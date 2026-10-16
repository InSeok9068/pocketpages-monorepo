/**
 * 책 제목을 메인 제목과 부제목으로 나눕니다.
 * @param {string} title 책 제목
 * @returns {[string, string]} 메인 제목과 부제목
 */
function splitBookTitle(title) {
  const normalizedTitle = String(title || '').trim()
  const separator = /[:：=]|\s[-–—]\s/.exec(normalizedTitle)

  if (!separator) {
    return [normalizedTitle, '']
  }

  const mainTitle = normalizedTitle.slice(0, separator.index).trim()
  const subtitle = normalizedTitle.slice(separator.index + separator[0].length).trim()

  if (!mainTitle || !subtitle) {
    return [normalizedTitle, '']
  }

  return [mainTitle, subtitle]
}

/**
 * 책의 메인 제목을 반환합니다.
 * @param {string} title 책 제목
 * @returns {string} 메인 제목
 */
function getMainTitle(title) {
  return splitBookTitle(title)[0]
}

/**
 * 책의 부제목을 반환합니다.
 * @param {string} title 책 제목
 * @returns {string} 부제목
 */
function getSubtitle(title) {
  return splitBookTitle(title)[1]
}

module.exports = {
  getMainTitle,
  getSubtitle,
}
