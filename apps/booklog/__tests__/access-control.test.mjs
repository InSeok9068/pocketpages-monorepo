import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
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
import { startService } from '@pocketpages/test-support/service-harness'

const require = createRequire(new URL('../package.json', import.meta.url))
const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const bookId = 'reviewbook00001'
const filePath = '/xapi/books/' + bookId + '/read-file'
let fixtureDir
let service
const sessions = {}

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-access-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  // 외부 도서 검색만 고정하고 업로드·EPUB 파싱·DB 저장은 실제 코드로 검증합니다.
  writeFileSync(
    path.join(fixtureDir, 'pb_hooks/pages/_private/data4library-service.js'),
    `const refreshBook = {
      bookname: '재분석 충돌 책',
      authors: '충돌 저자',
      publisher: '재분석 출판사',
      publication_year: '2024',
      isbn13: '9791100000083',
      bookImageURL: 'https://example.com/refresh.jpg',
      description: '도서관정보나루 소개',
    }
    module.exports = {
      searchBooks: function (config, query) {
        const text = JSON.stringify(query)
        if (text.indexOf('검색장애') >= 0) throw new Error('도서관정보나루 API 요청에 실패했습니다. timeout')
        if (text.indexOf('재분석 충돌') >= 0 && $app.store().get('refreshMatch') === true) {
          return { numFound: 1, docs: [refreshBook], raw: {} }
        }
        return { numFound: 0, docs: [], raw: {} }
      },
      getBookDetail: function (config, query) {
        if (query && query.isbn13 === refreshBook.isbn13 && $app.store().get('refreshMatch') === true) {
          return { book: refreshBook, raw: { source: 'refresh' } }
        }
        return { book: null }
      },
    }`
  )
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:18093' }"
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
    new URL('./fixtures/access-control-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port: 18093, timeoutMs: 30000 })
  for (const index of [1, 2, 3, 4]) {
    const response = await fetch(service.baseUrl + '/api/collections/users/auth-with-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'reader' + index + '@example.com', password: 'test-password-1234' }),
    })
    assert.equal(response.status, 200)
    const auth = await response.json()
    sessions[index] = {
      Authorization: auth.token,
      Cookie: 'pb_auth=' + encodeURIComponent(JSON.stringify({ token: auth.token })),
    }
  }
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-access-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function request(route, user = 1, input) {
  return fetch(service.baseUrl + route, {
    method: input ? 'POST' : 'GET',
    redirect: 'manual',
    headers: sessions[user] || {},
    body: input ? new URLSearchParams(input) : undefined,
  })
}

test('A stranger cannot create a shelf through position or status changes; owners keep reading and saving', async () => {
  assert.equal((await request(filePath, 2)).status, 404)
  assert.equal((await request('/api/books/save-progress', 2, { bookId, href: 'chapter.xhtml' })).status, 404)
  for (const status of ['queued', 'reading', 'finished']) {
    const response = await request('/xapi/books/update-status', 2, { bookId, status })
    assert.equal(response.status, 303)
  }
  assert.equal((await request(filePath, 2)).status, 404)
  const state = await (await request('/_test/access-state')).json()
  assert.equal(state.strangerShelfCount, 0)

  // 서재에 없는 책(다른 기기에서 서재에서 뺀 책 포함)에는 기록이 다시 생기지 않아야 합니다.
  assert.equal((await request('/api/books/save-highlight', 2, { bookId, quoteText: '남의 책 문구' })).status, 404)
  assert.equal((await request('/api/books/save-bookmark', 2, { bookId, href: 'chapter.xhtml' })).status, 404)
  const now = new Date().toISOString()
  const session = { bookId, startedAt: now, endedAt: now, durationSeconds: '90' }
  assert.equal((await request('/api/books/save-reading-session', 2, session)).status, 404)
  const review = await request('/xapi/books/save-review', 2, { bookId, reviewText: '남의 책 감상평' })
  assert.equal(review.status, 303)
  assert.match(decodeURIComponent(review.headers.get('location') || ''), /내 도서함에 있는 책만 감상평/)

  const save = await request('/api/books/save-progress', 1, { bookId, href: 'chapter.xhtml', progressPercent: '42' })
  assert.equal(save.status, 200)
  assert.equal((await save.json()).ok, true)
  assert.equal((await (await request('/api/books/load-progress', 1, { bookId })).json()).href, 'chapter.xhtml')
  assert.equal((await request('/xapi/books/update-status', 1, { bookId, status: 'finished' })).status, 303)
  assert.equal((await request(filePath)).status, 200)
  assert.equal((await request('/books/' + bookId + '/read')).status, 200)
})

