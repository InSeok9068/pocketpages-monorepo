'use strict'

// 토스증권 Open API 호출을 PocketBase JSVM의 동기 HTTP 환경에 맞춰 감싼 모듈입니다.
// 각 공개 메서드는 apps/seedlab/.docs/tossapi.json의 operationId와 같은 이름을 사용합니다.

const { globalApi } = require('pocketpages')
const { env } = globalApi

// 토스증권 공식 API 기본 접속 정보입니다.
const DEFAULT_BASE_URL = 'https://openapi.tossinvest.com'
const DEFAULT_TIMEOUT_SECONDS = 20

// 만료 직전 토큰을 피하기 위한 여유 시간입니다.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000

// ---------------------------------------------------------------------------
// 문자열, query, path 정리
// ---------------------------------------------------------------------------

/**
 * 공백을 제거한 문자열을 만듭니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 문자열 값입니다.
 */
function cleanText(value) {
  return String(value == null ? '' : value).trim()
}

/**
 * 환경 변수 값을 읽습니다.
 * @param {string} name 환경 변수 이름입니다.
 * @returns {string} 환경 변수 값입니다.
 */
function readEnv(name) {
  return cleanText(env(name))
}

/**
 * 객체 여부를 확인합니다.
 * @param {unknown} value 확인할 값입니다.
 * @returns {boolean} 일반 객체이면 true입니다.
 */
function isObjectRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 필수 문자열 값을 확인합니다.
 * @param {unknown} value 확인할 값입니다.
 * @param {string} name 값 이름입니다.
 * @returns {string} 정리한 문자열입니다.
 */
function requireText(value, name) {
  const text = cleanText(value)
  if (!text) throw new Error(`${name} is required`)
  return text
}

/**
 * 양수 숫자 옵션을 정리합니다.
 * @param {unknown} value 옵션 값입니다.
 * @param {number} fallback 기본값입니다.
 * @returns {number} 정리한 숫자입니다.
 */
function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

/**
 * 기준 URL을 정리합니다.
 * @param {unknown} value URL 값입니다.
 * @returns {string} 끝 슬래시를 제거한 URL입니다.
 */
function normalizeBaseUrl(value) {
  return cleanText(value || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/**
 * 종목 목록 query 값을 만듭니다.
 * @param {unknown} symbols 종목 목록입니다.
 * @returns {string} 콤마로 연결한 종목 문자열입니다.
 */
function normalizeSymbols(symbols) {
  if (Array.isArray(symbols)) {
    const list = []
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = cleanText(symbols[index])
      if (symbol) list.push(symbol)
    }
    return list.join(',')
  }

  return cleanText(symbols)
}

/**
 * query 값 문자열을 만듭니다.
 * @param {unknown} value query 값입니다.
 * @returns {string} query 문자열 값입니다.
 */
function toQueryValue(value) {
  // 토스 API 다건 종목 파라미터는 배열이 아니라 콤마 문자열입니다.
  if (Array.isArray(value)) return normalizeSymbols(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return cleanText(value)
}

/**
 * query string을 만듭니다.
 * @param {Record<string, any>} query query 객체입니다.
 * @returns {string} 직렬화된 query string입니다.
 */
function toQueryString(query) {
  const keys = Object.keys(query || {})
  const segments = []

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const value = query[key]
    const text = toQueryValue(value)

    if (text === '') continue
    segments.push(encodeURIComponent(key) + '=' + encodeURIComponent(text))
  }

  return segments.join('&')
}

/**
 * URL에 query string을 붙입니다.
 * @param {string} url 원본 URL입니다.
 * @param {Record<string, any>} query query 객체입니다.
 * @returns {string} query가 포함된 URL입니다.
 */
function appendQuery(url, query) {
  const queryString = toQueryString(query)
  if (!queryString) return url
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + queryString
}

/**
 * path parameter를 치환합니다.
 * @param {string} path API 경로입니다.
 * @param {Record<string, any>} params path parameter입니다.
 * @returns {string} 치환된 API 경로입니다.
 */
function applyPathParams(path, params) {
  let nextPath = String(path || '')
  const keys = Object.keys(params || {})

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const value = requireText(params[key], key)
    // OpenAPI 경로의 {orderId}, {symbol} 같은 path parameter를 치환합니다.
    nextPath = nextPath.replace('{' + key + '}', encodeURIComponent(value))
  }

  return nextPath
}

