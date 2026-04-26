const { globalApi } = require('pocketpages')
const dbg = globalApi.dbg
const info = globalApi.info
const store = globalApi.store

const APPLYHOME_BASE_URL = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1'
const LH_NOTICE_URL = 'https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1'
const DEFAULT_TIMEOUT_SECONDS = 15
const DEFAULT_PER_PAGE = 50
const NOTICE_LOOKBACK_MONTHS = 6
const API_CACHE_KEY_PREFIX = 'homeping:notices:api-cache:v1:'
const API_CACHE_INDEX_KEY = 'homeping:notices:api-cache-index:v1'

const REGIONS = [
  { slug: 'anyang', label: '안양시', searchText: '안양' },
  { slug: 'uiwang', label: '의왕시', searchText: '의왕' },
  { slug: 'gwacheon', label: '과천시', searchText: '과천' },
]

const ENDPOINTS = [
  {
    code: 'apt',
    label: 'APT 분양',
    path: '/getAPTLttotPblancDetail',
    applyStartField: 'RCEPT_BGNDE',
    applyEndField: 'RCEPT_ENDDE',
    houseDetailField: 'HOUSE_DTL_SECD_NM',
  },
  {
    code: 'remndr',
    label: '무순위/잔여세대',
    path: '/getRemndrLttotPblancDetail',
    applyStartField: 'SUBSCRPT_RCEPT_BGNDE',
    applyEndField: 'SUBSCRPT_RCEPT_ENDDE',
    houseDetailField: 'HOUSE_DTL_SECD_NM',
  },
  {
    code: 'urbty',
    label: '오피스텔/도시형',
    path: '/getUrbtyOfctlLttotPblancDetail',
    applyStartField: 'SUBSCRPT_RCEPT_BGNDE',
    applyEndField: 'SUBSCRPT_RCEPT_ENDDE',
    houseDetailField: 'HOUSE_DTL_SECD_NM',
  },
  {
    code: 'public-rent',
    label: '공공지원민간임대',
    path: '/getPblPvtRentLttotPblancDetail',
    applyStartField: 'SUBSCRPT_RCEPT_BGNDE',
    applyEndField: 'SUBSCRPT_RCEPT_ENDDE',
    houseDetailField: 'HOUSE_DETAIL_SECD_NM',
  },
  {
    code: 'optional',
    label: '임의공급',
    path: '/getOPTLttotPblancDetail',
    applyStartField: 'SUBSCRPT_RCEPT_BGNDE',
    applyEndField: 'SUBSCRPT_RCEPT_ENDDE',
    houseDetailField: 'HOUSE_DTL_SECD_NM',
  },
]

const LH_ENDPOINT = {
  code: 'lh-sale',
  label: 'LH 분양주택',
  upperTypeCode: '05',
  provinceCode: '41',
}

/**
 * 청약홈 조회 대상 지역 목록을 반환합니다.
 * @returns {types.HomepingRegion[]} 지역 옵션 목록
 */
function listRegions() {
  return REGIONS.slice()
}

/**
 * 지역 slug를 청약홈 검색 조건으로 정규화합니다.
 * @param {unknown} regionSlug 쿼리에서 받은 지역 slug
 * @returns {types.HomepingRegion} 선택 지역
 */
function getRegion(regionSlug) {
  const slug = String(regionSlug || '').trim()

  for (let index = 0; index < REGIONS.length; index += 1) {
    if (REGIONS[index].slug === slug) {
      return REGIONS[index]
    }
  }

  return REGIONS[0]
}

/**
 * query 객체를 URL query string으로 직렬화합니다.
 * @param {{ [key: string]: unknown }} query query 값
 * @param {{ rawServiceKey?: boolean }} options 직렬화 옵션
 * @returns {string} query string
 */
function toQueryString(query, options) {
  const keys = Object.keys(query || {})
  const segments = []

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const value = query[key]

    if (value === undefined || value === null || value === '') {
      continue
    }

    const encodedValue = options && options.rawServiceKey && key === 'serviceKey' ? String(value) : encodeURIComponent(String(value))
    segments.push(encodeURIComponent(key) + '=' + encodedValue)
  }

  return segments.join('&')
}

/**
 * query 객체를 안정적인 캐시용 query string으로 직렬화합니다.
 * @param {{ [key: string]: unknown }} query query 값
 * @returns {string} 정렬된 query string
 */
