import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from '@pocketpages/test-support/service-harness'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const pagesDir = path.join(serviceDir, 'pb_hooks/pages')
const port = 18098
let fixtureDir
let service
const sessions = {}

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-route-test-'))
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
    new URL('./fixtures/route-health-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  for (const name of ['rich', 'empty', 'pending', 'admin']) sessions[name] = await signIn(name + '@example.com')
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-route-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function signIn(email) {
  const response = await fetch(service.baseUrl + '/api/collections/users/auth-with-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password: 'test-password-1234' }),
  })
  assert.equal(response.status, 200, email)
  const auth = await response.json()
  return { Cookie: 'pb_auth=' + encodeURIComponent(JSON.stringify({ token: auth.token })) }
}

async function visit(route, user, options = {}) {
  const response = await fetch(service.baseUrl + route, {
    method: options.method || 'GET',
    redirect: 'manual',
    headers: { ...(user ? sessions[user] : {}), ...(options.htmx ? { 'HX-Request': 'true' } : {}) },
  })
  const body = await response.text()
  return { status: response.status, location: decodeURIComponent(response.headers.get('location') || ''), body }
}

// 전역 오류 경계가 그리는 안내와, 오류가 화면에 새어 나온 흔적입니다.
const BROKEN_MARKERS = [
  '페이지를 불러오지 못했습니다.',
  '처리 중 문제가 발생했습니다.',
  /\b(TypeError|ReferenceError|RangeError|SyntaxError)\b/,
  /\.ejs:\d+/,
]

function assertNotBroken(result, label) {
  assert.ok(result.status < 500, label + ' answered ' + result.status + ': ' + result.body.slice(0, 300))
  for (const marker of BROKEN_MARKERS) {
    const found = typeof marker === 'string' ? result.body.includes(marker) : marker.test(result.body)
    assert.ok(!found, label + ' shows an error: ' + marker)
  }
}

async function expectPage(route, user, check = {}) {
  const result = await visit(route, user, check)
  const label = (user || 'anonymous') + ' ' + route
  assertNotBroken(result, label)
  if (check.redirectTo) {
    assert.equal(result.status, 303, label + ': ' + result.body.slice(0, 300))
    assert.equal(result.location.split('?')[0], check.redirectTo, label)
  } else {
    assert.equal(result.status, check.status || 200, label + ': ' + result.location + result.body.slice(0, 300))
  }
  for (const text of check.contains || []) assert.ok(result.body.includes(text), label + ' should show ' + text)
  for (const text of check.lacks || []) assert.ok(!result.body.includes(text), label + ' should not show ' + text)
  return result
}

const SITE_PAGES = [
  '/library',
  '/library?status=finished&sort=title&q=book&limit=60',
  '/library?status=nonsense&sort=nonsense&limit=-5',
  '/highlights',
  '/highlights?q=문구&limit=60',
  '/highlights?book=fullbook0000001',
  '/reviews',
  '/reviews?q=감상&limit=abc',
  '/reading-records',
  '/reading-records?week=2026-01-05',
  '/reading-records?week=not-a-date',
  '/settings',
  '/popular',
  '/popular?tab=steady',
  '/books/fullbook0000001',
  '/books/barebook0000001',
  '/books/finishedbook001',
  '/books/droppedbook0001',
  '/books/unshelvedbook01',
]
const FRAGMENTS = [
  '/xapi/library-more?offset=0',
  '/xapi/library-more?offset=50&status=reading&sort=title&q=x',
  '/xapi/highlights-more?offset=0',
  '/xapi/highlights-more?offset=abc&book=fullbook0000001',
  '/xapi/reviews-more?offset=0',
  '/xapi/reviews-more?offset=9999',
  '/xapi/popular-list?tab=month',
  '/xapi/popular-list?tab=steady',
]
const POST_ONLY = [
  '/api/books/delete-bookmark',
  '/api/books/list-bookmarks',
  '/api/books/list-highlights',
  '/api/books/load-progress',
  '/api/books/save-bookmark',
  '/api/books/save-highlight',
  '/api/books/save-progress',
  '/api/books/save-reading-session',
  '/xapi/auth/sign-in',
  '/xapi/auth/sign-out',
  '/xapi/auth/sign-up',
  '/xapi/books/audio-job',
  '/xapi/books/delete-highlight',
  '/xapi/books/delete-review',
  '/xapi/books/recalculate-page-count',
  '/xapi/books/refresh-metadata',
  '/xapi/books/remove-from-shelf',
  '/xapi/books/reset-reading-sessions',
  '/xapi/books/save-review',
  '/xapi/books/update-highlight',
  '/xapi/books/update-status',
  '/xapi/epub/upload',
  '/xapi/settings/save',
]
const GET_WITHOUT_INPUT = [
  '/api/books/audio-chunk',
  '/api/books/audio-position',
  '/api/books/audio-progress',
  '/xapi/books/audio-file',
  '/xapi/books/audio-file?chunkId=nothing',
  '/xapi/books/barebook0000001/read-file',
  '/xapi/books/barebook0000001/download-file',
  '/xapi/books/unshelvedbook01/read-file',
]
const OTHER_ROUTES = [
  '/',
  '/auth',
  '/admin/books',
  '/books/fullbook0000001/read',
  '/xapi/books/fullbook0000001/read-file',
  '/xapi/books/fullbook0000001/download-file',
]

