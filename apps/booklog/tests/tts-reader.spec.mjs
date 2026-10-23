/* global window, document */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  audioChunkPayload,
  audioPositionInputError,
  audioProgressInputError,
  audioProgressPayload,
  badRequest,
  listHighlightsPayload,
  readForm,
} from './fake-booklog-api.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))
const { render } = require('pocketbase-ejs')
const { zipSync, strToU8 } = require('fflate')
const pagesRoot = new URL('../pb_hooks/pages/', import.meta.url)

const epub = zipSync({
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  ),
  'book.opf': strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">tts-test</dc:identifier><dc:title>낭독 테스트</dc:title><dc:language>ko</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>'
  ),
  'nav.xhtml': strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">첫 번째 챕터</a></li></ol></nav></body></html>'
  ),
  'chapter.xhtml': strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>첫 번째 챕터</title></head><body><h1>첫 번째 챕터</h1><p>책을 듣는 시간을 함께합니다.</p></body></html>'
  ),
})

// 실제 오디오 디코딩과 네이티브 플레이어를 검증하기 위한 30초 무음 WAV입니다.
const wav = Buffer.alloc(44 + 24000 * 2 * 30)
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
wav.writeUInt32LE(wav.length - 44, 40)

function renderReader(aiAudioAvailable) {
  const template = readFileSync(new URL('(reader)/books/[bookId]/read.ejs', pagesRoot), 'utf8').replace(
    /<script server>[\s\S]*?<\/script>/,
    ''
  )
  return render(template, {
    asset: (path) => path,
    env: () => '',
    bookId: 'book',
    bookFileId: 'file',
    userId: 'test-user',
    bookFileHash: 'test-hash',
    epubReaderUrl: '/test.epub',
    initialShelfStatus: 'reading',
    aiAudioAvailable,
    bookTitle: '낭독 <테스트>',
    showAudioDetail: true,
  })
}

function readerHtml(body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>[x-cloak]{display:none!important}</style><link rel="stylesheet" href="/assets/uno.min.css"><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body>'
    + body
    + '</body></html>'
  )
}

async function openReadAloudPanel(page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('section[x-data]')
        return window.Alpine && !window.Alpine.$data(root).loading
      })
    )
    .toBeTruthy()
  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).openReadAloud())
}

test('Reader without generated AI audio offers only the local audiobook', () => {
  const body = renderReader(false)
  expect(body).toContain("readAloudEngine: 'local'")
  expect(body).toContain('AI 오디오북 · 생성된 음성 없음')
  expect(body).not.toContain('reader-cloud-audio')
  expect(body).not.toContain('AI 오디오북 생성')
  const available = renderReader(true)
  expect(available).toContain("readAloudEngine: 'ai'")
  expect(available).toContain('reader-cloud-audio')
})

