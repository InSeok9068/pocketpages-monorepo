/* global window, document */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  badRequest,
  bookmarkFromForm,
  highlightFromForm,
  listHighlightsPayload,
  loadProgressPayload,
  positionFromForm,
  progressConflict,
  readForm,
  readerApiInputError,
  readingSessionPayload,
  saveProgressPayload,
} from './fake-booklog-api.mjs'

const require = createRequire(new URL('../package.json', import.meta.url))
const { render } = require('pocketbase-ejs')
const { zipSync, strToU8 } = require('fflate')
const pagesRoot = new URL('../pb_hooks/pages/', import.meta.url)
test.use({ viewport: { width: 390, height: 844 } })
test.setTimeout(120_000)

const CONFLICT_PROMPT = '다른 기기에서 읽은 위치가 있어요.'
const LOGIN_REQUIRED = '로그인이 필요합니다.'

function xhtml(body) {
  return strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>c</title></head><body>'
      + body
      + '</body></html>'
  )
}

const chapters = [1, 2, 3, 4]
const book = zipSync({
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  ),
  'book.opf': strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">sessions</dc:identifier><dc:title>두 탭</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
      + chapters
        .map((n) => '<item id="c' + n + '" href="c' + n + '.xhtml" media-type="application/xhtml+xml"/>')
        .join('')
      + '</manifest><spine>'
      + chapters.map((n) => '<itemref idref="c' + n + '"/>').join('')
      + '</spine></package>'
  ),
  'nav.xhtml': xhtml(
    '<nav epub:type="toc"><ol>'
      + chapters.map((n) => '<li><a href="c' + n + '.xhtml">' + n + '장</a></li>').join('')
      + '</ol></nav>'
  ),
  ...Object.fromEntries(
    chapters.map((n) => [
      'c' + n + '.xhtml',
      xhtml(
        '<h1>'
          + n
          + '장</h1>'
          + Array.from(
            { length: 40 },
            (_, index) =>
              '<p>' + n + '장 문단 ' + (index + 1) + '입니다. 두 곳에서 같은 책을 읽는 시험용 본문입니다.</p>'
          ).join('')
      ),
    ])
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
    userId: 'sessions-user',
    bookFileHash: 'sessions-hash',
    epubReaderUrl: '/test.epub',
    initialShelfStatus: 'reading',
    aiAudioAvailable: false,
    bookTitle: '두 탭',
    showAudioDetail: false,
  }
)

function pageLabel(route, pages) {
  try {
    const page = route.request().frame().page()
    return Object.keys(pages).find((name) => pages[name] === page) || ''
  } catch {
    return ''
  }
}