function toCacheQueryString(query) {
  const keys = Object.keys(query || {}).sort()
  const segments = []

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const value = query[key]

    if (value === undefined || value === null || value === '') {
      continue
    }

    segments.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
  }

  return segments.join('&')
}

/**
 * JSON 직렬화 가능한 값을 깊은 복사합니다.
 * @param {any} value 원본 값
 * @returns {any} 복사 값
 */
function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

/**
 * DATAGOKR API 키를 숨긴 로그용 URL을 만듭니다.
 * @param {string} urlValue 요청 URL
 * @param {string} apiKey 원본 API 키
 * @returns {string} 마스킹된 URL
 */
function redactApiKey(urlValue, apiKey) {
  const encodedApiKey = encodeURIComponent(apiKey)

  return String(urlValue || '')
    .replace(apiKey, '[REDACTED]')
    .replace(encodedApiKey, '[REDACTED]')
}

/**
 * 청약홈 API 요청 query를 만듭니다.
 * @param {{ [key: string]: unknown }} query 요청 query
 * @returns {{ [key: string]: unknown }} 기본값이 반영된 query
 */
function buildApplyhomeRequestQuery(query) {
  return Object.assign(
    {
      page: 1,
      perPage: DEFAULT_PER_PAGE,
      returnType: 'JSON',
    },
    query || {}
  )
}

/**
 * 청약홈 API GET 요청 URL을 만듭니다.
 * @param {{ apiKey: string, baseUrl?: string }} config 호출 설정
 * @param {string} path API 경로
 * @param {{ [key: string]: unknown }} query 요청 query
 * @param {{ rawServiceKey?: boolean }} options URL 옵션
 * @returns {string} 요청 URL
 */
function buildApplyhomeUrl(config, path, query, options) {
  const baseUrl = String(config && config.baseUrl ? config.baseUrl : APPLYHOME_BASE_URL).replace(/\/+$/, '')
  const apiKey = String(config && config.apiKey ? config.apiKey : '').trim()
  const requestQuery = Object.assign({}, buildApplyhomeRequestQuery(query), {
    serviceKey: apiKey,
  })

  return baseUrl + path + '?' + toQueryString(requestQuery, options || {})
}

/**
 * LH 분양임대공고문 API GET 요청 URL을 만듭니다.
 * @param {{ apiKey: string, lhNoticeUrl?: string }} config 호출 설정
 * @param {{ [key: string]: unknown }} query 요청 query
 * @param {{ rawServiceKey?: boolean }} options URL 옵션
 * @returns {string} 요청 URL
 */
function buildLhNoticeUrl(config, query, options) {
  const requestUrl = String(config && config.lhNoticeUrl ? config.lhNoticeUrl : LH_NOTICE_URL).trim()
  const apiKey = String(config && config.apiKey ? config.apiKey : '').trim()
  const requestQuery = Object.assign({}, query || {}, {
    serviceKey: apiKey,
  })

  return requestUrl + '?' + toQueryString(requestQuery, options || {})
}

/**
 * Date 값을 YYYY-MM-DD 비교 문자열로 포맷합니다.
 * @param {Date} date 날짜
 * @returns {string} YYYY-MM-DD 문자열
 */
function formatDateIso(date) {
  const rawValue = formatDateParam(date)

  return rawValue.slice(0, 4) + '-' + rawValue.slice(4, 6) + '-' + rawValue.slice(6, 8)
}

/**
 * 오늘 날짜 기준 캐시 날짜 키를 반환합니다.
 * @returns {string} YYYY-MM-DD 캐시 날짜
 */
function getTodayCacheDateKey() {
  return formatDateIso(new Date())
}

/**
 * API 응답 캐시 키를 만듭니다.
 * @param {string} dateKey 캐시 날짜
 * @param {string} sourceCode API 구분
 * @param {string} requestKey 요청 구분
 * @returns {string} store 키
 */
function buildDailyApiCacheKey(dateKey, sourceCode, requestKey) {
  return API_CACHE_KEY_PREFIX + dateKey + ':' + sourceCode + ':' + requestKey
}

/**
 * 오늘이 아닌 API 응답 캐시를 정리합니다.
 * @param {string} dateKey 오늘 캐시 날짜
 */
