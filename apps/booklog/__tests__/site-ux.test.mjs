import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'
import { chromium } from '@playwright/test'
import { startService } from '@pocketpages/test-support/service-harness'
import { readCookieHeader } from '@pocketpages/test-support/auth-cookie'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const bookPath = '/books/book00000000001'
let fixtureDir
let service
let cookie
let browser

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-site-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:18095' }"
    )
  )
  const binary = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'
  copyFileSync(path.join(serviceDir, binary), path.join(fixtureDir, binary))
  symlinkSync(realpathSync(path.join(serviceDir, 'node_modules')), path.join(fixtureDir, 'node_modules'), 'junction')
  const schema = JSON.parse(readFileSync(path.join(serviceDir, 'pb_schema.json'), 'utf8')).filter(
    (collection) => collection.name !== '_superusers'
  )
  writeFileSync(path.join(fixtureDir, 'pb_hooks/test-schema.json'), JSON.stringify(schema))
  copyFileSync(
    new URL('./fixtures/site-ux-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(path.join(fixtureDir, '.env'), 'APP_ENV=production\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n')
  service = await startService({ serviceName: path.basename(fixtureDir), port: 18095, timeoutMs: 30000 })
  const response = await fetch(service.baseUrl + '/xapi/auth/sign-in', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ email: 'reader@example.com', password: 'test-password-1234' }),
  })
  cookie = readCookieHeader(response.headers)
  assert.equal(response.status, 303)
  assert.ok(cookie)
})

after(async () => {
  if (browser) await browser.close()
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-site-test-'))
    rmSync(resolved, { recursive: true, force: true })
  }
})

async function html(route) {
  const response = await fetch(service.baseUrl + route, { headers: { Cookie: cookie } })
  const source = await response.text()
  assert.equal(response.status, 200, source.slice(0, 500))
  return load(source)
}

test('Lists and HTMX fragments link to the selected record and preserve list conditions after a save', async () => {
  for (const [route, from, hash] of [
    [
      '/library?q=테스트&status=reading&sort=title&limit=100',
      '/library?q=테스트&status=reading&sort=title&limit=100',
      '',
    ],
    ['/reviews?q=저장된&limit=60', '/reviews?q=저장된&limit=60', '#book-review'],
    ['/highlights?q=저장된&limit=60', '/highlights?q=저장된&limit=60', '#highlight-'],
    [
      '/xapi/library-more?offset=50&q=테스트&status=reading&sort=title',
      '/library?q=테스트&status=reading&sort=title&limit=100',
      '',
    ],
    ['/xapi/reviews-more?offset=30&q=저장된', '/reviews?q=저장된&limit=60', '#book-review'],
    ['/xapi/highlights-more?offset=30&q=저장된', '/highlights?q=저장된&limit=60', '#highlight-'],
  ]) {
    const $ = await html(route)
    const links = $('a[data-book-detail]')
    assert.ok(links.length > 0, route)
    const url = new URL(links.first().attr('href'), service.baseUrl)
    assert.equal(new URL(url.searchParams.get('from'), service.baseUrl).href, new URL(from, service.baseUrl).href)
    assert.ok(url.hash.startsWith(hash))
    if (hash === '#highlight-') assert.equal(url.hash, '#highlight-' + url.searchParams.get('highlight'))
  }

  const from = '/library?q=테스트&status=reading&sort=title&limit=100'
  let $ = await html(bookPath + '?from=' + encodeURIComponent(from) + '&highlight=quote0000000001')
  assert.equal($('main a').first().attr('href'), from)
  assert.equal($('#highlight-quote0000000001').length, 1, 'an older highlight outside the latest 20 is included')
  assert.equal($('#book-review').length, 1)
  const response = await fetch(service.baseUrl + '/xapi/books/save-review', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
    body: new URLSearchParams({ bookId: 'book00000000001', from, reviewText: '저장 후에도 목록 유지' }),
  })
  assert.equal(response.status, 303)
  const redirect = new URL(response.headers.get('location'), service.baseUrl)
  assert.equal(redirect.searchParams.get('from'), from)
  $ = await html(redirect.pathname + redirect.search)
  assert.equal($('main a').first().attr('href'), from)
  assert.equal($('textarea[name=reviewText]').val().trim(), '저장 후에도 목록 유지')

  for (const unsafe of ['//example.com', '/library/../auth', '/library\\evil', '/reviews#other']) {
    $ = await html(bookPath + '?from=' + encodeURIComponent(unsafe))
    assert.equal($('main a').first().attr('href'), '/')
  }
})

