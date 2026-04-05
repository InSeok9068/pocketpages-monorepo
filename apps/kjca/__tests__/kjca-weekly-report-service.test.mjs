import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))

globalThis.__hooks = path.resolve(testDir, '../pb_hooks')

const serviceModulePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-weekly-report-service.js')
const authModulePath = path.resolve(testDir, '../pb_hooks/pages/_private/kjca-auth.js')
const pocketpagesModulePath = require.resolve('pocketpages')

test('collectWeeklyReportUrls searches both weekly sources and returns combined approval urls', () => {
  const originalServiceCache = require.cache[serviceModulePath]
  const originalAuthCache = require.cache[authModulePath]
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalHttp = globalThis.$http
  const originalToString = globalThis.toString

  const requestedUrls = []

  try {
    require.cache[pocketpagesModulePath] = {
      id: pocketpagesModulePath,
      filename: pocketpagesModulePath,
      loaded: true,
      exports: {
        globalApi: {
          info() {},
          dbg() {},
          warn() {},
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
            cookieHeader: 'SESSION=abc',
          }
        },
      },
    }

    globalThis.$http = {
      send(options) {
        const url = String(options.url || '')
        requestedUrls.push(url)

        if (url.includes('mn=1426') && url.includes('type2=to_al_done')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="page_system_list width_table">' +
              '<table><tbody>' +
              '<tr>' +
              '<td data-label="문서번호">문서-1</td>' +
              '<td data-label="문서양식">기안서</td>' +
              '<td data-label="제목"><a href="?site=groupware&amp;mn=1426&amp;type=view&amp;type2=to_al_done&amp;ad_idx=1">경기성남 4월 첫째주 주간업무보고</a></td>' +
              '<td data-label="기안부서">경기성남</td>' +
              '<td data-label="기안자">김보라</td>' +
              '<td data-label="기안일">2026-03-27</td>' +
              '<td data-label="상태">종결</td>' +
              '</tr>' +
              '</tbody></table>' +
              '</div>',
          }
        }

        if (url.includes('mn=1425') && url.includes('type2=to_al_ing')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="page_system_list width_table">' +
              '<table><tbody>' +
              '<tr>' +
              '<td data-label="문서번호">문서-2</td>' +
              '<td data-label="문서양식">기안서</td>' +
              '<td data-label="제목"><a href="?site=groupware&amp;mn=1425&amp;type=view&amp;type2=to_al_ing&amp;ad_idx=2">경기수원 4월 첫째주 주간업무보고</a></td>' +
              '<td data-label="기안부서">경기수원</td>' +
              '<td data-label="기안자">임수라</td>' +
              '<td data-label="기안일">2026-03-28</td>' +
              '<td data-label="상태">진행</td>' +
              '</tr>' +
              '</tbody></table>' +
              '</div>',
          }
        }

        throw new Error(`Unexpected URL: ${url}`)
      },
    }

    globalThis.toString = (value) => String(value == null ? '' : value)

    delete require.cache[serviceModulePath]
    const weeklyReportService = require(serviceModulePath)
    const result = weeklyReportService.collectWeeklyReportUrls({}, { referenceWeek: '2026-W14' })

    assert.equal(requestedUrls.length, 2)
    assert.ok(requestedUrls.some((url) => url.includes('mn=1426') && url.includes('sc_ad_status1_sdate=2026-03-31') && url.includes('sc_ad_status1_edate=2026-04-06')))
    assert.ok(requestedUrls.some((url) => url.includes('mn=1425') && url.includes('type2=to_al_ing') && url.includes('sc_word=%EC%A3%BC%EA%B0%84')))

    assert.equal(result.referenceWeek, '2026-W14')
    assert.equal(result.weekStartDate, '2026-03-31')
    assert.equal(result.weekEndDate, '2026-04-06')
    assert.deepEqual(
      result.rows.map((row) => ({
        dept: row.dept,
        title: row.title,
        status: row.status,
        viewUrl: row.viewUrl,
      })),
      [
        {
          dept: '경기성남',
          title: '경기성남 4월 첫째주 주간업무보고',
          status: '종결',
          viewUrl: 'http://www.kjca.co.kr/appr/appr_doc/?site=groupware&mn=1426&type=view&type2=to_al_done&ad_idx=1',
        },
        {
          dept: '경기수원',
          title: '경기수원 4월 첫째주 주간업무보고',
          status: '진행',
          viewUrl: 'http://www.kjca.co.kr/appr/appr_doc/?site=groupware&mn=1425&type=view&type2=to_al_ing&ad_idx=2',
        },
      ]
    )
  } finally {
    if (originalServiceCache) require.cache[serviceModulePath] = originalServiceCache
    else delete require.cache[serviceModulePath]

    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalPocketpagesCache) require.cache[pocketpagesModulePath] = originalPocketpagesCache
    else delete require.cache[pocketpagesModulePath]

    globalThis.$http = originalHttp
    globalThis.toString = originalToString
  }
})

