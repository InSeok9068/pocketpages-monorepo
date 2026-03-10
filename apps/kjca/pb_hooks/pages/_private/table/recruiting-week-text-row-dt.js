/**
 * 주간 텍스트 행 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 주간 텍스트 행 레코드입니다.
 * @returns {{ hasContent: () => boolean, canSave: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
module.exports = function createRecruitingWeekTextRowDT(record) {
  const weekday = String(record.get('weekday') || '').trim()
  const channelName = String(record.get('channelName') || '').trim()
  const weeklyPlan = String(record.get('weeklyPlan') || '').trim()
  const promotionContent = String(record.get('promotionContent') || '').trim()
  const targetText = String(record.get('targetText') || '').trim()
  const resultText = String(record.get('resultText') || '').trim()
  const recruitCountText = String(record.get('recruitCountText') || '').trim()
  const ownerName = String(record.get('ownerName') || '').trim()
  const note = String(record.get('note') || '').trim()

  return {
    hasContent() {
      return !!channelName || !!weeklyPlan || !!promotionContent || !!targetText || !!resultText || !!recruitCountText || !!ownerName || !!note
    },

    canSave() {
      return !!weekday
    },
  }
}