function routePattern(route) {
  return route
    .split('?')[0]
    .replace(/^\/books\/[a-z0-9]{15}/, '/books/[bookId]')
    .replace(/^\/xapi\/books\/[a-z0-9]{15}\//, '/xapi/books/[bookId]/')
}

function listRouteFiles(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '_private' || name === 'assets') return []
      return listRouteFiles(full, /^\(.*\)$/.test(name) ? prefix : prefix + '/' + name)
    }
    if (!name.endsWith('.ejs') || name.startsWith('+')) return []
    return [name === 'index.ejs' ? prefix || '/' : prefix + '/' + name.slice(0, -4)]
  })
}

test('Every page and fragment under pb_hooks/pages is part of this route check', () => {
  const covered = new Set(
    [...SITE_PAGES, ...FRAGMENTS, ...POST_ONLY, ...GET_WITHOUT_INPUT, ...OTHER_ROUTES].map(routePattern)
  )
  const missing = listRouteFiles(pagesDir).filter((route) => !covered.has(route))
  assert.deepEqual(missing, [], 'add new routes to the tables in this file')
})

test('Signed-out visitors see only the home and sign-in pages; everything else sends them to sign in', async () => {
  await expectPage('/', null)
  await expectPage('/auth', null)
  for (const route of [...SITE_PAGES, '/admin/books', '/books/fullbook0000001/read']) {
    await expectPage(route, null, { redirectTo: '/auth' })
  }
  for (const route of FRAGMENTS) {
    await expectPage(route, null, { redirectTo: '/auth' })
    await expectPage(route, null, { htmx: true, status: 401, contains: ['로그인이 필요합니다.'] })
  }
  for (const route of ['/api/books/audio-chunk', '/api/books/audio-progress']) {
    const result = await expectPage(route, null, { status: 401 })
    assert.equal(JSON.parse(result.body).ok, false)
  }
  const download = await expectPage('/xapi/books/fullbook0000001/download-file', null, { redirectTo: '/auth' })
  assert.ok(!download.body.startsWith('PK'), 'the book file never leaks to a signed-out visitor')
})

test('An account waiting for approval sees the waiting notice and cannot open any reading page', async () => {
  await expectPage('/', 'pending', { contains: ['아직 사용할 수 없는 계정입니다'] })
  await expectPage('/auth', 'pending', { redirectTo: '/' })
  for (const route of [...SITE_PAGES, ...FRAGMENTS, '/admin/books', '/books/fullbook0000001/read']) {
    await expectPage(route, 'pending', { redirectTo: '/' })
  }
  const api = await expectPage('/api/books/audio-progress', 'pending', { status: 403 })
  assert.equal(JSON.parse(api.body).message, '관리자의 사용 승인이 필요합니다.')
})

