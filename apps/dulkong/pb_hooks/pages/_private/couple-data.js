const { dateutil } = require('@pocketpages/utils')

const ProfileNames = {
  inseok: '인석',
  solmi: '솔미',
}

/**
 * 프로필 키의 표시 이름을 반환합니다.
 * @param {string} profileKey 프로필 키
 * @returns {string} 표시 이름
 */
function getProfileName(profileKey) {
  return ProfileNames[String(profileKey || '')] || '둘콩'
}

/**
 * 사용자 레코드를 표시용 프로필로 변환합니다.
 * @param {core.Record} record 사용자 레코드
 * @returns {types.CoupleProfile} 프로필
 */
function mapProfile(record) {
  const storedName = String(record.get('name') || '').trim()
  const storedProfileKey = String(record.get('profileKey') || '')
  const profileKey = storedProfileKey || (storedName === '솔미' ? 'solmi' : 'inseok')

  return {
    id: String(record.get('id') || ''),
    profileKey: profileKey,
    name: storedName || getProfileName(profileKey),
    emoji: profileKey === 'solmi' ? '🌱' : '🫘',
    colorClass: profileKey === 'solmi' ? 'bg-[#e1eaff]' : 'bg-[#ffe5db]',
  }
}

/**
 * 로그인 사용자와 상대방 프로필을 조회합니다.
 * @param {types.CoupleDataApp} app PocketBase 앱
 * @param {core.Record} authRecord 로그인 사용자
 * @returns {types.CoupleProfiles} 커플 프로필
 */
function getCoupleProfiles(app, authRecord) {
  const current = mapProfile(authRecord)
  let partner = null

  try {
    const partnerRecord = app.findFirstRecordByFilter('users', 'id != {:userId}', {
      userId: current.id,
    })
    partner = mapProfile(partnerRecord)
  } catch (_exception) {
    partner = {
      id: '',
      profileKey: current.profileKey === 'inseok' ? 'solmi' : 'inseok',
      name: current.profileKey === 'inseok' ? '솔미' : '인석',
      emoji: current.profileKey === 'inseok' ? '🌱' : '🫘',
      colorClass: current.profileKey === 'inseok' ? 'bg-[#e1eaff]' : 'bg-[#ffe5db]',
    }
  }

  return { current: current, partner: partner }
}

/**
 * 연도 반복 날짜의 다음 발생일을 구합니다.
 * @param {string} dateText 기준 날짜
 * @param {Date} now 현재 시각
 * @returns {string} 다음 발생일
 */
function getNextYearlyDate(dateText, now) {
  const monthDay = dateText.slice(5)
  const currentYear = dateutil.formatDate(now, 'YYYY')
  const thisYear = currentYear + '-' + monthDay

  if (dateutil.diffDays(thisYear, now) >= 0) return thisYear

  return String(Number(currentYear) + 1) + '-' + monthDay
}

/**
 * 기념일 레코드를 표시용 데이터로 변환합니다.
 * @param {core.Record} record 기념일 레코드
 * @param {Date} now 현재 시각
 * @returns {types.AnniversaryItem} 기념일 항목
 */
function mapAnniversary(record, now) {
  const eventDate = dateutil.formatDate(record.get('eventDate'), dateutil.FORMATS.DATE)
  const kind = String(record.get('kind') || 'custom')
  const recurrence = String(record.get('recurrence') || 'none')
  const targetDate = recurrence === 'yearly' ? getNextYearlyDate(eventDate, now) : eventDate
  const difference = dateutil.diffDays(targetDate, now)
  let dayLabel = difference === 0 ? 'D-DAY' : difference > 0 ? 'D-' + String(difference) : 'D+' + String(Math.abs(difference))

  if (kind === 'relationship_start') {
    dayLabel = '+' + String(Math.max(1, dateutil.diffDays(now, eventDate) + 1))
  }

  return {
    id: String(record.get('id') || ''),
    kind: kind,
    title: String(record.get('title') || ''),
    eventDate: eventDate,
    dateLabel: dateutil.formatDate(eventDate, 'YYYY.MM.DD'),
    recurrence: recurrence,
    emoji: String(record.get('emoji') || (kind === 'birthday' ? '🎂' : kind === 'relationship_start' ? '❤️' : '🌿')),
    isPinned: Boolean(record.get('isPinned')),
    dayLabel: dayLabel,
    difference: kind === 'relationship_start' ? -999999 : difference,
  }
}

/**
 * 기념일 목록을 조회합니다.
 * @param {types.CoupleDataApp} app PocketBase 앱
 * @param {Date} [now] 현재 시각
 * @returns {types.AnniversaryItem[]} 기념일 목록
 */
function listAnniversaries(app, now) {
  const sourceDate = now || new Date()
  const records = app.findRecordsByFilter('anniversaries', '', '-isPinned,+eventDate', 100, 0)

  return records
    .map(function (record) {
      return mapAnniversary(record, sourceDate)
    })
    .sort(function (left, right) {
      if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
      return left.difference - right.difference
    })
}

