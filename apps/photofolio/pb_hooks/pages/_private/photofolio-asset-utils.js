/* global TextDecoder */

const ASSET_CLASS_CODES = ['cash', 'stock_growth', 'stock_dividend', 'bond', 'gold', 'real_estate', 'other']
const CAPTURE_PAGE_TYPES = ['assets_overview', 'invest_overview', 'invest_holdings', 'unknown']

/**
 * 이미지 바이트를 Base64 문자열로 바꿉니다.
 * @param {Array<number> | Uint8Array} bytes 업로드 이미지 바이트입니다.
 * @returns {string} Base64 문자열입니다.
 */
function encodeBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const source = Array.isArray(bytes) ? bytes : Array.from(bytes || [])
  const output = Array.from({ length: Math.ceil(source.length / 3) * 4 })
  let outIndex = 0

  for (let index = 0; index < source.length; index += 3) {
    const byte1 = source[index] === undefined ? 0 : source[index]
    const byte2 = source[index + 1] === undefined ? 0 : source[index + 1]
    const byte3 = source[index + 2] === undefined ? 0 : source[index + 2]
    const hasByte2 = index + 1 < source.length
    const hasByte3 = index + 2 < source.length
    const triplet = (byte1 << 16) | (byte2 << 8) | byte3

    output[outIndex++] = chars[(triplet >> 18) & 63]
    output[outIndex++] = chars[(triplet >> 12) & 63]
    output[outIndex++] = hasByte2 ? chars[(triplet >> 6) & 63] : '='
    output[outIndex++] = hasByte3 ? chars[triplet & 63] : '='
  }

  return output.join('')
}

/**
 * JSON 바이트 배열을 문자열로 바꿉니다.
 * @param {any} value 원본 JSON 필드 값입니다.
 * @returns {string} UTF-8 문자열입니다.
 */
function decodeJsonByteArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return ''
  }

  try {
    return new TextDecoder('utf-8').decode(Uint8Array.from(value))
  } catch (_error) {
    return ''
  }
}

/**
 * JSON 파싱 실패 시 fallback을 돌려줍니다.
 * @param {string} text JSON 문자열입니다.
 * @param {any} fallback 실패 시 기본값입니다.
 * @returns {any} 파싱 결과 또는 기본값입니다.
 */
function parseJsonSafely(text, fallback) {
  try {
    return JSON.parse(String(text || ''))
  } catch (_error) {
    return fallback
  }
}

/**
 * PocketBase JSON 필드를 일반 객체로 정리합니다.
 * @param {any} value 원본 JSON 필드 값입니다.
 * @returns {Record<string, any>} 정규화된 객체입니다.
 */
function normalizeJsonObject(value) {
  if (!value) {
    return {}
  }

  if (typeof value === 'string') {
    const parsedValue = parseJsonSafely(value, {})
    return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue) ? parsedValue : {}
  }

  if (Array.isArray(value)) {
    return normalizeJsonObject(decodeJsonByteArray(value))
  }

  if (typeof value === 'object') {
    return JSON.parse(JSON.stringify(value))
  }

  return {}
}

/**
 * AI 응답에서 JSON 객체 영역만 잘라냅니다.
 * @param {string} text AI 응답 원문입니다.
 * @returns {string} JSON 객체 문자열입니다.
 */
function extractJsonObjectText(text) {
  const normalized = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  const objectStart = normalized.indexOf('{')
  const objectEnd = normalized.lastIndexOf('}')

  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return '{}'
  }

  return normalized.slice(objectStart, objectEnd + 1).trim()
}

/**
 * 숫자처럼 보이는 값을 number로 바꿉니다.
 * @param {any} value 원본 값입니다.
 * @returns {number | null} 정규화된 숫자입니다.
 */
function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  const normalized = String(value === undefined || value === null ? '' : value)
    .replace(/[,₩$€¥원주식%]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^0-9.-]/g, '')

  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return parsed
}

/**
 * 텍스트를 정리하고 길이를 제한합니다.
 * @param {any} value 원본 값입니다.
 * @param {number} maxLength 최대 길이입니다.
 * @returns {string} 정리된 텍스트입니다.
 */
function normalizeText(value, maxLength) {
  const normalized = String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()

  if (!maxLength || maxLength < 1) {
    return normalized
  }

  return normalized.slice(0, maxLength)
}

/**
 * 코드형 텍스트를 대문자 영숫자 중심으로 정리합니다.
 * @param {any} value 원본 값입니다.
 * @param {number} maxLength 최대 길이입니다.
 * @returns {string} 정리된 코드값입니다.
 */
