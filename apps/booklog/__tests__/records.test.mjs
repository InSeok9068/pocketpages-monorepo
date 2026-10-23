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
const port = 18100
let fixtureDir
let service
let anchors
const sessions = {}

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-records-test-'))
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
    new URL('./fixtures/records-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  for (const id of ['recorduser00001', 'homeuser0000001']) sessions[id] = await signIn(id + '@example.com')
  anchors = await (await fetch(service.baseUrl + '/_test/records-anchors')).json()
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-records-test-'))
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

async function page(route, user) {
  const response = await fetch(service.baseUrl + route, { headers: sessions[user] })
  const source = await response.text()
  assert.equal(response.status, 200, source.slice(0, 500))
  return load(source)
}

function addDays(dateText, days) {
  const date = new Date(dateText + 'T00:00:00.000Z')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function weekLabel(monday) {
  return monday.slice(5) + ' ~ ' + addDays(monday, 6).slice(5)
}

function weekRows($) {
  return $('button[aria-controls^="week-dialog-"]')
    .toArray()
    .map((button) => ({
      key: $(button).attr('aria-controls').replace('week-dialog-', ''),
      label: $(button).children('span').first().text().trim(),
      time: $(button).children('span').last().text().trim(),
    }))
}

function summary($) {
  return $('section.grid > div')
    .toArray()
    .map((card) => $(card).find('p').last().text().trim())
}

test('Reading records split weeks at Monday 00:00 Korean time and only count this reader’s timed sessions', async () => {
  const { monday } = anchors
  const $ = await page('/reading-records', 'recorduser00001')

  assert.deepEqual(summary($), ['10분', '1시간 40분', '2권'], 'this week, all-time total and finished books')
  assert.deepEqual(
    weekRows($),
    [-21, -14, -7, 0].map((offset, index) => ({
      key: addDays(monday, offset),
      label: weekLabel(addDays(monday, offset)),
      time: ['30분', '0분', '20분', '10분'][index],
    })),
    'Sunday 23:50 goes to the week before Monday 00:10, and the session before the four weeks is left out'
  )
  assert.equal($('#week-dialog-' + monday + ' li').length, 1)
  assert.match($('#week-dialog-' + monday + ' li').text(), /기록 책\s+10분/)
  assert.equal($('[aria-label="다음 4주"]').attr('aria-disabled'), 'true')
})

test('Moving to the previous four weeks shows the session that fell just before them, and a future week stays on this week', async () => {
  const { monday } = anchors
  const previousStart = addDays(monday, -28)
  let $ = await page('/reading-records', 'recorduser00001')
  assert.equal($('a[aria-label="이전 4주"]').attr('href'), '/reading-records?week=' + previousStart)
  $ = await page('/reading-records?week=' + previousStart, 'recorduser00001')

  assert.deepEqual(
    weekRows($).map((row) => [row.key, row.time]),
    [
      [addDays(monday, -49), '0분'],
      [addDays(monday, -42), '0분'],
      [addDays(monday, -35), '0분'],
      [previousStart, '40분'],
    ]
  )
  assert.equal(summary($)[0], '10분', 'the summary always describes the current week')
  assert.equal($('a[aria-label="다음 4주"]').attr('href'), '/reading-records?week=' + monday)
  assert.equal($('a[href="/reading-records"]:contains("이번 주로 돌아가기")').length, 1)

  $ = await page('/reading-records?week=2999-01-07', 'recorduser00001')
  assert.equal(weekRows($).at(-1).key, monday)
  $ = await page('/reading-records?week=not-a-date', 'recorduser00001')
  assert.equal(weekRows($).at(-1).key, monday)
})

test('The home week marks days by Korean date, so 00:10 counts for today and 23:50 for yesterday', async () => {
  const { today, monday } = anchors
  const yesterday = addDays(today, -1)
  const $ = await page('/', 'homeuser0000001')
  const dots = $('[aria-label="이번 주 독서 기록"] span[aria-label]')
    .toArray()
    .map((dot) => $(dot).attr('aria-label'))

  assert.equal(dots.length, 7)
  assert.ok(dots[0].startsWith(monday + ' '), 'the week starts on Monday')
  assert.ok(dots.includes(today + ' 독서함'))
  if (today === monday) {
    assert.equal($('p:contains("이번 주")').first().text().trim(), '이번 주 1일 읽었어요')
  } else {
    assert.ok(dots.includes(yesterday + ' 독서함'))
    assert.equal($('p:contains("이번 주")').first().text().trim(), '이번 주 2일 읽었어요')
    const earlier = dots.filter((dot) => dot < yesterday && dot.endsWith('독서 기록 없음'))
    assert.equal(earlier.length, Math.max(0, (Date.parse(yesterday) - Date.parse(monday)) / 86_400_000))
  }
  assert.equal(dots.filter((dot) => dot.endsWith('아직 오지 않은 날')).length, 6 - dots.indexOf(today + ' 독서함'))
})