test('A device saving from an older position cannot overwrite a newer position saved elsewhere', async () => {
  const save = (input) => request('/api/books/save-progress', 1, { bookId, ...input })
  const first = 'epubcfi(/6/2!/4/2/1:0)'
  const newer = 'epubcfi(/6/4!/4/2/1:0)'

  assert.equal((await save({ locator: first, baseLocator: '', force: 'true' })).status, 200)
  assert.equal((await save({ locator: newer, baseLocator: first })).status, 200, 'device B continues from device A')

  const stale = await save({ locator: 'epubcfi(/6/2!/4/8/1:0)', baseLocator: first })
  assert.equal(stale.status, 409)
  const conflict = await stale.json()
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.locator, newer)
  assert.equal((await (await request('/api/books/load-progress', 1, { bookId })).json()).locator, newer)

  const forced = 'epubcfi(/6/2!/4/10/1:0)'
  assert.equal((await save({ locator: forced, baseLocator: first, force: 'true' })).status, 200)
  assert.equal((await save({ locator: 'epubcfi(/6/2!/4/12/1:0)' })).status, 200, 'a tab without baseLocator still saves')
})

test('Imported schema blocks self-approval and approval at signup while ordinary profile updates remain allowed', async () => {
  const response = await fetch(service.baseUrl + '/api/collections/users/records/reviewuser00003', {
    method: 'PATCH',
    headers: { ...sessions[3], 'Content-Type': 'application/json' },
    body: JSON.stringify({ booklog_enabled: true }),
  })
  assert.equal(response.status, 404)
  assert.equal((await (await request('/_test/access-state')).json()).pendingApproved, false)
  const signup = await fetch(service.baseUrl + '/api/collections/users/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'forged@example.com',
      password: 'test-password-1234',
      passwordConfirm: 'test-password-1234',
      booklog_enabled: true,
    }),
  })
  assert.equal(signup.status, 400)
  const update = await fetch(service.baseUrl + '/api/collections/users/records/reviewuser00001', {
    method: 'PATCH',
    headers: { ...sessions[1], 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '독자' }),
  })
  assert.equal(update.status, 200)
})

test('Pending accounts can sign in and see the waiting page, but cannot access reader, records or upload', async () => {
  assert.equal((await request('/', 3)).status, 200)
  assert.equal((await request('/auth', 0)).status, 200)
  assert.equal((await request('/auth', 3)).status, 303)
  for (const route of ['/library', '/settings', '/reading-records', '/books/' + bookId + '/read', filePath]) {
    const response = await request(route, 3)
    assert.equal(response.status, 303, route)
    assert.equal(new URL(response.headers.get('location'), service.baseUrl).pathname, '/')
  }
  assert.equal((await request('/api/books/save-progress', 3, { bookId, href: 'chapter.xhtml' })).status, 403)
  assert.equal((await request('/api/books/save-progress', 0, { bookId, href: 'chapter.xhtml' })).status, 401)
  const upload = await request('/xapi/epub/upload', 3, { epubFile: 'not-a-file' })
  assert.equal(upload.status, 303)
  assert.equal(new URL(upload.headers.get('location'), service.baseUrl).pathname, '/')
  const signin = await request('/xapi/auth/sign-in', 0, {
    email: 'reader3@example.com',
    password: 'test-password-1234',
  })
  assert.equal(new URL(signin.headers.get('location'), service.baseUrl).pathname, '/')
  assert.equal((await request('/xapi/auth/sign-out', 3, {})).status, 303)

  await request('/_test/approve', 1, {})
  assert.equal((await request('/library', 3)).status, 200, 'server approval takes effect with the existing auth token')
})

test('Approved users can still add a book through EPUB upload', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const bytes = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package version="3.0"><metadata><title>업로드 테스트</title><creator>테스트 저자</creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'OPS/body.xhtml': strToU8('<html><body><p>정상적인 업로드 경로로 서재에 책을 추가합니다.</p></body></html>'),
  })
  const form = new FormData()
  form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), 'test.epub')
  const response = await fetch(service.baseUrl + '/xapi/epub/upload', {
    method: 'POST',
    headers: sessions[2],
    redirect: 'manual',
    body: form,
  })
  assert.equal(response.status, 303)
  assert.equal(
    (await (await request('/_test/access-state')).json()).strangerShelfCount,
    1,
    decodeURIComponent(response.headers.get('location'))
  )
})

