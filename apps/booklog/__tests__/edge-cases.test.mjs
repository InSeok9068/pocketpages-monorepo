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
import { startService } from '@pocketpages/test-support/service-harness'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const port = 18103
let fixtureDir
let service
let anchors
const sessions = {}

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-edge-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  copyFileSync(
    new URL('./fixtures/onesignal-stub.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/jobs/onesignal-service.js')
  )
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
    new URL('./fixtures/edge-cases-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  for (const id of ['midnightuser001', 'deletereader001', 'deleteadmin0001']) {
    sessions[id] = await signIn(id + '@example.com')
  }
  anchors = await (await fetch(service.baseUrl + '/_test/edge-anchors')).json()
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-edge-test-'))
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

function request(route, user, input) {
  return fetch(service.baseUrl + route, {
    method: input ? 'POST' : 'GET',
    redirect: 'manual',
    headers: user ? sessions[user] : {},
    body: input ? new URLSearchParams(input) : undefined,
  })
}

async function page(route, user) {
  const response = await request(route, user)
  const source = await response.text()
  assert.equal(response.status, 200, source.slice(0, 300))
  return load(source)
}

async function state() {
  return (await request('/_test/edge-state')).json()
}

function addDays(dateText, days) {
  const date = new Date(dateText + 'T00:00:00.000Z')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function weekTimes($) {
  return Object.fromEntries(
    $('button[aria-controls^="week-dialog-"]')
      .toArray()
      .map((button) => [
        $(button).attr('aria-controls').replace('week-dialog-', ''),
        $(button).children('span').last().text().trim(),
      ])
  )
}

function saveSession(id, crossing) {
  return request('/api/books/save-reading-session', 'midnightuser001', {
    sessionId: id,
    bookId: 'midnightbook001',
    bookFileId: 'midnightfile001',
    startedAt: crossing.startedAt,
    endedAt: crossing.endedAt,
    durationSeconds: '2400',
  })
}

test('A session read across midnight counts on the day it ended, the same way on every screen and job', async (t) => {
  const { monday } = anchors
  assert.equal((await saveSession('midnightthis001', anchors.thisWeekCrossing)).status, 200)
  assert.equal((await saveSession('midnightold0001', anchors.olderWeekCrossing)).status, 200)

  // 일요일 23:40~월요일 00:20 세션은 끝난 월요일의 주에 40분 전부 들어갑니다.
  const $ = await page('/reading-records', 'midnightuser001')
  const weeks = weekTimes($)
  assert.equal(weeks[monday], '40분', 'this week holds the Sunday-night-to-Monday session')
  assert.equal(weeks[addDays(monday, -7)], '0분', 'the Sunday it started on is not counted')
  assert.equal(weeks[addDays(monday, -14)], '40분')
  assert.equal(weeks[addDays(monday, -21)], '0분')

  const home = await page('/', 'midnightuser001')
  const dots = home('[aria-label="이번 주 독서 기록"] span[aria-label]')
    .toArray()
    .map((dot) => home(dot).attr('aria-label'))
  assert.ok(dots.includes(monday + ' 독서함'), 'the home week marks the Monday it ended on')

  // 주간 알림은 지금까지의 이번 주만 보므로, 월요일 00:20이 아직 안 지났으면 이 확인은 건너뜁니다.
  if (Date.now() < Date.parse(anchors.thisWeekCrossing.endedAt) + 60_000) {
    t.diagnostic('skipped the weekly nudge check: the session ends in the future right now')
  } else {
    assert.equal((await request('/_test/edge-run?job=weekly', null, {})).status, 200)
    assert.deepEqual((await state()).nudgeReasons.at(-1), {
      status: 'skipped',
      reason: 'has_weekly_reading_session',
    })
  }

  assert.equal((await request('/_test/edge-run?job=merge', null, {})).status, 200)
  assert.deepEqual(
    (await state()).mergeSessions,
    [
      { endedDate: addDays(anchors.oldDay, -1), minutes: 30 },
      { endedDate: anchors.oldDay, minutes: 70 },
    ],
    'an old midnight session merges with the morning of the day it ended, not with the night before'
  )
})

test('After an administrator deletes a book someone is reading, that reader gets refusals instead of errors', async () => {
  const bookId = 'deletebook00001'
  assert.equal((await request('/books/' + bookId + '/read', 'deletereader001')).status, 200)
  assert.equal((await request('/api/books/save-progress', 'deletereader001', { bookId, href: 'c1.xhtml' })).status, 200)

  const deleted = await request('/admin/books', 'deleteadmin0001', { action: 'delete', bookId, userCount: '1' })
  assert.equal(deleted.status, 303)
  assert.match(decodeURIComponent(deleted.headers.get('location') || ''), /책과 관련 데이터를 삭제했습니다/)
  assert.deepEqual((await state()).deletedBook, { books: 0, shelves: 0, sessions: 0, bookmarks: 0, highlights: 0 })

  const now = new Date().toISOString()
  const apiCalls = [
    ['/api/books/save-progress', { bookId, href: 'c1.xhtml', locator: 'epubcfi(/6/2!/4/2/1:0)' }],
    ['/api/books/load-progress', { bookId }],
    [
      '/api/books/save-reading-session',
      {
        sessionId: 'deletesession01',
        bookId,
        bookFileId: 'deletefile00001',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: now,
        durationSeconds: '60',
      },
    ],
    ['/api/books/save-bookmark', { bookId, bookFileId: 'deletefile00001', href: 'c1.xhtml' }],
    ['/api/books/save-highlight', { bookId, quoteText: '지워진 책의 문구', href: 'c1.xhtml' }],
    ['/api/books/list-bookmarks', { bookId, bookFileId: 'deletefile00001' }],
  ]
  for (const [route, input] of apiCalls) {
    const response = await request(route, 'deletereader001', input)
    const body = await response.json()
    assert.ok(response.status >= 400 && response.status < 500, route + ' answered ' + response.status)
    assert.equal(body.ok, false, route)
    assert.ok(body.message, route + ' explains the refusal')
  }

  for (const route of ['/xapi/books/' + bookId + '/read-file', '/books/' + bookId, '/books/' + bookId + '/read']) {
    const response = await request(route, 'deletereader001')
    assert.ok(response.status < 500, route + ' answered ' + response.status)
    assert.notEqual(response.status, 200, route + ' does not pretend the book is still there')
  }

  assert.deepEqual(
    (await state()).deletedBook,
    { books: 0, shelves: 0, sessions: 0, bookmarks: 0, highlights: 0 },
    'late saves from the open reader leave nothing behind'
  )
})
