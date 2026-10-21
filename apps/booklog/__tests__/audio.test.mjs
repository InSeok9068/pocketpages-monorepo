import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const serviceRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const aiSource = readFileSync(new URL('../../../packages/ai/index.js', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../pb_hooks/pages/api/books/audio-chunk.ejs', import.meta.url), 'utf8')
  .replace('<script server>', '')
  .replace('</script>', '')

function createAi(response) {
  const requests = []
  const context = {
    module: { exports: {} },
    process: { env: { GEMINI_APIKEY: 'test-key' } },
    $http: {
      send(options) {
        requests.push(options)
        return response
      },
    },
    sleep() {
      throw new Error('Unexpected retry')
    },
  }
  vm.runInNewContext(aiSource, context)
  return { client: context.module.exports.createAiClient(), requests }
}

test('Gemini speech uses the configured key, separate styling, and WAV response', () => {
  const { client, requests } = createAi({
    statusCode: 200,
    json: {
      steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'UklGRg==', mime_type: 'audio/wav' }] }],
    },
  })
  const result = client.geminiSpeech({ model: 'gemini-3.8-flash-tts', input: '원문 그대로.', style: '차분하게' })
  assert.equal(result.ok, true)
  assert.equal(result.audio.mimeType, 'audio/wav')
  assert.equal(requests[0].headers['x-goog-api-key'], 'test-key')
  assert.match(requests[0].url, /\/v1beta\/interactions$/)
  const payload = JSON.parse(requests[0].body)
  assert.equal(payload.input[0].content[0].text, '원문 그대로.')
  assert.equal(payload.input[0].content[0].annotations[0].style, '차분하게')
  assert.equal(payload.response_format.mime_type, 'audio/wav')
  client.geminiSpeech({ model: 'gemini-3.8-flash-lite-tts', input: '원문', mimeType: 'audio/mp3' })
  assert.deepEqual(JSON.parse(requests[1].body).response_format, { type: 'audio', mime_type: 'audio/mp3' })
})

test('Gemini quota errors are returned without a second call or fallback model', () => {
  const { client, requests } = createAi({ statusCode: 429, json: { error: { message: 'Quota exceeded' } } })
  const result = client.geminiSpeech({ model: 'gemini-3.8-flash-tts', input: '테스트' })
  assert.equal(result.ok, false)
  assert.equal(result.statusCode, 429)
  assert.equal(result.audio, null)
  assert.equal(requests.length, 1)
})

test('A successful HTTP response without audio is not a successful speech result', () => {
  const { client } = createAi({ statusCode: 200, json: { steps: [] } })
  assert.equal(client.geminiSpeech({ model: 'gemini-3.8-flash-tts', input: '테스트' }).ok, false)
})

test('Whole-book extraction keeps spine order and preserves each chapter text exactly once', () => {
  const { zipSync, strToU8 } = require('fflate')
  const context = { module: { exports: {} }, require, __hooks: serviceRoot + 'pb_hooks' }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/epub-reading-metrics.js', import.meta.url), 'utf8'),
    context
  )
  const paragraph = '오디오북 문장을 자연스럽게 읽습니다. '.repeat(400).trim()
  const bytes = zipSync({
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'
    ),
    'OPS/one.xhtml': strToU8('<html><body><p>다른 챕터</p></body></html>'),
    'OPS/two.xhtml': strToU8(
      '<html><body><blockquote><p>' + paragraph + '</p></blockquote><script>실행 금지</script></body></html>'
    ),
  })
  const book = JSON.parse(JSON.stringify(context.module.exports.buildAudioBookFromBytes(bytes)))
  assert.deepEqual(
    book.map((section) => section.sectionIndex),
    [0, 1]
  )
  assert.deepEqual(book[0].chunks, ['다른 챕터'])
  const chunks = book[1].chunks
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((text) => text.length <= 3000))
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), paragraph)
})

function runRoute({ authenticated = true, method = 'GET', owned = true, ready = true, split = false, query = {} } = {}) {
  let result
  const queries = []
  const lookups = []
  const context = {
    request: {
      method,
      auth: authenticated ? { get: () => 'owner' } : null,
      url: { query: { bookId: 'book', fileId: 'file', sectionIndex: '2', chunkIndex: '1', ...query } },
    },
    response: {
      header() {},
      json(status, body) {
        result = { status, body }
      },
    },
    dbg() {},
    error() {},
    $app: {},
    env: () => '',
    resolve: () => ({
      findAuthorizedFile(app, userId, bookId, fileId) {
        queries.push({ userId, bookId, fileId })
        if (!owned) throw new Error('Not found')
      },
      getFileSettings: () => ({ configHash: 'settings' }),
      findChunk(app, fileId, configHash, sectionIndex, chunkIndex) {
        lookups.push({ fileId, configHash, sectionIndex, chunkIndex })
        return ready ? { id: 'chunk' } : null
      },
      countSectionChunks: () => 3,
      readSectionOrder: () => [1, 2, 4],
      findChunkParts: (app, chunk) => (split ? [] : [chunk]),
      sectionTimeline: () => [60, 60, 60],
      chunkView: (chunk, parts, bookId, chunkCount, order, timeline) => ({
        chunkId: chunk.id,
        parts: parts.length,
        chunkCount,
        order,
        timeline,
      }),
    }),
  }
  vm.runInNewContext('(function () {' + routeSource + '\n})()', context)
  return { result, queries, lookups }
}

function loadGenerationService() {
  const context = { module: { exports: {} } }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/book-audio-generation-service.js', import.meta.url), 'utf8'),
    context
  )
  return context.module.exports
}

function mp3Bytes({ frames, header, frameLength, id3 = true, trailer = true }) {
  const parts = []
  if (id3) parts.push(Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20))
  for (let index = 0; index < frames; index += 1) {
    const frame = Buffer.alloc(frameLength)
    Buffer.from(header).copy(frame)
    parts.push(frame)
  }
  if (trailer) parts.push(Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)]))
  return Buffer.concat(parts)
}

test('Generated MP3 duration is calculated from frames for MPEG-1 and MPEG-2 streams', () => {
  const service = loadGenerationService()
  const mpeg1 = mp3Bytes({ frames: 100, header: [0xff, 0xfb, 0x90, 0x00], frameLength: 417 })
  const decoded = service.decodeMp3(mpeg1.toString('base64'), 'audio/mp3; rate=24000; channels=1')
  assert.ok(Buffer.from(decoded.bytes).equals(mpeg1))
  assert.ok(Math.abs(decoded.durationSeconds - (100 * 1152) / 44100) < 1e-9)
  const mpeg2 = mp3Bytes({ frames: 50, header: [0xff, 0xf3, 0xc4, 0x00], frameLength: 384, id3: false, trailer: false })
  const second = service.decodeMp3(mpeg2.toString('base64'), 'audio/mpeg')
  assert.ok(Math.abs(second.durationSeconds - (50 * 576) / 24000) < 1e-9)
})

function generateWithProviderResult(providerResult, overrides = {}) {
  const fields = {
    status: 'generating',
    generation_started_at: 'claim',
    attempt_count: 0,
    model: 'm',
    input_text: '본문',
    split_path: '',
    section_index: 3,
    chunk_index: 2,
    ...overrides,
  }
  const record = { get: (name) => fields[name], set: (name, value) => (fields[name] = value) }
  const created = []
  const app = {
    findRecordById: () => record,
    runInTransaction: (fn) =>
      fn({
        findRecordById: () => record,
        findCollectionByNameOrId: () => 'book_audio_chunks',
        save(saved) {
          if (saved !== record) created.push(saved.fields)
        },
      }),
  }
  const context = {
    module: { exports: {} },
    require: () => ({ createAiClient: () => ({ geminiSpeech: () => providerResult }) }),
    $security: { sha256: (text) => 'hash:' + text.length },
    $filesystem: { fileFromBytes: () => 'audio-file' },
    Record: function () {
      this.fields = {}
      this.get = (name) => this.fields[name]
      this.set = (name, value) => (this.fields[name] = value)
    },
  }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/book-audio-generation-service.js', import.meta.url), 'utf8'),
    context
  )
  const result = context.module.exports.generateClaimedChunk(app, 'key', 'chunk', 'claim')
  return { result, fields, created, maxAttempts: context.module.exports.MAX_ATTEMPTS }
}

