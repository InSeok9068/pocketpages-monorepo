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
  const paragraph = '오디오북 문장을 자연스럽게 읽습니다. '.repeat(160).trim()
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
  assert.ok(chunks.every((text) => text.length <= 1400))
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), paragraph)
})

function runRoute({ authenticated = true, method = 'GET', owned = true, ready = true, query = {} } = {}) {
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
      getSettings: () => ({ configHash: 'settings' }),
      findReadyChunk(app, fileId, configHash, sectionIndex, chunkIndex) {
        lookups.push({ fileId, configHash, sectionIndex, chunkIndex })
        return ready ? { id: 'chunk' } : null
      },
      countSectionChunks: () => 3,
      findNextSectionIndex: (app, fileId, configHash, sectionIndex) => sectionIndex + 2,
      chunkView: (chunk, bookId, chunkCount, nextSectionIndex) => ({ chunkId: chunk.id, chunkCount, nextSectionIndex }),
    }),
  }
  vm.runInNewContext('(function () {' + routeSource + '\n})()', context)
  return { result, queries, lookups }
}

test('Generated WAV decoding matches the original bytes and duration for every padding length', () => {
  const context = { module: { exports: {} } }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/book-audio-generation-service.js', import.meta.url), 'utf8'),
    context
  )
  for (const extra of [0, 1, 2]) {
    const wav = Buffer.alloc(44 + 48000 * 2 + extra)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(24000, 24)
    wav.writeUInt32LE(48000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(48000 * 2 + extra, 40)
    for (let index = 44; index < wav.length; index += 1) wav[index] = (index * 37) % 256
    const decoded = context.module.exports.decodeWave(wav.toString('base64'))
    assert.ok(Buffer.from(decoded.bytes).equals(wav))
    assert.equal(decoded.durationSeconds, (48000 * 2 + extra) / 48000)
  }
  assert.throws(() => context.module.exports.decodeWave('not base64!'))
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
  const missing = runRoute({ ready: false })
  assert.equal(missing.result.status, 404)
  assert.match(missing.result.body.message, /아직 AI 오디오북이 생성되지 않았습니다/)
})

function createPlayerHarness(fetchAudio, options = {}) {
  const values = options.storage || new Map()
  const cachedAudio = new Map()
  const requests = []
  const server = options.server || { progress: null, downloads: 0, chunkCount: 1, failSaves: false }
  const audio = {
    currentTime: 0,
    duration: 60,
    src: '',
    playbackRate: 1,
    play() {
      this.onloadedmetadata?.()
      this.onplay?.()
      return Promise.resolve()
    },
    pause() {
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
  const context = {
    window: {
      booklogReaderConfig: {
        readerCacheKey: 'user:hash',
        bookId: 'book',
        bookFileId: 'file',
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
      return new Response(
        JSON.stringify({
          ...result,
          chunkId: 'chunk-' + section + '-' + index,
          configHash: 'settings',
          audioUrl: '/xapi/books/audio-file?chunkId=chunk-' + section + '-' + index,
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
  assert.match(state.cloudAudioMessage, /2 \/ 2/)
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
  const secondSentence = '낭독 단어 '.repeat(350).trim() + '.'
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
  assert.match(state.cloudAudioMessage, /1 \/ 2 구간/)
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
  const playingMessage = state.cloudAudioMessage
  finishOldChapter(audioResponse(2))
  await flushPlayback()
  assert.equal(state.cloudAudioMessage, playingMessage)
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
  assert.match(state.cloudAudioMessage, /1 \/ 2 구간/)
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
