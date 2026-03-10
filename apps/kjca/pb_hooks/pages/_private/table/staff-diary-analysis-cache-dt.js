/**
 * 업무일지 분석 캐시 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 분석 캐시 레코드입니다.
 * @returns {{ isSuccessStatus: () => boolean, canSaveSuccess: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
module.exports = function createStaffDiaryAnalysisCacheDT(record) {
  const reportDate = String(record.get('reportDate') || '').trim()
  const dept = String(record.get('dept') || '').trim()
  const printUrl = String(record.get('printUrl') || '').trim()
  const sourceHash = String(record.get('sourceHash') || '').trim()
  const status = String(record.get('status') || '').trim()

  return {
    isSuccessStatus() {
      return status === 'success'
    },

    canSaveSuccess() {
      return !!reportDate && !!dept && !!printUrl && !!sourceHash && (!status || status === 'success')
    },
  }
}
