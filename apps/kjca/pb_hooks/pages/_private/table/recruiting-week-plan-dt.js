module.exports = function createRecruitingWeekPlanDT(record) {
  const weekStartDate = String(record.get('weekStartDate') || '').trim()
  const dept = String(record.get('dept') || '').trim()
  const status = String(record.get('status') || '').trim()

  return {
    isConfirmed() {
      return status === 'confirmed'
    },

    canSaveConfirmed() {
      return !!weekStartDate && !!dept && status === 'confirmed'
    },
  }
}
