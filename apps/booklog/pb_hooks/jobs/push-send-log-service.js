const COLLECTION_NAME = 'push_send_logs'
const { dateutil } = require('@pocketpages/utils')

/**
 * 오늘 날짜를 YYYY-MM-DD 문자열로 만듭니다.
 *
 * @returns {string} 오늘 날짜 문자열
 */
function getTodayDateText() {
  return dateutil.formatDate(new Date(), dateutil.FORMATS.DATE)
}

/**
 * 날짜 문자열에서 YYYY-MM-DD 기준 날짜 객체를 만듭니다.
 *
 * @param {string} dateText 날짜 문자열
 * @returns {Date | null} 파싱된 날짜 객체
 */
function parseDateOnly(dateText) {
  const normalizedDateText = String(dateText || '').trim()

  if (!normalizedDateText) {
    return null
  }

  let parsedDate = null

  try {
    parsedDate = dateutil.startOfDay(normalizedDateText)
  } catch (_exception) {
    return null
  }

  if (!parsedDate || isNaN(parsedDate.getTime())) {
    return null
  }

  return parsedDate
}

/**
 * 두 날짜 문자열 사이의 지난 일수를 계산합니다.
 *
 * @param {string} fromDateText 시작 날짜 문자열
 * @param {string} toDateText 종료 날짜 문자열
 * @returns {number | null} 지난 일수
 */
function getDaysBetween(fromDateText, toDateText) {
  const fromDate = parseDateOnly(fromDateText)
  const toDate = parseDateOnly(toDateText)

  if (!fromDate || !toDate) {
    return null
  }

  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000)
}

/**
 * 오늘 기준으로 지난 날짜 문자열을 만듭니다.
 *
 * @param {number} daysBeforeToday 오늘에서 뺄 일수
 * @returns {string} YYYY-MM-DD 날짜 문자열
 */
function getDateTextDaysAgo(daysBeforeToday) {
  const days = Number(daysBeforeToday || 0)
  const targetDate = dateutil.addDays(new Date(), -days)

  return dateutil.formatDate(targetDate, dateutil.FORMATS.DATE)
}

/**
 * 날짜 문자열의 KST 하루 시작/끝 ISO를 만듭니다.
 *
 * @param {string} dateText 날짜 문자열
 * @returns {{ startIso: string, endIso: string }} 날짜 범위
 */
function getDateRangeIso(dateText) {
  return {
    startIso: dateutil.startOfDay(dateText).toISOString(),
    endIso: dateutil.endOfDay(dateText).toISOString(),
  }
}

/**
 * 발송 시각 값을 PB date 저장용 ISO로 정규화합니다.
 *
 * @param {unknown} value 발송 시각 값
 * @returns {string} 저장용 ISO 문자열
 */
function normalizeSentAtIso(value) {
  const raw = String(value || '').trim()

  if (!raw) {
    return new Date().toISOString()
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return dateutil.toDateOnlyIso(raw)
  }

  return raw
}

/**
 * 로그 저장용 payload를 안전한 객체로 정리합니다.
 *
 * @param {object} payload 원본 payload
 * @returns {object} 정리된 payload 객체
 */
function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {}
  }

  return payload
}

/**
 * 오늘 이미 발송 성공 로그가 있는지 확인합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {string} notificationKey 알림 종류 코드
 * @returns {boolean} 오늘 발송 성공 여부
 */
function hasSentToday(userId, notificationKey) {
  const normalizedUserId = String(userId || '').trim()
  const normalizedNotificationKey = String(notificationKey || '').trim()

  if (!normalizedUserId || !normalizedNotificationKey) {
    return false
  }

  try {
    const todayRange = getDateRangeIso(getTodayDateText())
    return !!$app.findFirstRecordByFilter(
      COLLECTION_NAME,
      'user_id = {:userId} && notification_key = {:notificationKey} && send_status = "sent" && sent_at >= {:sentAtStart} && sent_at <= {:sentAtEnd}',
      {
        userId: normalizedUserId,
        notificationKey: normalizedNotificationKey,
        sentAtStart: todayRange.startIso,
        sentAtEnd: todayRange.endIso,
      }
    )
  } catch (_exception) {
    return false
  }
}

/**
 * 마지막 발송 성공 로그의 sent_at 날짜를 조회합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {string} notificationKey 알림 종류 코드
 * @returns {string} 마지막 발송 날짜 문자열
 */
