/**
 * API 경로 여부를 판단한다.
 * @param {string} pathname
 * @returns {boolean}
 */
function isApiPath(pathname) {
  return pathname.startsWith('/xapi/') || pathname.startsWith('/api/')
}

/**
 * HTML 응답 문자열을 이스케이프한다.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** @type {PocketPagesNextMiddlewareFunc} */
module.exports = function (api, next) {
  const { env, error, request, response } = api
  const pathname = String(request.url.pathname || '')
  const appEnv = String(env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'

  try {
    next()
  } catch (exception) {
    const message = String(exception && exception.message ? exception.message : exception)

    error('squashpong/global-error-boundary:caught', {
      pathname: pathname,
      message: message,
    })

    if (isApiPath(pathname)) {
      return response.json(500, {
        ok: false,
        error: 'Unhandled route exception.',
        message: isDevelopment ? message : '',
      })
    }

    const detailHtml = isDevelopment ? `<pre>${escapeHtml(message)}</pre>` : '<p>잠시 후 다시 시도해 주세요.</p>'

    return response.html(500, `<html><body><h1>Squash Pong error</h1>${detailHtml}</body></html>`)
  }
}
