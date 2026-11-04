import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../package.json', import.meta.url))
const hooks = fileURLToPath(new URL('../pb_hooks', import.meta.url))
function load(name) {
  const context = { module: { exports: {} }, require, __hooks: hooks }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/' + name + '.js', import.meta.url), 'utf8'),
    context
  )
  return context.module.exports
}
const data = load('book-recommendation-data')
const service = load('book-recommendation-service')
const model = 'alibaba/qwen3.5-plus'
const record = (fields) => ({ get: (key) => fields[key] })
function candidate(id, extra = {}) {
  return {
    id,
    bookId: '',
    isbn13: '9788972754190',
    title: id,
    author: '저자',
    description: '도서 설명',
    className: '소설',
    pageCount: 0,
    coverUrl: '',
    href: 'https://data4library.kr/bookV?seq=1',
    source: 'discovery',
    ...extra,
  }
}

test('Qwen proposes title and author only, discarding invented ISBNs, duplicates, invalid and excess entries', () => {
  const ai = {
    vercelAiGatewayDecision: () => assert.fail('No decision call'),
    vercelAiGateway(request) {
      assert.equal(request.model, model)
      assert.equal(request.reasoning_effort, 'none')
      assert.deepEqual(JSON.parse(request.input), { readerPreference: '추리소설' })
      return {
        ok: true,
        json: {
          suggestions: [
            null,
            { title: '책' },
            { title: '', author: '저자' },
            { title: '악의', author: '히가시노 게이고', isbn13: 'invented', href: 'javascript:alert(1)' },
            { title: '악의 ', author: '히가시노 게이고' },
            ...Array.from({ length: 10 }, (_, index) => ({ title: '책 ' + index, author: '저자' })),
          ],
        },
      }
    },
  }
  const suggestions = service.suggestBooks(ai, model, '추리소설')
  assert.equal(suggestions.length, 8)
  assert.deepEqual({ ...suggestions[0] }, { title: '악의', author: '히가시노 게이고' })
  assert.throws(
    () => service.suggestBooks({ vercelAiGateway: () => ({ ok: false }) }, model, 'test'),
    /suggestions failed/
  )
})

test('Search verifies both title and author and a valid catalog ISBN, never a model-supplied ISBN', () => {
  const suggestion = { title: '악의', author: '히가시노 게이고', isbn13: 'invented' }
  const valid = {
    bookname: '악의 :장편소설',
    authors: '히가시노 게이고 [지음] ;양윤옥 옮김',
    isbn13: '9788972754190',
    description: '&lt;p&gt;추리 &amp; 모험&lt;/p&gt;',
    bookImageURL: 'javascript:bad',
    bookDtlUrl: 'javascript:bad',
  }
  const api = {
    searchBooks(_config, input) {
      assert.equal(input.title, '악의')
      return {
        docs: [
          { ...valid, authors: '다른 저자' },
          { ...valid, bookname: '다른 책' },
          { ...valid, isbn13: '9788972754191' },
          valid,
        ],
      }
    },
  }
  const book = data.findSuggestedBook(api, { apiKey: 'test', timeout: 4 }, suggestion)
  assert.equal(book.isbn13, '9788972754190')
  assert.equal(book.title, '악의')
  assert.equal(book.author, '히가시노 게이고')
  assert.equal(book.description, '추리 & 모험')
  assert.equal(book.coverUrl, '')
  assert.ok(book.href.startsWith('https://search.naver.com/'))
  assert.equal(
    data.findSuggestedBook({ searchBooks: () => ({ docs: [{ ...valid, authors: '다른 저자' }] }) }, {}, suggestion),
    null
  )
})

test('Shelf metadata only excludes finished books and connects owned books without restricting discovery', () => {
  const db = {
    findRecordsByFilter(collection, filter, _sort, _limit, _offset, bindings) {
      assert.equal(collection, 'book_shelves')
      assert.equal(filter, 'user_id = {:userId}')
      assert.equal(bindings.userId, 'current-user')
      return [record({ book_id: 'owned', status: 'queued' }), record({ book_id: 'finished', status: 'finished' })]
    },
    findRecordsByIds(collection, ids) {
      assert.equal(collection, 'books')
      assert.deepEqual(Array.from(ids), ['owned', 'finished'])
      return [
        record({ id: 'owned', title: '읽을 책', author: '저자', isbn13: 'owned-isbn' }),
        record({ id: 'finished', title: '완독 책', author: '저자', isbn13: 'finished-isbn' }),
      ]
    },
  }
  const shelf = data.loadShelfData(db, 'current-user')
  const result = data.buildCandidates(shelf, [
    candidate('owned', { title: '읽을 책', isbn13: 'owned-isbn' }),
    candidate('finished', { title: '완독 책', isbn13: 'finished-isbn' }),
    candidate('another-edition', { title: '완독 책', isbn13: 'other-isbn' }),
    candidate('new', { title: '새 책', isbn13: 'new-isbn' }),
    candidate('new', { title: '새 책', isbn13: 'new-isbn' }),
  ])
  assert.deepEqual(
    Array.from(result, (book) => book.title),
    ['읽을 책', '새 책']
  )
  assert.equal(result[0].href, '/books/owned?from=/')
  assert.equal(result[0].source, 'shelf')
  assert.equal(result[1].source, 'discovery')
})

test('Qwen chooses and explains only verified IDs while canonical titles, ISBNs and URLs stay server-owned', () => {
  const candidates = [candidate('book0'), candidate('book1')]
  const result = service.recommendBooks(
    {
      vercelAiGatewayDecision: () => assert.fail('No decision call'),
      vercelAiGateway(request) {
        assert.equal(request.model, model)
        assert.deepEqual(
          JSON.parse(request.input).verifiedBooks.map((book) => book.id),
          ['book0', 'book1']
        )
        return {
          ok: true,
          json: {
            recommendations: [{ id: 'book1', reason: '선택 이유', title: 'Invented title', href: 'javascript:bad' }],
          },
        }
      },
    },
    model,
    'test',
    candidates
  )
  assert.equal(result.books.length, 1)
  assert.equal(result.books[0].title, 'book1')
  assert.equal(result.books[0].href, candidates[1].href)
  assert.equal(result.books[0].reason, '선택 이유')
  assert.equal(result.explanationAvailable, true)
})

test('Invalid final output falls back to verified suggestions, while an explicit empty selection is respected', () => {
  for (const result of [
    { ok: false },
    { ok: true, json: {} },
    { ok: true, json: { recommendations: [{ id: 'invented', reason: 'fake' }] } },
    {
      ok: true,
      json: {
        recommendations: [
          { id: 'book0', reason: 'a' },
          { id: 'book0', reason: 'b' },
        ],
      },
    },
  ]) {
    const fallback = service.recommendBooks({ vercelAiGateway: () => result }, model, 'test', [candidate('book0')])
    assert.equal(fallback.books[0].reason, '책 소개: 도서 설명')
    assert.equal(fallback.explanationAvailable, false)
  }
  assert.equal(
    service.recommendBooks({ vercelAiGateway: () => ({ ok: true, json: { recommendations: [] } }) }, model, 'test', [
      candidate('book0'),
    ]).books.length,
    0
  )
  assert.equal(
    service.recommendBooks({ vercelAiGateway: () => assert.fail('No call for empty input') }, model, 'test', []).books
      .length,
    0
  )
})