const policyBlock = {
  ok: false,
  statusCode: 400,
  errorMessage: 'Request blocked for an unspecified policy reason. Please modify your input and retry.',
}

function longNarration(sentences) {
  return Array.from({ length: sentences }, (_, index) => '문장 ' + index + '번은 차분하게 이어지는 본문입니다.').join(' ')
}

test('A chunk is halved at the sentence boundary nearest the middle and short text is not split', () => {
  const service = loadGenerationService()
  const text = longNarration(60)
  const [first, second] = service.splitInHalf(text)
  assert.equal(first + ' ' + second, text)
  assert.match(first, /입니다\.$/)
  assert.ok(Math.abs(first.length - second.length) < 40)
  const paragraphs = longNarration(20) + '\n\n' + longNarration(25)
  assert.equal(service.splitInHalf(paragraphs)[0], longNarration(20))
  const minimum = longNarration(13)
  assert.ok(minimum.length >= 300 && minimum.length < 330)
  assert.equal(service.splitInHalf(minimum).join(' '), minimum)
  assert.equal(service.splitInHalf(longNarration(12)), null)
  assert.equal(service.splitInHalf('가'.repeat(400)), null, 'text without boundaries is not cut mid-word')
})

test('A chunk blocked once is replaced by two ordered parts and short chunks keep retrying', () => {
  const text = longNarration(60)
  const split = generateWithProviderResult(policyBlock, { input_text: text })
  assert.equal(split.result.blocked, true)
  assert.equal(split.result.split, true)
  assert.equal(split.fields.status, 'split')
  assert.equal(split.fields.attempt_count, 1)
  assert.deepEqual(
    split.created.map((part) => [part.split_path, part.status, part.section_index, part.chunk_index]),
    [
      ['0', 'queued', 3, 2],
      ['1', 'queued', 3, 2],
    ]
  )
  assert.equal(split.created[0].input_text + ' ' + split.created[1].input_text, text)
  const nested = generateWithProviderResult(policyBlock, { attempt_count: 1, input_text: text, split_path: '1' })
  assert.deepEqual(
    nested.created.map((part) => part.split_path),
    ['10', '11']
  )
  const retried = generateWithProviderResult(policyBlock, { attempt_count: 3, input_text: text })
  assert.equal(retried.fields.status, 'split', 'a chunk reset by restart is split on its next block')
  const short = generateWithProviderResult(policyBlock, { input_text: longNarration(12) })
  assert.equal(short.fields.status, 'failed')
  assert.equal(short.created.length, 0)
  assert.equal(short.fields.attempt_count, 1, 'a short blocked part is retried once later')
  const shortAgain = generateWithProviderResult(policyBlock, { attempt_count: 1, input_text: longNarration(12) })
  assert.equal(shortAgain.fields.status, 'failed')
  assert.equal(shortAgain.fields.attempt_count, 5, 'a second block ends retries to save the daily quota')
  assert.match(shortAgain.fields.error_message, /^Gemini 정책 필터에 반복 차단되어 이 부분은 기기 음성으로 읽습니다/)
  const other = generateWithProviderResult(
    { ok: false, statusCode: 500, errorMessage: 'Internal' },
    { attempt_count: 1, input_text: text }
  )
  assert.equal(other.fields.status, 'failed', 'only policy blocks are split')
})

test('Restarting a job retries ordinary failures but not parts that policy blocks repeatedly', () => {
  const record = (fields) => ({
    fields: { ...fields },
    get(name) {
      return this.fields[name] ?? ''
    },
    set(name, value) {
      this.fields[name] = value
    },
  })
  const blockedPath = '/pages/_private/book-audio-generation-service.js'
  const context = {
    module: { exports: {} },
    __hooks: '',
    $security: { sha256: (text) => text },
    $dbx: { hashExp: () => ({}), not: () => ({}), exp: () => ({}) },
    Date,
  }
  const load = (file) => {
    const sandbox = { ...context, module: { exports: {} } }
    vm.runInNewContext(readFileSync(new URL('../pb_hooks' + file, import.meta.url), 'utf8'), sandbox)
    return sandbox.module.exports
  }
  context.require = (name) => (name === blockedPath ? load(blockedPath) : name.startsWith('@') ? { dateutil: {} } : {})
  const service = load('/pages/_private/book-audio-job-service.js')
  const blocked = record({
    section_index: 0,
    chunk_index: 0,
    split_path: '',
    text_hash: '첫 구간',
    status: 'failed',
    attempt_count: 5,
    error_message: 'Gemini 정책 필터에 반복 차단되어 이 부분은 기기 음성으로 읽습니다. reason',
  })
  const ordinary = record({
    section_index: 0,
    chunk_index: 1,
    split_path: '',
    text_hash: '둘째 구간',
    status: 'failed',
    attempt_count: 5,
    error_message: 'Gemini 음성 생성에 실패했습니다.',
  })
  const job = record({ file_id: 'file', config_hash: 'hash', status: 'running', total_chunks: 0 })
  const tx = {
    findRecordById: () => job,
    findRecordsByFilter: () => [blocked, ordinary],
    findCollectionByNameOrId: () => ({}),
    countRecords: () => 0,
    save() {},
    delete() {},
  }
  service.planJob({ runInTransaction: (fn) => fn(tx) }, 'job', [{ sectionIndex: 0, chunks: ['첫 구간', '둘째 구간'] }])
  assert.equal(ordinary.fields.attempt_count, 0, 'ordinary failures are retried after a restart')
  assert.equal(blocked.fields.attempt_count, 5, 'repeatedly blocked parts keep reading with the device voice')
})

test('Audio much shorter than its text is regenerated twice and then saved with a review note', () => {
  // MPEG-1 44.1kHz 프레임 하나는 1152/44100초입니다.
  const audioFor = (seconds) => ({
    ok: true,
    audio: {
      data: mp3Bytes({
        frames: Math.round((seconds * 44100) / 1152),
        header: [0xff, 0xfb, 0x90, 0x00],
        frameLength: 417,
        id3: false,
        trailer: false,
      }).toString('base64'),
      mimeType: 'audio/mp3',
    },
  })
  const text = '가'.repeat(1300)
  const skipped = generateWithProviderResult(audioFor(150), { input_text: text })
  assert.equal(skipped.result.ok, false)
  assert.equal(skipped.fields.status, 'failed')
  assert.equal(skipped.fields.attempt_count, 1)
  assert.match(skipped.fields.error_message, /짧게 생성되어\(초당 8\.\d자\) 다시 만듭니다/)
  const kept = generateWithProviderResult(audioFor(150), { input_text: text, attempt_count: 2 })
  assert.equal(kept.result.ok, true)
  assert.equal(kept.fields.status, 'ready')
  assert.match(kept.fields.error_message, /짧게 생성됐습니다.*재생성해 주세요/)
  const normal = generateWithProviderResult(audioFor(240), { input_text: text })
  assert.deepEqual([normal.fields.status, normal.fields.error_message], ['ready', ''])
  const skippedPart = generateWithProviderResult(audioFor(34), { input_text: '가'.repeat(398) })
  assert.equal(skippedPart.fields.status, 'failed', 'a split part missing a third of its text is regenerated')
  const shortText = generateWithProviderResult(audioFor(20), { input_text: '가'.repeat(200) })
  assert.equal(shortText.fields.status, 'ready', 'very short text is not checked')
})

test('Reclaiming a chunk interrupted by a restart counts an attempt and stops after the limit', () => {
  const service = loadGenerationService()
  const chunkWith = (fields) => ({ fields, get: (name) => fields[name], set: (name, value) => (fields[name] = value) })
  const txApp = { save() {} }
  const fresh = chunkWith({ status: 'queued', attempt_count: 0 })
  assert.ok(service.claimChunk(txApp, fresh))
  assert.equal(fresh.fields.attempt_count, 0, 'a normal claim is not an attempt')
  const interrupted = chunkWith({ status: 'generating', attempt_count: 1 })
  assert.ok(service.claimChunk(txApp, interrupted))
  assert.deepEqual([interrupted.fields.status, interrupted.fields.attempt_count], ['generating', 2])
  const crashing = chunkWith({ status: 'generating', attempt_count: 4 })
  assert.equal(service.claimChunk(txApp, crashing), '')
  assert.deepEqual([crashing.fields.status, crashing.fields.attempt_count], ['failed', 5])
})

