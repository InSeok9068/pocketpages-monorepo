'use strict'

/* global $http, sleep */

const { globalApi } = require('pocketpages')
const { env, warn } = globalApi

const DEFAULT_GEMINI_API_VERSION = 'v1beta'
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_TIMEOUT_SECONDS = 60
const DEFAULT_MAX_ATTEMPTS = 1
const GEMINI_API_KEY_ENV_NAMES = ['GEMINI_API_KEY', 'GEMINI_AI_KEY']
const OPENAI_API_KEY_ENV_NAMES = ['OPENAI_API_KEY']
const DEEPSEEK_API_KEY_ENV_NAMES = ['DEEPSEEK_API_KEY']
const GEMINI_PAYLOAD_FIELDS = [
  'contents',
  'tools',
  'toolConfig',
  'safetySettings',
  'systemInstruction',
  'generationConfig',
  'cachedContent',
]
const OPENAI_PAYLOAD_FIELDS = [
  'background',
  'conversation',
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'model',
  'parallel_tool_calls',
  'previous_response_id',
  'prompt_cache_key',
  'reasoning',
  'safety_identifier',
  'service_tier',
  'store',
  'temperature',
  'text',
  'tool_choice',
  'tools',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
]
const DEEPSEEK_PAYLOAD_FIELDS = [
  'messages',
  'model',
  'thinking',
  'reasoning_effort',
  'max_tokens',
  'response_format',
  'stop',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'logprobs',
  'top_logprobs',
  'user_id',
]
/**
 * 빈 값이 아닌 문자열을 만듭니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 정리한 문자열입니다.
 */
function cleanText(value) {
  return String(value == null ? '' : value).trim()
}

/**
 * 첫 번째 문자열 값을 고릅니다.
 * @param {unknown[]} values 후보 값 목록입니다.
 * @returns {string} 선택한 문자열입니다.
 */
function firstText(values) {
  for (let index = 0; index < values.length; index += 1) {
    const text = cleanText(values[index])
    if (text) return text
  }
  return ''
}

/**
 * 환경 변수 값을 읽습니다.
 * @param {string} name 환경 변수 이름입니다.
 * @returns {string} 환경 변수 값입니다.
 */
function readEnv(name) {
  if (typeof env === 'function') return cleanText(env(name))
  if (typeof process !== 'undefined' && process.env) return cleanText(process.env[name])
  return ''
}

/**
 * 후보 환경 변수 중 첫 번째 값을 읽습니다.
 * @param {string[]} names 환경 변수 이름 목록입니다.
 * @returns {string} 환경 변수 값입니다.
 */
function readFirstEnv(names) {
  for (let index = 0; index < names.length; index += 1) {
    const value = readEnv(names[index])
    if (value) return value
  }
  return ''
}

/**
 * JSON 문자열을 안전하게 파싱합니다.
 * @param {unknown} text JSON 문자열입니다.
 * @param {unknown} fallback 파싱 실패 시 반환할 값입니다.
 * @returns {unknown} 파싱 결과입니다.
 */
function parseJsonSafely(text, fallback) {
  try {
    return JSON.parse(String(text == null ? '' : text))
  } catch (_error) {
    return fallback
  }
}

/**
 * JSON object를 안전하게 파싱합니다.
 * @param {unknown} text JSON 문자열입니다.
 * @returns {Record<string, any>} 파싱된 object입니다.
 */
