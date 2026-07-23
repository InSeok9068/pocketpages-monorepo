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
 * Realtime 요청에 PocketPages 쿠키 인증을 연결합니다.
 * @param {core.RealtimeConnectRequestEvent|core.RealtimeSubscribeRequestEvent} event Realtime 요청 이벤트
 */
function attachCookieAuth(event) {
  if (event.auth || !event.request) return

  try {
    const cookie = event.request.cookie('pb_auth')
    const authData = parseAuthCookie(cookie && cookie.value)
    const token = String((authData && authData.token) || '')
    if (!token) return

    const authRecord = event.app.findAuthRecordByToken(token, 'auth')
    event.auth = authRecord
    event.client.set('auth', authRecord)
  } catch (_exception) {
    // 로그인하지 않았거나 만료된 쿠키는 익명 Realtime 요청으로 처리합니다.
  }
}

module.exports = {
  attachCookieAuth,
}
