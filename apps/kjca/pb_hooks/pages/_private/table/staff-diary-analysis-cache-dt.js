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
