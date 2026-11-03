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
  for (const id of ['recorduser00001', 'homeuser0000001', 'calendaruser001'])
    sessions[id] = await signIn(id + '@example.com')
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

function calendarDay($, key) {
  assert.equal($('section.grid > div').length, 0, 'the calendar view does not render summary cards')
  return $('button[aria-controls="reading-day-details"]').filter(
    (_, button) => $(button).attr('@click') === "selectedDay = '" + key + "'"
  )
}

function calendarDetails($, key) {
  return $('#reading-day-details > div[x-show]').filter(
    (_, panel) => $(panel).attr('x-show') === "selectedDay === '" + key + "'"
  )
}

test('마지막 독서 기록 보기를 복원하고 명시한 보기와 주차 링크를 우선한다', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext()
    await context.route('https://**/*', (route) => route.abort())
    const entry = sessions.recorduser00001.Cookie
    const separator = entry.indexOf('=')
    await context.addCookies([
      { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: service.baseUrl },
    ])
    const browserPage = await context.newPage()
    browserPage.setDefaultTimeout(10000)
    const storageKey = 'booklog.readingRecords.view'
    await browserPage.goto(service.baseUrl + '/reading-records')
    await browserPage.getByRole('link', { name: '달력 보기', exact: true }).click()
    await browserPage.waitForURL('**/reading-records?view=calendar&month=*')
    assert.equal(await browserPage.evaluate((key) => globalThis.localStorage.getItem(key), storageKey), 'calendar')
    await browserPage.goto(service.baseUrl + '/reading-records')
    await browserPage.waitForURL('**/reading-records?view=calendar')
    await browserPage.getByRole('link', { name: '주차별 보기', exact: true }).click()
    await browserPage.waitForURL('**/reading-records?view=weekly')
    assert.equal(await browserPage.evaluate((key) => globalThis.localStorage.getItem(key), storageKey), 'weekly')
    await browserPage.goto(service.baseUrl + '/reading-records')
    await browserPage.getByRole('heading', { name: '주차별 독서 시간' }).waitFor()
    await browserPage.evaluate((key) => globalThis.localStorage.setItem(key, 'calendar'), storageKey)
    await browserPage.goto(service.baseUrl + '/reading-records?week=' + anchors.monday)
    await browserPage.getByRole('heading', { name: '주차별 독서 시간' }).waitFor()
    assert.equal(await browserPage.evaluate((key) => globalThis.localStorage.getItem(key), storageKey), 'weekly')
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, 'localStorage', {
        get() {
          throw new Error('storage blocked')
        },
      })
    })
    await browserPage.goto(service.baseUrl + '/reading-records')
    await browserPage.getByRole('link', { name: '달력 보기', exact: true }).click()
    await browserPage.getByRole('region', { name: '독서 달력' }).waitFor()
  } finally {
    await browser.close()
  }
})

test('Reading records split weeks at Monday 00:00 Korean time and only count this reader’s timed sessions', async () => {
  const { monday } = anchors
  const $ = await page('/reading-records', 'recorduser00001')

  assert.deepEqual(
    $('section.grid > div')
      .toArray()
      .map((card) => $(card).find('p').last().text().trim()),
    ['10분', '1시간 40분', '2권'],
    'the weekly view keeps the summary cards'
  )
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

  assert.equal($('a[aria-label="다음 4주"]').attr('href'), '/reading-records?week=' + monday)
  assert.equal($('a[href="/reading-records?view=weekly"]:contains("이번 주로 돌아가기")').length, 1)

  $ = await page('/reading-records?week=2999-01-07', 'recorduser00001')
  assert.equal(weekRows($).at(-1).key, monday)
  $ = await page('/reading-records?week=not-a-date', 'recorduser00001')
  assert.equal(weekRows($).at(-1).key, monday)
})

test('달력은 같은 책의 세션을 합산해 최장 독서 책의 표지를 표시하고 다른 사용자는 제외한다', async () => {
  const $ = await page('/reading-records?view=calendar&month=2024-02', 'calendaruser001')
  const day = calendarDay($, '2024-02-15')
  const details = calendarDetails($, '2024-02-15')

  assert.equal(day.length, 1)
  assert.equal(day.attr('aria-label'), '2월 15일, 2권 · 1시간 25분')
  assert.equal(day.find('img').attr('src'), 'https://example.com/calendar-main.jpg')
  assert.match(day.text(), /\+1/)
  assert.equal(details.length, 1)
  assert.deepEqual(
    details
      .find('li')
      .toArray()
      .map((item) => [
        $(item).find('p').text().trim(),
        $(item).children('span').text().trim(),
        $(item).find('img').attr('src'),
      ]),
    [
      ['합산 대표 책', '45분', 'https://example.com/calendar-main.jpg'],
      ['단일 세션 책', '40분', 'https://example.com/calendar-second.jpg'],
    ]
  )
  assert.equal($('img[src="https://example.com/calendar-other.jpg"]').length, 0)
  assert.doesNotMatch($('[aria-label="독서 달력"]').text(), /다른 사용자 책/)
})

