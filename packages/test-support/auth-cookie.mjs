function cleanText(value) {
  return String(value == null ? '' : value).trim()
}

function stripTrailingSlash(value) {
  return cleanText(value).replace(/\/+$/u, '')
}

function resolveUrl(baseUrl, input) {
  const path = String(input || '')

  if (/^https?:\/\//iu.test(path)) {
    return path
  }

  return `${stripTrailingSlash(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function splitSetCookieHeader(headerValue) {
  if (!headerValue) {
    return []
  }

  const source = String(headerValue)
  const values = []
  let current = ''

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (char === ',') {
      const nextPart = source.slice(index + 1)

      if (/^\s*[^=;,\s]+=/.test(nextPart)) {
        values.push(current.trim())
        current = ''
        continue
      }
    }

    current += char
  }

  if (current.trim()) {
    values.push(current.trim())
  }

  return values
}

function getSetCookieHeaders(headers) {
  if (!headers) {
    return []
  }

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }

  return splitSetCookieHeader(headers.get('set-cookie'))
}

function readCookiePair(setCookieHeader) {
  const pair = String(setCookieHeader || '').split(';')[0] || ''
  const separatorIndex = pair.indexOf('=')

  if (separatorIndex === -1) {
    return ''
  }

  const name = cleanText(pair.slice(0, separatorIndex))
  const value = pair.slice(separatorIndex + 1)

  return name ? `${name}=${value}` : ''
}

/**
 * 응답 Set-Cookie 값을 요청 Cookie 헤더 값으로 바꿉니다.
 * @param {Headers} headers 응답 헤더입니다.
 * @returns {string} 요청에 넣을 Cookie 헤더 값입니다.
 */
export function readCookieHeader(headers) {
  return getSetCookieHeaders(headers)
    .map(readCookiePair)
    .filter(Boolean)
    .join('; ')
}

/**
 * 서비스 로그인 라우트를 호출하고 Cookie 헤더 값을 돌려줍니다.
 * @param {string} baseUrl 서비스 base URL입니다.
 * @param {object} options 로그인 옵션입니다.
 * @param {string} options.email 사용자 이메일입니다.
 * @param {string} options.password 사용자 비밀번호입니다.
 * @param {string} [options.path] 로그인 라우트입니다.
 * @param {string} [options.emailField] 이메일 필드 이름입니다.
 * @param {string} [options.passwordField] 비밀번호 필드 이름입니다.
 * @returns {Promise<string>} 요청에 넣을 Cookie 헤더 값입니다.
 */
export async function signInAndGetCookieHeader(baseUrl, options) {
  const form = new URLSearchParams()

  form.set(cleanText(options.emailField || 'email'), cleanText(options.email).toLowerCase())
  form.set(cleanText(options.passwordField || 'password'), options.password == null ? '' : String(options.password))

  const response = await fetch(resolveUrl(baseUrl, options.path || '/xapi/auth/sign-in'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  })

  if (response.status < 200 || response.status >= 400) {
    const body = await response.text()

    throw new Error(`sign-in failed (status=${response.status}): ${body}`)
  }

  const cookieHeader = readCookieHeader(response.headers)

  if (!cookieHeader) {
    throw new Error('sign-in response is missing Set-Cookie')
  }

  return cookieHeader
}
