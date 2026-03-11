/**
 * 주간 텍스트 행을 저장할 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} record 주간 텍스트 행 record입니다.
 * @returns {boolean} 저장 가능하면 true입니다.
 */
function canSave(record) {
  if (!record) return false;

  const weekday = String(record.get('weekday') || '').trim();
  return !!weekday;
}

module.exports = {
  canSave,
};
