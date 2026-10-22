/**
 * 책 상세에서 돌아갈 앱 내부 목록 주소를 확인합니다.
 * @param {string} value 돌아갈 주소
 * @returns {string} 허용된 목록 주소
 */
function getBackHref(value) {
  const href = String(value || '').trim()

  return href === '/' || /^\/(library|reviews|highlights|popular)(\?[^#\r\n\\]*)?$/.test(href) ? href : '/'
}

module.exports = { getBackHref }
