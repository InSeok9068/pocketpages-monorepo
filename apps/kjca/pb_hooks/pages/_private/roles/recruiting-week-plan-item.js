/**
 * 주간 계획 항목에 저장할 내용이 있는지 판단합니다.
 * @param {core.Record | null | undefined} record 주간 계획 항목 record입니다.
 * @returns {boolean} 의미 있는 내용이 있으면 true입니다.
 */
function hasContent(record) {
  if (!record) return false;

  const channelName = String(record.get("channelName") || "").trim();
  const promotionContent = String(record.get("promotionContent") || "").trim();
  const targetCount = Number(record.get("targetCount") || 0);
  const ownerName = String(record.get("ownerName") || "").trim();
  const note = String(record.get("note") || "").trim();

  return !!channelName || !!promotionContent || !!ownerName || !!note || (Number.isFinite(targetCount) && targetCount > 0);
}

/**
 * 주간 계획 항목을 저장할 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} record 주간 계획 항목 record입니다.
 * @returns {boolean} 저장 가능하면 true입니다.
 */
function canSave(record) {
  if (!record) return false;

  const weekday = String(record.get("weekday") || "").trim();
  return !!weekday && hasContent(record);
}

module.exports = {
  canSave,
  hasContent,
};
