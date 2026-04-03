'use strict';

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIMEZONE = 'Asia/Seoul';

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
});

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
  return /(?:z|[+-]\d{2}:\d{2}|[+-]\d{4})$/i.test(value);
}

/**
 * 입력값을 KST 기준 dayjs 객체로 맞춥니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @returns {import('dayjs').Dayjs}
 */
function toBusinessDayjs(value) {
  if (dayjs.isDayjs(value)) {
    return value.tz(DEFAULT_TIMEZONE);
  }

  if (typeof value === 'string' && !hasTimeZoneOffset(value)) {
    return dayjs.tz(value, DEFAULT_TIMEZONE);
  }

  return dayjs(value).tz(DEFAULT_TIMEZONE);
}

/**
 * 입력값을 KST 기준 Date 객체로 변환합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @returns {Date}
 */
function toDate(value) {
  return toBusinessDayjs(value).toDate();
}

/**
 * 날짜를 KST 기준으로 포맷합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @param {DateFormat|string} [pattern=FORMATS.DATE_TIME]
 * @returns {string}
 */
function formatDate(value, pattern) {
  return toBusinessDayjs(value).format(pattern || FORMATS.DATE_TIME);
}

/**
 * 날짜에 일 수를 더한 뒤 KST 기준 Date를 반환합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @param {number} amount
 * @returns {Date}
 */
function addDays(value, amount) {
  return toBusinessDayjs(value).add(amount, 'day').toDate();
}

/**
 * 주어진 날짜를 KST 기준 해당 일자의 00:00:00.000으로 맞춥니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @returns {Date}
 */
function startOfDay(value) {
  return toBusinessDayjs(value).startOf('day').toDate();
}

/**
 * 주어진 날짜를 KST 기준 해당 일자의 23:59:59.999로 맞춥니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} value
 * @returns {Date}
 */
function endOfDay(value) {
  return toBusinessDayjs(value).endOf('day').toDate();
}

/**
 * 두 날짜가 KST 기준으로 같은 날짜인지 확인합니다.
 *
 * @param {Date|string|number|import('dayjs').Dayjs} left
 * @param {Date|string|number|import('dayjs').Dayjs} right
 * @returns {boolean}
 */
function isSameDay(left, right) {
  return toBusinessDayjs(left).isSame(toBusinessDayjs(right), 'day');
}

module.exports = {
  DEFAULT_TIMEZONE,
  FORMATS,
  toDate,
  formatDate,
  addDays,
  startOfDay,
  endOfDay,
  isSameDay,
};
