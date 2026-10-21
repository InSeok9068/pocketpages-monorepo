/* global window, document */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const require = createRequire(new URL('../package.json', import.meta.url))
const { render } = require('pocketbase-ejs')
const { zipSync, strToU8 } = require('fflate')
const pagesRoot = new URL('../pb_hooks/pages/', import.meta.url)
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
test.setTimeout(120_000)

function makeBook({ image = false } = {}) {
  const files = {
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
  }
  let manifest = ''
  let spine = ''
  let nav = ''
  for (let chapter = 0; chapter < 12; chapter += 1) {
    const name = 'chapter-' + chapter + '.xhtml'
    manifest += '<item id="c' + chapter + '" href="' + name + '" media-type="application/xhtml+xml"/>'
    spine += '<itemref idref="c' + chapter + '"/>'
    nav += '<li><a href="' + name + '">챕터 ' + chapter + '</a></li>'
    let body = ''
    for (let paragraph = 0; paragraph < 25; paragraph += 1) {
      const ordinal = chapter * 25 + paragraph
      body +=
        '<p id="p'
        + ordinal
        + '" data-ordinal="'
        + ordinal
        + '">챕터 '
        + chapter
        + ' 문단 '
        + paragraph
        + '. 사용자가 손으로 스크롤하며 책을 읽습니다. 앞뒤 챕터에서도 같은 문단을 놓치지 않고 자연스럽게 이어서 읽을 수 있어야 합니다.</p>'
      if (image && paragraph === 4)
        body +=
          '<img src="http://127.0.0.1:8090/slow-image.svg?chapter='
          + chapter
          + '" style="width:100%;height:auto" alt="늦게 표시되는 삽화"/>'
    }
    files[name] = strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>챕터 '
        + chapter
        + '</title><style>p{font-size:16px;line-height:26px;margin:20px 0}</style></head><body>'
        + body
        + '</body></html>'
    )
  }
  files['book.opf'] = strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">scroll-test</dc:identifier><dc:title>스크롤 테스트</dc:title><dc:language>ko</dc:language></metadata><manifest>'
      + manifest
      + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>'
      + spine
      + '</spine></package>'
  )
  files['nav.xhtml'] = strToU8(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>'
      + nav
      + '</ol></nav></body></html>'
  )
  return Buffer.from(zipSync(files))
}

// Observe the real epub.js instance and delay its real archive reads; no navigation methods are stubbed.
const observeReader = `
;(function () {
  var epub = window.ePub
  window.__scrollTest = { delay: 0, events: [] }
  window.ePub = function (buffer) {
    var book = epub(buffer)
    window.__scrollTest.book = book
    var load = book.load
    book.load = function (path) {
      var args = arguments
      var delay = /[.]x?html(?:$|[?#])/.test(String(path)) ? window.__scrollTest.delay : 0
      return new Promise(function (resolve) { setTimeout(resolve, delay) }).then(function () { return load.apply(book, args) })
    }
    var renderTo = book.renderTo
    book.renderTo = function () {
      var rendition = renderTo.apply(book, arguments)
      window.__scrollTest.rendition = rendition
      rendition.hooks.content.register(function (contents) {
        Array.from(contents.document.querySelectorAll('p')).forEach(function (node, index) {
          if (!node.hasAttribute('data-ordinal')) node.setAttribute('data-ordinal', contents.sectionIndex * 100000 + index)
        })
      })
      rendition.started.then(function () {
        var fill = rendition.manager.fill
        rendition.manager.fill = function () {
          window.__scrollTest.events.push({ kind: 'fill', time: performance.now() })
          return fill.apply(rendition.manager, arguments)
        }
      })
      ;['next', 'prev'].forEach(function (name) {
        var original = rendition[name]
        rendition[name] = function () {
          window.__scrollTest.events.push({ kind: name, time: performance.now() })
          return original.apply(rendition, arguments)
        }
      })
      rendition.on('relocated', function (location) {
        window.__scrollTest.events.push({ kind: 'relocated', index: location.start.index, time: performance.now() })
      })
      return rendition
    }
    return book
  }
  Object.assign(window.ePub, epub)
})()
`

