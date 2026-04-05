import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))

globalThis.__hooks = path.resolve(testDir, '../pb_hooks')

const collectServicePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-collect-service.js')
const authModulePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-auth.js')
const analyzeModulePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-analyze-service.js')

class MockRecord {
  constructor(collection) {
    this.collection = collection
    this.id = ''
    this.data = {}
  }

  set(key, value) {
    this.data[key] = value
  }

  get(key) {
    return this.data[key]
  }
}

function createAppMock() {
  const store = {
    staff_diary_analysis_cache: [],
    recruiting_week_plans: [],
    recruiting_week_plan_items: [],
    recruiting_week_text_plans: [],
    recruiting_week_text_rows: [],
    recruiting_daily_results: [],
  }

  let idCounter = 1

  function ensureId(record) {
    if (!record.id) {
      record.id = `rec-${idCounter}`
      idCounter += 1
    }
  }

  function normalizeDateText(value) {
    return String(value || '').trim().slice(0, 10)
  }

  function findByDateAndDept(rows, dateField, params) {
    const exact = normalizeDateText(params && params.exact)
    const dept = String((params && params.dept) || '').trim()
    return rows.find((row) => normalizeDateText(row.get(dateField)) === exact && String(row.get('dept') || '').trim() === dept) || null
  }

  return {
    findCollectionByNameOrId(name) {
      return { id: name, name }
    },
    findFirstRecordByFilter(collectionName, filter, params) {
      if (collectionName === 'recruiting_week_plans') {
        return findByDateAndDept(store.recruiting_week_plans, 'weekStartDate', params)
      }
      if (collectionName === 'recruiting_week_text_plans') {
        return findByDateAndDept(store.recruiting_week_text_plans, 'weekStartDate', params)
      }
      if (collectionName === 'recruiting_daily_results') {
        return findByDateAndDept(store.recruiting_daily_results, 'reportDate', params)
      }
      throw new Error(`Unexpected findFirstRecordByFilter collection: ${collectionName}`)
    },
    findRecordsByFilter(collectionName, filter, sort, limit, offset, params) {
      if (collectionName === 'staff_diary_analysis_cache') {
        const exact = normalizeDateText(String(filter.match(/reportDate = '([^']+)'/)?.[1] || ''))
        const dept = String(filter.match(/dept = '([^']+)'/)?.[1] || '').trim()
        return store.staff_diary_analysis_cache.filter(
          (row) => normalizeDateText(row.get('reportDate')) === exact && String(row.get('dept') || '').trim() === dept
        )
      }
      if (collectionName === 'recruiting_week_plan_items') {
        return store.recruiting_week_plan_items.filter((row) => row.get('planId') === params.planId)
      }
      if (collectionName === 'recruiting_week_text_rows') {
        return store.recruiting_week_text_rows.filter((row) => row.get('planId') === params.planId)
      }
      if (collectionName === 'recruiting_daily_results') {
        const exact = normalizeDateText(params && params.exact)
        const dept = String((params && params.dept) || '').trim()
        return store.recruiting_daily_results.filter(
          (row) => normalizeDateText(row.get('weekStartDate')) === exact && String(row.get('dept') || '').trim() === dept
        )
      }
      throw new Error(`Unexpected findRecordsByFilter collection: ${collectionName}`)
    },
    save(record) {
      ensureId(record)
      const collectionName = record.collection.name
      const rows = store[collectionName]
      if (!rows) throw new Error(`Unexpected save collection: ${collectionName}`)
      const existingIndex = rows.findIndex((item) => item.id === record.id)
      if (existingIndex === -1) {
        rows.push(record)
        return
      }
      rows[existingIndex] = record
    },
    delete(record) {
      const collectionName = record.collection.name
      const rows = store[collectionName]
      if (!rows) throw new Error(`Unexpected delete collection: ${collectionName}`)
      const nextRows = rows.filter((item) => item.id !== record.id)
      store[collectionName] = nextRows
    },
    __store: store,
  }
}

function createSavedRecord(appMock, collectionName, values) {
  const record = new MockRecord({ id: collectionName, name: collectionName })
  Object.entries(values || {}).forEach(([key, value]) => {
    record.set(key, value)
  })
  appMock.save(record)
  return record
}

function buildWeekRows() {
  return [
    {
      weekday: 'mon',
      channelName: 'A 채널',
      weeklyPlan: '',
      promotionContent: '월요일 홍보',
      targetText: '1',
      resultText: '',
      recruitCountText: '',
      ownerName: '김팀장',
      note: '',
    },
    {
      weekday: 'tue',
      channelName: 'B 채널',
      weeklyPlan: '',
      promotionContent: '화요일 홍보',
      targetText: '1',
      resultText: '',
      recruitCountText: '',
      ownerName: '김팀장',
      note: '',
    },
    {
      weekday: 'wed',
      channelName: 'C 채널',
      weeklyPlan: '',
      promotionContent: '수요일 홍보',
      targetText: '1',
      resultText: '',
      recruitCountText: '',
      ownerName: '김팀장',
      note: '',
    },
    {
      weekday: 'thu',
      channelName: 'D 채널',
      weeklyPlan: '',
      promotionContent: '목요일 홍보',
      targetText: '1',
      resultText: '',
      recruitCountText: '',
      ownerName: '김팀장',
      note: '',
    },
    {
      weekday: 'fri',
      channelName: 'E 채널',
      weeklyPlan: '',
      promotionContent: '금요일 홍보',
      targetText: '1',
      resultText: '',
      recruitCountText: '2',
      ownerName: '김팀장',
      note: '',
    },
  ]
}

test('collectWeekly saves and returns dept week table rows after module split', () => {
  const originalAuthCache = require.cache[authModulePath]
  const originalAnalyzeCache = require.cache[analyzeModulePath]
  const originalCollectCache = require.cache[collectServicePath]
  const originalApp = globalThis.$app
  const originalRecord = globalThis.Record
  const originalSleep = globalThis.sleep

  const appMock = createAppMock()

  try {
    require.cache[authModulePath] = {
      id: authModulePath,
      filename: authModulePath,
      loaded: true,
      exports: {
        ensureSuperuserRequest() {},
        createKjcaSession() {
          return {
            host: 'http://www.kjca.co.kr',
            cookieHeader: '',
          }
        },
        probeStaffAuth() {
          return {
            isDiaryAccessible: true,
            teamLeadRows: [
              {
                dept: '입학팀',
                position: '팀장',
                staffName: '김팀장',
                printUrl: 'http://www.kjca.co.kr/diary/?site=groupware&bd_idx=1',
              },
            ],
          }
        },
      },
    }

    require.cache[analyzeModulePath] = {
      id: analyzeModulePath,
      filename: analyzeModulePath,
      loaded: true,
      exports: {
        analyzeStaffDiary(request, role, payload) {
          return {
            ok: true,
            results: [
              {
                dept: '입학팀',
                position: '팀장',
                staffName: '김팀장',
                ok: true,
                promotion: [],
                vacation: [],
                special: [],
                recruiting: {
                  monthTarget: 20,
                  monthAssignedCurrent: 3,
                  weekTarget: 5,
                  dailyPlan: [
                    { weekday: 'mon', channelName: 'A 채널', promotionContent: '월요일 홍보', targetCount: 1, ownerName: '김팀장', note: '' },
                    { weekday: 'tue', channelName: 'B 채널', promotionContent: '화요일 홍보', targetCount: 1, ownerName: '김팀장', note: '' },
                    { weekday: 'wed', channelName: 'C 채널', promotionContent: '수요일 홍보', targetCount: 1, ownerName: '김팀장', note: '' },
                    { weekday: 'thu', channelName: 'D 채널', promotionContent: '목요일 홍보', targetCount: 1, ownerName: '김팀장', note: '' },
                    { weekday: 'fri', channelName: 'E 채널', promotionContent: '금요일 홍보', targetCount: 1, ownerName: '김팀장', note: '' },
                  ],
                  dailyActualCount: payload.reportDate === '2026-04-03' ? 2 : 1,
                  weekTableRows: buildWeekRows(),
                },
                printUrl: 'http://www.kjca.co.kr/diary/?site=groupware&bd_idx=1',
              },
            ],
            stoppedReason: '',
            alertMessage: '',
          }
        },
      },
    }

    delete require.cache[collectServicePath]

    globalThis.$app = appMock
    globalThis.Record = MockRecord
    globalThis.sleep = () => {}

    const collectService = require(collectServicePath)
    const result = collectService.collectWeekly(
      {},
      {
        recruitingWeekPlanRole: { canSaveConfirmed: () => true },
        recruitingWeekPlanItemRole: { canSave: () => true },
        recruitingDailyResultRole: { canSaveAiResult: () => true },
        recruitingWeekTextPlanRole: { canSaveConfirmed: () => true },
        recruitingWeekTextRowRole: { canSave: () => true },
      },
      {
        reportDate: '2026-04-03',
        testOneOnly: false,
      }
    )

    assert.equal(result.ok, true)
    assert.equal(result.deptWeekTables.length, 1)
    assert.equal(result.deptWeekTables[0].dept, '입학팀')
    assert.equal(result.deptWeekTables[0].rows.some((row) => row.channelName === 'A 채널'), true)
    assert.equal(result.deptWeekTables[0].rows.some((row) => row.recruitCountText === '2'), true)
  } finally {
    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalAnalyzeCache) require.cache[analyzeModulePath] = originalAnalyzeCache
    else delete require.cache[analyzeModulePath]

    if (originalCollectCache) require.cache[collectServicePath] = originalCollectCache
    else delete require.cache[collectServicePath]

    globalThis.$app = originalApp
    globalThis.Record = originalRecord
    globalThis.sleep = originalSleep
  }
})

