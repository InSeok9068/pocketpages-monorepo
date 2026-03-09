module.exports = function createRecruitingDailyResultDT(record) {
  const reportDate = String(record.get('reportDate') || '').trim()
  const weekStartDate = String(record.get('weekStartDate') || '').trim()
  const dept = String(record.get('dept') || '').trim()
  const weekday = String(record.get('weekday') || '').trim()
  const sourceType = String(record.get('sourceType') || '').trim()
  const actualCount = Number(record.get('actualCount'))

  return {
    isAiSource() {
      return sourceType === 'ai'
    },

    canSaveAiResult() {
      return !!reportDate && !!weekStartDate && !!dept && !!weekday && sourceType === 'ai' && Number.isFinite(actualCount) && actualCount >= 0
    },
  }
}
