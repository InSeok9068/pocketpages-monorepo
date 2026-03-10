/**
 * 게시글 record를 검증 전용 DT로 감쌉니다.
 * @param {core.Record} record 게시글 record입니다.
 * @returns {object} 게시글 검증 메서드만 가진 DT입니다.
 */
function toDT(record) {
  const id = record.get('id')
  const board = record.get('board')
  const title = String(record.get('title') || '').trim()
  const slug = String(record.get('slug') || '').trim()
  const content = String(record.get('content') || '').trim()
  const author_name = String(record.get('author_name') || '').trim()
  const status = String(record.get('status') || '').trim()
  const is_notice = !!record.get('is_notice')
  const view_count = Number(record.get('view_count') || 0)
  const published_at = record.get('published_at')

  return {
    isDraft() {
      return status === 'draft'
    },

    isPublished() {
      return status === 'published'
    },

    isArchived() {
      return status === 'archived'
    },

    hasPublishableContent() {
      return !!title && !!content
    },

    canPublish() {
      return !this.isArchived() && this.hasPublishableContent()
    },

    canArchive() {
      return this.isPublished()
    },

    canEdit() {
      return !this.isArchived()
    },

    canIncrementViewCount() {
      return this.isPublished()
    },
  }
}

module.exports = {
  toDT,
}
