const COLLECTION_NAME = 'homeping_notified_notices'
const BROADCAST_REGION = 'all'
const { dateutil } = require('@pocketpages/utils')

/**
 * 문자열을 PocketBase 필드 길이에 맞게 자릅니다.
 * @param {unknown} value 원본 값
 * @param {number} max 최대 길이
 * @returns {string} 정규화된 문자열
 */
function truncateText(value, max) {
  const text = String(value || '').trim()
  const limit = Number(max || 0)

  if (!limit || text.length <= limit) {
    return text
  }

  return text.slice(0, limit)
}

/**
 * 공고 중복 판단 키를 만듭니다.
 * @param {types.HomepingNotice} notice 공고
 * @returns {string} 공고 키
 */
function getNoticeKey(notice) {
  if (!notice) {
    return ''
  }

  return truncateText(notice.id || notice.detailUrl || notice.name, 255)
}

/**
 * 이미 전체 구독자 알림을 보낸 공고인지 확인합니다.
 * @param {string} noticeKey 공고 키
 * @returns {boolean} 발송 기록 존재 여부
 */
function hasNotifiedNotice(noticeKey) {
  const normalizedNoticeKey = String(noticeKey || '').trim()

  if (!normalizedNoticeKey) {
    return false
  }

  try {
    return !!$app.findFirstRecordByFilter(COLLECTION_NAME, 'notice_key = {:noticeKey} && region = {:region}', {
      noticeKey: normalizedNoticeKey,
      region: BROADCAST_REGION,
    })
  } catch (_exception) {
    return false
  }
}

/**
 * 공고 알림 발송 기록을 저장합니다.
 * @param {types.HomepingNotifiedNoticeInput} input 저장 입력값
 */
function createNotifiedNotice(input) {
  /** @type {types.HomepingNotifiedNoticeInput} */
  const source = input || {
    notice: null,
  }
  const notice = source.notice
  const noticeKey = getNoticeKey(notice)
  const collection = $app.findCollectionByNameOrId(COLLECTION_NAME)
  const record = new Record(collection)

  record.set('notice_key', noticeKey)
  record.set('source', truncateText(notice && notice.sourceCode ? notice.sourceCode : 'unknown', 40))
  record.set('region', truncateText(source.region || BROADCAST_REGION, 40))
  record.set('title', truncateText(notice && notice.name ? notice.name : noticeKey, 300))
  record.set('notice_url', truncateText(notice && notice.detailUrl ? notice.detailUrl : '', 2000))
  record.set('recruit_date', dateutil.toDateOnlyIso(notice && notice.recruitDate))
  record.set('apply_end_date', dateutil.toDateOnlyIso(notice && notice.applyEndDate))
  record.set('notified_at', String(source.notifiedAt || new Date().toISOString()).trim())
  record.set('onesignal_notification_id', truncateText(source.providerMessageId, 100))

  $app.save(record)
}

module.exports = {
  BROADCAST_REGION,
  createNotifiedNotice,
  getNoticeKey,
  hasNotifiedNotice,
}