function purgeOtherDailyApiCaches(dateKey) {
  const indexValue = store(API_CACHE_INDEX_KEY)
  const indexObject = indexValue && typeof indexValue === 'object' && !Array.isArray(indexValue) ? indexValue : null
  const indexDate = indexObject ? String(indexObject.date || '') : ''
  const keys = indexObject && Array.isArray(indexObject.keys) ? indexObject.keys : []

  if (indexDate === dateKey) {
    return
  }

  for (let index = 0; index < keys.length; index += 1) {
    const cacheKey = String(keys[index] || '')

    if (cacheKey) {
      store(cacheKey, null)
    }
  }

  store(API_CACHE_INDEX_KEY, {
    date: dateKey,
    keys: [],
  })

  if (indexDate && keys.length > 0) {
    info('homeping/cache:purge-daily', {
      fromDate: indexDate,
      toDate: dateKey,
      count: keys.length,
    })
  }
}

/**
 * 오늘 캐시 인덱스에 캐시 키를 등록합니다.
 * @param {string} dateKey 오늘 캐시 날짜
 * @param {string} cacheKey 캐시 키
 */
function addDailyApiCacheKey(dateKey, cacheKey) {
  const indexValue = store(API_CACHE_INDEX_KEY)
  const indexObject = indexValue && typeof indexValue === 'object' && !Array.isArray(indexValue) ? indexValue : null
  const keys = indexObject && indexObject.date === dateKey && Array.isArray(indexObject.keys) ? indexObject.keys.slice() : []

  if (keys.indexOf(cacheKey) === -1) {
    keys.push(cacheKey)
  }

  store(API_CACHE_INDEX_KEY, {
    date: dateKey,
    keys: keys,
  })
}

/**
 * 오늘 API 응답 캐시를 읽습니다.
 * @param {string} dateKey 오늘 캐시 날짜
 * @param {string} cacheKey 캐시 키
 * @returns {any | null} 캐시된 응답
 */
function readDailyApiCache(dateKey, cacheKey) {
  const cacheValue = store(cacheKey)
  const cacheObject = cacheValue && typeof cacheValue === 'object' && !Array.isArray(cacheValue) ? cacheValue : null

  if (!cacheObject || cacheObject.date !== dateKey || cacheObject.data === undefined) {
    return null
  }

  return cloneJsonValue(cacheObject.data)
}

/**
 * 오늘 API 응답 캐시를 저장합니다.
 * @param {string} dateKey 오늘 캐시 날짜
 * @param {string} cacheKey 캐시 키
 * @param {any} data API 응답
 */
function writeDailyApiCache(dateKey, cacheKey, data) {
  store(cacheKey, {
    date: dateKey,
    fetched_at: new Date().toISOString(),
    data: cloneJsonValue(data),
  })
  addDailyApiCacheKey(dateKey, cacheKey)
}

/**
 * 청약홈 API JSON 응답을 조회합니다.
 * @param {{ apiKey: string, baseUrl?: string, timeout?: number, cacheDateKey?: string }} config 호출 설정
 * @param {string} path API 경로
 * @param {{ [key: string]: unknown }} query 요청 query
 * @returns {any} 파싱된 JSON 응답
 */
