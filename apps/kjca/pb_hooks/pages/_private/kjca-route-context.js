/**
 * 공통 요청 컨텍스트에서 서비스에 필요한 기본 속성만 추립니다.
 * @param {Record<string, any> | null | undefined} api PocketPages 요청 컨텍스트입니다.
 * @returns {{ request: any, dbg: any, info: any, warn: any, error: any }} 서비스 함수에서 재사용할 기본 컨텍스트입니다.
 */
function buildBaseContext(api) {
  const source = api && typeof api === 'object' ? api : {}

  return {
    request: source.request || null,
    dbg: source.dbg,
    info: source.info,
    warn: source.warn,
    error: source.error,
  }
}

/**
 * 분석용 서비스 컨텍스트에 필요한 DT 팩토리만 연결합니다.
 * @param {((path: string) => any) | null | undefined} resolve PocketPages `resolve()` 함수입니다.
 * @returns {{ createStaffDiaryAnalysisCacheDT?: Function }} 분석 단계에서 쓰는 DT 팩토리 묶음입니다.
 */
function resolveAnalyzeDT(resolve) {
  if (typeof resolve !== 'function') {
    return {}
  }

  return {
    createStaffDiaryAnalysisCacheDT: resolve('table/staff-diary-analysis-cache-dt'),
  }
}

/**
 * 주간 수집용 서비스 컨텍스트에 필요한 DT 팩토리를 연결합니다.
 * @param {((path: string) => any) | null | undefined} resolve PocketPages `resolve()` 함수입니다.
 * @returns {Record<string, Function>} 수집 단계에서 쓰는 DT 팩토리 묶음입니다.
 */
function resolveCollectDT(resolve) {
  if (typeof resolve !== 'function') {
    return {}
  }

  return {
    ...resolveAnalyzeDT(resolve),
    createRecruitingWeekPlanDT: resolve('table/recruiting-week-plan-dt'),
    createRecruitingWeekPlanItemDT: resolve('table/recruiting-week-plan-item-dt'),
    createRecruitingDailyResultDT: resolve('table/recruiting-daily-result-dt'),
    createRecruitingWeekTextPlanDT: resolve('table/recruiting-week-text-plan-dt'),
    createRecruitingWeekTextRowDT: resolve('table/recruiting-week-text-row-dt'),
  }
}

/**
 * 분석 API에서 바로 넘길 수 있는 서비스 컨텍스트를 만듭니다.
 * @param {Record<string, any> | null | undefined} api PocketPages 요청 컨텍스트입니다.
 * @returns {{ request: any, dbg: any, info: any, warn: any, error: any, dt: Record<string, Function> }} 분석용 서비스 컨텍스트입니다.
 */
function buildAnalyzeContext(api) {
  const baseContext = buildBaseContext(api)
  return {
    ...baseContext,
    dt: resolveAnalyzeDT(api && api.resolve),
  }
}

/**
 * 수집 API에서 바로 넘길 수 있는 서비스 컨텍스트를 만듭니다.
 * @param {Record<string, any> | null | undefined} api PocketPages 요청 컨텍스트입니다.
 * @returns {{ request: any, dbg: any, info: any, warn: any, error: any, dt: Record<string, Function> }} 수집용 서비스 컨텍스트입니다.
 */
function buildCollectContext(api) {
  const baseContext = buildBaseContext(api)
  return {
    ...baseContext,
    dt: resolveCollectDT(api && api.resolve),
  }
}

module.exports = {
  buildBaseContext,
  buildAnalyzeContext,
  buildCollectContext,
}
