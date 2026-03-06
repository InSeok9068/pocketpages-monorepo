module.exports = function createDemoNoteDT(record) {
  const id = record.get('id')
  const title = record.get('title')
  const body = record.get('body')
  const isPublished = !!record.get('is_published')

  return {
    id,
    title,
    body,
    isPublished,

    canPublish() {
      return !this.isPublished && String(this.title || '').trim() !== ''
    },

    canUnpublish() {
      return this.isPublished
    },

    hasBody() {
      return String(this.body || '').trim() !== ''
    },
  }
}
