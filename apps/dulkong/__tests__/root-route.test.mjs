import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({
    serviceName: 'dulkong',
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / returns the dulkong home page', async () => {
  const response = await fetch(`${service.baseUrl}/`)
  const body = await response.text()
  const $ = load(body)

  assert.equal(response.status, 200)
  assert.match($('title').text(), /둘콩/)
  assert.equal($('h1').first().text().replace(/\s+/g, ' ').trim(), '오늘도 우리답게 🌱')
  assert.equal($('nav[aria-label="하단 메뉴"] a').length, 4)
  assert.equal($('#app-shell').length, 1)
  assert.equal($('#app-view').length, 1)
  assert.equal($('#app-toast[data-show="$appToastMessage"]').length, 1)
})

for (const page of [
  { path: '/memories', title: '추억' },
  { path: '/chat', title: '내 사랑콩' },
  { path: '/us', title: '우리' },
]) {
  test(`GET ${page.path} returns an app tab`, async () => {
    const response = await fetch(`${service.baseUrl}${page.path}`)
    const body = await response.text()
    const $ = load(body)

    assert.equal(response.status, 200)
    assert.equal($('h1').first().text().trim(), page.title)
    assert.equal($(`nav[aria-label="하단 메뉴"] a[href="${page.path}"]`).attr('aria-current'), 'page')
  })
}

test('Datastar validation error patches the global toast', async () => {
  const response = await fetch(`${service.baseUrl}/xapi/auth/sign-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Datastar-Request': 'true',
    },
    body: JSON.stringify({ email: '', password: '' }),
  })
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
  assert.match(body, /event: datastar-patch-signals/)
  assert.match(body, /appToastMessage/)
  assert.match(body, /이메일이 필요합니다\./)
})