test('collectWeeklyReportDetails fetches each document and keeps per-document parse errors', () => {
  const originalServiceCache = require.cache[serviceModulePath]
  const originalAuthCache = require.cache[authModulePath]
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalHttp = globalThis.$http
  const originalToString = globalThis.toString

  const requestedUrls = []

  try {
    require.cache[pocketpagesModulePath] = {
      id: pocketpagesModulePath,
      filename: pocketpagesModulePath,
      loaded: true,
      exports: {
        globalApi: {
          info() {},
          dbg() {},
          warn() {},
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
            cookieHeader: 'SESSION=abc',
          }
        },
      },
    }

    globalThis.$http = {
      send(options) {
        const url = String(options.url || '')
        requestedUrls.push(url)

        if (url.includes('ad_idx=1')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="doc_text">' +
              '<table><tr><td>지점명</td><td>팀장</td><td>상담사</td><td>총 진행인원</td><td>평균 진행인원</td><td>관리자</td></tr><tr><td>경기성남</td><td>김보라</td><td>5명</td><td>120명</td><td>24명</td><td>이명재 실장</td></tr></table>' +
              '<table><tr><td>월 목표<br>알선 취업자</td><td>알선 취업자<br>달성</td><td>월 목표<br>본인취업</td><td>본인취업<br>달성</td><td>기간만료</td><td>중단</td><td>취업률</td><td>알선취업률</td></tr><tr><td>3명</td><td>1명</td><td>5명</td><td>8명</td><td>10명</td><td>1명</td><td>55.67%</td><td>8.51%</td></tr></table>' +
              '<table><tr><td>2026년 목표인원</td><td>2026년 달성인원</td><td>3월 목표인원</td><td>3월 달성인원</td><td>월 IAP수립목표</td><td>IAP수립 달성</td></tr><tr><td>500명</td><td>89명</td><td>42명</td><td>21명</td><td>42명</td><td>30명</td></tr></table>' +
              '<table><tr><td>지난주 업무계획</td><td>대전일자리진흥원 협약 예정</td></tr><tr><td>지난주 업무결과</td><td>대전일자리진흥원 협약</td></tr></table>' +
              '<table><tr><td>요일</td><td>차주 업무계획 상세</td></tr><tr><td>월</td><td>그린컴퓨터아트학원 둔산점 국취 설명회</td></tr></table>' +
              '<table><tr><td>구분</td><td>내용</td></tr><tr><td>지점 특이사항</td><td>이음데이 행사 기업 섭외</td></tr><tr><td>기타 건의사항</td><td>-</td></tr></table>' +
              '</div>',
          }
        }

        if (url.includes('ad_idx=2')) {
          return {
            statusCode: 200,
            headers: {},
            body: '<div class="doc_text"><p>표를 찾을 수 없는 문서</p></div>',
          }
        }

        throw new Error(`Unexpected URL: ${url}`)
      },
    }

    globalThis.toString = (value) => String(value == null ? '' : value)

    delete require.cache[serviceModulePath]
    const weeklyReportService = require(serviceModulePath)
    const result = weeklyReportService.collectWeeklyReportDetails(
      {},
      {
        referenceWeek: '2026-W14',
        rows: [
          {
            sourceLabel: '종결 문서',
            sourceMenu: '1426',
            sourceType: 'to_al_done',
            docNo: '문서-1',
            formName: '기안서',
            title: '경기성남 4월 첫째주 주간업무보고',
            dept: '경기성남',
            drafter: '김보라',
            draftDate: '2026-03-27',
            status: '종결',
            viewUrl: 'http://www.kjca.co.kr/appr/appr_doc/?site=groupware&mn=1426&type=view&type2=to_al_done&ad_idx=1',
          },
          {
            sourceLabel: '진행 문서',
            sourceMenu: '1425',
            sourceType: 'to_al_ing',
            docNo: '문서-2',
            formName: '기안서',
            title: '경기수원 4월 첫째주 주간업무보고',
            dept: '경기수원',
            drafter: '임수라',
            draftDate: '2026-03-28',
            status: '진행',
            viewUrl: 'http://www.kjca.co.kr/appr/appr_doc/?site=groupware&mn=1425&type=view&type2=to_al_ing&ad_idx=2',
          },
        ],
      }
    )

    assert.equal(requestedUrls.length, 2)
    assert.equal(result.referenceWeek, '2026-W14')
    assert.equal(result.details.length, 2)
    assert.equal(result.details[0].ok, true)
    assert.deepEqual(
      result.details[0].operationsTables.map((table) => table.key),
      ['basic-status', 'employment-status', 'assignment-iap']
    )
    assert.equal(result.details[0].workTables[0].rows[1][0], '지난주 업무결과')
    assert.equal(result.details[1].ok, false)
    assert.equal(result.details[1].error.includes('지원하는 주간 보고 표를 찾지 못했습니다.'), true)
    assert.equal(result.warnings.length, 1)
  } finally {
    if (originalServiceCache) require.cache[serviceModulePath] = originalServiceCache
    else delete require.cache[serviceModulePath]

    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalPocketpagesCache) require.cache[pocketpagesModulePath] = originalPocketpagesCache
    else delete require.cache[pocketpagesModulePath]

    globalThis.$http = originalHttp
    globalThis.toString = originalToString
  }
})

