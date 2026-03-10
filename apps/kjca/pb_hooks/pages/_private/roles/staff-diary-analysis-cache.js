/**
 * 분석 캐시를 success 상태로 저장할 수 있는지 판단합니다.
 * @param {core.Record | null | undefined} record 분석 캐시 record입니다.
 * @returns {boolean} 저장 가능하면 true입니다.
 */
function canSaveSuccess(record) {
  if (!record) return false;

  const reportDate = String(record.get("reportDate") || "").trim();
  const dept = String(record.get("dept") || "").trim();
  const printUrl = String(record.get("printUrl") || "").trim();
  const sourceHash = String(record.get("sourceHash") || "").trim();
  const status = String(record.get("status") || "").trim();

  return !!reportDate && !!dept && !!printUrl && !!sourceHash && (!status || status === "success");
}

module.exports = {
  canSaveSuccess,
};
