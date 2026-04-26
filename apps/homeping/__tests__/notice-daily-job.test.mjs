import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))
const jobPath = path.resolve(testDir, '../pb_hooks/jobs/notice-daily-job.js')
const oneSignalServicePath = path.resolve(testDir, '../pb_hooks/jobs/onesignal-service.js')
const applyhomeServicePath = path.resolve(testDir, '../pb_hooks/pages/_private/applyhome-service.js')
const pocketpagesModulePath = require.resolve('pocketpages')

function createNotice(input) {
  return {
    id: input.id,
    sourceCode: input.sourceCode || 'applyhome-apt',
    sourceLabel: input.sourceLabel || '청약홈',
    categoryLabel: input.categoryLabel || 'APT 분양',
    name: input.name,
    address: input.address || '경기도 안양시',
    areaName: '',
    businessOwner: '',
    phone: '',
    detailUrl: input.detailUrl || 'https://applyhome.test/' + encodeURIComponent(input.id),
    recruitDate: input.recruitDate || '2026-04-26',
    recruitDateLabel: '',
    applyStartDate: '',
    applyEndDate: input.applyEndDate || '2026-05-01',
    applyDateLabel: '',
    winnerDateLabel: '',
    moveInLabel: '',
    householdCountLabel: '',
    statusLabel: '접수중',
    statusCode: 'open',
  }
}

function createApplyhomeApiRow(input) {
  return {
    RCRIT_PBLANC_DE: input.recruitDate || '2099-04-26',
    RCEPT_BGNDE: input.applyStartDate || '2099-04-26',
    RCEPT_ENDDE: input.applyEndDate || '2099-05-01',
    PRZWNER_PRESNATN_DE: '',
    HOUSE_MANAGE_NO: input.houseManageNo || input.id || input.name,
    PBLANC_NO: input.pblancNo || input.id || input.name,
    HOUSE_DTL_SECD_NM: input.detailName || '민영',
    HOUSE_SECD_NM: input.houseSectionName || 'APT',
    HOUSE_NM: input.name,
    HSSPLY_ADRES: input.address || '경기도 안양시 동안구',
    SUBSCRPT_AREA_CODE_NM: '경기',
    BSNS_MBY_NM: '사업주체',
    MDHS_TELNO: '',
    PBLANC_URL: input.detailUrl || 'https://applyhome.test/' + encodeURIComponent(input.id || input.name),
    MVN_PREARNGE_YM: '',
    TOT_SUPLY_HSHLDCO: input.householdCount || 12,
  }
}

function createLogger() {
  const logs = []

  return {
    logs,
    logger() {
      return {
        debug(...args) {
          logs.push(['debug'].concat(args))
        },
        info(...args) {
          logs.push(['info'].concat(args))
        },
        warn(...args) {
          logs.push(['warn'].concat(args))
        },
        error(...args) {
          logs.push(['error'].concat(args))
        },
      }
    },
  }
}

function createFakeHttp(applyhomeRows) {
  const requests = []

  return {
    requests,
    send(config) {
      const requestUrl = new URL(config.url)
      requests.push(requestUrl)

      if (requestUrl.hostname === 'api.odcloud.kr') {
        return {
          statusCode: 200,
          json: {
            data: requestUrl.pathname.indexOf('/getAPTLttotPblancDetail') !== -1 ? applyhomeRows : [],
          },
        }
      }

      if (requestUrl.hostname === 'apis.data.go.kr') {
        return {
          statusCode: 200,
          json: [
            {
              dsList: [],
            },
          ],
        }
      }

      throw new Error('Unexpected request URL: ' + config.url)
    },
  }
}

function installPocketpagesMock() {
  const originalPocketpagesCache = require.cache[pocketpagesModulePath]

  require.cache[pocketpagesModulePath] = {
    id: pocketpagesModulePath,
    filename: pocketpagesModulePath,
    loaded: true,
    exports: {
      globalApi: {
        dbg() {},
        info() {},
        store() {},
      },
    },
  }

  return function restorePocketpagesMock() {
    if (originalPocketpagesCache) {
      require.cache[pocketpagesModulePath] = originalPocketpagesCache
    } else {
      delete require.cache[pocketpagesModulePath]
    }
  }
}

function loadJobWithRealApplyhome() {
  const restorePocketpagesMock = installPocketpagesMock()
  const originalJobCache = require.cache[jobPath]
  const originalApplyhomeCache = require.cache[applyhomeServicePath]

  delete require.cache[jobPath]
  delete require.cache[applyhomeServicePath]

  const job = require(jobPath)

  return {
    job,
    cleanup() {
      if (originalJobCache) {
        require.cache[jobPath] = originalJobCache
      } else {
        delete require.cache[jobPath]
      }

      if (originalApplyhomeCache) {
        require.cache[applyhomeServicePath] = originalApplyhomeCache
      } else {
        delete require.cache[applyhomeServicePath]
      }

      restorePocketpagesMock()
    },
  }
}

