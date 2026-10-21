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

function makeBook({ image = false, paragraphCounts = Array(12).fill(25) } = {}) {
  const files = {
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
  }
  let manifest = ''
  let spine = ''
  let nav = ''
  let ordinal = 0
  for (let chapter = 0; chapter < paragraphCounts.length; chapter += 1) {
    const name = 'chapter-' + chapter + '.xhtml'
    manifest += '<item id="c' + chapter + '" href="' + name + '" media-type="application/xhtml+xml"/>'
    spine += '<itemref idref="c' + chapter + '"/>'
    nav += '<li><a href="' + name + '">챕터 ' + chapter + '</a></li>'
    let body = ''
    for (let paragraph = 0; paragraph < paragraphCounts[chapter]; paragraph += 1) {
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
      ordinal += 1
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
  window.__scrollTest = { delay: 0, delayPattern: [], loads: [], pendingLoads: 0, maxPendingLoads: 0, events: [] }
  window.ePub = function (buffer) {
    var book = epub(buffer)
    window.__scrollTest.book = book
    var load = book.load
    book.load = function (path) {
      var args = arguments
      var delay = /[.]x?html(?:$|[?#])/.test(String(path)) ? window.__scrollTest.delay : 0
      var state = window.__scrollTest
      var chapter = /[.]x?html(?:$|[?#])/.test(String(path))
      var entry
      if (chapter) {
        if (state.delayPattern.length) delay = state.delayPattern[state.loads.length % state.delayPattern.length]
        entry = { path: String(path), delay: delay, started: performance.now() }
        state.loads.push(entry)
        state.pendingLoads += 1
        state.maxPendingLoads = Math.max(state.maxPendingLoads, state.pendingLoads)
      }
      return new Promise(function (resolve) { setTimeout(resolve, delay) })
        .then(function () { return load.apply(book, args) })
        .finally(function () { if (chapter) { entry.finished = performance.now(); state.pendingLoads -= 1 } })
    }
    var renderTo = book.renderTo
    book.renderTo = function () {
      var rendition = renderTo.apply(book, arguments)
      window.__scrollTest.rendition = rendition
      rendition.hooks.content.register(function (contents) {
        Array.from(contents.document.querySelectorAll('p')).forEach(function (node, index) {
          if (!node.hasAttribute('data-ordinal')) node.setAttribute('data-ordinal', contents.sectionIndex * 100000 + index)
          node.setAttribute('data-scroll-section', contents.sectionIndex)
        })
      })
      rendition.started.then(function () {
        var manager = rendition.manager
        function observeView(view) {
          if (view.__scrollObserved) return view
          view.__scrollObserved = true
          var destroy = view.destroy
          view.destroy = function () {
            var watch = window.__scrollTest.stress
            var frame = view.iframe
            if (watch && watch.running && frame && frame.isConnected && frame.clientHeight && window.getComputedStyle(frame).visibility !== 'hidden') {
              var rect = frame.getBoundingClientRect()
              var bounds = manager.container.getBoundingClientRect()
              if (rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1)
                window.__scrollTest.events.push({ kind: 'destroy-visible', index: view.section.index, time: performance.now(), rect: { top: rect.top, bottom: rect.bottom } })
            }
            return destroy.apply(view, arguments)
          }
          return view
        }
        var createView = manager.createView
        manager.createView = function () { return observeView(createView.apply(manager, arguments)) }
        if (manager.views) manager.views.all().forEach(observeView)
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
      if (url.pathname === '/assets/vendor/epubjs-0.3.93.min.js' && process.env.BOOKLOG_EPUB_SCRIPT)
        return route.fulfill({ path: process.env.BOOKLOG_EPUB_SCRIPT })
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

async function startScrollWatch(page) {
  await page.evaluate(() => {
    const state = window.__scrollTest
    const cache = new WeakMap()
    const watch = (state.stress = {
      running: true,
      direction: 0,
      changedAt: performance.now(),
      phase: 'start',
      frames: [],
      reversals: [],
      sections: [],
      maxMissingFrameMs: 0,
    })
    let previous = null
    let missingSince = null
    function record() {
      if (!watch.running) return
      const container = state.rendition.manager.container
      const bounds = container.getBoundingClientRect()
      const visible = []
      let hasFrame = false
      for (const frame of container.querySelectorAll('iframe')) {
        const box = frame.getBoundingClientRect()
        if (
          !box.height
          || box.bottom <= bounds.top
          || box.top >= bounds.bottom
          || window.getComputedStyle(frame).visibility === 'hidden'
        )
          continue
        hasFrame = true
        let entry = cache.get(frame)
        if (!entry || entry.document !== frame.contentDocument) {
          entry = {
            document: frame.contentDocument,
            nodes: [...frame.contentDocument.querySelectorAll('p[data-ordinal]')],
          }
          cache.set(frame, entry)
        }
        for (const node of entry.nodes) {
          const rect = node.getBoundingClientRect()
          if (box.top + rect.bottom > bounds.top + 1 && box.top + rect.top < bounds.bottom) {
            visible.push({
              ordinal: Number(node.dataset.ordinal),
              section: Number(node.dataset.scrollSection),
              top: box.top + rect.top - bounds.top,
            })
          }
        }
      }
      const now = performance.now()
      const sample = {
        time: now,
        direction: watch.direction,
        phase: watch.phase,
        first: visible[0] || null,
        scrollTop: container.scrollTop,
        height: container.scrollHeight,
        pendingLoads: state.pendingLoads,
        hasFrame,
      }
      if (!hasFrame) {
        if (missingSince === null) missingSince = now
        watch.maxMissingFrameMs = Math.max(watch.maxMissingFrameMs, now - missingSince)
      } else missingSince = null
      if (sample.first && !watch.sections.includes(sample.first.section)) watch.sections.push(sample.first.section)
      // Ignore only the brief handoff between opposite inputs; keep every frame as evidence.
      if (previous && watch.direction && previous.direction === watch.direction && now - watch.changedAt > 120) {
        const shared = visible.find((node) => previous.visible.some((before) => before.ordinal === node.ordinal))
        const before = shared && previous.visible.find((node) => node.ordinal === shared.ordinal)
        const reversedPosition = before && (shared.top - before.top) * watch.direction > 12
        const reversedOrder =
          sample.first && previous.first && (sample.first.ordinal - previous.first.ordinal) * watch.direction < -1
        if (reversedPosition || reversedOrder)
          watch.reversals.push({ before: previous.sample, after: sample, sharedBefore: before, sharedAfter: shared })
      }
      watch.frames.push(sample)
      previous = { sample, first: sample.first, visible, direction: watch.direction }
      window.requestAnimationFrame(record)
    }
    window.requestAnimationFrame(record)
  })
}

async function stressScroll(page, direction, steps, { delta, interval }, phase) {
  await page.evaluate(
    ({ direction, phase }) => {
      const watch = window.__scrollTest.stress
      if (watch.direction !== direction) watch.changedAt = performance.now()
      watch.direction = direction
      watch.phase = phase
    },
    { direction, phase }
  )
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, direction * delta)
    if (interval) await page.waitForTimeout(interval)
  }
}

async function settledReadingPosition(page) {
  await expect.poll(() => page.evaluate(() => window.__scrollTest.pendingLoads), { timeout: 20_000 }).toBe(0)
  await page.waitForTimeout(1000)
  const stopped = await screen(page)
  await page.waitForTimeout(1200)
  const settled = await screen(page)
  expect(stopped.visible.length, 'a readable paragraph remains on screen').toBeGreaterThan(0)
  expect(settled.visible[0]?.ordinal, 'the stopped reading paragraph must not change later').toBe(
    stopped.visible[0].ordinal
  )
  expect(
    Math.abs(settled.visible[0].top - stopped.visible[0].top),
    'the stopped paragraph must not drift'
  ).toBeLessThanOrEqual(3)
  return settled
}

async function saveScrollWatch(page, testInfo, details = {}) {
  const result = await page.evaluate(() => {
    const state = window.__scrollTest
    state.stress.running = false
    return { ...state.stress, loads: state.loads, maxPendingLoads: state.maxPendingLoads, events: state.events }
  })
  const path = testInfo.outputPath('stress-observations.json')
  writeFileSync(path, JSON.stringify({ ...details, ...result }, null, 2))
  await testInfo.attach('scroll-frame-observations', { path, contentType: 'application/json' })
  return result
}

function assertScrollWatch(result) {
  expect(result.reversals, 'observed paragraphs must follow the held scroll direction').toEqual([])
  expect(
    result.events.filter((event) => event.kind === 'destroy-visible'),
    'queued cleanup must not destroy a chapter that is now visible'
  ).toEqual([])
  expect(result.maxMissingFrameMs, 'chapter rendering must recover instead of leaving an empty viewport').toBeLessThan(
    5000
  )
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

test.describe('Scroll stress', () => {
  test.setTimeout(180_000)
  test.afterEach(async ({ page }, testInfo) => {
    if (page.isClosed()) return
    if (await page.evaluate(() => !!window.__scrollTest?.stress?.running)) await saveScrollWatch(page, testInfo)
    if (testInfo.status !== testInfo.expectedStatus)
      await testInfo.attach('reader-at-failure', { body: await page.screenshot(), contentType: 'image/png' })
  })

  const mixedChapters = [1, 60, 2, 35, 1, 25, 3, 90, 1, 25, 2, 50, 1, 40, 2, 60, 3, 25, 1, 30]
  const profiles = [
    {
      name: 'one-pixel upward boundary gestures',
      delta: 1,
      interval: 80,
      steps: 40,
      rounds: 1,
      delays: [1400, 0, 400],
      creep: true,
    },
    { name: 'slow line-by-line reading', delta: 18, interval: 45, steps: 100, rounds: 1, delays: [900, 100, 1400] },
    {
      name: 'fast multi-chapter scrolling',
      delta: 900,
      interval: 18,
      steps: 40,
      rounds: 3,
      delays: [1600, 40, 900],
      mixed: true,
    },
    {
      name: 'extreme bursts on a narrow screen',
      delta: 3600,
      interval: 8,
      steps: 30,
      rounds: 4,
      delays: [2000, 200, 1100],
      mixed: true,
      narrow: true,
    },
  ]
  for (const profile of profiles) {
    test(profile.name, async ({ page, browserName }, testInfo) => {
      if (profile.narrow) await page.setViewportSize({ width: 320, height: 640 })
      const errors = await openReader(page, profile.mixed ? { paragraphCounts: mixedChapters } : {})
      if (browserName === 'chromium' && profile.narrow) {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
      }
      await page.evaluate((delays) => {
        window.__scrollTest.delayPattern = delays
      }, profile.delays)
      if (profile.creep) {
        const initial = await screen(page)
        await page.mouse.wheel(0, -(initial.top - 24))
        await page.waitForTimeout(100)
      }
      await startScrollWatch(page)
      const start = await screen(page)
      const stops = []
      for (const direction of profile.creep ? [-1, 1] : [1, -1]) {
        for (let round = 0; round < profile.rounds; round += 1) {
          await stressScroll(page, direction, profile.steps, profile, `${direction}:${round}`)
          await page.waitForTimeout(Math.max(...profile.delays) + 300)
        }
        stops.push(await settledReadingPosition(page))
      }
      const result = await saveScrollWatch(page, testInfo, { profile, start, stops })
      assertScrollWatch(result)
      expect(result.frames.length).toBeGreaterThan(30)
      if (profile.mixed)
        expect(result.sections.length, 'the burst must actually traverse multiple chapters').toBeGreaterThanOrEqual(4)
      if (profile.creep) expect(result.events.some((event) => event.kind === 'fill')).toBe(true)
      expect(errors).toEqual([])
    })
  }

  for (const seed of [17, 2026, 9817]) {
    test(`reproducible mixed speeds and direction changes, seed ${seed}`, async ({ page }, testInfo) => {
      const errors = await openReader(page, { paragraphCounts: mixedChapters })
      await page.evaluate(() => {
        window.__scrollTest.delayPattern = [0, 1800, 80, 700, 2200]
      })
      let randomState = seed
      const random = (limit) => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
        return randomState % limit
      }
      const plan = Array.from({ length: 24 }, (_, index) => ({
        direction: random(3) ? 1 : -1,
        steps: 4 + random(9),
        delta: [1, 6, 30, 160, 700, 2400][random(6)],
        interval: [8, 20, 55, 110][random(4)],
        pause: index % 5 === 4 ? 2300 : 0,
      }))
      await startScrollWatch(page)
      for (const [index, block] of plan.entries()) {
        await stressScroll(page, block.direction, block.steps, block, `seed-${seed}-block-${index}`)
        if (block.pause) await page.waitForTimeout(block.pause)
      }
      const stopped = await settledReadingPosition(page)
      const result = await saveScrollWatch(page, testInfo, { seed, plan, stopped })
      assertScrollWatch(result)
      expect(result.sections.length).toBeGreaterThanOrEqual(3)
      expect(errors).toEqual([])
    })
  }

  test('a previously loaded chapter can grow above the reading viewport', async ({ page }, testInfo) => {
    const errors = await openReader(page, { image: true, imageDelay: 700 })
    await page.evaluate(() =>
      window.Alpine.$data(document.querySelector('section[x-data]')).goToTocItem({
        href: 'chapter-6.xhtml',
        label: '챕터 6',
      })
    )
    await page.waitForTimeout(2500)
    await startScrollWatch(page)
    const before = await settledReadingPosition(page)
    const resized = await page.evaluate(() => {
      const container = window.__scrollTest.rendition.manager.container
      const bounds = container.getBoundingClientRect()
      for (const frame of container.querySelectorAll('iframe')) {
        if (frame.getBoundingClientRect().bottom > bounds.top + 1) continue
        const image = frame.contentDocument?.querySelector('img')
        if (image && frame.clientHeight) {
          image.style.height = `${image.getBoundingClientRect().height + 650}px`
          return true
        }
      }
      return false
    })
    expect(resized, 'exercise a real image resize in the preceding chapter').toBe(true)
    const after = await settledReadingPosition(page)
    const result = await saveScrollWatch(page, testInfo, { before, after })
    expect(after.visible[0].ordinal).toBe(before.visible[0].ordinal)
    expect(Math.abs(after.visible[0].top - before.visible[0].top)).toBeLessThanOrEqual(3)
    assertScrollWatch(result)
    expect(errors).toEqual([])
  })

  test('repeated touch flicks with slow rendering', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Native touch synthesis uses Chromium CDP; this is not an iPhone touch test.')
    const errors = await openReader(page, {
      paragraphCounts: [2, 7, 3, 9, 1, 25, 2, 8, 1, 5, 2, 10, 1, 8, 2, 6, 3, 5, 1, 10],
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    await page.evaluate(() => {
      window.__scrollTest.delayPattern = [1200, 0, 700]
    })
    await startScrollWatch(page)
    const stops = []
    for (const direction of [1, -1, 1, -1]) {
      await page.evaluate((direction) => {
        const watch = window.__scrollTest.stress
        watch.direction = direction
        watch.changedAt = performance.now()
        watch.phase = `touch-${direction}`
      }, direction)
      for (let swipe = 0; swipe < 16; swipe += 1) {
        const from = direction > 0 ? 650 : 180
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: from }] })
        for (let step = 1; step <= 5; step += 1) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: 190, y: from - direction * step * 85 }],
          })
          await page.waitForTimeout(swipe % 2 ? 8 : 60)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(180)
      }
      stops.push(await settledReadingPosition(page))
    }
    const result = await saveScrollWatch(page, testInfo, { stops })
    assertScrollWatch(result)
    expect(result.sections.length).toBeGreaterThanOrEqual(4)
    expect(errors).toEqual([])
  })

  test('supplied EPUB traverses several chapters in both directions under load', async ({ page }, testInfo) => {
    test.skip(!process.env.BOOKLOG_SCROLL_EPUB, 'Set BOOKLOG_SCROLL_EPUB to a local EPUB path.')
    const errors = await openReader(page, { epubPath: process.env.BOOKLOG_SCROLL_EPUB })
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click()
    await page.getByRole('button', { name: '목차', exact: true }).click()
    await page.locator('#reader-toc-scroll button').nth(4).click()
    await page.waitForTimeout(1200)
    await page.mouse.move(190, 420)
    await page.evaluate(() => {
      window.__scrollTest.delayPattern = [1500, 0, 600]
    })
    await startScrollWatch(page)
    const stops = []
    for (const direction of [1, -1]) {
      for (let round = 0; round < 3; round += 1) {
        await stressScroll(page, direction, 50, { delta: 8000, interval: 16 }, `supplied-${direction}-${round}`)
        await page.waitForTimeout(1800)
      }
      stops.push(await settledReadingPosition(page))
    }
    const result = await saveScrollWatch(page, testInfo, { stops })
    assertScrollWatch(result)
    expect(result.sections.length).toBeGreaterThanOrEqual(3)
    expect(errors).toEqual([])
  })
})
