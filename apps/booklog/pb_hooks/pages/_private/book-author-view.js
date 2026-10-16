/**
 * 도서함과 상세 화면에 표시할 저자 정보를 정리합니다.
 * @param {string} authorText 책 저자 정보
 * @returns {string} 표시할 저자 정보
 */
function formatDisplayAuthor(authorText) {
  const rawContributors = String(authorText || '')
    .split(/[,;]/)
    .map(function (contributor) {
      return contributor.trim()
    })
    .filter(Boolean)
  const authorContributors = rawContributors
    .filter(function (contributor) {
      const hasAuthorRole =
        /(?:지은이|지음|글쓴이|저자|작가)/i.test(contributor) || /(?:^|[\s·])글(?:\s*[·:：]|$)/.test(contributor)
      const hasOtherRole = /(?:옮긴이|옮김|역자|번역|그림|감수)/i.test(contributor)

      return contributor && (hasAuthorRole || !hasOtherRole)
    })
    .map(function (contributor) {
      return contributor
        .replace(/^\s*(?:지은이|저자|작가|글쓴이|글)(?:\s*[·/]\s*그림)?\s*[:：]\s*/i, '')
        .replace(/\s*\(\s*(?:지은이|지음|저자|작가)\s*\)/gi, '')
        .replace(/\s*\[\s*(?:지은이|지음)\s*\]/gi, '')
        .replace(/\s+(?:지음|저)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
    })
    .filter(function (contributor) {
      return contributor
    })

  if (authorContributors.length) {
    return authorContributors.join(', ')
  }

  if (/(?:옮긴이|옮김|역자|번역)/i.test(String(authorText || ''))) {
    return ''
  }

  return rawContributors.join(', ')
}

module.exports = {
  formatDisplayAuthor,
}
