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
      ['anyang', 'uiwang', 'gwacheon']
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
