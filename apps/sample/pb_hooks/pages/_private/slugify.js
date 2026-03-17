/**
 * 제목이나 이름을 URL slug 문자열로 정규화합니다.
 * @param {unknown} value slug 원본 값입니다.
 * @returns {string} 소문자 하이픈 slug 문자열입니다.
 */
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

module.exports = {
  slugify,
};
