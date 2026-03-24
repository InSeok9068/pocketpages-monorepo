const PocketBase = require('pocketbase-js-sdk-jsvm')

const AUTH_COOKIE_NAME = 'pb_auth'
const DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * 환경 변수 값을 양의 정수 초 값으로 읽습니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @param {string} key 읽을 환경 변수 이름입니다.
 * @param {number} fallback 유효한 값이 없을 때 쓸 기본 초 값입니다.
 * @returns {number} 사용할 초 값입니다.
 */
function readPositiveIntegerEnv(envGetter, key, fallback) {
  var value = parseInt(String(envGetter(key) || '').trim(), 10)
  if (!value || value < 1) return fallback
  return value
}

/**
 * PocketBase base URL을 읽습니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {string} PocketBase base URL입니다.
 */
function readPocketBaseHost(envGetter) {
  return String(envGetter('POCKETBASE_URL') || envGetter('PB_HOST') || 'http://localhost:8090').trim() || 'http://localhost:8090'
}

/**
 * 로그인 쿠키 설정값을 만듭니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {{ maxAgeSeconds: number, secure: boolean }} 쿠키 설정입니다.
 */
function readAuthCookieConfig(envGetter) {
  var appEnv = String(envGetter('APP_ENV') || 'development').trim()

  return {
    maxAgeSeconds: readPositiveIntegerEnv(envGetter, 'BOOKLOG_AUTH_COOKIE_MAX_AGE_SECONDS', DEFAULT_AUTH_COOKIE_MAX_AGE_SECONDS),
    secure: appEnv === 'production',
  }
}

/**
 * auth record를 쿠키 저장용 plain object로 바꿉니다.
 * @param {any} record PocketBase auth record 또는 SDK record입니다.
 * @returns {any} JSON 직렬화 가능한 plain object입니다.
 */
function toPlainObject(record) {
  if (!record || typeof record !== 'object') return record
  return JSON.parse(JSON.stringify(record))
}

/**
 * 영속 로그인 쿠키 옵션을 만듭니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {{ path: string, maxAge: number, expires: Date, httpOnly: boolean, sameSite: string, secure: boolean }} 쿠키 옵션입니다.
 */
function createPersistedCookieOptions(envGetter) {
  var cookieConfig = readAuthCookieConfig(envGetter)

  return {
    path: '/',
    maxAge: cookieConfig.maxAgeSeconds,
    expires: new Date(Date.now() + cookieConfig.maxAgeSeconds * 1000),
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieConfig.secure,
  }
}

/**
 * 로그인 쿠키를 즉시 만료시키는 옵션을 만듭니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {{ path: string, maxAge: number, expires: Date, httpOnly: boolean, sameSite: string, secure: boolean }} 쿠키 삭제 옵션입니다.
 */
function createExpiredCookieOptions(envGetter) {
  var cookieConfig = readAuthCookieConfig(envGetter)

  return {
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieConfig.secure,
  }
}

/**
 * Booklog users 컬렉션으로 비밀번호 로그인을 수행합니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @param {string} email 로그인할 이메일입니다.
 * @param {string} password 로그인할 비밀번호입니다.
 * @returns {{ token: string, record: any }} PocketBase 인증 결과입니다.
 */
function authenticateWithPassword(envGetter, email, password) {
  var pb = new PocketBase(readPocketBaseHost(envGetter))
  return pb.collection('users').authWithPassword(email, password)
}

/**
 * 응답에 Booklog 로그인 영속 쿠키를 씁니다.
 * @param {import('pocketpages').PagesResponse} response 현재 PocketPages 응답 객체입니다.
 * @param {{ token: string, record: any }} authData PocketBase 인증 결과입니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 */
function writePersistedAuthCookie(response, authData, envGetter) {
  if (!authData || !authData.token || !authData.record) throw new Error('로그인 쿠키에 필요한 authData가 없습니다.')

  response.cookie(
    AUTH_COOKIE_NAME,
    {
      token: authData.token,
      record: toPlainObject(authData.record),
    },
    createPersistedCookieOptions(envGetter)
  )
}

/**
 * 응답에 Booklog 로그인 쿠키 삭제 헤더를 씁니다.
 * @param {import('pocketpages').PagesResponse} response 현재 PocketPages 응답 객체입니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 */
function clearAuthCookie(response, envGetter) {
  response.cookie(AUTH_COOKIE_NAME, '', createExpiredCookieOptions(envGetter))
}

module.exports = {
  authenticateWithPassword,
  writePersistedAuthCookie,
  clearAuthCookie,
}
