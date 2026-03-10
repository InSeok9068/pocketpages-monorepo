/**
 * 주간 모집 계획 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 주간 계획 레코드입니다.
 * @returns {{ isConfirmed: () => boolean, canSaveConfirmed: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
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