test('Gemini policy blocks are retried later for that chunk only and keep the provider reason', () => {
  const blocked = generateWithProviderResult({
    ok: false,
    statusCode: 400,
    errorMessage: 'Request blocked for an unspecified policy reason. Please modify your input and retry.',
    responseJson: {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Request blocked for an unspecified policy reason.',
        details: [{ reason: 'POLICY_BLOCK' }],
      },
    },
  })
  assert.equal(blocked.result.blocked, true)
  assert.deepEqual(JSON.parse(blocked.result.detail), {
    code: 400,
    status: 'INVALID_ARGUMENT',
    message: 'Request blocked for an unspecified policy reason.',
    details: [{ reason: 'POLICY_BLOCK' }],
  })
  assert.equal(blocked.maxAttempts, 5)
  assert.equal(blocked.fields.status, 'failed')
  assert.equal(blocked.fields.attempt_count, 1)
  assert.match(blocked.fields.error_message, /정책 필터.*Request blocked/)
  assert.ok(Date.parse(blocked.fields.next_retry_at) > Date.now())
  const invalid = generateWithProviderResult({ ok: false, statusCode: 400, errorMessage: 'Invalid voice name' })
  assert.equal(invalid.result.blocked, false)
  const quota = generateWithProviderResult({ ok: false, statusCode: 429, errorMessage: 'Rate limit exceeded' })
  assert.equal(quota.result.statusCode, 429)
  assert.equal(quota.fields.attempt_count, 0)
})

test('Generated audio is rejected unless it is a valid MP3', () => {
  const service = loadGenerationService()
  const mpeg1 = mp3Bytes({ frames: 2, header: [0xff, 0xfb, 0x90, 0x00], frameLength: 417 }).toString('base64')
  assert.throws(() => service.decodeMp3(mpeg1, 'audio/wav'), /MP3 음성을 받지 못했습니다/)
  assert.throws(() => service.decodeMp3(Buffer.alloc(400).toString('base64'), 'audio/mp3'), /MP3/)
  assert.throws(() => service.decodeMp3('not base64!', 'audio/mp3'))
})

test('Audio chunk lookup requires authentication and GET', () => {
  assert.equal(runRoute({ authenticated: false }).result.status, 401)
  assert.equal(runRoute({ method: 'POST' }).result.status, 405)
})

test('Audio chunk lookup rejects unowned files before reading audio records', () => {
  const { result, queries, lookups } = runRoute({ owned: false })
  assert.equal(result.status, 404)
  assert.equal(queries[0].userId, 'owner')
  assert.equal(lookups.length, 0)
})

test('Audio chunk lookup rejects missing or invalid chapter positions', () => {
  assert.equal(runRoute({ query: { sectionIndex: '-1' } }).result.status, 400)
  assert.equal(runRoute({ query: { chunkIndex: '0.5' } }).result.status, 400)
  assert.equal(runRoute({ query: { chunkIndex: '' } }).result.status, 400)
})

test('Audio chunk lookup only returns generated audio and never generates it', () => {
  const found = runRoute()
  assert.equal(found.result.status, 200)
  assert.deepEqual(found.lookups[0], { fileId: 'file', configHash: 'settings', sectionIndex: 2, chunkIndex: 1 })
  assert.equal(found.result.body.chunkCount, 3)
  assert.equal(JSON.stringify(found.result.body.order), '[1,2,4]')
  const missing = runRoute({ ready: false })
  assert.equal(missing.result.status, 404)
  assert.equal(missing.result.body.reason, 'not-ready')
  assert.match(missing.result.body.message, /찾지 못했습니다/)
  assert.equal(runRoute({ split: true }).result.status, 404, 'a split chunk without parts is not playable')
})

test('A page without narration points to the next chapter that has narration', () => {
  const image = runRoute({ query: { sectionIndex: '3', chunkIndex: '0' } })
  assert.equal(image.result.status, 404)
  assert.equal(image.result.body.reason, 'no-text')
  assert.equal(image.result.body.nextSectionIndex, 4)
  assert.equal(image.lookups.length, 0, 'no chunk lookup for a page without narration')
  const end = runRoute({ query: { sectionIndex: '9', chunkIndex: '0' } })
  assert.equal(end.result.body.nextSectionIndex, -1)
  assert.match(end.result.body.message, /뒤로는 낭독할 본문이 없습니다/)
})

test('Chunk views number the chapter among chapters with narration and link its neighbours', () => {
  const context = {
    module: { exports: {} },
    require: () => ({}),
    __hooks: '',
    $security: { sha256: () => 'hash' },
  }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/book-audio-data.js', import.meta.url), 'utf8'),
    context
  )
  const fields = { id: 'c', config_hash: 'h', section_index: 7, file_id: 'f', status: 'ready', input_text: '본문', duration_seconds: 3 }
  const chunk = { get: (name) => fields[name] }
  const view = context.module.exports.chunkView(chunk, [chunk], 'book', 1, [1, 5, 7, 9], [3])
  assert.deepEqual(
    [view.chapterNumber, view.chapterTotal, view.previousSectionIndex, view.nextSectionIndex],
    [3, 4, 5, 9]
  )
  const last = context.module.exports.chunkView(chunk, [chunk], 'book', 1, [7], [3])
  assert.deepEqual([last.chapterNumber, last.previousSectionIndex, last.nextSectionIndex], [1, -1, -1])
})

