'use strict'

/* global $app, $http */

const DEFAULT_BASE_URL = 'https://api.onesignal.com'
const DEFAULT_TIMEOUT_SECONDS = 15

/**
 * 공백을 제거한 문자열을 만듭니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 문자열 값입니다.
 */
function cleanText(value) {
  return String(value == null ? '' : value).trim()
}

/**
 * 환경 변수 값을 읽습니다.
 * @param {string} name 환경 변수 이름입니다.
 * @returns {string} 환경 변수 값입니다.
 */
function readEnv(name) {
  return cleanText(process.env[name])
}

/**
 * 필수 문자열 값을 확인합니다.
 * @param {unknown} value 확인할 값입니다.
 * @param {string} name 값 이름입니다.
 * @returns {string} 정리한 문자열입니다.
 */
function requireText(value, name) {
  const text = cleanText(value)
  if (!text) throw new Error(`${name} is required`)
  return text
}

/**
 * 양수 숫자 옵션을 정리합니다.
 * @param {unknown} value 옵션 값입니다.
 * @param {number} fallback 기본값입니다.
 * @returns {number} 정리한 숫자입니다.
 */
function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

/**
 * OneSignal 응답 오류 목록을 배열로 정리합니다.
 * @param {Record<string, any>} responseJson 응답 JSON입니다.
 * @returns {unknown[]} 오류 목록입니다.
 */
function getResponseErrors(responseJson) {
  const errors = responseJson && responseJson.errors
  if (!errors) return []
  if (Array.isArray(errors)) return errors
  return [errors]
}

/**
 * 수신 가능한 구독자가 없다는 오류인지 판단합니다.
 * @param {unknown} value 오류 값입니다.
 * @returns {boolean} 수신자 없음이면 true입니다.
 */
function isNoSubscribedRecipientsMessage(value) {
  return cleanText(value).indexOf('All included players are not subscribed') >= 0
}

/**
 * OneSignal 호출 결과를 만듭니다.
 * @param {Record<string, any>} args 결과 인자입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function buildResult(args) {
  const statusCode = Number(args.statusCode || 0)
  const responseJson = args.responseJson && typeof args.responseJson === 'object' && !Array.isArray(args.responseJson) ? args.responseJson : {}
  const errors = getResponseErrors(responseJson)
  const notificationId = cleanText(responseJson.id)
  const httpOk = statusCode >= 200 && statusCode < 300
  const noSubscribedRecipients = httpOk && !notificationId
  const ok = httpOk && !!notificationId && errors.length === 0
  const firstError = errors.length > 0 ? cleanText(errors[0]) : ''
  const errorMessage = cleanText(args.errorMessage || firstError || responseJson.error || responseJson.message || '')

  return {
    ok,
    statusCode,
    notificationId,
    responseJson,
    errors,
    errorMessage,
    noSubscribedRecipients: noSubscribedRecipients || errors.some(isNoSubscribedRecipientsMessage),
  }
}

/**
 * OneSignal 클라이언트 런타임 값을 만듭니다.
 * @param {Record<string, any>} options 클라이언트 옵션입니다.
 * @returns {Record<string, any>} 런타임 값입니다.
 */
function createRuntime(options) {
  return {
    appId: cleanText(options.appId || readEnv('ONESIGNAL_APPID')),
    apiKey: cleanText(options.apiKey || readEnv('ONESIGNAL_APIKEY')),
    baseUrl: cleanText(options.baseUrl || readEnv('ONESIGNAL_APIURL') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutSeconds: normalizePositiveNumber(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
  }
}

/**
 * 알림 생성 payload를 만듭니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {Record<string, any>} OneSignal payload입니다.
 */
function buildNotificationPayload(request, runtime) {
  const payload = request.payload && typeof request.payload === 'object' ? Object.assign({}, request.payload) : Object.assign({}, request)
  delete payload.payload
  delete payload.timeoutSeconds

  if (!payload.app_id) payload.app_id = requireText(runtime.appId, 'OneSignal appId')
  return payload
}

/**
 * OneSignal 알림 생성 API를 호출합니다.
 * @param {Record<string, any>} input 알림 요청입니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function createNotification(input, runtime) {
  const request = input || {}
  const payload = buildNotificationPayload(request, runtime)
  const timeout = normalizePositiveNumber(request.timeoutSeconds, runtime.timeoutSeconds)
  const apiKey = requireText(runtime.apiKey, 'OneSignal apiKey')

  $app.logger().debug('pocketpages/onesignal:request', 'targetChannel', cleanText(payload.target_channel), 'timeoutSeconds', timeout)

  try {
    const response = $http.send({
      url: runtime.baseUrl + '/notifications',
      method: 'POST',
      headers: {
        Authorization: 'Key ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout,
    })
    const responseJson = response.json && typeof response.json === 'object' && !Array.isArray(response.json) ? response.json : {}
    const result = buildResult({
      statusCode: response.statusCode,
      responseJson,
      errorMessage: '',
    })

    $app.logger().debug('pocketpages/onesignal:response', 'statusCode', result.statusCode, 'ok', result.ok, 'notificationId', result.notificationId)
    return result
  } catch (error) {
    const result = buildResult({
      statusCode: 0,
      responseJson: {},
      errorMessage: cleanText(error),
    })

    $app.logger().debug('pocketpages/onesignal:response', 'statusCode', result.statusCode, 'ok', result.ok, 'error', result.errorMessage)
    return result
  }
}

/**
 * PocketBase JSVM용 OneSignal 클라이언트를 만듭니다.
 * @param {Record<string, any>} [options] 클라이언트 옵션입니다.
 * @returns {Record<string, any>} OneSignal 클라이언트입니다.
 */
function createOneSignalClient(options) {
  const runtime = createRuntime(options || {})

  return {
    createNotification(request) {
      return createNotification(request, runtime)
    },
  }
}

module.exports = {
  createOneSignalClient,
}
