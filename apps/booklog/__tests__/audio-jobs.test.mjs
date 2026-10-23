/* global window */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  copyFileSync,
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'
import { startService } from '@pocketpages/test-support/service-harness'
import { readCookieHeader } from '@pocketpages/test-support/auth-cookie'
import { chromium } from '@playwright/test'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const lite = 'gemini-3.8-flash-lite-tts'
const flash = 'gemini-3.8-flash-tts'
const bookId = (index) => 'book' + String(index).padStart(11, '0')
const fileId = (index) => 'file' + String(index).padStart(11, '0')
let fixtureDir
let service
let cookie
const mediaCache = fileURLToPath(new URL('../../../.cache/booklog-media-tools/node_modules/', import.meta.url))
const ffmpegBin =
  process.env.BOOKLOG_FFMPEG_BIN
  || path.join(mediaCache, 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobeBin =
  process.env.BOOKLOG_FFPROBE_BIN
  || path.join(
    mediaCache,
    'ffprobe-static/bin',
    process.platform === 'win32' ? 'win32/x64/ffprobe.exe' : 'linux/x64/ffprobe'
  )
const hasMediaTools = existsSync(ffmpegBin) && existsSync(ffprobeBin)
let fixtureFfmpeg

before(async () => {
  // 실데이터·API 키·cron을 복사하지 않고 기존 HTTP harness로 실제 JSVM/DB를 검증합니다.
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-audio-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:18094' }"
    )
  )
  const binary = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'
  copyFileSync(path.join(serviceDir, binary), path.join(fixtureDir, binary))
  symlinkSync(realpathSync(path.join(serviceDir, 'node_modules')), path.join(fixtureDir, 'node_modules'), 'junction')
  const schema = JSON.parse(readFileSync(path.join(serviceDir, 'pb_schema.json'), 'utf8')).filter(
    (collection) => collection.name !== '_superusers'
  )
  writeFileSync(path.join(fixtureDir, 'pb_hooks/test-schema.json'), JSON.stringify(schema))
  if (hasMediaTools) {
    fixtureFfmpeg = path.join(fixtureDir, path.basename(ffmpegBin))
    copyFileSync(ffmpegBin, fixtureFfmpeg)
  }
  copyFileSync(
    new URL('./fixtures/audio-jobs-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    [
      'APP_ENV=production',
      'BOOKLOG_TTS_MODEL=' + lite,
      'GEMINI_API_KEY=',
      'GEMINI_APIKEY=',
      'GEMINI_AI_KEY=',
      'ONESIGNAL_API_KEY=',
      'ONESIGNAL_APPID=',
      ...(hasMediaTools
        ? [
            'BOOKLOG_FFMPEG_BIN=' + fixtureFfmpeg.replace(/\\/g, '/'),
            'BOOKLOG_FFPROBE_BIN=' + ffprobeBin.replace(/\\/g, '/'),
          ]
        : []),
    ].join('\n')
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port: 18094, timeoutMs: 30000 })
  const response = await fetch(service.baseUrl + '/xapi/auth/sign-in', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ email: 'admin-manager@example.com', password: 'test-password-1234' }),
  })
  assert.equal(response.status, 303)
  cookie = readCookieHeader(response.headers)
  assert.ok(cookie, 'manager sign-in must set an auth cookie')
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-audio-test-'))
    rmSync(resolved, { recursive: true, force: true })
  }
})

async function detail(index) {
  const response = await fetch(service.baseUrl + '/books/' + bookId(index), { headers: { Cookie: cookie } })
  const html = await response.text()
  assert.equal(response.status, 200, html.slice(0, 500))
  return load(html)
}

async function request(index, action = 'start', model, extra = {}) {
  const input = { bookId: bookId(index), fileId: fileId(index), action, ...extra }
  if (model) input.model = model
  const response = await fetch(service.baseUrl + '/xapi/books/audio-job', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
    body: new URLSearchParams(input),
  })
  assert.equal(response.status, 303)
  return response
}

async function jobs() {
  return (await (await fetch(service.baseUrl + '/_test/audio-state')).json()).jobs
}