function parseJsonObject(text) {
  const parsed = parseJsonSafely(text, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * 정의된 필드를 payload에 복사합니다.
 * @param {Record<string, any>} payload 대상 payload입니다.
 * @param {Record<string, any>} source 원본 옵션입니다.
 * @param {string[]} fields 복사할 필드 목록입니다.
 */
function copyDefinedFields(payload, source, fields) {
  fields.forEach((field) => {
    if (source[field] !== undefined) payload[field] = source[field]
  })
}

/**
 * 응답 body를 문자열로 변환합니다.
 * @param {unknown} value 응답 body입니다.
 * @returns {string} body 문자열입니다.
 */
function stringifyBody(value) {
  if (value == null) return ''
  if (typeof toString === 'function') return String(toString(value) || '')
  return String(value || '')
}

/**
 * 헤더 이름을 대소문자 구분 없이 찾습니다.
 * @param {Record<string, any>} headers 응답 헤더입니다.
 * @param {string} key 찾을 헤더 이름입니다.
 * @returns {string[]} 헤더 값 목록입니다.
 */
function getHeaderValues(headers, key) {
  const wanted = String(key || '').toLowerCase()
  const values = []
  if (!headers || typeof headers !== 'object' || !wanted) return values

  Object.keys(headers).forEach((name) => {
    if (String(name || '').toLowerCase() !== wanted) return
    const rawValue = headers[name]
    if (Array.isArray(rawValue)) {
      rawValue.forEach((value) => {
        values.push(String(value == null ? '' : value))
      })
      return
    }
    values.push(String(rawValue == null ? '' : rawValue))
  })

  return values
}

/**
 * Retry-After 헤더를 ms 단위로 읽습니다.
 * @param {unknown} value Retry-After 헤더 값입니다.
 * @param {() => number} now 현재 시각 함수입니다.
 * @returns {number} 재시도 대기 ms입니다.
 */
function parseRetryAfterMs(value, now) {
  const text = cleanText(value)
  if (!text) return 0

  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds > 0) return Math.trunc(seconds * 1000)

  const dateMs = Date.parse(text)
  if (!Number.isFinite(dateMs)) return 0

  const delayMs = dateMs - now()
  if (delayMs <= 0) return 0
  return Math.trunc(delayMs)
}

/**
 * 재시도 대기 시간을 계산합니다.
 * @param {number} attempt 현재 시도 횟수입니다.
 * @param {unknown} retryAfterHeader Retry-After 헤더 값입니다.
 * @param {{ now: () => number }} runtime 런타임 함수입니다.
 * @returns {number} 다음 재시도까지 기다릴 ms입니다.
 */
function computeRetryDelayMs(attempt, retryAfterHeader, runtime) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, runtime.now)
  if (retryAfterMs > 0) return retryAfterMs

  const step = Math.max(0, Number(attempt || 1) - 1)
  const backoffMs = 1500 * Math.pow(2, step)
  const jitterMs = Math.trunc(Math.random() * 400)
  return backoffMs + jitterMs
}

/**
 * 전송 계층 오류가 재시도 가능한지 확인합니다.
 * @param {unknown} errorText 오류 메시지 값입니다.
 * @returns {boolean} 재시도 가능하면 true입니다.
 */
function isRetryableTransportError(errorText) {
  const text = String(errorText || '').toLowerCase()
  if (!text) return false
  return (
    text.indexOf('timeout') >= 0 ||
    text.indexOf('deadline') >= 0 ||
    text.indexOf('temporarily unavailable') >= 0 ||
    text.indexOf('connection reset') >= 0 ||
    text.indexOf('connection refused') >= 0 ||
    text.indexOf('eof') >= 0
  )
}

/**
 * OpenAI 429 응답의 원인을 추정합니다.
 * @param {Record<string, any>} responseJson 응답 JSON입니다.
 * @returns {string} 원인 추정값입니다.
 */
function inferOpenAi429Cause(responseJson) {
  const error = responseJson && responseJson.error ? responseJson.error : {}
  const code = cleanText(error.code).toLowerCase()
  const type = cleanText(error.type).toLowerCase()

  if (code === 'insufficient_quota' || type === 'insufficient_quota') {
    return 'quota-or-billing-limit'
  }
  return 'rate-limit'
}

/**
 * Gemini HTTP 응답 재시도 가능 여부를 판단합니다.
 * @param {number} statusCode HTTP 상태 코드입니다.
 * @param {Record<string, any>} responseJson 응답 JSON입니다.
 * @returns {boolean} 재시도 가능하면 true입니다.
 */
function isRetryableGeminiResponse(statusCode, responseJson) {
  void responseJson
  return statusCode === 429 || statusCode === 500 || statusCode === 503
}

/**
 * OpenAI HTTP 응답 재시도 가능 여부를 판단합니다.
 * @param {number} statusCode HTTP 상태 코드입니다.
 * @param {Record<string, any>} responseJson 응답 JSON입니다.
 * @returns {boolean} 재시도 가능하면 true입니다.
 */
function isRetryableOpenAiResponse(statusCode, responseJson) {
  if (statusCode === 429) return inferOpenAi429Cause(responseJson) !== 'quota-or-billing-limit'
  return statusCode === 500 || statusCode === 503
}

/**
 * DeepSeek HTTP 응답 재시도 가능 여부를 판단합니다.
 * @param {number} statusCode HTTP 상태 코드입니다.
 * @param {Record<string, any>} responseJson 응답 JSON입니다.
 * @returns {boolean} 재시도 가능하면 true입니다.
 */
