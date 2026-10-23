/* global window, document */
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
  writeFileSync(
    path.join(fixtureDir, 'pb_hooks/pages/_private/data4library-service.js'),
    readFileSync(new URL('./fixtures/data4library-stub.js', import.meta.url), 'utf8')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
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

test('Home counts every shelf book and points to the library when the chosen status is beyond the first 50', async () => {
  const $ = await html('/')
  const data = $('[x-data*="loadedShelfStatusCounts"]').attr('x-data')
  assert.match(data, /shelfStatusCounts: \{\s*queued: 0,\s*reading: 55,\s*finished: 1,/)
  assert.match(data, /loadedShelfStatusCounts: \{\s*queued: 0,\s*reading: 50,\s*finished: 0,/)

  const homeBrowser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await homeBrowser.newContext()
    await context.route('https://**/*', (route) => route.abort())
    await context.addCookies(
      cookie.split('; ').map((entry) => {
        const separator = entry.indexOf('=')
        return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl }
      })
    )
    await context.addInitScript(() =>
      globalThis.localStorage.setItem(
        'booklog.home.shelfFilters',
        JSON.stringify({ queued: false, reading: false, finished: true })
      )
    )
    const page = await context.newPage()
    await page.goto(service.baseUrl + '/')
    const link = page.getByRole('link', { name: '도서함에서 모두 보기' })
    await link.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await link.getAttribute('href'), '/library?status=finished')
    assert.equal(await page.getByText('선택한 상태의 책이 없습니다.').isVisible(), false)
  } finally {
    await homeBrowser.close()
  }
})

test('The popular page shows rising books at once, loads the ranking separately, then serves it from cache', async () => {
  const first = await html('/popular')
  const menuLinks = first('header a, nav a, [x-show="open"] a')
    .map((_, element) => first(element).text().trim())
    .get()
  assert.equal(menuLinks[menuLinks.indexOf('EPUB 도서관') + 1], '인기 도서')
  assert.equal(first('h1').text().trim(), '인기 도서')
  assert.equal(first('[data-hot-book]').length, 1)
  assert.match(first('[data-hot-book]').text(), /급상승 책[\s\S]*순위 42계단 상승/)
  assert.equal(first('#popular-list').attr('hx-get'), '/xapi/popular-list?tab=month')
  assert.deepEqual(
    first('a[href*="aladin.co.kr"], a[href*="kyobobook.co.kr"]')
      .map((_, element) => [first(element).attr('target'), first(element).attr('rel')])
      .get(),
    ['_blank', 'noopener noreferrer', '_blank', 'noopener noreferrer']
  )

  const list = await html('/xapi/popular-list?tab=month')
  const books = list('[data-popular-book]')
  assert.equal(list('h1').length, 0, 'the HTMX fragment has no page layout')
  assert.equal(books.length, 2, 'two editions of the same book count once')
  assert.equal(
    books.eq(0).find('[data-book-link]').attr('href'),
    '/books/finishedbook001?from=' + encodeURIComponent('/popular?tab=month')
  )
  assert.equal(books.eq(0).find('[data-book-link]').attr('target'), undefined)
  assert.match(books.eq(0).text(), /도서함에 있음[\s\S]*완독한 책[\s\S]*첫 저자[\s\S]*대출 4,999회/)
  assert.equal(books.eq(1).find('[data-book-link]').attr('href'), 'https://data4library.kr/bookV?isbn=9791100000002')
  assert.equal(books.eq(1).find('[data-book-link]').attr('target'), '_blank')
  assert.doesNotMatch(books.eq(1).text(), /도서함에 있음/)
  assert.equal(books.eq(0).find('button[aria-label="도서명 복사"]').attr('data-copy-text'), '완독한 책')

  const detail = await html(books.eq(0).find('[data-book-link]').attr('href'))
  assert.equal(detail('a[href="/popular?tab=month"]').first().text().trim(), '인기 도서로')
  assert.equal(detail('input[name="from"]').first().val(), '/popular?tab=month')

  const cached = await html('/popular')
  assert.equal(cached('#popular-list').attr('hx-get'), undefined)
  assert.equal(cached('[data-popular-book]').length, 2)
})

test('When the ranking cannot be loaded, the popular page still opens and explains the failure', async () => {
  const page = await html('/popular?tab=steady')
  assert.equal(page('nav[aria-label="인기 도서 기간"] a[aria-current="page"]').text().trim(), '스테디셀러')
  assert.equal(page('#popular-list').attr('hx-get'), '/xapi/popular-list?tab=steady')

  const list = await html('/xapi/popular-list?tab=steady')
  assert.match(list('#popular-list').text(), /지금은 목록을 불러오지 못했어요/)
  assert.equal(list('[data-popular-book]').length, 0)
})