async function control(index, options) {
  const response = await fetch(service.baseUrl + '/_test/audio-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: fileId(index), ...options }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

test('Book-level model reservations, concurrent requests, resume, playback and release work through HTTP', async () => {
  let $ = await detail(1)
  assert.equal($('select[name=model] option[selected]').val(), lite)
  assert.equal($('select[name=model] option[disabled]').length, 0)
  await request(1)
  $ = await detail(2)
  assert.ok($(`select[name=model] option[value="${lite}"]`).is('[disabled]'))
  assert.equal($('select[name=model] option[selected]').val(), flash)
  assert.ok($.text().includes('테스트 책 1 <제목>'))
  await request(2, 'start', lite)
  assert.equal((await jobs()).length, 1, 'a forged POST cannot reserve an occupied model')

  await Promise.all([request(2, 'start', flash), request(3, 'start', flash)])
  let registered = await jobs()
  assert.equal(registered.length, 2, 'simultaneous requests reserve the model only once')
  const flashJob = registered.find((job) => job.model === flash)
  const flashBook = flashJob.file_id === fileId(2) ? 2 : 3
  const waitingBook = flashBook === 2 ? 3 : 2
  $ = await detail(4)
  assert.equal($('select[name=model] option[disabled]').length, 2)
  assert.ok($('dialog form button[type=submit]').is(':disabled'))
  await request(4, 'start', flash)
  assert.equal((await jobs()).length, 2)

  const originalHash = registered.find((job) => job.model === lite).config_hash
  await request(1, 'pause')
  assert.ok((await detail(4))(`select[name=model] option[value="${lite}"]`).is('[disabled]'))
  await request(1, 'start', flash)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(1)).status, 'paused')
  await request(1, 'start', lite)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(1)).config_hash, originalHash)
  await control(1, { status: 'failed' })
  assert.ok(
    !(await detail(4))(`select[name=model] option[value="${lite}"]`).is('[disabled]'),
    'a job that failed before registering chunks releases its model'
  )
  await request(1, 'start', lite)

  await control(flashBook, { playback: true })
  const played = await detail(flashBook)
  assert.match(played.text(), /생성 완료 · 1분 \/ 약 1분 \(100%\)/, 'progress is shown by the stored audio length')
  assert.match(played.text(), /1 \/ 1 구간/)
  const compressRequest = (kbps) =>
    fetch(service.baseUrl + '/admin/books?scope=all', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie },
      body: new URLSearchParams({
        action: 'audio-compress',
        bookId: bookId(flashBook),
        fileId: fileId(flashBook),
        kbps: String(kbps),
      }),
    })
  const adminQuery = '/admin/books?scope=all&q=' + encodeURIComponent('테스트 책 ' + flashBook)
  let admin = load(await (await fetch(service.baseUrl + adminQuery, { headers: { Cookie: cookie } })).text())
  assert.deepEqual(
    admin('dialog[id^=audio-compress-dialog] select[name=kbps] option')
      .toArray()
      .map((option) => admin(option).val()),
    ['96', '64', '48']
  )
  assert.equal(
    admin('dialog[id^=audio-compress-dialog] select[name=kbps] option[selected]').val(),
    '64',
    '64kbps is offered by default'
  )
  assert.equal((await compressRequest(32)).status, 303)
  assert.equal(Number((await jobs()).find((job) => job.file_id === fileId(flashBook)).compress_kbps || 0), 0)
  await compressRequest(64)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(flashBook)).compress_kbps, 64)
  admin = load(await (await fetch(service.baseUrl + adminQuery, { headers: { Cookie: cookie } })).text())
  assert.match(admin.text(), /압축 64kbps · 0 \/ 1 구간/)
  const query = new URLSearchParams({ bookId: bookId(flashBook), fileId: fileId(flashBook) })
  const headers = { Cookie: cookie }
  let response = await fetch(service.baseUrl + '/api/books/audio-progress?' + query, { headers })
  assert.equal(
    (await response.json()).configHash,
    flashJob.config_hash,
    'playback uses the stored Flash settings despite the Lite env'
  )
  query.set('sectionIndex', '0')
  query.set('chunkIndex', '0')
  response = await fetch(service.baseUrl + '/api/books/audio-chunk?' + query, { headers })
  const chunk = await response.json()
  assert.equal(response.status, 200, JSON.stringify(chunk))
  assert.equal(chunk.configHash, flashJob.config_hash)
  response = await fetch(service.baseUrl + chunk.parts[0].audioUrl, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  response = await fetch(service.baseUrl + '/books/' + bookId(flashBook) + '/read', { headers })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('reader-cloud-audio'))
  query.set('anchor', '낭독 테스트 문장입니다.')
  response = await fetch(service.baseUrl + '/api/books/audio-position?' + query, { headers })
  assert.equal((await response.json()).chunkIndex, 0)
  response = await fetch(service.baseUrl + '/api/books/audio-progress', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      bookId: bookId(flashBook),
      fileId: fileId(flashBook),
      configHash: chunk.configHash,
      chunkId: chunk.chunkId,
      seconds: '24',
    }),
  })
  assert.equal(response.status, 200)
  response = await fetch(service.baseUrl + '/api/books/audio-progress?' + query, { headers })
  assert.equal((await response.json()).progress.seconds, 24)

  await request(waitingBook, 'start', flash)
  assert.equal((await jobs()).length, 3, 'a completed book releases its model')
  assert.equal((await control(flashBook, { regenerate: true, apply: true })).reset, 0)
  await request(waitingBook, 'delete')
  assert.equal(
    (await control(flashBook, { apply: true })).reset,
    1,
    'regeneration waits until the other book releases the model'
  )
  await request(flashBook, 'pause')
  assert.equal((await jobs()).find((job) => job.file_id === fileId(flashBook)).status, 'paused')
  $ = await detail(flashBook)
  assert.equal($('input[name=model]').length, 1, 'an existing book keeps its selected model')
  assert.equal($('input[name=model]').val(), flash)
  assert.equal($('dialog').filter((_, element) => $(element).text().includes('AI 오디오북 생성')).length, 0)
  await request(flashBook, 'start', flash)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(flashBook)).config_hash, flashJob.config_hash)
  await request(1, 'delete')
  $ = await detail(4)
  assert.equal($('select[name=model] option[selected]').val(), lite)
  assert.equal($('select[name=voice] option').length, 5)
  assert.equal($('select[name=voice] option[selected]').val(), 'Sulafat')
  assert.equal($('select[name=style] option[selected]').val(), 'calm')
  await request(4, 'start', lite, { voice: 'Unknown', style: 'calm' })
  assert.equal((await jobs()).filter((job) => job.file_id === fileId(4)).length, 0, 'unknown voices are rejected')
  await request(4, 'start', lite, { voice: 'Gacrux', style: 'nonfiction' })
  const chosen = (await jobs()).find((job) => job.file_id === fileId(4))
  assert.equal(chosen.model, lite)
  assert.equal(chosen.voice, 'Gacrux')
  assert.match(chosen.style, /^논픽션 오디오북 낭독가/)
  const adminList = load(
    await (
      await fetch(service.baseUrl + '/admin/books?scope=all&q=' + encodeURIComponent('테스트 책 6'), {
        headers: { Cookie: cookie },
      })
    ).text()
  )
  assert.equal(
    adminList('dialog select[name=voice] option[selected]').val(),
    'Sulafat',
    'the admin list offers the same choices'
  )
  assert.equal(adminList('dialog select[name=style] option[selected]').val(), 'calm')
  assert.equal(adminList('dialog input[name=action]').val(), 'audio-start')
  await request(4, 'pause')
  await request(4, 'start', lite, { voice: 'Zephyr', style: 'essay' })
  const resumed = (await jobs()).find((job) => job.file_id === fileId(4))
  assert.equal(resumed.config_hash, chosen.config_hash, 'restarting keeps the first chosen voice and style')
  $ = await detail(4)
  assert.equal($('select[name=voice]').length, 0)
  const fixed = $('dl dt')
    .toArray()
    .map((element) => [$(element).text().trim(), $(element).next('dd').text().trim()])
  assert.deepEqual(fixed.slice(-2), [
    ['목소리', 'Gacrux · 성숙한 남성'],
    ['스타일', '설명형 낭독 (비소설)'],
  ])
})

