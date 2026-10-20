/* global window, document, PageTransitionEvent */
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
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">nav-test</dc:identifier><dc:title>이동 테스트</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'
  ),
  'chapter.xhtml': strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>첫 번째 챕터</h1><p>뒤로가기 테스트 본문입니다.</p></body></html>'
  ),
})

const readerBody = render(
  readFileSync(new URL('(reader)/books/[bookId]/read.ejs', pagesRoot), 'utf8').replace(
    /<script server>[\s\S]*?<\/script>/,
    ''
  ),
  {
    asset: (path) => path,
    env: () => '',
    bookId: 'book',
    bookFileId: 'file',
    userId: 'nav-user',
    bookFileHash: 'nav-hash',
    epubReaderUrl: '/test.epub',
    initialShelfStatus: 'finished',
    aiAudioAvailable: false,
    bookTitle: '이동 테스트',
    showAudioDetail: false,
  }
)

function html(body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>[x-cloak]{display:none!important}</style><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body>'
    + body
    + '</body></html>'
  )
}

async function mockSite(page, options) {
  const requests = { detail: 0, saveProgress: 0, saveForms: [] }
  const savedHref = options && options.savedHref ? options.savedHref : ''
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub') return route.fulfill({ body: Buffer.from(epub), contentType: 'application/epub+zip' })
      if (url.pathname === '/api/books/load-progress') {
        return route.fulfill({ json: { ok: true, hasSavedPosition: !!savedHref, locator: '', href: savedHref } })
      }
      if (url.pathname === '/api/books/save-progress') {
        requests.saveProgress += 1
        const request = route.request()
        const form = await new Request(request.url(), {
          method: 'POST',
          headers: request.headers(),
          body: request.postDataBuffer(),
        }).formData()
        requests.saveForms.push({ baseLocator: form.get('baseLocator'), force: form.get('force') })
        if (options && options.conflict && form.get('force') !== 'true') {
          return route.fulfill({
            status: 409,
            json: { ok: false, conflict: true, locator: '', href: 'chapter.xhtml', chapterLabel: '다른 기기 챕터' },
          })
        }
        return route.fulfill({ json: { ok: true } })
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, id: 'session00000001' } })
      if (url.pathname === '/books/book') {
        requests.detail += 1
        if (options && options.cancelDetailNavigation) return route.fulfill({ status: 204 })
        return route.fulfill({ contentType: 'text/html', body: html('<h1>책 상세</h1><a href="/books/book/read">읽기</a>') })
      }
      return route.fulfill({ contentType: 'text/html', body: html(readerBody) })
    }
  )
  return requests
}

async function waitForReader(page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('section[x-data]')
        return !!(window.Alpine && root && !window.Alpine.$data(root).loading)
      })
    )
    .toBeTruthy()
}

test('A reader restored after leaving can save and leave again', async ({ page }) => {
  const requests = await mockSite(page, { cancelDetailNavigation: true })
  await page.goto('/books/book/read')
  await waitForReader(page)
  const clickBack = () => page.evaluate(() => document.querySelector('a[aria-label="뒤로가기"]').click())

  await clickBack()
  await expect.poll(() => requests.detail).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  const savesBeforeSecondLeave = requests.saveProgress

  await clickBack()
  await expect.poll(() => requests.detail).toBe(2)
  expect(requests.saveProgress).toBeGreaterThan(savesBeforeSecondLeave)
})

test('Browser back from a reader opened directly goes to the book detail page', async ({ page }) => {
  await mockSite(page)
  await page.goto('/books/book/read')
  await waitForReader(page)

  await page.goBack()
  await expect(page).toHaveURL(/\/books\/book$/)
  await expect(page.getByRole('heading', { name: '책 상세' })).toBeVisible()
})

test('Browser back from a reader opened from the book detail page saves and returns there', async ({ page }) => {
  const requests = await mockSite(page)
  await page.goto('/books/book')
  await page.getByRole('link', { name: '읽기' }).click()
  await waitForReader(page)
  const savesBeforeBack = requests.saveProgress

  await page.goBack()
  await expect(page).toHaveURL(/\/books\/book$/)
  await expect(page.getByRole('heading', { name: '책 상세' })).toBeVisible()
  expect(requests.saveProgress).toBeGreaterThan(savesBeforeBack)
  expect(await page.evaluate(() => window.history.length), 'returned with history.back, not a new entry').toBe(4)
})

test('A save rejected because another device moved on asks before overwriting', async ({ page }) => {
  const requests = await mockSite(page, { savedHref: 'chapter.xhtml', conflict: true })
  await page.goto('/books/book/read')
  await waitForReader(page)

  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect(page.getByText('다른 기기에서 읽은 위치가 있어요.')).toBeVisible()
  await expect(page.getByText('다른 기기 챕터 위치로 이동할까요?')).toBeVisible()
  expect(requests.saveForms.at(-1)).toEqual({ baseLocator: 'chapter.xhtml', force: null })

  await page.getByRole('button', { name: '여기서 계속 읽기' }).click()
  await expect.poll(() => requests.saveForms.at(-1).force).toBe('true')
  await expect(page.getByText('다른 기기에서 읽은 위치가 있어요.')).toBeHidden()
})

test('Leaving after another device moved on skips the stale save without asking', async ({ page }) => {
  const requests = await mockSite(page, { savedHref: 'chapter.xhtml', conflict: true })
  await page.goto('/books/book/read')
  await waitForReader(page)
  const savesBeforeLeave = requests.saveProgress

  await page.evaluate(() => document.querySelector('a[aria-label="뒤로가기"]').click())
  await expect(page).toHaveURL(/\/books\/book$/)
  expect(requests.saveProgress).toBeGreaterThan(savesBeforeLeave)
  expect(requests.saveForms.every((form) => form.force === null)).toBe(true)
})
