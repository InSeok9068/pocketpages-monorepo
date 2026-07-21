import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({ serviceName: 'dulkong' })
})

after(async () => {
  if (service) await service.stop()
})

test('unauthenticated app routes redirect to sign in', async () => {
  for (const path of ['/', '/memories', '/chat', '/us']) {
    const response = await fetch(`${service.baseUrl}${path}`, { redirect: 'manual' })

    assert.equal(response.status, 303)
    assert.match(response.headers.get('location') || '', /^\/sign-in/)
  }
})

test('GET /sign-in renders the two-person login and PWA metadata', async () => {
  const response = await fetch(`${service.baseUrl}/sign-in`)
  const body = await response.text()
  const $ = load(body)

  assert.equal(response.status, 200)
  assert.equal($('h1').first().text().trim(), '둘콩')
  assert.equal($('input[name="profileKey"]').length, 2)
  assert.deepEqual(
    $('input[name="profileKey"]')
      .map((_index, element) => $(element).attr('value'))
      .get(),
    ['inseok', 'solmi']
  )
  assert.equal($('#app-shell').length, 1)
  assert.equal($('#app-toast[data-show="$appToastMessage"]').length, 1)
  assert.match($('link[rel="manifest"]').attr('href') || '', /^\/assets\/manifest\..+\.webmanifest$/)
  assert.match($('link[rel="apple-touch-icon"]').attr('href') || '', /^\/assets\/apple-touch-icon\..+\.png$/)
})

test('Datastar login validation patches the global toast', async () => {
  const response = await fetch(`${service.baseUrl}/xapi/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Datastar-Request': 'true' },
    body: JSON.stringify({ profileKey: '', password: '' }),
  })
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
  assert.match(body, /event: datastar-patch-signals/)
  assert.match(body, /appToastMessage/)
  assert.match(body, /인석과 솔미 중에서 선택해 주세요\./)
})

test('FilePond preview assets are served locally', async () => {
  for (const path of [
    '/assets/vendor/filepond-4.32.12.min.css',
    '/assets/vendor/filepond-4.32.12.min.js',
    '/assets/vendor/filepond-plugin-image-preview-4.6.12.min.css',
    '/assets/vendor/filepond-plugin-image-preview-4.6.12.min.js',
  ]) {
    const response = await fetch(`${service.baseUrl}${path}`)

    assert.equal(response.status, 200)
  }
})