test('Reader plays generated AI audio and reuses it after stopping', async ({ page, browserName }) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'win32',
    'Windows Playwright WebKit rejects standalone PCM WAV playback; verify Safari on an Apple device.'
  )
  const lookups = []
  const anchors = []
  let downloads = 0
  let savedProgress = null
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const body = renderReader(true)
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub')
        return route.fulfill({ body: Buffer.from(epub), contentType: 'application/epub+zip' })
      if (url.pathname === '/api/books/audio-position') {
        const inputError = audioPositionInputError(url)
        if (inputError) return badRequest(route, inputError)
        anchors.push(url.searchParams.get('sectionIndex') + ':' + url.searchParams.get('anchor'))
        return route.fulfill({ json: { ok: true, chunkIndex: 0, seconds: 0 } })
      }
      if (url.pathname === '/api/books/audio-chunk') {
        lookups.push(
          route.request().method()
            + ':'
            + url.searchParams.get('sectionIndex')
            + ':'
            + url.searchParams.get('chunkIndex')
        )
        return route.fulfill({
          json: audioChunkPayload({
            chunkId: 'chunk0000000000',
            chunkCount: 1,
            timeline: [10],
            parts: [{ text: '첫 번째 챕터\n\n책을 듣는 시간을 함께합니다.', durationSeconds: 10 }],
          }),
        })
      }
      if (url.pathname === '/xapi/books/audio-file') {
        downloads += 1
        return route.fulfill({ body: wav, contentType: 'audio/wav' })
      }
      if (url.pathname === '/api/books/audio-progress') {
        if (route.request().method() === 'POST') {
          const form = await readForm(route)
          const inputError = audioProgressInputError(form)
          if (inputError) return badRequest(route, inputError)
          savedProgress = {
            sectionIndex: 0,
            chunkIndex: 0,
            seconds: Math.min(Number(form.get('seconds')), 10),
            isCompleted: form.get('isCompleted') === 'true',
          }
          return route.fulfill({ json: { ok: true } })
        }
        return route.fulfill({ json: audioProgressPayload(savedProgress, [10]) })
      }
      if (url.pathname === '/api/books/list-bookmarks') return route.fulfill({ json: { ok: true, bookmarks: [] } })
      if (url.pathname === '/api/books/list-highlights') {
        return route.fulfill({ json: listHighlightsPayload([], await readForm(route)) })
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, id: 'session00000001' } })
      return route.fulfill({ contentType: 'text/html', body: readerHtml(body) })
    }
  )
  await page.goto('/books/book/read')
  await openReadAloudPanel(page)
  const start = page.getByRole('button', { name: '이어 듣기', exact: true })
  await start.click()
  const player = page.locator('#reader-cloud-audio')
  await expect.poll(() => player.evaluate((audio) => audio.readyState)).toBeGreaterThan(0)
  await expect(page.getByText('1 / 1 구간')).toBeVisible()
  await expect(page.getByRole('slider', { name: '챕터 재생 위치' })).toBeVisible()
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeVisible()
  const media = await page.evaluate(() => ({
    artist: navigator.mediaSession.metadata && navigator.mediaSession.metadata.artist,
    state: navigator.mediaSession.playbackState,
  }))
  expect(media).toEqual({ artist: '낭독 <테스트>', state: 'playing' })
  const sleep = page.getByRole('button', { name: /^잠자기 타이머/ })
  await expect(sleep).toHaveText('타이머')
  await sleep.click()
  await expect(sleep).toHaveText('15분')
  await player.evaluate((audio) => {
    audio.currentTime = 5
  })
  await page.getByRole('button', { name: '정지', exact: true }).click()
  await expect(start).toContainText('부터')
  await start.click()
  await expect.poll(() => player.evaluate((audio) => audio.currentTime)).toBeGreaterThanOrEqual(4.9)
  expect(lookups.every((lookup) => lookup === 'GET:0:0')).toBe(true)
  expect(downloads).toBe(1)
  await page.getByRole('button', { name: '정지', exact: true }).click()
  await page.evaluate(async () => {
    await window.caches.delete('booklog-audio-v3')
    window.localStorage.clear()
  })
  await page.reload()
  await openReadAloudPanel(page)
  await page.getByRole('button', { name: '이어 듣기', exact: true }).click()
  await expect.poll(() => player.evaluate((audio) => audio.currentTime)).toBeGreaterThanOrEqual(4.9)
  expect(downloads).toBe(2)
  expect(lookups.every((lookup) => lookup === 'GET:0:0')).toBe(true)
  // 정지하면 이어 들을 위치를 서버에서 다시 받아 표시하므로, 그 값이 반영된 뒤에 긴 챕터명을 넣어야 덮이지 않습니다.
  const resumePreview = page.waitForResponse(
    (response) => response.url().includes('/api/books/audio-progress') && response.request().method() === 'GET'
  )
  await page.getByRole('button', { name: '정지', exact: true }).click()
  const { progress } = await (await resumePreview).json()
  const previewLabel = await page.evaluate(
    (seconds) => window.booklogAudio.formatTime(seconds) + '부터',
    progress.chapterSeconds || 0
  )
  await expect
    .poll(() =>
      page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).cloudAudioResumeLabel)
    )
    .toBe(previewLabel)
  await expect(page.getByRole('button', { name: '현재 챕터 처음부터' })).toBeHidden()
  const viewport = page.viewportSize()
  await page.setViewportSize({ width: 400, height: 700 })
  const resumeTime = page.getByRole('button', { name: '이어 듣기', exact: true }).getByText('0:57부터')
  await page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('section[x-data]'))
    data.cloudAudioResumeChapter = '내게 친절하지 않은 사람에게 친절하지 않을 것'
    data.cloudAudioResumeLabel = '0:57부터'
  })
  await expect(resumeTime).toBeVisible()
  expect(await resumeTime.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.setViewportSize(viewport)
  await page.getByRole('button', { name: '지금 보는 곳부터 듣기' }).click()
  await expect.poll(() => anchors.length).toBe(1)
  expect(anchors[0]).toMatch(/^0:.*책을 듣는 시간을 함께합니다/)
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  await expect(page.getByText('1 / 1 구간')).toBeVisible()
  await page.getByRole('button', { name: '듣는 곳으로 이동' }).click()
  await expect(page.getByRole('heading', { name: '읽어주기' })).toBeHidden()
  await expect(
    page.getByRole('button', { name: '듣는 곳으로 이동' }),
    'the mini player offers the same move'
  ).toBeEnabled()
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  const miniPause = page.getByRole('button', { name: 'AI 오디오북 일시 정지' })
  await expect(miniPause).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI 오디오북 조작 열기' })).toContainText('첫 번째 챕터')
  await miniPause.click()
  await expect.poll(() => player.evaluate((audio) => audio.paused)).toBe(true)
  await expect(page.getByRole('button', { name: 'AI 오디오북 재생' })).toBeVisible()
  await page.getByRole('button', { name: 'AI 오디오북 조작 열기' }).click()
  await expect(page.getByRole('button', { name: '듣는 곳으로 이동' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI 오디오북 재생' })).toBeHidden()
  expect(errors).toEqual([])
})

test('Seeking while paused keeps the audiobook paused, and device voice resumes from the paused sentence', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'win32',
    'Windows Playwright WebKit rejects standalone PCM WAV playback; verify Safari on an Apple device.'
  )
  const errors = []
  const saves = []
  page.on('pageerror', (error) => errors.push(error.message))
  // 기기 음성은 브라우저마다 소리가 달라, 읽으려고 넘긴 문장과 멈춤·재개 호출만 기록하는 대역으로 바꿉니다.
  await page.addInitScript(() => {
    const record = { spoken: [], pauses: 0, resumes: 0 }
    window.__speech = record
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speaking: false,
        paused: false,
        pending: false,
        getVoices: () => [],
        speak: (utterance) => record.spoken.push(utterance.text),
        cancel: () => {},
        pause: () => {
          record.pauses += 1
        },
        resume: () => {
          record.resumes += 1
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })
    window.SpeechSynthesisUtterance = function (text) {
      this.text = text
    }
  })
  const chunks = [
    {
      chunkId: 'chunk0000000000',
      parts: [
        { text: '첫 조각', durationSeconds: 10 },
        { text: '첫 문장입니다.\n둘째 문장입니다.', durationSeconds: 10, ready: false },
      ],
    },
    { chunkId: 'chunk0000000001', parts: [{ text: '둘째 구간', durationSeconds: 10 }] },
  ]
  const body = renderReader(true)
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub')
        return route.fulfill({ body: Buffer.from(epub), contentType: 'application/epub+zip' })
      if (url.pathname === '/api/books/audio-chunk') {
        const chunk = chunks[Number(url.searchParams.get('chunkIndex'))]
        return route.fulfill({ json: audioChunkPayload({ ...chunk, chunkCount: 2, timeline: [20, 10] }) })
      }
      if (url.pathname === '/xapi/books/audio-file') return route.fulfill({ body: wav, contentType: 'audio/wav' })
      if (url.pathname === '/api/books/audio-progress') {
        if (route.request().method() === 'POST') {
          const form = await readForm(route)
          const inputError = audioProgressInputError(form)
          if (inputError) return badRequest(route, inputError)
          saves.push({ chunkId: form.get('chunkId'), seconds: Number(form.get('seconds')) })
          return route.fulfill({ json: { ok: true } })
        }
        return route.fulfill({ json: audioProgressPayload(null, [20, 10]) })
      }
      if (url.pathname === '/api/books/list-bookmarks') return route.fulfill({ json: { ok: true, bookmarks: [] } })
      if (url.pathname === '/api/books/list-highlights') {
        return route.fulfill({ json: listHighlightsPayload([], await readForm(route)) })
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, id: 'session00000001' } })
      return route.fulfill({ contentType: 'text/html', body: readerHtml(body) })
    }
  )
  const state = () =>
    page.evaluate(() => {
      const data = window.Alpine.$data(document.querySelector('section[x-data]'))
      return {
        active: data.cloudAudioActive,
        busy: data.cloudAudioBusy,
        deviceVoice: data.cloudAudioDeviceVoice,
        position: data.cloudAudioPosition,
        spoken: window.__speech.spoken.slice(),
      }
    })
  const player = page.locator('#reader-cloud-audio')
  const toggle = page.getByRole('button', { name: /^(재생|일시 정지)$/ })

  await page.goto('/books/book/read')
  await openReadAloudPanel(page)
  await page.getByRole('button', { name: '이어 듣기', exact: true }).click()
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  await page.getByRole('button', { name: '일시 정지', exact: true }).click()
  await expect.poll(() => player.evaluate((audio) => audio.paused)).toBe(true)
  await expect(toggle).toHaveAccessibleName('재생')

  await page.evaluate(() => window.booklogAudio.seekTo(15))
  await expect.poll(async () => (await state()).deviceVoice).toBe(true)
  let current = await state()
  expect(current.active, 'moving onto a device-voice part while paused does not start speaking').toBe(false)
  expect(current.spoken).toEqual([])
  expect(current.position, 'the position lands on the sentence that covers 15s').toBeGreaterThan(14)
  expect(current.position).toBeLessThan(15)
  await expect(toggle).toHaveAccessibleName('재생')
  await expect.poll(() => saves.length, 'the moved position is saved even without playing').toBeGreaterThan(0)

  await page.evaluate(() => window.booklogAudio.seekTo(3))
  await expect.poll(async () => (await state()).deviceVoice).toBe(false)
  await expect.poll(() => player.evaluate((audio) => audio.currentTime)).toBeGreaterThanOrEqual(2.9)
  expect(await player.evaluate((audio) => audio.paused), 'moving back onto AI audio stays paused').toBe(true)
  expect((await state()).active).toBe(false)

  await page.evaluate(() => window.booklogAudio.seekTo(25))
  await expect.poll(async () => (await state()).busy).toBe(false)
  await expect.poll(() => player.evaluate((audio) => audio.currentTime)).toBeGreaterThanOrEqual(4.9)
  expect(await player.evaluate((audio) => audio.paused), 'moving to another chunk stays paused').toBe(true)
  expect(saves.at(-1).chunkId).toBe('chunk0000000001')

  await toggle.click()
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  await expect(toggle).toHaveAccessibleName('일시 정지')
  await page.evaluate(() => window.booklogAudio.seekTo(15))
  await expect
    .poll(async () => (await state()).spoken, 'seeking while playing keeps playing')
    .toEqual(['둘째 문장입니다.'])
  expect((await state()).active).toBe(true)

  await toggle.click()
  current = await state()
  expect(current.active).toBe(false)
  expect(await page.evaluate(() => window.__speech.pauses)).toBe(1)
  await toggle.click()
  current = await state()
  expect(current.active).toBe(true)
  expect(current.spoken, 'resuming re-speaks the paused sentence instead of relying on resume()').toEqual([
    '둘째 문장입니다.',
    '둘째 문장입니다.',
  ])
  expect(errors).toEqual([])
})

