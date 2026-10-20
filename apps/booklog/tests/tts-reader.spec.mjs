/* global window, document */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

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
        anchors.push(url.searchParams.get('sectionIndex') + ':' + url.searchParams.get('anchor'))
        return route.fulfill({ json: { ok: true, chunkIndex: 0 } })
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
          json: {
            ok: true,
            chunkCount: 1,
            configHash: 'settings',
            chunkId: 'chunk-0-0',
            parts: [{ audioUrl: '/xapi/books/audio-file?chunkId=chunk-0-0', fallbackText: '', durationSeconds: 1 }],
          },
        })
      }
      if (url.pathname === '/xapi/books/audio-file') {
        downloads += 1
        return route.fulfill({ body: wav, contentType: 'audio/wav' })
      }
      if (url.pathname === '/api/books/audio-progress') {
        if (route.request().method() === 'POST') {
          const request = route.request()
          const form = await new Request(request.url(), {
            method: 'POST',
            headers: request.headers(),
            body: request.postDataBuffer(),
          }).formData()
          savedProgress = {
            sectionIndex: 0,
            chunkIndex: 0,
            seconds: Number(form.get('seconds')),
            isCompleted: form.get('isCompleted') === 'true',
          }
          return route.fulfill({ json: { ok: true } })
        }
        return route.fulfill({ json: { ok: true, configHash: 'settings', progress: savedProgress } })
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, highlights: [], bookmarks: [] } })
      return route.fulfill({ contentType: 'text/html', body: readerHtml(body) })
    }
  )
  await page.goto('/books/book/read')
  await openReadAloudPanel(page)
  const start = page.getByRole('button', { name: '이어 듣기', exact: true })
  await start.click()
  const player = page.locator('#reader-cloud-audio')
  await expect.poll(() => player.evaluate((audio) => audio.readyState)).toBeGreaterThan(0)
  await expect(page.getByRole('status')).toContainText('1 / 1 구간')
  const media = await page.evaluate(() => ({
    artist: navigator.mediaSession.metadata && navigator.mediaSession.metadata.artist,
    state: navigator.mediaSession.playbackState,
  }))
  expect(media).toEqual({ artist: '낭독 <테스트>', state: 'playing' })
  await player.evaluate((audio) => {
    audio.currentTime = 5
  })
  await page.getByRole('button', { name: '정지', exact: true }).click()
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
  await page.getByRole('button', { name: '정지', exact: true }).click()
  await page.getByRole('button', { name: '읽던 위치부터' }).click()
  await expect.poll(() => anchors.length).toBe(1)
  expect(anchors[0]).toMatch(/^0:.*책을 듣는 시간을 함께합니다/)
  await expect.poll(() => player.evaluate((audio) => !audio.paused)).toBe(true)
  await expect(page.getByRole('status')).toContainText('1 / 1 구간')
  expect(errors).toEqual([])
})
