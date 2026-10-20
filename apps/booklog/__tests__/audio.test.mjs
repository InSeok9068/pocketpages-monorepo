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
      findPlayableChunk(app, fileId, configHash, sectionIndex, chunkIndex) {
        lookups.push({ fileId, configHash, sectionIndex, chunkIndex })
        return ready ? { id: 'chunk' } : null
      },
      countSectionChunks: () => 3,
      findNextSectionIndex: (app, fileId, configHash, sectionIndex) => sectionIndex + 2,
      findPlayableParts: (app, chunk) => (split ? null : [chunk]),
      findPreviousSectionIndex: (app, fileId, configHash, sectionIndex) => sectionIndex - 1,
      sectionTimeline: () => [60, 60, 60],
      chunkView: (chunk, parts, bookId, chunkCount, sections, timeline) => ({
        chunkId: chunk.id,
        parts: parts.length,
        chunkCount,
        nextSectionIndex: sections.next,
        previousSectionIndex: sections.previous,
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

test('A chunk blocked twice is replaced by two ordered parts and short chunks keep retrying', () => {
  const text = longNarration(60)
  const split = generateWithProviderResult(policyBlock, { attempt_count: 1, input_text: text })
  assert.equal(split.result.blocked, true)
  assert.equal(split.result.split, true)
  assert.equal(split.fields.status, 'split')
  assert.equal(split.fields.attempt_count, 2)
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
  const first = generateWithProviderResult(policyBlock, { input_text: text })
  assert.equal(first.fields.status, 'failed')
  assert.equal(first.created.length, 0)
  const short = generateWithProviderResult(policyBlock, { attempt_count: 1, input_text: longNarration(12) })
  assert.equal(short.fields.status, 'failed')
  assert.equal(short.created.length, 0)
  const other = generateWithProviderResult(
    { ok: false, statusCode: 500, errorMessage: 'Internal' },
    { attempt_count: 1, input_text: text }
  )
  assert.equal(other.fields.status, 'failed', 'only policy blocks are split')
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
  assert.equal(found.result.body.nextSectionIndex, 4)
  assert.equal(found.result.body.previousSectionIndex, 1)
  const missing = runRoute({ ready: false })
  assert.equal(missing.result.status, 404)
  assert.match(missing.result.body.message, /아직 AI 오디오북이 생성되지 않았습니다/)
  assert.equal(runRoute({ split: true }).result.status, 404, 'a split chunk waits until every part is playable')
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
        return new Response(JSON.stringify({ ok: true, chunkIndex: positionChunk }))
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
  const { logic, state, requests, server: result } = createPlayerHarness(() => chapterResponse(4, -1), {
    server,
    positionChunk: 2,
  })
  logic.start(state, 5, true, '읽던 문장')
  await flushPlayback()
  assert.deepEqual(result.positionQueries, ['5:읽던 문장'])
  assert.equal(requests[0], 2)
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
  const find = (anchor) => context.module.exports.findChunkIndexByText(app, 'file', 'hash', 0, anchor)
  assert.equal(find('여기서  시작하는 긴'), 1)
  assert.equal(find('둘째 구간은 여기서 시작하는 긴 문단입니다. 셋째 구간 문단입니다.'), 1)
  assert.equal(find('어디에도 없는 문장입니다만 충분히 깁니다'), -1)
  assert.equal(find('   '), -1)
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
