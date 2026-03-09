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

function resolveAnalyzeDT(resolve) {
  if (typeof resolve !== 'function') {
    return {}
  }

  return {
    createStaffDiaryAnalysisCacheDT: resolve('table/staff-diary-analysis-cache-dt'),
  }
}

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

function buildAnalyzeContext(api) {
  const baseContext = buildBaseContext(api)
  return {
    ...baseContext,
    dt: resolveAnalyzeDT(api && api.resolve),
  }
}

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
