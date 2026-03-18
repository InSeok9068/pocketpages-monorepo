/**
 * 게시글이 published 상태인지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} published 상태이면 true입니다.
 */
function isPublished(post) {
  if (!post) {
    return false
  }

  return String(post.get('status') || '').trim() === 'published'
}

/**
 * 게시글이 archived 상태인지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} archived 상태이면 true입니다.
 */
function isArchived(post) {
  if (!post) {
    return false
  }

  return String(post.get('status') || '').trim() === 'archived'
}

/**
 * 게시글이 게시 가능한 필수 내용을 갖췄는지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} 제목과 본문이 모두 있으면 true입니다.
 */
function hasPublishableContent(post) {
  if (!post) {
    return false
  }

  const title = String(post.get('title') || '').trim()
  const content = String(post.get('content') || '').trim()
  return !!title && !!content
}

/**
 * 게시글을 published 상태로 둘 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} 게시 가능하면 true입니다.
 */
function canPublish(post) {
  return !isArchived(post) && hasPublishableContent(post)
}

/**
 * 게시글을 archived 상태로 바꿀 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} archived 전환이 가능하면 true입니다.
 */
function canArchive(post) {
  return isPublished(post)
}

/**
 * 게시글을 수정하거나 삭제할 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} 수정 가능하면 true입니다.
 */
function canEdit(post) {
  return !isArchived(post)
}

/**
 * 게시글 조회수를 증가시킬 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {boolean} 조회수 증가 대상이면 true입니다.
 */
function canIncrementViewCount(post) {
  return isPublished(post)
}

module.exports = {
  canArchive,
  canEdit,
  canIncrementViewCount,
  canPublish,
  hasPublishableContent,
  isArchived,
  isPublished,
}
