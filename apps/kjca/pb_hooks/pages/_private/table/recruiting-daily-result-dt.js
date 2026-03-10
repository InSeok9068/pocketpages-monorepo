/**
 * 일일 모집 실적 레코드의 저장 가능 상태를 판단하는 DT를 만듭니다.
 * @param {core.Record} record 검증할 모집 실적 레코드입니다.
 * @returns {{ isAiSource: () => boolean, canSaveAiResult: () => boolean }} 저장 전 상태를 확인하는 DT입니다.
 */
function toDT(record) {
  const id = record.get('id')
  const reportDate = String(record.get('reportDate') || '').trim()
  const weekStartDate = String(record.get('weekStartDate') || '').trim()
  const dept = String(record.get('dept') || '').trim()
  const weekday = String(record.get('weekday') || '').trim()
  const actualCount = Number(record.get('actualCount'))
  const sourceType = String(record.get('sourceType') || '').trim()
  const memo = String(record.get('memo') || '').trim()
  const createdBy = record.get('createdBy')
  const created = record.get('created')
  const updated = record.get('updated')

  return {
    isAiSource() {
      return sourceType === 'ai'
    },

    canSaveAiResult() {
      return !!reportDate && !!weekStartDate && !!dept && !!weekday && sourceType === 'ai' && Number.isFinite(actualCount) && actualCount >= 0
    },
  }
}

module.exports = {
  toDT,
}
