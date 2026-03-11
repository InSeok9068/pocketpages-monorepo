/**
 * 공개된 게시판 slug로 활성 게시판을 찾습니다.
 * @param {unknown} boardSlug 라우트나 폼에서 받은 게시판 slug 값입니다.
 * @returns {core.Record | null} 활성 게시판이 있으면 record, 없으면 null입니다.
 */
function findActiveBoardBySlug(boardSlug) {
  const slug = String(boardSlug || '').trim();

  if (!slug) {
    return null;
  }

  try {
    return $app.findFirstRecordByFilter('boards', 'slug = {:slug} && is_active = true', { slug });
  } catch (error) {
    return null;
  }
}

/**
 * 게시판 안에서 글 slug로 게시글을 찾습니다.
 * @param {string | null | undefined} boardId 게시판 record id입니다.
 * @param {unknown} postSlug 라우트나 폼에서 받은 게시글 slug 값입니다.
 * @returns {core.Record | null} 게시글이 있으면 record, 없으면 null입니다.
 */
function findPostByBoardAndSlug(boardId, postSlug) {
  const slug = String(postSlug || '').trim();

  if (!boardId || !slug) {
    return null;
  }

  try {
    return $app.findFirstRecordByFilter('posts', 'board = {:boardId} && slug = {:slug}', { boardId, slug });
  } catch (error) {
    return null;
  }
}

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
  findActiveBoardBySlug,
  findPostByBoardAndSlug,
  slugify,
};
