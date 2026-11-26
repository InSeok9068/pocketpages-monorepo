import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({
    serviceName: 'launchboard',
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / redirects a guest to the sign-in page', async () => {
  const response = await fetch(`${service.baseUrl}/`)
  const body = await response.text()
  const $ = load(body)

  assert.equal(response.status, 200)
  assert.equal(new URL(response.url).pathname, '/sign-in')
  assert.equal($('h1').first().text().trim(), '로그인')
})