test('A new reader with no books opens every page and sees an empty-state message instead of an error', async () => {
  const empty = {
    '/library': '아직 도서함에 담긴 책이 없습니다.',
    '/highlights': '아직 저장된 인상 깊은 문구가 없습니다.',
    '/reviews': '아직 저장된 감상평이 없습니다.',
    '/reading-records': '이 주차에는 독서 기록이 없습니다.',
    '/': '저장된 인상 깊은 문구가 아직 없습니다.',
  }
  for (const route of ['/', ...SITE_PAGES]) {
    await expectPage(route, 'empty', { contains: empty[route] ? [empty[route]] : [] })
  }
  for (const route of FRAGMENTS) await expectPage(route, 'empty', { htmx: true })
  await expectPage('/books/fullbook0000001/read', 'empty', { redirectTo: '/books/fullbook0000001' })
  await expectPage('/xapi/books/fullbook0000001/download-file', 'empty', { status: 404 })
})

test('A reader with full and nearly empty records opens every page, and their text is shown escaped', async () => {
  for (const route of ['/', ...SITE_PAGES]) await expectPage(route, 'rich')
  for (const route of FRAGMENTS) await expectPage(route, 'rich', { htmx: true })

  await expectPage('/library', 'rich', { contains: ['barebook0000001', 'finishedbook001', '모든 정보가 있는 책'] })
  await expectPage('/reviews', 'rich', {
    contains: ['&lt;b&gt;굵게&lt;/b&gt; 감상', '날짜와 별점 없는 감상'],
    lacks: ['<b>굵게</b>'],
  })
  await expectPage('/highlights', 'rich', { contains: ['날짜도 위치도 없는 문구', '메모와 장 이름이 있는 문구'] })
  await expectPage('/books/fullbook0000001', 'rich', {
    contains: ['파일 경로가 장 이름에 남은 문구'],
    lacks: ['OEBPS/Text/section0003.xhtml'],
  })
  await expectPage('/books/fullbook0000001/read', 'rich')
  await expectPage('/books/barebook0000001/read', 'rich', { redirectTo: '/books/barebook0000001' })
  await expectPage('/books/unshelvedbook01/read', 'rich', { redirectTo: '/books/unshelvedbook01' })
  await expectPage('/books/doesnotexist001', 'rich', { redirectTo: '/' })

  const file = await fetch(service.baseUrl + '/xapi/books/fullbook0000001/read-file', { headers: sessions.rich })
  assert.equal(file.status, 200)
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [80, 75, 3, 4])
})

test('Routes that need a form or parameters answer a plain visit without crashing', async () => {
  for (const route of POST_ONLY) {
    const result = await visit(route, 'rich')
    assertNotBroken(result, 'GET ' + route)
    assert.notEqual(result.status, 200, 'GET ' + route + ' must not act like a successful submit')
    if (route.startsWith('/api/')) assert.equal(JSON.parse(result.body).ok, false, route)
  }
  for (const route of GET_WITHOUT_INPUT) {
    const result = await visit(route, 'rich')
    assertNotBroken(result, 'GET ' + route)
    assert.ok(result.status >= 300, route + ' answered ' + result.status)
  }
})

test('Book management opens only for administrators, including with odd search input', async () => {
  for (const user of ['rich', 'empty']) await expectPage('/admin/books', user, { redirectTo: '/' })
  for (const route of [
    '/admin/books',
    '/admin/books?scope=all&sort=size',
    '/admin/books?q=%25_&scope=all&page=999',
    '/admin/books?page=-1&sort=nonsense',
  ]) {
    await expectPage(route, 'admin')
  }
  await expectPage('/admin/books?scope=all', 'admin', { contains: ['unshelvedbook01'] })
})

test('Only administrators receive the audio diagnostic control and manual copy field', async () => {
  const controls = ['id="reader-audio-diagnostics-copy"', 'id="reader-audio-diagnostics-text"']
  await expectPage('/books/fullbook0000001/read', 'rich', { lacks: controls })
  await expectPage('/books/fullbook0000001/read', 'admin', { contains: controls })
})
