/* global window, document, indexedDB */
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
test.setTimeout(90_000)

const CHAPTER_COUNT = 5
const SEARCH_WORD = '은하수표지'
const SAVE_FAILURE_MESSAGE = '서버에 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'

function xhtml(body) {
  return strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>c</title></head><body>'
      + body
      + '</body></html>'
  )
}

function chapterBody(chapter) {
  const count = 40
  const paragraphs = Array.from({ length: count }, (_, index) => {
    const extra =
      chapter === 3 && index === 19
        ? ' 여기에 ' + SEARCH_WORD + '가 숨어 있습니다.'
        : chapter === 2 && index === 4
          ? ' 본문에 적힌 &lt;img src=x onerror=&quot;window.__searchXss=1&quot;&gt; 표식입니다.'
          : ''
    return (
      '<p>'
      + chapter
      + '장 문단 '
      + (index + 1)
      + '입니다. 책을 천천히 읽으며 문장을 따라가는 시험용 본문입니다.'
      + extra
      + '</p>'
    )
  }).join('')
  return '<h1>' + chapter + '장</h1>' + paragraphs
}

function buildBook(chapterCount) {
  const chapters = Array.from({ length: chapterCount }, (_, index) => index + 1)
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">features</dc:identifier><dc:title>기능 확인</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
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
    ...Object.fromEntries(chapters.map((n) => ['c' + n + '.xhtml', xhtml(chapterBody(n))])),
  })
}

const featureBook = buildBook(CHAPTER_COUNT)

function renderReaderBody(initialShelfStatus, options = {}) {
  return render(
    readFileSync(new URL('(reader)/books/[bookId]/read.ejs', pagesRoot), 'utf8').replace(
      /<script server>[\s\S]*?<\/script>/,
      ''
    ),
    {
      asset: (path) => path,
      env: () => '',
      bookId: 'book',
      bookFileId: 'file',
      userId: 'feature-user',
      bookFileHash: 'feature-hash',
      epubReaderUrl: '/test.epub',
      initialShelfStatus,
      aiAudioAvailable: false,
      bookTitle: '기능 확인',
      showAudioDetail: !!options.showAudioDetail,
    }
  )
}

const readerBody = renderReaderBody('reading')

async function mockReader(page, book, body = readerBody) {
  const state = {
    bookmarks: [],
    highlights: [],
    requests: [],
    epubDownloads: 0,
    epubStatus: 200,
    failures: new Set(),
    serverPosition: null,
    loadProgressDelay: 0,
    keepServerPosition: false,
  }
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub') {
        state.epubDownloads += 1
        if (state.epubStatus !== 200) return route.fulfill({ status: state.epubStatus, body: 'unavailable' })
        return route.fulfill({ body: Buffer.from(book), contentType: 'application/epub+zip' })
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/xapi/')) {
        const form = route.request().method() === 'POST' ? await readForm(route) : new FormData()
        state.requests.push({ path: url.pathname, form: Object.fromEntries(form.entries()) })
        if (url.pathname === '/api/books/load-progress' && state.failures.has(url.pathname)) {
          return route.abort('internetdisconnected')
        }
        if (state.failures.has(url.pathname)) return badRequest(route, SAVE_FAILURE_MESSAGE)
        if (url.pathname.startsWith('/api/books/')) {
          const inputError = readerApiInputError(url.pathname, form)
          if (inputError) {
            state.requests.at(-1).status = 400
            return badRequest(route, inputError)
          }
        }
        if (url.pathname === '/api/books/load-progress') {
          if (state.loadProgressDelay) await new Promise((resolve) => setTimeout(resolve, state.loadProgressDelay))
          return route.fulfill({ json: loadProgressPayload(state.serverPosition) })
        }
        if (url.pathname === '/api/books/save-progress') {
          const conflict = progressConflict(state.serverPosition, form)
          if (conflict) {
            state.requests.at(-1).status = 409
            return route.fulfill({ status: 409, json: conflict })
          }
          if (!state.keepServerPosition) state.serverPosition = positionFromForm(form)
          state.requests.at(-1).status = 200
          return route.fulfill({ json: saveProgressPayload() })
        }
        if (url.pathname === '/api/books/list-bookmarks')
          return route.fulfill({ json: { ok: true, bookmarks: state.bookmarks } })
        if (url.pathname === '/api/books/save-bookmark') {
          const bookmark = bookmarkFromForm('bookmark' + (state.bookmarks.length + 1), form)
          state.bookmarks.unshift(bookmark)
          return route.fulfill({ json: { ok: true, message: '책갈피를 저장했습니다.', bookmark } })
        }
        if (url.pathname === '/api/books/delete-bookmark') {
          const bookmarkId = form.get('bookmarkId')
          state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId)
          return route.fulfill({ json: { ok: true, message: '책갈피를 삭제했습니다.', id: bookmarkId } })
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
        return route.fulfill({ json: { ok: true, id: 'session00000001' } })
      }
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[x-cloak]{display:none!important}</style><link rel="stylesheet" href="/assets/uno.min.css"><link rel="stylesheet" href="/assets/style.css"><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body class="m-0">'
          + body
          + '</body></html>',
      })
    }
  )
  return state
}

async function openReader(page, book = featureBook, body = readerBody) {
  const state = await mockReader(page, book, body)
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
  return state
}

// 화면 맨 위에 걸친 문단의 글자로 지금 읽는 자리를 확인합니다.
function readingSpot(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    const top = container.getBoundingClientRect().top
    for (const frame of container.querySelectorAll('iframe')) {
      const frameTop = frame.getBoundingClientRect().top
      for (const node of frame.contentDocument?.querySelectorAll('h1, p') || []) {
        if (frameTop + node.getBoundingClientRect().bottom > top + 4) return node.textContent.trim()
      }
    }
    return ''
  })
}

function isOnScreen(page, text) {
  return page.evaluate((text) => {
    const container = document.querySelector('#epub-reader .epub-container')
    const bounds = container.getBoundingClientRect()
    for (const frame of container.querySelectorAll('iframe')) {
      const doc = frame.contentDocument
      const walker = doc ? doc.createTreeWalker(doc.body, 4) : null
      while (walker && walker.nextNode()) {
        const index = walker.currentNode.nodeValue.indexOf(text)
        if (index < 0) continue
        const range = doc.createRange()
        range.setStart(walker.currentNode, index)
        range.setEnd(walker.currentNode, index + text.length)
        const rect = range.getBoundingClientRect()
        const frameTop = frame.getBoundingClientRect().top
        return frameTop + rect.top >= bounds.top - 2 && frameTop + rect.bottom <= bounds.bottom + 2
      }
    }
    return false
  }, text)
}

function chapterOf(text) {
  return Number((String(text).match(/^(\d+)장/) || [])[1] || 0)
}

async function expectChapter(page, chapter) {
  await expect.poll(async () => chapterOf(await readingSpot(page)), { timeout: 15_000 }).toBe(chapter)
}

async function openMenuItem(page, name) {
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
}

async function goToChapter(page, chapter) {
  await openMenuItem(page, '목차')
  await page.locator('#reader-toc-scroll button', { hasText: new RegExp('^\\s*' + chapter + '장\\s*$') }).click()
  await expectChapter(page, chapter)
}

function lastRequest(state, path) {
  return state.requests.filter((request) => request.path === path).at(-1)
}

test('The menu opens over the book and closes with its close button or by tapping outside', async ({ page }) => {
  await openReader(page)
  const menu = page.getByRole('heading', { name: '메뉴', exact: true })

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await expect(menu).toBeVisible()
  await page.locator('button[aria-label="메뉴 닫기"]').last().click()
  await expect(menu).toBeHidden()

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await expect(menu).toBeVisible()
  await page.mouse.click(195, 60)
  await expect(menu).toBeHidden()
})

test('The table of contents moves to a chapter and shows it as the current position', async ({ page }) => {
  await openReader(page)
  await openMenuItem(page, '목차')
  await expect(page.locator('#reader-toc-scroll button')).toHaveCount(CHAPTER_COUNT)
  await page.locator('#reader-toc-scroll button', { hasText: /^\s*4장\s*$/ }).click()

  await expect(page.locator('#reader-toc-scroll')).toBeHidden()
  await expectChapter(page, 4)
  await openMenuItem(page, '목차')
  await expect(page.locator('p:visible', { hasText: '현재 위치: 4장' })).toHaveCount(1)
  await page.getByRole('button', { name: '목차 닫기' }).click()
  await expect(page.locator('#reader-toc-scroll')).toBeHidden()
})

test('A long table of contents opens scrolled to the current chapter', async ({ page }) => {
  await openReader(page, buildBook(40))
  await goToChapter(page, 36)
  await openMenuItem(page, '목차')
  const current = page.locator('#reader-toc-scroll button', { hasText: /^\s*36장\s*$/ })
  const first = page.locator('#reader-toc-scroll button', { hasText: /^\s*1장\s*$/ })

  await expect(current).toBeInViewport()
  await expect(first).not.toBeInViewport()
})

test('Searching the whole book lists matches and opens the chosen one', async ({ page }) => {
  await openReader(page)
  await openMenuItem(page, '검색')
  const input = page.locator('#reader-search-input')
  await expect(input).toBeFocused()
  await page.getByRole('button', { name: '검색 닫기' }).click()
  await expect(input).toBeHidden()
  await openMenuItem(page, '검색')

  await input.locator('xpath=..').getByRole('button', { name: '검색', exact: true }).click()
  await expect(page.getByText('검색어를 입력해 주세요.')).toBeVisible()

  await input.fill('없는낱말입니다')
  await input.press('Enter')
  await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible()

  await input.fill(SEARCH_WORD)
  await input.press('Enter')
  await expect(page.getByText('1개의 결과를 찾았습니다.')).toBeVisible()
  await page.getByRole('button', { name: new RegExp(SEARCH_WORD) }).click()

  await expect(input).toBeHidden()
  await expectChapter(page, 3)
  await expect.poll(() => isOnScreen(page, SEARCH_WORD)).toBe(true)
})

test('Opening the device voice panel puts the keyboard focus on the voice choice', async ({ page }) => {
  await openReader(page)
  await openMenuItem(page, '읽어주기')
  await expect(page.getByRole('heading', { name: '읽어주기' })).toBeVisible()
  const voice = page.locator('#reader-read-aloud-voice')
  test.skip(!(await voice.count()), 'This browser has no speech synthesis.')

  await expect(voice).toBeFocused()
  await page.getByRole('button', { name: '읽어주기 닫기' }).click()
  await expect(voice).toBeHidden()
})

test('Font size buttons resize the text, stay within limits, and are remembered after reload', async ({ page }) => {
  await openReader(page)
  const firstParagraph = page.frameLocator('#epub-reader iframe').first().locator('p').first()
  const fontSize = () => firstParagraph.evaluate((node) => parseFloat(window.getComputedStyle(node).fontSize))
  const base = await fontSize()

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  const larger = page.getByRole('button', { name: '글자 크기 키우기' }).first()
  const reset = page.getByRole('button', { name: '글자 크기 기본값으로 되돌리기' }).first()
  await larger.click()
  await expect(reset).toHaveText('110%')
  await expect.poll(fontSize).toBeGreaterThan(base)

  for (let step = 0; step < 4; step += 1) {
    if (await larger.isEnabled()) await larger.click()
  }
  await expect(reset).toHaveText('130%')
  await expect(larger).toBeDisabled()

  await page.reload()
  await expect.poll(fontSize, { timeout: 20_000 }).toBeGreaterThan(base)
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await expect(reset).toHaveText('130%')
  await reset.click()
  await expect(reset).toHaveText('100%')
  await expect.poll(fontSize).toBe(base)
})

