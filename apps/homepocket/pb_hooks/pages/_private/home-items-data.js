const { dateutil } = require('@pocketpages/utils')

const SECTION_VALUES = ['task', 'purchase', 'grocery']
const STATUS_VALUES = ['all', 'open', 'done']
const WEEKDAY_VALUES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * 검색 입력을 사용할 수 있는 필터 값으로 정리한다.
 * @param {Record<string, any>} input 입력값
 * @returns {types.HomeItemFilters} 정리된 필터
 */
function readFilters(input) {
  const source = input || {}
  const section = SECTION_VALUES.indexOf(String(source.section || '')) >= 0 ? String(source.section) : 'task'
  const status = STATUS_VALUES.indexOf(String(source.status || '')) >= 0 ? String(source.status) : 'all'
  let tag = String(source.tag || '')

  if (section === 'task' && ['none', 'weekly', 'monthly'].indexOf(tag) < 0) tag = ''
  if (section !== 'task' && ['offline', 'online', 'untagged'].indexOf(tag) < 0) tag = ''

  return {
    section,
    keyword: String(source.keyword || '').trim().slice(0, 100),
    status,
    tag,
  }
}

/**
 * 반복 주기와 태그에 맞는 생활 항목을 조회한다.
 * @param {string} userId 사용자 ID
 * @param {types.HomeItemFilters} filters 검색 조건
 * @returns {types.HomeItemCard[]} 목록 카드
 */
function listItems(userId, filters) {
  const expressions = ['user = {:userId}', 'section = {:section}']
  const values = { userId, section: filters.section }

  if (filters.keyword) {
    expressions.push('title ~ {:keyword}')
    values.keyword = filters.keyword
  }

  const sort = filters.section === 'task' ? '+nextDueDate,-created' : '-created'
  const records = $app.findRecordsByFilter('homeItems', expressions.join(' && '), sort, 500, 0, values)
  const today = dateutil.formatDate(new Date(), dateutil.FORMATS.DATE)
  const cards = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const repeatFrequency = String(record.get('repeatFrequency') || 'none')
    const nextDueDate = String(record.get('nextDueDate') || '')
    const status = getEffectiveStatus(record, today)
    const channel = String(record.get('channel') || '')
    const repeatWeekdays = toStringArray(record.get('repeatWeekdays'))
    const card = {
      id: String(record.get('id') || ''),
      title: String(record.get('title') || ''),
      note: String(record.get('note') || ''),
      section: filters.section,
      channel,
      status,
      repeatFrequency,
      repeatInterval: Number(record.get('repeatInterval') || 1),
      repeatWeekdays,
      repeatDayOfMonth: Number(record.get('repeatDayOfMonth') || 0),
      nextDueDate,
      nextDueLabel: formatDateOnly(nextDueDate),
    }

    if (filters.status !== 'all' && card.status !== filters.status) continue
    if (filters.section === 'task' && filters.tag && card.repeatFrequency !== filters.tag) continue
    if (filters.section !== 'task' && filters.tag === 'untagged' && card.channel) continue
    if (filters.section !== 'task' && filters.tag && filters.tag !== 'untagged' && card.channel !== filters.tag) continue

    cards.push(card)
  }

  return cards
}

/**
 * 반복 항목의 예정일이 되면 완료 상태를 다시 진행 중으로 표시한다.
 * @param {types.PocketBaseRecord} record 생활 항목 레코드
 * @param {string} [today] 오늘 날짜
 * @returns {'open'|'done'} 화면에 표시할 상태
 */
function getEffectiveStatus(record, today) {
  const frequency = String(record.get('repeatFrequency') || 'none')
  const dueDate = String(record.get('nextDueDate') || '')
  const currentDate = today || dateutil.formatDate(new Date(), dateutil.FORMATS.DATE)

  if (frequency !== 'none' && dueDate && (dateutil.isBeforeDay(dueDate, currentDate) || dateutil.isSameDay(dueDate, currentDate))) {
    return 'open'
  }

  return String(record.get('status') || 'open') === 'done' ? 'done' : 'open'
}