test('Concurrent uploads of the same new EPUB leave one book, one stored file and one shelf entry', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const title = 'concurrent-upload-race'
  const bytes = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>' + title + '</dc:title><dc:creator>동시 저자</dc:creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'OPS/body.xhtml': strToU8('<html><body><p>같은 파일을 동시에 여러 번 올려도 한 권만 남아야 합니다.</p></body></html>'),
  })
  const responses = await Promise.all(
    [1, 2, 3].map(() => {
      const form = new FormData()
      form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), title + '.epub')
      return fetch(service.baseUrl + '/xapi/epub/upload', {
        method: 'POST',
        headers: sessions[1],
        redirect: 'manual',
        body: form,
      })
    })
  )
  const messages = responses.map((response) => decodeURIComponent(response.headers.get('location') || ''))
  for (const response of responses) assert.equal(response.status, 303)
  const state = await (await request('/_test/upload-state?title=' + encodeURIComponent(title))).json()
  assert.equal(state.bookCount, 1, messages.join('\n'))
  assert.equal(state.files.length, 1, messages.join('\n'))
  assert.deepEqual(state.shelves, [{ userId: 'reviewuser00001', bookFileId: state.files[0].id }], messages.join('\n'))
  assert.ok(existsSync(path.join(state.storageRoot, state.files[0].path)), 'stored EPUB file exists')
  assert.equal(messages.filter((message) => message.includes('EPUB 파일과 도서 메타데이터를 저장했습니다.')).length, 1)
  for (const message of messages) assert.doesNotMatch(message, /UNIQUE|constraint|validation_/i)
})

test('Different readers uploading the same new EPUB at once share one book and file, each with their own shelf', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const title = 'shared-concurrent-upload'
  const bytes = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>' + title + '</dc:title><dc:creator>공유 저자</dc:creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    // 분석에 시간이 걸려야 세 요청이 실제로 겹치므로, 본문을 실제 책 한 권 정도로 키웁니다.
    'OPS/body.xhtml': strToU8(
      '<html><body>'
        + Array.from({ length: 400 }, (_, index) => '<p>' + index + '번째 문단은 여러 독자가 같은 파일을 동시에 올려도 하나로 남는지 확인합니다.</p>').join('')
        + '</body></html>'
    ),
  })
  const readers = [1, 2, 4]
  const responses = await Promise.all(
    readers.map((user) => {
      const form = new FormData()
      form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), title + '.epub')
      return fetch(service.baseUrl + '/xapi/epub/upload', {
        method: 'POST',
        headers: sessions[user],
        redirect: 'manual',
        body: form,
      })
    })
  )
  const messages = responses.map((response) => decodeURIComponent(response.headers.get('location') || ''))
  for (const response of responses) assert.equal(response.status, 303, messages.join('\n'))
  for (const message of messages) {
    assert.doesNotMatch(message, /UNIQUE|constraint|validation_/i)
    assert.match(message, /EPUB 파일과 도서 메타데이터를 저장했습니다\.|기존 책과 파일을 찾아 서재에 연결했습니다\./, message)
  }

  const state = await (await request('/_test/upload-state?title=' + encodeURIComponent(title))).json()
  assert.equal(state.bookCount, 1, messages.join('\n'))
  assert.equal(state.files.length, 1, messages.join('\n'))
  assert.deepEqual(
    state.shelves.map((shelf) => shelf.userId).sort(),
    ['reviewuser00001', 'reviewuser00002', 'reviewuser00004'],
    'every reader gets their own shelf entry'
  )
  assert.ok(
    state.shelves.every((shelf) => shelf.bookFileId === state.files[0].id),
    'all shelves point at the one shared file'
  )
  assert.ok(existsSync(path.join(state.storageRoot, state.files[0].path)), 'stored EPUB file exists')
})

