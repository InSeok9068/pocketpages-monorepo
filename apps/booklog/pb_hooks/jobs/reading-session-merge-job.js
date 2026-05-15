const RETENTION_DAYS = 30
const BATCH_LIMIT = 1000
const KST_OFFSET_MINUTES = 9 * 60

/**
 * UTC 시각 문자열을 한국 날짜 기준 YYYY-MM-DD로 바꿉니다.
 *
 * @param {string} value 기준 시각
 * @returns {string} 한국 날짜 문자열
 */
function getKoreanDateKey(value) {
  const date = new Date(String(value || '').trim())

  if (isNaN(date.getTime())) {
    return ''
  }

  return new Date(date.getTime() + KST_OFFSET_MINUTES * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 한국 날짜 기준 보존 기한의 UTC ISO 문자열을 만듭니다.
 *
 * @param {number} retentionDays 보존 일수
 * @returns {string} cutoff ISO 문자열
 */
function getCutoffIso(retentionDays) {
  const now = new Date()
  const kstNow = new Date(now.getTime() + KST_OFFSET_MINUTES * 60 * 1000)

  kstNow.setUTCHours(0, 0, 0, 0)
  kstNow.setUTCDate(kstNow.getUTCDate() - retentionDays)

  return new Date(kstNow.getTime() - KST_OFFSET_MINUTES * 60 * 1000).toISOString()
}

/**
 * 레코드 값을 문자열로 읽습니다.
 *
 * @param {any} record PocketBase record
 * @param {string} fieldName 필드명
 * @returns {string} 정리된 문자열
 */
function readString(record, fieldName) {
  return String(record && record.get(fieldName) ? record.get(fieldName) : '').trim()
}

/**
 * 숫자 필드를 읽습니다.
 *
 * @param {any} record PocketBase record
 * @param {string} fieldName 필드명
 * @returns {number | null} 숫자 값
 */
function readNumber(record, fieldName) {
  const rawValue = record ? record.get(fieldName) : null
  const normalizedValue = rawValue === null || typeof rawValue === 'undefined' ? '' : String(rawValue).trim()
  const parsedValue = normalizedValue ? Number(normalizedValue) : NaN

  if (!normalizedValue || !isFinite(parsedValue)) {
    return null
  }

  return Math.round(parsedValue)
}

/**
 * 숫자 필드를 선택 값으로 저장합니다.
 *
 * @param {any} record 저장할 record
 * @param {string} fieldName 필드명
 * @param {number | null} value 저장 값
 */
function setOptionalNumber(record, fieldName, value) {
  if (value === null || typeof value === 'undefined' || !isFinite(Number(value))) {
    record.set(fieldName, null)
    return
  }

  record.set(fieldName, Math.round(Number(value)))
}

/**
 * 오래된 독서 세션 후보를 조회합니다.
 *
 * @param {string} cutoffIso 보존 기한
 * @returns {Array<any>} 독서 세션 후보
 */
function findMergeCandidateRecords(cutoffIso) {
  return $app.findRecordsByFilter('reading_sessions', 'ended_at != "" && ended_at < {:cutoffIso}', 'user_id,book_id,file_id,ended_at,created', BATCH_LIMIT, 0, {
    cutoffIso: cutoffIso,
  })
}

/**
 * 같은 날짜와 책 파일 기준으로 병합 그룹을 만듭니다.
 *
 * @param {Array<any>} sessionRecords 독서 세션 목록
 * @returns {{[key: string]: Array<any>}} 병합 그룹
 */
function groupSessionRecords(sessionRecords) {
  /** @type {types.BooklogReadingSessionGroupMap} */
  const groups = {}

  for (let index = 0; index < sessionRecords.length; index += 1) {
    const sessionRecord = sessionRecords[index]
    const userId = readString(sessionRecord, 'user_id')
    const bookId = readString(sessionRecord, 'book_id')
    const fileId = readString(sessionRecord, 'file_id')
    const dateKey = getKoreanDateKey(readString(sessionRecord, 'ended_at'))
    const groupKey = [userId, bookId, fileId, dateKey].join('::')

    if (!userId || !bookId || !dateKey) {
      continue
    }

    if (!groups[groupKey]) {
      groups[groupKey] = []
    }

    groups[groupKey].push(sessionRecord)
  }

  return groups
}

/**
 * 세션 시작 시각 기준 정렬 값을 만듭니다.
 *
 * @param {any} sessionRecord 독서 세션 record
 * @returns {string} 정렬 값
 */
function getStartSortValue(sessionRecord) {
  return readString(sessionRecord, 'started_at') || readString(sessionRecord, 'created') || readString(sessionRecord, 'id')
}

/**
 * 세션 종료 시각 기준 정렬 값을 만듭니다.
 *
 * @param {any} sessionRecord 독서 세션 record
 * @returns {string} 정렬 값
 */
function getEndSortValue(sessionRecord) {
  return readString(sessionRecord, 'ended_at') || readString(sessionRecord, 'updated') || readString(sessionRecord, 'id')
}

/**
 * 세션을 시작 순서로 정렬합니다.
 *
 * @param {Array<any>} sessionRecords 독서 세션 목록
 * @returns {Array<any>} 정렬된 목록
 */
function sortByStart(sessionRecords) {
  return sessionRecords.slice().sort(function (left, right) {
    return getStartSortValue(left).localeCompare(getStartSortValue(right))
  })
}

/**
 * 세션을 종료 순서로 정렬합니다.
 *
 * @param {Array<any>} sessionRecords 독서 세션 목록
 * @returns {Array<any>} 정렬된 목록
 */
function sortByEnd(sessionRecords) {
  return sessionRecords.slice().sort(function (left, right) {
    return getEndSortValue(left).localeCompare(getEndSortValue(right))
  })
}

/**
 * 세션 목록의 총 독서 시간을 계산합니다.
 *
 * @param {Array<any>} sessionRecords 독서 세션 목록
 * @returns {number} 총 독서 초
 */
function sumDurationSeconds(sessionRecords) {
  let totalSeconds = 0

  for (let index = 0; index < sessionRecords.length; index += 1) {
    const durationSeconds = readNumber(sessionRecords[index], 'duration_seconds')

    if (durationSeconds !== null && durationSeconds > 0) {
      totalSeconds += durationSeconds
    }
  }

  return totalSeconds
}

/**
 * 병합 대표 세션을 갱신합니다.
 *
 * @param {any} keeperRecord 대표로 남길 record
 * @param {any} firstRecord 첫 세션 record
 * @param {any} lastRecord 마지막 세션 record
 * @param {number} durationSeconds 총 독서 초
 */
function updateMergedSessionRecord(keeperRecord, firstRecord, lastRecord, durationSeconds) {
  const startProgressPercent = readNumber(firstRecord, 'start_progress_percent')
  const endProgressPercent = readNumber(lastRecord, 'end_progress_percent')
  const startPage = readNumber(firstRecord, 'start_page')
  const endPage = readNumber(lastRecord, 'end_page')

  keeperRecord.set('started_at', readString(firstRecord, 'started_at'))
  keeperRecord.set('ended_at', readString(lastRecord, 'ended_at'))
  keeperRecord.set('duration_seconds', durationSeconds)
  keeperRecord.set('start_locator', readString(firstRecord, 'start_locator'))
  keeperRecord.set('end_locator', readString(lastRecord, 'end_locator'))
  keeperRecord.set('start_href', readString(firstRecord, 'start_href'))
  keeperRecord.set('end_href', readString(lastRecord, 'end_href'))
  keeperRecord.set('start_chapter_label', readString(firstRecord, 'start_chapter_label'))
  keeperRecord.set('end_chapter_label', readString(lastRecord, 'end_chapter_label'))
  setOptionalNumber(keeperRecord, 'start_progress_percent', startProgressPercent)
  setOptionalNumber(keeperRecord, 'end_progress_percent', endProgressPercent)
  setOptionalNumber(keeperRecord, 'progress_delta_percent', startProgressPercent !== null && endProgressPercent !== null ? endProgressPercent - startProgressPercent : null)
  setOptionalNumber(keeperRecord, 'start_page', startPage)
  setOptionalNumber(keeperRecord, 'end_page', endPage)
  setOptionalNumber(keeperRecord, 'page_delta', startPage !== null && endPage !== null ? endPage - startPage : null)
}

/**
 * 같은 날짜의 독서 세션들을 하나의 트랜잭션으로 합칩니다.
 *
 * @param {Array<any>} sessionRecords 병합할 세션 목록
 * @returns {{merged: boolean, deletedCount: number}} 병합 결과
 */
function mergeSessionGroup(sessionRecords) {
  const startSortedRecords = sortByStart(sessionRecords)
  const endSortedRecords = sortByEnd(sessionRecords)
  const keeperRecord = startSortedRecords[0]
  const firstRecord = startSortedRecords[0]
  const lastRecord = endSortedRecords[endSortedRecords.length - 1]
  const durationSeconds = sumDurationSeconds(sessionRecords)
  let deletedCount = 0

  if (sessionRecords.length < 2 || !keeperRecord || !firstRecord || !lastRecord || durationSeconds < 1) {
    return {
      merged: false,
      deletedCount: 0,
    }
  }

  $app.runInTransaction(function (txApp) {
    updateMergedSessionRecord(keeperRecord, firstRecord, lastRecord, durationSeconds)
    txApp.save(keeperRecord)

    for (let index = 0; index < sessionRecords.length; index += 1) {
      const sessionRecord = sessionRecords[index]

      if (readString(sessionRecord, 'id') === readString(keeperRecord, 'id')) {
        continue
      }

      txApp.delete(sessionRecord)
      deletedCount += 1
    }
  })

  return {
    merged: true,
    deletedCount: deletedCount,
  }
}

/**
 * 오래된 독서 세션을 날짜별로 병합합니다.
 *
 * @returns {{ready: boolean, candidateCount: number, mergedGroupCount: number, deletedCount: number}} 작업 결과
 */
function run() {
  const cutoffIso = getCutoffIso(RETENTION_DAYS)
  const sessionRecords = findMergeCandidateRecords(cutoffIso)
  const groups = groupSessionRecords(sessionRecords)
  const groupKeys = Object.keys(groups)
  let mergedGroupCount = 0
  let deletedCount = 0

  $app.logger().info('jobs/reading-session-merge:start', 'cutoffIso', cutoffIso, 'candidateCount', String(sessionRecords.length), 'groupCount', String(groupKeys.length))

  for (let index = 0; index < groupKeys.length; index += 1) {
    const groupKey = groupKeys[index]
    const groupRecords = groups[groupKey]

    if (!groupRecords || groupRecords.length < 2) {
      continue
    }

    try {
      const result = mergeSessionGroup(groupRecords)

      if (result.merged) {
        mergedGroupCount += 1
        deletedCount += result.deletedCount
      }
    } catch (exception) {
      $app.logger().error('jobs/reading-session-merge:group-failed', 'groupKey', groupKey, 'count', String(groupRecords.length), 'error', String(exception && exception.message ? exception.message : exception))
    }
  }

  $app.logger().info('jobs/reading-session-merge:done', 'candidateCount', String(sessionRecords.length), 'mergedGroupCount', String(mergedGroupCount), 'deletedCount', String(deletedCount))

  return {
    ready: true,
    candidateCount: sessionRecords.length,
    mergedGroupCount: mergedGroupCount,
    deletedCount: deletedCount,
  }
}

module.exports = {
  run,
}
