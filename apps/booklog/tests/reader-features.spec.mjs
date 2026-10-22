/* global window, document */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const require = createRequire(new URL('../package.json', import.meta.url))
const { render } = require('pocketbase-ejs')
const { zipSync, strToU8 } = require('fflate')
const pagesRoot = new URL('../pb_hooks/pages/', import.meta.url)
test.use({ viewport: { width: 390, height: 844 } })
test.setTimeout(90_000)

const CHAPTER_COUNT = 5
const SEARCH_WORD = '은하수표지'

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
    const extra = chapter === 3 && index === 19 ? ' 여기에 ' + SEARCH_WORD + '가 숨어 있습니다.' : ''
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
    userId: 'feature-user',
    bookFileHash: 'feature-hash',
    epubReaderUrl: '/test.epub',
    initialShelfStatus: 'reading',
    aiAudioAvailable: false,
    bookTitle: '기능 확인',
    showAudioDetail: false,
  }
)

async function readForm(route) {
  const request = route.request()
  return new Request(request.url(), {
    method: 'POST',
    headers: request.headers(),
    body: request.postDataBuffer(),
  }).formData()
}

async function mockReader(page, book) {
  const state = { bookmarks: [], highlights: [], requests: [] }
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub') {
        return route.fulfill({ body: Buffer.from(book), contentType: 'application/epub+zip' })
      }
      if (url.pathname === '/api/books/load-progress') {
        return route.fulfill({ json: { ok: true, hasSavedPosition: false, locator: '', href: '' } })
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/xapi/')) {
        const form = route.request().method() === 'POST' ? await readForm(route) : new FormData()
        state.requests.push({ path: url.pathname, form: Object.fromEntries(form.entries()) })
        if (url.pathname === '/api/books/list-bookmarks')
          return route.fulfill({ json: { ok: true, bookmarks: state.bookmarks } })
        if (url.pathname === '/api/books/save-bookmark') {
          const bookmark = {
            id: 'bookmark' + (state.bookmarks.length + 1),
            locator: form.get('locator'),
            href: form.get('href'),
            chapterLabel: form.get('chapterLabel'),
            progressPercent: form.get('progressPercent'),
          }
          state.bookmarks.unshift(bookmark)
          return route.fulfill({ json: { ok: true, message: '책갈피를 저장했습니다.', bookmark } })
        }
        if (url.pathname === '/api/books/delete-bookmark') {
          state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== form.get('bookmarkId'))
          return route.fulfill({ json: { ok: true, message: '책갈피를 삭제했습니다.' } })
        }
        if (url.pathname === '/api/books/list-highlights') {
          return route.fulfill({ json: { ok: true, highlights: state.highlights } })
        }
        if (url.pathname === '/api/books/save-highlight') {
          state.highlights.unshift({
            id: 'highlight' + (state.highlights.length + 1),
            quoteText: form.get('quoteText'),
            noteText: form.get('noteText'),
            locator: form.get('locator'),
            href: form.get('href'),
            chapterLabel: form.get('chapterLabel'),
          })
          return route.fulfill({ json: { ok: true, message: '인상 깊은 문구를 저장했습니다.' } })
        }
        return route.fulfill({ json: { ok: true, id: 'session00000001' } })
      }
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[x-cloak]{display:none!important}</style><link rel="stylesheet" href="/assets/uno.min.css"><link rel="stylesheet" href="/assets/style.css"><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body class="m-0">'
          + readerBody
          + '</body></html>',
      })
    }
  )
  return state
}

async function openReader(page, book = featureBook) {
  const state = await mockReader(page, book)
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
