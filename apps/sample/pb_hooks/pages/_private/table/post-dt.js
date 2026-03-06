module.exports = function createPostDT(record) {
  const id = record.get('id')
  const boardId = record.get('board')
  const title = record.get('title')
  const slug = record.get('slug')
  const content = record.get('content')
  const authorName = record.get('author_name')
  const status = record.get('status')
  const isNotice = !!record.get('is_notice')
  const viewCount = record.get('view_count') || 0
  const publishedAt = record.get('published_at')

  return {
    id,
    boardId,
    title,
    slug,
    content,
    authorName,
    status,
    isNotice,
    viewCount,
    publishedAt,

    isDraft() {
      return this.status === 'draft'
    },

    isPublished() {
      return this.status === 'published'
    },

    isArchived() {
      return this.status === 'archived'
    },

    hasPublishableContent() {
      return String(this.title || '').trim() !== '' && String(this.content || '').trim() !== ''
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