function requestApplyhomeJson(config, path, query) {
  const apiKey = String(config && config.apiKey ? config.apiKey : '').trim()
  const timeout = config && config.timeout ? config.timeout : DEFAULT_TIMEOUT_SECONDS

  if (!apiKey) {
    throw new Error('DATAGOKR_APIKEY 환경변수가 필요합니다.')
  }

  const cacheDateKey = String(config && config.cacheDateKey ? config.cacheDateKey : getTodayCacheDateKey())
  const cacheBaseUrl = String(config && config.baseUrl ? config.baseUrl : APPLYHOME_BASE_URL).replace(/\/+$/, '')
  const cacheKey = buildDailyApiCacheKey(cacheDateKey, 'applyhome', cacheBaseUrl + path + '?' + toCacheQueryString(buildApplyhomeRequestQuery(query)))
  const cachedPayload = readDailyApiCache(cacheDateKey, cacheKey)

  if (cachedPayload !== null) {
    info('homeping/cache:hit', {
      source: 'applyhome',
      path: path,
      date: cacheDateKey,
    })
    return cachedPayload
  }

  let requestUrl = buildApplyhomeUrl(config, path, query, { rawServiceKey: false })

  dbg('applyhome:request', {
    path: path,
    url: redactApiKey(requestUrl, apiKey),
  })

  let response = $http.send({
    url: requestUrl,
    method: 'GET',
    timeout: timeout,
  })

  if (response.statusCode === 401 && requestUrl.indexOf('%25') !== -1) {
    requestUrl = buildApplyhomeUrl(config, path, query, { rawServiceKey: true })
    dbg('applyhome:request:retry-raw-key', {
      path: path,
      url: redactApiKey(requestUrl, apiKey),
    })
    response = $http.send({
      url: requestUrl,
      method: 'GET',
      timeout: timeout,
    })
  }

  dbg('applyhome:response', {
    path: path,
    statusCode: response.statusCode,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('청약홈 API 요청에 실패했습니다. status=' + response.statusCode)
  }

  if (!response.json || !Array.isArray(response.json.data)) {
    throw new Error('청약홈 API 응답 형식이 올바르지 않습니다.')
  }

  writeDailyApiCache(cacheDateKey, cacheKey, response.json)
  return response.json
}

/**
 * LH 분양임대공고문 API JSON 응답을 조회합니다.
 * @param {{ apiKey: string, lhNoticeUrl?: string, timeout?: number, cacheDateKey?: string }} config 호출 설정
 * @param {{ [key: string]: unknown }} query 요청 query
 * @returns {any[]} 파싱된 JSON 응답 배열
 */
function requestLhNoticeJson(config, query) {
  const apiKey = String(config && config.apiKey ? config.apiKey : '').trim()
  const timeout = config && config.timeout ? config.timeout : DEFAULT_TIMEOUT_SECONDS

  if (!apiKey) {
    throw new Error('DATAGOKR_APIKEY 환경변수가 필요합니다.')
  }

  const cacheDateKey = String(config && config.cacheDateKey ? config.cacheDateKey : getTodayCacheDateKey())
  const cacheRequestUrl = String(config && config.lhNoticeUrl ? config.lhNoticeUrl : LH_NOTICE_URL).trim()
  const cacheKey = buildDailyApiCacheKey(cacheDateKey, 'lh-notice', cacheRequestUrl + '?' + toCacheQueryString(query || {}))
  const cachedPayload = readDailyApiCache(cacheDateKey, cacheKey)

  if (cachedPayload !== null) {
    info('homeping/cache:hit', {
      source: 'lh-notice',
      date: cacheDateKey,
    })
    return cachedPayload
  }

  let requestUrl = buildLhNoticeUrl(config, query, { rawServiceKey: false })

  dbg('lh-notice:request', {
    url: redactApiKey(requestUrl, apiKey),
  })

  let response = $http.send({
    url: requestUrl,
    method: 'GET',
    timeout: timeout,
  })

  if (response.statusCode === 401 && requestUrl.indexOf('%25') !== -1) {
    requestUrl = buildLhNoticeUrl(config, query, { rawServiceKey: true })
    dbg('lh-notice:request:retry-raw-key', {
      url: redactApiKey(requestUrl, apiKey),
    })
    response = $http.send({
      url: requestUrl,
      method: 'GET',
      timeout: timeout,
    })
  }

  dbg('lh-notice:response', {
    statusCode: response.statusCode,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('LH 분양임대공고문 API 요청에 실패했습니다. status=' + response.statusCode)
  }

  if (Array.isArray(response.json)) {
    writeDailyApiCache(cacheDateKey, cacheKey, response.json)
    return response.json
  }

  if (response.json && Array.isArray(response.json.value)) {
    writeDailyApiCache(cacheDateKey, cacheKey, response.json.value)
    return response.json.value
  }

  throw new Error('LH 분양임대공고문 API 응답 형식이 올바르지 않습니다.')
}

/**
 * 날짜 문자열을 YYYY-MM-DD 형태로 정규화합니다.
 * @param {unknown} value 날짜 값
 * @returns {string} 정규화된 날짜
 */
function normalizeDate(value) {
  const rawValue = String(value || '').trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue
  }

  const digits = rawValue.replace(/\D+/g, '')
  if (digits.length === 8) {
    return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8)
  }

  return ''
}

/**
 * Date 값을 YYYYMMDD API 파라미터로 포맷합니다.
 * @param {Date} date 날짜
 * @returns {string} YYYYMMDD 문자열
 */
