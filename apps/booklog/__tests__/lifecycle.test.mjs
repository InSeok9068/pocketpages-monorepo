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
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'
import { startService } from '@pocketpages/test-support/service-harness'
import { readCookieHeader } from '@pocketpages/test-support/auth-cookie'

const require = createRequire(new URL('../package.json', import.meta.url))
const { zipSync, strToU8 } = require('fflate')
const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const port = 18101
const email = 'journey@example.com'
const password = 'journey-password-1'
const title = '생애 첫 책'
const quote = '처음 밑줄을 그은 문장입니다.'
let fixtureDir
let service
let cookie = ''
let book = { bookId: '', bookFileId: '' }

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-lifecycle-test-'))
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
    new URL('./fixtures/lifecycle-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-lifecycle-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function send(route, input) {
  return fetch(service.baseUrl + route, {
    method: input ? 'POST' : 'GET',
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
    body: input instanceof FormData ? input : input ? new URLSearchParams(input) : undefined,
  })
}

async function page(route) {
  const response = await send(route)
  const source = await response.text()
  assert.equal(response.status, 200, route + ' ' + source.slice(0, 300))
  return load(source)
}

async function api(route, input) {
  const response = await send(route, input)
  const payload = await response.json()
  assert.equal(response.status, 200, route + ' ' + JSON.stringify(payload))
  return payload
}

async function state() {
  const response = await fetch(
    service.baseUrl
      + '/_test/lifecycle/state?email='
      + encodeURIComponent(email)
      + '&bookId='
      + encodeURIComponent(book.bookId)
  )
  return response.json()
}

function flash(response) {
  return decodeURIComponent(response.headers.get('location') || '')
}

function buildEpub() {
  const paragraphs = Array.from({ length: 30 }, (_, index) => '<p>첫 책의 ' + (index + 1) + '번째 문단입니다.</p>')
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">journey-book</dc:identifier><dc:title>'
        + title
        + '</dc:title><dc:creator>여정 저자</dc:creator><dc:language>ko</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
    ),
    'OPS/c1.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>1장</h1>' + paragraphs.join('') + '</body></html>'
    ),
  })
}