test('Reading settings change the page colour, font, spacing and margins and survive a reload', async ({ page }) => {
  await openReader(page)
  const body = page.frameLocator('#epub-reader iframe').first().locator('body')
  const paragraph = page.frameLocator('#epub-reader iframe').first().locator('p').first()
  const style = () =>
    Promise.all([
      body.evaluate((node) => {
        const computed = window.getComputedStyle(node)
        return { background: computed.backgroundColor, padding: computed.paddingLeft }
      }),
      paragraph.evaluate((node) => {
        const computed = window.getComputedStyle(node)
        return {
          font: computed.fontFamily,
          lineRatio: Math.round((parseFloat(computed.lineHeight) / parseFloat(computed.fontSize)) * 100) / 100,
        }
      }),
    ]).then(([page, text]) => ({ ...page, ...text }))
  const before = await style()

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '상세 읽기 설정' }).click()
  await expect(page.getByRole('heading', { name: '읽기 설정' })).toBeVisible()
  await page.getByRole('button', { name: '밤', exact: true }).click()
  await page.getByRole('button', { name: '고딕', exact: true }).click()
  await page.getByRole('button', { name: '더 넓게', exact: true }).click()
  await page.getByRole('button', { name: '넓게', exact: true }).last().click()

  const expected = { background: 'rgb(22, 22, 22)', padding: '48px', lineRatio: 2.3 }
  await expect.poll(style).toMatchObject(expected)
  expect((await style()).font).toContain('system-ui')

  await page.getByRole('button', { name: '완료', exact: true }).click()
  await page.reload()
  await expect.poll(style, { timeout: 20_000 }).toMatchObject(expected)

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '상세 읽기 설정' }).click()
  await page.getByRole('button', { name: '기본값', exact: true }).click()
  await expect.poll(style).toEqual(before)
})

test('Progress jump stays off until the value is changed on purpose', async ({ page }) => {
  await openReader(page)
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await expect(page.getByText(/^현재 \d+%$/)).toBeVisible({ timeout: 30_000 })
  const move = page.getByRole('button', { name: '이동', exact: true })

  await expect(move).toBeDisabled()

  const percent = page.getByRole('spinbutton', { name: '이동할 진행률' })
  await percent.fill('85')
  await expect(move).toBeEnabled()
  await move.click()

  await expect.poll(async () => chapterOf(await readingSpot(page)), { timeout: 15_000 }).toBeGreaterThanOrEqual(4)
  await expect
    .poll(async () => Number(((await page.getByText(/^현재 \d+%$/).textContent()) || '').match(/\d+/)[0]))
    .toBeGreaterThan(70)
  const current = ((await page.getByText(/^현재 \d+%$/).textContent()) || '').match(/\d+/)[0]
  await percent.fill(current)
  await expect(move).toBeDisabled()
})

test('A bookmark saves the current place, returns to it from elsewhere, and can be deleted', async ({ page }) => {
  const state = await openReader(page)
  await goToChapter(page, 3)
  const spot = await readingSpot(page)

  await openMenuItem(page, '책갈피')
  await expect(page.getByText('아직 저장한 책갈피가 없습니다.')).toBeVisible()
  await page.getByRole('button', { name: '현재 위치 저장' }).click()
  await expect(page.getByText('책갈피를 저장했습니다.')).toBeVisible()
  expect(lastRequest(state, '/api/books/save-bookmark').form.locator).toMatch(/^epubcfi\(\/6\/6!/)
  await page.getByRole('button', { name: '책갈피 닫기' }).click()
  await expect(page.getByRole('button', { name: '현재 위치 저장' })).toBeHidden()

  await goToChapter(page, 1)
  await openMenuItem(page, '책갈피')
  await page.getByRole('button', { name: /3장/ }).first().click()
  await expect.poll(() => readingSpot(page), { timeout: 15_000 }).toBe(spot)

  await openMenuItem(page, '책갈피')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '책갈피 삭제' }).click()
  await expect(page.getByText('책갈피를 삭제했습니다.')).toBeVisible()
  await expect(page.getByText('아직 저장한 책갈피가 없습니다.')).toBeVisible()
  expect(lastRequest(state, '/api/books/delete-bookmark').form.bookmarkId).toBe('bookmark1')
})

test('Selecting text in the book offers to save it and marks the saved passage', async ({ page }) => {
  const state = await openReader(page)
  const paragraph = page.frameLocator('#epub-reader iframe').first().locator('p').nth(1)
  await paragraph.click({ clickCount: 3 })

  await expect(page.getByText('선택한 문구', { exact: true })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByText('선택한 문구', { exact: true })).toBeHidden()

  const saved = lastRequest(state, '/api/books/save-highlight').form
  expect(saved.quoteText.length).toBeGreaterThan(3)
  expect((await paragraph.textContent()).replace(/\s+/g, ' ')).toContain(saved.quoteText)
  expect(saved.locator).toMatch(/^epubcfi\(\/6\/2!.*,.*\)$/)
  await expect(page.locator('#epub-reader .booklog-saved-highlight')).toHaveCount(1)
})

test('A typed passage with a note is saved, listed, and opens where it was saved', async ({ page }) => {
  const state = await openReader(page)
  await goToChapter(page, 2)
  const spot = await readingSpot(page)

  await openMenuItem(page, '문구')
  await expect(page.getByText('아직 저장한 문구가 없습니다.')).toBeVisible()
  await page.getByRole('button', { name: '문구 추가' }).click()
  await page.getByRole('button', { name: '문구 저장' }).click()
  await expect(page.getByText('문구를 입력해 주세요.')).toBeVisible()
  await page.getByRole('button', { name: '문구 추가 닫기' }).click()
  await expect(page.locator('#reader-highlight-quote')).toBeHidden()
  await openMenuItem(page, '문구')
  await page.getByRole('button', { name: '문구 추가', exact: true }).click()

  await page.locator('#reader-highlight-quote').fill('천천히 읽으며 문장을 따라가는')
  await page.getByPlaceholder('짧은 생각이 있으면 같이 남겨두세요.').fill('기억할 문장')
  await page.getByRole('button', { name: '문구 저장' }).click()
  await expect(page.locator('#reader-highlight-quote')).toBeHidden()
  const saved = lastRequest(state, '/api/books/save-highlight').form
  expect(saved).toMatchObject({ quoteText: '천천히 읽으며 문장을 따라가는', noteText: '기억할 문장' })
  expect(saved.locator).toMatch(/^epubcfi\(\/6\/4!/)

  await goToChapter(page, 5)
  await openMenuItem(page, '문구')
  const item = page.getByRole('button', { name: /천천히 읽으며 문장을 따라가는/ })
  await expect(item).toContainText('기억할 문장')
  await item.click()
  await expect.poll(() => readingSpot(page), { timeout: 15_000 }).toBe(spot)
})

test('Reaching the end of the book asks once to mark it finished', async ({ page }) => {
  const state = await openReader(page)
  await goToChapter(page, CHAPTER_COUNT)
  const prompt = page.getByText('마지막까지 읽은 것 같아요.')

  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    container.scrollTop = container.scrollHeight
  })
  await expect(prompt).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '완독 처리' }).click()
  await expect(page.getByText('완독으로 표시했습니다.')).toBeVisible()
  expect(lastRequest(state, '/xapi/books/update-status').form).toMatchObject({ bookId: 'book', status: 'finished' })
  await expect(prompt).toBeHidden()

  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    container.scrollTop -= 400
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    container.scrollTop = container.scrollHeight
  })
  await page.waitForTimeout(2500)
  await expect(prompt).toBeHidden()
})

test('Center panels close when the dimmed area outside them is tapped, but not after dragging out from inside', async ({
  page,
}) => {
  await openReader(page)
  const outside = () => page.mouse.click(195, 16)
  const panels = [
    { open: () => openMenuItem(page, '검색'), heading: '책 전체 검색' },
    { open: () => openMenuItem(page, '목차'), heading: '목차' },
    { open: () => openMenuItem(page, '책갈피'), heading: '책갈피' },
    { open: () => openMenuItem(page, '문구'), heading: '문구' },
    { open: () => openMenuItem(page, '읽어주기'), heading: '읽어주기' },
    {
      open: async () => {
        await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
        await page.getByRole('button', { name: '상세 읽기 설정' }).click()
      },
      heading: '읽기 설정',
    },
    {
      open: async () => {
        await openMenuItem(page, '문구')
        await page.getByRole('button', { name: '문구 추가', exact: true }).click()
      },
      heading: '인상 깊은 문구 추가',
    },
  ]

  for (const panel of panels) {
    const heading = page.getByRole('heading', { name: panel.heading, exact: true })
    await panel.open()
    await expect(heading).toBeVisible()
    await outside()
    await expect(heading, panel.heading + ' closes from outside').toBeHidden()
  }

  await openMenuItem(page, '검색')
  const input = page.locator('#reader-search-input')
  const box = await input.boundingBox()
  await page.mouse.move(box.x + 10, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(195, 16, { steps: 4 })
  await page.mouse.up()
  await expect(input, 'a drag that started inside keeps the panel open').toBeVisible()
})

async function waitUntilLoaded(page) {
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

function countCachedBooks(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('booklog-reader-cache')
        request.onerror = () => resolve(0)
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('epubBuffers')) {
            db.close()
            resolve(0)
            return
          }
          const count = db.transaction('epubBuffers').objectStore('epubBuffers').count()
          count.onsuccess = () => {
            db.close()
            resolve(count.result)
          }
          count.onerror = () => {
            db.close()
            resolve(0)
          }
        }
      })
  )
}

async function selectSecondParagraph(page) {
  await page.frameLocator('#epub-reader iframe').first().locator('p').nth(1).click({ clickCount: 3 })
  await expect(page.getByText('선택한 문구', { exact: true })).toBeVisible({ timeout: 10_000 })
}

test('Saved highlights are drawn again when the book is reopened', async ({ page }) => {
  const state = await openReader(page)
  await selectSecondParagraph(page)
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.locator('#epub-reader .booklog-saved-highlight')).toHaveCount(1)

  const requestsBeforeReload = state.requests.length
  await page.reload()
  await waitUntilLoaded(page)

  await expect(page.locator('#epub-reader .booklog-saved-highlight')).toHaveCount(1)
  expect(
    state.requests
      .slice(requestsBeforeReload)
      .some((request) => request.path === '/api/books/list-highlights' && request.form.annotationsOnly === 'true')
  ).toBe(true)
})

test('A book opened once is read from the device cache next time instead of downloading again', async ({ page }) => {
  const state = await openReader(page)
  expect(state.epubDownloads).toBe(1)
  await expect.poll(() => countCachedBooks(page)).toBeGreaterThan(0)

  await page.reload()
  await waitUntilLoaded(page)

  await expectChapter(page, 1)
  expect(state.epubDownloads, 'the second opening uses the stored copy').toBe(1)
})

test('Markup-like text found by search is shown as plain text and never runs', async ({ page }) => {
  await openReader(page)
  await openMenuItem(page, '검색')
  const input = page.locator('#reader-search-input')
  await input.fill('onerror')
  await input.press('Enter')

  const result = page.getByRole('button', { name: /onerror/ })
  await expect(result).toBeVisible()
  await expect(result).toContainText('<img src=x onerror=')
  expect(await result.locator('img').count()).toBe(0)
  expect(await page.evaluate(() => window.__searchXss)).toBeUndefined()
})

