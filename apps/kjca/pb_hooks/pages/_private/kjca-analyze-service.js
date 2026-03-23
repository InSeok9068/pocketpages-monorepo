const { globalApi } = require('pocketpages')
const { env, warn, info } = globalApi
const {
  CACHE_COLLECTION_NAME,
  GEMINI_MODEL_NAME,
  PROMPT_VERSION,
  GEMINI_MAX_ATTEMPTS,
  parseJsonSafely,
  extractJsonObjectText,
  getHeaderValues,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  toAbsoluteKjcaUrl,
  isAllowedKjcaUrl,
  buildBrowserLikeHeaders,
  normalizeReportDate,
  escapeFilterValue,
  hashText,
  extractDivInnerHtmlByClasses,
  htmlToText,
  normalizeStringArray,
  normalizeJsonArrayField,
  inferGemini429Cause,
  stringifyGeminiErrorDetails,
  normalizeRecruitingExtract,
  normalizeCachedRecruitingField,
} = require('./kjca-core')
const kjcaAuth = require('./kjca-auth')
const { createKjcaSession } = kjcaAuth

function parseRetryAfterMs(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.trunc(parsed * 1000)
}

function computeRetryDelayMs(attempt, retryAfterHeader) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader)
  if (retryAfterMs > 0) return retryAfterMs
  const step = Math.max(0, Number(attempt) - 1)
  const backoffMs = 1500 * 2 ** step
  const jitterMs = Math.trunc(Math.random() * 400)
  return backoffMs + jitterMs
}

function isRetryableGeminiHttp(statusCode, rateLimitCauseGuess) {
  if (statusCode === 429 && rateLimitCauseGuess === 'quota-or-billing-limit') return false
  return statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504
}

function isRetryableGeminiTransportError(errorText) {
  const text = String(errorText || '').toLowerCase()
  if (!text) return false
  return (
    text.includes('timeout') ||
    text.includes('deadline') ||
    text.includes('temporarily unavailable') ||
    text.includes('connection reset') ||
    text.includes('connection refused') ||
    text.includes('eof')
  )
}