function loadJob() {
  const restorePocketpagesMock = installPocketpagesMock()
  const originalJobCache = require.cache[jobPath]
  const originalApplyhomeCache = require.cache[applyhomeServicePath]

  require.cache[applyhomeServicePath] = {
    id: applyhomeServicePath,
    filename: applyhomeServicePath,
    loaded: true,
    exports: {
      searchRegionNotices() {
        return {
          notices: [],
          errors: [],
        }
      },
    },
  }

  delete require.cache[jobPath]

  const job = require(jobPath)

  return {
    job,
    cleanup() {
      if (originalJobCache) {
        require.cache[jobPath] = originalJobCache
      } else {
        delete require.cache[jobPath]
      }

      if (originalApplyhomeCache) {
        require.cache[applyhomeServicePath] = originalApplyhomeCache
      } else {
        delete require.cache[applyhomeServicePath]
      }

      restorePocketpagesMock()
    },
  }
}

test('daily notice job can use the real pages _private applyhome service', () => {
  const harness = loadJobWithRealApplyhome()
  const appMock = createLogger()
  const httpMock = createFakeHttp([
    createApplyhomeApiRow({
      id: 'applyhome-real-private-1',
      name: '안양 실제 _private 공고',
    }),
  ])
  const sentPushes = []
  const savedNotices = []
  const originalApp = globalThis.$app
  const originalHttp = globalThis.$http

  globalThis.$app = appMock
  globalThis.$http = httpMock

  try {
    const result = harness.job.runWithServices(
      {
        notifiedNoticeService: {
          BROADCAST_REGION: 'all',
          getNoticeKey(notice) {
            return notice.id
          },
          hasNotifiedNotice() {
            return false
          },
          createNotifiedNotice(input) {
            savedNotices.push(input)
          },
        },
        oneSignalService: {
          sendPushNotification(input) {
            sentPushes.push(input)
            return {
              id: 'onesignal-real-private-message-id',
            }
          },
        },
      },
      {
        apiKey: 'data-api-key',
        regionSlugs: ['anyang'],
      }
    )
    const applyhomeRequests = httpMock.requests.filter((requestUrl) => requestUrl.hostname === 'api.odcloud.kr')
    const lhRequests = httpMock.requests.filter((requestUrl) => requestUrl.hostname === 'apis.data.go.kr')

    assert.equal(result.checkedCount, 1)
    assert.equal(result.newCount, 1)
    assert.equal(result.sent, true)
    assert.equal(result.notificationId, 'onesignal-real-private-message-id')
    assert.equal(applyhomeRequests.length, 5)
    assert.equal(lhRequests.length, 1)
    assert.equal(applyhomeRequests[0].searchParams.get('cond[HSSPLY_ADRES::LIKE]'), '안양')
    assert.equal(sentPushes.length, 1)
    assert.equal(sentPushes[0].title, 'Homeping 신규 공고')
    assert.equal(sentPushes[0].contents.includes('안양 실제 _private 공고'), true)
    assert.equal(savedNotices.length, 1)
    assert.equal(savedNotices[0].notice.name, '안양 실제 _private 공고')
  } finally {
    globalThis.$app = originalApp
    globalThis.$http = originalHttp
    harness.cleanup()
  }
})

test('daily notice job sends one summary push and records every new notice', () => {
  const harness = loadJob()
  const appMock = createLogger()
  const sentPushes = []
  const savedNotices = []
  const searchCalls = []
  const noticesByRegion = {
    anyang: [createNotice({ id: 'applyhome:apt:1:1', name: '안양 신규 공고' })],
    uiwang: [createNotice({ id: 'applyhome:apt:2:2', name: '의왕 신규 공고', address: '경기도 의왕시' })],
    gwacheon: [createNotice({ id: 'applyhome:apt:1:1', name: '안양 신규 공고' })],
    seongnam: [],
    yongin: [],
  }
  const originalApp = globalThis.$app

  globalThis.$app = appMock

  try {
    const result = harness.job.runWithServices(
      {
        applyhomeService: {
          searchRegionNotices(_config, input) {
            searchCalls.push(input)
            return {
              notices: noticesByRegion[input.regionSlug] || [],
              errors: [],
            }
          },
        },
        notifiedNoticeService: {
          BROADCAST_REGION: 'all',
          getNoticeKey(notice) {
            return notice.id
          },
          hasNotifiedNotice() {
            return false
          },
          createNotifiedNotice(input) {
            savedNotices.push(input)
          },
        },
        oneSignalService: {
          sendPushNotification(input) {
            sentPushes.push(input)
            return {
              id: 'onesignal-message-id',
            }
          },
        },
      },
      {
        apiKey: 'data-api-key',
      }
    )

    assert.equal(result.checkedCount, 2)
    assert.equal(result.newCount, 2)
    assert.equal(result.sent, true)
    assert.equal(result.notificationId, 'onesignal-message-id')
    assert.deepEqual(
      searchCalls.map((call) => call.regionSlug),
      ['anyang', 'uiwang', 'gwacheon', 'seongnam', 'yongin']
    )
    assert.equal(sentPushes.length, 1)
    assert.equal(sentPushes[0].title, 'Homeping 신규 공고 2건')
    assert.equal(sentPushes[0].contents.includes('안양 신규 공고'), true)
    assert.equal(savedNotices.length, 2)
    assert.deepEqual(
      savedNotices.map((item) => item.region),
      ['all', 'all']
    )
  } finally {
    globalThis.$app = originalApp
    harness.cleanup()
  }
})