test('Choosing the other device’s place moves there and is not asked again', async ({ page }) => {
  const state = await openReader(page)
  const saves = () => state.requests.filter((request) => request.path === '/api/books/save-progress')
  const prompt = page.getByText('다른 기기에서 읽은 위치가 있어요.')
  state.serverPosition = { locator: '', href: 'c4.xhtml', chapterLabel: '4장' }

  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect(page.getByText('4장 위치로 이동할까요?')).toBeVisible()
  await page.getByRole('button', { name: '그 위치로 이동' }).click()

  await expectChapter(page, 4)
  await expect(prompt).toBeHidden()
  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect.poll(() => saves().some((request) => /^epubcfi\(\/6\/8!/.test(request.form.locator))).toBe(true)
  await page.waitForTimeout(1500)

  const afterMove = saves().filter((request) => /^epubcfi\(\/6\/8!/.test(request.form.locator))
  expect(afterMove.length).toBeGreaterThan(0)
  expect(afterMove[0].form.baseLocator, 'the first save from the new place builds on the other device').toBe('c4.xhtml')
  expect(afterMove.map((request) => request.status)).not.toContain(409)
  expect(afterMove.every((request) => request.form.force !== 'true')).toBe(true)
  expect(state.serverPosition.locator).toMatch(/^epubcfi\(\/6\/8!/)
  await expect(prompt).toBeHidden()
})

test('Failed saves explain the problem and keep what the reader entered until a retry succeeds', async ({ page }) => {
  const state = await openReader(page)
  state.failures = new Set(['/api/books/save-bookmark', '/api/books/save-highlight'])

  await openMenuItem(page, '책갈피')
  await page.getByRole('button', { name: '현재 위치 저장' }).click()
  await expect(page.locator('p:visible', { hasText: SAVE_FAILURE_MESSAGE })).toHaveCount(1)
  await expect(page.getByText('아직 저장한 책갈피가 없습니다.')).toBeVisible()
  await expect(page.getByRole('button', { name: '현재 위치 저장' })).toBeEnabled()
  await page.getByRole('button', { name: '책갈피 닫기' }).click()

  await openMenuItem(page, '문구')
  await page.getByRole('button', { name: '문구 추가', exact: true }).click()
  await page.locator('#reader-highlight-quote').fill('남겨 둘 문장')
  await page.getByRole('button', { name: '문구 저장' }).click()
  await expect(page.locator('p:visible', { hasText: SAVE_FAILURE_MESSAGE })).toHaveCount(1)
  await expect(page.locator('#reader-highlight-quote'), 'typed text survives a failed save').toHaveValue('남겨 둘 문장')
  await page.getByRole('button', { name: '문구 추가 닫기' }).click()

  await selectSecondParagraph(page)
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.locator('p:visible', { hasText: SAVE_FAILURE_MESSAGE })).toHaveCount(1)
  await expect(page.getByText('선택한 문구', { exact: true })).toBeVisible()
  await expect(page.locator('#epub-reader .booklog-saved-highlight')).toHaveCount(0)

  state.failures.clear()
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await expect(page.getByText('선택한 문구', { exact: true })).toBeHidden()
  await expect(page.locator('#epub-reader .booklog-saved-highlight')).toHaveCount(1)
})

test('A failed reading-position save tells the reader instead of failing silently', async ({ page }) => {
  const state = await openReader(page)
  state.failures = new Set(['/api/books/save-progress'])

  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect(page.getByText(SAVE_FAILURE_MESSAGE)).toBeVisible()
})

test('When the book file cannot be downloaded, the reader says so instead of loading forever', async ({ page }) => {
  const state = await mockReader(page, featureBook)
  state.epubStatus = 503
  await page.goto('/books/book/read')

  await expect(page.getByText(/EPUB 파일 응답이 올바르지 않습니다/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('EPUB 파일을 불러오는 중입니다.')).toBeHidden()
  expect(state.epubDownloads).toBe(1)
})

const DAY_MS = 86_400_000

// 리더의 독서 시간 계산은 Date.now()만 쓰므로, 그 값만 앞당겨 하루가 지난 상황을 만듭니다.
async function openReaderWithMovableClock(page) {
  await page.addInitScript(() => {
    const realNow = Date.now
    window.__clockShiftMs = 0
    Date.now = () => realNow.call(Date) + window.__clockShiftMs
  })
  return openReader(page)
}

function passTime(page, ms) {
  return page.evaluate((ms) => {
    window.__clockShiftMs += ms
  }, ms)
}

function touchReader(page) {
  return page.evaluate(() => window.dispatchEvent(new Event('pointerdown')))
}

function setScreen(page, visibility) {
  return page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, visibility)
}

function setReaderState(page, field, value) {
  return page.evaluate(
    ([field, value]) => {
      window.Alpine.$data(document.querySelector('section[x-data]'))[field] = value
    },
    [field, value]
  )
}

function sessionSaves(state) {
  return state.requests
    .filter((request) => request.path === '/api/books/save-reading-session')
    .map((request) => ({
      id: request.form.sessionId,
      seconds: Number(request.form.durationSeconds),
      startedAt: Date.parse(request.form.startedAt),
      endedAt: Date.parse(request.form.endedAt),
    }))
}

function lastSaveOf(state, id) {
  return sessionSaves(state)
    .filter((save) => save.id === id)
    .at(-1)
}

async function waitForSave(state, matches) {
  await expect.poll(() => sessionSaves(state).some(matches), { timeout: 10_000 }).toBe(true)
  return sessionSaves(state).filter(matches).at(-1)
}

test('Coming back to an open reader the next day starts a new reading record for that day', async ({ page }) => {
  const state = await openReaderWithMovableClock(page)

  await passTime(page, 100_000)
  await touchReader(page)
  await setScreen(page, 'hidden')
  const monday = await waitForSave(state, (save) => save.seconds >= 100)
  await page.waitForTimeout(300)

  await passTime(page, DAY_MS)
  await setScreen(page, 'visible')
  await passTime(page, 50_000)
  await touchReader(page)
  await setScreen(page, 'hidden')
  const tuesday = await waitForSave(state, (save) => save.id !== monday.id && save.seconds >= 50)

  expect(monday.seconds).toBeLessThan(110)
  expect(tuesday.seconds).toBeLessThan(60)
  expect(tuesday.startedAt - monday.endedAt).toBeGreaterThanOrEqual(DAY_MS)
  expect(lastSaveOf(state, monday.id), 'the previous day is not touched again').toEqual(monday)
})

test('A reader left on screen ends the old record at the last reading moment and starts anew on the next touch', async ({
  page,
}) => {
  const state = await openReaderWithMovableClock(page)

  await passTime(page, 60_000)
  await touchReader(page)
  await passTime(page, DAY_MS)
  await touchReader(page)
  const earlier = await waitForSave(state, (save) => save.seconds >= 200)

  // 마지막 손길 뒤 3분까지만 읽은 것으로 보고, 하루 동안 켜 둔 시간은 세지 않습니다.
  expect(earlier.seconds).toBeLessThan(250)
  expect(earlier.endedAt - earlier.startedAt).toBeGreaterThanOrEqual(240_000)
  expect(earlier.endedAt - earlier.startedAt).toBeLessThan(250_000)

  await passTime(page, 30_000)
  await touchReader(page)
  await setScreen(page, 'hidden')
  const next = await waitForSave(state, (save) => save.id !== earlier.id && save.seconds >= 30)

  expect(next.seconds).toBeLessThan(40)
  expect(next.startedAt - earlier.endedAt).toBeGreaterThan(DAY_MS - 300_000)
})

test('Listening to the AI audiobook with the screen off counts as reading time until playback stops', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const state = await openReaderWithMovableClock(page)

  await setReaderState(page, 'cloudAudioActive', true)
  await setScreen(page, 'hidden')
  await passTime(page, 20 * 60_000)
  await setReaderState(page, 'cloudAudioActive', false)
  const listened = await waitForSave(state, (save) => save.seconds >= 1200)

  expect(listened.seconds).toBeLessThan(1215)
  expect(listened.endedAt - listened.startedAt).toBeGreaterThanOrEqual(1_200_000)

  await page.waitForTimeout(300)
  await passTime(page, 10 * 60_000)
  await setScreen(page, 'visible')
  await passTime(page, 5_000)
  await touchReader(page)
  await setScreen(page, 'hidden')
  const after = await waitForSave(state, (save) => save.id !== listened.id && save.seconds >= 5)

  expect(after.seconds).toBeLessThan(15)
  expect(lastSaveOf(state, listened.id).seconds, 'the silent break after listening is not counted').toBeLessThan(
    1215
  )
  expect(errors).toEqual([])
})

// iOS가 화면 잠금 때 기기 음성을 끝났다는 신호 없이 멈춰, 재생 중 표시가 밤새 켜진 채 남는 상황입니다.
for (const [flags, player] of [
  [{ readAloudPlaying: true }, 'device voice'],
  [{ cloudAudioActive: true, cloudAudioDeviceVoice: true }, 'device voice standing in for AI audio'],
]) {
  test(`The ${player} counts only while the screen is on, so a voice stopped by a locked screen is not counted`, async ({
    page,
  }) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const state = await openReaderWithMovableClock(page)

    for (const [field, value] of Object.entries(flags)) await setReaderState(page, field, value)
    await page.waitForTimeout(100)
    await passTime(page, 10 * 60_000)
    await setScreen(page, 'hidden')
    const listened = await waitForSave(state, (save) => save.seconds >= 600)
    expect(listened.seconds, 'listening on screen counts without touching').toBeLessThan(615)

    await page.waitForTimeout(300)
    await passTime(page, 8 * 3_600_000)
    await setScreen(page, 'visible')
    await passTime(page, 5_000)
    await touchReader(page)
    await setScreen(page, 'hidden')
    await waitForSave(state, (save) => save.id !== listened.id && save.seconds >= 5)

    expect(lastSaveOf(state, listened.id).seconds).toBeLessThan(615)
    expect(Math.max(...sessionSaves(state).map((save) => save.seconds)), 'the locked night is never counted').toBeLessThan(
      615
    )
    expect(errors).toEqual([])
  })
}

function progressSaves(state) {
  return state.requests.filter((request) => request.path === '/api/books/save-progress')
}

function scrollReader(page, pixels) {
  return page.evaluate((pixels) => document.querySelector('#epub-reader .epub-container').scrollBy(0, pixels), pixels)
}

test('Turning the screen off right after moving saves the new place without waiting for the auto-save', async ({
  page,
}) => {
  // 5초 자동 저장을 멈춰, 화면을 끌 때 보낸 저장만 보이게 합니다.
  await page.addInitScript(() => {
    const realSetInterval = window.setInterval
    window.setInterval = (handler, ms, ...rest) => (ms === 5000 ? 0 : realSetInterval(handler, ms, ...rest))
  })
  const state = await openReader(page)
  await goToChapter(page, 3)
  await scrollReader(page, 300)
  await page.waitForTimeout(500)
  const before = progressSaves(state).length

  await setScreen(page, 'hidden')
  await expect.poll(() => progressSaves(state).length).toBe(before + 1)
  expect(progressSaves(state).at(-1).form.locator).toMatch(/^epubcfi\(\/6\/6!/)
  expect(state.serverPosition.locator).toBe(progressSaves(state).at(-1).form.locator)

  await setScreen(page, 'visible')
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await setScreen(page, 'hidden')
  await page.waitForTimeout(800)
  expect(progressSaves(state).length, 'an unchanged place is not sent again').toBe(before + 1)
})

async function openReaderWhileOffline(page) {
  const state = await mockReader(page, featureBook)
  state.serverPosition = { locator: '', href: 'c4.xhtml', chapterLabel: '4장' }
  state.failures.add('/api/books/load-progress')
  await page.goto('/books/book/read')
  await waitUntilLoaded(page)
  return state
}

test('When the saved place arrives late, a reader who has not moved is taken there', async ({ page }) => {
  const state = await openReaderWhileOffline(page)
  await expectChapter(page, 1)

  state.failures.clear()
  await expectChapter(page, 4)
  await expect(page.getByText('다른 기기에서 읽은 위치가 있어요.')).toBeHidden()
})

test('When the saved place arrives late, a reader who already moved on is asked instead of being pulled back', async ({
  page,
}) => {
  const state = await openReaderWhileOffline(page)
  await goToChapter(page, 2)

  state.failures.clear()
  await expect(page.getByText('4장 위치로 이동할까요?')).toBeVisible({ timeout: 15_000 })
  await expectChapter(page, 2)
  expect(progressSaves(state), 'nothing overwrites the saved place while the reader decides').toEqual([])

  await page.getByRole('button', { name: '그 위치로 이동' }).click()
  await expectChapter(page, 4)
})

function paragraphStyle(page, text) {
  return page.evaluate((text) => {
    for (const frame of document.querySelectorAll('#epub-reader iframe')) {
      const doc = frame.contentDocument
      const paragraph = [...(doc?.querySelectorAll('p') || [])].find((node) => node.textContent.includes(text))
      if (!paragraph) continue
      const computed = frame.contentWindow.getComputedStyle(paragraph)
      return {
        fontSize: parseFloat(computed.fontSize),
        lineRatio: Math.round((parseFloat(computed.lineHeight) / parseFloat(computed.fontSize)) * 100) / 100,
        font: computed.fontFamily,
        padding: frame.contentWindow.getComputedStyle(doc.body).paddingLeft,
      }
    }
    return null
  }, text)
}

test('Changing font size, line spacing and margins keeps the same paragraph at the top of the screen', async ({
  page,
}) => {
  await openReader(page)
  await goToChapter(page, 3)
  await scrollReader(page, 1200)
  await page.waitForTimeout(800)
  const spot = await readingSpot(page)
  expect(spot).toMatch(/^3장 문단 \d+입니다/)

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '글자 크기 키우기' }).first().click()
  await page.waitForTimeout(1000)
  expect(await readingSpot(page), 'after a larger font').toBe(spot)

  await page.getByRole('button', { name: '상세 읽기 설정' }).click()
  await page.getByRole('button', { name: '더 넓게', exact: true }).click()
  await page.waitForTimeout(1000)
  expect(await readingSpot(page), 'after wider line spacing').toBe(spot)
  await page.getByRole('button', { name: '넓게', exact: true }).last().click()
  await page.waitForTimeout(1000)
  expect(await readingSpot(page), 'after wider margins').toBe(spot)

  const smaller = page.getByRole('button', { name: '글자 크기 줄이기' }).last()
  await smaller.click()
  await smaller.click()
  await page.waitForTimeout(1200)
  expect(await readingSpot(page), 'after quick repeated changes').toBe(spot)
})

