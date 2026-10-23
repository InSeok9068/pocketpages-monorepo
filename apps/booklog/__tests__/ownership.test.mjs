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
import { startService } from '@pocketpages/test-support/service-harness'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const port = 18096
const bookId = 'ownedbook000001'
const owner = 'owner'
const stranger = 'stranger'
const outsider = 'outsider'
let fixtureDir
let service
const sessions = {}

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-ownership-test-'))
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
    new URL('./fixtures/ownership-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  for (const name of [owner, stranger, outsider]) {
    sessions[name] = await signIn(name + '@example.com')
  }
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-ownership-test-'))
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

async function post(route, user, input) {
  const response = await request(route, user, input)
  assert.equal(response.status, 303, route)
  return decodeURIComponent(response.headers.get('location') || '')
}

async function state() {
  return (await request('/_test/ownership-state')).json()
}

const ownerRecords = {
  highlight: { quote: '주인 문구', note: '주인 메모' },
  review: true,
  bookmark: true,
  audioProgress: true,
  ownerShelf: true,
  ownerSessions: 2,
}

test('Book files download only for readers who shelved the book', async () => {
  const route = '/xapi/books/' + bookId + '/download-file'

  const anonymous = await request(route)
  assert.equal(anonymous.status, 303)
  assert.match(anonymous.headers.get('location') || '', /^\/auth/)
  assert.equal((await request(route, outsider)).status, 404)

  for (const reader of [owner, stranger]) {
    const response = await request(route, reader)
    assert.equal(response.status, 200, reader)
    assert.equal(response.headers.get('content-type'), 'application/epub+zip')
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [80, 75, 3, 4])
  }
})

test('Re-reading metadata and page counts is refused for a book outside the reader’s shelf', async () => {
  const notShelved = /내 도서함에서 책을 찾을 수 없습니다/

  assert.match(await post('/xapi/books/refresh-metadata', outsider, { bookId }), notShelved)
  assert.match(await post('/xapi/books/recalculate-page-count', outsider, { bookId }), notShelved)
  assert.deepEqual((await state()).book, { title: '소유권 책', author: '원래 저자', pages: 77 })

  assert.match(await post('/xapi/books/recalculate-page-count', owner, { bookId }), /페이지 정보가 이미 있습니다/)
  assert.doesNotMatch(await post('/xapi/books/refresh-metadata', owner, { bookId }), notShelved)
})

test('Saving settings changes only the signed-in reader’s settings and rejects out-of-range cycles', async () => {
  const saved = await post('/xapi/settings/save', stranger, {
    pushEnabled: 'true',
    readingReminderCycle: '7',
    highlightPushCycle: '9',
    userId: 'owneruser000001',
    user_id: 'owneruser000001',
  })
  assert.match(saved, /설정을 저장했습니다/)
  let current = (await state()).settings
  assert.deepEqual(current.stranger, [{ pushEnabled: true, readingReminderCycle: 7, highlightPushCycle: 9 }])
  assert.deepEqual(current.owner, [{ pushEnabled: true, readingReminderCycle: 3, highlightPushCycle: 5 }])

  for (const [field, value, message] of [
    ['readingReminderCycle', '91', /읽기 리마인더 주기는 1일부터 90일/],
    ['readingReminderCycle', '2.5', /읽기 리마인더 주기는 1일부터 90일/],
    ['highlightPushCycle', 'abc', /하이라이트 리마인더 주기는 1일부터 90일/],
  ]) {
    assert.match(await post('/xapi/settings/save', owner, { pushEnabled: 'true', [field]: value }), message, value)
  }
  current = (await state()).settings
  assert.deepEqual(current.owner, [{ pushEnabled: true, readingReminderCycle: 3, highlightPushCycle: 5 }])

  await post('/xapi/settings/save', owner, { pushEnabled: '', readingReminderCycle: '14', highlightPushCycle: '' })
  assert.deepEqual((await state()).settings.owner, [
    { pushEnabled: false, readingReminderCycle: 14, highlightPushCycle: 0 },
  ])
})