async function scenario(index, name) {
  const response = await fetch(service.baseUrl + '/_test/audio-scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: fileId(index), name }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

const hasLame = spawnSync('lame', ['--version']).status === 0

test(
  'Compressing a ready part with lame replaces the 128kbps file with a mono file at the chosen bitrate',
  { skip: hasLame ? false : 'lame is not installed' },
  async () => {
    const job = (await jobs()).find((entry) => Number(entry.compress_kbps) === 64)
    assert.ok(job, 'the playback book from the first test has a ready part')
    const seconds = 3
    const rate = 24000
    const samples = Buffer.alloc(seconds * rate * 2)
    for (let index = 0; index < seconds * rate; index += 1) {
      samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8000), index * 2)
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + samples.length, 4)
    header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(rate, 24)
    header.writeUInt32LE(rate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(samples.length, 40)
    const wavPath = path.join(fixtureDir, 'tone.wav')
    const sourcePath = path.join(fixtureDir, 'tone.mp3')
    writeFileSync(wavPath, Buffer.concat([header, samples]))
    assert.equal(spawnSync('lame', ['--quiet', '-b', '128', '-m', 'm', wavPath, sourcePath]).status, 0)
    const sourceSize = readFileSync(sourcePath).length

    const response = await fetch(service.baseUrl + '/_test/audio-compress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: job.file_id, sourcePath, kbps: 64 }),
    })
    const compressed = await response.json()
    assert.equal(response.status, 200, JSON.stringify(compressed))
    assert.deepEqual(compressed.result, { jobId: job.id, compressed: 1, failed: 0 })
    assert.equal(compressed.kbps, 64)
    assert.ok(compressed.size < sourceSize * 0.6, compressed.size + ' / ' + sourceSize)
    assert.ok(Math.abs(compressed.durationSeconds - seconds) < 0.3, String(compressed.durationSeconds))
    assert.equal(compressed.sourceExists, false, 'the 128kbps file is removed with the record update')
    assert.equal(compressed.again.compressed, 0, 'an already compressed part is skipped')
  }
)