test('Moving inside an open book says it is moving, not loading the file', async ({ page }) => {
  await openReader(page)
  await page.evaluate(() => {
    const overlay = document.querySelector('[x-show="loading"]')
    window.__overlayTexts = []
    const sample = () => {
      if (window.getComputedStyle(overlay).display !== 'none') window.__overlayTexts.push(overlay.textContent.trim())
      window.requestAnimationFrame(sample)
    }
    sample()
  })

  await goToChapter(page, 3)
  const shown = await page.evaluate(() => [...new Set(window.__overlayTexts)])
  expect(shown).toEqual(['위치로 이동하는 중입니다.'])
})

test('A move that fails shows a short notice and leaves no error over the book', async ({ page }) => {
  await openReader(page)
  const messages = () =>
    page.evaluate(() => {
      const data = window.Alpine.$data(document.querySelector('section[x-data]'))
      return { error: data.errorMessage, notice: data.savePositionMessage }
    })

  for (const move of ['goToTocItem', 'goToSearchResult']) {
    await page.evaluate(
      (move) =>
        window.Alpine.$data(document.querySelector('section[x-data]'))[move]({
          href: 'missing.xhtml',
          cfi: 'missing.xhtml',
        }),
      move
    )
    await expect.poll(async () => (await messages()).notice, move).not.toBe('')
    expect((await messages()).error, move).toBe('')
    await expect.poll(async () => (await messages()).notice, move + ' notice goes away').toBe('')
    expect((await messages()).error, move).toBe('')
    await expect(page.getByText('위치로 이동하는 중입니다.')).toBeHidden()
  }
})

test('A chapter drawn after the reading settings changed uses the same settings', async ({ page }) => {
  await openReader(page)
  const before = await paragraphStyle(page, '1장 문단 1입니다')

  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
  await page.getByRole('button', { name: '글자 크기 키우기' }).first().click()
  await page.getByRole('button', { name: '상세 읽기 설정' }).click()
  await page.getByRole('button', { name: '고딕', exact: true }).click()
  await page.getByRole('button', { name: '더 넓게', exact: true }).click()
  await page.getByRole('button', { name: '넓게', exact: true }).last().click()
  await page.getByRole('button', { name: '완료', exact: true }).click()
  const expected = { lineRatio: 2.3, padding: '48px' }
  await expect.poll(() => paragraphStyle(page, '1장 문단 1입니다')).toMatchObject(expected)
  const changed = await paragraphStyle(page, '1장 문단 1입니다')
  expect(changed.fontSize).toBeGreaterThan(before.fontSize)
  expect(await paragraphStyle(page, '4장 문단 1입니다'), 'chapter 4 is not drawn yet').toBeNull()

  await goToChapter(page, 4)
  await expect.poll(() => paragraphStyle(page, '4장 문단 1입니다')).toEqual(changed)
})

test('A reading-time save that failed is sent again later, so the time is not lost', async ({ page }) => {
  const state = await openReaderWithMovableClock(page)
  const sessionRequests = () => state.requests.filter((request) => request.path === '/api/books/save-reading-session')
  state.failures.add('/api/books/save-reading-session')

  await passTime(page, 100_000)
  await touchReader(page)
  await setScreen(page, 'hidden')
  await expect.poll(() => sessionRequests().some((request) => Number(request.form.durationSeconds) >= 100)).toBe(true)
  const failed = sessionRequests().at(-1).form
  const afterFailure = state.requests.length
  state.failures.clear()

  await setScreen(page, 'visible')
  await passTime(page, 4 * 60_000)
  await touchReader(page)
  await expect
    .poll(() =>
      state.requests
        .slice(afterFailure)
        .some(
          (request) =>
            request.path === '/api/books/save-reading-session'
            && request.form.sessionId === failed.sessionId
            && Number(request.form.durationSeconds) >= Number(failed.durationSeconds)
        )
    )
    .toBe(true)
})

test('A book already marked finished does not ask again at the end', async ({ page }) => {
  const state = await openReader(page, featureBook, renderReaderBody('finished'))
  await goToChapter(page, CHAPTER_COUNT)

  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    container.scrollTop = container.scrollHeight
  })
  await page.waitForTimeout(3000)
  await expect(page.getByText('마지막까지 읽은 것 같아요.')).toBeHidden()
  expect(lastRequest(state, '/xapi/books/update-status')).toBeUndefined()
})

function cachedBookKeys(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('booklog-reader-cache')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const keys = db.transaction('epubBuffers').objectStore('epubBuffers').getAllKeys()
          keys.onsuccess = () => {
            db.close()
            resolve(keys.result.map(String).sort())
          }
          keys.onerror = () => reject(keys.error)
        }
      })
  )
}

test('The device keeps five books and drops the one opened longest ago when another is added', async ({ page }) => {
  const state = await openReader(page)
  await expect.poll(() => cachedBookKeys(page)).toHaveLength(1)
  const [current] = await cachedBookKeys(page)
  const older = ['older-book-1', 'older-book-2', 'older-book-3', 'older-book-4', 'older-book-5']

  // 지금 책을 처음 여는 상황을 만들려고, 지금 책은 빼고 예전에 연 책 다섯 권을 시각 순서대로 넣어 둡니다.
  await page.evaluate(
    ([current, older]) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('booklog-reader-cache')
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction('epubBuffers', 'readwrite')
          const store = transaction.objectStore('epubBuffers')
          store.delete(current)
          older.forEach((cacheKey, index) =>
            store.put({ cacheKey, buffer: new ArrayBuffer(8), byteLength: 8, lastOpenedAt: 1000 + index })
          )
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
        }
      }),
    [current, older]
  )

  await page.reload()
  await waitUntilLoaded(page)
  expect(state.epubDownloads).toBe(2)
  await expect.poll(() => cachedBookKeys(page)).toEqual([current, ...older.slice(1)].sort())

  await page.reload()
  await waitUntilLoaded(page)
  expect(state.epubDownloads, 'the book just added is read from the device').toBe(2)
  expect(await cachedBookKeys(page)).toEqual([current, ...older.slice(1)].sort())
})

test('A broken copy on the device is replaced by downloading the book again', async ({ page }) => {
  const state = await openReader(page)
  await expect.poll(() => cachedBookKeys(page)).toHaveLength(1)
  const [current] = await cachedBookKeys(page)
  const cachedSize = () =>
    page.evaluate(
      (current) =>
        new Promise((resolve) => {
          const request = indexedDB.open('booklog-reader-cache')
          request.onsuccess = () => {
            const db = request.result
            const entry = db.transaction('epubBuffers').objectStore('epubBuffers').get(current)
            entry.onsuccess = () => {
              db.close()
              resolve(entry.result ? entry.result.byteLength : 0)
            }
          }
        }),
      current
    )
  const fullSize = await cachedSize()

  await page.evaluate(
    (current) =>
      new Promise((resolve) => {
        const request = indexedDB.open('booklog-reader-cache')
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction('epubBuffers', 'readwrite')
          const broken = new TextEncoder().encode('not an epub file').buffer
          transaction.objectStore('epubBuffers').put({
            cacheKey: current,
            buffer: broken,
            byteLength: broken.byteLength,
            lastOpenedAt: Date.now(),
          })
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    current
  )

  await page.reload()
  await waitUntilLoaded(page)
  await expectChapter(page, 1)
  expect(state.epubDownloads, 'the broken copy makes the reader download the book once more').toBe(2)
  expect(await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).errorMessage)).toBe(
    ''
  )
  await expect.poll(cachedSize, 'the device copy is replaced with the real book').toBe(fullSize)

  await page.reload()
  await waitUntilLoaded(page)
  await expectChapter(page, 1)
  expect(state.epubDownloads, 'the repaired copy is used next time').toBe(2)
})

test('A bookmark cannot be saved while the list is still loading, so the new one is never dropped', async ({
  page,
}) => {
  const state = await openReader(page)
  let releaseList = null
  await page.route('**/api/books/list-bookmarks', async (route) => {
    if (releaseList === null) {
      await new Promise((resolve) => {
        releaseList = resolve
      })
    }
    return route.fallback()
  })
  const save = page.getByRole('button', { name: '현재 위치 저장' })

  await openMenuItem(page, '책갈피')
  await expect.poll(() => typeof releaseList).toBe('function')
  await expect(save, 'saving waits for the list').toBeDisabled()

  releaseList()
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText('책갈피를 저장했습니다.')).toBeVisible()
  const listed = () =>
    page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).bookmarks.length)
  await expect.poll(listed, 'the saved bookmark stays in the list').toBe(1)
  await page.waitForTimeout(500)
  expect(await listed()).toBe(1)
  expect(state.bookmarks).toHaveLength(1)
})

const searchBook = zipSync({
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  ),
  'book.opf': strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">search</dc:identifier><dc:title>검색 순서</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
      + [1, 2, 3]
        .map((n) => '<item id="c' + n + '" href="c' + n + '.xhtml" media-type="application/xhtml+xml"/>')
        .join('')
      + '</manifest><spine>'
      + [1, 2, 3].map((n) => '<itemref idref="c' + n + '"/>').join('')
      + '</spine></package>'
  ),
  'nav.xhtml': xhtml(
    '<nav epub:type="toc"><ol>'
      + [1, 2, 3].map((n) => '<li><a href="c' + n + '.xhtml">' + n + '장</a></li>').join('')
      + '</ol></nav>'
  ),
  ...Object.fromEntries(
    [1, 2, 3].map((n) => [
      'c' + n + '.xhtml',
      xhtml(
        chapterBody(n)
          .replace('문단 10입니다.', '문단 10입니다. ' + n + '장의 사과표지가 있습니다.')
          .replace('문단 30입니다.', '문단 30입니다. ' + n + '장의 포도표지가 있습니다.')
      ),
    ])
  ),
})

// 챕터마다 본문을 읽는 시간을 테스트에서 정할 수 있게, 리더가 만든 책 객체를 붙잡아 둡니다.
async function openReaderWithSlowSections(page) {
  await page.addInitScript(() => {
    let realEpub = null
    window.__sectionDelay = () => 0
    Object.defineProperty(window, 'ePub', {
      configurable: true,
      get: () =>
        realEpub
        && function (...args) {
          const book = realEpub(...args)
          book.ready.then(() => {
            book.spine.spineItems.forEach((section, index) => {
              const load = section.load.bind(section)
              section.load = (request) => {
                const delay = window.__sectionDelay(index)
                return delay
                  ? new Promise((resolve) => setTimeout(resolve, delay)).then(() => load(request))
                  : load(request)
              }
            })
          })
          return book
        },
      set: (value) => {
        realEpub = value
      },
    })
  })
  await openReader(page, searchBook)
  await openMenuItem(page, '검색')
}

function searchState(page) {
  return page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('section[x-data]'))
    return {
      searching: data.searching,
      message: data.searchMessage,
      results: data.searchResults.map((result) => result.chapterLabel + ' ' + result.excerpt),
    }
  })
}

test('Search results are listed in book order even when an earlier chapter takes longer to read', async ({ page }) => {
  await openReaderWithSlowSections(page)
  const input = page.locator('#reader-search-input')

  await page.evaluate(() => {
    window.__sectionDelay = (index) => (index === 0 ? 700 : 0)
  })
  await input.fill('사과표지')
  await input.press('Enter')
  await expect(page.getByText('3개의 결과를 찾았습니다.')).toBeVisible()

  const { results } = await searchState(page)
  expect(results.map((result) => result.split(' ')[0])).toEqual(['1장', '2장', '3장'])
  expect(results.every((result) => result.includes('사과표지'))).toBe(true)
  await expect(page.getByRole('button', { name: /사과표지/ }).first()).toContainText('1장의 사과표지')
})