test('달력은 KST 종료일로 월 경계와 윤일의 기록을 나눈다', async () => {
  const $ = await page('/reading-records?view=calendar&month=2024-02', 'calendaruser001')

  assert.equal($('button[aria-controls="reading-day-details"]').length, 29)
  for (const [key, label] of [
    ['2024-02-01', '2월 1일, 1권 · 10분'],
    ['2024-02-28', '2월 28일, 1권 · 5분'],
    ['2024-02-29', '2월 29일, 1권 · 15분'],
  ]) {
    assert.equal(calendarDay($, key).attr('aria-label'), label)
    assert.equal(calendarDetails($, key).length, 1)
    assert.equal(calendarDetails($, key).find('li').length, 1)
  }
  assert.equal(calendarDay($, '2024-01-31').length, 0)
  assert.equal(calendarDay($, '2024-03-01').length, 0)
  assert.match($('[aria-label="독서 달력"] h2 + p').text(), /4일 동안 읽었어요 · 1시간 55분/)
  assert.equal($('a[aria-label="이전 달"]').attr('href'), '/reading-records?view=calendar&month=2024-01')
  assert.equal($('a[aria-label="다음 달"]').attr('href'), '/reading-records?view=calendar&month=2024-03')
})

test('달력의 모든 날짜 버튼은 해당 날짜 상세와 연결되고 빈 날짜는 기록 없음을 표시한다', async () => {
  const $ = await page('/reading-records?view=calendar&month=2024-02', 'calendaruser001')

  assert.equal($('#reading-day-details > div[x-show]').length, 29)
  for (let day = 1; day <= 29; day += 1) {
    const key = '2024-02-' + String(day).padStart(2, '0')
    assert.equal(calendarDay($, key).length, 1, key)
    assert.equal(calendarDetails($, key).length, 1, key)
    assert.equal(calendarDetails($, key).find('h3').text(), '2월 ' + day + '일')
  }
  const empty = calendarDay($, '2024-02-02')
  assert.equal(empty.attr('aria-label'), '2월 2일, 독서 기록 없음')
  assert.equal(empty.find('img').length, 0)
  assert.equal(empty.is('[disabled]'), false)
  const details = calendarDetails($, '2024-02-02')
  assert.equal(details.find('li').length, 0)
  assert.match(details.text(), /0권 · 0분/)
  assert.match(details.text(), /이날에는 독서 기록이 없습니다\./)
})

test('독서 달력은 월요일부터 일요일까지 배치하고 월초 빈칸을 맞춘다', async () => {
  for (const [month, leading] of [
    ['2024-01', 0],
    ['2024-02', 3],
    ['2024-09', 6],
  ]) {
    const $ = await page('/reading-records?view=calendar&month=' + month, 'calendaruser001')
    const grid = $('[aria-label="독서 달력"] .grid-cols-7')
    assert.deepEqual(
      grid
        .children('span')
        .toArray()
        .map((label) => $(label).text().trim()),
      ['월', '화', '수', '목', '금', '토', '일']
    )
    const cells = grid.children('div, button')
    assert.equal(cells.index(calendarDay($, month + '-01')), leading)
    assert.equal(cells.length % 7, 0)
  }
})

test('잘못되거나 미래인 month는 이번 달로 정규화하고 오늘과 미래 날짜를 구분한다', async () => {
  const { today } = anchors
  const month = today.slice(0, 7)
  const todayLabel = Number(today.slice(5, 7)) + '월 ' + Number(today.slice(8)) + '일'
  const dayCount = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()

  for (const value of [month, 'not-a-month', '2024-13', '2024-2', '2999-01']) {
    const $ = await page('/reading-records?view=calendar&month=' + value, 'homeuser0000001')
    assert.equal(
      $('[aria-label="독서 달력"] h2').text(),
      Number(today.slice(0, 4)) + '년 ' + Number(today.slice(5, 7)) + '월',
      value
    )
    const days = $('button[aria-controls="reading-day-details"]')
    assert.equal(days.length, dayCount, value)
    assert.equal(calendarDay($, today).attr('aria-label'), todayLabel + ' 오늘, 1권 · 5분', value)
    assert.equal(calendarDay($, today).attr('aria-current'), 'date')
    assert.equal(calendarDay($, today).is('[disabled]'), false)
    assert.equal(calendarDetails($, today).attr('style'), '')
    assert.equal(days.filter('[disabled]').length, dayCount - Number(today.slice(8)))
    assert.equal($('[aria-label="다음 달"]').attr('aria-disabled'), 'true')
    assert.equal($('a[aria-label="다음 달"]').length, 0)
  }
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