// 탭 여러 개가 한 서버를 함께 쓰도록, 브라우저 컨텍스트 단위로 가짜 서버를 하나만 둡니다.
async function mockServer(context, pages) {
  const state = {
    requests: [],
    bookmarks: [],
    highlights: [],
    serverPosition: null,
    loggedOut: false,
    saveGate: Promise.resolve(),
  }
  await context.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub') {
        return route.fulfill({ body: Buffer.from(book), contentType: 'application/epub+zip' })
      }
      if (url.pathname.startsWith('/api/')) {
        const form = route.request().method() === 'POST' ? await readForm(route) : new FormData()
        const entry = { tab: pageLabel(route, pages), path: url.pathname, form: Object.fromEntries(form.entries()) }
        state.requests.push(entry)
        // +middleware.js는 로그인이 풀린 api 요청에 화면 이동 없이 401 JSON을 돌려줍니다.
        if (state.loggedOut) {
          entry.status = 401
          return route.fulfill({ status: 401, json: { ok: false, message: LOGIN_REQUIRED } })
        }
        const inputError = readerApiInputError(url.pathname, form)
        if (inputError) {
          entry.status = 400
          return badRequest(route, inputError)
        }
        if (url.pathname === '/api/books/load-progress') {
          return route.fulfill({ json: loadProgressPayload(state.serverPosition) })
        }
        if (url.pathname === '/api/books/save-progress') {
          await state.saveGate
          const conflict = progressConflict(state.serverPosition, form)
          if (conflict) {
            entry.status = 409
            return route.fulfill({ status: 409, json: conflict })
          }
          state.serverPosition = positionFromForm(form)
          entry.status = 200
          return route.fulfill({ json: saveProgressPayload() })
        }
        if (url.pathname === '/api/books/list-bookmarks') {
          return route.fulfill({ json: { ok: true, bookmarks: state.bookmarks } })
        }
        if (url.pathname === '/api/books/save-bookmark') {
          const bookmark = bookmarkFromForm('bookmark' + (state.bookmarks.length + 1), form)
          state.bookmarks.unshift(bookmark)
          return route.fulfill({ json: { ok: true, message: '책갈피를 저장했습니다.', bookmark } })
        }
        if (url.pathname === '/api/books/list-highlights') {
          return route.fulfill({ json: listHighlightsPayload(state.highlights, form) })
        }
        if (url.pathname === '/api/books/save-highlight') {
          const highlight = highlightFromForm('highlight' + (state.highlights.length + 1), form)
          state.highlights.unshift(highlight)
          return route.fulfill({ json: { ok: true, message: '인상 깊은 문구를 저장했습니다.', id: highlight.id } })
        }
        if (url.pathname === '/api/books/save-reading-session') {
          return route.fulfill({ json: readingSessionPayload(form) })
        }
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[x-cloak]{display:none!important}</style><link rel="stylesheet" href="/assets/uno.min.css"><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body class="m-0">'
          + readerBody
          + '</body></html>',
      })
    }
  )
  return state
}

async function openReader(page) {
  await page.goto('/books/book/read')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('section[x-data]')
        return !!(window.Alpine && root && !window.Alpine.$data(root).loading)
      })
    )
    .toBe(true)
  await page.waitForTimeout(500)
}

async function goToChapter(page, chapter) {
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '목차', exact: true }).click()
  await page.locator('#reader-toc-scroll button', { hasText: new RegExp('^\\s*' + chapter + '장\\s*$') }).click()
  await expect(page.locator('#reader-toc-scroll')).toBeHidden()
}

function scrollReader(page, pixels) {
  return page.evaluate((pixels) => document.querySelector('#epub-reader .epub-container').scrollBy(0, pixels), pixels)
}

function setScreen(page, visibility) {
  return page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, visibility)
}

function saves(state, tab) {
  return state.requests.filter((request) => request.path === '/api/books/save-progress' && request.tab === tab)
}