function isRetryableDeepSeekResponse(statusCode, responseJson) {
  void responseJson
  return statusCode === 429 || statusCode === 500 || statusCode === 503
}

/**
 * Gemini payload를 만듭니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @returns {Record<string, any>} Gemini payload입니다.
 */
function buildGeminiPayload(request) {
  if (request.payload && typeof request.payload === 'object') return Object.assign({}, request.payload)

  const input = request.input !== undefined ? request.input : request.prompt
  const payload = {}
  copyDefinedFields(payload, request, GEMINI_PAYLOAD_FIELDS)

  if (payload.contents === undefined) {
    payload.contents = [
      {
        parts: [{ text: String(input == null ? '' : input) }],
      },
    ]
  }

  if (request.json === true && !payload.generationConfig) {
    payload.generationConfig = {
      responseMimeType: 'application/json',
    }
  }

  return payload
}

/**
 * OpenAI Responses API payload를 만듭니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @returns {Record<string, any>} OpenAI payload입니다.
 */
function buildOpenAiPayload(request) {
  if (request.payload && typeof request.payload === 'object') {
    const payload = Object.assign({}, request.payload)
    delete payload.stream
    delete payload.stream_options
    return payload
  }

  const input = request.input !== undefined ? request.input : request.prompt !== undefined ? request.prompt : request.message
  const payload = {}
  copyDefinedFields(payload, request, OPENAI_PAYLOAD_FIELDS)

  if (payload.input === undefined) payload.input = input == null ? '' : input
  if (request.json === true && !payload.text) {
    payload.text = {
      format: { type: 'json_object' },
    }
  }

  return payload
}

/**
 * DeepSeek Chat Completions messages를 만듭니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @returns {any[]} messages 배열입니다.
 */
function buildDeepSeekMessages(request) {
  if (Array.isArray(request.messages)) return request.messages

  const messages = []
  const input = request.input !== undefined ? request.input : request.prompt

  if (request.instructions) {
    messages.push({
      role: 'system',
      content: String(request.instructions),
    })
  }

  messages.push({
    role: 'user',
    content: String(input == null ? '' : input),
  })

  return messages
}

/**
 * DeepSeek Chat Completions payload를 만듭니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @returns {Record<string, any>} DeepSeek payload입니다.
 */
function buildDeepSeekPayload(request) {
  if (request.payload && typeof request.payload === 'object') {
    const payload = Object.assign({}, request.payload)
    delete payload.stream
    delete payload.stream_options
    return payload
  }

  const payload = {}
  copyDefinedFields(payload, request, DEEPSEEK_PAYLOAD_FIELDS)

  if (payload.messages === undefined) payload.messages = buildDeepSeekMessages(request)
  if (!payload.model) payload.model = request.model || DEFAULT_DEEPSEEK_MODEL
  if (request.json === true && !payload.response_format) {
    payload.response_format = {
      type: 'json_object',
    }
  }

  delete payload.stream
  delete payload.stream_options

  return payload
}

/**
 * Gemini 응답에서 텍스트를 추출합니다.
 * @param {Record<string, any>} responseJson Gemini 응답 JSON입니다.
 * @returns {string} 추출한 텍스트입니다.
 */
function extractGeminiText(responseJson) {
  const candidates = responseJson && Array.isArray(responseJson.candidates) ? responseJson.candidates : []
  const candidate = candidates[0] || {}
  const content = candidate.content || {}
  const parts = Array.isArray(content.parts) ? content.parts : []

  return parts
    .map((part) => cleanText(part && part.text))
    .filter(Boolean)
    .join('\n')
}

/**
 * OpenAI Responses API 응답에서 텍스트를 추출합니다.
 * @param {Record<string, any>} responseJson OpenAI 응답 JSON입니다.
 * @returns {string} 추출한 텍스트입니다.
 */
function extractOpenAiText(responseJson) {
  const outputText = cleanText(responseJson && responseJson.output_text)
  if (outputText) return outputText

  const output = responseJson && Array.isArray(responseJson.output) ? responseJson.output : []
  const texts = []

  output.forEach((item) => {
    const content = item && Array.isArray(item.content) ? item.content : []
    content.forEach((part) => {
      if (!part || typeof part !== 'object') return
      if (part.type === 'output_text' || part.type === 'text') {
        const text = cleanText(part.text)
        if (text) texts.push(text)
      }
    })
  })

  return texts.join('\n')
}