test('The copy button puts the book title on the clipboard without opening the book', async () => {
  const copyBrowser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await copyBrowser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    await context.route('https://**/*', (route) => route.abort())
    await context.addCookies(
      cookie.split('; ').map((entry) => {
        const separator = entry.indexOf('=')
        return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl }
      })
    )
    const page = await context.newPage()
    await page.goto(service.baseUrl + '/popular?tab=month')
    const list = page.locator('#popular-list')
    const copy = list.getByRole('button', { name: '도서명 복사' }).first()
    await copy.waitFor({ state: 'visible', timeout: 10000 })
    await copy.click()

    assert.equal(await page.evaluate(() => globalThis.navigator.clipboard.readText()), '완독한 책')
    await list.getByRole('button', { name: '도서명을 복사했습니다' }).first().waitFor({ timeout: 3000 })
    assert.equal(new URL(page.url()).pathname, '/popular')
    assert.equal(context.pages().length, 1)

    await page.locator('[data-hot-book]').getByRole('button', { name: '도서명 복사' }).click()
    assert.equal(await page.evaluate(() => globalThis.navigator.clipboard.readText()), '급상승 책')
  } finally {
    await copyBrowser.close()
  }
})

test('The early-morning job refreshes the lists inside PocketBase and the page then shows them at once', async () => {
  const response = await fetch(service.baseUrl + '/_test/popular-books-job', { method: 'POST' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { 'list:month': true, 'list:steady': false, 'hot': true })

  const month = await html('/popular?tab=month')
  assert.equal(month('#popular-list').attr('hx-get'), undefined)
  assert.equal(month('[data-popular-book]').length, 2)

  const steady = await html('/xapi/popular-list?tab=steady')
  assert.match(steady('#popular-list').text(), /지금은 목록을 불러오지 못했어요/)
})

test('Push settings still save when the push service is blocked, and push turned on gets reminders that actually send', async () => {
  browser = browser || (await chromium.launch({ channel: 'chrome', headless: true }))
  const context = await browser.newContext()
  // 광고 차단기처럼 OneSignal CDN을 막은 상태입니다.
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
  const saved = async () => (await fetch(service.baseUrl + '/_test/settings')).json()
  const reading = page.locator('#reading-reminder-cycle-input')
  const highlight = page.locator('#highlight-push-cycle-input')
  const weekly = page.locator('#weekly-reading-nudge-input')
  const push = page.locator('#push-enabled-input')
  const notice = page.locator('#push-notice')
  async function submit() {
    await page.evaluate(() => {
      window.__beforeSave = true
    })
    await page.getByRole('button', { name: '설정 저장' }).click()
    await page.waitForFunction(() => !window.__beforeSave && document.readyState === 'complete')
    assert.match(await page.locator('main').innerText(), /설정을 저장했습니다/)
  }

  assert.equal((await fetch(service.baseUrl + '/_test/settings?push=true', { method: 'POST' })).status, 200)
  await page.goto(service.baseUrl + '/settings')
  assert.equal(await reading.inputValue(), '3')
  assert.equal(await highlight.inputValue(), '7')
  assert.equal(await weekly.isChecked(), true)
  assert.match(await notice.innerText(), /알림이 모두 꺼져 있어 알림이 오지 않았습니다/)
  await submit()
  assert.deepEqual(await saved(), { push: true, reading: 3, highlight: 7, weekly: true })

  // 이 기기는 구독되지 않았고 SDK도 막혔지만, 다른 설정만 바꾸는 저장은 막지 않습니다.
  await reading.fill('10')
  await submit()
  assert.equal((await saved()).reading, 10)

  await page.getByText('푸시 알림 사용', { exact: true }).click()
  assert.equal(await push.isChecked(), false)
  await submit()
  assert.equal((await saved()).push, false, 'push can be turned off without the push service')

  await reading.fill('')
  await highlight.fill('')
  await page.getByText('주간 독서 리마인더', { exact: true }).click()
  assert.equal(await weekly.isChecked(), false)
  await page.getByText('푸시 알림 사용', { exact: true }).click()
  assert.equal(await reading.inputValue(), '3', 'turning push on fills reminders that will send')
  assert.equal(await highlight.inputValue(), '7')
  assert.equal(await weekly.isChecked(), true)
  assert.match(await notice.innerText(), /기본 알림 주기를 채웠습니다/)

  // 이 기기에서 새로 켤 때는 실제 구독이 필요하므로, 구독할 수 없으면 이유를 알리고 저장하지 않습니다.
  await page.getByRole('button', { name: '설정 저장' }).click()
  await page.getByText('푸시 설정을 불러오지 못했습니다').waitFor({ timeout: 8000 })
  assert.equal((await saved()).push, false)
  assert.deepEqual(errors, [])
  await context.close()
})