function formatDateParam(date) {
  const year = date.getFullYear()
  const rawMonth = String(date.getMonth() + 1)
  const rawDay = String(date.getDate())
  const month = rawMonth.length === 1 ? '0' + rawMonth : rawMonth
  const day = rawDay.length === 1 ? '0' + rawDay : rawDay

  return String(year) + month + day
}

/**
 * 오늘 기준 이전 월 날짜를 계산합니다.
 * @param {number} months 이전 월 수
 * @returns {Date} 계산된 날짜
 */
function monthsAgo(months) {
  const date = new Date()
  date.setMonth(date.getMonth() - Number(months || 0))

  return date
}

/**
 * 공고가 기준일 이후인지 확인합니다.
 * @param {types.HomepingNotice} notice 공고
 * @param {string} sinceDate 기준일
 * @returns {boolean} 최근 공고 여부
 */
function isRecentNotice(notice, sinceDate) {
  const noticeDate = notice.recruitDate || notice.applyStartDate || notice.applyEndDate || ''

  return !sinceDate || !noticeDate || noticeDate >= sinceDate
}

/**
 * 날짜 범위를 화면 표시 문자열로 만듭니다.
 * @param {string} startDate 시작일
 * @param {string} endDate 종료일
 * @returns {string} 날짜 범위
 */
function formatDateRange(startDate, endDate) {
  if (startDate && endDate && startDate !== endDate) {
    return startDate + ' ~ ' + endDate
  }

  return startDate || endDate || '-'
}

/**
 * 공급 세대수를 화면 표시 문자열로 만듭니다.
 * @param {unknown} value 세대수
 * @returns {string} 세대수 표시
 */
function formatHouseholdCount(value) {
  const count = Number(value || 0)

  if (!count || count <= 0) {
    return '-'
  }

  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '세대'
}

/**
 * 접수일 기준 상태를 계산합니다.
 * @param {string} startDate 접수 시작일
 * @param {string} endDate 접수 종료일
 * @returns {{ code: string, label: string }} 상태 값
 */
function resolveStatus(startDate, endDate) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startTime = startDate ? new Date(startDate + 'T00:00:00').getTime() : 0
  const endTime = endDate ? new Date(endDate + 'T23:59:59').getTime() : 0

  if (startTime && today < startTime) {
    return { code: 'upcoming', label: '접수 전' }
  }

  if (startTime && endTime && today >= startTime && today <= endTime) {
    return { code: 'open', label: '접수 중' }
  }

  if (endTime && today > endTime) {
    return { code: 'closed', label: '마감' }
  }

  return { code: 'unknown', label: '일정 확인' }
}

/**
 * LH 공고 상태를 화면 상태로 정규화합니다.
 * @param {any} row LH 원본 공고
 * @param {string} closeDate 마감일
 * @returns {{ code: string, label: string }} 상태 값
 */
function resolveLhStatus(row, closeDate) {
  const statusLabel = String(row && row.PAN_SS ? row.PAN_SS : '').trim()
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const closeTime = closeDate ? new Date(closeDate + 'T23:59:59').getTime() : 0

  if (statusLabel.indexOf('마감') !== -1 || (closeTime && todayStart > closeTime)) {
    return { code: 'closed', label: statusLabel || '마감' }
  }

  if (statusLabel.indexOf('접수중') !== -1) {
    return { code: 'open', label: statusLabel }
  }

  return { code: 'upcoming', label: statusLabel || '공고중' }
}

/**
 * 청약홈 원본 공고가 선택 지역에 해당하는지 확인합니다.
 * @param {any} row 원본 공고
 * @param {types.HomepingRegion} region 선택 지역
 * @returns {boolean} 지역 매칭 여부
 */
function matchesRegion(row, region) {
  const address = String(row && row.HSSPLY_ADRES ? row.HSSPLY_ADRES : '')
  const houseName = String(row && row.HOUSE_NM ? row.HOUSE_NM : '')
  const searchText = String(region && region.searchText ? region.searchText : '')

  return !!searchText && (address.indexOf(searchText) !== -1 || houseName.indexOf(searchText) !== -1)
}

/**
 * LH 원본 공고가 선택 지역에 해당하는지 확인합니다.
 * @param {any} row LH 원본 공고
 * @param {types.HomepingRegion} region 선택 지역
 * @returns {boolean} 지역 매칭 여부
 */