test('Searching again before the first search ends shows only the latest results, in book order', async ({ page }) => {
  await openReaderWithSlowSections(page)
  const input = page.locator('#reader-search-input')

  await page.evaluate(() => {
    window.__sectionDelay = () => 900
  })
  await input.fill('사과표지')
  await input.press('Enter')
  await expect.poll(async () => (await searchState(page)).searching).toBe(true)

  await page.evaluate(() => {
    window.__sectionDelay = () => 0
  })
  await input.fill('포도표지')
  await input.press('Enter')
  await expect(page.getByText('3개의 결과를 찾았습니다.')).toBeVisible()

  // 첫 검색이 늦게 끝난 뒤에도 화면이 바뀌지 않는지 봅니다.
  await page.waitForTimeout(1500)
  const latest = await searchState(page)
  expect(latest.searching).toBe(false)
  expect(latest.message).toBe('3개의 결과를 찾았습니다.')
  expect(latest.results.map((result) => result.split(' ')[0])).toEqual(['1장', '2장', '3장'])
  expect(latest.results.every((result) => result.includes('포도표지'))).toBe(true)
  await expect(page.getByRole('button', { name: /사과표지/ })).toHaveCount(0)

  await input.fill('사과표지')
  await input.press('Enter')
  await expect(page.getByText('3개의 결과를 찾았습니다.')).toBeVisible()
  expect(
    (await searchState(page)).results.every((result) => result.includes('사과표지')),
    'a later search still reads every chapter'
  ).toBe(true)
})

// 큰 그림 두 장짜리 표지입니다. epub.js는 원래 크기(화면 몇 배)로 다음 챕터가 필요 없다고 본 뒤 그림을 화면 크기로 줄이고,
// 첫 스크롤 하나를 무시합니다. 줄어든 표지는 화면보다 조금만 길어 그 한 번이 끝까지 내린 스크롤이라 다음 챕터가 붙지 않았습니다.
function tallPng(width, height) {
  const { deflateSync, crc32 } = require('node:zlib')
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])))
    return Buffer.concat([length, Buffer.from(type), data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const rows = Buffer.alloc((width + 1) * height, 200)
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const pictureCoverBook = zipSync({
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  ),
  'book.opf': strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">picture-cover</dc:identifier><dc:title>그림 표지</dc:title></metadata><manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="front" href="front.png" media-type="image/png"/><item id="rear" href="rear.png" media-type="image/png"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  ),
  'cover.xhtml': xhtml('<div><img alt="" src="front.png" /></div><div><img alt="" src="rear.png" /></div>'),
  'front.png': new Uint8Array(tallPng(1000, 1600)),
  'rear.png': new Uint8Array(tallPng(1000, 1600)),
  'c1.xhtml': xhtml(chapterBody(1)),
  'c2.xhtml': xhtml(chapterBody(2)),
})

test('A picture cover that shrinks to just over a screen still scrolls on into the first chapter', async ({ page }) => {
  await openReader(page, pictureCoverBook)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(250)
  }

  await expect
    .poll(() => readingSpot(page), { timeout: 10_000, message: 'scrolling leaves the cover' })
    .toMatch(/^1장/)
})

// 위로 올라가며 앞에 붙은 그림 페이지는 나중에 화면 아래에서 다시 잴 때도 epub.js가 그만큼 스크롤을 옮겨, 표지로 되돌아가길 반복했습니다.
const picturePagesBook = zipSync({
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  ),
  'book.opf': strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">picture-pages</dc:identifier><dc:title>그림 속표지</dc:title></metadata><manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="author" href="author.xhtml" media-type="application/xhtml+xml"/><item id="inner" href="inner.xhtml" media-type="application/xhtml+xml"/><item id="rights" href="rights.xhtml" media-type="application/xhtml+xml"/><item id="inner2" href="inner2.xhtml" media-type="application/xhtml+xml"/><item id="front" href="front.png" media-type="image/png"/><item id="rear" href="rear.png" media-type="image/png"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="author"/><itemref idref="inner"/><itemref idref="rights"/><itemref idref="inner2"/><itemref idref="c1"/></spine></package>'
  ),
  'cover.xhtml': xhtml('<div><img alt="" src="front.png" /></div><div><img alt="" src="rear.png" /></div>'),
  'author.xhtml': xhtml(
    Array.from(
      { length: 8 },
      (_, index) => '<p>지은이 소개 ' + (index + 1) + '. 작가가 걸어온 길을 짧게 적은 문단입니다.</p>'
    ).join('')
  ),
  'inner.xhtml': xhtml('<div><img alt="" src="front.png" /></div>'),
  'rights.xhtml': xhtml('<p>판권 면입니다.</p><p>무단 복제를 금합니다.</p>'),
  'inner2.xhtml': xhtml('<div><img alt="" src="rear.png" /></div>'),
  'front.png': new Uint8Array(tallPng(1000, 1600)),
  'rear.png': new Uint8Array(tallPng(1000, 1600)),
  'c1.xhtml': xhtml(Array.from({ length: 6 }, () => chapterBody(1)).join('')),
})

test('Going back to the very top past picture pages and scrolling gently down never jumps back up', async ({
  page,
}) => {
  await openReader(page, picturePagesBook)
  const scrollTop = () => page.evaluate(() => document.querySelector('#epub-reader .epub-container').scrollTop)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 40; step += 1) {
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(1500)
  for (let step = 0; step < 80; step += 1) {
    await page.mouse.wheel(0, -500)
    await page.waitForTimeout(120)
    if (step > 10 && (await scrollTop()) === 0) break
  }
  await page.waitForTimeout(2500)
  await expect(page.locator('#epub-reader iframe').first(), 'back at the cover').toBeVisible()

  await page.evaluate(() => {
    window.__scrollTops = []
    const container = document.querySelector('#epub-reader .epub-container')
    const sample = () => {
      window.__scrollTops.push(container.scrollTop)
      window.requestAnimationFrame(sample)
    }
    sample()
  })
  for (let step = 0; step < 30; step += 1) {
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(2000)

  const tops = await page.evaluate(() => window.__scrollTops)
  const jumpsBack = tops.filter((top, index) => index > 0 && top < tops[index - 1] - 30).length
  expect(jumpsBack, 'gentle downward scrolling never springs back').toBe(0)
  expect(tops.at(-1), 'the reader moved down by the scrolled amount').toBeGreaterThan(1500)
})

function smallBook(id, files, spine) {
  const manifest = Object.keys(files)
    .map((name, index) => {
      const type = name.endsWith('.png') ? 'image/png' : 'application/xhtml+xml'
      return '<item id="i' + index + '" href="' + name + '" media-type="' + type + '"/>'
    })
    .join('')
  const order = spine.map((name) => '<itemref idref="i' + Object.keys(files).indexOf(name) + '"/>').join('')
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">'
        + id
        + '</dc:identifier><dc:title>'
        + id
        + '</dc:title></metadata><manifest>'
        + manifest
        + '</manifest><spine>'
        + order
        + '</spine></package>'
    ),
    ...files,
  })
}

// 표지 그림이 화면 크기로 줄어 화면보다 짧아지면 스크롤할 곳이 없어, epub.js가 다음 챕터를 붙일 기회가 다시 오지 않았습니다.
const shortPictureCoverBook = smallBook(
  'short-picture-cover',
  {
    'cover.xhtml': xhtml('<div><img alt="" src="front.png" /></div>'),
    'front.png': new Uint8Array(tallPng(1000, 1600)),
    'c1.xhtml': xhtml(chapterBody(1)),
    'c2.xhtml': xhtml(chapterBody(2)),
  },
  ['cover.xhtml', 'c1.xhtml', 'c2.xhtml']
)

test('A picture cover that shrinks below the screen height still lets the reader scroll into the first chapter', async ({
  page,
}) => {
  await openReader(page, shortPictureCoverBook)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(250)
  }

  await expect
    .poll(() => readingSpot(page), { timeout: 10_000, message: 'scrolling leaves the cover' })
    .toMatch(/^1장/)
})

// 높이 100% 상자 안에 그림만 둔 페이지는 epub.js가 그림 최대 높이를 0으로 정해, 표지와 삽화가 통째로 보이지 않았습니다.
function fullHeightPicturePage(image) {
  return strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>p</title><style type="text/css">html, body { height:100%; margin:0; padding:0; } img { max-width:100%; max-height:90%; } .allcenter { width:100%; height:100%; text-align:center; display:-webkit-box; -webkit-box-orient:horizontal; -webkit-box-pack:center; -webkit-box-align:center; }</style></head><body><div class="allcenter"><img alt="" src="'
      + image
      + '" /></div></body></html>'
  )
}

const fullHeightPictureBook = smallBook(
  'full-height-pictures',
  {
    'cover.xhtml': fullHeightPicturePage('front.png'),
    'c1.xhtml': xhtml(chapterBody(1)),
    'inner.xhtml': fullHeightPicturePage('rear.png'),
    'c2.xhtml': xhtml(chapterBody(2)),
    'front.png': new Uint8Array(tallPng(1000, 1600)),
    'rear.png': new Uint8Array(tallPng(1000, 1600)),
  },
  ['cover.xhtml', 'c1.xhtml', 'inner.xhtml', 'c2.xhtml']
)

test('Picture pages drawn inside a full-height box still show their picture', async ({ page }) => {
  await openReader(page, fullHeightPictureBook)
  const pictureHeights = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#epub-reader iframe')).flatMap((frame) =>
        Array.from(frame.contentDocument?.querySelectorAll('img') || []).map((image) =>
          Math.round(image.getBoundingClientRect().height)
        )
      )
    )

  await expect.poll(pictureHeights, { message: 'the cover picture is drawn on open' }).toEqual([expect.any(Number)])
  expect((await pictureHeights())[0], 'the cover picture has a real height').toBeGreaterThan(300)

  await page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('section[x-data]'))
    data.goToTocItem(data.tocItems.find((item) => /inner/.test(item.href)) || { href: 'inner.xhtml' })
  })
  await expect
    .poll(async () => (await pictureHeights()).filter((height) => height > 300).length, {
      timeout: 10_000,
      message: 'the inner picture page is drawn too',
    })
    .toBeGreaterThan(0)
})

// 표지 그림이 줄며 붙이는 다음 챕터를 불러오는 사이에 저장 위치로 옮기면, epub.js가 불러오던 챕터를 지워 이동이 끝나지 않았습니다.
const pictureStartBook = smallBook(
  'picture-start',
  {
    'cover.xhtml': xhtml(' <div><img alt="" src="front.png" /></div> '),
    'author.xhtml': xhtml(
      Array.from({ length: 6 }, (_, index) => '<p>지은이 소개 ' + (index + 1) + '. 작가가 걸어온 길입니다.</p>').join('')
    ),
    'inner1.xhtml': xhtml(' <div><img alt="" src="rear.png" /></div> '),
    'inner2.xhtml': xhtml(' <div><img alt="" src="front.png" /></div> '),
    'inner3.xhtml': xhtml(' <div><img alt="" src="rear.png" /></div> '),
    'front.png': new Uint8Array(tallPng(1000, 1600)),
    'rear.png': new Uint8Array(tallPng(1000, 1600)),
    'c1.xhtml': xhtml(chapterBody(1)),
    'c2.xhtml': xhtml(chapterBody(2)),
  },
  ['cover.xhtml', 'author.xhtml', 'inner1.xhtml', 'inner2.xhtml', 'inner3.xhtml', 'c1.xhtml', 'c2.xhtml']
)

test('Reopening at a picture page always finishes loading even when the saved position arrives during the first chapter fill', async ({
  page,
}) => {
  const state = await openReader(page, pictureStartBook)
  state.serverPosition = { locator: 'epubcfi(/6/8!/4/1:0)', href: 'inner2.xhtml', chapterLabel: '' }
  state.keepServerPosition = true
  const readerState = () =>
    page.evaluate(() => {
      const data = window.Alpine.$data(document.querySelector('section[x-data]'))
      return {
        ready: !data.loading && data.bookReady,
        chaptersShown: document.querySelectorAll('#epub-reader iframe').length > 1,
      }
    })

  for (const delay of [50, 80, 120, 50, 80, 120, 60, 100]) {
    state.loadProgressDelay = delay
    await page.reload()
    await expect
      .poll(readerState, { timeout: 6_000, message: 'reopen with a ' + delay + 'ms position response finishes loading' })
      .toEqual({ ready: true, chaptersShown: true })
  }
})

