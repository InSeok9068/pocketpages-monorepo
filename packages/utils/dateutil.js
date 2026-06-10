'use strict'

const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')

dayjs.extend(utc)

const KST_OFFSET_MINUTES = 9 * 60
const KST_OFFSET_MS = KST_OFFSET_MINUTES * 60 * 1000

const FORMATS = Object.freeze({
  DATE: 'YYYY-MM-DD',
  DATE_KR: 'YYYY년 MM월 DD일',
  DATE_TIME: 'YYYY-MM-DD HH:mm:ss',
  DATE_TIME_MINUTES: 'YYYY-MM-DD HH:mm',
  TIME: 'HH:mm:ss',
  TIME_MINUTES: 'HH:mm',
  MONTH: 'YYYY-MM',
  MONTH_KR: 'YYYY년 MM월',
  COMPACT_DATE: 'YYYYMMDD',
  COMPACT_DATE_TIME: 'YYYYMMDDHHmmss',
})

/**
 * 자주 쓰는 날짜 포맷 문자열입니다.
 *
 * @typedef {'YYYY-MM-DD'|'YYYY년 MM월 DD일'|'YYYY-MM-DD HH:mm:ss'|'YYYY-MM-DD HH:mm'|'HH:mm:ss'|'HH:mm'|'YYYY-MM'|'YYYY년 MM월'|'YYYYMMDD'|'YYYYMMDDHHmmss'} DateFormat
 */

/**
 * 문자열 끝에 UTC 또는 오프셋 정보가 있는지 확인합니다.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasTimeZoneOffset(value) {
  return /(?:z|[+-]\d{2}:\d{2}|[+-]\d{4})$/i.test(value)
}

/**
 * KST 로컬 시각 값을 실제 UTC millisecond로 바꿉니다.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {number} millisecond
 * @returns {number}
 */
function toKstUtcMs(year, month, day, hour, minute, second, millisecond) {
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - KST_OFFSET_MS
}

/**
 * millisecond 문자열을 3자리 값으로 맞춥니다.
 *
 * @param {string|undefined} value
 * @returns {number}
 */
function parseMillisecond(value) {
  const text = String(value || '')

  if (!text) {
    return 0
  }

  return Number((text + '000').slice(0, 3))
}

/**
 * 타임존 없는 날짜 문자열을 KST 로컬 날짜/시간으로 해석합니다.
 *
 * @param {string} value
 * @returns {number}
 */
function parseOffsetlessStringToUtcMs(value) {
  const text = String(value || '').trim()
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::?(\d{2}))?(?::?(\d{2}))?(?:\.(\d{1,3}))?)?$/)

  if (!match) {
    match = text.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/)
  }

  if (!match) {
    const parsed = Date.parse(text)

    return isNaN(parsed) ? NaN : parsed
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4] || 0)
  const minute = Number(match[5] || 0)
  const second = Number(match[6] || 0)
  const millisecond = parseMillisecond(match[7])
  const utcMs = toKstUtcMs(year, month, day, hour, minute, second, millisecond)
  const kstDate = new Date(utcMs + KST_OFFSET_MS)

  if (
    kstDate.getUTCFullYear() !== year ||
    kstDate.getUTCMonth() !== month - 1 ||
    kstDate.getUTCDate() !== day ||
    kstDate.getUTCHours() !== hour ||
    kstDate.getUTCMinutes() !== minute ||
    kstDate.getUTCSeconds() !== second
  ) {
    return NaN
  }

  return utcMs
}

/**
 * 입력값을 실제 UTC millisecond로 바꿉니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @returns {number}
 */
function toUtcMs(value) {
  if (dayjs.isDayjs(value)) {
    return value.valueOf()
  }

  if (typeof value === 'string') {
    const text = value.trim()

    if (!text) {
      return NaN
    }

    if (!hasTimeZoneOffset(text)) {
      return parseOffsetlessStringToUtcMs(text)
    }
  }

  const date = value instanceof Date ? value : new Date(value)

  return date.getTime()
}

/**
 * 입력값을 KST 기준 dayjs 객체로 맞춥니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @returns {import('dayjs').Dayjs}
 */
function toBusinessDayjs(value) {
  return dayjs.utc(toUtcMs(value) + KST_OFFSET_MS)
}

/**
 * KST 기준으로 해석한 Date 객체를 반환합니다.
 *
 * Date 객체가 필요한 계산에서만 사용하고, 표시 문자열은 formatDate()를 사용합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value 날짜 값
 * @returns {Date} KST 기준으로 보정된 Date 객체
 */
