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

const renderReaderBody = (aiAudioAvailable) => render(
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
    aiAudioAvailable,
    bookTitle: '이동 테스트',
    showAudioDetail: false,
  }
)
const readerBody = renderReaderBody(false)

function html(body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>[x-cloak]{display:none!important}</style><link rel="stylesheet" href="/assets/uno.min.css"><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body>'
    + body
    + '</body></html>'
  )
}

async function mockSite(page, options) {
  const requests = { detail: 0, saveProgress: 0, saveForms: [], savedLocators: [] }
  const savedHref = options && options.savedHref ? options.savedHref : ''
  const savedLocator = options && options.savedLocator ? options.savedLocator : ''
  const epubBytes = Buffer.from(options && options.epub ? options.epub : epub)
  await page.route(
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      }
      if (url.pathname === '/test.epub') return route.fulfill({ body: epubBytes, contentType: 'application/epub+zip' })
      if (url.pathname === '/api/books/load-progress') {
        return route.fulfill({
          json: { ok: true, hasSavedPosition: !!(savedHref || savedLocator), locator: savedLocator, href: savedHref },
        })
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
        requests.savedLocators.push(form.get('locator'))
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
      return route.fulfill({
        contentType: 'text/html',
        body: html(options && options.aiAudio ? renderReaderBody(true) : readerBody),
      })
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

test('Browser back after reloading the reader still returns to the book detail page', async ({ page }) => {
  await mockSite(page)
  await page.goto('/books/book')
  await page.getByRole('link', { name: '읽기' }).click()
  await waitForReader(page)
  for (let index = 0; index < 2; index += 1) {
    await page.reload()
    await waitForReader(page)
  }

  expect(await page.evaluate(() => window.history.length), 'reloading does not stack reader entries').toBe(4)

  await page.goBack()
  await expect(page).toHaveURL(/\/books\/book$/)
  await expect(page.getByRole('heading', { name: '책 상세' })).toBeVisible()
  expect(await page.evaluate(() => window.history.length), 'returned with history.back, not a new entry').toBe(4)
})

test('A saved position missing from this file does not block saving the new position', async ({ page }) => {
  const requests = await mockSite(page, { savedHref: 'chapter-from-another-file.xhtml' })
  await page.goto('/books/book/read')
  await waitForReader(page)

  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect.poll(() => requests.savedLocators.length).toBeGreaterThan(0)
  expect(requests.saveForms[0].baseLocator, 'the first save replaces the position this file does not have').toBe(
    'chapter-from-another-file.xhtml'
  )
  expect(
    await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).errorMessage)
  ).toBe('')
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

test('A saved position near the end of a short chapter is restored to the top of the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const paragraphs = (chapter, count) =>
    Array.from({ length: count }, (_, index) => '<p>' + chapter + ' 문단 ' + (index + 1) + ' 짧은 챕터의 끝부분까지 이어지는 본문입니다.</p>').join('')
  const shortChapters = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">short-chapters</dc:identifier><dc:title>짧은 챕터</dc:title></metadata><manifest><item id="zero" href="zero.xhtml" media-type="application/xhtml+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="zero"/><itemref idref="one"/><itemref idref="two"/></spine></package>'
    ),
    'zero.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + paragraphs('서문', 200) + '</body></html>'),
    'one.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + paragraphs('첫째', 30) + '</body></html>'),
    'two.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + paragraphs('둘째', 30) + '</body></html>'),
  })
  await mockSite(page, { epub: shortChapters, savedLocator: 'epubcfi(/6/4!/4/56/1:0)' })
  await page.goto('/books/book/read')
  await waitForReader(page)

  const top = await page.evaluate(() => {
    const readerTop = document.querySelector('#epub-reader').getBoundingClientRect().top
    for (const frame of document.querySelectorAll('#epub-reader iframe')) {
      const frameTop = frame.getBoundingClientRect().top
      for (const paragraph of frame.contentDocument.querySelectorAll('p')) {
        if (frameTop + paragraph.getBoundingClientRect().bottom > readerTop + 1) return paragraph.textContent.trim()
      }
    }
    return ''
  })
  expect(top).toContain('첫째 문단 28')
})