test('Turning push on with every reminder left empty saves default reminders so notifications actually arrive', async () => {
  const saved = await post('/xapi/settings/save', owner, {
    pushEnabled: 'true',
    readingReminderCycle: '',
    highlightPushCycle: '',
  })
  assert.match(saved, /기본 알림 주기를 적용했습니다/)
  let current = (await state()).settings
  assert.deepEqual(current.owner, [{ pushEnabled: true, readingReminderCycle: 3, highlightPushCycle: 7 }])
  assert.deepEqual(current.ownerWeeklyNudge, [true])

  // 하나라도 고른 알림이 있으면 사용자가 정한 값을 그대로 둡니다.
  const chosen = await post('/xapi/settings/save', owner, {
    pushEnabled: 'true',
    readingReminderCycle: '',
    highlightPushCycle: '',
    weeklyReadingNudgeEnabled: 'true',
  })
  assert.doesNotMatch(chosen, /기본 알림 주기/)
  current = (await state()).settings
  assert.deepEqual(current.owner, [{ pushEnabled: true, readingReminderCycle: 0, highlightPushCycle: 0 }])
  assert.deepEqual(current.ownerWeeklyNudge, [true])

  await post('/xapi/settings/save', owner, { pushEnabled: '', readingReminderCycle: '', highlightPushCycle: '' })
  current = (await state()).settings
  assert.deepEqual(current.owner, [{ pushEnabled: false, readingReminderCycle: 0, highlightPushCycle: 0 }])
  assert.deepEqual(current.ownerWeeklyNudge, [false])
})

test('A stranger who shelves the same book cannot change or delete the owner’s records', async () => {
  const shared = { bookId, highlightId: 'ownerquote00001' }

  await post('/xapi/books/update-highlight', stranger, { ...shared, quoteText: '바꾼 문구', noteText: '바꾼 메모' })
  await post('/xapi/books/delete-highlight', stranger, shared)
  await post('/xapi/books/delete-review', stranger, { bookId })
  await post('/xapi/books/reset-reading-sessions', stranger, { bookId })
  assert.match(await post('/xapi/books/remove-from-shelf', stranger, { bookId }), /내 도서함에서 책을 제거했습니다/)

  const afterStranger = await state()
  for (const [key, value] of Object.entries(ownerRecords)) {
    assert.deepEqual(afterStranger[key], value, key + ' survives the stranger')
  }
  assert.equal(afterStranger.strangerShelf, false, 'the stranger only removed their own shelf entry')

  for (const route of ['update-highlight', 'delete-highlight']) {
    assert.match(
      await post('/xapi/books/' + route, outsider, { ...shared, quoteText: '바꾼 문구' }),
      /^\/books\/ownedbook000001/
    )
  }
  assert.deepEqual((await state()).highlight, ownerRecords.highlight)
})

test('The owner can edit and remove their own records, and leaving the shelf clears them all', async () => {
  const shared = { bookId, highlightId: 'ownerquote00001' }

  assert.match(
    await post('/xapi/books/update-highlight', owner, { ...shared, quoteText: '고친 문구', noteText: '고친 메모' }),
    /인상 깊은 문구를 수정했습니다/
  )
  assert.deepEqual((await state()).highlight, { quote: '고친 문구', note: '고친 메모' })

  assert.match(await post('/xapi/books/reset-reading-sessions', owner, { bookId }), /독서 시간을 초기화했습니다/)
  assert.equal((await state()).ownerSessions, 0)

  assert.match(await post('/xapi/books/delete-review', owner, { bookId }), /감상평을 삭제했습니다/)
  assert.equal((await state()).review, false)

  assert.match(await post('/xapi/books/delete-highlight', owner, shared), /인상 깊은 문구를 삭제했습니다/)
  assert.equal((await state()).highlight, null)

  assert.match(await post('/xapi/books/remove-from-shelf', owner, { bookId }), /내 도서함에서 책을 제거했습니다/)
  const cleared = await state()
  assert.equal(cleared.ownerShelf, false)
  assert.equal(cleared.bookmark, false)
  assert.equal(cleared.audioProgress, false)
  assert.notEqual(cleared.book, null, 'the shared book itself stays for other readers')
})

