/**
 * API 경로 여부를 판단한다.
 * @param {string} pathname
 * @returns {boolean}
 */
function isApiPath(pathname) {
  return pathname.startsWith('/api/')
}

/**
 * HTML 응답에 표시할 문자열을 이스케이프한다.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function (api, next) {
  const { env, error, request, response } = api
  const pathname = String(request.url.pathname || '')
  const appEnv = String(env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'

  try {
    next()
  } catch (exception) {
    const message = String(exception && exception.message ? exception.message : exception)

    error('sample/global-error-boundary:caught', {
      pathname: pathname,
      message: message,
    })

    if (isApiPath(pathname)) {
      return response.json(500, {
        error: 'Global error boundary caught an unhandled exception.',
        message: isDevelopment ? message : '',
      })
    }

    const detailHtml = isDevelopment ? `<pre>${escapeHtml(message)}</pre>` : '<p>Something went wrong. Please try again later.</p>'

    return response.html(500, `<html><body><h1>Global error boundary</h1><p>Unhandled route exception.</p>${detailHtml}</body></html>`)
  }
}
