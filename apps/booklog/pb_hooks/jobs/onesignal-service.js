const { createOneSignalClient } = require('@pocketpages/onesignal')

/**
 * 특정 external id 목록으로 보낼 푸시 payload를 만듭니다.
 *
 * @param {types.BooklogOneSignalPushInput} input 푸시 생성 입력값
 * @returns {object} OneSignal 메시지 payload
 */
function createPushPayload(input) {
  /** @type {types.BooklogOneSignalPushInput} */
  const source = input || {
    externalIds: [],
    title: '',
    contents: '',
  }
  const externalIds = Array.isArray(source.externalIds) ? source.externalIds : []

  return {
    include_aliases: {
      external_id: externalIds,
    },
    target_channel: 'push',
    headings: {
      en: String(source.title || '').trim(),
    },
    contents: {
      en: String(source.contents || '').trim(),
    },
  }
}

/**
 * OneSignal로 푸시 메시지를 보냅니다.
 *
 * @param {types.BooklogOneSignalPushInput} input 푸시 발송 입력값
 * @returns {object} OneSignal 응답 json
 */
function sendPushNotification(input) {
  const payload = createPushPayload(input)
  const externalIds = payload.include_aliases && Array.isArray(payload.include_aliases.external_id) ? payload.include_aliases.external_id : []
  const timeout = input && input.timeout ? input.timeout : undefined

  if (externalIds.length === 0) {
    throw new Error('OneSignal 발송 대상 external id가 필요합니다.')
  }

  if (!payload.headings.en) {
    throw new Error('OneSignal 알림 제목이 필요합니다.')
  }

  if (!payload.contents.en) {
    throw new Error('OneSignal 알림 본문이 필요합니다.')
  }

  $app.logger().debug('onesignal:send:start', 'externalIdCount', externalIds.length, 'title', payload.headings.en)

  const oneSignal = createOneSignalClient()
  const result = oneSignal.createNotification({
    payload,
    timeoutSeconds: timeout,
  })

  $app.logger().debug('onesignal:send:response', 'statusCode', result.statusCode, 'externalIdCount', externalIds.length, 'notificationId', result.notificationId)

  if (!result.ok) {
    throw new Error('OneSignal 푸시 발송에 실패했습니다. status=' + result.statusCode + ' error=' + result.errorMessage)
  }

  return result.responseJson || {}
}

module.exports = {
  sendPushNotification,
}
