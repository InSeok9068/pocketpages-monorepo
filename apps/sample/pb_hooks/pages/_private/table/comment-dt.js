/**
 * 댓글 record를 검증 전용 DT로 감쌉니다.
 * @param {core.Record} record 댓글 record입니다.
 * @returns {object} 댓글 검증 메서드만 가진 DT입니다.
 */
function toDT(record) {
  const id = record.get('id')
  const post = record.get('post')
  const author_name = String(record.get('author_name') || '').trim()
  const content = String(record.get('content') || '').trim()
  const status = String(record.get('status') || '').trim()
  const parent_comment = record.get('parent_comment')

  return {
    isVisible() {
      return status === 'visible'
    },

    isHidden() {
      return status === 'hidden'
    },

    isDeleted() {
      return status === 'deleted'
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

module.exports = {
  toDT,
}
