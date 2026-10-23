/* global window, document */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { startService } from '@pocketpages/test-support/service-harness'

const require = createRequire(new URL('../package.json', import.meta.url))
const { zipSync, strToU8 } = require('fflate')
const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const port = 18102
let fixtureDir
let service
let browser

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-forms-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  writeFileSync(
    path.join(fixtureDir, 'pb_hooks/pages/_private/data4library-service.js'),
    readFileSync(new URL('./fixtures/data4library-stub.js', import.meta.url), 'utf8')
  )
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:" + port + "' }"
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
    new URL('./fixtures/browser-forms-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
})

after(async () => {
  if (browser) await browser.close()
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-forms-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function signedInPage() {
  const page = await (await browser.newContext()).newPage()
  await page.goto(service.baseUrl + '/auth')
  const form = page.locator('form[action="/xapi/auth/sign-in"]')
  await form.locator('input[name="email"]').fill('forms@example.com')
  await form.locator('input[name="password"]').fill('test-password-1234')
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/'),
    form.getByRole('button', { name: '로그인' }).click(),
  ])
  return page
}

function sampleEpub(title, content) {
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">'
        + title
        + '</dc:identifier><dc:title>'
        + title
        + '</dc:title><dc:creator>테스트 저자</dc:creator><dc:language>ko</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
    ),
    'OEBPS/c1.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        + (content || '<h1>1장</h1><p>' + '업로드 화면을 확인하는 본문입니다. '.repeat(80) + '</p>')
        + '</body></html>'
    ),
  })
}

test('The sign-in page shows its form before any request, and signing in through it opens the home page', async () => {
  const page = await (await browser.newContext()).newPage()
  await page.goto(service.baseUrl + '/auth')
  const form = page.locator('form[action="/xapi/auth/sign-in"]')
  await form.locator('input[name="email"][type="email"]').waitFor()
  assert.ok(await form.locator('input[name="password"][type="password"]').isVisible())
  assert.ok(await form.getByRole('button', { name: '로그인' }).isEnabled())
  await page.close()

  const signedIn = await signedInPage()
  await signedIn.getByRole('button', { name: '책 추가' }).waitFor()
  await signedIn.close()
})

test('Uploading an EPUB shows the loading screen and then the saved message on the home page', async () => {
  const uploadDir = path.join(fixtureDir, 'uploads')
  mkdirSync(uploadDir, { recursive: true })
  const generated = path.join(uploadDir, '업로드 화면 확인.epub')
  writeFileSync(generated, Buffer.from(sampleEpub('업로드 화면 확인')))
  // 서비스 문서 폴더에 실제 EPUB이 있으면 실제 책으로도 같은 흐름을 확인합니다.
  const files = [
    generated,
    ...[
      '귀하신 몸 근골격계 - 어깨부터 목, 무릎, 허리, 발목까지 14일 관절 통증 탈출 솔루션.epub',
      '모두에게 사랑받을 필요는 없다 타인에게 얽매이지 않고 온전한 나로 사는 법.epub',
    ]
      .map((name) => path.join(serviceDir, '.docs', name))
      .filter((filePath) => existsSync(filePath)),
  ]

  const page = await signedInPage()
  // 작은 파일은 응답이 너무 빨라 로딩 화면이 그려지기 전에 끝나므로, 업로드 응답만 잠시 늦춥니다.
  await page.route('**/xapi/epub/upload', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    return route.continue()
  })

  for (const filePath of files) {
    const fileName = path.basename(filePath)
    const form = page.locator('form[action="/xapi/epub/upload"]')
    await page.getByRole('button', { name: '책 추가' }).click()
    await page.getByRole('heading', { name: '도서함에 책 넣기' }).waitFor()
    await form.locator('input[name="epubFile"]').setInputFiles(filePath)
    assert.equal((await form.locator('p[x-show="uploadFileName"]').textContent()).trim(), fileName)

    const loading = page.getByRole('heading', { name: '업로드 중입니다' })
    const response = page.waitForResponse(
      (item) => new URL(item.url()).pathname === '/xapi/epub/upload' && item.request().method() === 'POST',
      { timeout: 300_000 }
    )
    await form.locator('button[type="submit"]').evaluate((button) => button.click())
    await loading.waitFor({ timeout: 10_000 })

    assert.equal((await response).status(), 303, fileName)
    await page.waitForURL((url) => url.pathname === '/')
    await page.getByText('EPUB 파일과 도서 메타데이터를 저장했습니다.', { exact: true }).waitFor()
    assert.equal(await loading.isVisible(), false, fileName)
  }
  await page.close()
})