test('collectWeeklyReports runs weekly url lookup and detail parsing in one flow', () => {
  const originalServiceCache = require.cache[serviceModulePath]
  const originalAuthCache = require.cache[authModulePath]
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalHttp = globalThis.$http
  const originalToString = globalThis.toString

  const requestedUrls = []

  try {
    require.cache[pocketpagesModulePath] = {
      id: pocketpagesModulePath,
      filename: pocketpagesModulePath,
      loaded: true,
      exports: {
        globalApi: {
          info() {},
          dbg() {},
          warn() {},
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
            cookieHeader: 'SESSION=abc',
          }
        },
      },
    }

    globalThis.$http = {
      send(options) {
        const url = String(options.url || '')
        requestedUrls.push(url)

        if (url.includes('type=lists') && url.includes('mn=1426')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="page_system_list width_table">' +
              '<table><tbody>' +
              '<tr>' +
              '<td data-label="문서번호">문서-1</td>' +
              '<td data-label="문서양식">기안서</td>' +
              '<td data-label="제목"><a href="?site=groupware&amp;mn=1426&amp;type=view&amp;type2=to_al_done&amp;ad_idx=1">경기성남 4월 첫째주 주간업무보고</a></td>' +
              '<td data-label="기안부서">경기성남</td>' +
              '<td data-label="기안자">김보라</td>' +
              '<td data-label="기안일">2026-03-27</td>' +
              '<td data-label="상태">종결</td>' +
              '</tr>' +
              '</tbody></table>' +
              '</div>',
          }
        }

        if (url.includes('type=lists') && url.includes('mn=1425')) {
          return {
            statusCode: 200,
            headers: {},
            body: '<div class="page_system_list width_table"><table><tbody></tbody></table></div>',
          }
        }

        if (url.includes('ad_idx=1')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="doc_text">' +
              '<table><tr><td>지점명</td><td>팀장</td><td>상담사</td><td>총 진행인원</td><td>평균 진행인원</td><td>관리자</td></tr><tr><td>경기성남</td><td>김보라</td><td>5명</td><td>120명</td><td>24명</td><td>이명재 실장</td></tr></table>' +
              '<table><tr><td>월 목표<br>알선 취업자</td><td>알선 취업자<br>달성</td><td>월 목표<br>본인취업</td><td>본인취업<br>달성</td><td>기간만료</td><td>중단</td><td>취업률</td><td>알선취업률</td></tr><tr><td>3명</td><td>1명</td><td>5명</td><td>8명</td><td>10명</td><td>1명</td><td>55.67%</td><td>8.51%</td></tr></table>' +
              '<table><tr><td>2026년 목표인원</td><td>2026년 달성인원</td><td>3월 목표인원</td><td>3월 달성인원</td><td>월 IAP수립목표</td><td>IAP수립 달성</td></tr><tr><td>500명</td><td>89명</td><td>42명</td><td>21명</td><td>42명</td><td>30명</td></tr></table>' +
              '<table><tr><td>지난주 업무계획</td><td>대전일자리진흥원 협약 예정</td></tr><tr><td>지난주 업무결과</td><td>대전일자리진흥원 협약</td></tr></table>' +
              '<table><tr><td>요일</td><td>차주 업무계획 상세</td></tr><tr><td>월</td><td>그린컴퓨터아트학원 둔산점 국취 설명회</td></tr></table>' +
              '<table><tr><td>구분</td><td>내용</td></tr><tr><td>지점 특이사항</td><td>이음데이 행사 기업 섭외</td></tr><tr><td>기타 건의사항</td><td>-</td></tr></table>' +
              '</div>',
          }
        }

        throw new Error(`Unexpected URL: ${url}`)
      },
    }

    globalThis.toString = (value) => String(value == null ? '' : value)

    delete require.cache[serviceModulePath]
    const weeklyReportService = require(serviceModulePath)
    const result = weeklyReportService.collectWeeklyReports({}, { referenceWeek: '2026-W14' })

    assert.equal(requestedUrls.filter((url) => url.includes('type=lists')).length, 2)
    assert.equal(requestedUrls.filter((url) => url.includes('ad_idx=1')).length, 1)
    assert.equal(result.rows.length, 1)
    assert.equal(result.details.length, 1)
    assert.equal(result.details[0].ok, true)
    assert.deepEqual(
      result.details[0].operationsTables.map((table) => table.key),
      ['basic-status', 'employment-status', 'assignment-iap']
    )
  } finally {
    if (originalServiceCache) require.cache[serviceModulePath] = originalServiceCache
    else delete require.cache[serviceModulePath]

    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalPocketpagesCache) require.cache[pocketpagesModulePath] = originalPocketpagesCache
    else delete require.cache[pocketpagesModulePath]

    globalThis.$http = originalHttp
    globalThis.toString = originalToString
  }
})

