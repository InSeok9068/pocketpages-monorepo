/* global window, document */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
  badRequest,
  bookmarkFromForm,
  listHighlightsPayload,
  loadProgressPayload,
  positionFromForm,
  progressConflict,
  readerApiInputError,
  readForm,
  readingSessionPayload,
  saveProgressPayload,
} from './fake-booklog-api.mjs'

// 내 컴퓨터에 있는 실제 EPUB으로만 도는 확인입니다. 폴더가 없으면 모두 건너뜁니다.
const require = createRequire(new URL('../package.json', import.meta.url))
const { render } = require('pocketbase-ejs')
const { unzipSync, strFromU8 } = require('fflate')
const pagesRoot = new URL('../pb_hooks/pages/', import.meta.url)
const bookDir = process.env.BOOKLOG_REAL_EPUB_DIR || 'C:/Users/kpcard/Desktop/업무/EPUB 파일'
const runAll = process.env.BOOKLOG_REAL_EPUB_ALL === '1'
// 평소에는 복원 위치 위로 그림이 늦게 그려지는 책 한 권만 엽니다. 전체는 BOOKLOG_REAL_EPUB_ALL=1로 돌립니다.
const representative = ['tyj74f164s']
const NOTE_REFERENCE = /epub:type="noteref"|<sup[^>]*>\s*<a\b[^>]*href="[^"]*#/

test.use({ viewport: { width: 390, height: 844 } })

const readerBody = render(
  readFileSync(new URL('(reader)/books/[bookId]/read.ejs', pagesRoot), 'utf8').replace(
    /<script server>[\s\S]*?<\/script>/,
    ''
  ),
  {
    asset: (value) => value,
    env: () => '',
    bookId: 'book',
    bookFileId: 'file',
    userId: 'real-book-user',
    bookFileHash: 'real-book-hash',
    epubReaderUrl: '/test.epub',
    initialShelfStatus: 'reading',
    aiAudioAvailable: false,
    bookTitle: '실제 책',
    showAudioDetail: false,
  }
)

function listBooks() {
  if (!existsSync(bookDir)) return []
  const names = readdirSync(bookDir)
    .filter((name) => /\.epub$/i.test(name))
    .sort()
  return runAll ? names : names.filter((name) => representative.some((key) => name.includes(key)))
}

// 주석 번호가 들어 있는 첫 본문 파일의 이름을 찾아, 그 챕터에서 주석 팝업을 확인합니다.
function findNoteFile(bytes) {
  const entries = unzipSync(bytes, { filter: (file) => /\.x?html?$/i.test(file.name) })
  const name = Object.keys(entries)
    .sort()
    .find((key) => NOTE_REFERENCE.test(strFromU8(entries[key])))
  return name ? path.posix.basename(name) : ''
}

async function mockReader(page, book) {
  const state = { serverPosition: null, saves: 0 }
  await page.addInitScript(() => {
    let realEpub = null
    Object.defineProperty(window, 'ePub', {
      configurable: true,
      get: () =>
        realEpub
        && function (...args) {
          const created = realEpub(...args)
          window.__book = created
          return created
        },
      set: (value) => {
        realEpub = value
      },
    })
  })
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub') return route.fulfill({ body: book, contentType: 'application/epub+zip' })
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/xapi/')) {
        const form = route.request().method() === 'POST' ? await readForm(route) : new FormData()
        const inputError = url.pathname.startsWith('/api/books/') ? readerApiInputError(url.pathname, form) : ''
        if (inputError) return badRequest(route, inputError)
        if (url.pathname === '/api/books/load-progress') {
          return route.fulfill({ json: loadProgressPayload(state.serverPosition) })
        }
        if (url.pathname === '/api/books/save-progress') {
          const conflict = progressConflict(state.serverPosition, form)
          if (conflict) return route.fulfill({ status: 409, json: conflict })
          state.serverPosition = positionFromForm(form)
          state.saves += 1
          return route.fulfill({ json: saveProgressPayload() })
        }
        if (url.pathname === '/api/books/list-bookmarks') return route.fulfill({ json: { ok: true, bookmarks: [] } })
        if (url.pathname === '/api/books/save-bookmark') {
          const bookmark = bookmarkFromForm('bookmark0000001', form)
          return route.fulfill({ json: { ok: true, message: '책갈피를 저장했습니다.', bookmark } })
        }
        if (url.pathname === '/api/books/list-highlights') {
          return route.fulfill({ json: listHighlightsPayload([], form) })
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
          + readerBody
          + '</body></html>',
      })
    }
  )
  return state
}