test('Sign-up creates a pending reader regardless of extra fields and rejects bad input', async () => {
  const signUp = async (input) => {
    const response = await fetch(service.baseUrl + '/xapi/auth/sign-up', {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(input),
    })
    assert.equal(response.status, 303)
    return {
      location: decodeURIComponent(response.headers.get('location') || ''),
      cookie: response.headers.get('set-cookie'),
    }
  }
  const valid = { email: 'signup@example.com', password: 'signup-password-1', passwordConfirm: 'signup-password-1' }

  for (const [input, message] of [
    [{ ...valid, password: 'short', passwordConfirm: 'short' }, /비밀번호는 8자 이상/],
    [{ ...valid, passwordConfirm: 'different-password' }, /비밀번호 확인이 일치하지 않습니다/],
    [{ ...valid, email: '' }, /이메일이 필요합니다/],
  ]) {
    const result = await signUp(input)
    assert.match(result.location, /^\/auth/)
    assert.match(result.location, message)
  }
  assert.deepEqual((await state()).users, [])

  const created = await signUp({ ...valid, booklog_enabled: 'true', admin_manager: 'true', verified: 'true' })
  assert.match(created.location, /^\/(\?|$)/)
  assert.ok(created.cookie, 'a new reader is signed in right away')
  assert.deepEqual((await state()).users, [{ email: 'signup@example.com', booklogEnabled: false, adminManager: false }])

  const pendingCookie = { Cookie: created.cookie.split(';')[0] }
  for (const route of ['/library', '/books/' + bookId + '/read', '/settings']) {
    const response = await fetch(service.baseUrl + route, { redirect: 'manual', headers: pendingCookie })
    assert.notEqual(response.status, 200, route + ' stays closed until approval')
  }

  const duplicate = await signUp(valid)
  assert.match(duplicate.location, /^\/auth/)
  assert.equal((await state()).users.length, 1)
})

test('Merging old reading sessions combines each reader’s same-day sessions for one file and nothing else', async () => {
  const before = (await state()).mergeSessions
  const byId = (list) => Object.fromEntries(list.map((session) => [session.id, session]))
  const original = byId(before)

  const response = await request('/_test/reading-session-merge', null, {})
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.mergedGroupCount, 2)
  assert.equal(result.deletedCount, 3)

  const afterMerge = byId((await state()).mergeSessions)
  assert.deepEqual(Object.keys(afterMerge).sort(), [
    'mergea000000001',
    'mergeb000000001',
    'mergeb000000002',
    'mergec000000001',
    'mergec000000002',
    'merged000000001',
    'merged000000002',
    'mergee000000001',
    'mergef000000001',
  ])
  const acrossUtcMidnight = afterMerge.mergef000000001
  assert.equal(acrossUtcMidnight.durationSeconds, 1500, 'one Korean day that spans UTC midnight is merged')
  assert.equal(acrossUtcMidnight.endedAt, original.mergef000000002.endedAt)
  const merged = afterMerge.mergea000000001
  assert.equal(merged.durationSeconds, 2100, 'reading time is added up')
  assert.equal(merged.startedAt, original.mergea000000001.startedAt, 'starts when the first session started')
  assert.equal(merged.endedAt, original.mergea000000002.endedAt, 'ends when the latest session ended')
  assert.equal(merged.startLocator, 'first-start')
  assert.equal(merged.endLocator, 'latest-end')
  assert.equal(merged.endChapterLabel, '3장')
  assert.deepEqual([merged.startProgressPercent, merged.endProgressPercent, merged.progressDeltaPercent], [10, 16, 6])
  assert.deepEqual([merged.startPage, merged.endPage, merged.pageDelta], [20, 40, 20])

  for (const id of Object.keys(afterMerge).filter((key) => !['mergea000000001', 'mergef000000001'].includes(key))) {
    assert.deepEqual(afterMerge[id], original[id], id + ' is left as it was')
  }

  const again = await (await request('/_test/reading-session-merge', null, {})).json()
  assert.deepEqual([again.mergedGroupCount, again.deletedCount], [0, 0], 'running again changes nothing')
  assert.equal((await state()).mergeSessions.length, 9)
})
