import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeEach, test } from 'node:test'
import vm from 'node:vm'

const serviceRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const storeValues = new Map()
globalThis.__hooks = serviceRoot + 'pb_hooks'
globalThis.$app = {
  store: () => ({
    get: (key) => storeValues.get(key),
    set: (key, value) => storeValues.set(key, value),
  }),
}

function loadModule() {
  const context = { module: { exports: {} }, require, __hooks: serviceRoot + 'pb_hooks' }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/popular-books-data.js', import.meta.url), 'utf8'),
    context
  )
  return context.module.exports
}

function doc(ranking, bookname, authors, extra = {}) {
  return {
    ranking: String(ranking),
    bookname,
    authors,
    publisher: '출판사',
    publication_year: '2024',
    isbn13: '97900000000' + String(ranking).padStart(2, '0'),
    addition_symbol: '03810',
    bookImageURL: 'https://image.aladin.co.kr/cover' + ranking + '.jpg',
    bookDtlUrl: 'https://data4library.kr/bookV?seq=' + ranking,
    loan_count: String(1000 + ranking),
    ...extra,
  }
}

function createDeps(overrides = {}) {
  const calls = { popular: [], hot: [] }
  return {
    calls,
    deps: {
      config: { apiKey: 'test' },
      data4libraryService: {
        getPopularLoanBooks(_config, input) {
          calls.popular.push(input)
          if (overrides.popular) return overrides.popular(input)
          return { numFound: 3, docs: [] }
        },
        getHotTrendBooks(_config, input) {
          calls.hot.push(input)
          return overrides.hot ? overrides.hot(input) : []
        },
      },
    },
  }
}

const now = new Date('2026-10-22T03:00:00Z')

beforeEach(() => storeValues.clear())

test('Each tab asks for adult loans up to yesterday, and the steady tab covers three years of general books', () => {
  const data = loadModule()

  assert.deepEqual(
    { ...data.buildListRequest('month', now) },
    {
      startDt: '2026-09-22',
      endDt: '2026-10-21',
      age: '20;30;40;50;60',
      addCode: '',
      pageSize: 50,
    }
  )
  const steady = data.buildListRequest('steady', now)
  assert.equal(steady.startDt, '2023-10-23')
  assert.equal(steady.addCode, '0;1')
  assert.equal(data.normalizeTab('steady'), 'steady')
  assert.equal(data.normalizeTab('anything'), 'month')
})

test('Editions of the same book count once, and names are tidied for display', () => {
  const data = loadModule()
  const { deps } = createDeps({
    popular: () => ({
      numFound: 4,
      docs: [
        doc(1, '불편한 편의점 :김호연 장편소설 ', '지은이: 김호연'),
        doc(2, '프로젝트 헤일메리 ', '앤디 위어 지음 ;강동혁 옮김', { loan_count: '125560' }),
        doc(3, '불편한 편의점 :김호연 장편소설', '지은이: 김호연'),
        doc(4, '표지 없는 책', '저자', { bookImageURL: 'javascript:alert(1)' }),
      ],
    }),
  })

  const books = data.loadPopularList(deps, 'month', now)

  assert.deepEqual(
    books.map((book) => [book.title, book.author]),
    [
      ['불편한 편의점', '김호연'],
      ['프로젝트 헤일메리', '앤디 위어'],
      ['표지 없는 책', '저자'],
    ]
  )
  assert.equal(books[1].loanCountText, '125,560')
  assert.equal(books[2].coverUrl, '')
})

test('A loaded list is reused for the day without calling the API again, and a failed load is not cached', () => {
  const data = loadModule()
  const { deps, calls } = createDeps({ popular: () => ({ numFound: 1, docs: [doc(1, '책', '저자')] }) })

  assert.equal(data.readCachedPopularList('month', now), undefined)
  data.loadPopularList(deps, 'month', now)
  data.loadPopularList(deps, 'month', new Date('2026-10-22T10:00:00Z'))
  assert.equal(calls.popular.length, 1)
  assert.equal(data.readCachedPopularList('month', now).length, 1)
  assert.equal(data.readCachedPopularList('steady', now), undefined)

  data.loadPopularList(deps, 'month', new Date('2026-10-23T03:00:00Z'))
  assert.equal(calls.popular.length, 2)

  const failing = createDeps({
    popular: () => {
      throw new Error('도서관정보나루 API 요청에 실패했습니다.')
    },
  })
  assert.throws(() => data.loadPopularList(failing.deps, 'steady', now))
  assert.equal(data.readCachedPopularList('steady', now), undefined)
})