test('A first move to the saved position that never finishes reopens the reader and retries the position', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let realEpub = null
    window.__restoreHung = false
    Object.defineProperty(window, 'ePub', {
      configurable: true,
      get: () =>
        realEpub
        && function (...args) {
          const book = realEpub(...args)
          const renderTo = book.renderTo.bind(book)
          book.renderTo = (...renderArgs) => {
            const rendition = renderTo(...renderArgs)
            const display = rendition.display.bind(rendition)
            rendition.display = (target) => {
              if (!window.__restoreHung && String(target || '').indexOf('/6/6!') >= 0) {
                window.__restoreHung = true
                return new Promise(() => {})
              }
              return display(target)
            }
            return rendition
          }
          return book
        },
      set: (value) => {
        realEpub = value
      },
    })
  })
  const warnings = []
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text())
  })
  const state = await mockReader(page, featureBook)
  state.serverPosition = { locator: 'epubcfi(/6/6!/4/2/1:0)', href: 'c3.xhtml', chapterLabel: '3장' }
  await page.goto('/books/book/read')

  const readerState = () =>
    page.evaluate(() => {
      const data = window.Alpine.$data(document.querySelector('section[x-data]'))
      return { ready: !data.loading && data.bookReady }
    })
  await expect.poll(readerState, { timeout: 15_000, message: 'the reader becomes usable' }).toEqual({ ready: true })
  expect(warnings.some((text) => text.includes('restore-timeout'))).toBe(true)
  await expect
    .poll(() => readingSpot(page), { timeout: 15_000, message: 'the saved position is opened on the retry' })
    .toMatch(/^3장/)
})

// 빠르게 올리는 동안 잠깐 화면 밖으로 나간 챕터를 epub.js가 비웠다가 다시 그리면, 다시 잴 때 줄어든 높이만큼 화면이 튀었습니다.
const shrinkingChaptersBook = smallBook(
  'shrinking-chapters',
  {
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        'c' + (index + 1) + '.xhtml',
        xhtml(chapterBody(index + 1) + '<div><img alt="" src="tall.png" /></div>'),
      ])
    ),
    'tall.png': new Uint8Array(tallPng(1000, 1600)),
  },
  Array.from({ length: 8 }, (_, index) => 'c' + (index + 1) + '.xhtml')
)

function watchVisibleJumps(page) {
  return page.evaluate(() => {
    window.__jumps = []
    const container = document.querySelector('#epub-reader .epub-container')
    let previous = null
    const sample = () => {
      const top = container.getBoundingClientRect().top
      // 막 붙어 아직 높이가 없거나 숨겨진 iframe은 화면 위치의 비교 대상이 아닙니다.
      const frame = Array.from(container.querySelectorAll('iframe')).find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return (
          bounds.height > 50
          && bounds.bottom > top + 1
          && bounds.top < top + container.clientHeight
          && window.getComputedStyle(candidate).visibility !== 'hidden'
        )
      })
      if (frame) {
        const current = { frame, top: frame.getBoundingClientRect().top - top }
        if (previous && previous.frame === frame) {
          const moved = previous.top - current.top
          if (moved > 30 || moved < -1600) window.__jumps.push(Math.round(moved))
        }
        previous = current
      }
      window.requestAnimationFrame(sample)
    }
    sample()
  })
}

test('Fast upward bursts from the last chapter never push the page down or jump on their own', async ({ page }) => {
  const state = await openReader(page, shrinkingChaptersBook)
  state.serverPosition = { locator: '', href: 'c8.xhtml', chapterLabel: '' }
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).bookReady))
    .toBe(true)
  await page.mouse.move(195, 500)
  await watchVisibleJumps(page)
  for (let round = 0; round < 3; round += 1) {
    for (let step = 0; step < 30; step += 1) {
      await page.mouse.wheel(0, 1500)
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
      window.__jumps = []
    })
    for (let burst = 0; burst < 12; burst += 1) {
      for (let step = 0; step < 8; step += 1) {
        await page.mouse.wheel(0, -1500)
        await page.waitForTimeout(16)
      }
      await page.waitForTimeout(350)
    }
    await page.waitForTimeout(1000)
    expect(await page.evaluate(() => window.__jumps), 'visible jumps while scrolling up, round ' + (round + 1)).toEqual([])
  }
})

async function captureRendition(page) {
  await page.addInitScript(() => {
    let realEpub = null
    Object.defineProperty(window, 'ePub', {
      configurable: true,
      get: () =>
        realEpub
        && function (...args) {
          const book = realEpub(...args)
          const renderTo = book.renderTo.bind(book)
          book.renderTo = (...renderArgs) => {
            window.__rendition = renderTo(...renderArgs)
            return window.__rendition
          }
          return book
        },
      set: (value) => {
        realEpub = value
      },
    })
  })
}

// 맨 끝에서는 더 스크롤되지 않아 scroll 이벤트가 없으므로, epub.js가 확인을 놓치면 앞뒤 챕터가 붙지 않고 멈췄습니다.
test('Wheeling at the very top or bottom attaches the neighbouring chapter even without a scroll event', async ({ page }) => {
  await captureRendition(page)
  const state = await openReader(page)
  state.serverPosition = { locator: '', href: 'c3.xhtml', chapterLabel: '3장' }
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).bookReady))
    .toBe(true)
  await page.waitForTimeout(1500)
  const edges = () =>
    page.evaluate(() => {
      const views = window.__rendition.manager.views
      return { first: views.first().section.index, last: views.last().section.index }
    })

  const missedTop = await page.evaluate(() => {
    const manager = window.__rendition.manager
    while (manager.views.first().section.index < 2) manager.views.remove(manager.views.first())
    manager.ignore = true
    manager.container.scrollTop = 0
    return manager.views.first().section.index
  })
  await page.mouse.move(195, 500)
  for (let step = 0; step < 10; step += 1) {
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(150)
  }
  await expect.poll(async () => (await edges()).first, { timeout: 4_000, message: 'the previous chapter attaches at the top' }).toBeLessThan(missedTop)

  const missedBottom = await page.evaluate(() => {
    const manager = window.__rendition.manager
    const current = manager.views.all().find((view) => view.section.index === 2)
    while (manager.views.last() !== current) manager.views.remove(manager.views.last())
    manager.ignore = true
    manager.container.scrollTop = manager.container.scrollHeight
    return manager.views.last().section.index
  })
  for (let step = 0; step < 10; step += 1) {
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(150)
  }
  await expect.poll(async () => (await edges()).last, { timeout: 4_000, message: 'the next chapter attaches at the bottom' }).toBeGreaterThan(missedBottom)
})

// 화면 맨 위에 걸친 챕터 안에서 보던 문단보다 위의 그림이 늦게 커져도, 보던 문단은 제자리에 있어야 합니다.
const lateImageBook = smallBook(
  'late-image',
  {
    'c1.xhtml': xhtml(chapterBody(1)),
    'c2.xhtml': xhtml(
      '<h1>2장</h1><p>2장 첫 문단입니다.</p><div><img id="late" alt="" src="small.png" style="width:100%;height:120px" /></div>'
        + Array.from({ length: 40 }, (_, index) => '<p>2장 그림 아래 문단 ' + (index + 1) + '입니다. 그림이 늦게 커져도 이 문단은 움직이면 안 됩니다.</p>').join('')
    ),
    'c3.xhtml': xhtml(chapterBody(3)),
    'small.png': new Uint8Array(tallPng(400, 300)),
  },
  ['c1.xhtml', 'c2.xhtml', 'c3.xhtml']
)

function topParagraph(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    const top = container.getBoundingClientRect().top
    for (const frame of container.querySelectorAll('iframe')) {
      const frameTop = frame.getBoundingClientRect().top
      for (const node of frame.contentDocument?.querySelectorAll('p') || []) {
        const box = node.getBoundingClientRect()
        if (frameTop + box.bottom > top + 4) return { text: node.textContent.trim().slice(0, 24), y: Math.round(frameTop + box.top - top) }
      }
    }
    return null
  })
}

function growLateImage(page, height) {
  return page.evaluate((height) => {
    for (const frame of document.querySelectorAll('#epub-reader iframe')) {
      const image = frame.contentDocument && frame.contentDocument.getElementById('late')
      if (image) image.style.height = height + 'px'
    }
  }, height)
}

test('A picture above the reading paragraph that grows late keeps the paragraph in place', async ({ page }) => {
  await captureRendition(page)
  const state = await openReader(page, lateImageBook)
  state.serverPosition = { locator: '', href: 'c2.xhtml', chapterLabel: '' }
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).bookReady))
    .toBe(true)
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    const frame = Array.from(container.querySelectorAll('iframe')).find((candidate) => candidate.contentDocument && candidate.contentDocument.getElementById('late'))
    const paragraph = frame.contentDocument.querySelectorAll('p')[12]
    container.scrollTop += frame.getBoundingClientRect().top + paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top
  })
  await page.waitForTimeout(800)

  const before = await topParagraph(page)
  await growLateImage(page, 700)
  await page.waitForTimeout(800)
  const after = await topParagraph(page)
  expect(after.text, 'the same paragraph stays at the top while sitting still').toBe(before.text)
  expect(Math.abs(after.y - before.y), 'the paragraph does not move while sitting still').toBeLessThanOrEqual(8)

  await page.mouse.move(195, 500)
  for (const [height, delta] of [[260, -60], [900, 60]]) {
    const start = await topParagraph(page)
    await page.mouse.wheel(0, delta)
    await growLateImage(page, height)
    await page.waitForTimeout(800)
    const end = await topParagraph(page)
    const paragraphs = await page.evaluate(() => {
      const frame = Array.from(document.querySelectorAll('#epub-reader iframe')).find((candidate) => candidate.contentDocument && candidate.contentDocument.getElementById('late'))
      return Array.from(frame.contentDocument.querySelectorAll('p')).map((node) => node.textContent.trim().slice(0, 24))
    })
    const startIndex = paragraphs.indexOf(start.text)
    const endIndex = paragraphs.indexOf(end.text)
    expect(Math.abs(endIndex - startIndex), 'scrolling ' + delta + 'px while the picture changes moves about one paragraph at most').toBeLessThanOrEqual(1)
  }
})

function styledXhtml(style, body) {
  return strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>c</title><style type="text/css">'
      + style
      + '</style></head><body>'
      + body
      + '</body></html>'
  )
}

const reservedPictureBook = smallBook(
  'reserved-pictures',
  {
    'c1.xhtml': xhtml(chapterBody(1)),
    'p2.xhtml': xhtml('<div><img alt="" src="front.png" /></div>'),
    'c3.xhtml': xhtml(chapterBody(3).replace('<p>3장 문단 20', '<div><img alt="" src="rear.png" /></div><p>3장 문단 20')),
    'p4.xhtml': xhtml('<div><img alt="" src="front.png" /></div>'),
    'c5.xhtml': xhtml(chapterBody(5)),
    'front.png': new Uint8Array(tallPng(1000, 1600)),
    'rear.png': new Uint8Array(tallPng(1200, 800)),
  },
  ['c1.xhtml', 'p2.xhtml', 'c3.xhtml', 'p4.xhtml', 'c5.xhtml']
)

const pictureStyleBook = smallBook(
  'picture-styles',
  {
    'cover.xhtml': styledXhtml(
      'html,body{height:100%;margin:0}',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 1000 1600" preserveAspectRatio="xMidYMid meet"><image width="1000" height="1600" xlink:href="front.png" /></svg>'
    ),
    'c1.xhtml': styledXhtml(
      '.fixed{height:200px}.w10{width:10%}',
      '<p>그림 크기 확인 문단입니다.</p><div><img id="fixed" class="fixed" alt="" src="front.png" /></div><div><img id="narrow" class="w10" alt="" src="front.png" /></div><div><img id="plain" alt="" src="rear.png" /></div>'
        + chapterBody(1)
    ),
    'front.png': new Uint8Array(tallPng(1000, 1600)),
    'rear.png': new Uint8Array(tallPng(1200, 800)),
  },
  ['cover.xhtml', 'c1.xhtml']
)

test('Picture sizes keep book styles, ratios and SVG covers intact', async ({ page }) => {
  await openReader(page, pictureStyleBook)
  const cover = await page.evaluate(() => {
    const frame = document.querySelector('#epub-reader iframe')
    const svg = frame && frame.contentDocument && frame.contentDocument.querySelector('svg')
    return svg ? Math.round(svg.getBoundingClientRect().height) : 0
  })
  expect(cover, 'the SVG cover is drawn').toBeGreaterThan(200)

  await page.mouse.move(195, 500)
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 300)
      return page.evaluate(() =>
        Array.from(document.querySelectorAll('#epub-reader iframe')).some(
          (frame) => frame.contentDocument && frame.contentDocument.getElementById('fixed')
        )
      )
    })
    .toBe(true)
  await page.waitForTimeout(1000)
  const sizes = await page.evaluate(() => {
    const frame = Array.from(document.querySelectorAll('#epub-reader iframe')).find(
      (candidate) => candidate.contentDocument && candidate.contentDocument.getElementById('fixed')
    )
    const box = (id) => {
      const rect = frame.contentDocument.getElementById(id).getBoundingClientRect()
      return { width: Math.round(rect.width), height: Math.round(rect.height) }
    }
    return { fixed: box('fixed'), narrow: box('narrow'), plain: box('plain') }
  })
  expect(sizes.fixed.height, 'book CSS that fixes the height still wins').toBe(200)
  expect(Math.abs(sizes.narrow.height - sizes.narrow.width * 1.6), 'a picture sized only by width keeps its ratio').toBeLessThanOrEqual(2)
  expect(Math.abs(sizes.plain.height - sizes.plain.width * (800 / 1200)), 'a plain picture keeps its ratio').toBeLessThanOrEqual(2)
})

