import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({
    serviceName: 'mom-calendar',
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / returns the Mom Calendar home page', async () => {
  const response = await fetch(`${service.baseUrl}/`)
  const body = await response.text()
  const $ = load(body)

  assert.equal(response.status, 200)
  assert.equal($('title').text(), '맘캘린더')
  assert.match($('link[rel="manifest"]').attr('href'), /^\/assets\/manifest\.[a-f0-9]+\.webmanifest$/)
  assert.match($('link[rel="icon"]').attr('href'), /^\/assets\/favicon\.[a-f0-9]+\.svg$/)
  assert.equal($('#calendar').length, 1)
  assert.equal($('#summary-days').length, 1)
})