function toDate(value) {
  return new Date(toUtcMs(value))
}

/**
 * 날짜 값을 KST 기준 문자열로 포맷합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value 날짜 값
 * @param {DateFormat|string} [pattern=FORMATS.DATE_TIME] 포맷 문자열
 * @returns {string} 포맷된 날짜 문자열
 */
function formatDate(value, pattern) {
  return toBusinessDayjs(value).format(pattern || FORMATS.DATE_TIME)
}

/**
 * KST 기준 날짜-only 값을 PB date 저장용 ISO 문자열로 바꿉니다.
 *
 * 날짜 라벨을 보존하기 위해 YYYY-MM-DDT00:00:00.000Z 형태로 저장합니다.
 * 실제 발생 시각 저장에는 사용하지 않습니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value 날짜-only 값
 * @returns {string} PB date 저장용 ISO 문자열
 */
function toDateOnlyIso(value) {
  if (typeof value === 'string' && !value.trim()) {
    return ''
  }

  let normalized = null

  try {
    normalized = toBusinessDayjs(value)
  } catch (_exception) {
    return ''
  }

  if (!normalized || !normalized.isValid()) {
    return ''
  }

  const dateText = normalized.format(FORMATS.DATE)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return ''
  }

  const date = new Date(dateText + 'T00:00:00.000Z')

  if (isNaN(date.getTime())) {
    return ''
  }

  return date.toISOString()
}

/**
 * 날짜에 일 수를 더한 뒤 KST 기준 Date 객체를 반환합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value 기준 날짜
 * @param {number} amount 더할 일 수
 * @returns {Date} 계산된 Date 객체
 */
function addDays(value, amount) {
  return new Date(toBusinessDayjs(value).add(amount, 'day').valueOf() - KST_OFFSET_MS)
}

/**
 * KST 기준 해당 일자의 시작 시각을 반환합니다.
 *
 * 날짜 단위 검색의 시작 ISO를 만들 때 사용합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value 날짜 값
 * @returns {Date} KST 기준 00:00:00.000 Date 객체
 */
function startOfDay(value) {
  return new Date(toBusinessDayjs(value).startOf('day').valueOf() - KST_OFFSET_MS)
}

/**
 * KST 기준 해당 일자의 끝 시각을 반환합니다.
 *
 * 날짜 단위 검색의 종료 ISO를 만들 때 사용합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value 날짜 값
 * @returns {Date} KST 기준 23:59:59.999 Date 객체
 */
function endOfDay(value) {
  return new Date(toBusinessDayjs(value).endOf('day').valueOf() - KST_OFFSET_MS)
}

/**
 * 두 날짜가 KST 기준으로 같은 날짜인지 확인합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} left 왼쪽 날짜 값
 * @param {Date|string|number|import('dayjs').Dayjs} right 오른쪽 날짜 값
 * @returns {boolean} 같은 날짜 여부
 */
function isSameDay(left, right) {
  return toBusinessDayjs(left).isSame(toBusinessDayjs(right), 'day')
}

/**
 * 두 날짜의 KST 기준 일 차이를 반환합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} left 왼쪽 날짜 값
 * @param {Date|string|number|import('dayjs').Dayjs} right 오른쪽 날짜 값
 * @returns {number} left - right 일 차이
 */
function diffDays(left, right) {
  return toBusinessDayjs(left).startOf('day').diff(toBusinessDayjs(right).startOf('day'), 'day')
}

/**
 * 왼쪽 날짜가 KST 기준으로 더 이른 날짜인지 확인합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} left 왼쪽 날짜 값
 * @param {Date|string|number|import('dayjs').Dayjs} right 오른쪽 날짜 값
 * @returns {boolean} 더 이른 날짜 여부
 */
function isBeforeDay(left, right) {
  return diffDays(left, right) < 0
}

/**
 * 왼쪽 날짜가 KST 기준으로 더 늦은 날짜인지 확인합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} left 왼쪽 날짜 값
 * @param {Date|string|number|import('dayjs').Dayjs} right 오른쪽 날짜 값
 * @returns {boolean} 더 늦은 날짜 여부
 */
function isAfterDay(left, right) {
  return diffDays(left, right) > 0
}

module.exports = {
  FORMATS,
  toDate,
  formatDate,
  toDateOnlyIso,
  addDays,
  startOfDay,
  endOfDay,
  isSameDay,
  diffDays,
  isBeforeDay,
  isAfterDay,
}
