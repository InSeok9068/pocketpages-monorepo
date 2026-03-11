/**
 * AI 일일 모집 실적을 저장할 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} record 일일 모집 실적 record입니다.
 * @returns {boolean} 저장 가능하면 true입니다.
 */
function canSaveAiResult(record) {
  if (!record) return false;

  const reportDate = String(record.get('reportDate') || '').trim();
  const weekStartDate = String(record.get('weekStartDate') || '').trim();
  const dept = String(record.get('dept') || '').trim();
  const weekday = String(record.get('weekday') || '').trim();
  const actualCount = Number(record.get('actualCount'));
  const sourceType = String(record.get('sourceType') || '').trim();

  return !!reportDate && !!weekStartDate && !!dept && !!weekday && sourceType === 'ai' && Number.isFinite(actualCount) && actualCount >= 0;
}

module.exports = {
  canSaveAiResult,
};