test('A new reader signs up, waits for approval, adds a book, reads it to the end and sees it in every record', async () => {
  const signUp = await send('/xapi/auth/sign-up', { email, password, passwordConfirm: password })
  assert.equal(signUp.status, 303)
  cookie = readCookieHeader(signUp.headers)
  assert.ok(cookie, 'signing up signs the reader in')
  assert.notEqual((await send('/library')).status, 200, 'the library stays closed before approval')

  const approval = await fetch(service.baseUrl + '/_test/lifecycle/approve?email=' + encodeURIComponent(email), {
    method: 'POST',
  })
  assert.equal(approval.status, 200, await approval.text())
  cookie = ''
  const signIn = await send('/xapi/auth/sign-in', { email, password })
  assert.equal(signIn.status, 303)
  assert.match(flash(signIn), /^\/\?/, flash(signIn))
  cookie = readCookieHeader(signIn.headers)
  assert.ok((await page('/library')).text().includes('도서함'))

  const bytes = buildEpub()
  const form = new FormData()
  form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), 'first-book.epub')
  const upload = await send('/xapi/epub/upload', form)
  assert.equal(upload.status, 303, flash(upload))
  book = await state()
  assert.equal(book.shelfCount, 1, flash(upload))
  assert.ok((await page('/library')).text().includes(title))

  const detail = await page('/books/' + book.bookId)
  assert.ok(detail.text().includes(title))
  await page('/books/' + book.bookId + '/read')
  const file = await send('/xapi/books/' + book.bookId + '/read-file')
  assert.equal(file.status, 200)
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes, 'the reader gets back the uploaded EPUB')

  const position = { bookId: book.bookId, locator: 'epubcfi(/6/2!/4/20/1:0)', href: 'c1.xhtml' }
  const loadedBefore = await api('/api/books/load-progress', { bookId: book.bookId })
  assert.equal(loadedBefore.hasSavedPosition, false)
  await api('/api/books/save-progress', {
    ...position,
    chapterLabel: '1장',
    progressPercent: '40',
    baseLocator: '',
  })
  const loaded = await api('/api/books/load-progress', { bookId: book.bookId })
  assert.deepEqual(
    {
      locator: loaded.locator,
      href: loaded.href,
      chapterLabel: loaded.chapterLabel,
      progressPercent: loaded.progressPercent,
    },
    { locator: position.locator, href: position.href, chapterLabel: '1장', progressPercent: '40' }
  )

  const endedAt = new Date()
  await api('/api/books/save-reading-session', {
    sessionId: 'journeysession1',
    bookId: book.bookId,
    bookFileId: book.bookFileId,
    startedAt: new Date(endedAt.getTime() - 30 * 60_000).toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds: '1800',
    startProgressPercent: '0',
    endProgressPercent: '40',
    startLocator: 'epubcfi(/6/2!/4/2/1:0)',
    endLocator: position.locator,
    startHref: 'c1.xhtml',
    endHref: 'c1.xhtml',
    startChapterLabel: '1장',
    endChapterLabel: '1장',
  })

  await api('/api/books/save-highlight', {
    ...position,
    quoteText: quote,
    noteText: '첫 메모',
    chapterLabel: '1장',
  })
  const highlights = await api('/api/books/list-highlights', { bookId: book.bookId, bookFileId: book.bookFileId })
  assert.deepEqual(
    highlights.highlights.map((item) => item.quoteText),
    [quote]
  )
  await api('/api/books/save-bookmark', {
    ...position,
    bookFileId: book.bookFileId,
    chapterLabel: '1장',
    progressPercent: '40',
  })
  const bookmarks = await api('/api/books/list-bookmarks', { bookId: book.bookId, bookFileId: book.bookFileId })
  assert.equal(bookmarks.bookmarks.length, 1)
  assert.equal(bookmarks.bookmarks[0].locator, position.locator)

  const review = await send('/xapi/books/save-review', { bookId: book.bookId, reviewText: '끝까지 읽은 첫 책' })
  assert.equal(review.status, 303, flash(review))
  const finished = await send('/xapi/books/update-status', { bookId: book.bookId, status: 'finished' })
  assert.equal(finished.status, 303)
  assert.match(flash(finished), /완독으로 표시했습니다/)
  const shelf = await state()
  assert.equal(shelf.status, 'finished')
  assert.equal(shelf.progressPercent, 100)
  assert.deepEqual(shelf.personal, { sessions: 1, highlights: 1, bookmarks: 1, reviews: 1 })

  const records = await page('/reading-records')
  assert.ok(records.text().includes('30분'), 'this week shows the 30 minutes read')
  assert.ok(records.text().includes('1권'), 'the finished count includes the book')
  assert.ok(records.text().includes(title), 'the day breakdown names the book')
  const home = await page('/')
  assert.ok(home.text().includes('이번 주 1일 읽었어요'))
  assert.match(home.html(), /finished: 1,/)
  assert.ok((await page('/highlights')).text().includes(quote))
  assert.ok((await page('/reviews')).text().includes('끝까지 읽은 첫 책'))
})

test('Taking the book off the shelf clears every personal record but keeps the shared book and file', async () => {
  assert.ok(book.bookId, 'runs after the reading journey')
  const removed = await send('/xapi/books/remove-from-shelf', { bookId: book.bookId })
  assert.equal(removed.status, 303)
  assert.match(flash(removed), /내 도서함에서 책을 제거했습니다/)

  const after = await state()
  assert.equal(after.shelfCount, 0)
  assert.deepEqual(after.personal, { sessions: 0, highlights: 0, bookmarks: 0, reviews: 0 })
  assert.equal(after.sharedBooks, 1, 'the book stays for other readers who shelve the same file')
  assert.equal(after.sharedFiles, 1)

  assert.ok(!(await page('/library')).text().includes(title))
  assert.ok((await page('/highlights')).text().includes('아직 저장된 인상 깊은 문구가 없습니다.'))
  const records = await page('/reading-records')
  assert.ok(!records.text().includes(title))
  assert.ok(records.text().includes('0권'))
  assert.notEqual((await send('/xapi/books/' + book.bookId + '/read-file')).status, 200, 'the file is no longer served')
  const position = await send('/api/books/load-progress', { bookId: book.bookId })
  assert.notEqual(position.status, 200)
})