test('A job whose only missing parts were blocked by policy is completed and releases its model', async () => {
  const { job, chunks } = await scenario(5, 'blocked')
  assert.equal(job.status, 'completed')
  assert.equal(job.ready_chunks, 1)
  assert.match(job.error_message, /1개 구간은 정책 차단/)
  const $ = await detail(5)
  const failed = $('a[href^="/_/#/collections?collection=book_audio_chunks"]')
  assert.equal(failed.length, 1, 'only the part that finished retrying is listed for review')
  assert.equal(
    failed.attr('href'),
    '/_/#/collections?collection=book_audio_chunks&filter=' + encodeURIComponent("id = '" + chunks[1].id + "'")
  )
  assert.match(failed.text(), /0:1/)
  assert.match(failed.text(), /정책 차단\(80자 미만\)/)
  const adminResponse = await fetch(service.baseUrl + '/admin/books?scope=all&q=' + encodeURIComponent('테스트 책 5'), {
    headers: { Cookie: cookie },
  })
  const admin = load(await adminResponse.text())
  assert.equal(admin(`a[href="${failed.attr('href')}"]`).length, 1, 'the admin book list links the same part')
})

test('Resuming after chunks were re-planned moves a stale position to the nearest remaining chunk', async () => {
  const headers = { Cookie: cookie }
  const { job, chunks } = await scenario(6, 'plan')
  const save = (chunk) =>
    fetch(service.baseUrl + '/api/books/audio-progress', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        bookId: bookId(6),
        fileId: fileId(6),
        configHash: job.config_hash,
        chunkId: chunk.id,
        seconds: '12',
        listenedAt: new Date().toISOString(),
      }),
    })
  const load = async () => {
    const query = new URLSearchParams({ bookId: bookId(6), fileId: fileId(6) })
    const { progress } = await (await fetch(service.baseUrl + '/api/books/audio-progress?' + query, { headers })).json()
    return { sectionIndex: progress.sectionIndex, chunkIndex: progress.chunkIndex, seconds: progress.seconds }
  }

  assert.equal((await save(chunks.find((chunk) => chunk.sectionIndex === 0 && chunk.chunkIndex === 2))).status, 200)
  await scenario(6, 'replan')
  assert.deepEqual(
    await load(),
    { sectionIndex: 0, chunkIndex: 0, seconds: 0 },
    'a chunk beyond the shortened chapter falls back to its last chunk'
  )

  const replanned = (await scenario(6, 'plan')).chunks
  assert.equal((await save(replanned.find((chunk) => chunk.sectionIndex === 2))).status, 200)
  await scenario(6, 'replan')
  assert.deepEqual(
    await load(),
    { sectionIndex: 4, chunkIndex: 0, seconds: 0 },
    'a removed chapter resumes from the next chapter that still has narration'
  )
})