function createPlayerHarness(fetchAudio, options = {}) {
  const values = options.storage || new Map()
  const cachedAudio = new Map()
  const requests = []
  const server = options.server || { progress: null, downloads: 0, chunkCount: 1, failSaves: false }
  const audio = {
    currentTime: 0,
    duration: 60,
    source: '',
    get src() {
      return this.source
    },
    set src(value) {
      this.source = value
      this.currentTime = 0
    },
    playbackRate: 1,
    paused: true,
    play() {
      this.paused = false
      this.onloadedmetadata?.()
      this.onplay?.()
      return Promise.resolve()
    },
    pause() {
      this.paused = true
      this.onpause?.()
    },
    removeAttribute() {
      this.src = ''
    },
    getAttribute: (name) => (name === 'data-book-title' ? '테스트 책' : null),
    load() {
      this.currentTime = 0
    },
  }
  const state = { readAloudRate: '1', cloudAudioBusy: false, cloudAudioActive: false, cloudAudioMessage: '' }
  const positionChunk = options.positionChunk ?? -1
  const positionSeconds = options.positionSeconds ?? 0
  const context = {
    window: {
      booklogReaderConfig: {
        readerCacheKey: 'user:hash',
        bookId: 'book',
        bookFileId: 'file',
      },
      speechSynthesis: options.speech,
      SpeechSynthesisUtterance: function (text) {
        this.text = text
      },
      MediaMetadata: options.mediaSession
        ? function (metadata) {
            Object.assign(this, metadata)
          }
        : undefined,
      location: { origin: 'http://localhost' },
      addEventListener() {},
      caches: {
        open: async () => ({
          match: async (key) => (options.matchCache ? options.matchCache(key) : cachedAudio.get(key)?.clone()),
          put: async (key, response) => cachedAudio.set(key, response),
          keys: async () => [...cachedAudio.keys()],
          delete: async (key) => cachedAudio.delete(key),
        }),
      },
    },
    document: { getElementById: () => audio },
    navigator: options.mediaSession ? { mediaSession: options.mediaSession } : {},
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    fetch: async (url, options = {}) => {
      if (url.startsWith('/api/books/audio-progress')) {
        if (options.method === 'POST') {
          if (server.failSaves) return new Response(JSON.stringify({ ok: false, message: 'offline' }), { status: 503 })
          if (server.rejectSaves) {
            server.rejected = (server.rejected || 0) + 1
            return new Response(JSON.stringify({ ok: false, message: 'invalid' }), { status: 400 })
          }
          const form = options.body
          const parts = String(form.get('chunkId')).split('-')
          server.progress = {
            sectionIndex: Number(parts[1]),
            chunkIndex: Number(parts[2]),
            seconds: Number(form.get('seconds')),
            isCompleted: form.get('isCompleted') === 'true',
          }
          server.saves = (server.saves || []).concat([
            parts[1] + ':' + parts[2] + ':' + form.get('isCompleted') + ':' + form.get('restart'),
          ])
          return new Response(JSON.stringify({ ok: true }))
        }
        const progress = server.progress ? { ...server.progress } : null
        if (
          progress
          && !progress.isCompleted
          && progress.seconds >= 60
          && progress.chunkIndex + 1 < server.chunkCount
        ) {
          progress.chunkIndex += 1
          progress.seconds = 0
        }
        return new Response(JSON.stringify({ ok: true, configHash: 'settings', progress }))
      }
      if (url.startsWith('/api/books/audio-position')) {
        const position = new URL(url, 'http://localhost').searchParams
        server.positionQueries = (server.positionQueries || []).concat([
          position.get('sectionIndex') + ':' + position.get('anchor'),
        ])
        return new Response(JSON.stringify({ ok: true, chunkIndex: positionChunk, seconds: positionSeconds }))
      }
      if (url.startsWith('/xapi/books/audio-file')) {
        server.downloads += 1
        return new Response(new Blob(['RIFF'], { type: 'audio/wav' }))
      }
      const lookup = new URL(url, 'http://localhost').searchParams
      const index = Number(lookup.get('chunkIndex'))
      const section = Number(lookup.get('sectionIndex'))
      requests.push(index)
      const response = await fetchAudio(index, options.signal, section)
      if (!response.ok) return response
      const result = await response.json()
      server.chunkCount = result.chunkCount
      const audioUrl = '/xapi/books/audio-file?chunkId=chunk-' + section + '-' + index
      return new Response(
        JSON.stringify({
          ...result,
          chunkId: 'chunk-' + section + '-' + index,
          configHash: 'settings',
          timeline: result.timeline || Array.from({ length: result.chunkCount }, () => 60),
          parts:
            result.parts
            || (result.fallbackText
              ? [{ audioUrl: '', fallbackText: result.fallbackText, durationSeconds: 0 }]
              : [{ audioUrl, fallbackText: '', durationSeconds: 60 }]),
        })
      )
    },
    URL,
    Response,
    Blob,
    FormData,
    AbortController,
    DOMException,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    atob,
  }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/assets/booklog-audio.js', import.meta.url), 'utf8'),
    context
  )
  return { logic: context.window.booklogAudio, state, audio, values, requests, server }
}

const audioResponse = (count = 1) =>
  new Response(
    JSON.stringify({
      ok: true,
      chunkCount: count,
      audio: { data: 'UklGRg==', mimeType: 'audio/wav' },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )

async function flushPlayback() {
  for (let index = 0; index < 15; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('Replay uses browser audio cache and restores server progress without downloading audio again', async () => {
  const { logic, state, audio, requests, server } = createPlayerHarness(() => audioResponse())
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(state.cloudAudioActive, true)
  audio.currentTime = 12
  logic.stop()
  logic.start(state, 0)
  await flushPlayback()
  audio.onloadedmetadata()
  assert.equal(audio.currentTime, 12)
  assert.deepEqual(requests, [0, 0])
  assert.equal(server.downloads, 1)
  logic.stop()
})

test('Playback stops at a chunk that is not generated yet and resumes there later', async () => {
  let notGenerated = true
  const { logic, state, audio, requests } = createPlayerHarness((index) => {
    if (index === 1 && notGenerated)
      return new Response(JSON.stringify({ ok: false, message: '아직 생성되지 않았습니다.' }), { status: 404 })
    return audioResponse(2)
  })
  logic.start(state, 0)
  await flushPlayback()
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  assert.equal(state.cloudAudioActive, false)
  assert.equal(state.cloudAudioMessage, '아직 생성되지 않았습니다.')
  notGenerated = false
  logic.start(state, 0)
  await flushPlayback()
  assert.deepEqual(requests, [0, 1, 1, 1])
  assert.match(state.cloudAudioDetail, /2 \/ 2/)
  logic.stop()
})

test('Stopping during a chunk lookup never starts late audio playback', async () => {
  let complete
  const { logic, state, audio } = createPlayerHarness(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  logic.start(state, 0)
  await flushPlayback()
  logic.stop()
  complete(audioResponse())
  await flushPlayback()
  assert.equal(state.cloudAudioActive, false)
  assert.equal(state.cloudAudioBusy, false)
  assert.equal(audio.src, '')
})

function audioChunksForHtml(html) {
  const { zipSync, strToU8 } = require('fflate')
  const context = { module: { exports: {} }, require, __hooks: serviceRoot + 'pb_hooks' }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/epub-reading-metrics.js', import.meta.url), 'utf8'),
    context
  )
  const epub = zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    'book.opf': strToU8(
      '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'
    ),
    'chapter.xhtml': strToU8('<html><body>' + html + '</body></html>'),
  })
  return context.module.exports.buildAudioBookFromBytes(epub)[0].chunks
}

function audioSectionsForFiles(files) {
  const { zipSync, strToU8 } = require('fflate')
  const context = { module: { exports: {} }, require, __hooks: serviceRoot + 'pb_hooks' }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/epub-reading-metrics.js', import.meta.url), 'utf8'),
    context
  )
  const names = Object.keys(files)
  const entries = {
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    'book.opf': strToU8(
      '<package><manifest>'
        + names.map((name, index) => '<item id="i' + index + '" href="' + name + '" media-type="application/xhtml+xml"/>').join('')
        + '</manifest><spine>'
        + names.map((_name, index) => '<itemref idref="i' + index + '"/>').join('')
        + '</spine></package>'
    ),
  }
  names.forEach((name) => {
    entries[name] = strToU8(files[name])
  })
  return JSON.parse(JSON.stringify(context.module.exports.buildAudioBookFromBytes(zipSync(entries))))
}

test('Copyright pages are skipped by file name, EPUB semantics, or ISBN with publishing terms', () => {
  const sections = audioSectionsForFiles({
    'chapter.xhtml': '<html><body><p>본문입니다. ISBN이라는 단어가 나와도 본문은 남습니다.</p></body></html>',
    'copyright.xhtml': '<html><body><p>판권 페이지</p></body></html>',
    'semantic.xhtml':
      '<html xmlns:epub="http://www.idpf.org/2007/ops"><body epub:type="backmatter copyright-page"><p>저작권</p></body></html>',
    'last.xhtml':
      '<html><body><p>책 제목</p><p>1판 1쇄 발행 2016년</p><p>발행인 홍길동</p><p>ISBN 979-11-87119-84-5</p></body></html>',
  })
  assert.deepEqual(
    sections.map((section) => section.sectionIndex),
    [0]
  )
  assert.match(sections[0].chunks[0], /ISBN이라는 단어/)
})

test('Cover links, tables of contents, notes, references, and English rights pages are not narrated', () => {
  const skipped = {
    'cover.xhtml': '<html><body><p><a href="#">처음으로</a></p></body></html>',
    'start.xhtml': '<html><body><p>책의 시작</p></body></html>',
    'toc.xhtml': '<html><body><p>차<br/>례</p><p></p><p>1장 시작</p><p>2장 끝</p></body></html>',
    'en_copy.xhtml': '<html><body><p>ORIGINAL TITLE</p><p>ⓒAuthor 2016</p></body></html>',
    'kcr.xhtml': '<html><body><p>THE TITLE</p><p>Copyright ⓒ 2025 by Author All rights reserved.</p></body></html>',
    'rights.xhtml': '<html><body><p>판권</p><p>제목 1판 1쇄 발행 2019년</p></body></html>',
    'notes.xhtml': '<html><body><p>주</p><p>머리말 1 이 용어는 대화에서 나왔다.</p></body></html>',
    'ref.xhtml': '<html><body><p>참고 문헌</p><p>저자, 책 제목, 2020</p></body></html>',
    'pictures.xhtml': '<html><body><p>PICTURE ACKNOWLEDGEMENTS</p><p>[1] Agency</p></body></html>',
    'decorated.xhtml': '<html><body><p>/ 참고문헌 /</p><p>• Allais, M. 1979.</p></body></html>',
    'bookinfo.xhtml':
      '<html><body><p>이 전자책은 대한민국 저작권법의 보호를 받는 저작물입니다. 허락 없이 가공할 수 없습니다.</p></body></html>',
    'start2.xhtml':
      '<html><body><p>ORIGINAL TITLE</p><p>Copyright © 2022 by Author</p><p>Korean edition published by arrangement with Agency.</p></body></html>',
    'endnotes.xhtml':
      '<html><body><p><img src="note-title.png"/></p><p>프롤로그</p>'
      + [1, 2, 3, 4, 5, 6]
        .map((n) => '<p><a href="chapter.xhtml#ref' + n + '" id="note' + n + '">' + n + '.</a> 참고한 책 ' + n + '</p>')
        .join('')
      + '</body></html>',
  }
  const kept = {
    'author.xhtml': '<html><body><p>지은이 소개</p><p>작가는 1988년에 태어났다.</p></body></html>',
    'chapter.xhtml':
      '<html><body><p>차례대로 줄을 섰다. 주석을 달 필요는 없었다.</p>'
      + [1, 2, 3, 4, 5, 6]
        .map((n) => '<p>문장 ' + n + '에는 주석 번호<a href="endnotes.xhtml#note' + n + '">' + n + '</a>가 붙어 있다.</p>')
        .join('')
      + '</body></html>',
    'thanks.xhtml': '<html><body><p>감사의 글</p><p>도와준 모든 분께 감사드립니다.</p></body></html>',
  }
  const sections = audioSectionsForFiles({ ...skipped, ...kept })
  const names = Object.keys({ ...skipped, ...kept })
  assert.deepEqual(
    sections.map((section) => names[section.sectionIndex]),
    Object.keys(kept)
  )
})

test('Long text without spaces is cut at the chunk limit instead of failing the whole book', () => {
  const text = 'あ'.repeat(7000)
  const [section] = audioSectionsForFiles({ 'jp.xhtml': '<html><body><p>' + text + '</p></body></html>' })
  assert.deepEqual(
    section.chunks.map((chunk) => chunk.length),
    [3000, 3000, 1000]
  )
})

test('A page that ends with endnotes keeps the narrative before the first note without the notes heading', () => {
  const summary = '요약 문단입니다. 이 논문은 불확실한 상황에서 판단을 내릴 때 개입하는 세 가지 어림짐작을 다룹니다. '.repeat(3)
  const [section] = audioSectionsForFiles({
    'appendix.xhtml':
      '<html><body><p>' + summary + '</p><p>/ 주 /</p>'
      + [1, 2, 3, 4, 5, 6]
        .map((n) => '<p><a href="paper.xhtml#ref' + n + '">' + n + '.</a> 참고 논문 ' + n + '</p>')
        .join('')
      + '</body></html>',
  })
  assert.equal(section.chunks.join(''), summary.trim())
})

test('Narration joins letter-spaced Latin titles and drops decorative bullets only', () => {
  const [section] = audioSectionsForFiles({
    'chapter.xhtml':
      '<html><body><p>Pㆍrㆍoㆍlㆍoㆍgㆍuㆍe</p><p>Tㆍhㆍaㆍnㆍkㆍs tㆍo</p><p>□ 내게 친절할 것</p><p>■ 가볍게 살 것</p>'
      + '<p>글ㆍ그림 김수현, 정신적ㆍ신체적 건강, A·B 테스트, 가격은 □ 안에 적기</p></body></html>',
  })
  const text = section.chunks.join(' ').replace(/\s+/g, ' ')
  assert.equal(text, 'Prologue Thanks to 내게 친절할 것 가볍게 살 것 글ㆍ그림 김수현, 정신적ㆍ신체적 건강, AB 테스트, 가격은 □ 안에 적기')
})

test('Narration omits navigation and hidden text without introducing list or quotation markers', () => {
  const chunks = audioChunksForHtml(
    '<nav>목차</nav><p hidden>숨긴 글</p><p aria-hidden="true">장식</p>'
      + '<h1>Booklog</h1><blockquote><p>인용문</p></blockquote><ul><li>첫 항목</li><li>둘째 항목</li></ul><p>부드\u00ad럽게&nbsp;읽기</p>'
  )
  const text = chunks.join(' ').replace(/\s+/g, ' ')
  assert.equal(text, 'Booklog 인용문 첫 항목 둘째 항목 부드럽게 읽기')
})

test('A shorter complete sentence is preserved instead of splitting the following sentence', () => {
  const firstSentence = '가'.repeat(300) + '.'
  const secondSentence = '낭독 단어 '.repeat(600).trim() + '.'
  const chunks = audioChunksForHtml('<p>' + firstSentence + ' ' + secondSentence + '</p>')
  assert.equal(chunks[0], firstSentence)
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), firstSentence + ' ' + secondSentence)
})