/**
 * DeepSeek Chat Completions 응답에서 텍스트를 추출합니다.
 * @param {Record<string, any>} responseJson DeepSeek 응답 JSON입니다.
 * @returns {string} 추출한 텍스트입니다.
 */
function extractDeepSeekText(responseJson) {
  const choices = responseJson && Array.isArray(responseJson.choices) ? responseJson.choices : []
  const choice = choices[0] || {}
  const message = choice.message || {}
  return cleanText(message.content)
}

/**
 * HTTP 호출 결과 object를 만듭니다.
 * @param {Record<string, any>} args 결과 인자입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function buildResult(args) {
  const statusCode = Number(args.statusCode || 0)
  const ok = statusCode >= 200 && statusCode < 300 && !args.transportError
  const responseJson = parseJsonObject(args.responseBody)
  const error = responseJson && responseJson.error ? responseJson.error : {}
  const errorMessage = cleanText(args.transportError || error.message || '')
  let rateLimitCause = ''

  if (statusCode === 429 && args.provider === 'gemini') {
    rateLimitCause = 'rate-limit'
  }
  if (statusCode === 429 && args.provider === 'openai') {
    rateLimitCause = inferOpenAi429Cause(responseJson)
  }
  if (statusCode === 429 && args.provider === 'deepseek') {
    rateLimitCause = 'rate-limit'
  }

  return {
    ok,
    provider: args.provider,
    statusCode,
    responseBody: args.responseBody || '',
    responseJson,
    text: args.extractText(responseJson),
    headers: args.headers || {},
    attempts: Number(args.attempts || 0),
    elapsedMs: Number(args.elapsedMs || 0),
    transportError: args.transportError || '',
    errorMessage,
    rateLimitCause,
  }
}

/**
 * HTTP 요청을 재시도 정책과 함께 실행합니다.
 * @param {Record<string, any>} request 요청 정보입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function sendWithRetry(request, runtime) {
  let lastStatusCode = 0
  let lastResponseBody = ''
  let lastHeaders = {}
  let lastTransportError = ''
  let lastElapsedMs = 0
  let attempts = 0

  while (attempts < request.maxAttempts) {
    attempts += 1
    const attemptStartedAt = runtime.now()

    try {
      const response = runtime.http.send(request.httpOptions)
      const elapsedMs = runtime.now() - attemptStartedAt
      const statusCode = Number(response.statusCode || 0)
      const responseBody = stringifyBody(response.body)
      const headers = response.headers || {}
      const responseJson = parseJsonObject(responseBody)

      lastStatusCode = statusCode
      lastResponseBody = responseBody
      lastHeaders = headers
      lastTransportError = ''
      lastElapsedMs = elapsedMs

      if (statusCode >= 200 && statusCode < 300) {
        return buildResult({
          provider: request.provider,
          statusCode,
          responseBody,
          headers,
          attempts,
          elapsedMs,
          transportError: '',
          extractText: request.extractText,
        })
      }

      const retryAfter = getHeaderValues(headers, 'Retry-After')[0] || ''
      const canRetry = attempts < request.maxAttempts && request.isRetryableResponse(statusCode, responseJson)
      if (!canRetry) {
        return buildResult({
          provider: request.provider,
          statusCode,
          responseBody,
          headers,
          attempts,
          elapsedMs,
          transportError: '',
          extractText: request.extractText,
        })
      }

      waitBeforeRetry(request, runtime, attempts, retryAfter, {
        statusCode,
        transportError: '',
      })
    } catch (error) {
      const elapsedMs = runtime.now() - attemptStartedAt
      const errorText = cleanText(error)

      lastStatusCode = 0
      lastResponseBody = ''
      lastHeaders = {}
      lastTransportError = errorText
      lastElapsedMs = elapsedMs

      const canRetry = attempts < request.maxAttempts && isRetryableTransportError(errorText)
      if (!canRetry) {
        return buildResult({
          provider: request.provider,
          statusCode: 0,
          responseBody: '',
          headers: {},
          attempts,
          elapsedMs,
          transportError: errorText,
          extractText: request.extractText,
        })
      }

      waitBeforeRetry(request, runtime, attempts, '', {
        statusCode: 0,
        transportError: errorText,
      })
    }
  }

  return buildResult({
    provider: request.provider,
    statusCode: lastStatusCode,
    responseBody: lastResponseBody,
    headers: lastHeaders,
    attempts,
    elapsedMs: lastElapsedMs,
    transportError: lastTransportError,
    extractText: request.extractText,
  })
}

/**
 * 다음 재시도 전 대기하고 로그를 남깁니다.
 * @param {Record<string, any>} request 요청 정보입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @param {number} attempts 현재 시도 횟수입니다.
 * @param {unknown} retryAfter Retry-After 헤더입니다.
 * @param {{ statusCode: number, transportError: string }} failure 실패 정보입니다.
 */