test('Real Chrome buffers authenticated split MP3s, restores DB progress after reload and completes each chapter', async () => {
  await scenario(7, 'browser-buffer')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext()
  try {
    await context.addCookies(
      cookie.split('; ').map((pair) => {
        const separator = pair.indexOf('=')
        return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: service.baseUrl }
      })
    )
    const page = await context.newPage()
    const errors = []
    const apiFailures = []
    const chunkRequests = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (response.url().includes('/api/books/audio-') && response.status() >= 400) apiFailures.push(response.status())
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/books/audio-chunk')
        chunkRequests.push([url.searchParams.get('sectionIndex'), url.searchParams.get('chunkIndex')])
    })
    await page.goto(service.baseUrl + '/_test/buffer-player')
    await page.click('#start')
    await page.waitForFunction(() => window.state.cloudAudioActive)
    await page.evaluate(() => window.booklogAudio.seekTo(4.4))
    await page.waitForFunction(() => !window.state.cloudAudioBusy && window.state.cloudAudioPosition >= 4.4)
    await page.evaluate(() => window.booklogAudio.toggle())
    await page.waitForFunction(() => !window.state.cloudAudioActive)
    await page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:browser-e2e') || '{}')).length === 0
    )
    const query = new URLSearchParams({ bookId: bookId(7), fileId: fileId(7) })
    const loaded = await (
      await fetch(service.baseUrl + '/api/books/audio-progress?' + query, { headers: { Cookie: cookie } })
    ).json()
    assert.equal(loaded.progress.sectionIndex, 0)
    assert.equal(loaded.progress.chunkIndex, 0)
    assert.ok(loaded.progress.seconds >= 4.4 && loaded.progress.seconds < 5.5, JSON.stringify(loaded.progress))
    const savedChapterSeconds = loaded.progress.chapterSeconds
    chunkRequests.length = 0
    await page.reload()
    await page.click('#start')
    await page.waitForFunction(() => window.state.cloudAudioActive)
    assert.deepEqual(chunkRequests[0], ['0', '0'])
    assert.ok(Math.abs((await page.evaluate(() => window.state.cloudAudioPosition)) - savedChapterSeconds) < 0.5)
    const src = await page.locator('audio').getAttribute('src')
    await page.waitForFunction(() => window.state.cloudAudioDetail.startsWith('1 / 1'))
    assert.equal(await page.locator('audio').getAttribute('src'), src)
    await page.waitForFunction(() => window.state.cloudAudioSession === false)
    await page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:browser-e2e') || '{}')).length === 0
    )
    const rows = await (await fetch(service.baseUrl + '/_test/buffer-progress')).json()
    assert.deepEqual(
      rows.map((row) => [row.section, row.completed]),
      [
        [0, true],
        [2, true],
      ]
    )
    assert.deepEqual(apiFailures, [])
    assert.deepEqual(errors, [])
    assert.equal(await page.locator('audio').getAttribute('src'), null)
  } finally {
    await context.close()
    await browser.close()
  }
})

async function completeControl(index, options = {}) {
  const response = await fetch(service.baseUrl + '/_test/complete-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: fileId(index), ...options }),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body
}

async function completeRequest(index, options = {}, authCookie = cookie) {
  return fetch(service.baseUrl + '/admin/books?scope=all', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: authCookie },
    body: new URLSearchParams({
      action: 'audio-complete',
      bookId: bookId(index),
      fileId: fileId(index),
      operation: 'merge',
      kbps: '0',
      cleanup: 'files',
      ...options,
    }),
  })
}

async function prepareComplete(index) {
  await scenario(index, 'browser-buffer')
  const sourcePath = path.join(fixtureDir, 'complete-tone.mp3')
  const generated = spawnSync(ffmpegBin, [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    sourcePath,
  ])
  assert.equal(generated.status, 0, String(generated.stderr))
  return completeControl(index, { sourcePath })
}

