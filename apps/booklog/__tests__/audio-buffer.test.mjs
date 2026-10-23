/* global window, document, SourceBuffer, HTMLMediaElement, caches */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium } from '@playwright/test'

const source = readFileSync(new URL('../pb_hooks/pages/assets/booklog-audio.js', import.meta.url), 'utf8')
// MPEG-1 Layer III의 무음 프레임입니다. 실제 Chrome 디코더와 SourceBuffer를 통과시킵니다.
const frames = 25
const mp3 = Buffer.alloc(417 * frames)
for (let index = 0; index < frames; index += 1) mp3.set([0xff, 0xfb, 0x90, 0x64], index * 417)
const duration = (frames * 1152) / 44100
let browser
before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
})
after(async () => {
  await browser?.close()
})

async function createPlayer(options = {}) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const saves = []
  const requests = []
  const errors = []
  const server = { progress: options.progress || null, failSaves: false }
  const chapters = options.chapters || { 0: [[true, true], [true]], 2: [[true], [true]] }
  const audioFrames = options.segmentSeconds ? Math.ceil((options.segmentSeconds * 44100) / 1152) : frames
  const audioBytes = options.segmentSeconds ? Buffer.alloc(417 * audioFrames) : mp3
  if (options.segmentSeconds) {
    for (let index = 0; index < audioFrames; index += 1) audioBytes.set([0xff, 0xfb, 0x90, 0x64], index * 417)
  }
  const segmentDuration = (audioFrames * 1152) / 44100
  const order = Object.keys(chapters)
    .map(Number)
    .sort((a, b) => a - b)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.testLiveUrls = []
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (value) => {
      const url = create(value)
      window.testLiveUrls.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      window.testLiveUrls = window.testLiveUrls.filter((item) => item !== url)
      revoke(url)
    }
    window.testMediaActions = {}
    const setAction = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession)
    navigator.mediaSession.setActionHandler = (action, handler) => {
      window.testMediaActions[action] = handler
      setAction(action, handler)
    }
  })
  await page.addInitScript(
    ({ disabled, appendFailure }) => {
      if (disabled) window.MediaSource = undefined
      if (appendFailure) {
        SourceBuffer.prototype.appendBuffer = function () {
          throw new DOMException('test append failure', 'QuotaExceededError')
        }
      }
    },
    { disabled: options.disabled, appendFailure: options.appendFailure }
  )
  if (options.speech) {
    await page.addInitScript(() => {
      window.testUtterances = []
      Object.defineProperty(window, 'speechSynthesis', {
        value: {
          getVoices: () => [],
          cancel() {},
          resume() {},
          pause() {},
          speak: (utterance) => window.testUtterances.push(utterance),
        },
      })
    })
  }
  await page.route('http://127.0.0.1:19876/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body) => route.fulfill({ json: body })
    if (url.pathname === '/audio.js') return route.fulfill({ contentType: 'text/javascript', body: source })
    if (url.pathname === '/audio.mp3') return route.fulfill({ contentType: 'audio/mpeg', body: audioBytes })
    if (url.pathname === '/api/books/audio-progress') {
      if (request.method() === 'POST') {
        if (server.failSaves) return route.fulfill({ status: 503, json: { ok: false, message: 'test offline' } })
        const fields = {}
        for (const match of request.postData().matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)) fields[match[1]] = match[2]
        saves.push(fields)
        if (options.persistProgress) {
          const [, section, chunk] = fields.chunkId.split('-')
          server.progress = {
            sectionIndex: Number(section),
            chunkIndex: Number(chunk),
            seconds: Number(fields.seconds),
            isCompleted: fields.isCompleted === 'true',
          }
        }
        return json({ ok: true })
      }
      return json({ ok: true, configHash: 'settings', progress: server.progress })
    }
    if (url.pathname === '/api/books/audio-chunk') {
      const section = Number(url.searchParams.get('sectionIndex'))
      const index = Number(url.searchParams.get('chunkIndex'))
      requests.push([section, index])
      const parts = chapters[section][index]
      return json({
        ok: true,
        configHash: 'settings',
        chunkId: `chunk-${section}-${index}`,
        chunkCount: chapters[section].length,
        chapterNumber: order.indexOf(section) + 1,
        chapterTotal: order.length,
        previousSectionIndex: order[order.indexOf(section) - 1] ?? -1,
        nextSectionIndex: order[order.indexOf(section) + 1] ?? -1,
        timeline: chapters[section].map((items) => items.length * segmentDuration),
        parts: parts.map((ready, part) => ({
          audioUrl: ready ? `/audio.mp3?chunkId=audio-${section}-${index}-${part}` : '',
          fallbackText: ready ? '' : '기기 음성 구간입니다.',
          text: '이 구간의 본문입니다.',
          durationSeconds: segmentDuration,
        })),
      })
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8">
      <audio id="reader-cloud-audio" preload="metadata"></audio>
      <button id="reader-audio-diagnostics-copy">diagnostics</button>
      <button id="reader-audio-diagnostics-toggle" onclick="booklogAudio.toggleDiagnostics()">record</button>
      <button id="start" onclick="booklogAudio.start(state, 0)">start</button>
      <script>
        window.booklogReaderConfig = {bookId:'book',bookFileId:'file',readerCacheKey:'buffer-test'};
        window.booklogReaderLogic = {audioChapterLabel: function (index) {return 'chapter ' + index}};
        window.state = {readAloudRate:'1',cloudAudioBusy:false,cloudAudioActive:false};
      </script><script src="/audio.js"></script>`,
    })
  })
  await page.goto('http://127.0.0.1:19876/')
  if (options.recording !== false) await page.click('#reader-audio-diagnostics-toggle')
  return { context, page, saves, requests, errors, server, segmentDuration }
}

async function waitForSaves(page) {
  await page.waitForFunction(
    () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:buffer-test') || '{}')).length === 0
  )
}

async function bufferEvents(page) {
  return page.evaluate(() => JSON.parse(window.booklogAudio.exportDiagnostics()).events)
}

test('Real Chrome plays split parts and chapters through one source without intermediate ended events', async () => {
  const player = await createPlayer()
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => {
      const events = JSON.parse(window.booklogAudio.exportDiagnostics()).events
      return events.some((entry) => entry.event === 'buffer-end' && entry.details.reason === 'complete')
    })
    const src = await player.page.locator('audio').getAttribute('src')
    const foreground = await player.context.newPage()
    await foreground.bringToFront()
    await player.page.waitForFunction(() => window.state.cloudAudioChapter === 'chapter 2', null, { polling: 50 })
    assert.equal(await player.page.locator('audio').getAttribute('src'), src)
    const during = await player.page.evaluate(() => JSON.parse(window.booklogAudio.exportDiagnostics()).events)
    assert.equal(during.filter((entry) => entry.event === 'ended').length, 0)
    assert.equal(during.filter((entry) => entry.event === 'play-request').length, 1)
    assert.equal(during.filter((entry) => entry.event === 'buffer-append').length, 5)
    assert.ok(player.saves.some((save) => save.chunkId === 'chunk-0-1' && save.isCompleted === 'true'))
    await player.page.waitForFunction(() => window.state.cloudAudioSession === false, null, { polling: 50 })
    await player.page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:buffer-test') || '{}')).length === 0
    )
    assert.ok(player.saves.some((save) => save.chunkId === 'chunk-2-1' && save.isCompleted === 'true'))
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Long chapters load only nearby chunks, trim heard audio and save part-local positions', async () => {
  const player = await createPlayer({ segmentSeconds: 90, chapters: { 0: Array.from({ length: 8 }, () => [true]) } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => {
      const events = JSON.parse(window.booklogAudio.exportDiagnostics()).events
      return events.filter((entry) => entry.event === 'buffer-append').length === 2
    })
    assert.deepEqual(player.requests, [
      [0, 0],
      [0, 1],
    ])
    await player.page.evaluate(() => {
      window.booklogAudio.toggle()
      document.querySelector('audio').currentTime = 120
    })
    await player.page.waitForFunction(() => {
      const events = JSON.parse(window.booklogAudio.exportDiagnostics()).events
      return (
        events.some((entry) => entry.event === 'buffer-trim')
        && events.filter((entry) => entry.event === 'buffer-append').length === 3
      )
    })
    assert.deepEqual(player.requests, [
      [0, 0],
      [0, 1],
      [0, 2],
    ])
    assert.ok(await player.page.evaluate(() => document.querySelector('audio').buffered.start(0) >= 89))
    assert.ok(Math.abs((await player.page.evaluate(() => window.state.cloudAudioPosition)) - 120) < 0.1)
    await player.page.evaluate(() => window.booklogAudio.stop())
    await player.page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:buffer-test') || '{}')).length === 0
    )
    const last = player.saves.at(-1)
    assert.equal(last.chunkId, 'chunk-0-1')
    assert.ok(Number(last.seconds) > 29 && Number(last.seconds) < 31, last.seconds)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Seeking into trimmed audio in the same part rebuilds the buffer and remains paused', async () => {
  const player = await createPlayer({ segmentSeconds: 90, chapters: { 0: Array.from({ length: 8 }, () => [true]) } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => {
      const events = JSON.parse(window.booklogAudio.exportDiagnostics()).events
      return events.filter((entry) => entry.event === 'buffer-append').length === 2
    })
    await player.page.evaluate(() => {
      window.booklogAudio.toggle()
      document.querySelector('audio').currentTime = 150
    })
    await player.page.waitForFunction(() => {
      const ranges = document.querySelector('audio').buffered
      return ranges.length > 0 && ranges.start(0) >= 119
    })
    const sourceBefore = await player.page.locator('audio').getAttribute('src')
    await player.page.evaluate(() => window.booklogAudio.seekTo(100))
    await player.page.waitForFunction(() => {
      const ranges = document.querySelector('audio').buffered
      return !window.state.cloudAudioBusy && ranges.length > 0 && ranges.start(0) < 1
    })
    assert.notEqual(await player.page.locator('audio').getAttribute('src'), sourceBefore)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), false)
    assert.ok(Math.abs((await player.page.evaluate(() => window.state.cloudAudioPosition)) - 100) < 0.1)
    await player.page.evaluate(() => window.booklogAudio.toggle())
    await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Diagnostics are off by default, can be enabled, and clearing them leaves playback running', async () => {
  const player = await createPlayer({ recording: false, segmentSeconds: 90 })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
    const before = await player.page.evaluate(() => JSON.parse(window.booklogAudio.exportDiagnostics()))
    assert.equal(before.recording, false)
    assert.equal(before.events.length, 0)
    await player.page.click('#reader-audio-diagnostics-toggle')
    const enabled = await player.page.evaluate(() => JSON.parse(window.booklogAudio.exportDiagnostics()))
    assert.equal(enabled.recording, true)
    assert.ok(enabled.events.some((entry) => entry.event === 'diagnostics-start'))
    await player.page.evaluate(() => window.booklogAudio.clearDiagnostics())
    const cleared = await player.page.evaluate(() => JSON.parse(window.booklogAudio.exportDiagnostics()))
    assert.equal(cleared.events.length, 0)
    assert.equal(cleared.recording, false)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), true)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Stopping during an outstanding buffer download never starts late playback', async () => {
  const player = await createPlayer({ chapters: { 0: [[true], [true]] } })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let reached
  const requested = new Promise((resolve) => {
    reached = resolve
  })
  try {
    await player.page.route('**/audio.mp3?chunkId=audio-0-1-0', async (route) => {
      reached()
      await gate
      await route.fulfill({ contentType: 'audio/mpeg', body: mp3 }).catch(() => {})
    })
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
    await requested
    await player.page.evaluate(() => window.booklogAudio.stop())
    release()
    await player.page.waitForFunction(() => !window.state.cloudAudioBusy && !window.state.cloudAudioSession)
    assert.equal(await player.page.locator('audio').getAttribute('src'), null)
    assert.deepEqual(player.errors, [])
  } finally {
    release()
    await player.context.close()
  }
})

test('A device-voice gap ends the buffer, reads the gap and starts a new AI buffer afterwards', async () => {
  const player = await createPlayer({ speech: true, chapters: { 0: [[true, false, true]] } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioDeviceVoice === true)
    assert.equal(await player.page.evaluate(() => window.testUtterances.length), 1)
    await player.page.evaluate(() => window.testUtterances.shift().onend())
    await player.page.waitForFunction(() => {
      const events = JSON.parse(window.booklogAudio.exportDiagnostics()).events
      return (
        events.filter((entry) => entry.event === 'buffer-start').length === 2
        && window.state.cloudAudioActive
        && !window.state.cloudAudioDeviceVoice
      )
    })
    await player.page.waitForFunction(() => window.state.cloudAudioSession === false)
    await player.page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:buffer-test') || '{}')).length === 0
    )
    assert.ok(player.saves.some((save) => save.chunkId === 'chunk-0-0' && save.isCompleted === 'true'))
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('The chapter sleep timer stops at a buffered chapter boundary and keeps its completion', async () => {
  const player = await createPlayer({ chapters: { 0: [[true, true]], 2: [[true]] } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
    await player.page.evaluate(() => {
      for (let index = 0; index < 4; index += 1) window.booklogAudio.cycleSleepTimer()
    })
    await player.page.waitForFunction(() => window.state.cloudAudioSession === false)
    await player.page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:buffer-test') || '{}')).length === 0
    )
    assert.ok(player.saves.some((save) => save.chunkId === 'chunk-0-0' && save.isCompleted === 'true'))
    assert.ok(!player.saves.some((save) => save.chunkId === 'chunk-2-0'))
    assert.match(await player.page.evaluate(() => window.state.cloudAudioMessage), /잠자기 타이머/)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Real Chrome preserves resume and paused seeking when a buffer is rebuilt', async () => {
  const player = await createPlayer({
    chapters: { 0: [[true, true], [true]] },
    progress: { sectionIndex: 0, chunkIndex: 0, seconds: duration + 0.2 },
  })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
    await player.page.evaluate(() => window.booklogAudio.toggle())
    await player.page.waitForFunction(() => !window.state.cloudAudioActive)
    const position = await player.page.evaluate(() => window.state.cloudAudioPosition)
    assert.ok(position >= duration + 0.19 && position < duration + 0.5, String(position))
    await player.page.evaluate(() => window.booklogAudio.seekTo(0.15))
    await player.page.waitForFunction(() => !window.state.cloudAudioBusy && window.state.cloudAudioPosition < 0.3)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), false)
    assert.ok(Math.abs((await player.page.evaluate(() => window.state.cloudAudioPosition)) - 0.15) < 0.05)
    await player.page.evaluate(() => window.booklogAudio.toggle())
    await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
    await player.page.evaluate(() => window.booklogAudio.stop())
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Unsupported MSE and append errors use the existing file player', async () => {
  for (const options of [{ disabled: true }, { appendFailure: true }]) {
    const player = await createPlayer({ ...options, chapters: { 0: [[true]] } })
    try {
      await player.page.click('#start')
      await player.page.waitForFunction(() => window.state.cloudAudioActive === true)
      const events = await player.page.evaluate(() => JSON.parse(window.booklogAudio.exportDiagnostics()).events)
      assert.ok(events.some((entry) => entry.event === 'play' && entry.playbackMode === 'file'))
      if (options.appendFailure) assert.ok(events.some((entry) => entry.event === 'buffer-fallback'))
      assert.deepEqual(player.errors, [])
    } finally {
      await player.context.close()
    }
  }
})

test('An empty buffer waits for a delayed MP3 and resumes without replacing the source', async () => {
  const player = await createPlayer({ chapters: { 0: [[true], [true]] } })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  try {
    await player.page.route('**/audio.mp3?chunkId=audio-0-1-0', async (route) => {
      await gate
      await route.fulfill({ contentType: 'audio/mpeg', body: mp3 }).catch(() => {})
    })
    await player.page.click('#start')
    await player.page.waitForFunction(() =>
      JSON.parse(window.booklogAudio.exportDiagnostics()).events.some(
        (entry) => entry.event === 'waiting' && entry.seconds > 0.5
      )
    )
    const src = await player.page.locator('audio').getAttribute('src')
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioSession), true)
    release()
    await player.page.waitForFunction(() => window.state.cloudAudioDetail.startsWith('2 /'))
    assert.equal(await player.page.locator('audio').getAttribute('src'), src)
    const events = await bufferEvents(player.page)
    assert.equal(events.filter((entry) => entry.event === 'play-request').length, 1)
    assert.equal(events.filter((entry) => entry.event === 'ended').length, 0)
    await player.page.waitForFunction(() => !window.state.cloudAudioSession)
    await waitForSaves(player.page)
    assert.equal(player.saves.at(-1).isCompleted, 'true')
    assert.deepEqual(player.errors, [])
  } finally {
    release()
    await player.context.close()
  }
})

for (const failure of ['network', 'metadata-503', 'audio-503']) {
  test(`A transient ${failure} failure retries and continues the same buffer`, async () => {
    const player = await createPlayer({ chapters: { 0: [[true], [true]] } })
    let attempts = 0
    try {
      const pattern = failure === 'audio-503' ? '**/audio.mp3?*' : '**/api/books/audio-chunk?*'
      await player.page.route(pattern, async (route) => {
        if (failure === 'audio-503') {
          if (++attempts === 1) return route.fulfill({ status: 503, body: 'temporarily unavailable' })
          return route.fallback()
        }
        if (new URL(route.request().url()).searchParams.get('chunkIndex') === '1' && ++attempts === 1)
          return failure === 'network'
            ? route.abort('failed')
            : route.fulfill({ status: 503, json: { ok: false, message: 'temporarily unavailable' } })
        return route.fallback()
      })
      await player.page.click('#start')
      await player.page.waitForFunction(() => !window.state.cloudAudioSession)
      const events = await bufferEvents(player.page)
      assert.ok(attempts >= 2)
      assert.equal(events.filter((entry) => entry.event === 'buffer-start').length, 1)
      assert.ok(events.some((entry) => entry.event === 'chunk-request-error'))
      assert.ok(!events.some((entry) => entry.event === 'session-error'))
      await waitForSaves(player.page)
      assert.equal(player.saves.at(-1).isCompleted, 'true')
      assert.deepEqual(player.errors, [])
    } finally {
      await player.context.close()
    }
  })
}

for (const reason of ['permission', 'regenerated', 'empty-parts', 'persistent-503']) {
  test(`Invalid next-chunk response (${reason}) preserves heard audio and exits without false completion`, async () => {
    const player = await createPlayer({ chapters: { 0: [[true], [true]] } })
    let attempts = 0
    try {
      await player.page.route('**/api/books/audio-chunk?*', async (route) => {
        if (new URL(route.request().url()).searchParams.get('chunkIndex') !== '1') return route.fallback()
        attempts += 1
        if (reason === 'persistent-503')
          return route.fulfill({ status: 503, json: { ok: false, message: 'temporarily unavailable' } })
        if (reason === 'permission')
          return route.fulfill({ status: 403, json: { ok: false, message: '접근 권한이 없습니다.' } })
        return route.fulfill({
          json: {
            ok: true,
            configHash: reason === 'regenerated' ? 'new-settings' : 'settings',
            chunkCount: 2,
            chunkId: 'chunk-0-1',
            parts: [],
          },
        })
      })
      await player.page.click('#start')
      await player.page.waitForFunction(() => !window.state.cloudAudioSession)
      await waitForSaves(player.page)
      const events = await bufferEvents(player.page)
      assert.ok(events.some((entry) => entry.event === 'play'))
      assert.ok(events.some((entry) => entry.event === 'buffer-end' && entry.details.reason === 'error'))
      assert.ok(events.some((entry) => entry.event === 'session-error'))
      assert.ok(player.saves.every((save) => save.isCompleted === 'false'))
      assert.ok(Number(player.saves.at(-1).seconds) > 0.6)
      assert.ok((await player.page.evaluate(() => window.state.cloudAudioMessage)).length > 0)
      assert.equal(attempts, reason === 'persistent-503' ? 3 : 1)
      assert.deepEqual(player.errors, [])
    } finally {
      await player.context.close()
    }
  })
}

test('Media Session pause, resume, seek and chapter commands preserve playback state', async () => {
  const player = await createPlayer({ segmentSeconds: 90, chapters: { 0: [[true], [true]], 2: [[true]] } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive)
    const src = await player.page.locator('audio').getAttribute('src')
    await player.page.evaluate(() => window.testMediaActions.pause())
    await player.page.waitForFunction(() => !window.state.cloudAudioActive)
    await player.page.evaluate(() => window.testMediaActions.seekto({ seekTime: 35 }))
    await player.page.waitForFunction(() => Math.abs(window.state.cloudAudioPosition - 35) < 0.1)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), false)
    assert.equal(await player.page.locator('audio').getAttribute('src'), src)
    await player.page.evaluate(() => window.testMediaActions.play())
    await player.page.waitForFunction(() => window.state.cloudAudioActive)
    await player.page.evaluate(() => window.testMediaActions.nexttrack())
    await player.page.waitForFunction(
      () => window.state.cloudAudioChapter === 'chapter 2' && window.state.cloudAudioActive
    )
    await player.page.evaluate(() => window.testMediaActions.pause())
    await player.page.waitForFunction(() => !window.state.cloudAudioActive)
    await player.page.evaluate(() => window.testMediaActions.previoustrack())
    await player.page.waitForFunction(
      () => !window.state.cloudAudioBusy && window.state.cloudAudioChapter === 'chapter 0'
    )
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), false)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Seeking during an old prefetch never lets its late result overwrite the new chapter', async () => {
  const player = await createPlayer({ chapters: { 0: [[true], [true]], 2: [[true, true, true]] } })
  let release
  let reached
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const requested = new Promise((resolve) => {
    reached = resolve
  })
  try {
    await player.page.route('**/audio.mp3?chunkId=audio-0-1-0', async (route) => {
      reached()
      await gate
      await route.fulfill({ contentType: 'audio/mpeg', body: mp3 }).catch(() => {})
    })
    await player.page.click('#start')
    await requested
    await player.page.evaluate(() => window.booklogAudio.moveChapter(1))
    await player.page.waitForFunction(
      () => window.state.cloudAudioChapter === 'chapter 2' && window.state.cloudAudioActive
    )
    const src = await player.page.locator('audio').getAttribute('src')
    release()
    await player.page.waitForFunction(() => window.state.cloudAudioDetail.includes('조각 2'))
    assert.equal(await player.page.locator('audio').getAttribute('src'), src)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioChapter), 'chapter 2')
    assert.deepEqual(player.errors, [])
  } finally {
    release()
    await player.context.close()
  }
})

test('Saving failures keep a local outbox and a fresh player flushes it before resuming', async () => {
  const player = await createPlayer({ segmentSeconds: 90, persistProgress: true, chapters: { 0: [[true], [true]] } })
  try {
    player.server.failSaves = true
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive)
    await player.page.evaluate(() => {
      window.booklogAudio.toggle()
      window.booklogAudio.seekTo(24)
    })
    await player.page.waitForFunction(() => window.state.cloudAudioMessage.includes('저장'))
    await player.page.evaluate(() => window.booklogAudio.stop())
    const pending = await player.page.evaluate(() =>
      JSON.parse(localStorage.getItem('booklog-audio-pending:buffer-test'))
    )
    assert.ok(Object.values(pending).some((snapshot) => Number(snapshot.fields.seconds) >= 24))
    player.server.failSaves = false
    await player.page.reload()
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioActive && window.state.cloudAudioPosition >= 24)
    assert.ok((await player.page.evaluate(() => window.state.cloudAudioPosition)) < 25)
    await player.page.evaluate(() => window.booklogAudio.stop())
    await waitForSaves(player.page)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Repeated start and stop releases every object URL and cannot restart after stopping', async () => {
  const player = await createPlayer({ recording: false, segmentSeconds: 90 })
  try {
    for (let index = 0; index < 12; index += 1) {
      await player.page.click('#start')
      await player.page.waitForFunction(() => window.state.cloudAudioActive)
      await player.page.evaluate(() => window.booklogAudio.stop())
      assert.equal(await player.page.evaluate(() => window.testLiveUrls.length), 0)
      assert.equal(await player.page.locator('audio').getAttribute('src'), null)
    }
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioSession), false)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Two hours of accelerated playback cycles keep downloads, buffers and position mapping bounded', async () => {
  const player = await createPlayer({
    recording: false,
    segmentSeconds: 120,
    chapters: { 0: Array.from({ length: 100 }, () => [true]) },
  })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(
      () => document.querySelector('audio').buffered.length && document.querySelector('audio').buffered.end(0) >= 239
    )
    await player.page.evaluate(() => window.booklogAudio.toggle())
    const src = await player.page.locator('audio').getAttribute('src')
    for (let index = 1; index <= 60; index += 1) {
      const target = index * player.segmentDuration + 1
      await player.page.evaluate((seconds) => {
        document.querySelector('audio').currentTime = seconds
      }, target)
      await player.page.waitForFunction((seconds) => {
        const audio = document.querySelector('audio')
        return (
          audio.buffered.length > 0
          && audio.buffered.start(0) >= seconds - 31
          && audio.buffered.end(audio.buffered.length - 1) >= seconds + 120
        )
      }, target)
      assert.ok(Math.abs((await player.page.evaluate(() => window.state.cloudAudioPosition)) - target) < 0.1)
      assert.equal(await player.page.locator('audio').getAttribute('src'), src)
      assert.equal(await player.page.evaluate(() => window.testLiveUrls.length), 1)
    }
    assert.ok(player.requests.length < 65, String(player.requests.length))
    assert.ok(
      await player.page.evaluate(() => {
        const ranges = document.querySelector('audio').buffered
        return ranges.end(ranges.length - 1) - ranges.start(0) < 280
      })
    )
    assert.ok(
      await player.page.evaluate(async () => (await (await caches.open('booklog-audio-v3')).keys()).length <= 16)
    )
    await player.page.evaluate(() => window.booklogAudio.stop())
    await waitForSaves(player.page)
    assert.equal(player.saves.at(-1).chunkId, 'chunk-0-60')
    assert.ok(Math.abs(Number(player.saves.at(-1).seconds) - 1) < 0.1)
    assert.equal(await player.page.evaluate(() => window.testLiveUrls.length), 0)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('An append failure after crossing a chunk boundary falls back at the current local position', async () => {
  const player = await createPlayer({ segmentSeconds: 90, chapters: { 0: Array.from({ length: 6 }, () => [true]) } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(
      () =>
        JSON.parse(window.booklogAudio.exportDiagnostics()).events.filter((entry) => entry.event === 'buffer-append')
          .length === 2
    )
    await player.page.evaluate(() => {
      SourceBuffer.prototype.appendBuffer = function () {
        throw new DOMException('test midstream quota', 'QuotaExceededError')
      }
      document.querySelector('audio').currentTime = 120
    })
    await player.page.waitForFunction(() =>
      JSON.parse(window.booklogAudio.exportDiagnostics()).events.some(
        (entry) => entry.event === 'play' && entry.playbackMode === 'file'
      )
    )
    // play 이벤트가 메타데이터의 위치 복원보다 먼저 올 수 있어 탐색 완료까지 기다립니다.
    await player.page.waitForFunction(() => {
      const audio = document.querySelector('audio')
      return audio.readyState >= 2 && !audio.seeking && audio.currentTime >= 29
    })
    assert.ok((await player.page.evaluate(() => window.state.cloudAudioPosition)) >= 119.9)
    assert.ok((await player.page.evaluate(() => window.state.cloudAudioPosition)) < 122)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), true)
    assert.match(await player.page.evaluate(() => window.state.cloudAudioDetail), /^2 \/ 6/)
    await player.page.evaluate(() => window.booklogAudio.stop())
    await waitForSaves(player.page)
    assert.equal(player.saves.at(-1).chunkId, 'chunk-0-1')
    assert.ok(Number(player.saves.at(-1).seconds) > 29 && Number(player.saves.at(-1).seconds) < 32)
    assert.equal(await player.page.evaluate(() => window.testLiveUrls.length), 0)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Autoplay rejection leaves a prepared buffer paused and a manual play uses the same source', async () => {
  const player = await createPlayer({ segmentSeconds: 90, chapters: { 0: [[true], [true]] } })
  try {
    await player.page.evaluate(() => {
      const play = HTMLMediaElement.prototype.play
      let rejected = false
      HTMLMediaElement.prototype.play = function () {
        if (!rejected) {
          rejected = true
          return Promise.reject(new DOMException('test autoplay blocked', 'NotAllowedError'))
        }
        return play.call(this)
      }
    })
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioMessage.includes('재생 버튼'))
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioActive), false)
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioBusy), false)
    const src = await player.page.locator('audio').getAttribute('src')
    await player.page.evaluate(() => window.booklogAudio.toggle())
    await player.page.waitForFunction(() => window.state.cloudAudioActive)
    assert.equal(await player.page.locator('audio').getAttribute('src'), src)
    assert.equal((await bufferEvents(player.page)).filter((entry) => entry.event === 'buffer-start').length, 1)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})

test('Stopping device speech ignores its late end event and leaves no audio source alive', async () => {
  const player = await createPlayer({ speech: true, chapters: { 0: [[true, false, true]] } })
  try {
    await player.page.click('#start')
    await player.page.waitForFunction(() => window.state.cloudAudioDeviceVoice)
    await player.page.evaluate(() => {
      const ended = window.testUtterances[0].onend
      window.booklogAudio.stop()
      ended()
    })
    assert.equal(await player.page.evaluate(() => window.state.cloudAudioSession), false)
    assert.equal(await player.page.locator('audio').getAttribute('src'), null)
    assert.equal(await player.page.evaluate(() => window.testLiveUrls.length), 0)
    assert.deepEqual(player.errors, [])
  } finally {
    await player.context.close()
  }
})