async function waitUntilReady(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const root = document.querySelector('section[x-data]')
          return !!(window.Alpine && root && !window.Alpine.$data(root).loading && window.__book)
        }),
      { timeout: 180_000 }
    )
    .toBe(true)
  await page.waitForTimeout(800)
}

function readerState(page) {
  return page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('section[x-data]'))
    const location = window.__book.rendition.currentLocation()
    const start = location && location.start ? location.start : {}
    return { error: data.errorMessage, href: String(start.href || ''), index: Number(start.index), cfi: start.cfi }
  })
}

// 화면 맨 위에 처음 보이는 글자부터 20자를 돌려줍니다.
function topText(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container')
    const top = container.getBoundingClientRect().top
    for (const frame of container.querySelectorAll('iframe')) {
      const doc = frame.contentDocument
      if (!doc || !doc.body) continue
      const frameTop = frame.getBoundingClientRect().top
      const walker = doc.createTreeWalker(doc.body, 4)
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.nodeValue.trim()) continue
        const range = doc.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        if (rect.height && frameTop + rect.bottom > top + 1) return node.nodeValue.trim().slice(0, 20)
      }
    }
    return ''
  })
}

function flatTocItems(page) {
  return page.evaluate(() => {
    const flat = []
    const walk = (items, path) =>
      (items || []).forEach((item, index) => {
        flat.push({ path: path.concat(index), href: String(item.href || ''), label: String(item.label || '') })
        walk(item.children || item.subitems, path.concat(index))
      })
    walk(window.Alpine.$data(document.querySelector('section[x-data]')).tocItems, [])
    return flat.filter((item) => item.href)
  })
}

function goToTocItem(page, itemPath) {
  return page.evaluate((itemPath) => {
    const data = window.Alpine.$data(document.querySelector('section[x-data]'))
    let item = null
    let items = data.tocItems
    itemPath.forEach((index) => {
      item = items[index]
      items = item.children || item.subitems || []
    })
    data.goToTocItem(item)
  }, itemPath)
}

// 짧은 마지막 장(판권·END)은 화면 맨 위로 올릴 공간이 없어, 위치 대신 그 장이 화면에 보이는지로 확인합니다.
function isSectionOnScreen(page, href) {
  return page.evaluate((href) => {
    const file = href.split('#')[0].split('/').pop()
    const container = document.querySelector('#epub-reader .epub-container').getBoundingClientRect()
    return window.__book.rendition.manager.views.all().some((view) => {
      if (view.section.href.split('/').pop() !== file) return false
      const rect = view.element.getBoundingClientRect()
      return rect.bottom > container.top + 1 && rect.top < container.bottom - 1
    })
  }, href)
}

// 표지처럼 그림만 있는 화면도 내용이 보이는 것으로 칩니다.
function hasVisibleContent(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#epub-reader .epub-container').getBoundingClientRect()
    for (const frame of document.querySelectorAll('#epub-reader iframe')) {
      const doc = frame.contentDocument
      if (!doc || !doc.body) continue
      const frameTop = frame.getBoundingClientRect().top
      for (const node of doc.querySelectorAll('img, image, svg, p, h1, h2, h3, div, span')) {
        const rect = node.getBoundingClientRect()
        const visible =
          rect.width > 0
          && rect.height > 0
          && frameTop + rect.bottom > container.top
          && frameTop + rect.top < container.bottom
        if (visible && (/^(img|image|svg)$/i.test(node.tagName) || node.textContent.trim())) return true
      }
    }
    return false
  })
}

const sameFile = (left, right) =>
  path.posix.basename(String(left).split('#')[0]) === path.posix.basename(String(right).split('#')[0])

