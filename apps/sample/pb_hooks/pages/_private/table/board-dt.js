module.exports = function createBoardDT(record) {
  const id = record.get('id')
  const name = record.get('name')
  const slug = record.get('slug')
  const description = record.get('description')
  const isActive = !!record.get('is_active')
  const sortOrder = record.get('sort_order') || 0

  return {
    id,
    name,
    slug,
    description,
    isActive,
    sortOrder,

    isUsable() {
      return this.isActive
    },

    canAcceptPosts() {
      return this.isActive
    },

    canDeactivate() {
      return this.isActive
    },
  }
}