test('Renamed legacy EPUBs reuse the same file, while equal-size different contents stay separate', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const title = 'legacy-hash-rename-case'
  function buildEpub(letter) {
    return zipSync({
      'mimetype': strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(
        '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
      ),
      'OPS/book.opf': strToU8(
        '<package version="3.0"><metadata><title>' + title
          + '</title><creator>테스트 저자</creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
      ),
      'OPS/body.xhtml': strToU8('<html><body><p>본문 ' + letter + '</p></body></html>'),
    }, { level: 0 })
  }
  async function upload(bytes, name, user) {
    const form = new FormData()
    form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), name)
    const response = await fetch(service.baseUrl + '/xapi/epub/upload', {
      method: 'POST', headers: sessions[user], redirect: 'manual', body: form,
    })
    assert.equal(response.status, 303)
    return response
  }
  const stateUrl = '/_test/upload-state?title=' + encodeURIComponent(title)
  const bytes = buildEpub('A')
  await upload(bytes, '같은파일.epub', 1)
  const before = await (await request(stateUrl)).json()
  assert.equal(before.files.length, 1)
  const file = before.files[0]
  // 예전 구현은 각 바이트를 문자로 바꾼 문자열을 SHA-256에 전달했습니다.
  const legacyHash = createHash('sha256').update(Buffer.from(bytes).toString('latin1'), 'utf8').digest('hex')
  assert.equal((await request('/_test/legacy-file-hash?fileId=' + file.id + '&hash=' + legacyHash, 1, {})).status, 200)
  await upload(bytes, '같은파일.epub'.normalize('NFD'), 2)
  await upload(bytes, '완전히다른이름.epub', 4)
  const reused = await (await request(stateUrl)).json()
  assert.equal(reused.bookCount, 1)
  assert.deepEqual(reused.files, [file])
  assert.deepEqual(reused.shelves.map((shelf) => shelf.userId).sort(), [
    'reviewuser00001', 'reviewuser00002', 'reviewuser00004',
  ])
  assert.ok(reused.shelves.every((shelf) => shelf.bookFileId === file.id))
  const differentBytes = buildEpub('B')
  assert.equal(differentBytes.length, bytes.length, 'the candidate size is exactly the same')
  await upload(differentBytes, '같은파일.epub', 2)
  const separate = await (await request(stateUrl)).json()
  assert.equal(separate.bookCount, 2)
  assert.equal(separate.files.length, 2, 'equal size must not reuse different file contents')
})

test('A failed shelf save rolls back the new book, file record and stored EPUB file', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const { readdirSync } = await import('node:fs')
  const title = 'rollback-upload-case'
  const bytes = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package version="3.0"><metadata></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'OPS/body.xhtml': strToU8('<html><body><p>도서함 저장이 실패하면 책과 파일이 모두 되돌려져야 합니다.</p></body></html>'),
  })
  const { storageRoot } = await (await request('/_test/upload-state?title=' + encodeURIComponent(title))).json()
  const storageDir = path.join(storageRoot, 'pbc_1101001002')
  const countStoredFiles = () =>
    existsSync(storageDir) ? readdirSync(storageDir, { recursive: true }).filter((name) => /\.epub$/i.test(name)).length : 0
  const storedBefore = countStoredFiles()
  assert.ok(storedBefore > 0, 'storage path points at existing book_files uploads')
  await fetch(service.baseUrl + '/_test/fail-shelf-save?on=true', { method: 'POST' })
  try {
    const form = new FormData()
    form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), title + '.epub')
    const response = await fetch(service.baseUrl + '/xapi/epub/upload', {
      method: 'POST',
      headers: sessions[1],
      redirect: 'manual',
      body: form,
    })
    const message = decodeURIComponent(response.headers.get('location') || '')
    assert.equal(response.status, 303)
    assert.match(message, /업로드 중 문제가 발생했습니다/)
    assert.doesNotMatch(message, /forced shelf save failure/)
  } finally {
    await fetch(service.baseUrl + '/_test/fail-shelf-save?on=false', { method: 'POST' })
  }
  const state = await (await request('/_test/upload-state?title=' + encodeURIComponent(title))).json()
  assert.equal(state.bookCount, 0, 'book record rolled back')
  assert.equal(state.files.length, 0, 'file record rolled back')
  assert.equal(countStoredFiles(), storedBefore, 'stored EPUB file removed after rollback')
})

function buildIsbnEpub(isbn13, bodyText) {
  const { zipSync, strToU8 } = require('fflate')
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:identifier id="isbn" opf:scheme="ISBN">'
        + isbn13
        + '</dc:identifier></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'OPS/body.xhtml': strToU8('<html><body><p>' + bodyText + '</p></body></html>'),
  })
}

async function uploadEpub(user, bytes, name) {
  const form = new FormData()
  form.set('epubFile', new Blob([bytes], { type: 'application/epub+zip' }), name)
  const response = await fetch(service.baseUrl + '/xapi/epub/upload', {
    method: 'POST',
    headers: sessions[user],
    redirect: 'manual',
    body: form,
  })
  assert.equal(response.status, 303)
  return decodeURIComponent(response.headers.get('location') || '')
}

