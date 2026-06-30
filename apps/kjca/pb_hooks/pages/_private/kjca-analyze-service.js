const { globalApi } = require('pocketpages')
const { warn, info } = globalApi
const { createAiClient } = require('@pocketpages/ai')
const {
  CACHE_COLLECTION_NAME,
  GEMINI_MODEL_NAME,
  PROMPT_VERSION,
  GEMINI_MAX_ATTEMPTS,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  toAbsoluteKjcaUrl,
  isAllowedKjcaUrl,
  buildBrowserLikeHeaders,
  normalizeReportDate,
  buildDateMatchParams,
  toDateFieldIso,
  escapeFilterValue,
  hashText,
  extractDivInnerHtmlByClasses,
  parseRecruitingExtractFromDiaryHtml,
  parseJobStatusTableFromDiaryHtml,
  parseMiscSectionFromDiaryHtml,
  htmlToText,
  normalizeStringArray,
  normalizeJsonArrayField,
  normalizeTeamLeadRows,
  normalizeRecruitingExtract,
  normalizeCachedRecruitingField,
} = require('./kjca-core')
const kjcaAuth = require('./kjca-auth')
const { createKjcaSession } = kjcaAuth

/**
 * 분석 결과 1건을 화면/캐시 공용 shape로 정리합니다.
 * @param {Partial<types.KjcaAnalyzeResult> | null | undefined} resultInput 원본 분석 결과입니다.
 * @returns {types.KjcaAnalyzeResult} 정규화한 분석 결과입니다.
 */
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
    miscSection: resultInput.miscSection || null,
    recruiting: normalizeRecruitingExtract(resultInput.recruiting),
    printUrl: String(resultInput.printUrl || '').trim(),
  }
}

/**
 * recruiting 값 두 개를 병합하되 HTML 파싱 결과를 우선합니다.
 * @param {unknown} primaryRecruiting 우선 사용할 recruiting 값입니다.
 * @param {unknown} fallbackRecruiting 보완용 recruiting 값입니다.
 * @returns {types.KjcaRecruitingExtract} 병합한 recruiting 값입니다.
 */
function mergeRecruitingPreferHtml(primaryRecruiting, fallbackRecruiting) {
  const primary = normalizeRecruitingExtract(primaryRecruiting)
  const fallback = normalizeRecruitingExtract(fallbackRecruiting)

  return normalizeRecruitingExtract({
    monthTarget: primary.monthTarget !== null ? primary.monthTarget : fallback.monthTarget,
    monthAssignedCurrent: primary.monthAssignedCurrent !== null ? primary.monthAssignedCurrent : fallback.monthAssignedCurrent,
    weekTarget: primary.weekTarget !== null ? primary.weekTarget : fallback.weekTarget,
    jobStatusTable: primary.jobStatusTable || fallback.jobStatusTable,
    dailyPlan: primary.dailyPlan.length > 0 ? primary.dailyPlan : fallback.dailyPlan,
    dailyActualCount: primary.dailyActualCount !== null ? primary.dailyActualCount : fallback.dailyActualCount,
    weekTableRows: primary.weekTableRows.length > 0 ? primary.weekTableRows : fallback.weekTableRows,
  })
}

/**
 * 업무일지 분석용 Gemini 프롬프트를 만듭니다.
 * @param {{ dept?: unknown, staffName?: unknown, docText?: unknown }} promptInput 프롬프트 입력값입니다.
 * @returns {string} Gemini 프롬프트 문자열입니다.
 */
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

/**
 * 분석 캐시 식별 filter를 만듭니다.
 * @param {{ reportDate?: unknown, dept?: unknown, printUrl?: unknown, sourceHash?: unknown, promptVersion?: unknown }} cacheIdentityInput 캐시 식별 입력값입니다.
 * @returns {string} PocketBase filter 문자열입니다.
 */
function buildCacheIdentityFilter(cacheIdentityInput) {
  const reportDate = buildDateMatchParams(cacheIdentityInput.reportDate)
  return (
    `(reportDate = '${escapeFilterValue(reportDate.exact)}'` +
    ` || reportDate ~ '${escapeFilterValue(reportDate.like)}'` +
    ` || (reportDate >= '${escapeFilterValue(reportDate.startIso)}' && reportDate <= '${escapeFilterValue(reportDate.endIso)}'))` +
    ` && dept = '${escapeFilterValue(cacheIdentityInput.dept)}'` +
    ` && printUrl = '${escapeFilterValue(cacheIdentityInput.printUrl)}'` +
    ` && sourceHash = '${escapeFilterValue(cacheIdentityInput.sourceHash)}'` +
    ` && promptVersion = ${Number(cacheIdentityInput.promptVersion) || 1}`
  )
}

/**
 * 동일 본문 해시의 성공 캐시를 찾습니다.
 * @param {{ reportDate?: unknown, dept?: unknown, printUrl?: unknown, sourceHash?: unknown, promptVersion?: unknown }} cacheIdentityInput 캐시 식별 입력값입니다.
 * @returns {core.Record | null} 찾은 성공 캐시 record입니다.
 */
