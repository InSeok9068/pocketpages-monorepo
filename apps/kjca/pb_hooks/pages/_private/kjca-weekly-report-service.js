const { globalApi } = require('pocketpages')
const { info, dbg, warn } = globalApi
const { createKjcaSession } = require('./kjca-auth')
const {
  buildBrowserLikeHeaders,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  buildWeeklyReportSearchRangeFromReferenceWeek,
  parseWeeklyReportRowsFromListHtml,
  parseWeeklyReportDetailFromHtml,
  normalizeWeeklyReportRows,
  normalizeWeeklyReportDetails,
} = require('./kjca-core')

const WEEKLY_SEARCH_SOURCES = [
  {
    label: '종결 문서',
    mn: '1426',
    type2: 'to_al_done',
  },
  {
    label: '진행 문서',
    mn: '1425',
    type2: 'to_al_ing',
  },
]

/**
 * 주간 보고 목록 조회 URL을 만듭니다.
 * @param {string} host KJCA 호스트입니다.
 * @param {{ label?: string, mn: string, type2: string }} source 조회할 목록 출처입니다.
 * @param {{ weekStartDate: string, weekEndDate: string }} weekRange 조회할 날짜 범위입니다.
 * @returns {string} 목록 조회 URL입니다.
 */
function buildWeeklyReportSearchUrl(host, source, weekRange) {
  return (
    `${host}/appr/appr_doc/?site=groupware` +
    `&mn=${encodeURIComponent(source.mn)}` +
    '&type=lists' +
    `&type2=${encodeURIComponent(source.type2)}` +
    '&sc_sort=ad_status1_date' +
    '&sc_ord=desc' +
    '&sc_adg_name=' +
    `&sc_ad_status1_sdate=${encodeURIComponent(weekRange.weekStartDate)}` +
    `&sc_ad_status1_edate=${encodeURIComponent(weekRange.weekEndDate)}` +
    '&sc_sf_name=' +
    '&sc_al_status=' +
    `&sc_word=${encodeURIComponent('주간')}`
  )
}

/**
 * 목록 출처 1곳에서 주간 보고 행을 읽습니다.
 * @param {types.KjcaSession} session 재사용할 로그인 세션입니다.
 * @param {{ label?: string, mn: string, type2: string }} source 조회할 목록 출처입니다.
 * @param {{ weekStartDate: string, weekEndDate: string }} weekRange 조회할 날짜 범위입니다.
 * @returns {{ rows: types.KjcaWeeklyReportRow[], warningMessage: string }} 읽은 행 목록과 경고 메시지입니다.
 */
function fetchWeeklyReportRowsFromSource(session, source, weekRange) {
  const searchUrl = buildWeeklyReportSearchUrl(session.host, source, weekRange)
  const response = $http.send({
    url: searchUrl,
    method: 'GET',
    timeout: 20,
    headers: buildBrowserLikeHeaders(session.host, session.cookieHeader, searchUrl),
  })

  session.cookieHeader = mergeSetCookieIntoCookieHeader(session.cookieHeader, response.headers)

  const bodyText = String(toString(response.body) || '')
  if (detectAuthRequiredHtml(bodyText)) {
    throw new Error('KJCA 주간 보고 목록 접근에 실패했습니다. 다시 로그인 상태를 확인해주세요.')
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const warningMessage = `${source.label} 목록 조회에 실패했습니다. (${response.statusCode})`
    warn('kjca/weekly-report:list-failed', {
      mn: source.mn,
      type2: source.type2,
      statusCode: response.statusCode,
    })
    return {
      rows: [],
      warningMessage,
    }
  }

  const parsed = parseWeeklyReportRowsFromListHtml(bodyText, session.host, source)

  info('kjca/weekly-report:list', {
    mn: source.mn,
    type2: source.type2,
    weekStartDate: weekRange.weekStartDate,
    weekEndDate: weekRange.weekEndDate,
    rowCount: parsed.rows.length,
  })

  return {
    rows: parsed.rows,
    warningMessage: '',
  }
}

/**
 * 주간 보고 상세 실패 결과 1건을 만듭니다.
 * @param {types.KjcaWeeklyReportRow | null | undefined} row 실패한 문서 행입니다.
 * @param {unknown} errorMessage 실패 메시지 값입니다.
 * @returns {types.KjcaWeeklyReportDetail} 실패 상태를 담은 상세 결과입니다.
 */