// ---------------------------------------------------------------------------
// 응답 envelope 정리
// ---------------------------------------------------------------------------

/**
 * form-urlencoded body를 만듭니다.
 * @param {Record<string, any>} payload 요청 payload입니다.
 * @returns {string} form body입니다.
 */
function toFormBody(payload) {
  return toQueryString(payload || {})
}

/**
 * 헤더 값을 대소문자 무관하게 읽습니다.
 * @param {Record<string, any>} headers 응답 헤더입니다.
 * @param {string} name 헤더 이름입니다.
 * @returns {string[]} 헤더 값 목록입니다.
 */
function getHeaderValues(headers, name) {
  const target = cleanText(name).toLowerCase()
  const keys = Object.keys(headers || {})

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (cleanText(key).toLowerCase() !== target) continue

    const value = headers[key]
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean)
    const text = cleanText(value)
    return text ? [text] : []
  }

  return []
}

/**
 * 요청 제한 헤더를 정리합니다.
 * @param {Record<string, any>} headers 응답 헤더입니다.
 * @returns {types.TossApiRateLimit} rate limit 정보입니다.
 */
function readRateLimit(headers) {
  return {
    limit: getHeaderValues(headers, 'X-RateLimit-Limit')[0] || '',
    remaining: getHeaderValues(headers, 'X-RateLimit-Remaining')[0] || '',
    reset: getHeaderValues(headers, 'X-RateLimit-Reset')[0] || '',
    retryAfter: getHeaderValues(headers, 'Retry-After')[0] || '',
  }
}

/**
 * 클라이언트 오류 결과를 만듭니다.
 * @param {string} operationId API operationId입니다.
 * @param {string} message 오류 메시지입니다.
 * @returns {types.TossApiResult} 호출 결과입니다.
 */
function buildClientErrorResult(operationId, message) {
  return {
    ok: false,
    statusCode: 0,
    operationId,
    json: {},
    result: null,
    error: null,
    errorMessage: cleanText(message),
    requestId: '',
    headers: {},
    rateLimit: readRateLimit({}),
  }
}

/**
 * HTTP 응답 결과를 만듭니다.
 * @param {Record<string, any>} args 응답 인자입니다.
 * @returns {types.TossApiResult} 호출 결과입니다.
 */
function buildHttpResult(args) {
  const response = args.response || {}
  const statusCode = Number(response.statusCode || 0)
  const headers = response.headers || {}
  const json = isObjectRecord(response.json) ? response.json : {}
  const error = isObjectRecord(json.error) ? json.error : null
  const oauthErrorCode = typeof json.error === 'string' ? cleanText(json.error) : ''
  const oauthErrorDescription = cleanText(json.error_description)
  const httpOk = statusCode >= 200 && statusCode < 300
  const result = Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : json
  const requestId = cleanText((error && error.requestId) || getHeaderValues(headers, 'X-Request-Id')[0] || '')
  const errorMessage = cleanText(
    args.transportError || (error && error.message) || json.message || oauthErrorDescription || oauthErrorCode || ''
  )

  // OAuth 토큰 응답은 result envelope이 없으므로 json 전체를 result처럼 다룹니다.
  return {
    ok: httpOk && !error && !args.transportError,
    statusCode,
    operationId: cleanText(args.operationId),
    json,
    result,
    error,
    errorMessage,
    requestId,
    headers,
    rateLimit: readRateLimit(headers),
  }
}

// ---------------------------------------------------------------------------
// 클라이언트 런타임과 OAuth 토큰 관리
// ---------------------------------------------------------------------------

/**
 * 클라이언트 런타임 값을 만듭니다.
 * @param {Record<string, any>} options 클라이언트 옵션입니다.
 * @returns {Record<string, any>} 런타임 값입니다.
 */
