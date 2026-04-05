import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))

globalThis.__hooks = path.resolve(testDir, '../pb_hooks')

const analyzeServicePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-analyze-service.js')
const authModulePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-auth.js')
const pocketpagesModulePath = require.resolve('pocketpages')

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

function createCacheRecord(values) {
  const record = new MockRecord({ id: 'staff_diary_analysis_cache', name: 'staff_diary_analysis_cache' })
  Object.entries(values || {}).forEach(([key, value]) => {
    record.set(key, value)
  })
  return record
}

function buildDiaryHtml() {
  return (
    '<div class="doc_text editor">' +
    '<strong>2. 모집 / 홍보</strong>' +
    '<table>' +
    '<tr><td colspan="7">월 배정목표 : 50건 / 4월 현재 달성 : 배정 9명</td></tr>' +
    '<tr><td>요일</td><td colspan="3">주간 홍보계획</td><td>결과</td><td>담당자(홍보)</td><td>비고</td></tr>' +
    '<tr><td>모집홍보처</td><td>모집 홍보내용</td><td>모집목표</td><td>모집 건수</td></tr>' +
    '<tr><td>목</td><td>안양온누리요양보호사교육원</td><td>홍보</td><td></td><td></td><td>정은선</td><td></td></tr>' +
    '<tr><td>금</td><td>한국직업능력교육원</td><td>설명회</td><td>12명</td><td>1</td><td>김민정</td><td>선물 전달예정</td></tr>' +
    '</table>' +
    '<strong>3. 알선취업자 현황</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>임수라</td></tr>' +
    '<tr><td>월 알선취업 목표</td><td>1</td></tr>' +
    '<tr><td>금일 알선건수</td><td>0</td></tr>' +
    '<tr><td>알선취업 예정자 수</td><td>1</td></tr>' +
    '<tr><td>알선자 면접건수</td><td>0</td></tr>' +
    '<tr><td>알선취업 누적건수</td><td>0</td></tr>' +
    '</table>' +
    '<strong>4. 기타 사항</strong>' +
    '<table>' +
    '<tr><td>구분</td><td>내용</td></tr>' +
    '<tr><td>고용센터 전달사항</td><td>- 수원고용센터 간담회</td></tr>' +
    '<tr><td>지점 특이사항</td><td>- 없음</td></tr>' +
    '<tr><td>기타 건의사항</td><td>- 없음</td></tr>' +
    '</table>' +
    '</div>'
  )
}

test('analyzeStaffDiary prefers html recruiting data over cached recruiting data on cache hit', () => {
  const originalAuthCache = require.cache[authModulePath]
  const originalAnalyzeCache = require.cache[analyzeServicePath]
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalHttp = globalThis.$http
  const originalApp = globalThis.$app
  const originalRecord = globalThis.Record
  const originalSleep = globalThis.sleep
  const originalToString = globalThis.toString

  try {
    require.cache[pocketpagesModulePath] = {
      id: pocketpagesModulePath,
      filename: pocketpagesModulePath,
      loaded: true,
      exports: {
        globalApi: {
          env() {
            return 'test-gemini-key'
          },
          warn() {},
          info() {},
        },
      },
    }

    require.cache[authModulePath] = {
      id: authModulePath,
      filename: authModulePath,
      loaded: true,
      exports: {
        createKjcaSession() {
          return {
            host: 'http://www.kjca.co.kr',
            cookieHeader: '',
          }
        },
      },
    }

    delete require.cache[analyzeServicePath]

    const cachedRecord = createCacheRecord({
      promotion: ['캐시 모집 문구'],
      vacation: [],
      special: [],
      recruiting: {
        monthTarget: 999,
        monthAssignedCurrent: 88,
        weekTarget: 99,
        dailyPlan: [{ weekday: 'fri', channelName: '오염된 캐시 계획', promotionContent: '알선 데이터', targetCount: 99, ownerName: '오염', note: '오염' }],
        dailyActualCount: 77,
        weekTableRows: [
          {
            weekday: 'fri',
            channelName: '오염된 캐시값',
            weeklyPlan: '',
            promotionContent: '알선취업 예정자 수 / 알선자 면접건수',
            targetText: '77',
            resultText: '',
            recruitCountText: '77',
            ownerName: '오염',
            note: '오염된 비고',
          },
        ],
      },
    })

    globalThis.$app = {
      findFirstRecordByFilter(collectionName) {
        if (collectionName === 'staff_diary_analysis_cache') return cachedRecord
        throw new Error(`Unexpected collection: ${collectionName}`)
      },
      findCollectionByNameOrId(name) {
        return { id: name, name }
      },
      save() {
        throw new Error('save should not be called on cache hit')
      },
    }

    globalThis.$http = {
      send(options) {
        if (String(options.url || '').includes('generativelanguage.googleapis.com')) {
          throw new Error('gemini should not be called on cache hit')
        }

        return {
          statusCode: 200,
          headers: {},
          body: `<html><body>${buildDiaryHtml()}</body></html>`,
        }
      },
    }

    globalThis.Record = MockRecord
    globalThis.sleep = () => {}
    globalThis.toString = (value) => String(value == null ? '' : value)

    const analyzeService = require(analyzeServicePath)
    const result = analyzeService.analyzeStaffDiary(
      {},
      null,
      {
        reportDate: '2026-04-03',
        targets: [
          {
            dept: '경기안양',
            position: '팀장',
            staffName: '김민정',
            printUrl: 'http://www.kjca.co.kr/diary/?site=groupware&bd_idx=1',
          },
        ],
      }
    )

    const item = result.results[0]
    const friRow = item.recruiting.weekTableRows.find((row) => row.weekday === 'fri')

    assert.equal(item.ok, true)
    assert.deepEqual(item.promotion, ['캐시 모집 문구'])
    assert.equal(item.recruiting.monthTarget, 50)
    assert.equal(item.recruiting.monthAssignedCurrent, 9)
    assert.equal(item.recruiting.dailyActualCount, 1)
    assert.equal(friRow.channelName, '한국직업능력교육원')
    assert.equal(friRow.promotionContent, '설명회')
    assert.equal(friRow.ownerName, '김민정')
    assert.equal(item.recruiting.jobStatusTable.staffNames[0], '임수라')
    assert.equal(item.miscSection.items.length, 3)
  } finally {
    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalAnalyzeCache) require.cache[analyzeServicePath] = originalAnalyzeCache
    else delete require.cache[analyzeServicePath]

    if (originalPocketpagesCache) require.cache[pocketpagesModulePath] = originalPocketpagesCache
    else delete require.cache[pocketpagesModulePath]

    globalThis.$http = originalHttp
    globalThis.$app = originalApp
    globalThis.Record = originalRecord
    globalThis.sleep = originalSleep
    globalThis.toString = originalToString
  }
})

