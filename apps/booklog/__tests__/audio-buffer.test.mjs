/* global window, document, SourceBuffer */
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
        const fields = {}
        for (const match of request.postData().matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)) fields[match[1]] = match[2]
        saves.push(fields)
        return json({ ok: true })
      }
      return json({ ok: true, configHash: 'settings', progress: options.progress || null })
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
      <button id="start" onclick="booklogAudio.start(state, 0)">start</button>
      <script>
        window.booklogReaderConfig = {bookId:'book',bookFileId:'file',readerCacheKey:'buffer-test'};
        window.booklogReaderLogic = {audioChapterLabel: function (index) {return 'chapter ' + index}};
        window.state = {readAloudRate:'1',cloudAudioBusy:false,cloudAudioActive:false};
      </script><script src="/audio.js"></script>`,
    })
  })
  await page.goto('http://127.0.0.1:19876/')
  return { context, page, saves, requests, errors }
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
