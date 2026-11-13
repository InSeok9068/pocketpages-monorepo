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
  copyFileSync(
    new URL('./fixtures/book-recommendation-ai-stub.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/book-recommendation-ai-stub.js')
  )
  const recommendRoute = path.join(fixtureDir, 'pb_hooks/pages/xapi/books/recommend.ejs')
  writeFileSync(
    recommendRoute,
    readFileSync(recommendRoute, 'utf8').replace(
      "require('@pocketpages/ai')",
      "require(__hooks + '/book-recommendation-ai-stub.js')"
    )
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nVERCEL_AI_GATEWAY_API_KEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
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

test('A book with more than 20 quotes links to a list of only its quotes, which keeps the filter while paging', async () => {
  const bookHighlights = '/highlights?book=book00000000001'
  let $ = await html(bookPath)
  assert.equal($('article[id^="highlight-"]').length, 20)
  assert.equal($(`a[href="${bookHighlights}"]`).text().trim(), '이 책 문구 전체 55개 보기')
  $ = await html('/books/book00000000002')
  assert.equal($('a[href^="/highlights?book="]').length, 0, 'a book with few quotes shows them all without the link')

  $ = await html('/highlights')
  assert.ok($('body').text().includes('다른 책의 문구'), 'the unfiltered list shows every book')

  $ = await html(bookHighlights)
  assert.equal($('main a').first().attr('href'), bookPath, 'the back link returns to the book')
  assert.ok($('body').text().includes('의 문구만 보고 있어요.'))
  assert.equal($('a[href="/highlights"]').text().trim(), '전체 문구 보기')
  assert.equal($('input[type=hidden][name=book]').val(), 'book00000000001', 'searching stays within the book')
  let links = $('a[data-book-detail]')
  assert.equal(links.length, 30)
  assert.ok(!$('body').text().includes('다른 책의 문구'))
  const from = new URL(links.first().attr('href'), service.baseUrl).searchParams.get('from')
  assert.equal(from, bookHighlights, 'a quote opened from here comes back to the filtered list')
  const more = $('#highlights-more-control a')
  assert.equal(more.attr('hx-push-url'), bookHighlights + '&limit=60')

  $ = await html(more.attr('hx-get'))
  links = $('a[data-book-detail]')
  assert.equal(links.length, 25, 'the second page holds the remaining quotes of this book only')
  assert.ok(
    links.toArray().every((link) =>
      $(link)
        .attr('href')
        .startsWith(bookPath + '?')
    )
  )
  assert.equal($('#highlights-more-control').length, 0)

  $ = await html('/highlights?book=' + encodeURIComponent("x' OR 1=1"))
  assert.ok($('body').text().includes('다른 책의 문구'), 'an invalid book filter is ignored')
  assert.ok(!$('body').text().includes('의 문구만 보고 있어요.'))
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

test('Only popular exposes recommendations and its mobile dialog submits safely and restores focus', async () => {
  const recommendationBrowser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await recommendationBrowser.newContext({ viewport: { width: 360, height: 800 } })
    await context.route('https://**/*', (route) => route.abort())
    await context.addCookies(
      cookie.split('; ').map((entry) => {
        const separator = entry.indexOf('=')
        return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl }
      })
    )
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(service.baseUrl + '/')
    assert.equal(await page.getByRole('button', { name: 'AI 책 추천 열기' }).count(), 0)
    assert.equal(await page.locator('#book-recommendation-dialog').count(), 0)
    await page.goto(service.baseUrl + '/popular?tab=steady')
    const trigger = page.getByRole('button', { name: 'AI 책 추천 열기' })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '어떤 책을 읽을까요?' })
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.locator('form').getAttribute('hx-post'), '/xapi/books/recommend')
    assert.equal(await dialog.locator('input[name=from]').inputValue(), '/popular?tab=steady')
    assert.equal(await page.locator('#book-recommendation-dialog').count(), 1)
    await dialog.locator('textarea[name=preference]').fill('짧고 몰입감 있는 소설')
    assert.equal(await dialog.locator('select[name=source]').count(), 0)
    await dialog.getByRole('button', { name: '책 골라보기', exact: true }).click()
    await page.locator('[data-recommended-book]').first().waitFor()
    assert.equal(await page.locator('[data-recommended-book]').count(), 3)
    assert.ok((await dialog.textContent()).includes('<script>window.injected = true</script>'))
    assert.equal(await page.evaluate(() => window.injected), undefined)
    assert.equal(await dialog.locator('#book-recommendation-results script').count(), 0)
    assert.ok(
      (await dialog.getByRole('link', { name: '도서 정보 찾기' }).first().getAttribute('href')).startsWith(
        'https://data4library.kr/'
      )
    )
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await dialog.getByRole('button', { name: '책 골라보기', exact: true }).click()
    await dialog.getByText('조금 전에 책을 고르고 있어요. 잠시 후 다시 시도해 주세요.').waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    assert.deepEqual(errors, [])
    await context.close()
  } finally {
    await recommendationBrowser.close()
  }
})