test(
  'Admin queues a real FFmpeg merge; authenticated Range playback and progress survive deleting every chunk record',
  { skip: hasMediaTools ? false : 'ffmpeg and ffprobe are required' },
  async () => {
    await prepareComplete(8)
    const html = await (await fetch(service.baseUrl + '/admin/books?scope=all', { headers: { Cookie: cookie } })).text()
    assert.match(html, /완성본 통합 예약/)
    const queueBrowser = await chromium.launch({ channel: 'chrome', headless: true })
    const queueContext = await queueBrowser.newContext()
    try {
      await queueContext.addCookies(
        cookie.split('; ').map((pair) => {
          const at = pair.indexOf('=')
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: service.baseUrl }
        })
      )
      const page = await queueContext.newPage()
      await page.goto(service.baseUrl + '/admin/books?scope=all&q=' + encodeURIComponent('테스트 책 8'))
      await page.locator('summary').filter({ hasText: '완성본 ·' }).click()
      const form = page.locator('form').filter({ has: page.locator('input[name=action][value=audio-complete]') })
      await form.locator('select[name=cleanup]').selectOption('records')
      await Promise.all([
        page.waitForNavigation(),
        form.getByRole('button', { name: '완성본 통합 예약', exact: true }).click(),
      ])
    } finally {
      await queueContext.close()
      await queueBrowser.close()
    }
    assert.equal((await completeControl(8)).records[0].status, 'queued')
    await completeRequest(8, { cleanup: 'records' })
    assert.equal((await completeControl(8)).records.length, 1, 'duplicate queue is rejected')
    const merged = await completeControl(8, { run: true })
    assert.equal(merged.result.status, 'ready', JSON.stringify(merged))
    assert.equal(merged.records[0].exists, true)
    assert.ok(merged.audioChunks > 0, 'originals stay during the grace period')
    assert.ok(merged.chunkKeys.every((key) => existsSync(path.join(merged.storageDir, key))))
    const collectionId = JSON.parse(readFileSync(path.join(serviceDir, 'pb_schema.json'))).find(
      (c) => c.name === 'book_audio_complete'
    ).id
    const bypass =
      service.baseUrl + '/api/files/' + collectionId + '/' + merged.records[0].id + '/' + merged.records[0].filename
    assert.equal(
      (await fetch(bypass)).status,
      404,
      'the protected PocketBase file URL cannot bypass shelf authorization'
    )
    const query = new URLSearchParams({ bookId: bookId(8), fileId: fileId(8) })
    const loadProgress = async () =>
      await (
        await fetch(service.baseUrl + '/api/books/audio-progress?' + query, { headers: { Cookie: cookie } })
      ).json()
    const metadata = await loadProgress()
    assert.equal(metadata.completeAudio.parts.length, 4)
    const url = service.baseUrl + metadata.completeAudio.url
    const headers = { Cookie: cookie, Range: 'bytes=10-99' }
    const partial = await fetch(url, { headers })
    assert.equal(partial.status, 206)
    assert.match(partial.headers.get('content-range'), /^bytes 10-99\//)
    assert.equal((await partial.arrayBuffer()).byteLength, 90)
    assert.equal(
      (await fetch(url, { headers: { 'Cookie': cookie, 'If-None-Match': partial.headers.get('etag') } })).status,
      304
    )
    assert.equal((await fetch(url.replace(bookId(8), bookId(9)), { headers: { Cookie: cookie } })).status, 404)
    assert.equal((await fetch(url, { method: 'HEAD', headers: { Cookie: cookie } })).status, 200)
    assert.equal((await fetch(url, { headers: { Cookie: cookie, Range: 'bytes=9999999999-' } })).status, 416)
    const suffix = await fetch(url, { headers: { Cookie: cookie, Range: 'bytes=-20' } })
    assert.equal(suffix.status, 206)
    assert.equal((await suffix.arrayBuffer()).byteLength, 20)
    const signedOut = await fetch(url, { redirect: 'manual' })
    assert.equal(signedOut.status, 303)
    assert.match(signedOut.headers.get('location'), /auth/)
    const login = await fetch(service.baseUrl + '/xapi/auth/sign-in', {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ email: 'other@example.com', password: 'test-password-1234' }),
    })
    const otherCookie = readCookieHeader(login.headers)
    assert.equal((await fetch(url, { headers: { Cookie: otherCookie } })).status, 404)
    await completeRequest(8, {}, otherCookie)
    assert.equal((await completeControl(8)).records.length, 1)
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext()
    try {
      await context.addCookies(
        cookie.split('; ').map((pair) => {
          const at = pair.indexOf('=')
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: service.baseUrl }
        })
      )
      const page = await context.newPage(),
        errors = [],
        ranges = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('response', (r) => {
        if (r.url().includes('/complete-audio')) ranges.push(r.status())
      })
      await page.goto(service.baseUrl + '/_test/buffer-player?complete=1')
      await page.click('#start')
      await page.waitForFunction(() => window.state.cloudAudioActive)
      assert.match(await page.locator('audio').getAttribute('src'), /\/complete-audio\?/)
      await page.evaluate(() => {
        window.booklogAudio.seekTo(4.4)
        window.booklogAudio.toggle()
      })
      await page.waitForFunction(() => !window.state.cloudAudioActive)
      await page.evaluate(() => window.booklogAudio.stop())
      await page.waitForFunction(
        () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:browser-e2e') || '{}')).length === 0
      )
      const before = (await loadProgress()).progress
      assert.ok(before.seconds >= 4.3 && before.seconds < 5.3)
      const cleaned = await completeControl(8, { expire: true, run: true })
      assert.equal(cleaned.chunks, 0, JSON.stringify(cleaned))
      assert.equal(cleaned.records[0].cleanupDone, true)
      assert.ok(
        merged.chunkKeys.every((key) => !existsSync(path.join(merged.storageDir, key))),
        'chunk files are physically removed'
      )
      const restored = (await loadProgress()).progress
      assert.equal(restored.chunkIndex, before.chunkIndex)
      assert.ok(Math.abs(restored.seconds - before.seconds) < 0.1)
      const position = await (
        await fetch(
          service.baseUrl
            + '/api/books/audio-position?'
            + query
            + '&sectionIndex=0&anchor='
            + encodeURIComponent('조각으로 나뉘는 첫 번째'),
          { headers: { Cookie: cookie } }
        )
      ).json()
      assert.equal(position.ok, true)
      assert.equal(position.chunkIndex, 0)
      await page.reload()
      await page.click('#start')
      await page.waitForFunction(() => window.state.cloudAudioActive)
      assert.ok(Math.abs((await page.evaluate(() => window.state.cloudAudioPosition)) - before.seconds) < 0.5)
      const src = await page.locator('audio').getAttribute('src')
      await page.waitForFunction(() => window.state.cloudAudioDetail.startsWith('1 / 1'))
      assert.equal(await page.locator('audio').getAttribute('src'), src)
      await page.waitForFunction(() => !window.state.cloudAudioSession)
      await page.waitForFunction(
        () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:browser-e2e') || '{}')).length === 0
      )
      assert.equal((await loadProgress()).progress.isCompleted, true)
      assert.ok(ranges.includes(206))
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
      await browser.close()
    }
  }
)

