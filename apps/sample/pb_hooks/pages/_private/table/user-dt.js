/**
 * 사용자 record를 검증 전용 DT로 감쌉니다.
 * @param {core.Record} record 사용자 record입니다.
 * @returns {object} 사용자 검증 메서드만 가진 DT입니다.
 */
function toDT(record) {
  const id = record.get('id')
  const password = record.get('password')
  const tokenKey = record.get('tokenKey')
  const email = String(record.get('email') || '').trim()
  const emailVisibility = !!record.get('emailVisibility')
  const verified = typeof record.verified === 'function' ? record.verified() : !!record.get('verified')
  const name = String(record.get('name') || '').trim()
  const avatar = record.get('avatar')
  const created = record.get('created')
  const updated = record.get('updated')

  return {
    hasDisplayName() {
      return !!name
    },

    isVerified() {
      return verified === true
    },

    canEditProfile(authRecord) {
      if (!authRecord) {
        return false
      }

      return authRecord.get('id') === id || authRecord.isSuperuser()
    },

    canUploadAvatar() {
      return verified === true
    },
  }
}

module.exports = {
  toDT,
}