test('Uploading another file of an existing book keeps its stored metadata and only fills blank fields', async () => {
  const sharedMessage = await uploadEpub(1, buildIsbnEpub('9791100000014', '다른 판본 파일입니다.'), 'other-edition.epub')
  assert.match(sharedMessage, /저장했습니다/)
  const shared = await (await request('/_test/book?id=sharedbook00001')).json()
  assert.deepEqual(shared.fields, {
    title: '공유 원본 책',
    author: '원본 저자',
    publisher: '원본 출판사',
    isbn13: '9791100000014',
    book_image_url: 'https://example.com/cover.jpg',
    description: '원본 설명',
    estimated_page_count: 123,
  })
  assert.deepEqual(JSON.parse(shared.metadataJson), { source: 'original' })
  assert.equal(shared.fileCount, 1)
  assert.deepEqual(shared.shelves, [{ userId: 'reviewuser00001', fileBookId: 'sharedbook00001' }])

  await uploadEpub(1, buildIsbnEpub('9791100000021', '빈칸을 채우는 파일입니다.'), 'blank-fill.epub')
  const blank = await (await request('/_test/book?id=blankbook000001')).json()
  assert.equal(blank.fields.title, '빈칸 책')
  assert.ok(blank.fields.estimated_page_count > 0, 'missing page count is filled')
})

test('A re-saved shared file stays attached to its book even when its ISBN now points at another book', async () => {
  const bytes = buildIsbnEpub('9791100000038', '파일이 다른 책으로 옮겨 붙으면 안 됩니다.')
  await uploadEpub(1, bytes, 'move-guard.epub')
  const original = await (await request('/_test/book?isbn13=9791100000038')).json()
  const { otherId } = await (await fetch(service.baseUrl + '/_test/prepare-move?bookId=' + original.id, { method: 'POST' })).json()

  const message = await uploadEpub(2, bytes, 'move-guard.epub')
  assert.doesNotMatch(message, /문제가 발생했습니다/)
  const kept = await (await request('/_test/book?id=' + original.id)).json()
  assert.equal(kept.fields.isbn13, '9791100000045')
  assert.equal(kept.fileCount, 1, 'shared file still belongs to the original book')
  assert.deepEqual(
    kept.shelves.map((shelf) => shelf.userId + ':' + shelf.fileBookId).sort(),
    ['reviewuser00001:' + original.id, 'reviewuser00002:' + original.id]
  )
  const other = await (await request('/_test/book?id=' + otherId)).json()
  assert.equal(other.fields.title, '같은 ISBN의 다른 책')
  assert.equal(other.fileCount, 0)
})

test('Saves sent together while closing the reader keep one reading session', async () => {
  const sessionId = 'closingsession0'
  const now = new Date().toISOString()
  const save = (durationSeconds) =>
    request('/api/books/save-reading-session', 1, { bookId, sessionId, startedAt: now, endedAt: now, durationSeconds })
  const before = (await (await request('/_test/access-state')).json()).readingSessions.length

  const responses = await Promise.all([save('40'), save('41')])
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200]
  )
  assert.equal((await (await save('42')).json()).id, sessionId)

  const sessions = (await (await request('/_test/access-state')).json()).readingSessions
  assert.equal(sessions.length, before + 1)
  assert.equal(sessions.find((session) => session.id === sessionId).durationSeconds, 42)
})

test('A save that arrives late with less reading time does not shrink the reading session', async () => {
  const sessionId = 'latesession0001'
  const now = new Date().toISOString()
  const save = (durationSeconds, endLocator) =>
    request('/api/books/save-reading-session', 1, {
      bookId,
      sessionId,
      startedAt: now,
      endedAt: now,
      durationSeconds,
      endLocator,
    })

  assert.equal((await save('120', 'later-place')).status, 200)
  const late = await save('60', 'earlier-place')
  assert.equal(late.status, 200)
  assert.equal((await late.json()).id, sessionId)

  const session = (await (await request('/_test/access-state')).json()).readingSessions.find(
    (item) => item.id === sessionId
  )
  assert.equal(session.durationSeconds, 120)
  assert.equal(session.endLocator, 'later-place')
})

