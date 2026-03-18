const { globalApi } = require('pocketpages')
const dbg = globalApi.dbg

const DEFAULT_BASE_URL = 'http://data4library.kr/api'
const DEFAULT_TIMEOUT_SECONDS = 15

/**
 * data4library 요청용 query string을 만든다.
 * @param {Object<string, any>} query 값 객체
 * @returns {string} 직렬화된 query string
 */
function toQueryString(query) {
  const keys = Object.keys(query || {})
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
 * data4library API에 GET 요청을 보낸다.
 * @param {{ apiKey: string, baseUrl?: string, timeout?: number }} config 호출 설정
 * @param {string} path API 경로
 * @param {Object<string, any>} query 요청 query
 * @returns {any} 파싱된 json 응답
 */
function requestData4LibraryJson(config, path, query) {
  const apiKey = String(config && config.apiKey ? config.apiKey : '').trim()
  const baseUrl = String(config && config.baseUrl ? config.baseUrl : DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeout = config && config.timeout ? config.timeout : DEFAULT_TIMEOUT_SECONDS

  if (!apiKey) {
    throw new Error('DATA4LIBRARY_APIKEY 환경변수가 필요합니다.')
  }

  const requestQuery = Object.assign(
    {
      authKey: apiKey,
      format: 'json',
    },
    query || {},
  )
  const url = baseUrl + path + '?' + toQueryString(requestQuery)

  dbg('data4library:request', {
    path: path,
    url: url.replace(apiKey, '[REDACTED]'),
  })

  const response = $http.send({
    url: url,
    method: 'GET',
    timeout: timeout,
  })

  dbg('data4library:response', {
    path: path,
    statusCode: response.statusCode,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('도서관정보나루 API 요청에 실패했습니다. status=' + response.statusCode)
  }

  if (!response.json || !response.json.response) {
    throw new Error('도서관정보나루 API 응답 형식이 올바르지 않습니다.')
  }

  return response.json
}

/**
 * 도서 검색 API 응답의 doc 목록을 평탄화한다.
 * @param {Array<any>} docs 원본 docs 배열
 * @returns {Array<any>} 평탄화된 도서 목록
 */
function normalizeSearchDocs(docs) {
  const list = Array.isArray(docs) ? docs : []
  const normalized = []

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    normalized.push(item && item.doc ? item.doc : item)
  }

  return normalized
}

/**
 * 상세 조회 응답에서 첫 도서 정보를 꺼낸다.
 * @param {Array<any>} detail 원본 detail 배열
 * @returns {any} 첫 도서 정보
 */
function normalizeDetailBook(detail) {
  const list = Array.isArray(detail) ? detail : []
  if (list.length === 0) {
    return null
  }

  const firstItem = list[0]
  return firstItem && firstItem.book ? firstItem.book : null
}

/**
 * 키워드로 도서 목록을 조회한다.
 * @param {{ apiKey: string, baseUrl?: string, timeout?: number }} config 호출 설정
 * @param {{ keyword: string, pageNo?: number, pageSize?: number, sort?: string, direction?: string, exactMatch?: boolean }} input 검색 조건
 * @returns {{ request: any, numFound: number, docs: Array<any>, raw: any }} 검색 결과
 */
function searchBooks(config, input) {
  const keyword = String(input && input.keyword ? input.keyword : '').trim()
  if (!keyword) {
    throw new Error('도서 검색 keyword가 필요합니다.')
  }

  const payload = requestData4LibraryJson(config, '/srchBooks', {
    keyword: keyword,
    pageNo: input && input.pageNo ? input.pageNo : 1,
    pageSize: input && input.pageSize ? input.pageSize : 10,
    sort: input && input.sort ? input.sort : 'loan_count',
    direction: input && input.direction ? input.direction : 'desc',
    exactMatch: input && input.exactMatch ? 'true' : 'false',
  })
  const response = payload.response

  return {
    request: response.request || {},
    numFound: Number(response.numFound || 0),
    docs: normalizeSearchDocs(response.docs),
    raw: response,
  }
}

/**
 * ISBN13으로 도서 상세 정보를 조회한다.
 * @param {{ apiKey: string, baseUrl?: string, timeout?: number }} config 호출 설정
 * @param {{ isbn13: string, loaninfoYN?: string, displayInfo?: string }} input 상세 조회 조건
 * @returns {{ request: any, book: any, detail: Array<any>, loanInfo: Array<any>, raw: any }} 상세 조회 결과
 */
function getBookDetail(config, input) {
  const isbn13 = String(input && input.isbn13 ? input.isbn13 : '').trim()
  if (!isbn13) {
    throw new Error('도서 상세 조회 isbn13이 필요합니다.')
  }

  const payload = requestData4LibraryJson(config, '/srchDtlList', {
    isbn13: isbn13,
    loaninfoYN: input && input.loaninfoYN ? input.loaninfoYN : 'Y',
    displayInfo: input && input.displayInfo ? input.displayInfo : '',
  })
  const response = payload.response
  const detail = Array.isArray(response.detail) ? response.detail : []
  const loanInfo = Array.isArray(response.loanInfo) ? response.loanInfo : []

  return {
    request: response.request || {},
    book: normalizeDetailBook(detail),
    detail: detail,
    loanInfo: loanInfo,
    raw: response,
  }
}

module.exports = {
  searchBooks,
  getBookDetail,
}