test('clearAnalysisCache removes derived weekly records for the selected dept', () => {
  const originalAuthCache = require.cache[authModulePath]
  const originalAnalyzeCache = require.cache[analyzeModulePath]
  const originalCollectCache = require.cache[collectServicePath]
  const originalApp = globalThis.$app
  const originalRecord = globalThis.Record

  const appMock = createAppMock()

  try {
    require.cache[authModulePath] = {
      id: authModulePath,
      filename: authModulePath,
      loaded: true,
      exports: {
        ensureSuperuserRequest() {},
        createKjcaSession() {
          return null
        },
        probeStaffAuth() {
          return {
            isDiaryAccessible: true,
            teamLeadRows: [],
          }
        },
      },
    }

    require.cache[analyzeModulePath] = {
      id: analyzeModulePath,
      filename: analyzeModulePath,
      loaded: true,
      exports: {
        analyzeStaffDiary() {
          throw new Error('not used in this test')
        },
      },
    }

    delete require.cache[collectServicePath]

    globalThis.$app = appMock
    globalThis.Record = MockRecord

    createSavedRecord(appMock, 'staff_diary_analysis_cache', {
      reportDate: '2026-04-03',
      dept: '경기안양',
    })

    const weekTextPlan = createSavedRecord(appMock, 'recruiting_week_text_plans', {
      weekStartDate: '2026-03-30',
      dept: '경기안양',
    })
    createSavedRecord(appMock, 'recruiting_week_text_rows', {
      planId: weekTextPlan.id,
      weekday: 'fri',
      channelName: '오염된 주간표',
    })

    const weekPlan = createSavedRecord(appMock, 'recruiting_week_plans', {
      weekStartDate: '2026-03-30',
      dept: '경기안양',
    })
    createSavedRecord(appMock, 'recruiting_week_plan_items', {
      planId: weekPlan.id,
      weekday: 'fri',
      targetCount: 12,
    })

    createSavedRecord(appMock, 'recruiting_daily_results', {
      reportDate: '2026-04-03',
      weekStartDate: '2026-03-30',
      dept: '경기안양',
      weekday: 'fri',
      actualCount: 1,
    })

    const collectService = require(collectServicePath)
    const result = collectService.clearAnalysisCache(
      {},
      {
        reportDate: '2026-04-03',
        dept: '경기안양',
      }
    )

    assert.equal(result.ok, true)
    assert.equal(result.deletedCount, 6)
    assert.equal(appMock.__store.staff_diary_analysis_cache.length, 0)
    assert.equal(appMock.__store.recruiting_week_text_plans.length, 0)
    assert.equal(appMock.__store.recruiting_week_text_rows.length, 0)
    assert.equal(appMock.__store.recruiting_week_plans.length, 0)
    assert.equal(appMock.__store.recruiting_week_plan_items.length, 0)
    assert.equal(appMock.__store.recruiting_daily_results.length, 0)
  } finally {
    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalAnalyzeCache) require.cache[analyzeModulePath] = originalAnalyzeCache
    else delete require.cache[analyzeModulePath]

    if (originalCollectCache) require.cache[collectServicePath] = originalCollectCache
    else delete require.cache[collectServicePath]

    globalThis.$app = originalApp
    globalThis.Record = originalRecord
  }
})
