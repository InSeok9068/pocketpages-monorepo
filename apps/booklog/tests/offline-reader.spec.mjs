/* global window, document, indexedDB, getComputedStyle */
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const require = createRequire(new URL('../package.json', import.meta.url))
const { zipSync, strToU8 } = require('fflate')
const pagesRoot = new URL('../pb_hooks/pages/', import.meta.url)
const CACHE_KEY = 'reader1:hash1'
test.use({ viewport: { width: 390, height: 844 } })

function buildBook() {
  const chapters = [1, 2, 3]
  const chapter = (number) =>
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>'
    + number
    + '장</title></head><body><h1>'
    + number
    + '장</h1>'
    + Array.from({ length: 40 }, (_, index) => '<p>' + number + '장 ' + (index + 1) + '번째 문단입니다.</p>').join('')
    + '</body></html>'
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">offline-book</dc:identifier><dc:title>지하철에서 읽는 책</dc:title><dc:creator>오프라인 저자</dc:creator><dc:language>ko</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        + chapters
          .map(
            (number) => '<item id="c' + number + '" href="c' + number + '.xhtml" media-type="application/xhtml+xml"/>'
          )
          .join('')
        + '</manifest><spine>'
        + chapters.map((number) => '<itemref idref="c' + number + '"/>').join('')
        + '</spine></package>'
    ),
    'OPS/nav.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
        + chapters.map((number) => '<li><a href="c' + number + '.xhtml">' + number + '장</a></li>').join('')
        + '</ol></nav></body></html>'
    ),
    ...Object.fromEntries(chapters.map((number) => ['OPS/c' + number + '.xhtml', strToU8(chapter(number))])),
  })
}

async function serveOffline(page) {
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/offline.html' || url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      return route.abort('internetdisconnected')
    }
  )
}

const offlineTest = test.extend({
  workerOrigin: async ({ page }, use) => {
    const files = new Map([
      ['/offline.html', 'text/html'],
      ['/assets/booklog-offline.js', 'text/javascript'],
      ['/assets/vendor/jszip-3.10.1.min.js', 'text/javascript'],
      ['/assets/vendor/epubjs-0.3.93.min.js', 'text/javascript'],
      ['/assets/favicon.svg', 'image/svg+xml'],
    ])
    let stalled = false
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.url === '/stall') {
        stalled = true
        return response.writeHead(204).end()
      }
      if (stalled) return
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><title>Booklog</title>')
      } else if (request.url === '/worker.js' || files.has(request.url)) {
        const path = request.url === '/worker.js' ? '/assets/booklog-offline-worker.js' : request.url
        response.setHeader('Content-Type', files.get(path) || 'text/javascript')
        response.end(readFileSync(new URL(path.slice(1), pagesRoot)))
      } else {
        response.writeHead(404).end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const origin = 'http://127.0.0.1:' + server.address().port
      await page.goto(origin)
      await use(origin)
    } finally {
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
    }
  },
})

async function storeBook(page, bytes) {
  await page.evaluate(
    ({ key, data }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('booklog-reader-cache', 2)
        request.onupgradeneeded = () => {
          request.result
            .createObjectStore('epubBuffers', { keyPath: 'cacheKey' })
            .createIndex('lastOpenedAt', 'lastOpenedAt')
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const buffer = new Uint8Array(data).buffer
          const transaction = db.transaction('epubBuffers', 'readwrite')
          transaction
            .objectStore('epubBuffers')
            .put({ cacheKey: key, buffer, byteLength: buffer.byteLength, lastOpenedAt: Date.now() })
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    { key: CACHE_KEY, data: Array.from(bytes) }
  )
}

function scroller(page) {
  return page.evaluateHandle(() =>
    [...document.querySelectorAll('#epub-reader, #epub-reader .epub-container')].find(
      (element) =>
        element.scrollHeight > element.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(element).overflowY)
    )
  )
}

function chapterAtTop(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#epub-reader').getBoundingClientRect()
    const frame = [...document.querySelectorAll('#epub-reader iframe')].find((item) => {
      const box = item.getBoundingClientRect()
      return box.top <= container.top + 40 && box.bottom > container.top + 40
    })
    const heading = frame && frame.contentDocument ? frame.contentDocument.querySelector('h1') : null
    return heading ? heading.textContent : ''
  })
}

test('A device without saved books explains how to keep one, and leaves no empty cache behind', async ({ page }) => {
  await serveOffline(page)
  await page.goto('/offline.html')
  await expect(page.getByRole('status').first()).toContainText('이 기기에 저장된 책이 없습니다')
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))).not.toContain(
    'booklog-reader-cache'
  )
})

offlineTest(
  'A stalled home request does not keep the offline shelf and its scripts waiting',
  async ({ page, workerOrigin }) => {
    await page.evaluate(async () => {
      await window.navigator.serviceWorker.register('/worker.js')
      await window.navigator.serviceWorker.ready
    })
    await storeBook(page, buildBook())
    await page.request.get(workerOrigin + '/stall')

    await page.reload({ timeout: 6_000 })
    await expect(page.getByRole('button', { name: /지하철에서 읽는 책/ })).toBeVisible()
  }
)

offlineTest(
  'A saved book reads offline as one continuous scroll and reopens where reading stopped',
  async ({ page, context, workerOrigin }) => {
    await page.evaluate(async () => {
      await window.navigator.serviceWorker.register('/worker.js')
      await window.navigator.serviceWorker.ready
    })
    await storeBook(page, buildBook())
    await page.evaluate(() =>
      window.localStorage.setItem(
        'booklog:reader-settings:reader1',
        JSON.stringify({ theme: 'night', fontSizePercent: 120 })
      )
    )
    await context.setOffline(true)
    await page.goto(workerOrigin + '/library')

    const book = page.getByRole('button', { name: /지하철에서 읽는 책/ })
    await expect(book).toContainText('오프라인 저자 · 처음부터 읽기')
    await book.click()
    await expect(page.locator('#offline-loading')).toBeHidden({ timeout: 15_000 })
    await expect.poll(() => chapterAtTop(page)).toBe('1장')
    expect(
      await page
        .frameLocator('#epub-reader iframe')
        .first()
        .locator('body')
        .evaluate((body) => getComputedStyle(body).backgroundColor),
      'the theme chosen in the online reader is used'
    ).toBe('rgb(22, 22, 22)')

    const target = await scroller(page)
    for (let step = 0; step < 80 && (await chapterAtTop(page)) !== '2장'; step += 1) {
      await target.evaluate((element) => element.scrollBy(0, 300))
      await page.waitForTimeout(60)
    }
    expect(await chapterAtTop(page), 'scrolling past the first chapter flows into the next one').toBe('2장')
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(window.localStorage.getItem('booklog-offline:position:' + key) || '{}').locator || '',
          CACHE_KEY
        )
      )
      .toMatch(/^epubcfi\(\/6\/4!/)

    await expect(page.getByRole('progressbar', { name: '읽기 진행률' })).toHaveAttribute('aria-valuenow', /^[1-9]\d*$/)
    await page.getByRole('button', { name: '오프라인 서재 목록으로 돌아가기' }).click()
    await expect(page.getByRole('heading', { name: '오프라인 서재' })).toBeVisible()
    await expect(book).toContainText('이어 읽기')
    await book.click()
    await expect(page.locator('#offline-loading')).toBeHidden({ timeout: 15_000 })
    await expect.poll(() => chapterAtTop(page), { message: 'reopening returns to the second chapter' }).toBe('2장')
  }
)
