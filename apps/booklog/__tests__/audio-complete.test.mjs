/* global window, document, HTMLMediaElement */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { chromium, webkit } from '@playwright/test'

const source = readFileSync(new URL('../pb_hooks/pages/assets/booklog-audio.js', import.meta.url), 'utf8')
let browser
before(async () => {
  const engine = process.env.BOOKLOG_AUDIO_BROWSER || 'chrome'
  assert.ok(['chrome', 'webkit'].includes(engine), 'BOOKLOG_AUDIO_BROWSER must be chrome or webkit')
  browser =
    engine === 'webkit'
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ channel: 'chrome', headless: true })
  if (engine === 'webkit') {
    const probe = await browser.newPage()
    try {
      const mp3 = Buffer.alloc(417 * 100)
      for (let i = 0; i < 100; i++) mp3.set([0xff, 0xfb, 0x90, 0x64], i * 417)
      const result = await probe.evaluate(
        (data) =>
          new Promise((resolve) => {
            const audio = document.createElement('audio')
            const timer = setTimeout(() => resolve('metadata timeout'), 5000)
            audio.onloadedmetadata = () => {
              clearTimeout(timer)
              resolve('supported')
            }
            audio.onerror = () => {
              clearTimeout(timer)
              resolve('media error ' + audio.error.code)
            }
            audio.src = 'data:audio/mpeg;base64,' + data
            audio.load()
          }),
        mp3.toString('base64')
      )
      assert.equal(
        result,
        'supported',
        'This WebKit build cannot decode the native MP3 fixture; run on an Apple media-capable environment. Result: '
          + result
      )
    } finally {
      await probe.close()
    }
  }
})
after(async () => {
  await browser?.close()
})

