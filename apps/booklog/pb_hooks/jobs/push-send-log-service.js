const COLLECTION_NAME = 'push_send_logs'

/**
 * 오늘 날짜를 YYYY-MM-DD 문자열로 만듭니다.
 *
 * @returns {string} 오늘 날짜 문자열
 */
function getTodayDateText() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 날짜 문자열에서 YYYY-MM-DD 기준 날짜 객체를 만듭니다.
 *
 * @param {string} dateText 날짜 문자열
 * @returns {Date | null} 파싱된 날짜 객체
 */
function parseDateOnly(dateText) {
  const normalizedDateText = String(dateText || '').trim()

  if (!normalizedDateText || !/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateText)) {
    return null
  }

  const parsedDate = new Date(normalizedDateText + 'T00:00:00Z')

  if (isNaN(parsedDate.getTime())) {
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
 * 로그 저장용 payload를 안전한 객체로 정리합니다.
 *
 * @param {Object} payload 원본 payload
 * @returns {Object} 정리된 payload 객체
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
    return !!$app.findFirstRecordByFilter(COLLECTION_NAME, 'user_id = {:userId} && notification_key = {:notificationKey} && send_status = "sent" && sent_at = {:sentAt}', {
      userId: normalizedUserId,
      notificationKey: normalizedNotificationKey,
      sentAt: getTodayDateText(),
    })
  } catch (exception) {
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
    const logRecords = $app.findRecordsByFilter(COLLECTION_NAME, 'user_id = {:userId} && notification_key = {:notificationKey} && send_status = "sent"', '-sent_at,-created', 1, 0, {
      userId: normalizedUserId,
      notificationKey: normalizedNotificationKey,
    })

    if (!logRecords || logRecords.length === 0) {
      return ''
    }

    return String(logRecords[0] && logRecords[0].get('sent_at') ? logRecords[0].get('sent_at') : '').trim()
  } catch (exception) {
    return ''
  }
}

/**
 * 푸시 발송 로그를 저장합니다.
 *
 * @param {Object} input 로그 입력값
 * @param {string} input.userId 사용자 ID
 * @param {string} input.notificationKey 알림 종류 코드
 * @param {string} input.channel 채널 코드
 * @param {string} input.sendStatus 발송 결과 상태
 * @param {string} [input.dedupeKey] 중복 방지 키
 * @param {string} [input.bookId] 관련 책 ID
 * @param {string} [input.shelfId] 관련 책장 ID
 * @param {string} [input.highlightId] 관련 하이라이트 ID
 * @param {string} [input.title] 발송 제목
 * @param {string} [input.bodyText] 발송 본문
 * @param {string} [input.providerMessageId] 외부 발송 ID
 * @param {string} [input.errorMessage] 실패 메시지
 * @param {string} [input.sentAt] 발송 일자
 * @param {Object} [input.payloadJson] 원본 payload
 */
function createLog(input) {
  const source = input || {}
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
  logRecord.set('sent_at', String(source.sentAt || getTodayDateText()).trim())
  logRecord.set('payload_json', sanitizePayload(source.payloadJson))

  $app.save(logRecord)
}

module.exports = {
  createLog,
  getDaysBetween,
  getTodayDateText,
  getLastSentAt,
  hasSentToday,
}
