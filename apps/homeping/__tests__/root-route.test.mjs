import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const serviceDir = path.resolve(testDir, '..')
const serviceEnv = parseEnvFile(path.join(serviceDir, '.env'))
const dataApiKey = String(process.env.DATAGOKR_APIKEY || serviceEnv.DATAGOKR_APIKEY || '').trim()
const liveTestSkipReason = dataApiKey ? false : 'DATAGOKR_APIKEY is required for live Homeping route tests'

let service

/**
 * .env 파일을 단순 key=value 구조로 읽습니다.
 * @param {string} envFilePath 환경 파일 경로
 * @returns {Record<string, string>} 환경 값
 */
function parseEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    return {}
  }

  const entries = {}
  const source = readFileSync(envFilePath, 'utf8')

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')

    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()

    if (!key) {
      continue
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    entries[key] = value
  }

  return entries
}

async function findExistingHomepingService() {
  const baseUrl = 'http://127.0.0.1:8090'

  try {
    const response = await fetch(`${baseUrl}/assets/favicon.svg`, {
      signal: AbortSignal.timeout(1200),
    })
    const body = await response.text()

    if (response.status === 200 && body.includes('Homeping')) {
      return {
        baseUrl: baseUrl,
        async stop() {},
      }
    }
  } catch {
    return null
  }

  return null
}

before(async () => {
  if (!dataApiKey) {
    return
  }

  service =
    (await findExistingHomepingService()) ||
    (await startService({
      serviceName: 'homeping',
      timeoutMs: 60000,
    }))
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / renders the live Homeping search page through the service harness', { skip: liveTestSkipReason }, async () => {
  const response = await fetch(`${service.baseUrl}/?region=anyang&showClosed=1`)
  const body = await response.text()
  const $ = load(body)
  const countText = $('.hp-count').first().text().trim()
  const summaryLabels = $('.hp-summary-name')
    .map((_, element) => $(element).text().trim())
    .get()
  const regionLabels = $('.hp-region-option span')
    .map((_, element) => $(element).text().trim())
    .get()

  assert.equal(response.status, 200)
  assert.equal($('title').text().trim(), 'Homeping')
  assert.equal($('h1').first().text().trim(), '안양시 청약 공고')
  assert.equal($('.hp-meta').first().text().includes('최근 6개월'), true)
  assert.equal($('.hp-meta').first().text().includes('위치정보 미사용'), false)
  assert.equal($('input[name="showClosed"]').prop('checked'), true)
  assert.equal($('[data-hp-notification-button]').attr('data-region'), 'anyang')
  assert.equal($('[data-hp-notification-button]').attr('data-include-closed'), '1')
  assert.equal($('[data-hp-notification-label]').first().text().trim(), '알림 받기')
  assert.deepEqual(regionLabels, ['전체', '안양시', '의왕시', '과천시', '성남시', '용인시'])
  assert.equal($('[data-hp-detail-modal]').length, 1)
  assert.match(countText, /^\d+건$/u)
  assert.equal(summaryLabels.includes('APT 분양'), true)
  assert.equal(summaryLabels.includes('LH 분양주택'), true)
  assert.equal(summaryLabels.includes('LH 임대주택'), true)
  assert.equal(body.includes('PocketPages Error'), false)
  assert.equal($('.hp-error').length, 0)
})

test('GET / serves Homeping static assets through hashed asset links', { skip: liveTestSkipReason }, async () => {
  const response = await fetch(`${service.baseUrl}/?region=anyang`)
  const body = await response.text()
  const $ = load(body)
  const stylesheetHref = $('link[rel="stylesheet"]').attr('href') || ''
  const faviconHref = $('link[rel="icon"]').attr('href') || ''
  const manifestHref = $('link[rel="manifest"]').attr('href') || ''
  const oneSignalSdkSrc = $('script[src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js"]').attr('src') || ''
  const lhDetailAssetSrc = $('script[src*="/assets/lh-detail."]').attr('src') || ''
  const oneSignalAssetSrc = $('script[src*="/assets/onesignal."]').attr('src') || ''

  assert.equal(response.status, 200)
  assert.match(stylesheetHref, /^\/assets\/style\.[a-f0-9]+\.css$/u)
  assert.match(faviconHref, /^\/assets\/favicon\.[a-f0-9]+\.svg$/u)
  assert.match(manifestHref, /^\/assets\/manifest\.[a-f0-9]+\.json$/u)
  assert.equal(oneSignalSdkSrc, 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js')
  assert.match(lhDetailAssetSrc, /^\/assets\/lh-detail\.[a-f0-9]+\.js$/u)
  assert.match(oneSignalAssetSrc, /^\/assets\/onesignal\.[a-f0-9]+\.js$/u)
  assert.equal(body.includes('5bb6b0ff-fe97-4753-9ce8-508e6048a518'), true)
  assert.equal($('meta[name="theme-color"]').attr('content'), '#f5f6f2')

  const stylesheetResponse = await fetch(`${service.baseUrl}${stylesheetHref}`)
  const faviconResponse = await fetch(`${service.baseUrl}${faviconHref}`)
  const manifestResponse = await fetch(`${service.baseUrl}${manifestHref}`)
  const lhDetailAssetResponse = await fetch(`${service.baseUrl}${lhDetailAssetSrc}`)
  const oneSignalAssetResponse = await fetch(`${service.baseUrl}${oneSignalAssetSrc}`)
  const oneSignalWorkerResponse = await fetch(`${service.baseUrl}/OneSignalSDKWorker.js`)
  const faviconBody = await faviconResponse.text()
  const manifestPayload = await manifestResponse.json()
  const lhDetailAssetBody = await lhDetailAssetResponse.text()
  const oneSignalAssetBody = await oneSignalAssetResponse.text()
  const oneSignalWorkerBody = await oneSignalWorkerResponse.text()

  assert.equal(stylesheetResponse.status, 200)
  assert.match(stylesheetResponse.headers.get('content-type') || '', /^text\/css/u)
  assert.equal(faviconResponse.status, 200)
  assert.match(faviconResponse.headers.get('content-type') || '', /^image\/svg\+xml/u)
  assert.equal(faviconBody.includes('Homeping'), true)
  assert.equal(manifestResponse.status, 200)
  assert.match(manifestResponse.headers.get('content-type') || '', /manifest|json/u)
  assert.equal(manifestPayload.short_name, 'Homeping')
  assert.equal(manifestPayload.display, 'standalone')
  assert.equal(manifestPayload.icons[0].src, '/assets/favicon.svg')
  assert.equal(lhDetailAssetResponse.status, 200)
  assert.match(lhDetailAssetResponse.headers.get('content-type') || '', /javascript/u)
  assert.equal(lhDetailAssetBody.includes('/api/lh-notice-detail'), true)
  assert.equal(oneSignalAssetResponse.status, 200)
  assert.match(oneSignalAssetResponse.headers.get('content-type') || '', /javascript/u)
  assert.equal(oneSignalAssetBody.includes('OneSignalDeferred'), true)
  assert.equal(oneSignalWorkerResponse.status, 200)
  assert.equal(oneSignalWorkerBody.includes('OneSignalSDK.sw.js'), true)
})