function requestGeminiWithRetry(geminiPayload, context) {
  let lastStatusCode = 0
  let lastResponseBody = ''
  let lastHeaders = {}
  let lastTransportError = ''
  let attempts = 0

  while (attempts < GEMINI_MAX_ATTEMPTS) {
    attempts += 1
    const attemptStartedAt = Date.now()

    try {
      const response = $http.send({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${context.geminiApiKey}`,
        method: 'POST',
        timeout: 60,
        body: JSON.stringify(geminiPayload),
        headers: {
          'content-type': 'application/json',
        },
      })

      const elapsedMs = Date.now() - attemptStartedAt
      const statusCode = Number(response.statusCode || 0)
      const responseBody = toString(response.body)
      const headers = response.headers || {}
      const retryAfter = getHeaderValues(headers, 'Retry-After')[0] || ''
      const parsedErrorBody = parseJsonSafely(responseBody, {})
      const geminiError = parsedErrorBody && parsedErrorBody.error ? parsedErrorBody.error : {}
      const geminiErrorMessage = String(geminiError.message || '').trim()
      const geminiErrorDetailsText = stringifyGeminiErrorDetails(geminiError.details)
      const rateLimitCauseGuess = statusCode === 429 ? inferGemini429Cause(geminiErrorMessage, geminiErrorDetailsText) : ''

      lastStatusCode = statusCode
      lastResponseBody = responseBody
      lastHeaders = headers
      lastTransportError = ''

      if (statusCode >= 200 && statusCode < 300) {
        return { statusCode, responseBody, headers, attempts, elapsedMs, transportError: '' }
      }

      const canRetry = attempts < GEMINI_MAX_ATTEMPTS && isRetryableGeminiHttp(statusCode, rateLimitCauseGuess)
      if (!canRetry) {
        return { statusCode, responseBody, headers, attempts, elapsedMs, transportError: '' }
      }

      const delayMs = computeRetryDelayMs(attempts, retryAfter)
      warn('kjca/analyze:gemini-retry', {
        index: context.index,
        dept: context.dept,
        attempt: attempts,
        statusCode,
        delayMs,
      })
      sleep(delayMs)
    } catch (error) {
      const elapsedMs = Date.now() - attemptStartedAt
      const errorText = String(error || '').trim()
      lastStatusCode = 0
      lastResponseBody = ''
      lastHeaders = {}
      lastTransportError = errorText

      const canRetry = attempts < GEMINI_MAX_ATTEMPTS && isRetryableGeminiTransportError(errorText)
      if (!canRetry) {
        return { statusCode: 0, responseBody: '', headers: {}, attempts, elapsedMs, transportError: errorText }
      }

      const delayMs = computeRetryDelayMs(attempts)
      warn('kjca/analyze:gemini-retry-transport', {
        index: context.index,
        dept: context.dept,
        attempt: attempts,
        error: errorText,
        delayMs,
      })
      sleep(delayMs)
    }
  }

  return {
    statusCode: lastStatusCode,
    responseBody: lastResponseBody,
    headers: lastHeaders,
    attempts,
    elapsedMs: 0,
    transportError: lastTransportError,
  }
}

function buildAnalyzeResult(resultInput) {
  return {
    dept: String(resultInput.dept || '').trim(),
    position: String(resultInput.position || '').trim(),
    staffName: String(resultInput.staffName || '').trim(),
    ok: resultInput.ok !== false,
    error: String(resultInput.error || '').trim(),
    promotion: normalizeStringArray(resultInput.promotion),
    vacation: normalizeStringArray(resultInput.vacation),
    special: normalizeStringArray(resultInput.special),
    recruiting: normalizeRecruitingExtract(resultInput.recruiting),
    printUrl: String(resultInput.printUrl || '').trim(),
  }
}

function buildPrompt(promptInput) {
  return (
    '아래는 업무일지 본문 텍스트야. 부서별로 "모집/홍보", "휴가", "특이사항"을 최대한 빠짐없이 추출해.\n' +
    '"모집"과 "홍보"는 같은 범주로 보고 모두 promotion 배열에 넣어.\n' +
    '추가로 모집/현황 비교에 필요한 구조화 정보(recruiting)도 함께 추출해.\n' +
    'recruiting.dailyPlan은 요일별 계획표(월~금)를 읽어 배열로 만들어.\n' +
    'recruiting.dailyActualCount는 당일 모집 실적(예: 모집 1명)을 숫자로 넣어.\n' +
    'recruiting.weekTableRows에는 "요일, 주간 홍보계획, 결과, 담당자, 비고, 모집홍보처, 모집 홍보내용, 모집목표, 모집 건수"를 텍스트로 최대한 보존해.\n' +
    '값이 없거나 판단 불가면 반드시 null을 넣어.\n' +
    '반드시 코드펜스 없이 JSON 객체만 반환해.\n' +
    '추출할 내용이 없으면 해당 배열은 빈 배열([])로 반환.\n' +
    '\n' +
    '응답 스키마:\n' +
    '{\n' +
    '  "promotion": ["string"],\n' +
    '  "vacation": ["string"],\n' +
    '  "special": ["string"],\n' +
    '  "recruiting": {\n' +
    '    "monthTarget": number | null,\n' +
    '    "monthAssignedCurrent": number | null,\n' +
    '    "weekTarget": number | null,\n' +
    '    "dailyPlan": [\n' +
    '      {\n' +
    '        "weekday": "mon" | "tue" | "wed" | "thu" | "fri",\n' +
    '        "channelName": "string",\n' +
    '        "promotionContent": "string",\n' +
    '        "targetCount": number | null,\n' +
    '        "ownerName": "string",\n' +
    '        "note": "string"\n' +
    '      }\n' +
    '    ],\n' +
    '    "dailyActualCount": number | null,\n' +
    '    "weekTableRows": [\n' +
    '      {\n' +
    '        "weekday": "mon" | "tue" | "wed" | "thu" | "fri",\n' +
    '        "channelName": "string",\n' +
    '        "weeklyPlan": "string",\n' +
    '        "promotionContent": "string",\n' +
    '        "targetText": "string",\n' +
    '        "resultText": "string",\n' +
    '        "recruitCountText": "string",\n' +
    '        "ownerName": "string",\n' +
    '        "note": "string"\n' +
    '      }\n' +
    '    ]\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    `부서: ${promptInput.dept}\n` +
    (promptInput.staffName ? `성명: ${promptInput.staffName}\n` : '') +
    '\n' +
    '본문:\n' +
    promptInput.docText
  )
}

function buildCacheIdentityFilter(cacheIdentityInput) {
  const reportDateExact = String(cacheIdentityInput.reportDate || '').trim()
  const reportDateLike = `${reportDateExact}%`
  return (
    `(reportDate = '${escapeFilterValue(reportDateExact)}' || reportDate ~ '${escapeFilterValue(reportDateLike)}')` +
    ` && dept = '${escapeFilterValue(cacheIdentityInput.dept)}'` +
    ` && printUrl = '${escapeFilterValue(cacheIdentityInput.printUrl)}'` +
    ` && sourceHash = '${escapeFilterValue(cacheIdentityInput.sourceHash)}'` +
    ` && promptVersion = ${Number(cacheIdentityInput.promptVersion) || 1}`
  )
}

function findSuccessCache(cacheIdentityInput) {
  const filter = `${buildCacheIdentityFilter(cacheIdentityInput)} && status = 'success'`
  try {
    return $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, filter)
  } catch (error) {
    return null
  }
}

function upsertSuccessCache(staffDiaryAnalysisCacheRole, cacheRecordInput) {
  const collection = $app.findCollectionByNameOrId(CACHE_COLLECTION_NAME)
  const lookupFilter = buildCacheIdentityFilter(cacheRecordInput)
  let record = null

  try {
    record = $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, lookupFilter)
  } catch (error) {
    record = null
  }

  const targetRecord = record || new Record(collection)
  targetRecord.set('reportDate', cacheRecordInput.reportDate)
  targetRecord.set('dept', cacheRecordInput.dept)
  targetRecord.set('staffName', cacheRecordInput.staffName)
  targetRecord.set('printUrl', cacheRecordInput.printUrl)
  targetRecord.set('sourceHash', cacheRecordInput.sourceHash)
  targetRecord.set('promotion', cacheRecordInput.promotion || [])
  targetRecord.set('vacation', cacheRecordInput.vacation || [])
  targetRecord.set('special', cacheRecordInput.special || [])
  targetRecord.set('recruiting', cacheRecordInput.recruiting || {})
  targetRecord.set('status', 'success')
  targetRecord.set('errorMessage', '')
  targetRecord.set('model', GEMINI_MODEL_NAME)
  targetRecord.set('promptVersion', cacheRecordInput.promptVersion)

  if (staffDiaryAnalysisCacheRole && typeof staffDiaryAnalysisCacheRole.canSaveSuccess === 'function') {
    if (!staffDiaryAnalysisCacheRole.canSaveSuccess(targetRecord)) {
      warn('kjca/analyze:cache-skip', {
        dept: cacheRecordInput.dept,
        reportDate: cacheRecordInput.reportDate,
      })
      return
    }
  }

  $app.save(targetRecord)
}

/**
 * 팀장 업무일지 본문을 읽어 AI 분석 결과 목록으로 변환합니다.
 * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
 * @param {types.KjcaStaffDiaryAnalysisCacheRole | null | undefined} staffDiaryAnalysisCacheRole 분석 성공 캐시 저장 전에 확인할 role입니다.
 * @param {types.KjcaAnalyzePayload | null | undefined} payload 분석 날짜와 대상 목록을 담은 입력값입니다.
 * @param {types.KjcaSession | null | undefined} [session] 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
 * @returns {types.KjcaAnalyzeCallResult} 분석 결과 목록과 중단 사유를 담은 결과입니다.
 */
function analyzeStaffDiary(request, staffDiaryAnalysisCacheRole, payload, session = null) {
  const safeSession = session || createKjcaSession(request)
  const targets = Array.isArray(payload && payload.targets) ? payload.targets : []
  const reportDate = normalizeReportDate(payload && payload.reportDate)
  const geminiApiKey = String(env('GEMINI_API_KEY') || env('GEMINI_AI_KEY') || '').trim()

  if (!targets.length) throw new Error('targets가 필요합니다.')
  if (targets.length > 50) throw new Error('targets는 최대 50개까지 지원합니다.')
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY (또는 GEMINI_AI_KEY)가 설정되지 않았습니다.')

  info('kjca/analyze:start', {
    reportDate,
    targetsCount: targets.length,
  })

  const results = []
  let stoppedReason = ''
  let alertMessage = ''

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index] || {}
    const dept = String(target.dept || '').trim()
    const position = String(target.position || '').trim()
    const staffName = String(target.staffName || '').trim()
    const printUrl = toAbsoluteKjcaUrl(safeSession.host, String(target.printUrl || '').trim())

    if (!dept || !printUrl) {
      warn('kjca/analyze:target-skip-missing', { index, dept })
      continue
    }
    if (!isAllowedKjcaUrl(safeSession.host, printUrl)) {
      warn('kjca/analyze:target-skip-url', { index, dept, printUrl })
      continue
    }

    const detailResponse = $http.send({
      url: printUrl,
      method: 'GET',
      timeout: 20,
      headers: buildBrowserLikeHeaders(safeSession.host, safeSession.cookieHeader, printUrl),
    })
    safeSession.cookieHeader = mergeSetCookieIntoCookieHeader(safeSession.cookieHeader, detailResponse.headers)

    const detailHtml = toString(detailResponse.body)
    if (detailResponse.statusCode < 200 || detailResponse.statusCode >= 300) {
      results.push(buildAnalyzeResult({ dept, position, staffName, ok: false, error: `원본 페이지 조회 실패 (HTTP ${detailResponse.statusCode})`, printUrl }))
      continue
    }

    if (detectAuthRequiredHtml(detailHtml)) {
      results.push(buildAnalyzeResult({ dept, position, staffName, ok: false, error: '로그인이 필요합니다.', printUrl }))
      continue
    }

    const docInnerHtml = extractDivInnerHtmlByClasses(detailHtml, ['doc_text', 'editor']) || extractDivInnerHtmlByClasses(detailHtml, ['doc_text'])
    const docText = htmlToText(docInnerHtml)
    const sourceHash = hashText(docText)

    if (!docText) {
      results.push(buildAnalyzeResult({ dept, position, staffName, ok: false, error: `본문 영역(doc_text)을 찾지 못했습니다. (HTTP ${detailResponse.statusCode})`, printUrl }))
      continue
    }

    const cachedRecord = findSuccessCache({
      reportDate,
      dept,
      printUrl,
      sourceHash,
      promptVersion: PROMPT_VERSION,
    })

    if (cachedRecord) {
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: true,
          promotion: normalizeJsonArrayField(cachedRecord.get('promotion')),
          vacation: normalizeJsonArrayField(cachedRecord.get('vacation')),
          special: normalizeJsonArrayField(cachedRecord.get('special')),
          recruiting: normalizeCachedRecruitingField(cachedRecord.get('recruiting')),
          printUrl,
        })
      )
      continue
    }

    const geminiAttemptResult = requestGeminiWithRetry(
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: buildPrompt({ dept, staffName, docText }) }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      },
      { index, dept, geminiApiKey }
    )

    const responseBody = String(geminiAttemptResult.responseBody || '')
    const geminiStatusCode = Number(geminiAttemptResult.statusCode || 0)
    const parsedErrorBody = parseJsonSafely(responseBody, {})
    const geminiError = parsedErrorBody && parsedErrorBody.error ? parsedErrorBody.error : {}
    const geminiErrorMessage = String(geminiError.message || '').trim()
    const geminiErrorDetailsText = stringifyGeminiErrorDetails(geminiError.details)
    const rateLimitCauseGuess = geminiStatusCode === 429 ? inferGemini429Cause(geminiErrorMessage, geminiErrorDetailsText) : ''

    if (!(geminiStatusCode >= 200 && geminiStatusCode < 300)) {
      const errorText = geminiStatusCode > 0 ? `AI 요청 실패 (HTTP ${geminiStatusCode})` : `AI 요청 실패 (네트워크/타임아웃) ${String(geminiAttemptResult.transportError || '').trim()}`
      results.push(buildAnalyzeResult({ dept, position, staffName, ok: false, error: errorText, printUrl }))

      if (rateLimitCauseGuess === 'quota-or-billing-limit') {
        stoppedReason = 'quota-exceeded'
        alertMessage = 'Gemini 무료 쿼터가 소진되어 분석을 중단했습니다. 잠시 후 다시 시도하거나 과금/플랜을 확인해주세요.'
        break
      }

      continue
    }

    const geminiPayloadJson = parseJsonSafely(responseBody, {})
    const geminiText =
      geminiPayloadJson &&
      geminiPayloadJson.candidates &&
      geminiPayloadJson.candidates[0] &&
      geminiPayloadJson.candidates[0].content &&
      geminiPayloadJson.candidates[0].content.parts &&
      geminiPayloadJson.candidates[0].content.parts[0]
        ? geminiPayloadJson.candidates[0].content.parts[0].text || ''
        : ''
    const parsed = parseJsonSafely(extractJsonObjectText(geminiText), {})
    const promotion = normalizeStringArray(parsed && parsed.promotion)
    const vacation = normalizeStringArray(parsed && parsed.vacation)
    const special = normalizeStringArray(parsed && parsed.special)
    const recruiting = normalizeRecruitingExtract(parsed && parsed.recruiting)

    upsertSuccessCache(staffDiaryAnalysisCacheRole, {
      reportDate,
      dept,
      staffName,
      printUrl,
      sourceHash,
      promptVersion: PROMPT_VERSION,
      promotion,
      vacation,
      special,
      recruiting,
    })

    results.push(buildAnalyzeResult({ dept, position, staffName, ok: true, promotion, vacation, special, recruiting, printUrl }))
  }

  return {
    ok: true,
    results,
    stoppedReason,
    alertMessage,
  }
}

module.exports = {
  analyzeStaffDiary,
}
