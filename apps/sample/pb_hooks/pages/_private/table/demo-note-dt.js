/**
 * 데모 노트 record를 검증 전용 DT로 감쌉니다.
 * @param {core.Record} record 데모 노트 record입니다.
 * @returns {object} 데모 노트 검증 메서드만 가진 DT입니다.
 */
module.exports = function createDemoNoteDT(record) {
  const id = record.get('id')
  const title = String(record.get('title') || '').trim()
  const body = String(record.get('body') || '').trim()
  const is_published = !!record.get('is_published')

  return {
    canPublish() {
      return !is_published && !!title
    },

    canUnpublish() {
      return is_published
    },

    hasBody() {
      return !!body
    },
  }
}