test('Leaving with only the bottom of a picture page above the text saves the text position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const xhtml = (body) => strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>')
  const pictureBook = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">picture-page</dc:identifier><dc:title>그림 페이지</dc:title></metadata><manifest><item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/><item id="picture" href="picture.xhtml" media-type="application/xhtml+xml"/><item id="next" href="next.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="intro"/><itemref idref="picture"/><itemref idref="next"/></spine></package>'
    ),
    'intro.xhtml': xhtml(Array.from({ length: 200 }, (_, index) => '<p>서문 ' + (index + 1) + '</p>').join('')),
    'picture.xhtml': xhtml('<div style="height:1500px;background:#ddd"></div>'),
    'next.xhtml': xhtml(Array.from({ length: 40 }, (_, index) => '<p>다음 장 문단 ' + (index + 1) + '</p>').join('')),
  })
  const requests = await mockSite(page, { epub: pictureBook, savedLocator: 'epubcfi(/6/6!/4/2/1:0)', aiAudio: true })
  await page.goto('/books/book/read')
  await waitForReader(page)
  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('#epub-reader, #epub-reader *')].find(
      (element) => element.scrollHeight > element.clientHeight + 10 && /auto|scroll/.test(window.getComputedStyle(element).overflowY)
    )
    scroller.scrollTop -= 100
  })
  await page.waitForTimeout(1000)

  const highlightRequest = page.waitForRequest((request) => request.url().includes('/api/books/save-highlight'))
  await page.evaluate(() => {
    const reader = window.Alpine.$data(document.querySelector('section[x-data]'))
    reader.highlightQuoteText = '직접 붙여 넣은 문구'
    reader.saveHighlight()
  })
  const highlightForm = await new Request('http://local/', {
    method: 'POST',
    headers: (await highlightRequest).headers(),
    body: (await highlightRequest).postDataBuffer(),
  }).formData()
  expect(highlightForm.get('locator')).toMatch(/^epubcfi\(\/6\/6!/)
  expect(highlightForm.get('href')).toBe('next.xhtml')

  const audioRequest = page.waitForRequest((request) => request.url().includes('/api/books/audio-position'))
  await page.evaluate(() =>
    window.Alpine.$data(document.querySelector('section[x-data]')).startCloudAudioAtReadingPosition()
  )
  const audioQuery = new URL((await audioRequest).url()).searchParams
  expect(audioQuery.get('sectionIndex')).toBe('2')
  expect(audioQuery.get('anchor')).toMatch(/^다음 장 문단 1/)

  await page.evaluate(() => document.querySelector('a[aria-label="뒤로가기"]').click())
  await expect(page).toHaveURL(/\/books\/book$/)
  expect(requests.savedLocators.at(-1)).toMatch(/^epubcfi\(\/6\/6!/)
})

test('AI audio from the reading position starts at the first sentence on screen, not the paragraph start', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const xhtml = (body) => strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>')
  const sentences = Array.from({ length: 400 }, (_, index) => '문장 ' + (index + 1) + '입니다.').join(' ')
  const longParagraphBook = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">long-paragraph</dc:identifier><dc:title>긴 문단</dc:title></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'body.xhtml': xhtml('<p>' + sentences + '</p><p>다음 문단입니다.</p>'),
  })
  await mockSite(page, { epub: longParagraphBook, savedLocator: 'epubcfi(/6/2!/4/2/1:3000)', aiAudio: true })
  await page.goto('/books/book/read')
  await waitForReader(page)
  await page.waitForTimeout(1000)

  const audioRequest = page.waitForRequest((request) => request.url().includes('/api/books/audio-position'))
  await page.evaluate(() =>
    window.Alpine.$data(document.querySelector('section[x-data]')).startCloudAudioAtReadingPosition()
  )
  const anchor = new URL((await audioRequest).url()).searchParams.get('anchor')
  const sentence = Number((anchor.match(/^문장 (\d+)입니다\./) || [])[1])
  expect(sentence, anchor).toBeGreaterThan(250)
  expect(sentence, anchor).toBeLessThan(300)
})