test('collectWeeklyReports keeps list-stage warnings after detail parsing succeeds', () => {
  const originalServiceCache = require.cache[serviceModulePath]
  const originalAuthCache = require.cache[authModulePath]
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]
  const originalHttp = globalThis.$http
  const originalToString = globalThis.toString

  try {
    require.cache[pocketpagesModulePath] = {
      id: pocketpagesModulePath,
      filename: pocketpagesModulePath,
      loaded: true,
      exports: {
        globalApi: {
          info() {},
          dbg() {},
          warn() {},
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
            cookieHeader: 'SESSION=abc',
          }
        },
      },
    }

    globalThis.$http = {
      send(options) {
        const url = String(options.url || '')

        if (url.includes('type=lists') && url.includes('mn=1426')) {
          return {
            statusCode: 503,
            headers: {},
            body: '<div class="page_system_list width_table"><table><tbody></tbody></table></div>',
          }
        }

        if (url.includes('type=lists') && url.includes('mn=1425')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="page_system_list width_table">' +
              '<table><tbody>' +
              '<tr>' +
              '<td data-label="문서번호">문서-2</td>' +
              '<td data-label="문서양식">기안서</td>' +
              '<td data-label="제목"><a href="?site=groupware&amp;mn=1425&amp;type=view&amp;type2=to_al_ing&amp;ad_idx=2">경기수원 4월 첫째주 주간업무보고</a></td>' +
              '<td data-label="기안부서">경기수원</td>' +
              '<td data-label="기안자">임수라</td>' +
              '<td data-label="기안일">2026-03-28</td>' +
              '<td data-label="상태">진행</td>' +
              '</tr>' +
              '</tbody></table>' +
              '</div>',
          }
        }

        if (url.includes('ad_idx=2')) {
          return {
            statusCode: 200,
            headers: {},
            body:
              '<div class="doc_text">' +
              '<table><tr><td>지점명</td><td>팀장</td><td>상담사</td><td>총 진행인원</td><td>평균 진행인원</td><td>관리자</td></tr><tr><td>경기수원</td><td>임수라</td><td>5명</td><td>120명</td><td>24명</td><td>이명재 실장</td></tr></table>' +
              '<table><tr><td>월 목표<br>알선 취업자</td><td>알선 취업자<br>달성</td><td>월 목표<br>본인취업</td><td>본인취업<br>달성</td><td>기간만료</td><td>중단</td><td>취업률</td><td>알선취업률</td></tr><tr><td>3명</td><td>1명</td><td>5명</td><td>8명</td><td>10명</td><td>1명</td><td>55.67%</td><td>8.51%</td></tr></table>' +
              '<table><tr><td>2026년 목표인원</td><td>2026년 달성인원</td><td>3월 목표인원</td><td>3월 달성인원</td><td>월 IAP수립목표</td><td>IAP수립 달성</td></tr><tr><td>500명</td><td>89명</td><td>42명</td><td>21명</td><td>42명</td><td>30명</td></tr></table>' +
              '</div>',
          }
        }

        throw new Error(`Unexpected URL: ${url}`)
      },
    }

    globalThis.toString = (value) => String(value == null ? '' : value)

    delete require.cache[serviceModulePath]
    const weeklyReportService = require(serviceModulePath)
    const result = weeklyReportService.collectWeeklyReports({}, { referenceWeek: '2026-W14' })

    assert.equal(result.rows.length, 1)
    assert.equal(result.details.length, 1)
    assert.equal(result.details[0].ok, true)
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0].includes('종결 문서 목록 조회에 실패했습니다. (503)'), true)
  } finally {
    if (originalServiceCache) require.cache[serviceModulePath] = originalServiceCache
    else delete require.cache[serviceModulePath]

    if (originalAuthCache) require.cache[authModulePath] = originalAuthCache
    else delete require.cache[authModulePath]

    if (originalPocketpagesCache) require.cache[pocketpagesModulePath] = originalPocketpagesCache
    else delete require.cache[pocketpagesModulePath]

    globalThis.$http = originalHttp
    globalThis.toString = originalToString
  }
})