function matchesLhRegion(row, region) {
  const noticeName = String(row && row.PAN_NM ? row.PAN_NM : '')
  const searchText = String(region && region.searchText ? region.searchText : '')

  return !!searchText && noticeName.indexOf(searchText) !== -1
}

/**
 * 청약홈 공고 유형 라벨을 만든다.
 * @param {{ label: string }} endpoint API 엔드포인트 메타
 * @param {string} detailName 상세 유형명
 * @param {string} houseSectionName 주택 구분명
 * @returns {string} 유형 라벨
 */
function buildApplyhomeCategoryLabel(endpoint, detailName, houseSectionName) {
  const normalizedDetailName = String(detailName || '').trim()

  if (normalizedDetailName && endpoint.label.indexOf(normalizedDetailName) === -1) {
    return endpoint.label + ' · ' + normalizedDetailName
  }

  return endpoint.label || normalizedDetailName || houseSectionName || '청약홈'
}

/**
 * LH 공고명으로 개인에게 의미 있는 분양 성격을 분류합니다.
 * @param {any} row LH 원본 공고
 * @returns {string} 분류 라벨
 */
function buildLhCategoryLabel(row) {
  const noticeName = String(row && row.PAN_NM ? row.PAN_NM : '')
  const detailName = String(row && row.AIS_TP_CD_NM ? row.AIS_TP_CD_NM : '').trim()

  if (/무순위|잔여세대|추가입주자|공가세대/i.test(noticeName)) {
    return '무순위/잔여세대'
  }

  if (/일반공급|일반매각|분양광고/i.test(noticeName)) {
    return '일반공급/매각'
  }

  return detailName || '분양주택'
}

/**
 * 청약홈 원본 공고를 화면 표시용 공고로 정규화합니다.
 * @param {any} row 원본 공고
 * @param {{ code: string, label: string, applyStartField: string, applyEndField: string, houseDetailField: string }} endpoint API 엔드포인트 메타
 * @returns {types.HomepingNotice} 정규화된 공고
 */
function toNotice(row, endpoint) {
  const recruitDate = normalizeDate(row && row.RCRIT_PBLANC_DE)
  const applyStartDate = normalizeDate(row && row[endpoint.applyStartField])
  const applyEndDate = normalizeDate(row && row[endpoint.applyEndField])
  const winnerDate = normalizeDate(row && row.PRZWNER_PRESNATN_DE)
  const status = resolveStatus(applyStartDate, applyEndDate)
  const houseManageNo = String(row && row.HOUSE_MANAGE_NO ? row.HOUSE_MANAGE_NO : '').trim()
  const pblancNo = String(row && row.PBLANC_NO ? row.PBLANC_NO : '').trim()
  const detailName = String(row && row[endpoint.houseDetailField] ? row[endpoint.houseDetailField] : '').trim()
  const houseSectionName = String(row && row.HOUSE_SECD_NM ? row.HOUSE_SECD_NM : '').trim()

  return {
    id: 'applyhome:' + endpoint.code + ':' + houseManageNo + ':' + pblancNo,
    sourceCode: 'applyhome-' + endpoint.code,
    sourceLabel: '청약홈',
    categoryLabel: buildApplyhomeCategoryLabel(endpoint, detailName, houseSectionName),
    name: String(row && row.HOUSE_NM ? row.HOUSE_NM : '').trim() || '공고명 없음',
    address: String(row && row.HSSPLY_ADRES ? row.HSSPLY_ADRES : '').trim() || '공급위치 없음',
    areaName: String(row && row.SUBSCRPT_AREA_CODE_NM ? row.SUBSCRPT_AREA_CODE_NM : '').trim(),
    businessOwner: String(row && row.BSNS_MBY_NM ? row.BSNS_MBY_NM : '').trim(),
    phone: String(row && row.MDHS_TELNO ? row.MDHS_TELNO : '').trim(),
    detailUrl: String(row && row.PBLANC_URL ? row.PBLANC_URL : '').trim(),
    recruitDate: recruitDate,
    recruitDateLabel: recruitDate || '-',
    applyStartDate: applyStartDate,
    applyEndDate: applyEndDate,
    applyDateLabel: formatDateRange(applyStartDate, applyEndDate),
    winnerDateLabel: winnerDate || '-',
    moveInLabel: String(row && row.MVN_PREARNGE_YM ? row.MVN_PREARNGE_YM : '').trim() || '-',
    householdCountLabel: formatHouseholdCount(row && row.TOT_SUPLY_HSHLDCO),
    statusLabel: status.label,
    statusCode: status.code,
  }
}