test('Browser restores drafts, clears them after successful saves, updates expanded-list links and reveals records', async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext()
  await context.route('https://**/*', (route) => route.abort())
  await context.addCookies(
    cookie.split('; ').map((entry) => {
      const separator = entry.indexOf('=')
      return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl }
    })
  )
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(service.baseUrl + bookPath)
  const review = page.locator('textarea[name=reviewText]')
  const key = await review.getAttribute('data-review-draft-key')
  await review.fill('아직 저장하지 않은 긴 감상평\n둘째 줄')
  await page.reload()
  assert.equal(await review.inputValue(), '아직 저장하지 않은 긴 감상평\n둘째 줄')

  // A failed server validation must not clear the locally preserved text.
  await page.locator('input[name=bookId]').evaluateAll((inputs) =>
    inputs.forEach((input) => {
      input.value = 'missingbook0001'
    })
  )
  await page.getByRole('button', { name: '감상평 저장', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await page.goto(service.baseUrl + bookPath)
  assert.equal(await review.inputValue(), '아직 저장하지 않은 긴 감상평\n둘째 줄')
  await page.getByRole('button', { name: '감상평 저장', exact: true }).click()
  await page.waitForURL((url) => url.pathname === bookPath && url.search.includes('from='))
  await page.waitForFunction((draftKey) => globalThis.localStorage.getItem(draftKey) === null, key)
  assert.equal((await review.inputValue()).trim(), '아직 저장하지 않은 긴 감상평\n둘째 줄')

  await page.goto(service.baseUrl + '/library?q=테스트&status=reading&sort=title')
  await page.getByRole('link', { name: '더 보기', exact: true }).click()
  await page.waitForFunction(() => globalThis.document.querySelectorAll('a[data-book-detail]').length === 55)
  await page.waitForFunction(() =>
    new URL(globalThis.document.querySelector('a[data-book-detail]').href).searchParams
      .get('from')
      .includes('limit=100')
  )
  await page.locator('a[data-book-detail]').first().click()
  await page.getByRole('link', { name: '도서함으로', exact: true }).click()
  assert.equal(new URL(page.url()).searchParams.get('limit'), '100')
  await page.waitForFunction(() => globalThis.document.querySelectorAll('a[data-book-detail]').length === 55)
  assert.equal(await page.locator('a[data-book-detail]').count(), 55)

  await page.goto(service.baseUrl + bookPath + '?highlight=quote0000000001#highlight-quote0000000001')
  assert.equal(
    await page
      .locator('#highlight-quote0000000001')
      .evaluate((element) => element.classList.contains('booklog-linked-section')),
    true
  )
  const position = await page.locator('#highlight-quote0000000001').boundingBox()
  assert.ok(position.y >= 0 && position.y < 720)
  await page.goto(service.baseUrl + '/')
  await page.clock.install()
  await page.evaluate(() => {
    globalThis.HTMLFormElement.prototype.submit = function () {}
  })
  await page.getByRole('button', { name: '책 추가', exact: true }).click()
  await page
    .locator('input[name=epubFile]')
    .setInputFiles({ name: 'test.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('test') })
  await page.getByRole('button', { name: '업로드', exact: true }).click()
  await page.clock.runFor(9000)
  assert.equal(await page.getByRole('heading', { name: '업로드 중입니다', exact: true }).isVisible(), true)
  assert.equal(await page.locator('[x-text="uploadElapsedLabel"]').textContent(), '9초')
  assert.equal(await page.getByText('현재 단계', { exact: true }).count(), 0)
  assert.equal(await page.locator('[x-bind\\:style]').count(), 0)
  assert.deepEqual(errors, [])
  await context.close()
})
