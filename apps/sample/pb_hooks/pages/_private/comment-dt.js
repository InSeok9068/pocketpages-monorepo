module.exports = function createCommentDT(record) {
  const id = record.get('id')
  const postId = record.get('post')
  const authorName = record.get('author_name')
  const content = record.get('content')
  const status = record.get('status')
  const parentCommentId = record.get('parent_comment')

  return {
    id,
    postId,
    authorName,
    content,
    status,
    parentCommentId,

    isVisible() {
      return this.status === 'visible'
    },

    isHidden() {
      return this.status === 'hidden'
    },

    isDeleted() {
      return this.status === 'deleted'
    },

    canReply() {
      return this.isVisible() && !this.isDeleted()
    },

    canHide() {
      return this.isVisible()
    },

    canSoftDelete() {
      return !this.isDeleted()
    },
  }
}