/**
 * 반복 일정이 끝난 뒤 다음 예정일을 계산한다.
 * @param {'weekly'|'monthly'} frequency 반복 주기
 * @param {number} interval 반복 간격
 * @param {string[]} weekdays 반복 요일
 * @param {number} dayOfMonth 매월 반복 날짜
 * @param {string} dueDate 현재 예정일
 * @returns {string} 다음 예정일의 PB date ISO 값
 */
function nextDueDate(frequency, interval, weekdays, dayOfMonth, dueDate) {
  const today = dateutil.formatDate(new Date(), dateutil.FORMATS.DATE)
  const baseDate = dueDate && dateutil.isBeforeDay(dueDate, today) ? today : (dueDate || today)
  const repeatInterval = Math.max(1, Math.min(12, Number(interval) || 1))

  if (frequency === 'weekly') {
    const selectedDays = weekdays || []
    const baseWeekday = Number(dateutil.formatDate(baseDate, 'd'))
    const mondayOffset = (baseWeekday + 6) % 7

    for (let offset = 1; offset <= repeatInterval * 7 + 7; offset += 1) {
      const candidate = dateutil.addDays(baseDate, offset)
      const weekday = Number(dateutil.formatDate(candidate, 'd'))
      const weekOffset = Math.floor((mondayOffset + offset) / 7)

      if (selectedDays.indexOf(WEEKDAY_VALUES[weekday]) >= 0 && weekOffset % repeatInterval === 0) {
        return dateutil.toDateOnlyIso(candidate)
      }
    }

    return dateutil.toDateOnlyIso(dateutil.addDays(baseDate, 7 * repeatInterval))
  }

  return monthlyDate(baseDate, repeatInterval, dayOfMonth)
}

/**
 * 폼에서 반복 요일을 배열로 읽는다.
 * @param {any} value 입력값
 * @returns {string[]} 요일 코드
 */
function readWeekdays(value) {
  const values = toStringArray(value)
  const weekdays = []

  for (let index = 0; index < values.length; index += 1) {
    if (WEEKDAY_VALUES.indexOf(values[index]) >= 0 && weekdays.indexOf(values[index]) < 0) weekdays.push(values[index])
  }

  return weekdays
}

/**
 * 다음 달 반복일을 지정한 날짜로 맞춘다.
 * @param {string} baseDate 기준 날짜
 * @param {number} interval 월 간격
 * @param {number} dayOfMonth 반복 날짜
 * @returns {string} 다음 날짜의 PB date ISO 값
 */
function monthlyDate(baseDate, interval, dayOfMonth) {
  const monthDate = dateutil.addMonths(baseDate, interval)
  const yearMonth = dateutil.formatDate(monthDate, 'YYYY-MM')
  const parts = yearMonth.split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.max(1, Math.min(monthEnd, Number(dayOfMonth) || 1))
  const dateText = yearMonth + '-' + ('0' + day).slice(-2)

  return dateutil.toDateOnlyIso(dateText)
}

/**
 * 다중 선택값을 문자열 배열로 바꾼다.
 * @param {any} value 입력값
 * @returns {string[]} 문자열 목록
 */
function toStringArray(value) {
  if (Array.isArray(value)) {
    const values = []
    for (let index = 0; index < value.length; index += 1) values.push(String(value[index] || '').trim())
    return values
  }

  const text = String(value || '').trim()
  return text ? text.split(',').map(function (item) { return item.trim() }).filter(function (item) { return !!item }) : []
}

/**
 * PB date-only 값의 저장된 날짜 부분을 화면용으로 바꾼다.
 * @param {string} value 날짜 값
 * @returns {string} 화면용 날짜
 */
function formatDateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? Number(match[2]) + '월 ' + Number(match[3]) + '일' : ''
}

module.exports = {
  readFilters,
  listItems,
  getEffectiveStatus,
  nextDueDate,
  readWeekdays,
  formatDateOnly,
}