test('analyzeStaffDiary keeps html extracted recruiting, job status and misc data when AI request fails', () => {
  const originalAuthCache = require.cache[authModulePath]
  const originalAnalyzeCache = require.cache[analyzeServicePath]
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalHttp = globalThis.$http
  const originalApp = globalThis.$app
  const originalRecord = globalThis.Record
  const originalSleep = globalThis.sleep
  const originalToString = globalThis.toString

  let geminiCallCount = 0

  try {
    require.cache[pocketpagesModulePath] = {
      id: pocketpagesModulePath,
      filename: pocketpagesModulePath,
      loaded: true,
      exports: {
        globalApi: {
          env() {
            return 'test-gemini-key'
          },
          warn() {},
          info() {},
        },
      },
    }

    require.cache[authModulePath] = {
      id: authModulePath,
      filename: authModulePath,
      loaded: true,
      exports: {
        createKjcaSession() {
          return {
            host: 'http://www.kjca.co.kr',
            cookieHeader: '',
          }
        },
      },
    }

    delete require.cache[analyzeServicePath]

    globalThis.$app = {
      findFirstRecordByFilter() {
        throw new Error('cache miss')
      },
      findCollectionByNameOrId(name) {
        return { id: name, name }
      },
      save() {},
    }

    globalThis.$http = {
      send(options) {
        if (String(options.url || '').includes('generativelanguage.googleapis.com')) {
          geminiCallCount += 1
          return {
            statusCode: 503,
            headers: {},
            body: '{}',
          }
        }

        return {
          statusCode: 200,
          headers: {},
          body: `<html><body>${buildDiaryHtml()}</body></html>`,
        }
      },
    }

    globalThis.Record = MockRecord
    globalThis.sleep = () => {}
    globalThis.toString = (value) => String(value == null ? '' : value)

    const analyzeService = require(analyzeServicePath)
    const result = analyzeService.analyzeStaffDiary(
      {},
      null,
      {
        reportDate: '2026-04-03',
        targets: [
          {
            dept: '경기안양',
            position: '팀장',
            staffName: '김민정',
            printUrl: 'http://www.kjca.co.kr/diary/?site=groupware&bd_idx=1',
          },
        ],
      }
    )

    const item = result.results[0]

    assert.equal(geminiCallCount, 3)
    assert.equal(item.ok, false)
    assert.equal(item.error.includes('AI 요청 실패 (HTTP 503)'), true)
    assert.equal(item.recruiting.weekTableRows.find((row) => row.weekday === 'fri').channelName, '한국직업능력교육원')
    assert.equal(item.recruiting.jobStatusTable.staffNames[0], '임수라')
    assert.equal(item.miscSection.items[0].label, '고용센터 전달사항')
  } finally {
    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalAnalyzeCache) require.cache[analyzeServicePath] = originalAnalyzeCache
    else delete require.cache[analyzeServicePath]

    if (originalPocketpagesCache) require.cache[pocketpagesModulePath] = originalPocketpagesCache
    else delete require.cache[pocketpagesModulePath]

    globalThis.$http = originalHttp
    globalThis.$app = originalApp
    globalThis.Record = originalRecord
    globalThis.sleep = originalSleep
    globalThis.toString = originalToString
  }
})