function buildWeeklyReportDetailError(row, errorMessage) {
  const normalizedRow = normalizeWeeklyReportRows([row])[0]
  const safeRow = normalizedRow && typeof normalizedRow === 'object' ? normalizedRow : {}
  return {
    sourceLabel: String(safeRow.sourceLabel || '').trim(),
    sourceMenu: String(safeRow.sourceMenu || '').trim(),
    sourceType: String(safeRow.sourceType || '').trim(),
    docNo: String(safeRow.docNo || '').trim(),
    formName: String(safeRow.formName || '').trim(),
    title: String(safeRow.title || '').trim(),
    dept: String(safeRow.dept || '').trim(),
    drafter: String(safeRow.drafter || '').trim(),
    draftDate: String(safeRow.draftDate || '').trim(),
    status: String(safeRow.status || '').trim(),
    viewUrl: String(safeRow.viewUrl || '').trim(),
    ok: false,
    error: String(errorMessage || '').trim(),
    operationsTables: [],
    workTables: [],
    peopleTables: [],
  }
}

/**
 * 주간 보고 본문 HTML을 가져옵니다.
 * @param {types.KjcaSession} session 재사용할 로그인 세션입니다.
 * @param {types.KjcaWeeklyReportRow | null | undefined} reportRow 조회할 문서 행입니다.
 * @returns {string} 주간 보고 상세 HTML입니다.
 */
function fetchWeeklyReportDocumentHtml(session, reportRow) {
  const viewUrl = String((reportRow && reportRow.viewUrl) || '').trim()
  if (!viewUrl) throw new Error('주간 보고 URL이 비어 있습니다.')

  const response = $http.send({
    url: viewUrl,
    method: 'GET',
    timeout: 20,
    headers: buildBrowserLikeHeaders(session.host, session.cookieHeader, viewUrl),
  })

  session.cookieHeader = mergeSetCookieIntoCookieHeader(session.cookieHeader, response.headers)

  const bodyText = String(toString(response.body) || '')
  if (detectAuthRequiredHtml(bodyText)) {
    throw new Error('KJCA 주간 보고 상세 접근에 실패했습니다. 다시 로그인 상태를 확인해주세요.')
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`주간 보고 상세 조회에 실패했습니다. (${response.statusCode})`)
  }

  return bodyText
}

/**
 * 주간 업무 보고 목록에서 문서 URL만 먼저 수집합니다.
 * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
 * @param {types.KjcaWeeklyReportUrlPayload | null | undefined} payload 조회할 주차 입력값입니다.
 * @param {types.KjcaSession | null | undefined} [session] 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
 * @returns {types.KjcaWeeklyReportUrlResult} 주간 보고 문서 URL 목록과 조회 범위입니다.
 */
function collectWeeklyReportUrls(request, payload, session = null) {
  const safeSession = session || createKjcaSession(request)
  const weekRange = buildWeeklyReportSearchRangeFromReferenceWeek(payload && payload.referenceWeek)
  const warnings = []
  let rows = []

  dbg('kjca/weekly-report:start', {
    referenceWeek: weekRange.referenceWeek,
    weekStartDate: weekRange.weekStartDate,
    weekEndDate: weekRange.weekEndDate,
  })

  WEEKLY_SEARCH_SOURCES.forEach((source) => {
    const result = fetchWeeklyReportRowsFromSource(safeSession, source, weekRange)
    rows = rows.concat(result.rows)
    if (result.warningMessage) warnings.push(result.warningMessage)
  })

  rows = normalizeWeeklyReportRows(rows)

  info('kjca/weekly-report:done', {
    referenceWeek: weekRange.referenceWeek,
    rowCount: rows.length,
    warningCount: warnings.length,
  })

  return {
    ok: true,
    referenceWeek: weekRange.referenceWeek,
    weekStartDate: weekRange.weekStartDate,
    weekEndDate: weekRange.weekEndDate,
    rows,
    warnings,
    alertMessage: rows.length > 0 ? `주간 보고 URL ${rows.length}건을 확인했습니다.` : '선택한 주차에 해당하는 주간 보고 URL을 찾지 못했습니다.',
  }
}