async function openReadingBook(page, title) {
  const content = Array.from(
    { length: 80 },
    (_, index) =>
      '<p id="reading-'
      + (index + 1)
      + '">'
      + (index + 1)
      + '번째 독서 문단입니다. '
      + '읽던 문단이 서버에 저장되고 다시 열었을 때 복원되는지 확인합니다. '.repeat(5)
      + '</p>'
  ).join('')
  const upload = await page.request.post(service.baseUrl + '/xapi/epub/upload', {
    maxRedirects: 0,
    multipart: {
      epubFile: {
        name: title + '.epub',
        mimeType: 'application/epub+zip',
        buffer: Buffer.from(sampleEpub(title, content)),
      },
    },
  })
  assert.equal(upload.status(), 303)
  assert.match(decodeURIComponent(upload.headers().location || ''), /EPUB 파일과 도서 메타데이터를 저장했습니다/)
  await page.goto(service.baseUrl + '/library?q=' + encodeURIComponent(title))
  const href = await page.locator('a[data-book-detail]', { hasText: title }).getAttribute('href')
  assert.ok(href)
  const bookPath = href.split('?')[0]
  await openReader(page, bookPath)
  return bookPath
}

async function openReader(page, bookPath) {
  await page.goto(service.baseUrl + bookPath + '/read')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.Alpine?.$data(document.querySelector('section[x-data]'))
        return !!state?.bookReady && state.progressLocationsStatus === 'ready'
      })
    )
    .toBe(true)
  // 진행률 생성 직후 보내는 최초 저장까지 끝낸 다음 사용자 동작을 시작합니다.
  await page.waitForLoadState('networkidle')
}

function readingParagraph(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    const bounds = container.getBoundingClientRect()
    for (const frame of container.querySelectorAll('iframe')) {
      for (const paragraph of frame.contentDocument?.querySelectorAll('p') || []) {
        const rect = paragraph.getBoundingClientRect()
        if (frame.getBoundingClientRect().top + rect.bottom > bounds.top + 4) return paragraph.id
      }
    }
    return ''
  })
}

async function moveToParagraph(page, number) {
  await page.locator('#epub-reader .epub-container').evaluate((container, number) => {
    for (const frame of container.querySelectorAll('iframe')) {
      const paragraph = frame.contentDocument?.getElementById('reading-' + number)
      if (paragraph) {
        container.scrollTop +=
          frame.getBoundingClientRect().top
          + paragraph.getBoundingClientRect().top
          - container.getBoundingClientRect().top
        return
      }
    }
    throw new Error('독서 문단을 찾지 못했습니다: ' + number)
  }, number)
  await expect.poll(() => readingParagraph(page)).toBe('reading-' + number)
  await expect
    .poll(() =>
      page.evaluate(() => Number(window.Alpine.$data(document.querySelector('section[x-data]')).currentProgressPercent))
    )
    .toBeGreaterThan(Math.floor(((number - 1) / 80) * 100) - 5)
}

test('A new browser context restores the reading paragraph saved through the real server', async () => {
  const first = await signedInPage()
  let second
  try {
    const bookPath = await openReadingBook(first, '서버 위치 복원')
    await moveToParagraph(first, 35)
    const saved = first.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/books/save-progress' && response.request().method() === 'POST'
    )
    await first.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
    assert.equal((await saved).status(), 200)
    await first.locator('a[aria-label="뒤로가기"]').click()
    await first.waitForURL((url) => url.pathname === bookPath)
    await first.context().close()

    second = await signedInPage()
    assert.equal(
      await second.evaluate(async () =>
        (await window.indexedDB.databases()).some((db) => db.name === 'booklog-reader-cache')
      ),
      false,
      'the fresh browser context has no Booklog reader cache'
    )
    const download = second.waitForResponse(
      (response) => new URL(response.url()).pathname === '/xapi' + bookPath + '/read-file'
    )
    await openReader(second, bookPath)
    assert.equal((await download).status(), 200, 'the fresh context downloads the EPUB instead of using a device copy')
    await expect.poll(() => readingParagraph(second)).toBe('reading-35')
  } finally {
    await first.context().close()
    if (second) await second.context().close()
  }
})

test('Leaving while an earlier save response is delayed stores the latest reading paragraph', async () => {
  const page = await signedInPage()
  let releaseSave
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve
  })
  try {
    const bookPath = await openReadingBook(page, '저장 응답 지연')
    await moveToParagraph(page, 20)
    let firstStored
    const stored = new Promise((resolve) => {
      firstStored = resolve
    })
    const saves = []
    await page.route('**/api/books/save-progress', async (route) => {
      const isFirst = saves.length === 0
      saves.push(route.request())
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      if (isFirst) {
        firstStored()
        await saveGate
      }
      await route.fulfill({ response })
    })
    await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
    await stored
    await moveToParagraph(page, 60)
    await page.locator('a[aria-label="뒤로가기"]').click()
    assert.equal(saves.length, 1, 'the newer save waits until the earlier response is received')
    assert.equal(new URL(page.url()).pathname, bookPath + '/read', 'leaving waits for the queued position save')
    releaseSave()
    await page.waitForURL((url) => url.pathname === bookPath)
    assert.ok(saves.length >= 2, 'leaving sends the newer position after the first save')
    await page.unroute('**/api/books/save-progress')
    await openReader(page, bookPath)
    await expect.poll(() => readingParagraph(page)).toBe('reading-60')
    await expect(page.getByText('다른 기기에서 읽은 위치가 있어요.')).toBeHidden()
  } finally {
    releaseSave()
    await page.context().close()
  }
})