async function openReader(page, options = {}) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const body = render(
    readFileSync(new URL('(reader)/books/[bookId]/read.ejs', pagesRoot), 'utf8').replace(
      /<script server>[\s\S]*?<\/script>/,
      ''
    ),
    {
      asset: (path) => path,
      env: () => '',
      bookId: 'book',
      bookFileId: 'file',
      userId: 'scroll-user',
      bookFileHash: 'scroll-hash',
      epubReaderUrl: '/test.epub',
      initialShelfStatus: 'finished',
      aiAudioAvailable: false,
      bookTitle: '스크롤 테스트',
      showAudioDetail: false,
    }
  )
  const bytes = options.epubPath ? readFileSync(options.epubPath) : makeBook(options)
  await page.route(
    (url) => /^https?:$/.test(url.protocol),
    async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/assets/booklog-reader.js') {
        return route.fulfill({
          contentType: 'application/javascript',
          body:
            observeReader
            + readFileSync(process.env.BOOKLOG_READER_SCRIPT || new URL('assets/booklog-reader.js', pagesRoot), 'utf8'),
        })
      }
      if (url.pathname.startsWith('/assets/'))
        return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), pagesRoot)) })
      if (url.pathname === '/test.epub') return route.fulfill({ body: bytes, contentType: 'application/epub+zip' })
      if (url.pathname === '/slow-image.svg') {
        await new Promise((resolve) => setTimeout(resolve, options.imageDelay || 1500))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="1100"><rect width="300" height="1100" fill="#aaa"/></svg>',
        })
      }
      if (url.pathname === '/api/books/load-progress')
        return route.fulfill({
          json: options.epubPath
            ? { ok: true, hasSavedPosition: false, href: '', locator: '' }
            : { ok: true, hasSavedPosition: true, href: 'chapter-5.xhtml', locator: 'epubcfi(/6/12!/4/22/1:0)' },
        })
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({ json: { ok: true, id: 'session00000001', bookmarks: [], highlights: [] } })
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[x-cloak]{display:none!important}</style><link rel="stylesheet" href="/assets/uno.min.css"><link rel="stylesheet" href="/assets/style.css"><script defer src="/assets/vendor/alpine-3.17.4-cdn.min.js"></script></head><body class="m-0">'
          + body
          + '</body></html>',
      })
    }
  )
  await page.goto('/books/book/read')
  await expect
    .poll(
      () =>
        page.evaluate(() => !!window.Alpine && !window.Alpine.$data(document.querySelector('section[x-data]')).loading),
      { timeout: 30_000 }
    )
    .toBe(true)
  await page.waitForTimeout(800)
  await page.mouse.move(190, 420)
  return errors
}

async function screen(page) {
  return page.evaluate(() => {
    const state = window.__scrollTest
    const container = state.rendition.manager.container
    const bounds = container.getBoundingClientRect()
    const visible = []
    for (const frame of container.querySelectorAll('iframe')) {
      const frameBox = frame.getBoundingClientRect()
      if (
        !frameBox.height
        || frameBox.bottom <= bounds.top
        || frameBox.top >= bounds.bottom
        || window.getComputedStyle(frame).visibility === 'hidden'
      )
        continue
      const top = frameBox.top
      for (const paragraph of frame.contentDocument?.querySelectorAll('p[data-ordinal]') || []) {
        const rect = paragraph.getBoundingClientRect()
        if (top + rect.bottom > bounds.top + 1 && top + rect.top < bounds.bottom) {
          visible.push({ ordinal: Number(paragraph.dataset.ordinal), top: Math.round(top + rect.top - bounds.top) })
        }
      }
    }
    return {
      visible,
      top: Math.round(container.scrollTop),
      height: container.scrollHeight,
      viewport: container.clientHeight,
      events: state.events.slice(-40),
    }
  })
}

async function scrollSteps(page, direction, steps, { delta = 280, interval = 90 } = {}) {
  const samples = []
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, direction * delta)
    await page.waitForTimeout(interval)
    samples.push(await screen(page))
  }
  return samples
}

