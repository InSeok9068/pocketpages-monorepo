declare namespace types {
  type KjcaWeekday = "mon" | "tue" | "wed" | "thu" | "fri"

  type KjcaRecruitingExtract = {
    monthTarget: number | null
    monthAssignedCurrent: number | null
    weekTarget: number | null
    dailyPlan: Array<{
      weekday: KjcaWeekday
      channelName: string
      promotionContent: string
      targetCount: number | null
      ownerName: string
      note: string
    }>
    dailyActualCount: number | null
    weekTableRows: KjcaWeekTextRow[]
  }

  type KjcaTeamLeadRow = {
    dept: string
    position: string
    staffName: string
    printUrl: string
  }

  type KjcaWeekTextRow = {
    weekday: KjcaWeekday
    channelName: string
    weeklyPlan: string
    promotionContent: string
    targetText: string
    resultText: string
    recruitCountText: string
    ownerName: string
    note: string
    sortOrder?: number
  }

  type KjcaMergedWeekdayRow = {
    channelName: string
    weeklyPlan: string
    promotionContent: string
    targetText: string
    resultText: string
    recruitCountText: string
    ownerName: string
    note: string
  }

  type KjcaAnalyzeResult = {
    dept: string
    position: string
    staffName: string
    ok: boolean
    error: string
    promotion: string[]
    vacation: string[]
    special: string[]
    recruiting: KjcaRecruitingExtract
    printUrl: string
  }

  type KjcaSnapshotRow = {
    weekday: KjcaWeekday
    target: number
    actual: number
    gap: number
  }

  type KjcaDeptWeekTable = {
    dept: string
    todayWeekday: KjcaWeekday
    rows: KjcaWeekTextRow[]
  }

  type KjcaDeptSnapshot = {
    dept: string
    monthTarget: number | null
    weekTarget: number | null
    rows: KjcaSnapshotRow[]
    today: KjcaSnapshotRow
    cumulative: {
      target: number
      actual: number
      gap: number
    }
  }

  type KjcaAuthState = {
    authRecord: core.Record | null
    isSignedIn: boolean
    isSuperuser: boolean
    email: string
  }

  type KjcaFormState = {
    reportDate: string
    testOneOnly: boolean
  }

  type KjcaFormStateInput = {
    reportDate?: string | string[] | null | undefined
    testOneOnly?: boolean | string | string[] | null | undefined
  }

  type KjcaDeptSummaryParams = {
    dept?: unknown
    reportDate?: unknown
    analysisResults?: unknown
  }

  type KjcaRequestLike = {
    auth?: core.Record | null
  }

  type KjcaDashboardState = {
    reportDate: string
    testOneOnly: boolean
    noticeMessage: string
    errorMessage: string
    warnings: string[]
    stoppedReason: string
    isDiaryAccessible: boolean | null
    teamLeadRows: KjcaTeamLeadRow[]
    analysisResults: KjcaAnalyzeResult[]
    deptWeekTables: KjcaDeptWeekTable[]
    deptSnapshots: KjcaDeptSnapshot[]
  }

  type KjcaStaffDiaryAnalysisCacheRole = {
    canSaveSuccess: (record: core.Record) => boolean
  }

  type KjcaRecruitingWeekPlanRole = {
    canSaveConfirmed: (record: core.Record) => boolean
  }

  type KjcaRecruitingWeekPlanItemRole = {
    canSave: (record: core.Record) => boolean
    hasContent: (record: core.Record) => boolean
  }

  type KjcaRecruitingDailyResultRole = {
    canSaveAiResult: (record: core.Record) => boolean
  }

  type KjcaRecruitingWeekTextPlanRole = {
    canSaveConfirmed: (record: core.Record) => boolean
  }

  type KjcaRecruitingWeekTextRowRole = {
    canSave: (record: core.Record) => boolean
  }

  type KjcaCollectRoles = {
    staffDiaryAnalysisCacheRole?: KjcaStaffDiaryAnalysisCacheRole | null
    recruitingWeekPlanRole?: KjcaRecruitingWeekPlanRole | null
    recruitingWeekPlanItemRole?: KjcaRecruitingWeekPlanItemRole | null
    recruitingDailyResultRole?: KjcaRecruitingDailyResultRole | null
    recruitingWeekTextPlanRole?: KjcaRecruitingWeekTextPlanRole | null
    recruitingWeekTextRowRole?: KjcaRecruitingWeekTextRowRole | null
  }

  type KjcaSession = {
    host: string
    loginUrl: string
    staffAuthUrl: string
    cookieHeader: string
  }

  type KjcaProbeResult = {
    ok: true
    isDiaryAccessible: boolean
    teamLeadRows: KjcaTeamLeadRow[]
  }

  type KjcaProbePayload = {
    scDay?: unknown
    reportDate?: unknown
  }

  type KjcaAnalyzeCallResult = {
    ok: true
    results: KjcaAnalyzeResult[]
    stoppedReason: string
    alertMessage: string
  }

  type KjcaAnalyzePayload = {
    reportDate?: unknown
    targets?: unknown[]
  }

  type KjcaCollectResult = {
    ok: true
    isDiaryAccessible: boolean
    teamLeadRows: KjcaTeamLeadRow[]
    analysisResults: KjcaAnalyzeResult[]
    deptSnapshots: KjcaDeptSnapshot[]
    deptWeekTables: KjcaDeptWeekTable[]
    alertMessage: string
    stoppedReason: string
    warnings: string[]
  }

  type KjcaCollectPayload = {
    reportDate?: unknown
    testOneOnly?: unknown
  }

  type KjcaCacheClearResult = {
    ok: true
    reportDate: string
    dept: string
    deletedCount: number
  }

  type KjcaCacheClearPayload = {
    reportDate?: unknown
    dept?: unknown
  }
}
