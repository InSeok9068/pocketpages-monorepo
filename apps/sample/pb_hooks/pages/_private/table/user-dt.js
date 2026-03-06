module.exports = function createUserDT(record) {
  const id = record.get('id')
  const email = record.get('email')
  const name = record.get('name')
  const verified = typeof record.verified === 'function' ? record.verified() : !!record.get('verified')
  const avatar = record.get('avatar')

  return {
    id,
    email,
    name,
    verified,
    avatar,

    hasDisplayName() {
      return String(this.name || '').trim().length > 0
    },

    isVerified() {
      return this.verified === true
    },

    canEditProfile(authRecord) {
      if (!authRecord) {
        return false
      }

      return authRecord.get('id') === this.id || authRecord.isSuperuser()
    },

    canUploadAvatar() {
      return this.isVerified()
    },
  }
}
