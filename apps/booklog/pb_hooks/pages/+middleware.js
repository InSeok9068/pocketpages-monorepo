/**
 * API 경로 여부를 판단합니다.
 * @param {string} pathname 확인할 경로
 * @returns {boolean}
 */
function isApiPath(pathname) {
  return pathname.startsWith('/api/')
}

/**
 * xapi 경로 여부를 판단합니다.
 * @param {string} pathname 확인할 경로
 * @returns {boolean}
 */
function isXapiPath(pathname) {
  return pathname.startsWith('/xapi/')
}

/**
 * HTMX 요청 여부를 판단합니다.
 * @param {import('pocketpages').PagesRequest} request 요청 객체
 * @returns {boolean}
 */
function isHtmxRequest(request) {
  return String(request.header('HX-Request') || '').toLowerCase() === 'true'
}

/**
 * HTML 응답에 표시할 문자열을 이스케이프합니다.
 * @param {string} value 표시할 문자열
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 오류 안내 HTML을 반환합니다.
 * @param {string} title 제목
 * @param {string} message 안내 문구
 * @param {string} detail 개발 환경 상세 문구
 * @returns {string}
 */
function renderErrorPage(title, message, detail) {
  const detailHtml = detail ? '<pre style="margin-top:16px;white-space:pre-wrap;border-radius:12px;background:#fff7ed;padding:16px;color:#7c2d12;">' + escapeHtml(detail) + '</pre>' : ''

  return (
    '<!doctype html>' +
    '<html lang="ko">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' +
    escapeHtml(title) +
    '</title>' +
    '</head>' +
    '<body style="margin:0;min-height:100vh;background:#f7f2e6;color:#292524;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
    '<main style="box-sizing:border-box;width:min(720px,100%);margin:0 auto;padding:48px 20px;">' +
    '<p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.14em;color:#a16207;text-transform:uppercase;">Booklog</p>' +
    '<h1 style="margin:0;font-size:28px;line-height:1.25;">' +
    escapeHtml(title) +
    '</h1>' +
    '<p style="margin:14px 0 0;font-size:16px;line-height:1.7;color:#57534e;">' +
    escapeHtml(message) +
    '</p>' +
    '<p style="margin:24px 0 0;"><a href="/" style="color:#44403c;font-weight:700;text-decoration:none;">홈으로 이동</a></p>' +
    detailHtml +
    '</main>' +
    '</body>' +
    '</html>'
  )
}

/**
 * HTMX 응답에 사용할 오류 조각을 반환합니다.
 * @param {string} message 안내 문구
 * @returns {string}
 */
function renderHtmxErrorAlert(message) {
  return (
    '<div class="rounded-[1.5rem] border-none bg-rose-50/90 px-4 py-3 text-sm text-rose-800 shadow-[0_12px_30px_rgba(136,19,55,0.06)] backdrop-blur-sm">' +
    '<p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-500">Alert</p>' +
    '<p class="mt-1.5 font-medium leading-6">' +
    escapeHtml(message) +
    '</p>' +
    '</div>'
  )
}

/** @type {PocketPagesNextMiddlewareFunc} */
module.exports = function (api, next) {
  const { env, error, request, redirect, response } = api
  const pathname = String(request.url.pathname || '')
  const appEnv = String(env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'
  const fallbackMessage = '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.'

  try {
    next()
  } catch (exception) {
    const errorMessage = String(exception && exception.message ? exception.message : exception)

    error('booklog/global-error-boundary:caught', {
      pathname: pathname,
      method: String(request.method || ''),
      error: errorMessage,
    })

    if (isApiPath(pathname)) {
      return response.json(500, {
        ok: false,
        message: isDevelopment ? errorMessage : fallbackMessage,
      })
    }

    if (isXapiPath(pathname)) {
      if (isHtmxRequest(request)) {
        return response.html(200, renderHtmxErrorAlert(fallbackMessage))
      }

      return redirect('/', {
        status: 303,
        message: isDevelopment ? errorMessage : fallbackMessage,
      })
    }

    return response.html(500, renderErrorPage('페이지를 불러오지 못했습니다.', fallbackMessage, isDevelopment ? errorMessage : ''))
  }
}
