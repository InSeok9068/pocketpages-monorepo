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