test('Rising books skip children books and repeats across days, newest day first, up to five', () => {
  const data = loadModule()
  const { deps, calls } = createDeps({
    hot: () => [
      {
        date: '2026-10-21',
        docs: [
          doc(1, '도둑맞은 집중력', '요한 하리 지음', { difference: '264' }),
          doc(2, '에그박사', '원작: 에그박사', { addition_symbol: '77490', difference: '126' }),
          doc(3, '테오', '지은이: 앨런 레비', { difference: '104' }),
        ],
      },
      {
        date: '2026-10-20',
        docs: [
          doc(1, '도둑맞은 집중력', '요한 하리 지음', { difference: '229' }),
          doc(4, '수족관', '지은이: 유래혁'),
          doc(5, '세종의 나라 2', '김진명'),
          doc(6, '종의 기원', '지은이: 정유정'),
          doc(7, '여섯 번째 책', '지은이: 누군가'),
        ],
      },
    ],
  })

  const books = data.loadHotTrend(deps, now)

  assert.equal(calls.hot[0].searchDt, '2026-10-21')
  assert.deepEqual(
    Array.from(books, (book) => book.title),
    ['도둑맞은 집중력', '테오', '수족관', '세종의 나라 2', '종의 기원']
  )
  assert.equal(books[0].rankChange, 264)
})

function withClock(start) {
  const realNow = Date.now
  let current = start
  Date.now = () => current
  return {
    advance(ms) {
      current += ms
    },
    restore() {
      Date.now = realNow
    },
  }
}

test('When the API fails, the last good list is shown and the API is left alone for ten minutes', () => {
  const data = loadModule()
  const clock = withClock(Date.parse('2026-10-22T03:00:00Z'))
  let failing = false
  const { deps, calls } = createDeps({
    popular: () => {
      if (failing) throw new Error('도서관정보나루 API 요청에 실패했습니다. timeout')
      return { numFound: 1, docs: [doc(1, '어제 받은 책', '저자')] }
    },
  })

  try {
    data.loadPopularList(deps, 'month', now)
    failing = true
    clock.advance(24 * 60 * 60 * 1000)
    const nextDay = new Date('2026-10-23T03:00:00Z')

    assert.equal(data.readCachedPopularList('month', nextDay), undefined)
    assert.deepEqual(
      data.loadPopularList(deps, 'month', nextDay).map((book) => book.title),
      ['어제 받은 책']
    )
    assert.deepEqual(
      data.readCachedPopularList('month', nextDay).map((book) => book.title),
      ['어제 받은 책']
    )
    data.loadPopularList(deps, 'month', nextDay)
    assert.equal(calls.popular.length, 2, 'no retry inside the wait window')

    clock.advance(10 * 60 * 1000 + 1)
    failing = false
    assert.equal(data.readCachedPopularList('month', nextDay), undefined)
    data.loadPopularList(deps, 'month', nextDay)
    assert.equal(calls.popular.length, 3)
  } finally {
    clock.restore()
  }
})

test('Without any earlier list, a failure is reported quickly instead of waiting on the API every visit', () => {
  const data = loadModule()
  const { deps, calls } = createDeps({
    popular: () => {
      throw new Error('도서관정보나루 API 요청에 실패했습니다. timeout')
    },
  })

  assert.throws(() => data.loadPopularList(deps, 'steady', now), /timeout/)
  assert.throws(() => data.loadPopularList(deps, 'steady', now), /잠시 불러올 수 없습니다/)
  assert.equal(calls.popular.length, 1)
})

test('The early-morning refresh replaces today’s lists and reports which ones failed', () => {
  const data = loadModule()
  let version = 1
  const { deps, calls } = createDeps({
    popular: (input) => {
      if (input.addCode === '0;1' && version === 2) throw new Error('timeout')
      return { numFound: 1, docs: [doc(1, '판 ' + version + (input.addCode ? ' 스테디' : ''), '저자')] }
    },
    hot: () => [{ date: '2026-10-21', docs: [doc(9, '급상승 ' + version, '저자')] }],
  })

  assert.deepEqual({ ...data.refreshAll(deps, now) }, { 'list:month': true, 'list:steady': true, 'hot': true })
  version = 2
  assert.deepEqual({ ...data.refreshAll(deps, now) }, { 'list:month': true, 'list:steady': false, 'hot': true })

  assert.equal(data.loadPopularList(deps, 'month', now)[0].title, '판 2')
  assert.equal(data.loadHotTrend(deps, now)[0].title, '급상승 2')
  assert.equal(data.loadPopularList(deps, 'steady', now)[0].title, '판 1 스테디')
  assert.equal(calls.popular.length, 4)
})