async function createPlayer(options = {}) {
  const frames = options.long ? 5000 : 100
  const seconds = (frames * 1152) / 44100
  const part = Buffer.alloc(frames * 417)
  for (let i = 0; i < frames; i++) part.set([0xff, 0xfb, 0x90, 0x64], i * 417)
  const mp3 = Buffer.concat([part, part, part, part])
  // 완성본의 Xing 헤더에 총 프레임·바이트 수를 담아 큰 파일의 길이를 추정에 맡기지 않습니다.
  mp3.write('Xing', 36)
  mp3.writeUInt32BE(3, 40)
  mp3.writeUInt32BE(frames * 4, 44)
  mp3.writeUInt32BE(mp3.length, 48)
  const parts = [
    { sectionIndex: 0, chunkIndex: 0, chunkId: 'chunk-0-0' },
    { sectionIndex: 0, chunkIndex: 0, chunkId: 'chunk-0-0' },
    { sectionIndex: 0, chunkIndex: 1, chunkId: 'chunk-0-1' },
    { sectionIndex: 2, chunkIndex: 0, chunkId: 'chunk-2-0' },
  ].map((item, index) => ({
    ...item,
    startSeconds: index * seconds,
    endSeconds: (index + 1) * seconds,
    text: `문장 ${index}입니다.`,
  }))
  const state = {
    manifest: { url: '/audio.mp3?v=complete-1', configHash: 'settings', parts },
    progress: options.progress || null,
    failComplete: false,
    failSaves: false,
  }
  if (options.manifest) options.manifest(state.manifest)
  const saves = [],
    requests = [],
    errors = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/audio.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      return res.end(source)
    }
    if (url.pathname === '/audio.mp3') {
      const request = { range: req.headers.range || '', cookie: req.headers.cookie || '', status: 0, start: 0, end: 0 }
      requests.push(request)
      if (!request.cookie.includes('audio-auth=allowed')) {
        request.status = 403
        return json({ ok: false }, 403)
      }
      if (state.failComplete) {
        request.status = 404
        return json({ ok: false }, 404)
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.range)
      const start = match ? Number(match[1]) : 0
      const end = match
        ? Math.min(match[2] ? Number(match[2]) : mp3.length - 1, start + 65535, mp3.length - 1)
        : mp3.length - 1
      if (start >= mp3.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${mp3.length}` })
        return res.end()
      }
      Object.assign(request, { status: match ? 206 : 200, start, end })
      res.writeHead(request.status, {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'private, no-store',
        'ETag': '"complete-1"',
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${mp3.length}` } : {}),
      })
      if (req.method === 'HEAD') return res.end()
      // 실제 소켓으로 부분 응답합니다. 긴 파일은 탐색 전에 전부 내려받지 않게 속도를 제한합니다.
      if (options.long) {
        const timer = setTimeout(() => res.end(mp3.subarray(start, end + 1)), 40)
        res.on('close', () => clearTimeout(timer))
      } else res.end(mp3.subarray(start, end + 1))
      return
    }
    if (url.pathname === '/part.mp3') {
      requests.push({ part: true })
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      return res.end(part)
    }
    if (url.pathname === '/api/books/audio-progress') {
      if (req.method === 'GET')
        return json({
          ok: true,
          configHash: 'settings',
          progress: state.progress,
          completeAudio: options.absent ? undefined : state.manifest,
        })
      const body = []
      for await (const chunk of req) body.push(chunk)
      if (state.failSaves) return json({ ok: false }, 503)
      const fields = {}
      for (const match of Buffer.concat(body)
        .toString()
        .matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g))
        fields[match[1]] = match[2]
      saves.push(fields)
      const [, section, chunk] = fields.chunkId.split('-')
      state.progress = {
        sectionIndex: Number(section),
        chunkIndex: Number(chunk),
        seconds: Number(fields.seconds),
        isCompleted: fields.isCompleted === 'true',
      }
      return json({ ok: true })
    }
    if (url.pathname === '/api/books/audio-position') return json({ ok: true, chunkIndex: 0, seconds: seconds + 0.2 })
    if (url.pathname === '/api/books/audio-chunk') {
      requests.push({ chunk: true })
      const section = Number(url.searchParams.get('sectionIndex')),
        chunk = Number(url.searchParams.get('chunkIndex'))
      return json({
        ok: true,
        configHash: 'settings',
        chunkId: `chunk-${section}-${chunk}`,
        chunkCount: section === 0 ? 2 : 1,
        chapterNumber: section === 0 ? 1 : 2,
        chapterTotal: 2,
        previousSectionIndex: section === 0 ? -1 : 0,
        nextSectionIndex: section === 0 ? 2 : -1,
        timeline: section === 0 ? [seconds * 2, seconds] : [seconds],
        parts: parts
          .filter((p) => p.sectionIndex === section && p.chunkIndex === chunk)
          .map((p) => ({ audioUrl: '/part.mp3', text: p.text, durationSeconds: seconds })),
      })
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><meta charset="utf-8"><audio id="reader-cloud-audio" preload="metadata"></audio>
      <button id="reader-audio-diagnostics-copy">copy</button><button id="start" onclick="booklogAudio.start(state,0)">start</button>
      <script>window.booklogReaderConfig={bookId:'book',bookFileId:'file',readerCacheKey:'complete-test',preferCompleteAudio:${options.disabled ? 'false' : 'true'}};
      window.booklogReaderLogic={audioChapterLabel:index=>'chapter '+index};window.state={readAloudRate:'1',cloudAudioActive:false,cloudAudioBusy:false};
      window.MediaSource=undefined;window.testBlobUrls=0;const create=URL.createObjectURL.bind(URL);URL.createObjectURL=value=>{window.testBlobUrls++;return create(value)};
      </script><script src="/audio.js"></script><script>booklogAudio.toggleDiagnostics()</script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const context = await browser.newContext()
  await context.addCookies([{ name: 'audio-auth', value: 'allowed', url: base, httpOnly: true }])
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.testMediaActions = {}
    const media = navigator.mediaSession
    if (!media) return
    const set = media.setActionHandler.bind(media)
    media.setActionHandler = (action, handler) => {
      window.testMediaActions[action] = handler
      set(action, handler)
    }
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base)
  return {
    page,
    context,
    requests,
    errors,
    saves,
    state,
    seconds,
    base,
    async close() {
      await context.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function start(player) {
  await player.page.click('#start')
  await player.page.waitForFunction(() => window.state.cloudAudioActive && !window.state.cloudAudioBusy)
}
async function flush(player) {
  await player.page.waitForFunction(
    () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:complete-test') || '{}')).length === 0
  )
}

test('A complete MP3 uses authenticated native Range playback without MSE, Blob downloads or source changes at boundaries', async () => {
  const p = await createPlayer()
  try {
    await start(p)
    const src = await p.page.locator('audio').getAttribute('src')
    assert.equal(src, p.base + '/audio.mp3?v=complete-1')
    await p.page.waitForFunction(() => window.state.cloudAudioChapter === 'chapter 2')
    assert.equal(await p.page.locator('audio').getAttribute('src'), src)
    await p.page.waitForFunction(() => !window.state.cloudAudioSession)
    await flush(p)
    assert.ok(p.requests.some((r) => r.range && r.status === 206))
    assert.ok(p.requests.filter((r) => r.range).every((r) => r.cookie.includes('audio-auth=allowed')))
    assert.ok(p.requests.every((r) => !r.chunk && !r.part))
    assert.equal(await p.page.evaluate(() => window.testBlobUrls), 0)
    assert.ok(p.saves.some((s) => s.chunkId === 'chunk-0-1' && s.isCompleted === 'true'))
    assert.ok(p.saves.some((s) => s.chunkId === 'chunk-2-0' && s.isCompleted === 'true'))
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('Native Range seeks fetch later bytes, preserve pause and speed, and map split-part and chapter positions', async (t) => {
  const p = await createPlayer({ long: true })
  try {
    await start(p)
    await p.page.evaluate(() => window.booklogAudio.toggle())
    await p.page.waitForFunction(() => !window.state.cloudAudioActive)
    const src = await p.page.locator('audio').getAttribute('src')
    assert.equal(
      src,
      p.base + '/audio.mp3?v=complete-1',
      await p.page.evaluate(() => window.booklogAudio.exportDiagnostics())
    )
    assert.ok(
      await p.page.evaluate((seconds) => {
        const ranges = document.querySelector('audio').buffered
        return !ranges.length || ranges.end(ranges.length - 1) < seconds
      }, p.seconds * 2),
      'the seek target has not already been downloaded'
    )
    const seekResponse = p.page.waitForResponse((response) => {
      const range = response.request().headers().range || ''
      return response.status() === 206 && Number(/^bytes=(\d+)-/.exec(range)?.[1]) > 1000000
    })
    await p.page.evaluate(
      (seconds) => {
        document.querySelector('audio').playbackRate = 1.4
        window.booklogAudio.seekTo(seconds)
      },
      p.seconds * 2 + 10
    )
    await p.page.waitForFunction(() => !document.querySelector('audio').seeking)
    await flush(p)
    assert.equal(p.saves.at(-1).chunkId, 'chunk-0-1')
    assert.ok(Math.abs(Number(p.saves.at(-1).seconds) - 10) < 0.1)
    await seekResponse.catch(async (error) => {
      t.diagnostic(
        JSON.stringify({
          requests: p.requests,
          media: await p.page.evaluate(() => {
            const a = document.querySelector('audio')
            return {
              time: a.currentTime,
              duration: a.duration,
              ranges: Array.from({ length: a.buffered.length }, (_, i) => [a.buffered.start(i), a.buffered.end(i)]),
            }
          }),
        })
      )
      throw error
    })
    assert.ok(p.requests.some((r) => r.status === 206 && r.start > 1000000))
    await p.page.evaluate(() => window.booklogAudio.moveChapter(1))
    await p.page.waitForFunction(() => window.state.cloudAudioChapter === 'chapter 2')
    assert.equal(await p.page.evaluate(() => document.querySelector('audio').paused), true)
    assert.equal(await p.page.evaluate(() => document.querySelector('audio').playbackRate), 1.4)
    await p.page.evaluate(() => {
      window.booklogAudio.moveChapter(-1)
      window.booklogAudio.seekTo(10)
    })
    await flush(p)
    assert.equal(p.saves.at(-1).chunkId, 'chunk-0-0')
    assert.ok(Math.abs(Number(p.saves.at(-1).seconds) - 10) < 0.1)
    assert.equal(await p.page.locator('audio').getAttribute('src'), src)
    assert.ok(p.saves.every((s) => s.isCompleted === 'false'))
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('Complete playback restores split-chunk progress and reloads from the same saved position', async () => {
  const p = await createPlayer({ progress: { sectionIndex: 0, chunkIndex: 0, seconds: 3.2 } })
  try {
    await start(p)
    assert.ok(Math.abs((await p.page.evaluate(() => window.state.cloudAudioPosition)) - 3.2) < 0.5)
    await p.page.evaluate(() => window.booklogAudio.stop())
    await flush(p)
    const saved = Number(p.saves.at(-1).seconds)
    assert.ok(saved >= 3.2 && saved < 4)
    await p.page.reload()
    await start(p)
    assert.ok(Math.abs((await p.page.evaluate(() => window.state.cloudAudioPosition)) - saved) < 0.5)
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('The chapter sleep timer stops the complete MP3 at the chapter boundary', async () => {
  const p = await createPlayer()
  try {
    await start(p)
    await p.page.evaluate(() => {
      for (let i = 0; i < 4; i++) window.booklogAudio.cycleSleepTimer()
    })
    await p.page.waitForFunction(() => !window.state.cloudAudioSession)
    await flush(p)
    assert.ok(p.saves.some((s) => s.chunkId === 'chunk-0-1' && s.isCompleted === 'true'))
    assert.ok(p.saves.every((s) => s.chunkId !== 'chunk-2-0'))
    assert.match(await p.page.evaluate(() => window.state.cloudAudioMessage), /잠자기/)
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

for (const reason of ['absent', 'disabled', 'stale', 'gap', 'bad-url', 'missing-file', 'wrong-duration']) {
  test(`An unavailable complete MP3 (${reason}) uses the existing player`, async () => {
    const p = await createPlayer({
      absent: reason === 'absent',
      disabled: reason === 'disabled',
      manifest: (m) => {
        if (reason === 'stale') m.configHash = 'old'
        if (reason === 'gap') m.parts[1].startSeconds += 0.1
        if (reason === 'bad-url') m.url = 'https://example.com/audio.mp3'
        if (reason === 'wrong-duration') m.parts.at(-1).endSeconds += 2
      },
    })
    try {
      p.state.failComplete = reason === 'missing-file'
      await start(p)
      await p.page.waitForFunction(() => document.querySelector('audio').src.startsWith('blob:'))
      assert.ok(p.requests.some((r) => r.chunk))
      assert.deepEqual(p.errors, [])
    } finally {
      await p.close()
    }
  })
}

test('Stopping before complete-file metadata arrives cannot start late audio', async () => {
  const p = await createPlayer({ long: true })
  try {
    await p.page.click('#start')
    await p.page.waitForFunction(() => document.querySelector('audio').src.includes('/audio.mp3'))
    await p.page.evaluate(() => window.booklogAudio.stop())
    await p.page.waitForTimeout(200)
    assert.equal(await p.page.evaluate(() => window.state.cloudAudioSession), false)
    assert.equal(await p.page.locator('audio').getAttribute('src'), null)
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('Complete playback supports Media Session actions and starting at the reading anchor', async () => {
  const p = await createPlayer()
  try {
    await p.page.evaluate(() => window.booklogAudio.start(window.state, 0, true, '문장'))
    await p.page.waitForFunction(() => window.state.cloudAudioActive)
    assert.ok((await p.page.evaluate(() => window.state.cloudAudioPosition)) >= p.seconds + 0.1)
    const src = await p.page.locator('audio').getAttribute('src')
    await p.page.evaluate(() => window.testMediaActions.pause())
    await p.page.waitForFunction(() => !window.state.cloudAudioActive)
    await p.page.evaluate(() => window.testMediaActions.seekto({ seekTime: 1 }))
    await flush(p)
    assert.ok(Math.abs(Number(p.saves.at(-1).seconds) - 1) < 0.1)
    await p.page.evaluate(() => window.testMediaActions.nexttrack())
    await p.page.waitForFunction(() => window.state.cloudAudioChapter === 'chapter 2')
    assert.equal(await p.page.evaluate(() => document.querySelector('audio').paused), true)
    await p.page.evaluate(() => window.testMediaActions.play())
    await p.page.waitForFunction(() => window.state.cloudAudioActive)
    assert.equal(await p.page.locator('audio').getAttribute('src'), src)
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('Native complete playback crosses part boundaries while page JavaScript cannot run', async () => {
  const p = await createPlayer()
  try {
    await start(p)
    await p.page.evaluate((seconds) => window.booklogAudio.seekTo(seconds), p.seconds - 0.2)
    await p.page.waitForFunction(() => !document.querySelector('audio').seeking)
    const result = await p.page.evaluate(() => {
      const audio = document.querySelector('audio')
      const before = audio.currentTime
      const src = audio.src
      const until = performance.now() + 3000
      while (performance.now() < until) {
        /* 재생 위치 갱신과 모든 페이지 JS 콜백을 잠시 막습니다. */
      }
      return { before, sameSource: src === audio.src, paused: audio.paused }
    })
    // currentTime은 같은 JS 작업 안에서 고정될 수 있어, 작업을 돌려준 다음 다시 읽습니다.
    const after = await p.page.evaluate(() => document.querySelector('audio').currentTime)
    assert.ok(after - result.before >= 2.5, JSON.stringify({ ...result, after }))
    assert.ok(after > p.seconds * 2)
    assert.equal(result.sameSource, true)
    assert.equal(result.paused, false)
    assert.ok(p.requests.every((r) => !r.chunk && !r.part))
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('A complete-file playback error restores the split-chunk position in the existing player', async () => {
  const p = await createPlayer({ progress: { sectionIndex: 0, chunkIndex: 0, seconds: 3.2 } })
  try {
    await start(p)
    await p.page.evaluate(() => window.booklogAudio.toggle())
    await p.page.waitForFunction(() => !window.state.cloudAudioActive)
    const before = await p.page.evaluate(() => window.state.cloudAudioPosition)
    await p.page.evaluate(() => document.querySelector('audio').dispatchEvent(new Event('error')))
    await p.page.waitForFunction(
      () => !window.state.cloudAudioBusy && document.querySelector('audio').src.startsWith('blob:')
    )
    await p.page.waitForFunction(() => document.querySelector('audio').readyState > 0)
    await flush(p)
    assert.equal(await p.page.evaluate(() => document.querySelector('audio').paused), true)
    assert.ok(Math.abs(Number(p.saves.at(-1).seconds) - before) < 0.1)
    assert.equal(p.saves.at(-1).chunkId, 'chunk-0-0')
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('Autoplay rejection keeps the complete URL ready for a manual play request', async () => {
  const p = await createPlayer()
  try {
    await p.page.evaluate(() => {
      const play = HTMLMediaElement.prototype.play
      let blocked = false
      HTMLMediaElement.prototype.play = function () {
        if (!blocked) {
          blocked = true
          return Promise.reject(new DOMException('test autoplay', 'NotAllowedError'))
        }
        return play.call(this)
      }
    })
    await p.page.click('#start')
    await p.page.waitForFunction(
      () => !window.state.cloudAudioBusy && window.state.cloudAudioMessage.includes('재생 버튼')
    )
    const src = await p.page.locator('audio').getAttribute('src')
    await p.page.evaluate(() => window.booklogAudio.toggle())
    await p.page.waitForFunction(() => window.state.cloudAudioActive)
    assert.equal(await p.page.locator('audio').getAttribute('src'), src)
    assert.ok(p.requests.every((r) => !r.chunk))
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})

test('Failed complete-file progress saves are flushed on reload before native playback resumes', async () => {
  const p = await createPlayer()
  try {
    await start(p)
    p.state.failSaves = true
    await p.page.evaluate(() => {
      window.booklogAudio.toggle()
      window.booklogAudio.seekTo(3.2)
      window.booklogAudio.stop()
    })
    await p.page.waitForFunction(
      () => Object.keys(JSON.parse(localStorage.getItem('booklog-audio-pending:complete-test') || '{}')).length > 0
    )
    p.state.failSaves = false
    await p.page.reload()
    await start(p)
    await flush(p)
    assert.ok((await p.page.evaluate(() => window.state.cloudAudioPosition)) >= 3.1)
    assert.ok(p.requests.every((r) => !r.chunk))
    assert.deepEqual(p.errors, [])
  } finally {
    await p.close()
  }
})