test('Popular header and first card align with the library at mobile and desktop sizes', async () => {
  const headerBrowser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await headerBrowser.newContext()
    await context.route('https://**/*', (route) => route.abort())
    await context.addCookies(
      cookie.split('; ').map((entry) => {
        const separator = entry.indexOf('=')
        return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl }
      })
    )
    const page = await context.newPage()
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport)
      const layouts = []
      for (const route of ['/library', '/popular']) {
        await page.goto(service.baseUrl + route)
        layouts.push({
          title: await page.getByRole('heading', { level: 1 }).boundingBox(),
          back: await page.getByRole('link', { name: '메인으로', exact: true }).boundingBox(),
          card: await page.locator('main > section > section').first().boundingBox(),
        })
      }
      for (const [element, properties] of [
        ['title', ['x', 'y', 'height']],
        ['back', ['x', 'y', 'width', 'height']],
        ['card', ['x', 'y', 'width']],
      ]) {
        for (const property of properties) {
          assert.ok(
            Math.abs(layouts[0][element][property] - layouts[1][element][property]) < 1,
            viewport.width + 'px: ' + element + '.' + property + ': ' + JSON.stringify(layouts)
          )
        }
      }
    }
    await context.close()
  } finally {
    await headerBrowser.close()
  }
})

test('Recommendation endpoint rejects unauthenticated requests, wrong methods and invalid preference lengths', async () => {
  const unauthenticated = await fetch(service.baseUrl + '/xapi/books/recommend', {
    method: 'POST',
    headers: { 'HX-Request': 'true' },
    body: new URLSearchParams({ preference: 'test' }),
  })
  assert.equal(unauthenticated.status, 401)
  const wrongMethod = await fetch(service.baseUrl + '/xapi/books/recommend', { headers: { Cookie: cookie } })
  assert.equal(wrongMethod.status, 405)
  for (const preference of ['', '가'.repeat(501)]) {
    const response = await fetch(service.baseUrl + '/xapi/books/recommend', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: new URLSearchParams({ preference }),
    })
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes('500자 이내'))
  }
})

