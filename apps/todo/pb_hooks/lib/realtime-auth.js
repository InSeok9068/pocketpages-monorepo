'use strict'

/**
 * PocketPages 인증 쿠키 값을 읽습니다.
 * @param {string} value 쿠키 값
 * @returns {{ token?: string }|null}
 */
function parseAuthCookie(value) {
  const rawValue = String(value || '')
  const candidates = [rawValue]

  try {
    const decodedValue = decodeURIComponent(rawValue)
    if (decodedValue !== rawValue) candidates.push(decodedValue)
  } catch (_exception) {
    // 인코딩되지 않은 쿠키 값은 그대로 확인합니다.
  }

  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const parsed = JSON.parse(candidates[index])
      if (parsed && typeof parsed === 'object') return parsed
    } catch (_exception) {
      // 다음 형식으로 계속 확인합니다.
    }
  }

  return null
}

/**
 * Cookie 헤더에서 지정한 쿠키 값을 찾습니다.
 * @param {string} header Cookie 헤더
 * @param {string} name 쿠키 이름
 * @returns {string} 쿠키 값
 */
function findCookieValue(header, name) {
  const cookies = String(header || '').split(';')

  for (let index = 0; index < cookies.length; index += 1) {
    const cookie = cookies[index]
    const separatorIndex = cookie.indexOf('=')
    if (separatorIndex < 0) continue

    const cookieName = cookie.slice(0, separatorIndex).trim()
    if (cookieName === name) return cookie.slice(separatorIndex + 1).trim()
  }

  return ''
}

/**
 * Realtime 요청에서 PocketPages 인증 쿠키 값을 읽습니다.
 * @param {core.RealtimeSubscribeRequestEvent} event Realtime 구독 이벤트
 * @returns {string} 인증 쿠키 값
 */
function readAuthCookieValue(event) {
  const requestInfo = event.requestInfo()
  const headers = requestInfo && requestInfo.headers ? requestInfo.headers : {}
  return findCookieValue(headers.cookie, 'pb_auth')
}

/**
 * Realtime 요청에 PocketPages 쿠키 인증을 연결합니다.
 * @param {core.RealtimeSubscribeRequestEvent} event Realtime 구독 이벤트
 * @returns {{ status: string, userId: string, error: string }} 인증 결과
 */
function attachCookieAuth(event) {
  if (event.auth) {
    return {
      status: 'existing-auth',
      userId: String(event.auth.get('id') || ''),
      error: '',
    }
  }

  try {
    const cookieValue = readAuthCookieValue(event)
    if (!cookieValue) {
      return {
        status: 'missing-cookie',
        userId: '',
        error: '',
      }
    }

    const authData = parseAuthCookie(cookieValue)
    if (!authData) {
      return {
        status: 'invalid-cookie',
        userId: '',
        error: '',
      }
    }

    const token = String((authData && authData.token) || '')
    if (!token) {
      return {
        status: 'missing-token',
        userId: '',
        error: '',
      }
    }

    const authRecord = event.app.findAuthRecordByToken(token, 'auth')
    event.auth = authRecord

    return {
      status: 'cookie-auth',
      userId: String(authRecord.get('id') || ''),
      error: '',
    }
  } catch (exception) {
    return {
      status: 'invalid-token',
      userId: '',
      error: String(exception && exception.message ? exception.message : exception),
    }
  }
}

module.exports = {
  attachCookieAuth,
}
