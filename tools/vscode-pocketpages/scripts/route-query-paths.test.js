'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { collectPathContexts, getPathContextAtOffset } = require('../packages/language-core/custom-context')

const assetOptions = { filePath: '/app/pb_hooks/pages/assets/audio.js' }

for (const expression of [
  "'/api/books/audio-chunk?' + query.toString()",
  "'/api/books/audio-chunk?bookId=' + bookId + '&chunk=' + index",
  "'/api/books/audio-chunk#' + anchor",
  "'/api/books/audio-chunk?fixed=1#' + (anchor + suffix)",
  "((('/api/books/audio-chunk?') + query.toString()) + '#' + anchor)",
  '`/api/books/audio-chunk?` + query.toString()',
]) {
  test(`collects the literal prefix of ${expression}`, () => {
    const text = `fetch(${expression}, { method: 'POST' })`
    const contexts = collectPathContexts(text, assetOptions)
    assert.equal(contexts.length, 1)
    const context = contexts[0]
    assert.equal(context.kind, 'route-path')
    assert.equal(context.routeSource, 'fetch-post')
    assert.equal(context.isDynamic, false)
    assert.equal(context.isOpen, undefined)
    assert.equal(context.matchText, text)
    assert.equal(text.slice(context.start, context.end), context.value)
    assert.match(context.value, /^\/api\/books\/audio-chunk[?#]/)
    assert.deepEqual(getPathContextAtOffset(text, context.start + 5, assetOptions), context)
    assert.equal(getPathContextAtOffset(text, text.lastIndexOf(' + ') + 3, assetOptions), null)
  })
}

for (const expression of [
  "'/api/books/' + bookId",
  "'/api/books/' + bookId + '?q=' + query",
  "('/api/books/' + bookId) + '#anchor'",
  "prefix + '/api/books/audio-chunk?' + query",
  "('/api/books/audio-chunk?' + query).trim()",
  "condition ? '/api/books/audio-chunk?' + query : other",
  "'/api/books/audio-chunk?' || query",
  "'/api/books/audio-chunk?' - query",
  '`/api/books/${bookId}?` + query',
  "'/api/books/audio-chunk' + ('?' + query)",
  "'/api/books/audio-chunk\\x3f' + query",
  "'/api/books/\\\\?' + query",
  "'https://example.com/api/books?' + query",
  'audioUrl',
]) {
  test(`does not infer a static route from ${expression}`, () => {
    const text = `fetch(${expression})`
    assert.deepEqual(collectPathContexts(text, assetOptions), [])
    const pathOffset = text.indexOf('/api/books')
    if (pathOffset !== -1) {
      assert.equal(getPathContextAtOffset(text, pathOffset + 3, assetOptions), null)
    }
  })
}

test('preserves literal paths, quotes, ranges, and HTTP methods', () => {
  const text = [
    "fetch('/api/books')",
    'window.fetch("/api/books?fixed=1", { method: "PATCH" })',
    'globalThis.fetch(`/api/books#anchor`, { method: `DELETE` })',
    "fetch(('/api/books?'), { method: 'PUT' })",
    "fetch('/api/books?' + query, { method: method })",
    "window.fetch('/api/books#' + anchor, { method: 'HEAD' })",
    "globalThis.fetch('/api/books?' + query, { method: 'options' })",
  ].join('\n')
  const contexts = collectPathContexts(text, assetOptions)
  assert.deepEqual(
    contexts.map((context) => [context.value, context.routeSource, context.quote]),
    [
      ['/api/books', 'fetch-get', "'"],
      ['/api/books?fixed=1', 'fetch-patch', '"'],
      ['/api/books#anchor', 'fetch-delete', '`'],
      ['/api/books?', 'fetch-put', "'"],
      ['/api/books?', 'fetch-get', "'"],
      ['/api/books#', 'fetch-head', "'"],
      ['/api/books?', 'fetch-options', "'"],
    ]
  )
  for (const context of contexts) {
    assert.equal(text.slice(context.start, context.end), context.value)
  }
})

test('supports other route calls without broadening asset/include/resolve paths', () => {
  const text = [
    "redirect('/books?' + query)",
    "response.redirect('/books#' + anchor)",
    "api.redirect('/books?' + query)",
    "datastar.redirect('/books?' + query)",
    "datastar.replaceURL('/books#' + anchor)",
    "asset('/books?' + query)",
    "include('/books?' + query)",
    "resolve('/books?' + query)",
    "asset('/logo.svg')",
    "include('card')",
    "resolve('book-service')",
  ].join('\n')
  const contexts = collectPathContexts(text, { mode: 'script' })
  assert.deepEqual(
    contexts.map((context) => context.routeSource || context.kind),
    ['redirect', 'redirect', 'redirect', 'redirect', 'replace-url', 'asset-path', 'include-path', 'resolve-path']
  )
})

test('keeps client/server and asset fetch collection boundaries', () => {
  const call = "fetch('/api/books?' + query, { method: 'POST' })"
  const document = `<script server>${call}</script>\n<% ${call} %>\n<script>${call}</script>`
  const contexts = collectPathContexts(document, { mode: 'ejs' })
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].routeSource, 'fetch-post')
  assert.equal(contexts[0].start, document.lastIndexOf('/api/books?'))
  assert.deepEqual(getPathContextAtOffset(document, contexts[0].start + 3, { mode: 'ejs' }), contexts[0])
  for (const filePath of [
    '/app/pb_hooks/pages/+load.js',
    '/app/pb_hooks/pages/_private/audio.js',
    '/app/pb_hooks/pages/assets/vendor/audio.js',
    '/app/pb_hooks/pages/assets/audio.min.js',
  ]) {
    assert.deepEqual(collectPathContexts(call, { filePath }), [])
  }
})

test('collects the previously missing booklog audio query calls', () => {
  const filePath = path.resolve(__dirname, '../../../apps/booklog/pb_hooks/pages/assets/booklog-audio.js')
  const text = fs.readFileSync(filePath, 'utf8')
  const contexts = collectPathContexts(text, { filePath }).filter((context) => context.kind === 'route-path')
  assert.deepEqual(
    contexts.map((context) => [context.value, context.routeSource]),
    [
      ['/api/books/audio-progress', 'fetch-post'],
      ['/api/books/audio-chunk?', 'fetch-get'],
      ['/api/books/audio-progress?', 'fetch-get'],
      ['/api/books/audio-progress?', 'fetch-get'],
      ['/api/books/audio-position?', 'fetch-get'],
    ]
  )
  for (const context of contexts) {
    assert.equal(text.slice(context.start, context.end), context.value)
  }
})