test('도서함의 추가일·저자 정렬은 더 보기와 전체 목록에서 같은 순서와 링크 조건을 유지한다', async () => {
  for (const sort of ['added', 'author']) {
    const route = '/library?q=테스트&status=reading&sort=' + sort
    const first = await html(route)
    const more = await html('/xapi/library-more?offset=50&q=테스트&status=reading&sort=' + sort)
    const full = await html(route + '&limit=100')
    const bookIds = ($) =>
      $('a[data-book-detail]')
        .toArray()
        .map((link) => new URL($(link).attr('href'), service.baseUrl).pathname)
    const expected = Array.from({ length: sort === 'added' ? 55 : 54 }, (_, index) =>
      sort === 'added' ? 55 - index : 54 - index
    )
    if (sort === 'author') expected.push(55)
    assert.deepEqual(
      bookIds(full),
      expected.map((number) => '/books/book' + String(number).padStart(11, '0'))
    )
    assert.deepEqual([...bookIds(first), ...bookIds(more)], bookIds(full))
    assert.equal(first('select[name="sort"]').val(), sort)
    assert.deepEqual(
      first('select[name="sort"] option')
        .toArray()
        .map((option) => first(option).text().trim()),
      ['최근 읽은 순', '최근 추가한 순', '제목순', '저자순']
    )
    assert.match(first('#library-more-control a').attr('hx-get'), new RegExp('sort=' + sort))
    const detailUrl = new URL(more('a[data-book-detail]').first().attr('href'), service.baseUrl)
    assert.equal(decodeURI(detailUrl.searchParams.get('from')), route + '&limit=100')
  }
  const fallback = await html('/library?sort=unknown')
  assert.equal(fallback('select[name="sort"]').val(), 'recent')
})

test('도서함 필터 화살표는 스크롤 영역 밖에 표시되고 끝까지 이동하거나 화면이 넓어지면 숨겨진다', async () => {
  const filterBrowser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await filterBrowser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
    await context.route('https://**/*', (route) => route.abort())
    await context.addCookies(
      cookie.split('; ').map((entry) => {
        const separator = entry.indexOf('=')
        return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl }
      })
    )
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    await page.goto(service.baseUrl + '/library')
    const arrow = page.getByRole('button', { name: '오른쪽 필터 더 보기' })
    await arrow.waitFor({ state: 'visible' })
    const listBox = await page.locator('#library-filters').boundingBox()
    const arrowBox = await arrow.boundingBox()
    assert.ok(arrowBox.x >= listBox.x + listBox.width, 'the arrow does not cover the filters')
    await arrow.click()
    await page.waitForFunction(() => document.querySelector('#library-filters').scrollLeft > 0)
    await page.locator('#library-filters').evaluate((list) => {
      list.scrollLeft = list.scrollWidth
    })
    await arrow.waitFor({ state: 'hidden' })
    await page.locator('#library-filters').evaluate((list) => {
      list.scrollLeft = 0
    })
    await arrow.waitFor({ state: 'visible' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await arrow.waitFor({ state: 'hidden' })
    assert.equal(
      await page.locator('[x-ref="filterRow"]').evaluate((row) => globalThis.getComputedStyle(row).paddingRight),
      '0px'
    )
  } finally {
    await filterBrowser.close()
  }
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

test('The popular page opens without waiting, loads rising books and the ranking separately, then serves both from cache', async () => {
  const resetCache = await fetch(service.baseUrl + '/_test/reset-popular-books-cache', { method: 'POST' })
  assert.equal(resetCache.status, 200)

  const first = await html('/popular')
  const menuLinks = first('header a, nav a, [x-show="open"] a')
    .map((_, element) => first(element).text().trim())
    .get()
  assert.equal(menuLinks[menuLinks.indexOf('EPUB 도서관') + 1], '인기 도서')
  assert.equal(first('h1').text().trim(), '인기 도서')
  assert.equal(first('[data-hot-book]').length, 0)
  assert.equal(first('#popular-hot').attr('hx-get'), '/xapi/popular-hot?tab=month')
  assert.equal(first('#popular-list').attr('hx-get'), '/xapi/popular-list?tab=month')

  const hot = await html('/xapi/popular-hot?tab=month')
  assert.equal(hot('h1').length, 0, 'the HTMX fragment has no page layout')
  assert.equal(hot('#popular-hot [data-hot-book]').length, 1)
  assert.match(hot('[data-hot-book]').text(), /급상승 책[\s\S]*순위 42계단 상승/)
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
  assert.equal(cached('#popular-hot').attr('hx-get'), undefined)
  assert.equal(cached('[data-hot-book]').length, 1)
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
  assert.match(await notice.innerText(), /받을 알림이 모두 꺼져 있어 기본 주기를 채웠습니다\. 저장하면 적용됩니다\./)
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
