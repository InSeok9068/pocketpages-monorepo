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
