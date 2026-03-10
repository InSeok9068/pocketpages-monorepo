/**
 * 업무일지 분석 캐시 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 분석 캐시 레코드입니다.
 * @returns {{ isSuccessStatus: () => boolean, canSaveSuccess: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
module.exports = function createStaffDiaryAnalysisCacheDT(record) {
  const id = record.get('id')
  const reportDate = String(record.get('reportDate') || '').trim()
  const dept = String(record.get('dept') || '').trim()
  const staffName = String(record.get('staffName') || '').trim()
  const printUrl = String(record.get('printUrl') || '').trim()
  const sourceHash = String(record.get('sourceHash') || '').trim()
  const promotion = record.get('promotion')
  const vacation = record.get('vacation')
  const special = record.get('special')
  const recruiting = record.get('recruiting')
  const status = String(record.get('status') || '').trim()
  const errorMessage = String(record.get('errorMessage') || '').trim()
  const model = String(record.get('model') || '').trim()
  const promptVersion = String(record.get('promptVersion') || '').trim()
  const created = record.get('created')
  const updated = record.get('updated')

  return {
    isSuccessStatus() {
      return status === 'success'
    },

    canSaveSuccess() {
      return !!reportDate && !!dept && !!printUrl && !!sourceHash && (!status || status === 'success')
    },
  }
}
