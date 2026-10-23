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
const port = 18097
let fixtureDir
let service

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-push-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  // 실제 알림이 나가지 않도록 발송만 기록용 대체 모듈로 바꾸고, 작업 로직과 발송 기록은 그대로 씁니다.
  copyFileSync(
    new URL('./fixtures/onesignal-stub.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/jobs/onesignal-service.js')
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
    new URL('./fixtures/push-jobs-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(path.join(fixtureDir, '.env'), 'APP_ENV=production\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n')
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-push-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function call(route) {
  const response = await fetch(service.baseUrl + route, {
    method: route.startsWith('/_test/push/state') ? 'GET' : 'POST',
  })
  assert.equal(response.status, 200, route)
  return response.json()
}

const run = (job) => call('/_test/push/run?job=' + job)
const state = () => call('/_test/push/state')

function attemptsFor(current, userId) {
  return current.attempts.filter((attempt) => attempt.userId === userId)
}

function logsFor(current, userId, key) {
  return current.logs.filter((log) => log.userId === userId && log.key === key)
}

function lastReason(current, userId, key) {
  return logsFor(current, userId, key).at(-1)?.reason
}

test('Reading reminders go once a day to readers who stopped long enough, and wait a full cycle before repeating', async () => {
  const key = 'reading_reminder'
  await call('/_test/push/fail?users=readuser0000005')

  const first = await run('reading')
  assert.equal(first.matchedUserCount, 4, 'readers with push turned off are not even considered')
  let current = await state()
  assert.equal(attemptsFor(current, 'readuser0000001').length, 1)
  assert.match(attemptsFor(current, 'readuser0000001')[0].contents, /"알림 책"[\s\S]*5일째 멈춰 있어요/)
  assert.equal(attemptsFor(current, 'readuser0000002').length, 0)
  assert.equal(lastReason(current, 'readuser0000002', key), 'reading_activity_recent')
  assert.equal(attemptsFor(current, 'readuser0000003').length, 0)
  assert.equal(logsFor(current, 'readuser0000003', key).length, 0)
  assert.equal(lastReason(current, 'readuser0000004', key), 'missing_reading_history')
  assert.deepEqual(
    logsFor(current, 'readuser0000005', key).map((log) => log.status),
    ['failed'],
    'a failed delivery is recorded as failed, not sent'
  )

  await run('reading')
  current = await state()
  assert.equal(attemptsFor(current, 'readuser0000001').length, 1, 'no second reminder on the same day')
  assert.equal(lastReason(current, 'readuser0000001', key), 'already_sent_today')
  assert.equal(attemptsFor(current, 'readuser0000005').length, 2, 'a failed delivery is retried on the next run')

  await call('/_test/push/fail?users=')
  await run('reading')
  current = await state()
  assert.equal(attemptsFor(current, 'readuser0000005').length, 3)
  assert.equal(logsFor(current, 'readuser0000005', key).filter((log) => log.status === 'sent').length, 1)

  await call('/_test/push/backdate?user=readuser0000001&key=' + key + '&days=2')
  await run('reading')
  current = await state()
  assert.equal(attemptsFor(current, 'readuser0000001').length, 1, 'two days later is still inside the 3-day cycle')
  assert.equal(lastReason(current, 'readuser0000001', key), 'cycle_not_due')

  await call('/_test/push/backdate?user=readuser0000001&key=' + key + '&days=3')
  await run('reading')
  current = await state()
  assert.equal(attemptsFor(current, 'readuser0000001').length, 2, 'a full cycle later the reminder goes again')
  const sent = logsFor(current, 'readuser0000001', key).filter((log) => log.status === 'sent')
  assert.equal(new Set(sent.map((log) => log.dedupeKey)).size, sent.length, 'each sent reminder has its own day key')
})

test('Highlight reminders prefer a quote not sent in the last week and never repeat within the day or cycle', async () => {
  const key = 'highlight_reminder'

  await run('highlight')
  let current = await state()
  const attempts = attemptsFor(current, 'hluser000000001')
  assert.equal(attempts.length, 1)
  assert.match(attempts[0].contents, /아직 보내지 않은 문구/)
  assert.doesNotMatch(attempts[0].contents, /이틀 전에 보낸 문구/)
  assert.equal(logsFor(current, 'hluser000000001', key).at(-1).highlightId, 'hlquoteb0000001')
  assert.equal(attemptsFor(current, 'hluser000000002').length, 0)
  assert.equal(lastReason(current, 'hluser000000002', key), 'missing_highlight')
  assert.equal(attemptsFor(current, 'hluser000000003').length, 0)
  assert.equal(lastReason(current, 'hluser000000003', key), 'cycle_not_due')

  await run('highlight')
  current = await state()
  assert.equal(attemptsFor(current, 'hluser000000001').length, 1, 'no second quote on the same day')
  assert.equal(lastReason(current, 'hluser000000001', key), 'already_sent_today')
})

test('The weekly nudge goes once a week only to readers with no reading this week', async () => {
  const key = 'weekly_reading_nudge'

  const first = await run('weekly')
  assert.equal(first.matchedUserCount, 3, 'readers who turned the nudge off are not considered')
  let current = await state()
  assert.equal(attemptsFor(current, 'weekuser0000001').length, 1)
  assert.equal(attemptsFor(current, 'weekuser0000004').length, 1, 'reading last week does not count for this week')
  assert.equal(attemptsFor(current, 'weekuser0000002').length, 0)
  assert.equal(lastReason(current, 'weekuser0000002', key), 'has_weekly_reading_session')
  assert.equal(attemptsFor(current, 'weekuser0000003').length, 0)
  const sentKey = logsFor(current, 'weekuser0000001', key).find((log) => log.status === 'sent').dedupeKey
  assert.match(sentKey, /^weekly_reading_nudge:weekuser0000001:\d{4}-\d{2}-\d{2}$/)

  await run('weekly')
  current = await state()
  assert.equal(attemptsFor(current, 'weekuser0000001').length, 1, 'no second nudge in the same week')
  assert.equal(lastReason(current, 'weekuser0000001', key), 'already_sent_this_week')
})

test('Send logs older than 90 days are cleaned up while recent ones stay', async () => {
  const before = (await state()).logs.filter((log) => log.userId === 'cleanuser000001')
  assert.deepEqual(before.map((log) => log.title).sort(), ['old', 'recent'])

  const result = await run('cleanup')
  assert.equal(result.deletedCount, 1)
  const afterCleanup = (await state()).logs.filter((log) => log.userId === 'cleanuser000001')
  assert.deepEqual(
    afterCleanup.map((log) => log.title),
    ['recent']
  )
})
