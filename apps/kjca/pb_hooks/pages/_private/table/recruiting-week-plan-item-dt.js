/**
 * 주간 계획 항목 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 계획 항목 레코드입니다.
 * @returns {{ hasContent: () => boolean, canSave: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
module.exports = function createRecruitingWeekPlanItemDT(record) {
  const id = record.get('id')
  const planId = record.get('planId')
  const weekday = String(record.get('weekday') || '').trim()
  const channelName = String(record.get('channelName') || '').trim()
  const promotionContent = String(record.get('promotionContent') || '').trim()
  const targetCount = Number(record.get('targetCount') || 0)
  const ownerName = String(record.get('ownerName') || '').trim()
  const note = String(record.get('note') || '').trim()
  const sortOrder = record.get('sortOrder')
  const created = record.get('created')
  const updated = record.get('updated')

  return {
    hasContent() {
      return !!channelName || !!promotionContent || !!ownerName || !!note || Number.isFinite(targetCount) && targetCount > 0
    },

    canSave() {
      return !!weekday && this.hasContent()
    },
  }
}