test('Manual playback after autoplay was blocked starts prefetch exactly once', async () => {
  const { logic, state, audio, requests } = createPlayerHarness(() => audioResponse(2))
  audio.play = () => Promise.reject(new DOMException('User gesture required', 'NotAllowedError'))
  logic.start(state, 0)
  await flushPlayback()
  assert.deepEqual(requests, [0])
  assert.match(state.cloudAudioMessage, /재생 버튼/)
  audio.onloadedmetadata()
  audio.onplay()
  await flushPlayback()
  audio.onpause()
  audio.onplay()
  await flushPlayback()
  assert.deepEqual(requests, [0, 1])
  assert.match(state.cloudAudioDetail, /1 \/ 2 구간/)
  logic.stop()
})

test('A stopped session does not download audio after a slow cache lookup finishes', async () => {
  let finishLookup
  const { logic, state, requests, server } = createPlayerHarness(() => audioResponse(), {
    matchCache: () =>
      new Promise((resolve) => {
        finishLookup = resolve
      }),
  })
  logic.start(state, 0)
  await flushPlayback()
  logic.stop()
  finishLookup(null)
  await flushPlayback()
  assert.deepEqual(requests, [0])
  assert.equal(server.downloads, 0)
  assert.equal(state.cloudAudioBusy, false)
})

test('Stopping before metadata loads preserves the saved listening position', async () => {
  const { logic, state, audio, server } = createPlayerHarness(() => audioResponse())
  logic.start(state, 0)
  await flushPlayback()
  audio.currentTime = 23
  logic.stop()
  audio.play = () => Promise.resolve()
  logic.start(state, 0)
  await flushPlayback()
  audio.ontimeupdate()
  logic.stop()
  await flushPlayback()
  assert.equal(server.progress.seconds, 23)
})

test('A late response from a stopped chapter never changes the new playback session', async () => {
  let finishOldChapter
  const { logic, state, requests } = createPlayerHarness((_index, _signal, section) => {
    if (section === 0)
      return new Promise((resolve) => {
        finishOldChapter = resolve
      })
    return audioResponse()
  })
  logic.start(state, 0)
  await flushPlayback()
  logic.start(state, 1)
  await flushPlayback()
  const playingDetail = state.cloudAudioDetail
  finishOldChapter(audioResponse(2))
  await flushPlayback()
  assert.equal(state.cloudAudioDetail, playingDetail)
  assert.equal(state.cloudAudioActive, true)
  assert.equal(requests.length, 2)
  logic.stop()
})

test('A fresh player restores the server chapter and playback time without browser storage', async () => {
  const first = createPlayerHarness(() => audioResponse())
  first.logic.start(first.state, 3, true)
  await flushPlayback()
  first.audio.currentTime = 17
  first.logic.stop()
  await flushPlayback()
  const second = createPlayerHarness(() => audioResponse(), { server: first.server })
  second.logic.start(second.state, 0)
  await flushPlayback()
  assert.equal(second.server.progress.sectionIndex, 3)
  assert.equal(second.audio.currentTime, 17)
  second.logic.stop()
})