test('A playback speed change applies to the voice playing now and stays for the next part', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'win32',
    'Windows Playwright WebKit rejects standalone PCM WAV playback; verify Safari on an Apple device.'
  )
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const chunk = {
    chunkId: 'chunk0000000000',
    chunkCount: 1,
    timeline: [20],
    parts: [
      { text: '첫 조각', durationSeconds: 10 },
      { text: '둘째 조각', durationSeconds: 10 },
    ],
  }
  const body = renderReader(true)
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub')
        return route.fulfill({ body: Buffer.from(epub), contentType: 'application/epub+zip' })
      if (url.pathname === '/api/books/audio-chunk') return route.fulfill({ json: audioChunkPayload(chunk) })
      if (url.pathname === '/xapi/books/audio-file') return route.fulfill({ body: wav, contentType: 'audio/wav' })
      if (url.pathname === '/api/books/audio-progress') {
        if (route.request().method() === 'POST') {
          const inputError = audioProgressInputError(await readForm(route))
          return inputError ? badRequest(route, inputError) : route.fulfill({ json: { ok: true } })
        }
        return route.fulfill({ json: audioProgressPayload(null, chunk.timeline) })
      }
      if (url.pathname === '/api/books/list-bookmarks') return route.fulfill({ json: { ok: true, bookmarks: [] } })
      if (url.pathname === '/api/books/list-highlights') {
        return route.fulfill({ json: listHighlightsPayload([], await readForm(route)) })
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, id: 'session00000001' } })
      return route.fulfill({ contentType: 'text/html', body: readerHtml(body) })
    }
  )
  const player = page.locator('#reader-cloud-audio')
  const rate = () => player.evaluate((audio) => audio.playbackRate)
  const speed = page.getByRole('button', { name: '재생 속도' })

  await page.goto('/books/book/read')
  await openReadAloudPanel(page)
  await page.getByRole('button', { name: '이어 듣기', exact: true }).click()
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeVisible()
  expect(await rate()).toBe(1)

  await speed.click()
  await expect(speed).toHaveText('1.2x')
  await expect.poll(rate, 'the voice playing now speeds up at once').toBe(1.2)
  const firstSource = await player.evaluate((audio) => audio.src)

  await page.evaluate(() => window.booklogAudio.seekTo(15))
  await expect.poll(() => player.evaluate((audio) => audio.src)).not.toBe(firstSource)
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  expect(await rate(), 'the next part keeps the chosen speed').toBe(1.2)
  expect(errors).toEqual([])
})