/**
 * 주간 업무 보고 문서 URL 목록을 실제 본문까지 수집해 표 단위로 정리합니다.
 * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
 * @param {types.KjcaWeeklyReportDetailPayload | null | undefined} payload 조회할 주차와 대상 URL 목록입니다.
 * @param {types.KjcaSession | null | undefined} [session] 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
 * @returns {types.KjcaWeeklyReportDetailResult} 주간 보고 상세 표 목록입니다.
 */
function collectWeeklyReportDetails(request, payload, session = null) {
  const safeSession = session || createKjcaSession(request)
  const weekRange = buildWeeklyReportSearchRangeFromReferenceWeek(payload && payload.referenceWeek)
  const rows = normalizeWeeklyReportRows(payload && payload.rows)
  if (rows.length === 0) {
    throw new Error('주간 보고 문서 목록이 없습니다.')
  }

  const warnings = []
  const details = []

  dbg('kjca/weekly-report-details:start', {
    referenceWeek: weekRange.referenceWeek,
    rowCount: rows.length,
  })

  rows.forEach((row) => {
    try {
      const documentHtml = fetchWeeklyReportDocumentHtml(safeSession, row)
      details.push(parseWeeklyReportDetailFromHtml(row, documentHtml))
    } catch (error) {
      const errorMessage = String(error && error.message ? error.message : error)
      warnings.push(`${String(row.dept || row.title || row.viewUrl || '-').trim()}: ${errorMessage}`)
      details.push(buildWeeklyReportDetailError(row, errorMessage))
    }
  })

  const normalizedDetails = normalizeWeeklyReportDetails(details)
  const successCount = normalizedDetails.filter((item) => item.ok).length

  info('kjca/weekly-report-details:done', {
    referenceWeek: weekRange.referenceWeek,
    rowCount: rows.length,
    successCount,
    warningCount: warnings.length,
  })

  return {
    ok: true,
    referenceWeek: weekRange.referenceWeek,
    weekStartDate: weekRange.weekStartDate,
    weekEndDate: weekRange.weekEndDate,
    rows,
    details: normalizedDetails,
    warnings,
    alertMessage: normalizedDetails.length > 0 ? `주간 보고 본문 ${successCount}건을 취합했습니다.` : '선택한 주간 보고 본문을 취합하지 못했습니다.',
  }
}

/**
 * 기준 주차의 주간 보고를 URL 조회부터 본문 취합까지 한 번에 실행합니다.
 * @param {types.KjcaRequestLike | null | undefined} request PocketPages 요청 객체입니다.
 * @param {types.KjcaWeeklyReportUrlPayload | null | undefined} payload 조회할 주차 입력값입니다.
 * @param {types.KjcaSession | null | undefined} [session] 이미 만든 세션이 있으면 재사용할 세션 정보입니다.
 * @returns {types.KjcaWeeklyReportDetailResult} 주간 보고 본문 취합 결과입니다.
 */
function collectWeeklyReports(request, payload, session = null) {
  const safeSession = session || createKjcaSession(request)
  const urlResult = collectWeeklyReportUrls(request, payload, safeSession)

  if (!Array.isArray(urlResult.rows) || urlResult.rows.length === 0) {
    return {
      ok: true,
      referenceWeek: urlResult.referenceWeek,
      weekStartDate: urlResult.weekStartDate,
      weekEndDate: urlResult.weekEndDate,
      rows: [],
      details: [],
      warnings: Array.isArray(urlResult.warnings) ? urlResult.warnings : [],
      alertMessage: String(urlResult.alertMessage || '').trim(),
    }
  }

  const detailResult = collectWeeklyReportDetails(
    request,
    {
      referenceWeek: urlResult.referenceWeek,
      rows: urlResult.rows,
    },
    safeSession
  )

  return Object.assign({}, detailResult, {
    warnings: [].concat(Array.isArray(urlResult.warnings) ? urlResult.warnings : []).concat(Array.isArray(detailResult.warnings) ? detailResult.warnings : []),
  })
}

module.exports = {
  WEEKLY_SEARCH_SOURCES,
  collectWeeklyReportUrls,
  collectWeeklyReportDetails,
  collectWeeklyReports,
}