/**
 * LH 원본 공고를 화면 표시용 공고로 정규화합니다.
 * @param {any} row LH 원본 공고
 * @returns {types.HomepingNotice} 정규화된 공고
 */
function toLhNotice(row) {
  const recruitDate = normalizeDate((row && row.PAN_DT) || (row && row.PAN_NT_ST_DT))
  const noticeStartDate = normalizeDate(row && row.PAN_NT_ST_DT)
  const closeDate = normalizeDate(row && row.CLSG_DT)
  const status = resolveLhStatus(row, closeDate)
  const noticeId = String(row && row.PAN_ID ? row.PAN_ID : '').trim()
  const provinceName = String(row && row.CNP_CD_NM ? row.CNP_CD_NM : '').trim()

  return {
    id: 'lh:' + noticeId,
    sourceCode: 'lh-sale',
    sourceLabel: 'LH',
    categoryLabel: buildLhCategoryLabel(row),
    name: String(row && row.PAN_NM ? row.PAN_NM : '').trim() || '공고명 없음',
    address: provinceName ? provinceName + ' · LH 공고문 확인 필요' : 'LH 공고문 확인 필요',
    areaName: provinceName,
    businessOwner: '한국토지주택공사',
    phone: '',
    detailUrl: String(row && row.DTL_URL ? row.DTL_URL : row && row.DTL_URL_MOB ? row.DTL_URL_MOB : '').trim(),
    recruitDate: recruitDate,
    recruitDateLabel: recruitDate || '-',
    applyStartDate: noticeStartDate,
    applyEndDate: closeDate,
    applyDateLabel: formatDateRange(noticeStartDate, closeDate),
    winnerDateLabel: '-',
    moveInLabel: '-',
    householdCountLabel: '-',
    statusLabel: status.label,
    statusCode: status.code,
  }
}

/**
 * 중복 공고를 제거합니다.
 * @param {types.HomepingNotice[]} notices 공고 목록
 * @returns {types.HomepingNotice[]} 중복 제거된 공고 목록
 */
function dedupeNotices(notices) {
  const list = Array.isArray(notices) ? notices : []
  const seen = {}
  const deduped = []

  for (let index = 0; index < list.length; index += 1) {
    const notice = list[index]
    const key = notice.id || notice.detailUrl || notice.name

    if (!key || seen[key]) {
      continue
    }

    seen[key] = true
    deduped.push(notice)
  }

  return deduped
}

/**
 * 공고 표시 순서를 정렬합니다.
 * @param {types.HomepingNotice} left 왼쪽 공고
 * @param {types.HomepingNotice} right 오른쪽 공고
 * @returns {number} 정렬 값
 */
function compareNotices(left, right) {
  const leftDate = left.recruitDate || left.applyStartDate || ''
  const rightDate = right.recruitDate || right.applyStartDate || ''

  if (leftDate > rightDate) {
    return -1
  }

  if (leftDate < rightDate) {
    return 1
  }

  return String(left.name || '').localeCompare(String(right.name || ''))
}

/**
 * 선택 지역의 LH 분양주택 공고를 조회합니다.
 * @param {{ apiKey: string, lhNoticeUrl?: string, timeout?: number, perPage?: number, cacheDateKey?: string }} config 호출 설정
 * @param {types.HomepingRegion} region 선택 지역
 * @param {boolean} includeClosed 마감 공고 포함 여부
 * @returns {{ notices: types.HomepingNotice[], summary: types.HomepingEndpointSummary }} LH 검색 결과
 */