test('Pressing save on a review several times at once keeps one review with the latest text', async () => {
  assert.equal((await request('/_test/race-review-create', 1, {})).status, 200)
  const raced = await request('/xapi/books/save-review', 1, { bookId, reviewText: '나중에 도착한 감상' })
  assert.equal(raced.status, 303)
  assert.match(decodeURIComponent(raced.headers.get('location') || ''), /감상평을 저장했습니다/)
  assert.deepEqual(
    (await (await request('/_test/access-state')).json()).reviews,
    ['나중에 도착한 감상'],
    'the save that lost the race updates the review the other save just created'
  )

  const texts = ['첫 감상', '둘째 감상', '셋째 감상', '넷째 감상', '다섯째 감상', '여섯째 감상']
  const responses = await Promise.all(
    texts.map((reviewText) => request('/xapi/books/save-review', 1, { bookId, reviewText }))
  )
  for (const response of responses) {
    assert.equal(response.status, 303)
    assert.match(decodeURIComponent(response.headers.get('location') || ''), /감상평을 저장했습니다/)
  }

  const { reviews } = await (await request('/_test/access-state')).json()
  assert.equal(reviews.length, 1)
  assert.ok(texts.includes(reviews[0]))

  await request('/xapi/books/save-review', 1, { bookId, reviewText: '고쳐 쓴 감상' })
  assert.deepEqual((await (await request('/_test/access-state')).json()).reviews, ['고쳐 쓴 감상'])
})

test('Saved reading or listening time marks the book as recently read and never moves that back', async () => {
  const toMs = (value) => new Date(String(value).replace(' ', 'T')).getTime()
  const lastReadAt = async () => toMs((await (await request('/_test/access-state')).json()).lastReadAt)
  const save = (sessionId, endedAtMs) =>
    request('/api/books/save-reading-session', 1, {
      bookId,
      sessionId,
      startedAt: new Date(endedAtMs - 600_000).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationSeconds: '600',
    })
  assert.equal((await request('/_test/shelf-last-read?at=' + encodeURIComponent('2020-01-01 00:00:00.000Z'), 1, {})).status, 200)

  const listenedAt = Date.now() - 2 * 3_600_000
  assert.equal((await save('listenedsession', listenedAt)).status, 200)
  assert.ok(Math.abs((await lastReadAt()) - listenedAt) < 1000, 'last read time follows the session end')

  assert.equal((await save('oldersession001', Date.now() - 3 * 86_400_000)).status, 200)
  assert.ok(Math.abs((await lastReadAt()) - listenedAt) < 1000, 'an older session does not move it back')

  const beforeFuture = Date.now()
  assert.equal((await save('futuresession01', Date.now() + 86_400_000)).status, 200)
  const clamped = await lastReadAt()
  assert.ok(clamped >= beforeFuture - 1000 && clamped <= Date.now() + 1000, 'a device clock ahead is capped at now')
})

test('A failing book search does not block the upload; the EPUB metadata is saved instead', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const epub = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
    'OPS/book.opf': strToU8(
      '<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>검색장애 책</dc:title><dc:creator>장애 저자</dc:creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'OPS/body.xhtml': strToU8('<html><body><p>검색 API가 응답하지 않아도 책은 올라가야 합니다.</p></body></html>'),
  })

  const message = await uploadEpub(1, epub, 'search-down.epub')
  assert.match(message, /저장했습니다/)
  const state = await (await request('/_test/upload-state?title=' + encodeURIComponent('검색장애 책'))).json()
  assert.equal(state.bookCount, 1)
})

test('Re-reading metadata matched to an ISBN another book already uses fills the details and leaves the ISBN blank', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const epub = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
    'OPS/book.opf': strToU8(
      '<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>재분석 충돌 책</dc:title><dc:creator>충돌 저자</dc:creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'OPS/body.xhtml': strToU8('<html><body><p>ISBN 없이 올린 책입니다.</p></body></html>'),
  })
  assert.match(await uploadEpub(1, epub, 'refresh-conflict.epub'), /저장했습니다/)
  const uploaded = await (await request('/_test/book?title=' + encodeURIComponent('재분석 충돌 책'))).json()
  assert.equal(uploaded.fields.isbn13, '')
  const owner = await (await request('/_test/book?id=isbnowner000001')).json()
  const refresh = async () => {
    const response = await request('/xapi/books/refresh-metadata', 1, { bookId: uploaded.id })
    assert.equal(response.status, 303)
    return decodeURIComponent(response.headers.get('location') || '')
  }

  assert.equal((await request('/_test/refresh-match?on=true', 1, {})).status, 200)
  try {
    const message = await refresh()
    assert.match(message, /메타데이터를 갱신했습니다/)
    assert.doesNotMatch(message, /UNIQUE|constraint|validation_|Failed/i)

    const refreshed = await (await request('/_test/book?id=' + uploaded.id)).json()
    assert.equal(refreshed.fields.isbn13, '', 'the ISBN stays with the book that already had it')
    assert.equal(refreshed.fields.author, '충돌 저자')
    assert.equal(refreshed.fields.publisher, '재분석 출판사')
    assert.equal(refreshed.fields.book_image_url, 'https://example.com/refresh.jpg')
    assert.equal(refreshed.fields.description, '도서관정보나루 소개')
    assert.match(refreshed.metadataJson, /refresh/)
    assert.deepEqual(await (await request('/_test/book?id=isbnowner000001')).json(), owner)

    assert.match(await refresh(), /도서 상세 메타데이터가 이미 있습니다/, 'pressing again no longer retries and fails')
  } finally {
    await request('/_test/refresh-match?on=false', 1, {})
  }
})

