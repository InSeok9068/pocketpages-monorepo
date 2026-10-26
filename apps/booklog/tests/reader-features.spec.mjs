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

function renderReaderBody(initialShelfStatus) {
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
      showAudioDetail: false,
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