function searchLhSaleNotices(config, region, includeClosed) {
  const perPage = Number(config && config.perPage ? config.perPage : DEFAULT_PER_PAGE)
  const today = new Date()
  const sinceDate = monthsAgo(NOTICE_LOOKBACK_MONTHS)
  const query = {
    PG_SZ: perPage,
    PAGE: 1,
    UPP_AIS_TP_CD: LH_ENDPOINT.upperTypeCode,
    CNP_CD: LH_ENDPOINT.provinceCode,
    PAN_NM: region.searchText,
    PAN_ST_DT: formatDateParam(sinceDate),
    PAN_ED_DT: formatDateParam(today),
  }

  if (!includeClosed) {
    query.CLSG_ST_DT = formatDateParam(today)
  }

  const payload = requestLhNoticeJson(config, query)
  let rows = []
  const notices = []

  for (let index = 0; index < payload.length; index += 1) {
    const item = payload[index]

    if (item && Array.isArray(item.dsList)) {
      rows = item.dsList
      break
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]

    if (!matchesLhRegion(row, region)) {
      continue
    }

    const notice = toLhNotice(row)

    if (!includeClosed && notice.statusCode === 'closed') {
      continue
    }

    if (!isRecentNotice(notice, formatDateIso(sinceDate))) {
      continue
    }

    notices.push(notice)
  }

  return {
    notices: notices,
    summary: {
      code: LH_ENDPOINT.code,
      label: LH_ENDPOINT.label,
      count: notices.length,
      error: '',
    },
  }
}

/**
 * 선택 지역의 청약홈 공고를 조회합니다.
 * @param {{ apiKey: string, baseUrl?: string, lhNoticeUrl?: string, timeout?: number, perPage?: number }} config 호출 설정
 * @param {types.HomepingSearchInput} input 검색 조건
 * @returns {types.HomepingSearchResult} 검색 결과
 */
function searchRegionNotices(config, input) {
  const region = getRegion(input && input.regionSlug)
  const includeClosed = !!(input && input.includeClosed)
  const cacheDateKey = getTodayCacheDateKey()
  const requestConfig = {
    apiKey: String(config && config.apiKey ? config.apiKey : ''),
    baseUrl: config && config.baseUrl,
    lhNoticeUrl: config && config.lhNoticeUrl,
    timeout: config && config.timeout,
    perPage: config && config.perPage,
    cacheDateKey: cacheDateKey,
  }
  const perPage = Number(config && config.perPage ? config.perPage : DEFAULT_PER_PAGE)
  const sinceDate = formatDateIso(monthsAgo(NOTICE_LOOKBACK_MONTHS))
  const notices = []
  const summaries = []
  const errors = []

  purgeOtherDailyApiCaches(cacheDateKey)

  for (let index = 0; index < ENDPOINTS.length; index += 1) {
    const endpoint = ENDPOINTS[index]

    try {
      const payload = requestApplyhomeJson(requestConfig, endpoint.path, {
        page: 1,
        perPage: perPage,
        'cond[HSSPLY_ADRES::LIKE]': region.searchText,
      })
      const rows = Array.isArray(payload.data) ? payload.data : []
      let matchCount = 0

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]

        if (!matchesRegion(row, region)) {
          continue
        }

        const notice = toNotice(row, endpoint)

        if (!includeClosed && notice.statusCode === 'closed') {
          continue
        }

        if (!isRecentNotice(notice, sinceDate)) {
          continue
        }

        notices.push(notice)
        matchCount += 1
      }

      summaries.push({
        code: endpoint.code,
        label: endpoint.label,
        count: matchCount,
        error: '',
      })
    } catch (exception) {
      const message = String(exception && exception.message ? exception.message : exception)

      errors.push(endpoint.label + ': ' + message)
      summaries.push({
        code: endpoint.code,
        label: endpoint.label,
        count: 0,
        error: message,
      })
    }
  }

  try {
    const lhResult = searchLhSaleNotices(requestConfig, region, includeClosed)

    for (let index = 0; index < lhResult.notices.length; index += 1) {
      notices.push(lhResult.notices[index])
    }

    summaries.push(lhResult.summary)
  } catch (exception) {
    const message = String(exception && exception.message ? exception.message : exception)

    errors.push(LH_ENDPOINT.label + ': ' + message)
    summaries.push({
      code: LH_ENDPOINT.code,
      label: LH_ENDPOINT.label,
      count: 0,
      error: message,
    })
  }

  const sortedNotices = dedupeNotices(notices).sort(compareNotices)

  return {
    region: region,
    notices: sortedNotices,
    summaries: summaries,
    errors: errors,
  }
}

module.exports = {
  getRegion,
  listRegions,
  searchRegionNotices,
}