test('A completed chapter remains completed until the user explicitly restarts it', async () => {
  const { logic, state, audio, server, requests } = createPlayerHarness(() => audioResponse())
  logic.start(state, 0)
  await flushPlayback()
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  assert.equal(server.progress.isCompleted, true)
  logic.stop()
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(requests.length, 1)
  assert.match(state.cloudAudioMessage, /모두 들었습니다/)
  logic.start(state, 0, true)
  await flushPlayback()
  assert.equal(server.progress.isCompleted, false)
  logic.stop()
})

const chapterResponse = (count, nextSectionIndex) =>
  new Response(JSON.stringify({ ok: true, chunkCount: count, nextSectionIndex }))

test('Finishing a chapter continues with the next chapter that has audio', async () => {
  const { logic, state, audio, requests, server } = createPlayerHarness((index, _signal, section) =>
    section === 1 ? chapterResponse(1, 4) : chapterResponse(2, -1)
  )
  logic.start(state, 1)
  await flushPlayback()
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  assert.equal(state.cloudAudioActive, true)
  assert.match(state.cloudAudioDetail, /1 \/ 2 구간/)
  assert.deepEqual(requests, [0, 0, 1])
  assert.ok(server.saves.includes('1:0:true:false'))
  assert.ok(server.saves.includes('4:0:false:true'), 'first save of the next chapter overrides an old completion')
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  assert.equal(state.cloudAudioActive, false)
  assert.match(state.cloudAudioMessage, /마지막 챕터까지 들었습니다/)
  assert.equal(state.cloudAudioSession, false, 'the start screen offers other starting points')
  logic.stop()
})

test('Resuming after a completed chapter starts the next chapter from the beginning', async () => {
  const server = {
    progress: { sectionIndex: 4, chunkIndex: 0, seconds: 0, isCompleted: false, startsNextSection: true },
    downloads: 0,
    chunkCount: 1,
    failSaves: false,
  }
  const { logic, state, server: result } = createPlayerHarness(() => chapterResponse(1, -1), { server })
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(state.cloudAudioActive, true)
  assert.ok(result.saves.includes('4:0:false:true'))
  logic.stop()
})

test('Starting from the reading position plays the chunk that contains the visible sentence', async () => {
  const server = {
    progress: { sectionIndex: 9, chunkIndex: 3, seconds: 40, isCompleted: false },
    downloads: 0,
    chunkCount: 1,
    failSaves: false,
  }
  const { logic, state, requests, audio, server: result } = createPlayerHarness(() => chapterResponse(4, -1), {
    server,
    positionChunk: 2,
    positionSeconds: 25,
  })
  logic.start(state, 5, true, '읽던 문장')
  await flushPlayback()
  assert.deepEqual(result.positionQueries, ['5:읽던 문장'])
  assert.equal(requests[0], 2)
  assert.equal(audio.currentTime, 25, 'playback starts at the visible sentence inside the chunk')
  assert.match(state.cloudAudioDetail, /3 \/ 4 구간/)
  assert.ok(result.saves.includes('5:2:false:true'), 'a previously completed chapter is reopened')
  logic.stop()
})

test('An unmatched reading position falls back to the chapter beginning with a notice', async () => {
  const { logic, state, requests } = createPlayerHarness(() => chapterResponse(2, -1))
  logic.start(state, 1, true, '찾을 수 없는 문장')
  await flushPlayback()
  assert.equal(requests[0], 0)
  assert.match(state.cloudAudioMessage, /챕터 처음부터 재생합니다/)
  logic.stop()
})

const splitParts = [
  { audioUrl: '/xapi/books/audio-file?chunkId=part-0', fallbackText: '', durationSeconds: 40 },
  { audioUrl: '', fallbackText: '차단된 문장입니다.', durationSeconds: 10 },
  { audioUrl: '/xapi/books/audio-file?chunkId=part-1', fallbackText: '', durationSeconds: 50 },
]

test('A split chunk plays its parts in order and saves one position across the parts', async () => {
  const speech = fakeSpeech()
  const { logic, state, audio, server } = createPlayerHarness(
    (index) =>
      new Response(
        JSON.stringify({ ok: true, chunkCount: 2, nextSectionIndex: -1, ...(index === 0 ? { parts: splitParts } : {}) })
      ),
    { speech }
  )
  logic.start(state, 0)
  await flushPlayback()
  assert.match(state.cloudAudioDetail, /1 \/ 2 구간 · 조각 1 \/ 3/)
  assert.equal(state.cloudAudioMessage, '')
  assert.equal(server.downloads, 3, 'both audio parts and the prefetched next chunk')
  audio.currentTime = 40
  audio.onended()
  await flushPlayback()
  assert.deepEqual(
    speech.spoken.map((item) => item.text),
    ['차단된 문장입니다.']
  )
  assert.match(state.cloudAudioDetail, /1 \/ 2 구간 · 조각 3 \/ 3/)
  audio.currentTime = 10
  logic.stop()
  await flushPlayback()
  assert.deepEqual(
    [server.progress.chunkIndex, server.progress.seconds],
    [0, 60],
    'the device voice part counts as its estimated length'
  )
})

test('Resuming inside a split chunk starts the part that contains the saved time', async () => {
  const parts = [splitParts[0], splitParts[2]]
  const { logic, state, audio } = createPlayerHarness(
    () => new Response(JSON.stringify({ ok: true, chunkCount: 2, nextSectionIndex: -1, parts })),
    { server: { progress: { sectionIndex: 0, chunkIndex: 0, seconds: 52 }, downloads: 0, chunkCount: 2 } }
  )
  logic.start(state, 0)
  await flushPlayback()
  assert.match(state.cloudAudioDetail, /조각 2 \/ 2/)
  assert.equal(audio.currentTime, 12)
  logic.stop()
})

test('The chapter progress bar spans every chunk and seeking moves to the chunk that holds the time', async () => {
  const { logic, state, audio, requests } = createPlayerHarness(() => chapterResponse(3, -1))
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(state.cloudAudioDuration, 180)
  audio.currentTime = 20
  audio.ontimeupdate()
  assert.equal(state.cloudAudioPosition, 20)
  logic.seekTo(130)
  await flushPlayback()
  assert.ok(requests.includes(2), 'the chunk containing 130s is loaded')
  assert.equal(audio.currentTime, 10)
  assert.equal(state.cloudAudioPosition, 130)
  logic.seekBy(-15)
  await flushPlayback()
  assert.ok(requests.includes(1))
  assert.equal(audio.currentTime, 55)
  assert.equal(state.cloudAudioPosition, 115)
  const loads = requests.length
  logic.seekBy(3)
  assert.equal(requests.length, loads, 'seeking inside the playing chunk does not reload it')
  assert.equal(audio.currentTime, 58)
  assert.equal(logic.toggle(), true)
  assert.equal(state.cloudAudioActive, false)
  logic.toggle()
  assert.equal(state.cloudAudioActive, true)
  logic.stop()
  assert.equal(state.cloudAudioDuration, 0)
  assert.equal(logic.toggle(), false, 'without a session the caller starts playback')
})

test('Chapter buttons jump to the start of the previous or next chapter that has audio', async () => {
  const handlers = {}
  const mediaSession = { setActionHandler: (action, handler) => (handlers[action] = handler), setPositionState() {} }
  const chapters = { 2: [-1, 5], 5: [2, 9], 9: [5, -1] }
  const { logic, state, audio, server } = createPlayerHarness(
    (index, _signal, section) =>
      new Response(
        JSON.stringify({
          ok: true,
          chunkCount: 2,
          previousSectionIndex: chapters[section][0],
          nextSectionIndex: chapters[section][1],
        })
      ),
    { mediaSession }
  )
  logic.start(state, 5)
  await flushPlayback()
  assert.deepEqual([state.cloudAudioHasPrevious, state.cloudAudioHasNext], [true, true])
  audio.currentTime = 30
  logic.moveChapter(1)
  await flushPlayback()
  assert.match(state.cloudAudioDetail, /1 \/ 2 구간/)
  assert.equal(state.cloudAudioPosition, 0)
  assert.deepEqual([state.cloudAudioHasPrevious, state.cloudAudioHasNext], [true, false])
  assert.ok(server.saves.includes('9:0:false:true'), 'the new chapter is saved as a restart')
  logic.moveChapter(1)
  await flushPlayback()
  assert.equal(server.progress.sectionIndex, 9, 'there is no chapter after the last one')
  handlers.previoustrack()
  await flushPlayback()
  handlers.previoustrack()
  await flushPlayback()
  assert.equal(server.progress.sectionIndex, 2)
  assert.deepEqual([state.cloudAudioHasPrevious, state.cloudAudioHasNext], [false, true])
  logic.stop()
  assert.deepEqual([state.cloudAudioHasPrevious, state.cloudAudioHasNext], [false, false])
})