test(
  'A complete MP3 can be recompressed after chunk deletion; old URLs stay valid until their grace period expires',
  { skip: hasMediaTools ? false : 'ffmpeg and ffprobe are required' },
  async () => {
    if (!(await completeControl(8)).records.some((r) => r.status === 'ready')) {
      await prepareComplete(8)
      await completeRequest(8, { cleanup: 'records' })
      await completeControl(8, { run: true })
      await completeControl(8, { expire: true, run: true })
    }
    const original = (await completeControl(8)).records.find((r) => r.status === 'ready')
    await completeRequest(8, { operation: 'compress', kbps: '64' })
    const compressed = await completeControl(8, { run: true })
    const current = compressed.records.find((r) => r.status === 'ready')
    assert.equal(compressed.result.status, 'ready', JSON.stringify(compressed))
    assert.equal(current.kbps, 64)
    assert.ok(current.size < original.size * 0.7)
    const oldUrl =
      service.baseUrl
      + '/xapi/books/complete-audio?bookId='
      + bookId(8)
      + '&fileId='
      + fileId(8)
      + '&editionId='
      + original.id
    assert.equal((await fetch(oldUrl, { headers: { Cookie: cookie, Range: 'bytes=0-20' } })).status, 206)
    const after = await completeControl(8, { expire: true, run: true })
    assert.equal(after.records.length, 1)
    assert.equal(after.records[0].id, current.id)
    assert.equal((await fetch(oldUrl, { headers: { Cookie: cookie } })).status, 404)
    assert.equal(after.chunks, 0)
  }
)

