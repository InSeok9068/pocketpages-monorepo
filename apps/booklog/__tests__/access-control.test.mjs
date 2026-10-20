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
    'module.exports = { searchBooks: function () { return { numFound: 0, docs: [], raw: {} } }, getBookDetail: function () { return { book: null } } }'
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

  const save = await request('/api/books/save-progress', 1, { bookId, href: 'chapter.xhtml', progressPercent: '42' })
  assert.equal(save.status, 200)
  assert.equal((await save.json()).ok, true)
  assert.equal((await (await request('/api/books/load-progress', 1, { bookId })).json()).href, 'chapter.xhtml')
  assert.equal((await request('/xapi/books/update-status', 1, { bookId, status: 'finished' })).status, 303)
  assert.equal((await request(filePath)).status, 200)
  assert.equal((await request('/books/' + bookId + '/read')).status, 200)
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
  assert.match(html, /연결 인원 2명/)
  assert.match(html, /reader4@example.com/)
  assert.match(html, /EPUB 2개/)
  assert.match(html, /음성 파일 2개/)
  assert.equal(
    (await request('/admin/books', 4, { action: 'delete', bookId: 'unusedbook00001', userCount: '0' })).status,
    303
  )
  assert.equal((await (await request('/_test/admin-state')).json()).unusedBookCount, 0)
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
