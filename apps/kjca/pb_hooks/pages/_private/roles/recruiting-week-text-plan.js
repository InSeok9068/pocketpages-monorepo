/**
 * 주간 텍스트 계획을 confirmed 상태로 저장할 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} record 주간 텍스트 계획 record입니다.
 * @returns {boolean} 저장 가능하면 true입니다.
 */
function canSaveConfirmed(record) {
  if (!record) return false;

  const weekStartDate = String(record.get("weekStartDate") || "").trim();
  const dept = String(record.get("dept") || "").trim();
  const status = String(record.get("status") || "").trim();

  return !!weekStartDate && !!dept && status === "confirmed";
}

module.exports = {
  canSaveConfirmed,
};
