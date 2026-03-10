/**
 * 게시판 record를 검증 전용 DT로 감쌉니다.
 * @param {core.Record} record 게시판 record입니다.
 * @returns {object} 게시판 검증 메서드만 가진 DT입니다.
 */
function toDT(record) {
  const id = record.get('id')
  const name = String(record.get('name') || '').trim()
  const slug = String(record.get('slug') || '').trim()
  const description = String(record.get('description') || '').trim()
  const is_active = !!record.get('is_active')
  const sort_order = Number(record.get('sort_order') || 0)

  return {
    isUsable() {
      return is_active
    },

    canAcceptPosts() {
      return is_active
    },

    canDeactivate() {
      return is_active
    },
  }
}

module.exports = {
  toDT,
}
