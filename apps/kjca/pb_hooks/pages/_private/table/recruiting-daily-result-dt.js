/**
 * 일일 모집 실적 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 모집 실적 레코드입니다.
 * @returns {{ isAiSource: () => boolean, canSaveAiResult: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
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