test('An EPUB whose text expands far beyond a real book is rejected before it is unpacked', async () => {
  const { zipSync, strToU8 } = require('fflate')
  const bomb = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
    'OPS/book.opf': strToU8('<package version="3.0"><metadata></metadata><manifest></manifest><spine></spine></package>'),
    'OPS/body.xhtml': new Uint8Array(17 * 1024 * 1024).fill(32),
  })
  assert.ok(bomb.length < 1024 * 1024, 'a small upload that expands to 17MB')

  const message = await uploadEpub(1, bomb, 'bomb.epub')
  assert.match(message, /압축을 푼 본문 크기가 너무 커서/)
  const state = await (await request('/_test/upload-state?title=bomb')).json()
  assert.equal(state.bookCount, 0)
})

test('Only administrators see and access book management; users cannot grant themselves admin access', async () => {
  assert.doesNotMatch(await (await request('/')).text(), /href="\/admin\/books"/)
  assert.match(await (await request('/', 4)).text(), /href="\/admin\/books"/)
  for (const user of [0, 1, 2, 3]) {
    assert.equal((await request('/admin/books', user)).status, 303)
    assert.equal(
      (await request('/admin/books', user, { action: 'delete', bookId: 'adminbook000001', userCount: '2' })).status,
      303
    )
  }
  const escalation = await fetch(service.baseUrl + '/api/collections/users/records/reviewuser00001', {
    method: 'PATCH',
    headers: { ...sessions[1], 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_manager: true }),
  })
  const escalationState = await (await request('/_test/admin-state')).json()
  assert.equal(escalation.status, 200)
  assert.equal(escalationState.ownerAdmin, false, 'hidden admin_manager input is ignored by the Record API')
  const signup = await fetch(service.baseUrl + '/api/collections/users/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'forged-admin@example.com',
      password: 'test-password-1234',
      passwordConfirm: 'test-password-1234',
      admin_manager: true,
    }),
  })
  assert.equal(signup.status, 200)
  const state = await (await request('/_test/admin-state')).json()
  assert.equal(state.counts.books, 1)
  assert.equal(state.forgedAdminCount, 0)
})

test('Administrators can search all books, see members and delete unused books', async () => {
  const unused = await request('/admin/books', 4)
  assert.equal(unused.status, 200)
  assert.match(await unused.text(), /미사용 관리 책/)
  const listing = await request('/admin/books?scope=all&q=' + encodeURIComponent('관리 저자'), 4)
  assert.equal(listing.status, 200)
  const html = await listing.text()
  assert.match(html, /관리 대상 책/)
  const cells = load(html)('tbody tr').first().find('td')
  assert.match(cells.eq(0).text(), /2명/)
  assert.match(html, /reader4@example.com/)
  assert.match(cells.eq(1).text(), /2개/)
  assert.match(cells.eq(1).text(), /EPUB 8 B · 2개/)
  assert.match(cells.eq(1).text(), /오디오 8 B · 2개/)
  assert.equal(cells.eq(1).find('span').first().text(), '16 B')
  assert.equal(
    (await request('/admin/books', 4, { action: 'delete', bookId: 'unusedbook00001', userCount: '0' })).status,
    303
  )
  assert.equal((await (await request('/_test/admin-state')).json()).unusedBookCount, 0)
})

