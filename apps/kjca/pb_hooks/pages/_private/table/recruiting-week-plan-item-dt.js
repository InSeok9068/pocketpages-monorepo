module.exports = function createRecruitingWeekPlanItemDT(record) {
  const weekday = String(record.get('weekday') || '').trim()
  const channelName = String(record.get('channelName') || '').trim()
  const promotionContent = String(record.get('promotionContent') || '').trim()
  const ownerName = String(record.get('ownerName') || '').trim()
  const note = String(record.get('note') || '').trim()
  const targetCount = Number(record.get('targetCount') || 0)

  return {
    hasContent() {
      return !!channelName || !!promotionContent || !!ownerName || !!note || Number.isFinite(targetCount) && targetCount > 0
    },

    canSave() {
      return !!weekday && this.hasContent()
    },
  }
}