function reverseJumps(samples, direction) {
  const failures = []
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1].visible[0]
    const after = samples[index].visible[0]
    const sharedBefore = samples[index - 1].visible.find((item) =>
      samples[index].visible.some((next) => next.ordinal === item.ordinal)
    )
    const sharedAfter = sharedBefore && samples[index].visible.find((item) => item.ordinal === sharedBefore.ordinal)
    if (
      before
      && after
      && ((after.ordinal - before.ordinal) * direction < -1
        || (sharedBefore && sharedAfter && (sharedAfter.top - sharedBefore.top) * direction > 12))
    )
      failures.push({ index, before, after, state: samples[index] })
  }
  return failures
}

for (const slow of [false, true]) {
  test(
    'Manual scrolling stays in reading order across chapters' + (slow ? ' with delayed chapters' : ''),
    async ({ page, browserName }, testInfo) => {
      const errors = await openReader(page)
      if (slow) {
        await page.evaluate(() => {
          window.__scrollTest.delay = 700
        })
        if (browserName === 'chromium') {
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 5 })
        }
      }
      const start = await screen(page)
      const down = await scrollSteps(page, 1, 55)
      const up = await scrollSteps(page, -1, 70)
      await page.waitForTimeout(2000)
      const end = await screen(page)
      const observations = testInfo.outputPath('observations.json')
      writeFileSync(observations, JSON.stringify({ start, down, up, end }, null, 2))
      await testInfo.attach('scroll-observations', { path: observations, contentType: 'application/json' })
      expect(reverseJumps(down, 1), 'downward gestures must not jump backward to earlier paragraphs').toEqual([])
      expect(reverseJumps(up, -1), 'upward gestures must not jump forward to later paragraphs').toEqual([])
      expect(down.at(-1).visible[0].ordinal).toBeGreaterThan(start.visible[0].ordinal + 30)
      expect(end.visible[0].ordinal).toBeLessThan(down.at(-1).visible[0].ordinal - 30)
      expect(errors).toEqual([])
    }
  )
}

test('Slow upward gestures at a loading chapter boundary keep the reading position', async ({ page }, testInfo) => {
  const errors = await openReader(page, { image: true, imageDelay: 2400 })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    window.__scrollTest.delay = 1600
    window.__scrollTest.events = []
  })
  const initial = await screen(page)
  await page.evaluate(() => {
    const container = window.__scrollTest.rendition.manager.container
    const anchor = [...container.querySelectorAll('iframe')]
      .map((frame) => ({ frame, node: frame.contentDocument?.querySelector('[data-ordinal="125"]') }))
      .find((item) => item.node)
    const watch = (window.__scrollTest.watch = [])
    const started = performance.now()
    function record() {
      if (anchor.node.isConnected)
        watch.push({
          time: performance.now(),
          top:
            anchor.frame.getBoundingClientRect().top
            + anchor.node.getBoundingClientRect().top
            - container.getBoundingClientRect().top,
          scrollTop: container.scrollTop,
        })
      if (performance.now() - started < 6500) window.requestAnimationFrame(record)
    }
    window.requestAnimationFrame(record)
  })
  await page.mouse.wheel(0, -(initial.top - 29))
  const samples = await scrollSteps(page, -1, 12, { delta: 2, interval: 65 })
  for (let index = 0; index < 60; index += 1) {
    await page.waitForTimeout(80)
    samples.push(await screen(page))
  }
  const events = await page.evaluate(() => window.__scrollTest.events)
  const watch = await page.evaluate(() => window.__scrollTest.watch)
  writeFileSync(testInfo.outputPath('boundary.json'), JSON.stringify({ initial, samples, events, watch }, null, 2))
  expect(
    events.some((event) => event.kind === 'prev' || event.kind === 'fill'),
    'the slow gesture exercised the app boundary handler'
  ).toBe(true)
  expect(reverseJumps(samples, -1).map(({ index, before, after }) => ({ index, before, after }))).toEqual([])
  const backwardFrames = watch.slice(1).filter((sample, index) => sample.top < watch[index].top - 12)
  expect(backwardFrames, 'upward input must not snap the same paragraph back upward during compensation').toEqual([])
  expect(errors).toEqual([])
})