function createRuntime(options) {
  const safeOptions = options || {}
  const expiresInSeconds = Number(safeOptions.accessTokenExpiresInSeconds || 0)
  const nowMs = Date.now()

  return {
    baseUrl: normalizeBaseUrl(safeOptions.baseUrl || readEnv('TOSSINVEST_BASE_URL') || DEFAULT_BASE_URL),
    timeoutSeconds: normalizePositiveNumber(safeOptions.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    // 환경변수 기본 이름은 사용자가 정한 TOSS_APIKEY / TOSS_SECRET만 사용합니다.
    clientId: cleanText(safeOptions.clientId || safeOptions.apiKey || readEnv('TOSS_APIKEY')),
    clientSecret: cleanText(safeOptions.clientSecret || safeOptions.secret || readEnv('TOSS_SECRET')),
    accessToken: cleanText(safeOptions.accessToken || readEnv('TOSSINVEST_ACCESS_TOKEN')),
    accountSeq: cleanText(safeOptions.accountSeq || readEnv('TOSSINVEST_ACCOUNT_SEQ')),
    accessTokenExpiresAtMs:
      expiresInSeconds > 0 ? nowMs + expiresInSeconds * 1000 : Number(safeOptions.accessTokenExpiresAtMs || 0),
  }
}

/**
 * 캐시된 액세스 토큰을 읽습니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {string} 사용 가능한 토큰입니다.
 */
function readCachedAccessToken(runtime) {
  const accessToken = cleanText(runtime.accessToken)
  if (!accessToken) return ''

  const expiresAtMs = Number(runtime.accessTokenExpiresAtMs || 0)
  // 만료 시각을 모르는 토큰은 호출자가 직접 관리하는 토큰으로 보고 그대로 사용합니다.
  if (expiresAtMs > 0 && Date.now() + TOKEN_EXPIRY_SKEW_MS >= expiresAtMs) {
    return ''
  }

  return accessToken
}

/**
 * 토큰 응답을 런타임에 저장합니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @param {Record<string, any>} tokenJson 토큰 응답입니다.
 * @returns {string} 저장한 액세스 토큰입니다.
 */
function saveAccessToken(runtime, tokenJson) {
  const accessToken = requireText(tokenJson && tokenJson.access_token, 'access_token')
  const expiresInSeconds = Number(tokenJson && tokenJson.expires_in ? tokenJson.expires_in : 0)

  // 런타임 안에만 저장해 같은 클라이언트 인스턴스의 후속 요청에서 재사용합니다.
  runtime.accessToken = accessToken
  runtime.accessTokenExpiresAtMs = expiresInSeconds > 0 ? Date.now() + expiresInSeconds * 1000 : 0
  return accessToken
}

/**
 * OAuth2 토큰을 발급받습니다.
 * @param {types.TossTokenRequest} input 토큰 요청 값입니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {types.TossApiResult<types.TossTokenResponse>} 호출 결과입니다.
 */
function issueOAuth2Token(input, runtime) {
  const payload = {
    grant_type: 'client_credentials',
    client_id: requireText((input && (input.clientId || input.apiKey)) || runtime.clientId, 'clientId'),
    client_secret: requireText((input && (input.clientSecret || input.secret)) || runtime.clientSecret, 'clientSecret'),
  }

  try {
    // 토스증권 토큰 발급은 JSON이 아니라 form-urlencoded body를 요구합니다.
    const response = $http.send({
      url: runtime.baseUrl + '/oauth2/token',
      method: 'POST',
      timeout: runtime.timeoutSeconds,
      body: toFormBody(payload),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })
    const result = buildHttpResult({
      operationId: 'issueOAuth2Token',
      response,
      transportError: '',
    })

    if (result.ok) saveAccessToken(runtime, result.json)
    return result
  } catch (error) {
    return buildHttpResult({
      operationId: 'issueOAuth2Token',
      response: {},
      transportError: cleanText(error),
    })
  }
}

/**
 * 인증 토큰을 확보합니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {{ ok: boolean, accessToken: string, tokenResult: types.TossApiResult<types.TossTokenResponse> | null }} 토큰 확보 결과입니다.
 */
function ensureAccessToken(runtime) {
  const cachedToken = readCachedAccessToken(runtime)
  if (cachedToken) {
    return {
      ok: true,
      accessToken: cachedToken,
      tokenResult: null,
    }
  }

  // 호출자가 토큰을 넘기지 않았거나 만료된 경우 client credentials로 새 토큰을 발급합니다.
  const tokenResult = issueOAuth2Token({}, runtime)
  if (!tokenResult.ok) {
    return {
      ok: false,
      accessToken: '',
      tokenResult,
    }
  }

  return {
    ok: true,
    accessToken: runtime.accessToken,
    tokenResult,
  }
}

// ---------------------------------------------------------------------------
// 공통 HTTP 요청
// ---------------------------------------------------------------------------

/**
 * 계좌 식별자를 선택합니다.
 * @param {types.TossRawRequest} descriptor 요청 설명입니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @returns {string} 계좌 식별자입니다.
 */
function resolveAccountSeq(descriptor, runtime) {
  return cleanText(descriptor.accountSeq || runtime.accountSeq)
}

/**
 * Toss Open API 요청을 보냅니다.
 * @param {Record<string, any>} runtime 런타임 값입니다.
 * @param {types.TossRawRequest} descriptor 요청 설명입니다.
 * @returns {types.TossApiResult} 호출 결과입니다.
 */
function requestTossApi(runtime, descriptor) {
  const operationId = cleanText(descriptor.operationId || 'request')
  const method = cleanText(descriptor.method || 'GET').toUpperCase()
  const path = applyPathParams(descriptor.path, descriptor.pathParams || {})
  const url = appendQuery(runtime.baseUrl + path, descriptor.query || {})
  const headers = Object.assign(
    {
      Accept: 'application/json',
    },
    descriptor.headers || {}
  )

  if (descriptor.requiresAuth !== false) {
    // 기본값은 인증 필요입니다. OAuth 토큰 발급 같은 예외만 requiresAuth=false를 씁니다.
    const tokenState = ensureAccessToken(runtime)
    if (!tokenState.ok) return tokenState.tokenResult || buildClientErrorResult(operationId, 'access token is required')
    headers.Authorization = 'Bearer ' + tokenState.accessToken
  }

  if (descriptor.requiresAccount) {
    // 계좌/자산/주문 API는 토큰 외에 X-Tossinvest-Account 헤더가 필요합니다.
    const accountSeq = resolveAccountSeq(descriptor, runtime)
    if (!accountSeq) return buildClientErrorResult(operationId, 'accountSeq is required')
    headers['X-Tossinvest-Account'] = accountSeq
  }

  const httpOptions = {
    url,
    method,
    timeout: normalizePositiveNumber(descriptor.timeoutSeconds, runtime.timeoutSeconds),
    headers,
  }

  if (Object.prototype.hasOwnProperty.call(descriptor, 'body')) {
    // 주문 생성/정정/취소 계열은 JSON body로 보냅니다.
    headers['Content-Type'] = 'application/json'
    httpOptions.body = JSON.stringify(descriptor.body == null ? {} : descriptor.body)
  }

  try {
    return buildHttpResult({
      operationId,
      response: $http.send(httpOptions),
      transportError: '',
    })
  } catch (error) {
    return buildHttpResult({
      operationId,
      response: {},
      transportError: cleanText(error),
    })
  }
}

/**
 * 토스증권 Open API 클라이언트를 만듭니다.
 * @param {types.TossApiClientOptions} [options] 클라이언트 옵션입니다.
 * @returns {types.TossApiClient} 토스증권 API 클라이언트입니다.
 */
function createTossApiClient(options) {
  const runtime = createRuntime(options || {})

  return {
    /**
     * OAuth2 액세스 토큰을 발급합니다.
     * @param {types.TossTokenRequest} [input] 토큰 요청 값입니다.
     * @returns {types.TossApiResult<types.TossTokenResponse>} 호출 결과입니다.
     */
    issueOAuth2Token(input) {
      return issueOAuth2Token(input || {}, runtime)
    },

    /**
     * 액세스 토큰을 수동으로 교체합니다.
     * @param {string} accessToken 액세스 토큰입니다.
     * @param {number} [expiresInSeconds] 만료까지 남은 초입니다.
     * @returns {void}
     */
    setAccessToken(accessToken, expiresInSeconds) {
      saveAccessToken(runtime, {
        access_token: accessToken,
        expires_in: expiresInSeconds || 0,
      })
    },

    /**
     * 공통 요청 함수로 API를 호출합니다.
     * @param {types.TossRawRequest} descriptor 요청 설명입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    request(descriptor) {
      if (!descriptor) return buildClientErrorResult('request', 'descriptor is required')
      return requestTossApi(runtime, descriptor)
    },

    /**
     * 호가를 조회합니다.
     * @param {types.TossSymbolRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getOrderbook(input) {
      const symbol = requireText(input && input.symbol, 'symbol')
      return requestTossApi(runtime, {
        operationId: 'getOrderbook',
        method: 'GET',
        path: '/api/v1/orderbook',
        query: { symbol },
      })
    },

    /**
     * 현재가를 조회합니다.
     * @param {types.TossSymbolsRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getPrices(input) {
      const symbols = requireText(normalizeSymbols(input && input.symbols), 'symbols')
      return requestTossApi(runtime, {
        operationId: 'getPrices',
        method: 'GET',
        path: '/api/v1/prices',
        query: { symbols },
      })
    },

    /**
     * 최근 체결 내역을 조회합니다.
     * @param {types.TossTradesRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getTrades(input) {
      const symbol = requireText(input && input.symbol, 'symbol')
      return requestTossApi(runtime, {
        operationId: 'getTrades',
        method: 'GET',
        path: '/api/v1/trades',
        query: {
          symbol,
          count: input && input.count,
        },
      })
    },

    /**
     * 상하한가를 조회합니다.
     * @param {types.TossSymbolRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getPriceLimit(input) {
      const symbol = requireText(input && input.symbol, 'symbol')
      return requestTossApi(runtime, {
        operationId: 'getPriceLimit',
        method: 'GET',
        path: '/api/v1/price-limits',
        query: { symbol },
      })
    },

    /**
     * 캔들 차트를 조회합니다.
     * @param {types.TossCandlesRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getCandles(input) {
      const symbol = requireText(input && input.symbol, 'symbol')
      const interval = requireText(input && input.interval, 'interval')
      return requestTossApi(runtime, {
        operationId: 'getCandles',
        method: 'GET',
        path: '/api/v1/candles',
        query: {
          symbol,
          interval,
          count: input && input.count,
          before: input && input.before,
          adjusted: input && input.adjusted,
        },
      })
    },

    /**
     * 종목 기본 정보를 조회합니다.
     * @param {types.TossSymbolsRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getStocks(input) {
      const symbols = requireText(normalizeSymbols(input && input.symbols), 'symbols')
      return requestTossApi(runtime, {
        operationId: 'getStocks',
        method: 'GET',
        path: '/api/v1/stocks',
        query: { symbols },
      })
    },

    /**
     * 매수 유의사항을 조회합니다.
     * @param {types.TossSymbolRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getStockWarnings(input) {
      return requestTossApi(runtime, {
        operationId: 'getStockWarnings',
        method: 'GET',
        path: '/api/v1/stocks/{symbol}/warnings',
        pathParams: {
          symbol: input && input.symbol,
        },
      })
    },

    /**
     * 환율을 조회합니다.
     * @param {types.TossExchangeRateRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getExchangeRate(input) {
      return requestTossApi(runtime, {
        operationId: 'getExchangeRate',
        method: 'GET',
        path: '/api/v1/exchange-rate',
        query: {
          baseCurrency: requireText(input && input.baseCurrency, 'baseCurrency'),
          quoteCurrency: requireText(input && input.quoteCurrency, 'quoteCurrency'),
          dateTime: input && input.dateTime,
        },
      })
    },

    /**
     * 국내 장 운영 정보를 조회합니다.
     * @param {types.TossMarketCalendarRequest} [input] 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getKrMarketCalendar(input) {
      return requestTossApi(runtime, {
        operationId: 'getKrMarketCalendar',
        method: 'GET',
        path: '/api/v1/market-calendar/KR',
        query: {
          date: input && input.date,
        },
      })
    },

    /**
     * 미국 장 운영 정보를 조회합니다.
     * @param {types.TossMarketCalendarRequest} [input] 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getUsMarketCalendar(input) {
      return requestTossApi(runtime, {
        operationId: 'getUsMarketCalendar',
        method: 'GET',
        path: '/api/v1/market-calendar/US',
        query: {
          date: input && input.date,
        },
      })
    },

    /**
     * 계좌 목록을 조회합니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getAccounts() {
      return requestTossApi(runtime, {
        operationId: 'getAccounts',
        method: 'GET',
        path: '/api/v1/accounts',
      })
    },

    /**
     * 보유 주식을 조회합니다.
     * @param {types.TossHoldingsRequest} [input] 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getHoldings(input) {
      return requestTossApi(runtime, {
        operationId: 'getHoldings',
        method: 'GET',
        path: '/api/v1/holdings',
        requiresAccount: true,
        accountSeq: input && input.accountSeq,
        query: {
          symbol: input && input.symbol,
        },
      })
    },

    /**
     * 주문 목록을 조회합니다.
     * @param {types.TossOrdersRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getOrders(input) {
      return requestTossApi(runtime, {
        operationId: 'getOrders',
        method: 'GET',
        path: '/api/v1/orders',
        requiresAccount: true,
        accountSeq: input && input.accountSeq,
        query: {
          status: requireText(input && input.status, 'status'),
          symbol: input && input.symbol,
          from: input && input.from,
          to: input && input.to,
          cursor: input && input.cursor,
          limit: input && input.limit,
        },
      })
    },

    /**
     * 주문을 생성합니다.
     * @param {types.TossOrderCreateRequest} order 주문 요청입니다.
     * @param {types.TossAccountOption} [options] 계좌 옵션입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    createOrder(order, options) {
      return requestTossApi(runtime, {
        operationId: 'createOrder',
        method: 'POST',
        path: '/api/v1/orders',
        requiresAccount: true,
        accountSeq: options && options.accountSeq,
        body: order || {},
      })
    },

    /**
     * 주문 상세를 조회합니다.
     * @param {types.TossOrderIdRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getOrder(input) {
      return requestTossApi(runtime, {
        operationId: 'getOrder',
        method: 'GET',
        path: '/api/v1/orders/{orderId}',
        requiresAccount: true,
        accountSeq: input && input.accountSeq,
        pathParams: {
          orderId: input && input.orderId,
        },
      })
    },

    /**
     * 주문을 정정합니다.
     * @param {string} orderId 주문 식별자입니다.
     * @param {types.TossOrderModifyRequest} order 주문 정정 요청입니다.
     * @param {types.TossAccountOption} [options] 계좌 옵션입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    modifyOrder(orderId, order, options) {
      return requestTossApi(runtime, {
        operationId: 'modifyOrder',
        method: 'POST',
        path: '/api/v1/orders/{orderId}/modify',
        requiresAccount: true,
        accountSeq: options && options.accountSeq,
        pathParams: {
          orderId,
        },
        body: order || {},
      })
    },

    /**
     * 주문을 취소합니다.
     * @param {string} orderId 주문 식별자입니다.
     * @param {types.TossAccountOption} [options] 계좌 옵션입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    cancelOrder(orderId, options) {
      return requestTossApi(runtime, {
        operationId: 'cancelOrder',
        method: 'POST',
        path: '/api/v1/orders/{orderId}/cancel',
        requiresAccount: true,
        accountSeq: options && options.accountSeq,
        pathParams: {
          orderId,
        },
        body: {},
      })
    },

    /**
     * 매수 가능 금액을 조회합니다.
     * @param {types.TossBuyingPowerRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getBuyingPower(input) {
      return requestTossApi(runtime, {
        operationId: 'getBuyingPower',
        method: 'GET',
        path: '/api/v1/buying-power',
        requiresAccount: true,
        accountSeq: input && input.accountSeq,
        query: {
          currency: requireText(input && input.currency, 'currency'),
        },
      })
    },

    /**
     * 판매 가능 수량을 조회합니다.
     * @param {types.TossSellableQuantityRequest} input 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getSellableQuantity(input) {
      return requestTossApi(runtime, {
        operationId: 'getSellableQuantity',
        method: 'GET',
        path: '/api/v1/sellable-quantity',
        requiresAccount: true,
        accountSeq: input && input.accountSeq,
        query: {
          symbol: requireText(input && input.symbol, 'symbol'),
        },
      })
    },

    /**
     * 매매 수수료를 조회합니다.
     * @param {types.TossAccountOption} [input] 요청 값입니다.
     * @returns {types.TossApiResult} 호출 결과입니다.
     */
    getCommissions(input) {
      return requestTossApi(runtime, {
        operationId: 'getCommissions',
        method: 'GET',
        path: '/api/v1/commissions',
        requiresAccount: true,
        accountSeq: input && input.accountSeq,
      })
    },
  }
}

module.exports = {
  createTossApiClient,
}