test('daily notice job skips push when every notice was already recorded', () => {
  const harness = loadJob()
  const appMock = createLogger()
  const sentPushes = []
  const originalApp = globalThis.$app

  globalThis.$app = appMock

  try {
    const result = harness.job.runWithServices(
      {
        applyhomeService: {
          searchRegionNotices() {
            return {
              notices: [createNotice({ id: 'lh:old', sourceCode: 'lh-sale', sourceLabel: 'LH', name: '기존 공고' })],
              errors: [],
            }
          },
        },
        notifiedNoticeService: {
          BROADCAST_REGION: 'all',
          getNoticeKey(notice) {
            return notice.id
          },
          hasNotifiedNotice() {
            return true
          },
          createNotifiedNotice() {
            throw new Error('should not save')
          },
        },
        oneSignalService: {
          sendPushNotification(input) {
            sentPushes.push(input)
            throw new Error('should not send')
          },
        },
      },
      {
        apiKey: 'data-api-key',
      }
    )

    assert.equal(result.newCount, 0)
    assert.equal(result.sent, false)
    assert.equal(sentPushes.length, 0)
  } finally {
    globalThis.$app = originalApp
    harness.cleanup()
  }
})

test('OneSignal service targets subscribed users with Homeping env keys', () => {
  const originalEnv = {
    appId: process.env.HOMEPING_ONESIGNAL_APPID,
    apiKey: process.env.HOMEPING_ONESIGNAL_APIKEY,
    apiUrl: process.env.HOMEPING_ONESIGNAL_APIURL,
  }
  const originalApp = globalThis.$app
  const originalHttp = globalThis.$http
  const originalServiceCache = require.cache[oneSignalServicePath]
  const appMock = createLogger()
  const requests = []

  process.env.HOMEPING_ONESIGNAL_APPID = 'homeping-app-id'
  process.env.HOMEPING_ONESIGNAL_APIKEY = 'homeping-rest-key'
  process.env.HOMEPING_ONESIGNAL_APIURL = 'https://api.onesignal.test'
  globalThis.$app = appMock
  globalThis.$http = {
    send(config) {
      requests.push(config)
      return {
        statusCode: 200,
        json: {
          id: 'notification-id',
        },
      }
    },
  }

  delete require.cache[oneSignalServicePath]

  try {
    const oneSignalService = require(oneSignalServicePath)
    const response = oneSignalService.sendPushNotification({
      title: 'Homeping 신규 공고',
      contents: '안양 신규 공고',
      url: 'https://homeping.test',
    })
    const payload = JSON.parse(requests[0].body)

    assert.equal(response.id, 'notification-id')
    assert.equal(requests[0].url, 'https://api.onesignal.test/notifications')
    assert.equal(requests[0].headers.Authorization, 'Key homeping-rest-key')
    assert.equal(payload.app_id, 'homeping-app-id')
    assert.equal(payload.target_channel, 'push')
    assert.deepEqual(payload.included_segments, ['Subscribed Users'])
    assert.equal(payload.headings.ko, 'Homeping 신규 공고')
    assert.equal(payload.contents.ko, '안양 신규 공고')
    assert.equal(payload.url, 'https://homeping.test')
  } finally {
    if (originalEnv.appId === undefined) {
      delete process.env.HOMEPING_ONESIGNAL_APPID
    } else {
      process.env.HOMEPING_ONESIGNAL_APPID = originalEnv.appId
    }

    if (originalEnv.apiKey === undefined) {
      delete process.env.HOMEPING_ONESIGNAL_APIKEY
    } else {
      process.env.HOMEPING_ONESIGNAL_APIKEY = originalEnv.apiKey
    }

    if (originalEnv.apiUrl === undefined) {
      delete process.env.HOMEPING_ONESIGNAL_APIURL
    } else {
      process.env.HOMEPING_ONESIGNAL_APIURL = originalEnv.apiUrl
    }

    globalThis.$app = originalApp
    globalThis.$http = originalHttp

    if (originalServiceCache) {
      require.cache[oneSignalServicePath] = originalServiceCache
    } else {
      delete require.cache[oneSignalServicePath]
    }
  }
})
