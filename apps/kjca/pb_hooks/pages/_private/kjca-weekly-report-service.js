const { globalApi } = require('pocketpages')
const { info, dbg, warn } = globalApi
const { createKjcaSession } = require('./kjca-auth')
const {
  buildBrowserLikeHeaders,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  buildWeeklyReportSearchRangeFromReferenceWeek,
  parseWeeklyReportRowsFromListHtml,
  normalizeWeeklyReportRows,
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

module.exports = {
  WEEKLY_SEARCH_SOURCES,
  collectWeeklyReportUrls,
}
