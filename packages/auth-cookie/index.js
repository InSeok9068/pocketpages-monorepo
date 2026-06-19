'use strict'

const DEFAULT_COOKIE_NAME = 'pb_auth'
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

/**
 * 공백을 제거한 문자열을 만듭니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 문자열 값입니다.
 */
function cleanText(value) {
  return String(value == null ? '' : value).trim()
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
 * secure 쿠키 기본값을 결정합니다. APP_ENV=production일 때만 true입니다.
 * @returns {boolean} secure 기본값입니다.
 */
function defaultSecure() {
  return cleanText(process.env.APP_ENV).toLowerCase() === 'production'
}

/**
 * PocketBase record를 쿠키 저장용 plain object로 바꿉니다.
 * @param {unknown} record PocketBase auth record입니다.
 * @returns {unknown} JSON 직렬화 가능한 값입니다.
 */
function toPlainObject(record) {
  if (!record || typeof record !== 'object') return record
  return JSON.parse(JSON.stringify(record))
}

/**
 * auth cookie 런타임 값을 만듭니다.
 * @param {Record<string, any>} options auth cookie 옵션입니다.
 * @returns {Record<string, any>} 런타임 값입니다.
 */
function createRuntime(options) {
  return {
    cookieName: cleanText(options.cookieName || DEFAULT_COOKIE_NAME),
    maxAgeSeconds: Math.floor(normalizePositiveNumber(options.maxAgeSeconds, DEFAULT_MAX_AGE_SECONDS)),
    path: cleanText(options.path || '/'),
    httpOnly: options.httpOnly !== false,
    sameSite: cleanText(options.sameSite || 'lax'),
    secure: options.secure === undefined ? defaultSecure() : options.secure === true,
  }
}

/**
 * 영속 auth cookie 옵션을 만듭니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {Record<string, any>} 쿠키 옵션입니다.
 */
function createCookieOptions(runtime) {
  return {
    path: runtime.path,
    maxAge: runtime.maxAgeSeconds,
    expires: new Date(Date.now() + runtime.maxAgeSeconds * 1000),
    httpOnly: runtime.httpOnly,
    sameSite: runtime.sameSite,
    secure: runtime.secure,
  }
}

/**
 * auth cookie 삭제 옵션을 만듭니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {Record<string, any>} 쿠키 삭제 옵션입니다.
 */
function createExpiredCookieOptions(runtime) {
  return {
    path: runtime.path,
    maxAge: 0,
    expires: new Date(0),
    httpOnly: runtime.httpOnly,
    sameSite: runtime.sameSite,
    secure: runtime.secure,
  }
}

/**
 * 응답에 auth cookie를 씁니다.
 * @param {Record<string, any>} response PocketPages 응답 객체입니다.
 * @param {{ token: string, record: any }} authData PocketBase 인증 결과입니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 */
function writeAuthCookie(response, authData, runtime) {
  if (!authData || !authData.token || !authData.record) throw new Error('authData is required')

  response.cookie(
    runtime.cookieName,
    {
      token: authData.token,
      record: toPlainObject(authData.record),
    },
    createCookieOptions(runtime)
  )
}

/**
 * 응답에서 auth cookie를 만료시킵니다.
 * @param {Record<string, any>} response PocketPages 응답 객체입니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 */
function signOut(response, runtime) {
  response.cookie(runtime.cookieName, '', createExpiredCookieOptions(runtime))
}

/**
 * PocketPages 영속 auth cookie 헬퍼를 만듭니다.
 * @param {Record<string, any>} [options] auth cookie 옵션입니다.
 * @returns {Record<string, any>} auth cookie 헬퍼입니다.
 */
function createAuthCookie(options) {
  const runtime = createRuntime(options || {})

  return {
    writeAuthCookie(response, authData) {
      writeAuthCookie(response, authData, runtime)
    },
    signOut(response) {
      signOut(response, runtime)
    },
  }
}

module.exports = {
  createAuthCookie,
}