function getLastSentAt(userId, notificationKey) {
  const normalizedUserId = String(userId || '').trim()
  const normalizedNotificationKey = String(notificationKey || '').trim()

  if (!normalizedUserId || !normalizedNotificationKey) {
    return ''
  }

  try {
    const logRecords = $app.findRecordsByFilter(
      COLLECTION_NAME,
      'user_id = {:userId} && notification_key = {:notificationKey} && send_status = "sent"',
      '-sent_at,-created',
      1,
      0,
      {
        userId: normalizedUserId,
        notificationKey: normalizedNotificationKey,
      }
    )

    if (!logRecords || logRecords.length === 0) {
      return ''
    }

    return String(logRecords[0] && logRecords[0].get('sent_at') ? logRecords[0].get('sent_at') : '').trim()
  } catch (_exception) {
    return ''
  }
}

/**
 * 최근 N일 안에 성공 발송된 하이라이트 ID 목록을 조회합니다.
 *
 * @param {string} userId 사용자 ID
 * @param {string} notificationKey 알림 종류 코드
 * @param {number} days 최근 일수
 * @returns {string[]} 하이라이트 ID 목록
 */
function getSentHighlightIdsWithinDays(userId, notificationKey, days) {
  const normalizedUserId = String(userId || '').trim()
  const normalizedNotificationKey = String(notificationKey || '').trim()
  const normalizedDays = Number(days)

  if (!normalizedUserId || !normalizedNotificationKey || isNaN(normalizedDays) || normalizedDays < 1) {
    return []
  }

  try {
    const cutoffDateText = getDateTextDaysAgo(normalizedDays - 1)
    const cutoffRange = getDateRangeIso(cutoffDateText)
    const logRecords = $app.findRecordsByFilter(
      COLLECTION_NAME,
      'user_id = {:userId} && notification_key = {:notificationKey} && send_status = "sent" && highlight_id != "" && sent_at >= {:cutoffDate}',
      '-sent_at,-created',
      100,
      0,
      {
        userId: normalizedUserId,
        notificationKey: normalizedNotificationKey,
        cutoffDate: cutoffRange.startIso,
      }
    )
    const highlightIdMap = {}
    const highlightIds = []

    for (let index = 0; index < logRecords.length; index += 1) {
      const highlightId = String(logRecords[index].get('highlight_id') || '').trim()

      if (!highlightId || highlightIdMap[highlightId]) {
        continue
      }

      highlightIdMap[highlightId] = true
      highlightIds.push(highlightId)
    }

    return highlightIds
  } catch (_exception) {
    return []
  }
}

/**
 * 보관 기간이 지난 푸시 발송 로그를 삭제합니다.
 *
 * @param {number} retentionDays 보관 일수
 * @returns {number} 삭제한 로그 수
 */
function cleanupExpiredLogs(retentionDays) {
  const normalizedRetentionDays = Math.floor(Number(retentionDays))

  if (isNaN(normalizedRetentionDays) || normalizedRetentionDays < 1) {
    return 0
  }

  const cutoffRange = getDateRangeIso(getDateTextDaysAgo(normalizedRetentionDays))
  const deleteResult = $app
    .db()
    .delete(
      COLLECTION_NAME,
      $dbx.exp("sent_at != '' AND sent_at < {:cutoffDate}", {
        cutoffDate: cutoffRange.startIso,
      })
    )
    .execute()

  return deleteResult.rowsAffected()
}

/**
 * 푸시 발송 로그를 저장합니다.
 *
 * @param {types.BooklogPushSendLogInput} input 로그 입력값
 */
function createLog(input) {
  /** @type {types.BooklogPushSendLogInput} */
  const source = input || {
    userId: '',
    notificationKey: '',
    channel: 'push',
    sendStatus: '',
  }
  const collection = $app.findCollectionByNameOrId(COLLECTION_NAME)
  const logRecord = new Record(collection)

  logRecord.set('user_id', String(source.userId || '').trim())
  logRecord.set('notification_key', String(source.notificationKey || '').trim())
  logRecord.set('channel', String(source.channel || 'push').trim() || 'push')
  logRecord.set('send_status', String(source.sendStatus || '').trim())
  logRecord.set('dedupe_key', String(source.dedupeKey || '').trim())
  logRecord.set('book_id', String(source.bookId || '').trim())
  logRecord.set('shelf_id', String(source.shelfId || '').trim())
  logRecord.set('highlight_id', String(source.highlightId || '').trim())
  logRecord.set('title', String(source.title || '').trim())
  logRecord.set('body_text', String(source.bodyText || '').trim())
  logRecord.set('provider_message_id', String(source.providerMessageId || '').trim())
  logRecord.set('error_message', String(source.errorMessage || '').trim())
  logRecord.set('sent_at', normalizeSentAtIso(source.sentAt))
  logRecord.set('payload_json', sanitizePayload(source.payloadJson))

  $app.save(logRecord)
}

module.exports = {
  cleanupExpiredLogs,
  createLog,
  getDateTextDaysAgo,
  getDaysBetween,
  getSentHighlightIdsWithinDays,
  getTodayDateText,
  getLastSentAt,
  hasSentToday,
}