test(
  'Merge rejects incomplete audio and unreviewed short-audio warnings; source changes and encoder errors preserve originals',
  { skip: hasMediaTools ? false : 'ffmpeg and ffprobe are required' },
  async () => {
    await scenario(9, 'plan')
    await completeRequest(9)
    assert.equal((await completeControl(9)).records.length, 0)
    await prepareComplete(10)
    await completeControl(10, { warning: true })
    await completeRequest(10)
    assert.equal((await completeControl(10)).records.length, 0)
    await completeRequest(10, { reviewed: 'yes' })
    await completeControl(10, { mutate: true })
    const stale = await completeControl(10, { run: true })
    assert.equal(stale.result.status, 'failed')
    assert.ok(stale.audioChunks > 0)
    await prepareComplete(11)
    await completeRequest(11)
    const hidden = fixtureFfmpeg + '.disabled'
    renameSync(fixtureFfmpeg, hidden)
    let failed
    try {
      failed = await completeControl(11, { run: true })
    } finally {
      renameSync(hidden, fixtureFfmpeg)
    }
    assert.equal(failed.result.status, 'failed')
    assert.ok(failed.audioChunks > 0)
    assert.ok(failed.records[0].error)
  }
)

test(
  'File-only cleanup removes MP3 bytes, preserves metadata, and prevents destructive per-chunk regeneration',
  { skip: hasMediaTools ? false : 'ffmpeg and ffprobe are required' },
  async () => {
    await prepareComplete(10)
    await completeRequest(10, { reviewed: 'yes', cleanup: 'files' })
    const merged = await completeControl(10, { run: true })
    assert.equal(merged.result.status, 'ready', JSON.stringify(merged))
    const keys = merged.chunkKeys
    assert.ok(keys.length > 0)
    const cleaned = await completeControl(10, { expire: true, run: true })
    assert.equal(cleaned.audioChunks, 0)
    assert.equal(cleaned.chunks, merged.chunks)
    assert.ok(keys.every((key) => !existsSync(path.join(merged.storageDir, key))))
    const regenerated = await control(10, { regenerate: true, apply: true })
    assert.equal(regenerated.reset, 0)
    assert.equal(
      (await completeControl(10)).records.find((r) => r.status === 'ready').id,
      merged.records.find((r) => r.status === 'ready').id
    )
  }
)

test(
  'Deleting the audiobook also deletes complete editions and leaves no archived progress',
  { skip: hasMediaTools ? false : 'ffmpeg and ffprobe are required' },
  async () => {
    let before = await completeControl(8)
    if (!before.records.length) {
      await prepareComplete(8)
      await completeRequest(8)
      before = await completeControl(8, { run: true })
    }
    assert.ok(before.records.length > 0)
    await request(8, 'delete')
    assert.equal((await completeControl(8)).records.length, 0)
    assert.equal((await completeControl(8)).chunks, 0)
  }
)

test(
  'Cleanup preserves originals if the published complete file has disappeared',
  { skip: hasMediaTools ? false : 'ffmpeg and ffprobe are required' },
  async () => {
    await prepareComplete(11)
    await completeRequest(11, { cleanup: 'records' })
    const merged = await completeControl(11, { run: true })
    assert.equal(merged.result.status, 'ready', JSON.stringify(merged))
    const after = await completeControl(11, { hideComplete: true, expire: true, run: true })
    assert.equal(after.chunks, merged.chunks)
    assert.equal(after.audioChunks, merged.audioChunks)
    assert.equal(after.records.find((r) => r.status === 'ready').cleanupDone, false)
  }
)

test('Before the complete schema is imported, cron and existing reader/admin routes remain usable', async () => {
  await scenario(7, 'browser-buffer')
  const response = await completeControl(7, { dropSchema: true })
  assert.equal(response.result.status, 'schema-missing')
  const headers = { Cookie: cookie }
  const query = new URLSearchParams({ bookId: bookId(7), fileId: fileId(7) })
  const progress = await (await fetch(service.baseUrl + '/api/books/audio-progress?' + query, { headers })).json()
  assert.equal(progress.ok, true)
  assert.equal(progress.completeAudio, null)
  const chunks = await fetch(service.baseUrl + '/api/books/audio-chunk?' + query + '&sectionIndex=0&chunkIndex=0', {
    headers,
  })
  assert.equal(chunks.status, 200)
  const admin = await fetch(service.baseUrl + '/admin/books?scope=all', { headers })
  assert.equal(admin.status, 200)
  assert.match(await admin.text(), /완성본 스키마 import 필요/)
})
