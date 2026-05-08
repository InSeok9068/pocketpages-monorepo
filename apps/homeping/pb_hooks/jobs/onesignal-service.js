const DEFAULT_BASE_URL = 'https://api.onesignal.com'
const DEFAULT_TIMEOUT_SECONDS = 15
const NO_SUBSCRIBED_RECIPIENTS_CODE = 'ONESIGNAL_NO_SUBSCRIBED_RECIPIENTS'

/**
 * 여러 환경변수 후보 중 첫 값을 읽습니다.
 * @param {string[]} names 환경변수 이름 목록
 * @returns {string} 환경변수 값
 */
function getFirstEnv(names) {
  const list = Array.isArray(names) ? names : []

  for (let index = 0; index < list.length; index += 1) {
    const name = String(list[index] || '').trim()
    const value = name ? String(process.env[name] || '').trim() : ''

    if (value) {
      return value
    }
  }

  return ''
}

/**
 * OneSignal App ID를 읽습니다.
 * @returns {string} OneSignal App ID
 */
function getRequiredAppId() {
  const appId = getFirstEnv(['HOMEPING_ONESIGNAL_APPID', 'ONESIGNAL_APPID'])

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
  const apiKey = getFirstEnv(['HOMEPING_ONESIGNAL_APIKEY', 'ONESIGNAL_APIKEY'])

  if (!apiKey) {
    throw new Error('HOMEPING_ONESIGNAL_APIKEY 환경변수가 필요합니다.')
  }

  return apiKey
}

/**
 * OneSignal API 기본 URL을 읽습니다.
 * @returns {string} OneSignal API URL
 */
function getBaseUrl() {
  return getFirstEnv(['HOMEPING_ONESIGNAL_APIURL', 'ONESIGNAL_APIURL']) || DEFAULT_BASE_URL
}

/**
 * OneSignal 발송 대상 세그먼트 설정을 읽습니다.
 * @returns {string} OneSignal 세그먼트명
 */
function getConfiguredTargetSegment() {
  return getFirstEnv(['HOMEPING_ONESIGNAL_SEGMENT', 'ONESIGNAL_SEGMENT'])
}

/**
 * Homeping 기본 발송 대상을 만듭니다.
 * @returns {object} OneSignal 대상 payload
 */
function createTargetingPayload() {
  const segment = getConfiguredTargetSegment()

  if (segment) {
    return {
      included_segments: [segment],
    }
  }

  return {
    filters: [
      {
        field: 'tag',
        key: 'homeping_region',
        relation: 'exists',
      },
    ],
  }
}

/**
 * 로그용 발송 대상 설명을 만듭니다.
 * @param {object} payload OneSignal 메시지 payload
 * @returns {string} 발송 대상 설명
 */
function describeTarget(payload) {
  if (payload && Array.isArray(payload.included_segments) && payload.included_segments.length > 0) {
    return 'segment:' + payload.included_segments[0]
  }

  return 'tag:homeping_region:exists'
}

/**
 * OneSignal 응답 오류 목록을 배열로 정규화합니다.
 * @param {object} responseJson OneSignal 응답 json
 * @returns {unknown[]} 오류 목록
 */
function getResponseErrors(responseJson) {
  const source = responseJson && typeof responseJson === 'object' ? responseJson : null

  if (!source || !source.errors) {
    return []
  }

  if (Array.isArray(source.errors)) {
    return source.errors
  }

  return [source.errors]
}

/**
 * OneSignal 오류 객체를 만듭니다.
 * @param {string} message 오류 메시지
 * @param {string} code 오류 코드
 * @returns {Error} 오류 객체
 */
function createOneSignalError(message, code) {
  const exception = new Error(message)

  if (code) {
    exception.code = code
  }

  return exception
}

/**
 * 수신 가능한 구독자가 없다는 오류인지 확인합니다.
 * @param {unknown} value 오류 값
 * @returns {boolean} 구독자 없음 여부
 */
function isNoSubscribedRecipientsMessage(value) {
  return String(value || '').indexOf('All included players are not subscribed') !== -1
}

/**
 * 수신 가능한 구독자가 없다는 예외인지 확인합니다.
 * @param {unknown} exception 예외
 * @returns {boolean} 구독자 없음 여부
 */
function isNoSubscribedRecipientsError(exception) {
  return !!(exception && exception.code === NO_SUBSCRIBED_RECIPIENTS_CODE)
}

/**
 * 전체 Homeping 구독자에게 보낼 푸시 payload를 만듭니다.
 * @param {types.HomepingNoticePushInput} input 푸시 생성 입력값
 * @returns {object} OneSignal 메시지 payload
 */
function createPushPayload(input) {
  /** @type {types.HomepingNoticePushInput} */
  const source = input || {
    title: '',
    contents: '',
  }
  const title = String(source.title || '').trim()
  const contents = String(source.contents || '').trim()
  const url = String(source.url || '').trim()
  const payload = Object.assign({}, createTargetingPayload(), {
    app_id: getRequiredAppId(),
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
  })

  if (url) {
    payload.url = url
  }

  return payload
}

/**
 * OneSignal API 인증 헤더를 만듭니다.
 * @returns {{ Authorization: string, 'Content-Type': string }} 요청 헤더
 */
function createAuthHeaders() {
  return {
    Authorization: 'Key ' + getRequiredApiKey(),
    'Content-Type': 'application/json',
  }
}

/**
 * OneSignal로 전체 구독자 푸시 메시지를 보냅니다.
 * @param {types.HomepingNoticePushInput} input 푸시 발송 입력값
 * @returns {object} OneSignal 응답 json
 */
function sendPushNotification(input) {
  const payload = createPushPayload(input)
  const timeout = input && input.timeout ? input.timeout : DEFAULT_TIMEOUT_SECONDS

  if (!payload.headings.ko) {
    throw new Error('OneSignal 알림 제목이 필요합니다.')
  }

  if (!payload.contents.ko) {
    throw new Error('OneSignal 알림 본문이 필요합니다.')
  }

  $app.logger().debug('homeping/onesignal:send:start', 'target', describeTarget(payload), 'title', payload.headings.ko)

  const response = $http.send({
    url: String(getBaseUrl()).replace(/\/+$/, '') + '/notifications',
    method: 'POST',
    headers: createAuthHeaders(),
    body: JSON.stringify(payload),
    timeout: timeout,
  })

  $app.logger().debug('homeping/onesignal:send:response', 'statusCode', response.statusCode)

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('OneSignal 푸시 발송에 실패했습니다. status=' + response.statusCode)
  }

  const responseJson = response.json || {}
  const responseErrors = getResponseErrors(responseJson)

  if (responseErrors.length > 0) {
    const code = responseErrors.some(isNoSubscribedRecipientsMessage) ? NO_SUBSCRIBED_RECIPIENTS_CODE : ''

    throw createOneSignalError('OneSignal 푸시 발송에 실패했습니다. error=' + JSON.stringify(responseErrors), code)
  }

  if (!String(responseJson.id || '').trim()) {
    throw createOneSignalError('OneSignal 푸시 메시지가 생성되지 않았습니다. 수신 가능한 구독자가 없을 수 있습니다.', NO_SUBSCRIBED_RECIPIENTS_CODE)
  }

  return responseJson
}

module.exports = {
  createPushPayload,
  isNoSubscribedRecipientsError,
  sendPushNotification,
}