function findSuccessCache(cacheIdentityInput) {
  const filter = `${buildCacheIdentityFilter(cacheIdentityInput)} && status = 'success'`
  try {
    return $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, filter)
  } catch (_error) {
    return null
  }
}

/**
 * 분석 성공 결과를 캐시에 저장합니다.
 * @param {types.KjcaStaffDiaryAnalysisCacheRole | null | undefined} staffDiaryAnalysisCacheRole 저장 전 검증 role입니다.
 * @param {{ reportDate?: unknown, dept?: unknown, staffName?: unknown, printUrl?: unknown, sourceHash?: unknown, promotion?: unknown, vacation?: unknown, special?: unknown, recruiting?: unknown, promptVersion?: unknown }} cacheRecordInput 저장할 캐시 값입니다.
 */
function upsertSuccessCache(staffDiaryAnalysisCacheRole, cacheRecordInput) {
  const collection = $app.findCollectionByNameOrId(CACHE_COLLECTION_NAME)
  const lookupFilter = buildCacheIdentityFilter(cacheRecordInput)
  let record = null

  try {
    record = $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, lookupFilter)
  } catch (_error) {
    record = null
  }

  const targetRecord = record || new Record(collection)
  targetRecord.set('reportDate', toDateFieldIso(cacheRecordInput.reportDate))
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
  const targets = normalizeTeamLeadRows(payload && payload.targets)
  const reportDate = normalizeReportDate(payload && payload.reportDate)

  if (!targets.length) throw new Error('targets가 필요합니다.')
  if (targets.length > 50) throw new Error('targets는 최대 50개까지 지원합니다.')

  const ai = createAiClient({
    maxAttempts: GEMINI_MAX_ATTEMPTS,
  })

  info('kjca/analyze:start', {
    reportDate,
    targetsCount: targets.length,
  })

  const results = []
  let stoppedReason = ''
  let alertMessage = ''

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index] || { dept: '', position: '', staffName: '', printUrl: '' }
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
    const parsedRecruiting = parseRecruitingExtractFromDiaryHtml(docInnerHtml, reportDate)
    const parsedJobStatusTable = parseJobStatusTableFromDiaryHtml(docInnerHtml)
    const parsedMiscSection = parseMiscSectionFromDiaryHtml(docInnerHtml)
    const recruitingFromHtml = mergeRecruitingPreferHtml(parsedRecruiting || {}, parsedJobStatusTable ? { jobStatusTable: parsedJobStatusTable } : {})
    const miscSectionFromHtml = parsedMiscSection || null

    if (!docText) {
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: false,
          error: `본문 영역(doc_text)을 찾지 못했습니다. (HTTP ${detailResponse.statusCode})`,
          miscSection: miscSectionFromHtml,
          recruiting: recruitingFromHtml,
          printUrl,
        })
      )
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
      const cachedRecruiting = normalizeCachedRecruitingField(cachedRecord.get('recruiting'))
      results.push(
        buildAnalyzeResult({
          dept,
          position,
          staffName,
          ok: true,
          promotion: normalizeJsonArrayField(cachedRecord.get('promotion')),
          vacation: normalizeJsonArrayField(cachedRecord.get('vacation')),
          special: normalizeJsonArrayField(cachedRecord.get('special')),
          miscSection: miscSectionFromHtml,
          recruiting: mergeRecruitingPreferHtml(recruitingFromHtml, cachedRecruiting),
          printUrl,
        })
      )
      continue
    }

    const geminiResult = ai.gemini({
      model: GEMINI_MODEL_NAME,
      json: true,
      contents: [
        {
          role: 'user',
          parts: [{ text: buildPrompt({ dept, staffName, docText }) }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
    })

    if (!geminiResult.ok) {
      const statusCode = Number(geminiResult.statusCode || 0)
      const errorMessage = String(geminiResult.errorMessage || '').trim()
      const errorDetail = errorMessage ? ` ${errorMessage}` : ''
      const errorText = statusCode > 0 ? `AI 요청 실패 (HTTP ${statusCode})${errorDetail}` : `AI 요청 실패 (네트워크/타임아웃)${errorDetail}`
      results.push(buildAnalyzeResult({ dept, position, staffName, ok: false, error: errorText, miscSection: miscSectionFromHtml, recruiting: recruitingFromHtml, printUrl }))

      continue
    }

    const parsed = geminiResult.json && typeof geminiResult.json === 'object' && !Array.isArray(geminiResult.json) ? geminiResult.json : {}
    const promotion = normalizeStringArray(parsed && parsed.promotion)
    const vacation = normalizeStringArray(parsed && parsed.vacation)
    const special = normalizeStringArray(parsed && parsed.special)
    const recruiting = mergeRecruitingPreferHtml(recruitingFromHtml, parsed && parsed.recruiting)

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

    results.push(buildAnalyzeResult({ dept, position, staffName, ok: true, promotion, vacation, special, miscSection: miscSectionFromHtml, recruiting, printUrl }))
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