test('A dragged progress bar is not overwritten by playback updates until it is released', async () => {
  const { logic, state, audio } = createPlayerHarness(() => chapterResponse(2, -1))
  logic.start(state, 0)
  await flushPlayback()
  state.cloudAudioSeeking = true
  state.cloudAudioPosition = 90
  audio.currentTime = 5
  audio.ontimeupdate()
  assert.equal(state.cloudAudioPosition, 90)
  logic.stop()
})

test('Before playback the resume button shows where listening continues', async () => {
  const fresh = createPlayerHarness(() => chapterResponse(1, -1))
  fresh.logic.preview(fresh.state)
  await flushPlayback()
  assert.match(fresh.state.cloudAudioResumeLabel, /처음 듣는 책/)
  const saved = createPlayerHarness(() => chapterResponse(3, -1), {
    server: { progress: { sectionIndex: 0, chunkIndex: 1, seconds: 15, chapterSeconds: 75 }, downloads: 0, chunkCount: 3 },
  })
  saved.logic.preview(saved.state)
  await flushPlayback()
  assert.equal(saved.state.cloudAudioResumeLabel, '1:15부터')
  saved.logic.start(saved.state, 0)
  await flushPlayback()
  assert.equal(saved.state.cloudAudioSession, true)
  saved.logic.stop()
  assert.equal(saved.state.cloudAudioSession, false)
})

test('Starting on a page without narration plays the next chapter and shows its chapter number', async () => {
  const sections = []
  const { logic, state, server } = createPlayerHarness((index, _signal, section) => {
    sections.push(section)
    if (section === 2) {
      return new Response(JSON.stringify({ ok: false, reason: 'no-text', nextSectionIndex: 5, message: '없음' }), {
        status: 404,
      })
    }
    return new Response(
      JSON.stringify({ ok: true, chunkCount: 2, nextSectionIndex: -1, chapterNumber: 3, chapterTotal: 16 })
    )
  })
  logic.start(state, 2, true)
  await flushPlayback()
  assert.deepEqual(sections.slice(0, 2), [2, 5])
  assert.equal(state.cloudAudioActive, true)
  assert.equal(state.cloudAudioChapterOrder, '3 / 16')
  assert.ok(server.saves.some((save) => save.startsWith('5:0:false:true')), 'the moved chapter starts over')
  logic.stop()
  assert.equal(state.cloudAudioChapterOrder, '')
})

test('A chapter that is not generated yet shows why playback stopped', async () => {
  const message = '이 챕터는 아직 AI 음성을 만들지 않았습니다. 지금 3 / 16번째 챕터를 만들고 있습니다.'
  const { logic, state } = createPlayerHarness(
    () => new Response(JSON.stringify({ ok: false, reason: 'not-ready', message }), { status: 404 })
  )
  logic.start(state, 8, true)
  await flushPlayback()
  assert.equal(state.cloudAudioMessage, message)
  assert.equal(state.cloudAudioSession, false, 'the start screen comes back with the reason')
  assert.equal(state.cloudAudioActive, false)
  logic.stop()
})

test('A part that is still being generated is read with the device voice and says so', async () => {
  const speech = fakeSpeech()
  const { logic, state } = createPlayerHarness(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          chunkCount: 1,
          nextSectionIndex: -1,
          parts: [{ audioUrl: '', fallbackText: '아직 만드는 중인 문장입니다.', pending: true, durationSeconds: 5 }],
        })
      ),
    { speech }
  )
  logic.start(state, 0)
  await flushPlayback()
  assert.deepEqual(
    speech.spoken.map((item) => item.text),
    ['아직 만드는 중인 문장입니다.']
  )
  logic.stop()
})

test('Device voice resumes at the sentence nearest the saved time and saves its estimated progress', async () => {
  const sentences = ['첫째 문장입니다.', '둘째 문장입니다.', '셋째 문장입니다.', '넷째 문장입니다.']
  const speech = fakeSpeech()
  speech.speak = (utterance) => speech.spoken.push({ text: utterance.text, utterance })
  const server = { progress: { sectionIndex: 0, chunkIndex: 0, seconds: 25 }, downloads: 0, chunkCount: 1 }
  const { logic, state } = createPlayerHarness(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          chunkCount: 1,
          nextSectionIndex: -1,
          parts: [{ audioUrl: '', fallbackText: sentences.join('\n'), pending: true, durationSeconds: 40 }],
        })
      ),
    { speech, server }
  )
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(speech.spoken[0].text, '셋째 문장입니다.', 'the third sentence starts at 20s, just before 25s')
  assert.equal(state.cloudAudioPosition, 20)
  speech.spoken[0].utterance.onend()
  assert.equal(speech.spoken[1].text, '넷째 문장입니다.')
  assert.equal(state.cloudAudioPosition, 30)
  logic.stop()
  await flushPlayback()
  assert.equal(server.progress.seconds, 30, 'the estimated device-voice progress is saved')
})

test('Seeking forward in device voice moves past a sentence longer than the seek step', async () => {
  const speech = fakeSpeech()
  speech.speak = (utterance) => speech.spoken.push({ text: utterance.text, utterance })
  const { logic, state } = createPlayerHarness(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          chunkCount: 1,
          nextSectionIndex: -1,
          timeline: [40],
          parts: [{ audioUrl: '', fallbackText: '첫째 문장입니다.\n둘째 문장입니다.', pending: true, durationSeconds: 40 }],
        })
      ),
    { speech }
  )
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(speech.spoken[0].text, '첫째 문장입니다.')
  logic.seekBy(15)
  await flushPlayback()
  assert.equal(speech.spoken.at(-1).text, '둘째 문장입니다.', 'a 20s sentence is not restarted by a 15s seek')
  assert.equal(state.cloudAudioPosition, 20)
  logic.stop()
})

test('Starting from the reading position in device voice begins at the visible sentence, not the line before', async () => {
  const speech = fakeSpeech()
  speech.speak = (utterance) => speech.spoken.push({ text: utterance.text, utterance })
  const lines = ['앞 문단은 화면 위쪽 이전 페이지에 있습니다.', '화면 첫 문장입니다. 이어지는 문장입니다.']
  const { logic, state } = createPlayerHarness(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          chunkCount: 1,
          nextSectionIndex: -1,
          parts: [{ audioUrl: '', fallbackText: lines.join('\n'), pending: true, durationSeconds: 40 }],
        })
      ),
    { speech, positionChunk: 0, positionSeconds: 15 }
  )
  logic.start(state, 0, true, '이어지는 문장입니다. 다음 문단')
  await flushPlayback()
  assert.equal(speech.spoken[0].text, '이어지는 문장입니다.', 'the sentence is found in the text instead of the estimated time')
  logic.stop()
})

test('A dropped connection between chunks is retried before playback gives up', async () => {
  let failures = 2
  const { logic, state, requests } = createPlayerHarness(() => {
    if (requests.length === 2 && failures > 0) {
      failures -= 1
      throw new TypeError('Failed to fetch')
    }
    return chapterResponse(2, -1)
  })
  logic.start(state, 0)
  await flushPlayback()
  const original = globalThis.setTimeout
  logic.seekTo(70)
  await new Promise((resolve) => original(resolve, 6500))
  await flushPlayback()
  assert.equal(state.cloudAudioSession, true, 'playback continues after the connection returns')
  assert.match(state.cloudAudioDetail, /2 \/ 2 구간/)
  logic.stop()
})

test('Starting from an excluded page explains that the next narrated chapter plays', async () => {
  const { logic, state } = createPlayerHarness((index, _signal, section) =>
    section === 3
      ? new Response(JSON.stringify({ ok: false, reason: 'no-text', nextSectionIndex: 5 }), { status: 404 })
      : chapterResponse(1, -1)
  )
  logic.start(state, 3, true, '판권 페이지의 문장입니다')
  await flushPlayback()
  assert.match(state.cloudAudioMessage, /다음 본문 챕터부터 재생합니다/)
  logic.stop()
})

