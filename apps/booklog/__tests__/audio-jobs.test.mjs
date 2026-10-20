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
import { readCookieHeader } from '@pocketpages/test-support/auth-cookie'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const lite = 'gemini-3.8-flash-lite-tts'
const flash = 'gemini-3.8-flash-tts'
const bookId = (index) => 'book' + String(index).padStart(11, '0')
const fileId = (index) => 'file' + String(index).padStart(11, '0')
let fixtureDir
let service
let cookie

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

async function request(index, action = 'start', model) {
  const input = { bookId: bookId(index), fileId: fileId(index), action }
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
  assert.equal($('input[name=model]:checked').val(), lite)
  assert.equal($('input[name=model]:disabled').length, 0)
  await request(1)
  $ = await detail(2)
  assert.ok($(`input[value="${lite}"]`).is(':disabled'))
  assert.equal($('input[name=model]:checked').val(), flash)
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
  assert.equal($('input[name=model]:disabled').length, 2)
  assert.ok(
    $('button')
      .filter((_, element) => $(element).text().includes('AI 오디오북 생성 요청'))
      .is(':disabled')
  )
  await request(4, 'start', flash)
  assert.equal((await jobs()).length, 2)

  const originalHash = registered.find((job) => job.model === lite).config_hash
  await request(1, 'pause')
  assert.ok((await detail(4))(`input[value="${lite}"]`).is(':disabled'))
  await request(1, 'start', flash)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(1)).status, 'paused')
  await request(1, 'start', lite)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(1)).config_hash, originalHash)
  await control(1, { status: 'failed' })
  assert.ok((await detail(4))(`input[value="${lite}"]`).is(':disabled'))
  await request(1, 'start', lite)

  await control(flashBook, { playback: true })
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
  response = await fetch(service.baseUrl + chunk.audioUrl, { headers })
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
  assert.equal($('input[name=model]:checked').val(), flash)
  await request(flashBook, 'start', flash)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(flashBook)).config_hash, flashJob.config_hash)
  await request(1, 'delete')
  $ = await detail(4)
  assert.equal($('input[name=model]:checked').val(), lite)
  await request(4)
  assert.equal((await jobs()).find((job) => job.file_id === fileId(4)).model, lite)
})
