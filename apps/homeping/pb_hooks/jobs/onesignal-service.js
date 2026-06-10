const { createOneSignalClient } = require('@pocketpages/onesignal')

const NO_SUBSCRIBED_RECIPIENTS_CODE = 'ONESIGNAL_NO_SUBSCRIBED_RECIPIENTS'

/**
 * OneSignal App ID를 읽습니다.
 * @returns {string} OneSignal App ID
 */
function getRequiredAppId() {
  const appId = String(process.env.HOMEPING_ONESIGNAL_APPID || '').trim()

  if (!appId) {
    throw new Error('HOMEPING_ONESIGNAL_APPID 환경변수가 필요합니다.')
  }

  return appId
}

/**
 * OneSignal REST API Key를 읽습니다.
 * @returns {string} OneSignal REST API Key
 */
function getRequiredApiKey() {
  const apiKey = String(process.env.HOMEPING_ONESIGNAL_APIKEY || '').trim()

  if (!apiKey) {
    throw new Error('HOMEPING_ONESIGNAL_APIKEY 환경변수가 필요합니다.')
  }

  return apiKey
}

/**
 * OneSignal 발송 대상 세그먼트 설정을 읽습니다.
 * @returns {string} OneSignal 세그먼트명
 */
function getConfiguredTargetSegment() {
  return String(process.env.HOMEPING_ONESIGNAL_SEGMENT || '').trim()
}

/**
 * 수신 가능한 구독자가 없다는 예외인지 확인합니다.
 * @param {unknown} exception 예외
 * @returns {boolean} 구독자 없음 여부
 */
function isNoSubscribedRecipientsError(exception) {
  if (!exception || typeof exception !== 'object') {
    return false
  }

  return String(Reflect.get(exception, 'code') || '') === NO_SUBSCRIBED_RECIPIENTS_CODE
}

/**
 * OneSignal로 전체 구독자 푸시 메시지를 보냅니다.
 * @param {types.HomepingNoticePushInput} input 푸시 발송 입력값
 * @returns {object} OneSignal 응답 json
 */
function sendPushNotification(input) {
  /** @type {types.HomepingNoticePushInput} */
  const source = input || {
    title: '',
    contents: '',
  }
  const title = String(source.title || '').trim()
  const contents = String(source.contents || '').trim()
  const url = String(source.url || '').trim()
  const timeout = source.timeout
  const segment = getConfiguredTargetSegment()

  if (!title) {
    throw new Error('OneSignal 알림 제목이 필요합니다.')
  }

  if (!contents) {
    throw new Error('OneSignal 알림 본문이 필요합니다.')
  }

  /** @type {import('@pocketpages/onesignal').OneSignalNotification} */
  const notification = {
    target_channel: 'push',
    isAnyWeb: true,
    headings: {
      ko: title,
      en: title,
    },
    contents: {
      ko: contents,
      en: contents,
    },
    timeoutSeconds: timeout,
  }

  if (segment) {
    notification.included_segments = [segment]
  } else {
    notification.filters = [
      {
        field: 'tag',
        key: 'homeping_region',
        relation: 'exists',
      },
    ]
  }

  if (url) {
    notification.url = url
  }

  $app.logger().debug('homeping/onesignal:send:start', 'title', title)

  const oneSignal = createOneSignalClient({
    appId: getRequiredAppId(),
    apiKey: getRequiredApiKey(),
    baseUrl: String(process.env.HOMEPING_ONESIGNAL_APIURL || '').trim(),
  })
  const result = oneSignal.createNotification(notification)

  $app.logger().debug('homeping/onesignal:send:response', 'statusCode', result.statusCode, 'notificationId', result.notificationId)

  if (result.noSubscribedRecipients) {
    /** @type {Error & { code?: string }} */
    const exception = new Error('OneSignal 푸시 메시지가 생성되지 않았습니다. 수신 가능한 구독자가 없을 수 있습니다.')
    exception.code = NO_SUBSCRIBED_RECIPIENTS_CODE
    throw exception
  }

  if (!result.ok) {
    throw new Error('OneSignal 푸시 발송에 실패했습니다. status=' + result.statusCode + ' error=' + result.errorMessage)
  }

  return result.responseJson || {}
}

module.exports = {
  isNoSubscribedRecipientsError,
  sendPushNotification,
}