function waitBeforeRetry(request, runtime, attempts, retryAfter, failure) {
  const delayMs = computeRetryDelayMs(attempts, retryAfter, runtime)
  const meta = {
    provider: request.provider,
    attempt: attempts,
    statusCode: failure.statusCode,
    error: failure.transportError,
    delayMs,
  }

  Object.keys(request.logMeta || {}).forEach((key) => {
    meta[key] = request.logMeta[key]
  })

  if (typeof warn === 'function') {
    warn('pocketpages/ai:retry', meta)
  }
  runtime.sleep(delayMs)
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
 * provider별 API 키를 고릅니다.
 * @param {string} provider AI provider입니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @returns {string} API 키입니다.
 */
function resolveApiKey(provider, request, runtime) {
  if (request.apiKey) return cleanText(request.apiKey)
  if (provider === 'gemini') return firstText([runtime.apiKeys.gemini, readFirstEnv(GEMINI_API_KEY_ENV_NAMES)])
  if (provider === 'openai') return firstText([runtime.apiKeys.openai, readFirstEnv(OPENAI_API_KEY_ENV_NAMES)])
  if (provider === 'deepseek') return firstText([runtime.apiKeys.deepseek, readFirstEnv(DEEPSEEK_API_KEY_ENV_NAMES)])
  return ''
}

/**
 * provider별 기본 모델을 고릅니다.
 * @param {string} provider AI provider입니다.
 * @param {Record<string, any>} request 요청 옵션입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @returns {string} 모델 이름입니다.
 */
function resolveModel(provider, request, runtime) {
  if (request.model) return request.model
  if (provider === 'gemini') return runtime.models.gemini || DEFAULT_GEMINI_MODEL
  if (provider === 'openai') return runtime.models.openai || DEFAULT_OPENAI_MODEL
  if (provider === 'deepseek') return runtime.models.deepseek || DEFAULT_DEEPSEEK_MODEL
  return ''
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
 * 요청 시도 횟수를 정리합니다.
 * @param {unknown} value 옵션 값입니다.
 * @param {number} fallback 기본값입니다.
 * @returns {number} 정리한 시도 횟수입니다.
 */
function normalizeAttempts(value, fallback) {
  const parsed = normalizePositiveNumber(value, fallback)
  return Math.max(1, Math.trunc(parsed))
}

/**
 * 클라이언트 런타임 의존성을 만듭니다.
 * @param {Record<string, any>} options 클라이언트 옵션입니다.
 * @returns {Record<string, any>} 런타임 의존성입니다.
 */
function createRuntime(options) {
  const globalHttp = typeof $http !== 'undefined' ? $http : null
  const globalSleep = typeof sleep === 'function' ? sleep : null
  const runtime = {
    http: globalHttp,
    sleep: globalSleep || function noopSleep(_ms) {},
    now: Date.now,
    defaultTimeoutSeconds: normalizePositiveNumber(options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    defaultMaxAttempts: normalizeAttempts(options.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    defaultProvider: cleanText(options.provider).toLowerCase(),
    apiKeys: {
      gemini: cleanText(options.geminiApiKey),
      openai: cleanText(options.openaiApiKey),
      deepseek: cleanText(options.deepseekApiKey),
    },
    models: {
      gemini: cleanText(options.geminiModel),
      openai: cleanText(options.openaiModel),
      deepseek: cleanText(options.deepseekModel),
    },
  }

  if (!runtime.http || typeof runtime.http.send !== 'function') {
    throw new Error('$http.send is required. Run inside PocketBase JSVM.')
  }

  return runtime
}

/**
 * Gemini generateContent 요청을 실행합니다.
 * @param {Record<string, any>} input 요청 옵션입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function requestGemini(input, runtime) {
  const request = input || {}
  const apiKey = requireText(resolveApiKey('gemini', request, runtime), 'Gemini apiKey')
  const apiVersion = request.apiVersion || DEFAULT_GEMINI_API_VERSION
  const model = resolveModel('gemini', request, runtime)
  const baseUrl = request.baseUrl || DEFAULT_GEMINI_BASE_URL
  const timeout = normalizePositiveNumber(request.timeoutSeconds, runtime.defaultTimeoutSeconds)
  const maxAttempts = normalizeAttempts(request.maxAttempts, runtime.defaultMaxAttempts)
  const payload = buildGeminiPayload(request)
  const headers = {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  }

  return sendWithRetry(
    {
      provider: 'gemini',
      maxAttempts,
      logMeta: request.logMeta || {},
      isRetryableResponse: isRetryableGeminiResponse,
      extractText: extractGeminiText,
      httpOptions: {
        url: `${baseUrl}/${apiVersion}/models/${model}:generateContent`,
        method: 'POST',
        timeout,
        body: JSON.stringify(payload),
        headers,
      },
    },
    runtime
  )
}

/**
 * OpenAI Responses API 요청을 실행합니다.
 * @param {Record<string, any>} input 요청 옵션입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function requestOpenAi(input, runtime) {
  const request = input || {}
  const apiKey = requireText(resolveApiKey('openai', request, runtime), 'OpenAI apiKey')
  const baseUrl = request.baseUrl || DEFAULT_OPENAI_BASE_URL
  const timeout = normalizePositiveNumber(request.timeoutSeconds, runtime.defaultTimeoutSeconds)
  const maxAttempts = normalizeAttempts(request.maxAttempts, runtime.defaultMaxAttempts)
  const payload = buildOpenAiPayload(request)
  if (!payload.model) payload.model = resolveModel('openai', request, runtime)
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }

  return sendWithRetry(
    {
      provider: 'openai',
      maxAttempts,
      logMeta: request.logMeta || {},
      isRetryableResponse: isRetryableOpenAiResponse,
      extractText: extractOpenAiText,
      httpOptions: {
        url: `${baseUrl}/v1/responses`,
        method: 'POST',
        timeout,
        body: JSON.stringify(payload),
        headers,
      },
    },
    runtime
  )
}

/**
 * DeepSeek Chat Completions 요청을 실행합니다.
 * @param {Record<string, any>} input 요청 옵션입니다.
 * @param {Record<string, any>} runtime 런타임 의존성입니다.
 * @returns {Record<string, any>} 호출 결과입니다.
 */
function requestDeepSeek(input, runtime) {
  const request = input || {}
  const apiKey = requireText(resolveApiKey('deepseek', request, runtime), 'DeepSeek apiKey')
  const baseUrl = request.baseUrl || DEFAULT_DEEPSEEK_BASE_URL
  const timeout = normalizePositiveNumber(request.timeoutSeconds, runtime.defaultTimeoutSeconds)
  const maxAttempts = normalizeAttempts(request.maxAttempts, runtime.defaultMaxAttempts)
  const payload = buildDeepSeekPayload(request)
  if (!payload.model) payload.model = resolveModel('deepseek', request, runtime)
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }

  return sendWithRetry(
    {
      provider: 'deepseek',
      maxAttempts,
      logMeta: request.logMeta || {},
      isRetryableResponse: isRetryableDeepSeekResponse,
      extractText: extractDeepSeekText,
      httpOptions: {
        url: `${baseUrl}/chat/completions`,
        method: 'POST',
        timeout,
        body: JSON.stringify(payload),
        headers,
      },
    },
    runtime
  )
}

/**
 * PocketPages/PocketBase JSVM용 AI 클라이언트를 만듭니다.
 * @param {Record<string, any>} [options] 클라이언트 옵션입니다.
 * @returns {Record<string, any>} AI 클라이언트입니다.
 */
function createAiClient(options) {
  const runtime = createRuntime(options || {})

  return {
    gemini(request) {
      return requestGemini(request, runtime)
    },
    openai(request) {
      return requestOpenAi(request, runtime)
    },
    deepseek(request) {
      return requestDeepSeek(request, runtime)
    },
    generate(request) {
      const provider = cleanText((request && request.provider) || runtime.defaultProvider).toLowerCase()
      if (provider === 'gemini') return requestGemini(request, runtime)
      if (provider === 'openai') return requestOpenAi(request, runtime)
      if (provider === 'deepseek') return requestDeepSeek(request, runtime)
      throw new Error('provider must be gemini, openai, or deepseek')
    },
  }
}

module.exports = {
  createAiClient,
}