test('The first and last chapters remain reachable without looping', async ({ page }, testInfo) => {
  const errors = await openReader(page)
  await scrollSteps(page, 1, 38, { delta: 1500, interval: 120 })
  await expect.poll(async () => (await screen(page)).visible.some((item) => item.ordinal === 299)).toBe(true)
  const last = await screen(page)
  await page.mouse.wheel(0, 1200)
  await page.waitForTimeout(700)
  expect((await screen(page)).visible[0].ordinal).toBe(last.visible[0].ordinal)
  await scrollSteps(page, -1, 42, { delta: 1500, interval: 120 })
  await expect.poll(async () => (await screen(page)).visible[0]?.ordinal).toBe(0)
  const first = await screen(page)
  await page.mouse.wheel(0, -1200)
  await page.waitForTimeout(700)
  expect((await screen(page)).visible[0].ordinal).toBe(0)
  writeFileSync(testInfo.outputPath('endpoints.json'), JSON.stringify({ first, last }, null, 2))
  expect(errors).toEqual([])
})

test('Rapid direction changes settle at the paragraph the reader stopped on', async ({ page }, testInfo) => {
  const errors = await openReader(page)
  await page.evaluate(() => {
    window.__scrollTest.delay = 350
  })
  const observations = []
  for (const direction of [1, -1, 1, -1, 1, -1]) {
    observations.push(...(await scrollSteps(page, direction, 12, { delta: 420, interval: 45 })))
  }
  await page.waitForTimeout(1500)
  const stopped = await screen(page)
  await page.waitForTimeout(1200)
  const settled = await screen(page)
  writeFileSync(testInfo.outputPath('reversals.json'), JSON.stringify({ observations, stopped, settled }, null, 2))
  expect(settled.visible[0].ordinal).toBe(stopped.visible[0].ordinal)
  expect(Math.abs(settled.visible[0].top - stopped.visible[0].top)).toBeLessThanOrEqual(3)
  expect(errors).toEqual([])
})

test('A table-of-contents move during boundary loading keeps the newly chosen chapter', async ({ page }) => {
  const errors = await openReader(page)
  await page.evaluate(() => {
    window.__scrollTest.delay = 1800
    window.__scrollTest.events = []
  })
  const initial = await screen(page)
  await page.mouse.wheel(0, -(initial.top - 29))
  await scrollSteps(page, -1, 5, { delta: 2, interval: 65 })
  expect(await page.evaluate(() => window.__scrollTest.events.some((event) => event.kind === 'fill'))).toBe(true)
  await page.evaluate(() =>
    window.Alpine.$data(document.querySelector('section[x-data]')).goToTocItem({
      href: 'chapter-9.xhtml',
      label: '챕터 9',
    })
  )
  await expect.poll(async () => (await screen(page)).visible[0]?.ordinal, { timeout: 15_000 }).toBe(225)
  await page.waitForTimeout(2200)
  expect((await screen(page)).visible[0].ordinal).toBe(225)
  expect(errors).toEqual([])
})

test('Native touch swipes work across chapter boundaries on mobile Chrome', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP provides real touch gesture synthesis in Chromium.')
  const errors = await openReader(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.evaluate(() => {
    window.__scrollTest.delay = 300
  })
  const start = await screen(page)
  const observations = []
  for (const direction of [1, -1]) {
    for (let swipe = 0; swipe < 10; swipe += 1) {
      const from = direction > 0 ? 650 : 200
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: from }] })
      for (let step = 1; step <= 10; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 190, y: from - direction * step * 40 }],
        })
        await page.waitForTimeout(18)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(180)
      observations.push(await screen(page))
    }
  }
  writeFileSync(testInfo.outputPath('touch.json'), JSON.stringify({ start, observations }, null, 2))
  await page.screenshot({ path: testInfo.outputPath('touch-reader.png') })
  expect(observations[9].visible[0].ordinal).toBeGreaterThan(start.visible[0].ordinal + 15)
  expect(observations.at(-1).visible[0].ordinal).toBeLessThan(observations[9].visible[0].ordinal - 15)
  expect(errors).toEqual([])
})