function normalizeUpperCode(value, maxLength) {
  return normalizeText(value, maxLength)
    .toUpperCase()
    .replace(/[^A-Z0-9_\-]/g, '')
}

/**
 * 날짜 텍스트를 YYYY-MM-DD로 정리합니다.
 * @param {any} value 원본 날짜 값입니다.
 * @returns {string} 정규화된 날짜 문자열입니다.
 */
function normalizeIsoDate(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  let match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)

  if (!match) {
    match = text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  }

  if (!match) {
    return ''
  }

  const year = match[1]
  const month = String(match[2]).padStart(2, '0')
  const day = String(match[3]).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/**
 * 자산 분류 코드값을 허용 enum으로 정리합니다.
 * @param {any} value 원본 자산 분류 값입니다.
 * @returns {types.PhotofolioAssetClassCode} 정규화된 자산 분류 코드입니다.
 */
function normalizeAssetClassCode(value) {
  const normalized = normalizeText(value, 80).toLowerCase().replace(/[()]/g, '').replace(/\s+/g, '')

  if (!normalized) {
    return 'other'
  }

  if (['cash', '현금', '예금', '적금', '예적금', '현금성', 'cma', 'mmf', '파킹통장', '입출금', '보통예금'].includes(normalized)) {
    return 'cash'
  }

  if (['stockgrowth', 'stock', 'growth', '주식', '성장', '성장형', '성장주', '주식성장형', '주식성장', 'growthstock', 'equity'].includes(normalized)) {
    return 'stock_growth'
  }

  if (['stockdividend', 'dividend', 'dividendstock', '배당', '배당형', '배당주', '주식배당형', '주식배당', '고배당'].includes(normalized)) {
    return 'stock_dividend'
  }

  if (['bond', '채권', '국채', '회사채', '채권형'].includes(normalized)) {
    return 'bond'
  }

  if (['gold', '금', '골드'].includes(normalized)) {
    return 'gold'
  }

  if (['realestate', 'real_estate', '부동산', '리츠', 'reit', 'reits'].includes(normalized)) {
    return 'real_estate'
  }

  if (ASSET_CLASS_CODES.includes(normalized)) {
    return normalized
  }

  return 'other'
}

/**
 * 캡처 화면 타입을 허용 enum으로 정리합니다.
 * @param {any} value 원본 화면 타입 값입니다.
 * @returns {types.PhotofolioCapturePageType} 정규화된 화면 타입입니다.
 */
function normalizeCapturePageType(value) {
  const normalized = normalizeText(value, 80).toLowerCase().replace(/[()]/g, '').replace(/\s+/g, '')

  if (!normalized) {
    return 'unknown'
  }

  if (['assets_overview', 'assetsoverview', 'assetoverview', 'overview_assets', 'overviewassets', '내자산', '자산요약', '전체자산', '자산개요'].includes(normalized)) {
    return 'assets_overview'
  }

  if (['invest_overview', 'investoverview', 'investmentoverview', '내투자', '투자요약', '투자개요', '투자'].includes(normalized)) {
    return 'invest_overview'
  }

  if (['invest_holdings', 'investholdings', 'holdingdetail', 'holdingdetails', 'holdings', '보유종목', '종목상세', '투자상세', '보유자산상세'].includes(normalized)) {
    return 'invest_holdings'
  }

  if (CAPTURE_PAGE_TYPES.includes(normalized)) {
    return normalized
  }

  return 'unknown'
}

/**
 * 레코드 목록의 number 필드 합계를 계산합니다.
 * @param {Array<{ get: (field: string) => any }>} records PocketBase 레코드 목록입니다.
 * @param {string} fieldName 합계를 구할 필드명입니다.
 * @returns {number} 합계입니다.
 */
function sumRecordNumber(records, fieldName) {
  let sum = 0

  for (let index = 0; index < (records || []).length; index += 1) {
    const record = records[index]
    sum += Number(record.get(fieldName) || 0)
  }

  return sum
}

module.exports = {
  ASSET_CLASS_CODES,
  CAPTURE_PAGE_TYPES,
  encodeBase64,
  decodeJsonByteArray,
  parseJsonSafely,
  normalizeJsonObject,
  extractJsonObjectText,
  parseNumber,
  normalizeText,
  normalizeUpperCode,
  normalizeIsoDate,
  normalizeAssetClassCode,
  normalizeCapturePageType,
  sumRecordNumber,
}
