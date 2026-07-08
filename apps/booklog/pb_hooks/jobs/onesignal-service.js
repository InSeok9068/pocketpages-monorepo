const { createOneSignalClient } = require('@pocketpages/onesignal')

/**
 * OneSignal로 푸시 메시지를 보냅니다.
 *
 * @param {types.BooklogOneSignalPushInput} input 푸시 발송 입력값
 * @returns {types.BooklogOneSignalResponse} OneSignal 응답 json
 */
function sendPushNotification(input) {
  /** @type {types.BooklogOneSignalPushInput} */
  const source = input || {
    externalIds: [],
    title: '',
    contents: '',
  }
  const externalIds = Array.isArray(source.externalIds) ? source.externalIds : []
  const title = String(source.title || '').trim()
  const contents = String(source.contents || '').trim()
  const timeout = source.timeout

  if (externalIds.length === 0) {
    throw new Error('OneSignal 발송 대상 external id가 필요합니다.')
  }

  if (!title) {
    throw new Error('OneSignal 알림 제목이 필요합니다.')
  }

  if (!contents) {
    throw new Error('OneSignal 알림 본문이 필요합니다.')
  }

  /** @type {import('@pocketpages/onesignal').OneSignalNotification} */
  const notification = {
    include_aliases: {
      external_id: externalIds,
    },
    target_channel: 'push',
    headings: {
      en: title,
    },
    contents: {
      en: contents,
    },
    timeoutSeconds: timeout,
  }

  $app.logger().debug('onesignal:send:start', 'externalIdCount', externalIds.length, 'title', title)

  const oneSignal = createOneSignalClient()
  const result = oneSignal.createNotification(notification)

  $app.logger().debug('onesignal:send:response', 'statusCode', result.statusCode, 'externalIdCount', externalIds.length, 'notificationId', result.notificationId)

  if (!result.ok) {
    throw new Error('OneSignal 푸시 발송에 실패했습니다. status=' + result.statusCode + ' error=' + result.errorMessage)
  }

  return result.responseJson || {}
}

module.exports = {
  sendPushNotification,
}