test('Footnote number links are left out of the reading position text, like the AI narration text', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const xhtml = (body) => strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>')
  const sentences = Array.from(
    { length: 400 },
    (_, index) => '문장 ' + (index + 1) + '입니다.<sup><a href="notes.xhtml#n' + (index + 1) + '">' + (index + 1) + '</a></sup> '
  ).join('')
  const footnoteBook = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">footnotes</dc:identifier><dc:title>각주</dc:title></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'body.xhtml': xhtml('<p>' + sentences + '</p><p>다음 문단입니다.</p>'),
  })
  await mockSite(page, { epub: footnoteBook, savedLocator: 'epubcfi(/6/2!/4/2/541:1)', aiAudio: true })
  await page.goto('/books/book/read')
  await waitForReader(page)
  await page.waitForTimeout(1000)

  const audioRequest = page.waitForRequest((request) => request.url().includes('/api/books/audio-position'))
  await page.evaluate(() =>
    window.Alpine.$data(document.querySelector('section[x-data]')).startCloudAudioAtReadingPosition()
  )
  const anchor = new URL((await audioRequest).url()).searchParams.get('anchor')
  const sentence = Number((anchor.match(/^문장 (\d+)입니다\. 문장 (\d+)입니다\./) || [])[1])
  expect(sentence, anchor).toBeGreaterThan(250)
  expect(sentence, anchor).toBeLessThan(300)
})

test('Tapping a footnote number shows the note in a sheet without leaving the reading position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const xhtml = (body) =>
    strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>c</title></head><body>'
        + body
        + '</body></html>'
    )
  const filler = Array.from({ length: 60 }, (_, index) => '<p>본문 문단 ' + (index + 1) + '입니다.</p>').join('')
  const longNote = Array.from({ length: 30 }, (_, index) => '<p>긴 주석 문단 ' + (index + 1) + '입니다.</p>').join('')
  const noteBook = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">notes</dc:identifier><dc:title>주석</dc:title></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/><itemref idref="notes"/></spine></package>'
    ),
    'body.xhtml': xhtml(
      '<p>첫 주석이 붙은 문장입니다.<sup><a epub:type="noteref" id="r1" href="notes.xhtml#n1">1</a></sup> 둘째 주석입니다.<a id="r2" href="notes.xhtml#n2">[2]</a></p>'
        + filler
    ),
    'notes.xhtml': xhtml(
      '<aside epub:type="footnote" id="n1"><p><a href="body.xhtml#r1">1</a> 10<sup>9</sup>은 10억입니다.</p></aside><div id="n2"><p><a href="body.xhtml#r2">[2]</a> 긴 주석의 시작입니다.</p>'
        + longNote
        + '</div>'
    ),
  })
  const requests = await mockSite(page, { epub: noteBook })
  await page.goto('/books/book/read')
  await waitForReader(page)
  await page.waitForTimeout(800)
  const body = page.frameLocator('#epub-reader iframe').first()
  const sheet = page.locator('#reader-note-sheet')

  await body.locator('#r1').click()
  await expect(sheet).toBeVisible()
  await expect(page.locator('#reader-note-title')).toHaveText('주석 1')
  await expect(page.locator('#reader-note-text')).toHaveText('10⁹은 10억입니다.')
  await expect(body.locator('#r1')).toBeInViewport()

  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  await body.locator('#r2').click()
  await expect(page.locator('#reader-note-title')).toHaveText('주석 2')
  await expect(page.locator('#reader-note-text')).toContainText('긴 주석 문단 30입니다.')
  await expect(sheet).toBeVisible()
  await expect
    .poll(() => page.locator('#reader-note-text').evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await page.mouse.click(195, 40)
  await expect(sheet).toBeHidden()
  await expect(body.locator('#r2')).toBeInViewport()

  await page.evaluate(() => window.Alpine.$data(document.querySelector('section[x-data]')).saveCurrentPosition())
  await expect.poll(() => requests.savedLocators.length).toBeGreaterThan(0)
  expect(requests.savedLocators.at(-1)).toMatch(/^epubcfi\(\/6\/2!/)
})