test('A body file over the size limit fails planning instead of silently dropping a chapter', () => {
  assert.throws(
    () => audioSectionsForFiles({ 'huge.xhtml': '<html><body><p>' + '가'.repeat(6 * 1024 * 1024) + '</p></body></html>' }),
    (error) => /16MB를 넘어/.test(error.userMessage)
  )
})

test('The listening position is the start of the sentence being read in the current part', async () => {
  const text = '첫 문장입니다. 둘째 문장은 여기서 시작합니다. 셋째 문장입니다.'
  const { logic, state, audio } = createPlayerHarness(() =>
    new Response(
      JSON.stringify({
        ok: true,
        chunkCount: 1,
        nextSectionIndex: -1,
        parts: [{ audioUrl: '/xapi/books/audio-file?chunkId=p', fallbackText: '', text, durationSeconds: 60 }],
      })
    )
  )
  assert.equal(logic.currentAnchor(), null)
  logic.start(state, 4)
  await flushPlayback()
  assert.deepEqual(JSON.parse(JSON.stringify(logic.currentAnchor())), { sectionIndex: 4, text })
  audio.currentTime = 30
  assert.deepEqual(JSON.parse(JSON.stringify(logic.currentAnchor())), { sectionIndex: 4, text: '둘째 문장은 여기서 시작합니다. 셋째 문장입니다.' })
  logic.stop()
})

test('Playback times are shown as minutes or hours', () => {
  const { logic } = createPlayerHarness(() => chapterResponse(1, -1))
  assert.deepEqual(
    [0, 65.9, 3600, 3725].map(logic.formatTime),
    ['0:00', '1:05', '1:00:00', '1:02:05']
  )
})

test('Reading-position matching ignores whitespace and tolerates anchors that cross chunk boundaries', () => {
  const context = {
    module: { exports: {} },
    require: () => ({}),
    __hooks: '',
    $security: { sha256: () => '' },
  }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/book-audio-data.js', import.meta.url), 'utf8'),
    context
  )
  const chunks = ['첫 구간의 문장입니다.', '둘째 구간은\n\n여기서 시작하는 긴 문단입니다.', '셋째 구간 문단입니다.'].map(
    (text, index) => ({ get: (name) => (name === 'input_text' ? text : index) })
  )
  const app = { findRecordsByFilter: () => chunks }
  const find = (anchor) =>
    JSON.parse(JSON.stringify(context.module.exports.findChunkPositionByText(app, 'file', 'hash', 0, anchor)))
  assert.deepEqual(find('여기서  시작하는 긴'), { chunkIndex: 1, ratio: 5 / 19 })
  assert.deepEqual(find('둘째 구간은 여기서 시작하는 긴 문단입니다. 셋째 구간 문단입니다.'), { chunkIndex: 1, ratio: 0 })
  assert.equal(find('어디에도 없는 문장입니다만 충분히 깁니다').chunkIndex, -1)
  assert.equal(find('   ').chunkIndex, -1)
})

function fakeSpeech() {
  const speech = {
    spoken: [],
    cancelled: 0,
    getVoices: () => [{ name: '한국어', lang: 'ko-KR' }],
    speak(utterance) {
      speech.spoken.push({ text: utterance.text, lang: utterance.lang, voice: utterance.voice && utterance.voice.name })
      setImmediate(() => utterance.onend && utterance.onend())
    },
    cancel() {
      speech.cancelled += 1
    },
    pause() {},
    resume() {},
  }
  return speech
}

test('A chunk that failed every retry is read with the device voice and playback continues', async () => {
  const speech = fakeSpeech()
  const fallbackText = '첫 문장입니다. 둘째 문장입니다.\n셋째 줄입니다.'
  const { logic, state, audio, requests, server } = createPlayerHarness(
    (index) =>
      index === 1
        ? new Response(JSON.stringify({ ok: true, chunkCount: 3, nextSectionIndex: -1, fallbackText }))
        : chapterResponse(3, -1),
    { speech }
  )
  logic.start(state, 0)
  await flushPlayback()
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  assert.deepEqual(
    speech.spoken.map((item) => item.text),
    ['첫 문장입니다. 둘째 문장입니다.', '셋째 줄입니다.']
  )
  assert.equal(speech.spoken[0].lang, 'ko-KR')
  assert.equal(speech.spoken[0].voice, '한국어')
  assert.deepEqual(requests, [0, 1, 2])
  assert.ok(server.saves.some((save) => save.startsWith('0:1:false')), 'the fallback chunk position is saved')
  assert.equal(state.cloudAudioActive, true)
  assert.match(state.cloudAudioDetail, /3 \/ 3 구간/)
  assert.equal(state.cloudAudioMessage, '', 'normal AI playback shows no notice')
  logic.stop()
})

test('Stopping during a device voice fallback cancels speech and never resumes it', async () => {
  const speech = fakeSpeech()
  speech.speak = (utterance) => speech.spoken.push({ text: utterance.text })
  const { logic, state } = createPlayerHarness(
    () => new Response(JSON.stringify({ ok: true, chunkCount: 1, nextSectionIndex: -1, fallbackText: '대체 문장' })),
    { speech }
  )
  logic.start(state, 0)
  await flushPlayback()
  assert.match(state.cloudAudioMessage, /기기 음성으로 읽는 중/)
  const cancelledBefore = speech.cancelled
  logic.stop()
  assert.equal(speech.cancelled, cancelledBefore + 1)
  assert.equal(state.cloudAudioActive, false)
})

test('Lock screen controls show the chapter and control the same player', async () => {
  const handlers = {}
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) {
      handlers[action] = handler
    },
    setPositionState(position) {
      this.position = position
    },
  }
  const { logic, state, audio } = createPlayerHarness(() => chapterResponse(1, -1), { mediaSession })
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(mediaSession.metadata.artist, '테스트 책')
  assert.equal(mediaSession.playbackState, 'playing')
  assert.equal(mediaSession.position.duration, 60)
  audio.currentTime = 30
  handlers.seekbackward({})
  assert.equal(audio.currentTime, 15)
  handlers.seekforward({ seekOffset: 30 })
  assert.equal(audio.currentTime, 45)
  handlers.pause()
  assert.equal(mediaSession.playbackState, 'paused')
  logic.stop()
  assert.equal(handlers.play, null)
  assert.equal(mediaSession.playbackState, 'none')
})

test('A saved position the server rejects as invalid is dropped and never blocks playback', async () => {
  const storage = new Map([
    [
      'booklog-audio-pending:user:hash',
      JSON.stringify({
        stale: {
          key: 'stale',
          sectionIndex: 0,
          revision: '1',
          fields: { configHash: 'settings', chunkId: 'chunk-0-0', seconds: '60', isCompleted: 'true', restart: 'false' },
        },
      }),
    ],
  ])
  const server = { progress: null, downloads: 0, chunkCount: 2, rejectSaves: true }
  const { logic, state } = createPlayerHarness(() => chapterResponse(2, -1), { storage, server })
  logic.start(state, 0)
  await flushPlayback()
  assert.equal(server.rejected >= 1, true)
  assert.equal(state.cloudAudioActive, true, 'playback starts despite the rejected save')
  assert.equal(JSON.parse(storage.get('booklog-audio-pending:user:hash')).stale, undefined)
  logic.stop()
})

test('Failed completion saves are retained locally and flushed before the next resume', async () => {
  const { logic, state, audio, server, values } = createPlayerHarness(() => audioResponse())
  logic.start(state, 0)
  await flushPlayback()
  server.failSaves = true
  audio.currentTime = 60
  audio.onended()
  await flushPlayback()
  assert.equal(server.progress.isCompleted, false)
  server.failSaves = false
  logic.stop()
  const restored = createPlayerHarness(() => audioResponse(), { server, storage: values })
  restored.logic.start(restored.state, 0)
  await flushPlayback()
  assert.equal(server.progress.isCompleted, true)
  assert.match(restored.state.cloudAudioMessage, /모두 들었습니다/)
  restored.logic.stop()
})