const manyPicturePagesBook = smallBook(
  'many-picture-pages',
  {
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => ['p' + index + '.xhtml', xhtml('<div><img alt="" src="front.png" /></div>')])
    ),
    'c1.xhtml': xhtml(chapterBody(1)),
    'c2.xhtml': xhtml(chapterBody(2)),
    'front.png': new Uint8Array(tallPng(1000, 1600)),
  },
  [...Array.from({ length: 12 }, (_, index) => 'p' + index + '.xhtml'), 'c1.xhtml', 'c2.xhtml']
)

const tinyChaptersBook = smallBook(
  'tiny-chapters',
  Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [
      't' + index + '.xhtml',
      xhtml('<h1>' + (index + 1) + '장</h1><p>' + (index + 1) + '장의 짧은 문단입니다.</p>'),
    ])
  ),
  Array.from({ length: 30 }, (_, index) => 't' + index + '.xhtml')
)

async function travelToEnd(page, delta) {
  const edge = () =>
    page.evaluate((down) => {
      const manager = window.__rendition.manager
      const container = manager.container
      return down
        ? !manager.views.last().section.next() && container.scrollTop + container.clientHeight >= container.scrollHeight - 2
        : !manager.views.first().section.prev() && container.scrollTop === 0
    }, delta > 0)
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    if (await edge()) return true
    await page.mouse.wheel(0, delta)
    await page.waitForTimeout(60)
  }
  return edge()
}

for (const [name, book] of [
  ['many picture pages in a row', manyPicturePagesBook],
  ['a long chain of very short chapters', tinyChaptersBook],
]) {
  test('Scrolling through ' + name + ' reaches both ends without stalling or jumping up', async ({ page }) => {
    await captureRendition(page)
    await openReader(page, book)
    await page.mouse.move(195, 500)
    expect(await travelToEnd(page, 900), 'reaches the last chapter').toBe(true)
    await watchVisibleJumps(page)
    expect(await travelToEnd(page, -900), 'reaches the first chapter').toBe(true)
    expect(await page.evaluate(() => window.__jumps), 'no visible jumps on the way up').toEqual([])
  })
}

test('Reopening at the start and the end with a slow position response lands on that chapter', async ({ page }) => {
  await captureRendition(page)
  const state = await openReader(page, reservedPictureBook)
  state.keepServerPosition = true
  for (const [href, index, delay] of [
    ['c5.xhtml', 4, 300],
    ['c1.xhtml', 0, 150],
  ]) {
    state.serverPosition = { locator: '', href, chapterLabel: '' }
    state.loadProgressDelay = delay
    await page.reload()
    await expect
      .poll(() => page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).bookReady), {
        timeout: 8_000,
      })
      .toBe(true)
    await page.waitForTimeout(800)
    const landed = await page.evaluate(() => {
      const manager = window.__rendition.manager
      const top = manager.container.getBoundingClientRect().top
      const view = manager.views.all().find((candidate) => {
        const box = candidate.element.getBoundingClientRect()
        return box.bottom > top + 1 && box.height > 50
      })
      return view ? view.section.index : -1
    })
    expect(landed, 'reopening at ' + href).toBe(index)
  }
})

// iOS Safari는 스크롤하며 주소창·도구막대를 접어 화면 높이만 바꾸는데, 그때마다 모든 챕터를 다시 그려 흰 화면과 위치 튐이 생겼습니다.
test('A height-only screen change keeps the drawn chapters and the reading spot without a blank frame', async ({
  page,
}) => {
  await openReader(page)
  await goToChapter(page, 3)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(1200)
  const spot = await readingSpot(page)

  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    window.__frames = new Set(container.querySelectorAll('iframe'))
    window.__blankFrames = 0
    const sample = () => {
      const box = container.getBoundingClientRect()
      const covered = Array.from(container.querySelectorAll('iframe')).some((frame) => {
        const bounds = frame.getBoundingClientRect()
        return (
          bounds.height > 0
          && bounds.top < box.bottom
          && bounds.bottom > box.top
          && window.getComputedStyle(frame).visibility !== 'hidden'
        )
      })
      if (!covered) window.__blankFrames += 1
      window.__sampling = window.requestAnimationFrame(sample)
    }
    sample()
  })

  for (const height of [770, 742, 800, 844]) {
    await page.setViewportSize({ width: 390, height })
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(800)

  const result = await page.evaluate(() => {
    window.cancelAnimationFrame(window.__sampling)
    const frames = Array.from(document.querySelectorAll('#epub-reader .epub-container iframe'))
    return { blank: window.__blankFrames, kept: frames.every((frame) => window.__frames.has(frame)) }
  })
  expect(result.blank, 'no frame without a visible chapter').toBe(0)
  expect(result.kept, 'the drawn chapters are not redrawn').toBe(true)
  expect(await readingSpot(page), 'the same paragraph stays at the top').toBe(spot)
})

const adminReaderBody = renderReaderBody('reading', { showAudioDetail: true })
const READER_DIAGNOSTICS_ON_KEY = 'booklog-reader-diagnostics-on:feature-user:feature-hash'
const READER_DIAGNOSTICS_KEY = 'booklog-reader-diagnostics:feature-user:feature-hash'

function readerDiagnostics(page) {
  return page.evaluate(() => JSON.parse(window.booklogReaderDiagnostics.exportText()).events)
}

function diagnosticEvents(list, name) {
  return list.filter((entry) => entry.event === name)
}

function waitForReaderReady(page) {
  return expect
    .poll(
      () =>
        page.evaluate(() => {
          const root = document.querySelector('section[x-data]')
          const data = window.Alpine && root ? window.Alpine.$data(root) : null
          return !!(data && data.bookReady && !data.loading)
        }),
      { timeout: 20_000 }
    )
    .toBe(true)
}

async function openScrollDiagnostics(page) {
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('section[x-data]')).controlsVisible = true
  })
  await page.getByLabel('스크롤 진단', { exact: true }).click()
}

function enableDiagnosticsBeforeLoad(page) {
  return page.addInitScript((key) => localStorage.setItem(key, String(Date.now())), READER_DIAGNOSTICS_ON_KEY)
}

test('Scroll diagnostics stay off until started and then record the whole reopen with its causes', async ({ page }) => {
  const state = await mockReader(page, featureBook, adminReaderBody)
  state.serverPosition = { locator: 'epubcfi(/6/6!/4/2/1:0)', href: 'c3.xhtml', chapterLabel: '3장' }
  await page.goto('/books/book/read')
  await waitForReaderReady(page)

  expect(await readerDiagnostics(page), 'nothing is recorded before starting').toEqual([])
  expect(await page.evaluate((key) => localStorage.getItem(key), READER_DIAGNOSTICS_ON_KEY)).toBeNull()

  await openScrollDiagnostics(page)
  const toggle = page.locator('#reader-scroll-diagnostics-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveText('기록 중지')
  await expect(page.locator('#reader-scroll-diagnostics-status')).toContainText('기록을 시작했습니다')

  await page.reload()
  await waitForReaderReady(page)
  await expect
    .poll(async () => diagnosticEvents(await readerDiagnostics(page), 'progress-locations-ready').length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
  await page.waitForTimeout(500)
  const events = await readerDiagnostics(page)
  const reopen = events.filter((entry) => entry.page === events.at(-1).page)
  const names = reopen.map((entry) => entry.event)

  const start = diagnosticEvents(reopen, 'diagnostics-start')[0]
  expect(start.details.reason, 'recording continues after reopening').toBe('reopen')
  expect(start.details).toEqual(
    expect.objectContaining({ userAgent: expect.any(String), standalone: false, dpr: expect.any(Number) })
  )
  expect(start.details.viewport.inner).toBe('390x844')

  const restoreMove = reopen.findIndex(
    (entry) => entry.event === 'display-start' && entry.details.target.includes('/6/6!')
  )
  const restoreMoveDone = reopen.findIndex(
    (entry, index) => index > restoreMove && entry.event === 'display-done' && entry.details.target.includes('/6/6!')
  )
  const order = ['reader-init', 'book-rendered', 'restore-start', 'restore-position-received']
  const positions = order
    .map((name) => names.indexOf(name))
    .concat([restoreMove, restoreMoveDone])
    .concat(['restore-landed', 'reader-ready'].map((name) => names.indexOf(name)))
  expect(
    positions.every((position) => position >= 0),
    'every lifecycle step is recorded: ' + names.join(',')
  ).toBe(true)
  expect(
    [...positions].sort((left, right) => left - right),
    'in the order they happen: ' + names.join(',')
  ).toEqual(positions)
  expect(names.some((name) => name === 'book-cache-hit' || name === 'book-cache-miss')).toBe(true)
  expect(names, 'progress locations are recorded whether cached or generated').toContain('progress-locations-ready')

  const request = reopen.findIndex((entry) => entry.event === 'display-at' && entry.details.target.includes('/6/6!'))
  expect(request, 'the move request is recorded before the redraw').toBeGreaterThan(names.indexOf('restore-start'))
  expect(request).toBeLessThan(restoreMove)
  expect(reopen[request].details.waitsForQueue).toEqual(expect.any(Boolean))
  expect(diagnosticEvents(reopen, 'restore-position-received')[0].details.href).toBe('c3.xhtml')

  const progress = diagnosticEvents(reopen, 'progress-change').find((entry) => entry.details.href.includes('c3'))
  expect(progress, 'the percent after reaching the saved chapter is recorded with where it came from').toBeTruthy()
  expect(progress.details.from).toEqual(expect.any(String))
  expect(Number(progress.details.to)).toBeGreaterThan(30)

  const snapshot = reopen.filter((entry) => entry.state && entry.state.views).at(-1).state
  expect(reopen.at(-1).state, 'frequent records keep a light state').toEqual(
    expect.objectContaining({ progress: expect.any(String), scrollTop: expect.any(Number) })
  )
  expect(snapshot).toEqual(
    expect.objectContaining({
      ready: true,
      loading: false,
      locations: 'ready',
      scrollTop: expect.any(Number),
      clientHeight: expect.any(Number),
      views: expect.any(Array),
    })
  )
  expect(snapshot.views.length).toBeGreaterThan(0)
  expect(snapshot.views[0]).toHaveLength(5)
  expect(diagnosticEvents(reopen, 'view-prepared')[0].details).toEqual(
    expect.objectContaining({ index: expect.any(Number), hooksMs: expect.any(Number), fontsMs: expect.any(Number) })
  )
  expect(JSON.stringify(events), 'book text is never recorded').not.toContain('책을 천천히 읽으며')
})

test('Scroll diagnostics name a full redraw, its blank frames, skipped height-only resizes and chapter attaches', async ({
  page,
}) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page, featureBook, adminReaderBody)
  await goToChapter(page, 3)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(1500)
  const scrolled = await readerDiagnostics(page)
  expect(diagnosticEvents(scrolled, 'view-append').length, 'attached chapters are recorded').toBeGreaterThan(0)
  expect(diagnosticEvents(scrolled, 'view-resized').length).toBeGreaterThan(0)
  expect(diagnosticEvents(scrolled, 'relocated').length).toBeGreaterThan(0)
  const before = scrolled.length

  await page.setViewportSize({ width: 390, height: 742 })
  await page.waitForTimeout(800)
  const heightOnly = (await readerDiagnostics(page)).slice(before)
  expect(diagnosticEvents(heightOnly, 'window-resize').length, 'the browser resize itself is recorded').toBeGreaterThan(
    0
  )
  expect(diagnosticEvents(heightOnly, 'manager-resize').at(-1).details).toEqual(
    expect.objectContaining({ heightOnly: true, to: '390x742' })
  )
  expect(diagnosticEvents(heightOnly, 'manager-clear'), 'a height-only change does not redraw').toEqual([])
  const afterHeight = before + heightOnly.length

  await page.setViewportSize({ width: 360, height: 742 })
  await expect
    .poll(async () => diagnosticEvents((await readerDiagnostics(page)).slice(afterHeight), 'display-done').length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0)
  await page.waitForTimeout(800)
  const widthChange = (await readerDiagnostics(page)).slice(afterHeight)
  expect(diagnosticEvents(widthChange, 'manager-resize').at(-1).details.heightOnly).toBe(false)
  const clear = diagnosticEvents(widthChange, 'manager-clear')[0]
  expect(clear.details.views, 'how many chapters were wiped').toBeGreaterThan(0)
  expect(clear.caller, 'the wipe is traced back to the resize').toEqual(expect.arrayContaining(['resize']))
  expect(
    diagnosticEvents(widthChange, 'display-start')[0].caller,
    'the redraw is traced back to the resize'
  ).toEqual(expect.arrayContaining(['onResized']))
  const blank = diagnosticEvents(widthChange, 'blank-end')
  expect(blank.length, 'the blank screen during the redraw is measured').toBeGreaterThan(0)
  expect(blank[0].details.ms).toBeGreaterThan(0)
  await page.setViewportSize({ width: 390, height: 844 })
})

