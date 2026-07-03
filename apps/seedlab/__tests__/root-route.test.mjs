import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({
    serviceName: 'seedlab',
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / returns the seedlab home page', async () => {
  const response = await fetch(`${service.baseUrl}/`)
  const body = await response.text()
  const $ = load(body)
  const h1Text = $('h1').first().text().replace(/\s+/g, ' ').trim()
  const faviconHref = $('link[rel="icon"]').attr('href') || ''
  const manifestHref = $('link[rel="manifest"]').attr('href') || ''

  assert.equal(response.status, 200)
  assert.equal($('title').text().trim(), 'SeedLab')
  assert.equal($('link[rel="icon"]').attr('type'), 'image/svg+xml')
  assert.match(faviconHref, /^\/assets\/favicon\.[a-f0-9]+\.svg$/)
  assert.match(manifestHref, /^\/assets\/manifest\.[a-f0-9]+\.webmanifest$/)
  assert.equal($('meta[name="theme-color"]').attr('content'), '#f7f8fa')
  assert.equal(h1Text, '투자 판단을 실험해보세요')
  assert.equal($('a[href="/sign-up"]').length > 0, true)
  assert.equal($('a[href="/sign-in"]').length > 0, true)
  assert.equal($('[data-nav-key]').length, 0)
})

test('GET /assets/manifest.webmanifest returns PWA icon metadata', async () => {
  const response = await fetch(`${service.baseUrl}/assets/manifest.webmanifest`)
  const manifest = await response.json()

  assert.equal(response.status, 200)
  assert.equal(manifest.name, 'SeedLab')
  assert.equal(manifest.short_name, 'SeedLab')
  assert.equal(manifest.icons.some((icon) => icon.src === '/assets/favicon.svg' && icon.type === 'image/svg+xml'), true)
  assert.equal(manifest.icons.some((icon) => icon.src === '/assets/icon-192.png' && icon.sizes === '192x192'), true)
  assert.equal(manifest.icons.some((icon) => icon.src === '/assets/icon-512.png' && icon.sizes === '512x512'), true)
  assert.equal(manifest.icons.some((icon) => icon.src === '/assets/icon-512-maskable.png' && icon.purpose === 'maskable'), true)
})