test('Viewport resizing preserves the reading paragraph and scrolling remains usable', async ({ page }) => {
  const errors = await openReader(page)
  await scrollSteps(page, 1, 4, { delta: 180, interval: 100 })
  await page.waitForTimeout(500)
  const before = await screen(page)
  await page.setViewportSize({ width: 360, height: 740 })
  await page.waitForTimeout(700)
  await expect
    .poll(async () => Math.abs((await screen(page)).visible[0]?.ordinal - before.visible[0].ordinal))
    .toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(700)
  await expect
    .poll(async () => Math.abs((await screen(page)).visible[0]?.ordinal - before.visible[0].ordinal))
    .toBeLessThanOrEqual(1)
  const restored = await screen(page)
  await scrollSteps(page, -1, 5, { delta: 200, interval: 100 })
  expect((await screen(page)).visible[0].ordinal).toBeLessThan(restored.visible[0].ordinal)
  expect(errors).toEqual([])
})

// Optional local fixture: keep the supplied EPUB outside the repository.
for (const supplied of [false, true]) {
  test(
    'Reading slowly, opening menus and changing font size stays usable' + (supplied ? ' in supplied EPUB' : ''),
    async ({ page }, testInfo) => {
      test.skip(supplied && !process.env.BOOKLOG_SCROLL_EPUB, 'Set BOOKLOG_SCROLL_EPUB to a local EPUB path.')
      const errors = await openReader(page, supplied ? { epubPath: process.env.BOOKLOG_SCROLL_EPUB } : {})
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
      await page.getByRole('button', { name: '목차', exact: true }).click()
      await page.locator('#reader-toc-scroll button').nth(4).click()
      await page.waitForTimeout(900)
      await page.mouse.move(190, 420)
      await scrollSteps(page, 1, 12, { delta: 90, interval: 120 })
      await page.waitForTimeout(700)
      const reading = await screen(page)
      await page.waitForTimeout(3000)
      const paused = await screen(page)
      expect(paused.visible[0]).toEqual(reading.visible[0])
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
      await page.getByRole('button', { name: '메뉴 닫기', exact: true }).last().click()
      expect((await screen(page)).visible[0]).toEqual(paused.visible[0])
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
      await page.getByRole('button', { name: '글자 크기 키우기', exact: true }).filter({ visible: true }).click()
      await page.getByRole('button', { name: '글자 크기 키우기', exact: true }).filter({ visible: true }).click()
      await page.getByRole('button', { name: '메뉴 닫기', exact: true }).last().click()
      await page.waitForTimeout(1200)
      const enlarged = await screen(page)
      expect(enlarged.visible.length).toBeGreaterThan(0)
      await page.waitForTimeout(1800)
      expect((await screen(page)).visible[0]).toEqual(enlarged.visible[0])
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
      await page
        .getByRole('button', { name: '글자 크기 기본값으로 되돌리기', exact: true })
        .filter({ visible: true })
        .click()
      await page.getByRole('button', { name: '메뉴 닫기', exact: true }).last().click()
      await page.waitForTimeout(1200)
      const reset = await screen(page)
      await page.mouse.move(190, 420)
      const down = await scrollSteps(page, 1, 8, { delta: 150, interval: 100 })
      const up = await scrollSteps(page, -1, 10, { delta: 150, interval: 100 })
      expect(reverseJumps(down, 1)).toEqual([])
      expect(reverseJumps(up, -1)).toEqual([])
      writeFileSync(
        testInfo.outputPath('reading-workflow.json'),
        JSON.stringify({ reading, paused, enlarged, reset, down, up }, null, 2)
      )
      expect(errors).toEqual([])
    }
  )
}