test('Storage ordering covers all pages, preserves filters and escapes expandable audio errors', async () => {
  assert.equal((await request('/_test/storage-fixtures', 4, { action: 'create' })).status, 200)
  const query = '/admin/books?scope=all&q=' + encodeURIComponent('용량검증') + '&sort=size'
  const response = await request(query, 4)
  assert.equal(response.status, 200)
  const html = await response.text()
  const $ = load(html)
  const rows = $('tbody tr')
  assert.equal(rows.length, 30)
  assert.match(rows.first().find('th').text(), /관리 대상 책/)
  assert.equal(rows.first().find('td').eq(1).find('span').first().text(), '16 B')
  assert.equal(rows.eq(1).find('td').eq(1).find('span').first().text(), '12 B')
  assert.equal($('#admin-book-sort').val(), 'size')
  const details = rows.first().find('details')
  assert.equal(details.length, 1)
  assert.equal(details.attr('open'), undefined)
  assert.match(details.text(), /실패 사유/)
  assert.match(details.text(), /<script>alert\("오류"\)<\/script>/)
  assert.equal(details.find('script').length, 0)
  const actionUrl = new URL(rows.first().find('form').first().attr('action'), service.baseUrl)
  assert.equal(actionUrl.searchParams.get('sort'), 'size')
  assert.equal(actionUrl.searchParams.get('q'), '용량검증')
  const next = $('nav[aria-label="도서 목록 페이지"] a').last().attr('href')
  const nextUrl = new URL(next, service.baseUrl)
  assert.equal(nextUrl.searchParams.get('page'), '2')
  assert.equal(nextUrl.searchParams.get('sort'), 'size')
  assert.equal(nextUrl.searchParams.get('q'), '용량검증')
  const pageTwo = load(await (await request(next, 4)).text())
  assert.ok(pageTwo('tbody tr').length > 0)
  assert.doesNotMatch(pageTwo('tbody').text(), /관리 대상 책/)
  const newest = load(await (await request(query.replace('sort=size', 'sort=newest'), 4)).text())
  assert.doesNotMatch(newest('tbody').text(), /관리 대상 책/)
  const rejected = await request(query + '&page=2', 4, { action: 'delete', bookId: 'adminbook000001', userCount: '-1' })
  assert.equal(rejected.status, 303)
  const redirectUrl = new URL(rejected.headers.get('location'), service.baseUrl)
  assert.equal(redirectUrl.searchParams.get('sort'), 'size')
  assert.equal(redirectUrl.searchParams.get('q'), '용량검증')
  assert.equal(redirectUrl.searchParams.get('page'), '2')
  try {
    assert.equal((await request('/_test/missing-audio?on=true', 4, { action: 'hide' })).status, 200)
    const unavailable = load(await (await request('/admin/books?scope=all&sort=size&q=' + encodeURIComponent('관리 대상 책'), 4)).text())
    const storage = unavailable('tbody tr').first().find('td').eq(1)
    assert.equal(storage.find('span').first().text(), '확인 불가')
    assert.match(storage.text(), /오디오 확인 불가/)
    const unknownLast = load(await (await request(next, 4)).text())
    assert.match(unknownLast('tbody tr').last().find('th').text(), /관리 대상 책/)
  } finally {
    await request('/_test/missing-audio?on=false', 4, { action: 'restore' })
  }
  const empty = load(await (await request('/admin/books?scope=all&sort=size&q=없는제목', 4)).text())
  assert.match(empty('tbody').text(), /해당하는 도서가 없습니다/)
})

test('Deleting a shared book checks the member count and removes all related records and stored files', async () => {
  const beforeState = await (await request('/_test/admin-state')).json()
  for (const count of Object.values(beforeState.counts)) assert.ok(count > 0)
  assert.equal(beforeState.paths.length, 4)
  for (const storedPath of beforeState.paths)
    assert.ok(existsSync(path.join(beforeState.storageRoot, storedPath)), storedPath)
  const stale = await request('/admin/books', 4, { action: 'delete', bookId: 'adminbook000001', userCount: '0' })
  assert.equal(stale.status, 303)
  assert.match(decodeURIComponent(stale.headers.get('location')), /연결 인원이 변경/)
  assert.deepEqual((await (await request('/_test/admin-state')).json()).counts, beforeState.counts)
  const deleted = await request('/admin/books?scope=all', 4, {
    action: 'delete',
    bookId: 'adminbook000001',
    userCount: '2',
  })
  assert.equal(deleted.status, 303)
  assert.match(decodeURIComponent(deleted.headers.get('location')), /책과 관련 데이터를 삭제/)
  const state = await (await request('/_test/admin-state')).json()
  for (const [collection, count] of Object.entries(state.counts)) assert.equal(count, 0, collection)
  assert.equal(state.originalBookCount, 1)
  assert.equal(state.originalFileCount, 1)
  for (const storedPath of beforeState.paths)
    assert.equal(existsSync(path.join(beforeState.storageRoot, storedPath)), false, storedPath)
})