test('Scroll diagnostics record the eight-second restore fallback with what was stuck', async ({ page }) => {
  test.setTimeout(60_000)
  await enableDiagnosticsBeforeLoad(page)
  await page.addInitScript(() => {
    let realEpub = null
    Object.defineProperty(window, 'ePub', {
      configurable: true,
      get: () =>
        realEpub
        && function (...args) {
          const book = realEpub(...args)
          const renderTo = book.renderTo.bind(book)
          book.renderTo = (...renderArgs) => {
            const rendition = renderTo(...renderArgs)
            const display = rendition.display.bind(rendition)
            rendition.display = (target) => {
              if (!window.__restoreHung && String(target || '').indexOf('/6/6!') >= 0) {
                window.__restoreHung = true
                return new Promise(() => {})
              }
              return display(target)
            }
            return rendition
          }
          return book
        },
      set: (value) => {
        realEpub = value
      },
    })
  })
  const state = await mockReader(page, featureBook, adminReaderBody)
  state.serverPosition = { locator: 'epubcfi(/6/6!/4/2/1:0)', href: 'c3.xhtml', chapterLabel: '3장' }
  await page.goto('/books/book/read')
  await waitForReaderReady(page)

  const events = await readerDiagnostics(page)
  const names = events.map((entry) => entry.event)
  const stuck = diagnosticEvents(events, 'display-start').find((entry) => entry.details.target.includes('/6/6!'))
  expect(stuck, 'the move that never finished is recorded').toBeTruthy()
  expect(
    diagnosticEvents(events, 'display-done').some((entry) => entry.details.target === stuck.details.target),
    'and it never reports done'
  ).toBe(false)
  for (const name of ['restore-timeout-rebuild', 'book-discard', 'restore-timeout-rebuilt', 'reader-ready']) {
    expect(names, name).toContain(name)
  }
  expect(names.indexOf('restore-timeout-rebuild')).toBeLessThan(names.indexOf('restore-timeout-rebuilt'))
  expect(names[names.indexOf('book-discard') - 1], 'the rebuild is what discarded the book').toBe(
    'restore-timeout-rebuild'
  )
  expect(
    diagnosticEvents(events, 'restore-timeout-rebuild')[0].state.restoring,
    'the stuck restore is visible in the state'
  ).toBe(true)
})

test('Clearing scroll diagnostics deletes the records and stops recording', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page, featureBook, adminReaderBody)
  expect((await readerDiagnostics(page)).length).toBeGreaterThan(0)

  await openScrollDiagnostics(page)
  await page.getByRole('button', { name: '기록 복사' }).click()
  await expect(page.locator('#reader-scroll-diagnostics-status')).toContainText('복사')
  await page.getByRole('button', { name: '기록 삭제' }).click()
  await expect(page.locator('#reader-scroll-diagnostics-status')).toContainText('삭제하고 기록을 중지했습니다')
  await expect(page.locator('#reader-scroll-diagnostics-toggle')).toHaveText('기록 시작')
  expect(await readerDiagnostics(page)).toEqual([])
  expect(
    await page.evaluate(
      (keys) => keys.map((key) => localStorage.getItem(key)),
      [READER_DIAGNOSTICS_ON_KEY, READER_DIAGNOSTICS_KEY]
    )
  ).toEqual([null, null])

  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('section[x-data]')).controlsVisible = false
  })
  await page.mouse.move(195, 500)
  await page.mouse.wheel(0, 800)
  await page.waitForTimeout(1500)
  expect(await readerDiagnostics(page), 'nothing more is recorded after stopping').toEqual([])
})

test('Readers without diagnostics see no diagnostics controls and record nothing', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page)
  await expect(page.getByLabel('스크롤 진단', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.booklogReaderDiagnostics.isEnabled())).toBe(false)
  expect(await page.evaluate((key) => localStorage.getItem(key), READER_DIAGNOSTICS_KEY)).toBeNull()
})

// iOS는 맨 위에서 더 당기면 바운스로 scrollTop이 음수가 되어, 막 붙인 앞 챕터가 화면 맨 위보다 아래에 놓입니다.
// 그때 보정을 건너뛰어 맨 위에 계속 머물렀고, 앞 챕터가 표지까지 연달아 붙어 처음으로 가 버렸습니다.
test('A chapter attached above while the top bounces below the screen edge keeps the reader in place', async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = '#epub-reader .epub-container { padding-top: 30px !important; box-sizing: border-box; }'
      document.head.appendChild(style)
    })
  })
  const state = await mockReader(page, featureBook)
  state.serverPosition = { locator: '', href: 'c5.xhtml', chapterLabel: '5장' }
  await page.goto('/books/book/read')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('section[x-data]')
        const data = window.Alpine && root ? window.Alpine.$data(root) : null
        return !!(data && data.bookReady && !data.loading)
      })
    )
    .toBe(true)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(2500)

  expect(await readingSpot(page), 'the reader stays just above chapter 5, not back at the start').toMatch(/^[45]장/)
  const sections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#epub-reader .epub-container iframe')).map(
      (frame) => frame.contentDocument?.querySelector('h1')?.textContent || ''
    )
  )
  expect(sections, 'earlier chapters are not attached in a chain').not.toContain('1장')
})

// iOS는 관성 스크롤 중에 코드가 바꾼 스크롤 위치를 덮어써, 위쪽 챕터를 지우며 줄인 위치가 되돌아가 흰 화면 뒤 진행률이 크게 건너뛰었습니다.
const twelveChapterBook = buildBook(12)

test('Chapters above are removed only after scrolling stops, not while the reader keeps scrolling', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page, twelveChapterBook, adminReaderBody)
  await page.mouse.move(195, 500)
  const startedAt = await page.evaluate(() => performance.now())
  // 관성 스크롤이 느려지는 끝 무렵처럼, epub.js가 정리를 시작하는 0.25초보다 긴 간격으로 계속 움직입니다.
  for (let step = 0; step < 32; step += 1) {
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(350)
  }
  const stoppedAt = await page.evaluate(() => performance.now())
  await page.waitForTimeout(2000)

  expect(
    await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).currentProgressPercent),
    'scrolling stopped before the end of the book'
  ).not.toBe('100')
  const events = (await readerDiagnostics(page)).filter((entry) => entry.t > startedAt)
  const removedWhileScrolling = events.filter((entry) => entry.event === 'view-remove' && entry.t < stoppedAt)
  expect(removedWhileScrolling, 'no chapter above is removed while scrolling').toEqual([])
  expect(
    events.some((entry) => entry.event === 'trim-deferred' && entry.t < stoppedAt),
    'the cleanup was put off'
  ).toBe(true)
  expect(
    events.some((entry) => entry.event === 'view-remove' && entry.t > stoppedAt),
    'and done once scrolling stopped'
  ).toBe(true)
  expect(await readingSpot(page), 'reading went on past the first chapters').toMatch(/^([4-9]|1[01])장/)
  const frames = await page.evaluate(() => document.querySelectorAll('#epub-reader iframe').length)
  expect(frames, 'the chapters left above were cleaned up').toBeLessThanOrEqual(3)
})

test('Scroll diagnostics show whether each correction was applied, skipped or overwritten', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await captureRendition(page)
  const state = await openReader(page, lateImageBook, adminReaderBody)
  state.serverPosition = { locator: '', href: 'c3.xhtml', chapterLabel: '' }
  await page.reload()
  await waitForReaderReady(page)
  await page.waitForTimeout(1200)
  const opened = await readerDiagnostics(page)
  expect(diagnosticEvents(opened, 'refill-after-move').length, 'the re-check after the restore move is recorded').toBeGreaterThan(0)
  const counter = diagnosticEvents(opened, 'scroll-write').find((entry) => entry.details.kind === 'counter')
  expect(counter, 'a chapter attached above records the scroll it wrote').toBeTruthy()
  expect(counter.details).toEqual(
    expect.objectContaining({ before: expect.any(Number), written: expect.any(Number), next: expect.any(Number) })
  )
  expect(counter.details.written - counter.details.before, 'it moved by the attached height').toBe(counter.details.delta)
  expect(counter.details.reverted, 'the browser kept the written position').toBe(false)

  await page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    const frame = Array.from(container.querySelectorAll('iframe')).find(
      (candidate) => candidate.contentDocument && candidate.contentDocument.getElementById('late')
    )
    const paragraph = frame.contentDocument.querySelectorAll('p')[12]
    container.scrollTop +=
      frame.getBoundingClientRect().top + paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top
  })
  await page.waitForTimeout(800)
  const before = (await readerDiagnostics(page)).length
  await growLateImage(page, 700)
  await page.waitForTimeout(800)
  const grown = (await readerDiagnostics(page)).slice(before)
  const resized = diagnosticEvents(grown, 'view-resized').find((entry) => entry.details.delta > 0)
  expect(resized.details.position, 'the resize says the chapter straddled the top of the screen').toBe('straddling')
  const skipped = diagnosticEvents(grown, 'counter-skipped')[0]
  expect(skipped, 'a straddling chapter that grew is recorded as not countered').toBeTruthy()
  expect(skipped.details.viewTop, 'with where it sat on screen').toBeLessThan(0)
  expect(skipped.details).toEqual(expect.objectContaining({ delta: resized.details.delta, scrollTop: expect.any(Number) }))
  const anchor = diagnosticEvents(grown, 'scroll-write').find((entry) => entry.details.kind === 'anchor')
  expect(anchor, 'the paragraph correction records its scroll write').toBeTruthy()
  expect(anchor.details.reverted).toBe(false)
})

test('Scroll diagnostics record the picture height fixes each chapter needed', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page, fullHeightPictureBook, adminReaderBody)
  await page.waitForTimeout(800)
  const fixes = diagnosticEvents(await readerDiagnostics(page), 'image-height-fix')
  expect(fixes.length, 'the cover fix is recorded').toBeGreaterThan(0)
  expect(fixes[0].details).toEqual(
    expect.objectContaining({
      index: expect.any(Number),
      collapsed: expect.any(Number),
      pictureOnly: expect.any(Number),
      svg: expect.any(Number),
    })
  )
  expect(fixes[0].details.collapsed + fixes[0].details.pictureOnly + fixes[0].details.svg).toBeGreaterThan(0)
})

test('Scroll diagnostics record removing chapters above after scrolling with the scroll it wrote', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page, twelveChapterBook, adminReaderBody)
  await page.mouse.move(195, 500)
  for (let step = 0; step < 32; step += 1) {
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(350)
  }
  await page.waitForTimeout(2000)
  const events = await readerDiagnostics(page)
  const erase = diagnosticEvents(events, 'scroll-write').filter((entry) => entry.details.kind === 'erase-above')
  expect(erase.length, 'each removal above records its scroll write').toBeGreaterThan(0)
  expect(erase.every((entry) => typeof entry.details.reverted === 'boolean')).toBe(true)
})

test('Scroll diagnostics record why a chapter was not attached while sitting at the top edge', async ({ page }) => {
  await enableDiagnosticsBeforeLoad(page)
  await openReader(page, twelveChapterBook, adminReaderBody)
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('section[x-data]')).loading = true
  })
  await page.mouse.move(195, 500)
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(120)
  }
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('section[x-data]')).loading = false
  })
  const skips = diagnosticEvents(await readerDiagnostics(page), 'edge-skip')
  expect(skips.length, 'wheeling at the top while the reader is busy is recorded').toBeGreaterThan(0)
  expect(skips[0].details).toEqual(expect.objectContaining({ direction: 'prev', loading: true }))
  expect(skips.length, 'and kept to a few records').toBeLessThanOrEqual(2)
})