for (const name of listBooks()) {
  const short = name.replace(/^.*z_lib_|^z_library_|\.sk|\.epub$/g, '').slice(0, 24)

  test(`Real book ${short} opens, moves, scrolls and reopens in its chapter`, async ({ page, browserName }) => {
    test.skip(browserName === 'webkit' && runAll, 'All books run on Chrome; WebKit covers the representative set.')
    test.setTimeout(600_000)
    const bytes = readFileSync(path.join(bookDir, name))
    const noteFile = findNoteFile(bytes)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const state = await mockReader(page, bytes)
    const sizeMb = Math.round(statSync(path.join(bookDir, name)).size / 104857.6) / 10
    test.info().annotations.push({ type: 'book', description: name + ' (' + sizeMb + 'MB)' })

    await page.goto('/books/book/read')
    await waitUntilReady(page)
    expect((await readerState(page)).error, 'opens without an error').toBe('')
    expect(await hasVisibleContent(page), 'the first screen shows text or a picture').toBe(true)

    const toc = await flatTocItems(page)
    if (toc.length > 1) {
      for (const item of [toc[Math.floor(toc.length / 2)], toc[toc.length - 1]]) {
        await goToTocItem(page, item.path)
        await expect
          .poll(() => isSectionOnScreen(page, item.href), {
            timeout: 60_000,
            message: 'moves to ' + item.label,
          })
          .toBe(true)
        await page.waitForTimeout(800)
        expect((await readerState(page)).error, 'no error after moving to ' + item.label).toBe('')
      }
      await goToTocItem(page, toc[Math.floor(toc.length / 2)].path)
      await expect
        .poll(async () => sameFile((await readerState(page)).href, toc[Math.floor(toc.length / 2)].href), {
          timeout: 60_000,
        })
        .toBe(true)
      await page.waitForTimeout(800)
    }

    // 긴 챕터를 휠로만 내려가면 너무 오래 걸려 끝에서 몇 화면 앞까지 옮깁니다. 목차 이동 직후 epub.js가 첫 스크롤을 무시하므로, 나머지는 휠로 내려가야 다음 챕터가 붙습니다.
    const before = await readerState(page)
    await page.evaluate((index) => {
      const view = window.__book.rendition.manager.views.all().find((item) => item.section.index === index)
      const container = document.querySelector('#epub-reader .epub-container')
      if (!view) return
      const bottom = view.element.getBoundingClientRect().bottom - container.getBoundingClientRect().top
      container.scrollTop += Math.max(0, bottom - container.clientHeight * 4)
    }, before.index)
    await page.mouse.move(195, 420)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 600)
          await page.waitForTimeout(250)
          return (await readerState(page)).index
        },
        { timeout: 90_000, message: 'scrolling crosses into the next chapter' }
      )
      .toBeGreaterThan(before.index)
    await page.waitForTimeout(1200)
    expect(await hasVisibleContent(page), 'the next chapter shows text or a picture').toBe(true)

    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(1200)
    const savesBefore = state.saves
    await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
    await expect.poll(() => state.saves, { timeout: 30_000 }).toBeGreaterThan(savesBefore)
    const saved = state.serverPosition
    await page.reload()
    await waitUntilReady(page)
    const restored = await readerState(page)
    expect(restored.error, 'reopens without an error').toBe('')
    // 그림이 늦게 그려지면 몇 줄 밀릴 수 있어(알려진 한계), 실제 책에서는 같은 챕터로 돌아오는지까지만 봅니다.
    expect(sameFile(restored.href, saved.href), 'reopens in the saved chapter').toBe(true)

    if (noteFile) {
      await page.evaluate((file) => {
        const section = window.__book.spine.spineItems.find((item) => item.href.split('/').pop() === file)
        return window.__book.rendition.display(section.href)
      }, noteFile)
      await page.waitForTimeout(1500)
      const focused = await page.evaluate((file) => {
        const view = window.__book.rendition.manager.views
          .all()
          .find((item) => item.section.href.split('/').pop() === file && item.contents)
        if (!view) return 'no-view'
        const link = view.contents.document.querySelector('a[data-booklog-note-href]')
        if (!link) return 'no-note-link'
        link.focus()
        return 'focused'
      }, noteFile)
      expect(focused, 'the chapter with note numbers has a note link the reader can open').toBe('focused')
      await expect(page.locator('#reader-note-sheet')).toBeVisible({ timeout: 10_000 })
      expect(
        await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).noteText.length),
        'the note sheet shows the note text'
      ).toBeGreaterThan(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('#reader-note-sheet')).toBeHidden()
    }

    const word = (await topText(page)).match(/[가-힣A-Za-z]{2,}/)?.[0]
    if (word) {
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
      await page.getByRole('button', { name: '검색', exact: true }).click()
      const input = page.locator('#reader-search-input')
      await input.fill(word)
      await input.press('Enter')
      await expect(page.getByText(/개의 결과를 찾았습니다\./), 'searching for "' + word + '" finds it').toBeVisible({
        timeout: 180_000,
      })
    }

    expect(errors, 'no script errors').toEqual([])
  })
}

test('Real book folder is available for the local check', () => {
  test.skip(!existsSync(bookDir), 'Real EPUB folder not found: ' + bookDir)
  expect(listBooks().length).toBeGreaterThan(0)
})