/**
 * 사진 레코드를 표시용 데이터로 변환합니다.
 * @param {core.Record} record 사진 레코드
 * @returns {types.PhotoItem} 사진 항목
 */
function mapPhoto(record) {
  const fileName = String(record.get('image') || '')
  const takenAtValue = record.get('takenAt') || record.get('created')
  const collectionName = String(record.collection().name || 'photos')
  const recordId = String(record.get('id') || '')

  return {
    id: recordId,
    uploaderId: String(record.get('uploader') || ''),
    caption: String(record.get('caption') || '').trim() || '우리의 순간',
    locationName: String(record.get('locationName') || '').trim(),
    takenAt: dateutil.formatDate(takenAtValue, dateutil.FORMATS.DATE),
    dateLabel: dateutil.formatDate(takenAtValue, 'M.DD'),
    monthLabel: dateutil.formatDate(takenAtValue, dateutil.FORMATS.MONTH_KR),
    isFavorite: Boolean(record.get('isFavorite')),
    imageUrl: '/api/files/' + encodeURIComponent(collectionName) + '/' + encodeURIComponent(recordId) + '/' + encodeURIComponent(fileName) + '?thumb=960x0',
  }
}

/**
 * 사진 목록을 조회합니다.
 * @param {types.CoupleDataApp} app PocketBase 앱
 * @param {string} filter 필터 값
 * @returns {types.PhotoItem[]} 사진 목록
 */
function listPhotos(app, filter) {
  let query = "deletedAt = ''"
  const normalizedFilter = String(filter || 'all')

  if (normalizedFilter === 'favorite') query += ' && isFavorite = true'
  if (/^\d{4}$/.test(normalizedFilter)) {
    query += ' && takenAt >= {:start} && takenAt <= {:end}'
  }

  const filterValues = /^\d{4}$/.test(normalizedFilter)
    ? {
        start: dateutil.startOfDay(normalizedFilter + '-01-01').toISOString(),
        end: dateutil.endOfDay(normalizedFilter + '-12-31').toISOString(),
      }
    : {}
  const records = app.findRecordsByFilter('photos', query, '-takenAt,-created', 200, 0, filterValues)

  return records.map(mapPhoto)
}

/**
 * 메시지 레코드를 표시용 데이터로 변환합니다.
 * @param {core.Record} record 메시지 레코드
 * @param {string} currentUserId 현재 사용자 ID
 * @returns {types.MessageItem} 메시지 항목
 */
function mapMessage(record, currentUserId) {
  const createdValue = record.get('clientCreatedAt') || record.get('created')
  const body = String(record.get('body') || '')

  return {
    id: String(record.get('id') || ''),
    senderId: String(record.get('sender') || ''),
    body: body,
    lines: body.split(/\r\n?|\n/),
    createdAt: String(record.get('created') || ''),
    mine: String(record.get('sender') || '') === currentUserId,
    timeLabel: dateutil.formatDate(createdValue, dateutil.FORMATS.TIME_MINUTES),
    dateLabel: dateutil.formatDate(createdValue, 'M월 D일'),
  }
}

/**
 * 메시지 페이지를 오래된 순으로 조회합니다.
 * @param {types.CoupleDataApp} app PocketBase 앱
 * @param {string} currentUserId 현재 사용자 ID
 * @param {types.MessagePageOptions} [options] 페이지 조건
 * @returns {types.MessagePage} 메시지 페이지
 */
function getMessagePage(app, currentUserId, options) {
  const pageOptions = options || {}
  const limit = Math.max(1, Math.min(100, Number(pageOptions.limit) || 50))
  const beforeCreated = String(pageOptions.beforeCreated || '')
  const beforeId = String(pageOptions.beforeId || '')
  let filter = "deletedAt = ''"
  let filterValues = {}

  if (beforeCreated && beforeId) {
    filter += ' && (created < {:beforeCreated} || (created = {:beforeCreated} && id < {:beforeId}))'
    filterValues = { beforeCreated: beforeCreated, beforeId: beforeId }
  }

  const records = app.findRecordsByFilter('messages', filter, '-created,-id', limit + 1, 0, filterValues)
  const recordCount = Math.min(records.length, limit)
  const messages = []

  for (let index = recordCount - 1; index >= 0; index -= 1) {
    messages.push(mapMessage(records[index], currentUserId))
  }

  return { messages: messages, hasMore: records.length > limit }
}

/**
 * 최근 메시지를 오래된 순으로 조회합니다.
 * @param {types.CoupleDataApp} app PocketBase 앱
 * @param {string} currentUserId 현재 사용자 ID
 * @returns {types.MessageItem[]} 메시지 목록
 */
function listMessages(app, currentUserId) {
  return getMessagePage(app, currentUserId).messages
}

module.exports = {
  getCoupleProfiles,
  getProfileName,
  getMessagePage,
  listAnniversaries,
  listMessages,
  listPhotos,
  mapMessage,
}
