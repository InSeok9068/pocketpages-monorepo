const DEFAULT_BASE_URL = 'https://api.onesignal.com'
const DEFAULT_TIMEOUT_SECONDS = 15

function getRequiredAppId() {
  const appId = String(process.env.ONESIGNAL_APPID || '').trim()

  if (!appId) {
    throw new Error('ONESIGNAL_APPID 환경변수가 필요합니다.')
  }

  return appId
}

function getRequiredApiKey() {
  const apiKey = String(process.env.ONESIGNAL_APIKEY || '').trim()

  if (!apiKey) {
    throw new Error('ONESIGNAL_APIKEY 환경변수가 필요합니다.')
  }

  return apiKey
}

function getBaseUrl() {
  return String(process.env.ONESIGNAL_APIURL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/**
 * 특정 external id 목록으로 보낼 푸시 payload를 만듭니다.
 *
 * @param {Object} input 푸시 생성 입력값
 * @param {string[]} input.externalIds 대상 external id 목록
 * @param {string} input.title 알림 제목
 * @param {string} input.contents 알림 본문
 * @returns {Object} OneSignal 메시지 payload
 */
function createPushPayload(input) {
  const source = input || {}
  const externalIds = Array.isArray(source.externalIds) ? source.externalIds : []

  return {
    app_id: getRequiredAppId(),
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
 * OneSignal API 인증 헤더를 만듭니다.
 *
 * @returns {{Authorization: string, 'Content-Type': string}} 요청 헤더
 */
function createAuthHeaders() {
  return {
    Authorization: 'Key ' + getRequiredApiKey(),
    'Content-Type': 'application/json',
  }
}

/**
 * OneSignal로 푸시 메시지를 보냅니다.
 *
 * @param {Object} input 푸시 발송 입력값
 * @param {string[]} input.externalIds 대상 external id 목록
 * @param {string} input.title 알림 제목
 * @param {string} input.contents 알림 본문
 * @returns {Object} OneSignal 응답 json
 */
function sendPushNotification(input) {
  const payload = createPushPayload(input)
  const externalIds = payload.include_aliases && Array.isArray(payload.include_aliases.external_id) ? payload.include_aliases.external_id : []
  const timeout = input && input.timeout ? input.timeout : DEFAULT_TIMEOUT_SECONDS

  if (externalIds.length === 0) {
    throw new Error('OneSignal 발송 대상 external id가 필요합니다.')
  }

  if (!payload.headings.en) {
    throw new Error('OneSignal 알림 제목이 필요합니다.')
  }

  if (!payload.contents.en) {
    throw new Error('OneSignal 알림 본문이 필요합니다.')
  }

  $app.logger().debug(
    'onesignal:send:start',
    'externalIdCount',
    externalIds.length,
    'title',
    payload.headings.en
  )

  const response = $http.send({
    url: getBaseUrl() + '/notifications',
    method: 'POST',
    headers: createAuthHeaders(),
    body: JSON.stringify(payload),
    timeout: timeout,
  })

  $app.logger().debug(
    'onesignal:send:response',
    'statusCode',
    response.statusCode,
    'externalIdCount',
    externalIds.length
  )

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('OneSignal 푸시 발송에 실패했습니다. status=' + response.statusCode)
  }

  return response.json || {}
}

module.exports = {
  sendPushNotification,
}