test('Two tabs on the same book ask about the other place once each instead of fighting over it', async ({ page }) => {
  const errors = []
  const context = page.context()
  const tabB = await context.newPage()
  const pages = { A: page, B: tabB }
  for (const tab of Object.values(pages)) tab.on('pageerror', (error) => errors.push(error.message))
  const state = await mockServer(context, pages)
  await openReader(page)
  await expect.poll(() => saves(state, 'A').some((save) => save.status === 200), { timeout: 12_000 }).toBe(true)
  await openReader(tabB)

  await goToChapter(page, 3)
  await expect
    .poll(() => String(state.serverPosition && state.serverPosition.locator), { timeout: 12_000 })
    .toMatch(/^epubcfi\(\/6\/6!/)
  const placeA = state.serverPosition.locator

  await scrollReader(tabB, 400)
  await expect(tabB.getByText(CONFLICT_PROMPT)).toBeVisible({ timeout: 12_000 })
  await expect(page.getByText(CONFLICT_PROMPT)).toBeHidden()
  expect(state.serverPosition.locator, 'the other tab did not overwrite the newer place').toBe(placeA)

  // 아무것도 고르지 않고 두면 저장을 계속 다시 보내지 않아야 합니다.
  const asked = saves(state, 'B').length
  await tabB.waitForTimeout(12_000)
  expect(saves(state, 'B').length, 'no repeated rejected saves while the question is open').toBe(asked)

  await tabB.getByRole('button', { name: '여기서 계속 읽기' }).click()
  await expect(tabB.getByText(CONFLICT_PROMPT)).toBeHidden()
  await expect.poll(() => saves(state, 'B').at(-1).status).toBe(200)
  const placeB = state.serverPosition.locator
  expect(placeB).not.toBe(placeA)

  // 가만히 있던 탭은 서버 위치가 바뀌었다는 이유만으로 저장하거나 묻지 않습니다.
  const quietA = saves(state, 'A').length
  await page.waitForTimeout(7_000)
  expect(saves(state, 'A').length).toBe(quietA)
  await expect(page.getByText(CONFLICT_PROMPT)).toBeHidden()

  // 화면을 떠나는 탭이 옮기지 않은 위치로 다른 탭의 최신 위치를 덮지 않습니다.
  await setScreen(page, 'hidden')
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(1_000)
  expect(state.serverPosition.locator, 'leaving an untouched tab keeps the other tab’s place').toBe(placeB)
  await setScreen(page, 'visible')

  // 그 탭에서 다시 읽기 시작하면 한 번만 묻고, 고르면 그 위치로 맞춰집니다.
  await scrollReader(page, 400)
  await expect(page.getByText(CONFLICT_PROMPT)).toBeVisible({ timeout: 12_000 })
  const askedA = saves(state, 'A').length
  await page.waitForTimeout(7_000)
  expect(saves(state, 'A').length).toBe(askedA)
  await page.getByRole('button', { name: '그 위치로 이동' }).click()
  await expect(page.getByText(CONFLICT_PROMPT)).toBeHidden()
  await page.waitForTimeout(6_000)
  expect(state.serverPosition.locator, 'moving to the other place does not save back over it').toBe(placeB)
  await expect(tabB.getByText(CONFLICT_PROMPT)).toBeHidden()
  expect(saves(state, 'A').filter((save) => save.status === 409).length).toBeLessThanOrEqual(1)
  expect(saves(state, 'B').filter((save) => save.status === 409).length).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})

test('After the login expires, saving a place, a bookmark or a passage tells the reader to sign in', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const state = await mockServer(page.context(), { A: page })
  await openReader(page)
  state.loggedOut = true

  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect(page.getByText(LOGIN_REQUIRED).first()).toBeVisible()

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '책갈피', exact: true }).click()
  await page.getByRole('button', { name: '현재 위치 저장' }).click()
  await expect(page.locator('p:visible', { hasText: LOGIN_REQUIRED })).toHaveCount(1)
  await page.getByRole('button', { name: '책갈피 닫기' }).click()

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '문구', exact: true }).click()
  await page.getByRole('button', { name: '문구 추가', exact: true }).click()
  await page.locator('#reader-highlight-quote').fill('로그인이 풀린 뒤 남길 문장')
  await page.getByRole('button', { name: '문구 저장' }).click()
  await expect(page.locator('p:visible', { hasText: LOGIN_REQUIRED })).toHaveCount(1)
  await expect(page.locator('#reader-highlight-quote')).toHaveValue('로그인이 풀린 뒤 남길 문장')

  expect(state.requests.filter((request) => request.status === 401).length).toBeGreaterThanOrEqual(3)
  expect(errors).toEqual([])
})

test('Two tabs opened together on a new book do not ask about a place that is the same as theirs', async ({ page }) => {
  const context = page.context()
  const tabB = await context.newPage()
  const state = await mockServer(context, { A: page, B: tabB })
  // 두 탭이 모두 첫 화면을 연 뒤에야 첫 저장을 처리해, 둘 다 서버에 위치가 없을 때 연 상황을 만듭니다.
  let releaseSaves = null
  state.saveGate = new Promise((resolve) => {
    releaseSaves = resolve
  })
  await openReader(page)
  await openReader(tabB)
  releaseSaves()

  await expect
    .poll(() => saves(state, 'A').length + saves(state, 'B').length, { timeout: 12_000 })
    .toBeGreaterThanOrEqual(2)
  await page.waitForTimeout(1_000)
  await expect(page.getByText(CONFLICT_PROMPT)).toBeHidden()
  await expect(tabB.getByText(CONFLICT_PROMPT)).toBeHidden()
})