test('Supplied EPUB keeps its position at short and long chapter boundaries', async ({ page }, testInfo) => {
  test.skip(!process.env.BOOKLOG_SCROLL_EPUB, 'Set BOOKLOG_SCROLL_EPUB to a local EPUB path.')
  test.setTimeout(180_000)
  const errors = await openReader(page, { epubPath: process.env.BOOKLOG_SCROLL_EPUB })
  const hrefs = await page.evaluate(() => {
    const items = window.__scrollTest.book.spine.spineItems
    return [3, Math.floor(items.length * 0.28), Math.floor(items.length * 0.42), items.length - 1].map(
      (index) => items[index].href
    )
  })
  const observations = []
  for (const href of hrefs) {
    await page.evaluate((href) => {
      window.__scrollTest.delay = 0
      return window.Alpine.$data(document.querySelector('section[x-data]')).goToTocItem({ href, label: 'test' })
    }, href)
    await page.waitForTimeout(1200)
    const initial = await screen(page)
    await page.evaluate(() => {
      window.__scrollTest.delay = 1600
      window.__scrollTest.events = []
      const container = window.__scrollTest.rendition.manager.container
      const anchor = [...container.querySelectorAll('iframe')]
        .map((frame) => ({ frame, node: frame.contentDocument?.querySelector('p[data-ordinal]') }))
        .find((item) => item.node && item.frame.clientHeight)
      const watch = (window.__scrollTest.watch = [])
      const started = performance.now()
      function record() {
        if (
          anchor?.frame.isConnected
          && anchor.frame.clientHeight
          && window.getComputedStyle(anchor.frame).visibility !== 'hidden'
          && anchor.node.isConnected
        )
          watch.push({
            time: performance.now(),
            top: anchor.frame.getBoundingClientRect().top + anchor.node.getBoundingClientRect().top,
          })
        if (performance.now() - started < 6500) window.requestAnimationFrame(record)
      }
      window.requestAnimationFrame(record)
    })
    await page.mouse.wheel(0, -(initial.top - 29))
    await scrollSteps(page, -1, 12, { delta: 2, interval: 65 })
    await page.waitForTimeout(5000)
    observations.push(
      await page.evaluate(() => ({
        events: window.__scrollTest.events,
        watch: window.__scrollTest.watch,
      }))
    )
  }
  writeFileSync(testInfo.outputPath('supplied-boundaries.json'), JSON.stringify(observations, null, 2))
  for (const observation of observations) {
    expect(observation.watch.length).toBeGreaterThan(10)
    expect(
      observation.watch.slice(1).filter((sample, index) => sample.top < observation.watch[index].top - 12)
    ).toEqual([])
  }
  expect(observations.some((item) => item.events.some((event) => ['fill', 'prev'].includes(event.kind)))).toBe(true)
  expect(errors).toEqual([])
})

test('Supplied EPUB supports repeated manual scrolling and resize in its longest chapter', async ({
  page,
}, testInfo) => {
  test.skip(!process.env.BOOKLOG_SCROLL_EPUB, 'Set BOOKLOG_SCROLL_EPUB to a local EPUB path.')
  const errors = await openReader(page, { epubPath: process.env.BOOKLOG_SCROLL_EPUB })
  await page.evaluate(() => {
    const items = window.__scrollTest.book.spine.spineItems
    return window.Alpine.$data(document.querySelector('section[x-data]')).goToTocItem({
      href: items.at(-1).href,
      label: 'test',
    })
  })
  await page.waitForTimeout(1200)
  const start = await screen(page)
  const down = await scrollSteps(page, 1, 70, { delta: 420, interval: 50 })
  const up = await scrollSteps(page, -1, 45, { delta: 420, interval: 50 })
  expect(reverseJumps(down, 1)).toEqual([])
  expect(reverseJumps(up, -1)).toEqual([])
  expect(down.at(-1).visible[0].ordinal).toBeGreaterThan(start.visible[0].ordinal + 20)
  expect(up.at(-1).visible[0].ordinal).toBeLessThan(down.at(-1).visible[0].ordinal - 20)
  for (const direction of [1, -1, 1, -1]) await scrollSteps(page, direction, 8, { delta: 320, interval: 45 })
  await page.waitForTimeout(800)
  const stopped = await screen(page)
  await page.waitForTimeout(1500)
  const settled = await screen(page)
  expect(settled.visible[0]).toEqual(stopped.visible[0])
  await page.setViewportSize({ width: 360, height: 740 })
  await page.waitForTimeout(800)
  expect(Math.abs((await screen(page)).visible[0].ordinal - settled.visible[0].ordinal)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('supplied-reader.png') })
  writeFileSync(
    testInfo.outputPath('supplied-long-chapter.json'),
    JSON.stringify({ start, down, up, stopped, settled }, null, 2)
  )
  expect(errors).toEqual([])
})
