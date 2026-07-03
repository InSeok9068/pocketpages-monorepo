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

  assert.equal(response.status, 200)
  assert.equal($('h1').first().text().trim(), 'seedlab')
})