test('AI audio highlights the paragraph being read and follows it only while the reader is watching it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const xhtml = (body) => strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>')
  const paragraphs = Array.from(
    { length: 60 },
    (_, index) => '<p>문단 ' + (index + 1) + '번째 이야기입니다. 듣는 위치를 화면에서 따라가는지 확인합니다.</p>'
  ).join('')
  const followBook = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">follow</dc:identifier><dc:title>따라가기</dc:title></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>'
    ),
    'body.xhtml': xhtml(paragraphs),
  })
  await mockSite(page, { epub: followBook, aiAudio: true })
  await page.goto('/books/book/read')
  await waitForReader(page)
  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    window.booklogAudio.currentAnchor = () => window.__listening
    window.Alpine.$data(document.querySelector('section[x-data]')).cloudAudioSession = true
  })
  const listen = (number) =>
    page.evaluate((text) => {
      window.__listening = { sectionIndex: 0, text }
    }, '문단 ' + number + '번째 이야기입니다.')
  const state = () =>
    page.evaluate(() => {
      const scroller = [...document.querySelectorAll('#epub-reader, #epub-reader *')].find(
        (element) => element.scrollHeight > element.clientHeight + 10 && /auto|scroll/.test(window.getComputedStyle(element).overflowY)
      )
      const frame = document.querySelector('#epub-reader iframe')
      const active = frame.contentDocument.querySelector('.booklog-listen-active')
      const box = active ? active.getBoundingClientRect() : null
      const top = box ? frame.getBoundingClientRect().top + box.top : null
      return {
        text: active ? active.textContent.split('.')[0] : '',
        onScreen: top !== null && top >= 0 && top < window.innerHeight,
        scrollTop: Math.round(scroller.scrollTop),
      }
    })

  await listen(2)
  await expect.poll(async () => (await state()).text).toBe('문단 2번째 이야기입니다')
  const atStart = await state()
  await listen(3)
  await expect.poll(async () => (await state()).text).toBe('문단 3번째 이야기입니다')
  expect((await state()).scrollTop, 'a visible next paragraph does not move the page').toBe(atStart.scrollTop)

  await listen(40)
  await expect.poll(async () => (await state()).text).toBe('문단 40번째 이야기입니다')
  await expect.poll(async () => (await state()).onScreen, 'the page follows a paragraph that left the screen').toBe(true)

  await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('#epub-reader, #epub-reader *')].find(
      (element) => element.scrollHeight > element.clientHeight + 10 && /auto|scroll/.test(window.getComputedStyle(element).overflowY)
    )
    scroller.scrollTop = 0
  })
  await page.waitForTimeout(500)
  await listen(41)
  await expect.poll(async () => (await state()).text).toBe('문단 41번째 이야기입니다')
  await page.waitForTimeout(1200)
  expect((await state()).scrollTop, 'a reader who scrolled away is not pulled back').toBeLessThan(50)

  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('section[x-data]')).cloudAudioDuration = 60
  })
  await page.getByRole('button', { name: '듣는 곳으로 이동' }).click()
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const frame = document.querySelector('#epub-reader iframe')
          const active = frame.contentDocument.querySelector('.booklog-listen-active')
          const top = active ? frame.getBoundingClientRect().top + active.getBoundingClientRect().top : null
          return top !== null && top > -16 && top < window.innerHeight / 2
        }),
      'the mini player button brings the listening paragraph back to the top of the screen'
    )
    .toBe(true)

  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('section[x-data]')).cloudAudioSession = false
  })
  await expect.poll(async () => (await state()).text, 'stopping clears the highlight').toBe('')
})

test('Restoring near the end of the last chapter does not wait for a chapter that will never load', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const xhtml = (body) => strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>')
  const lastChapterBook = zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'book.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">last-chapter</dc:identifier><dc:title>마지막 챕터</dc:title></metadata><manifest><item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/><item id="last" href="last.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="intro"/><itemref idref="last"/></spine></package>'
    ),
    'intro.xhtml': xhtml(Array.from({ length: 200 }, (_, index) => '<p>서문 ' + (index + 1) + '</p>').join('')),
    'last.xhtml': xhtml(Array.from({ length: 30 }, (_, index) => '<p>마지막 문단 ' + (index + 1) + '</p>').join('')),
  })
  await mockSite(page, { epub: lastChapterBook, savedLocator: 'epubcfi(/6/4!/4/56/1:0)' })
  const loadProgressAnswered = page.waitForResponse((response) => response.url().includes('/api/books/load-progress'))
  await page.goto('/books/book/read')
  await loadProgressAnswered
  const answeredAt = Date.now()
  await waitForReader(page)
  const restoreMs = Date.now() - answeredAt

  const top = await page.evaluate(() => {
    const readerTop = document.querySelector('#epub-reader').getBoundingClientRect().top
    for (const frame of document.querySelectorAll('#epub-reader iframe')) {
      const frameTop = frame.getBoundingClientRect().top
      for (const paragraph of frame.contentDocument.querySelectorAll('p')) {
        if (frameTop + paragraph.getBoundingClientRect().bottom > readerTop + 1) return paragraph.textContent.trim()
      }
    }
    return ''
  })
  expect(top).toContain('마지막 문단')
  expect(restoreMs).toBeLessThan(1000)
})
