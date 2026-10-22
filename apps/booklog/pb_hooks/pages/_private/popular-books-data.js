const { dateutil, storeCache } = require('@pocketpages/utils')
const bookTitleService = require(__hooks + '/pages/_private/book-title.js')
const bookAuthorView = require(__hooks + '/pages/_private/book-author-view.js')

const CACHE_NAMESPACE = 'booklog:popular-books'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const LAST_GOOD_TTL_MS = 14 * 24 * 60 * 60 * 1000
const FAILURE_WAIT_MS = 10 * 60 * 1000
const CACHE_MAX_ENTRIES = 24
const LIST_SIZE = 30
const HOT_TREND_SIZE = 5
// 연령 조건이 없으면 학습만화 시리즈가 여러 권으로 상위를 채워서, 20대 이상 대출만 셉니다.
const ADULT_AGES = '20;30;40;50;60'
const CHILDREN_ADDITION_SYMBOL = /^7/

const POPULAR_TABS = {
  month: { label: '이번 달', days: 30, addCode: '' },
  steady: { label: '스테디셀러', days: 3 * 365, addCode: '0;1' },
}

/**
 * 요청한 탭 이름을 지원하는 탭으로 맞춥니다.
 * @param {string} value 요청한 탭
 * @returns {'month' | 'steady'} 탭 이름
 */
function normalizeTab(value) {
  return value === 'steady' ? 'steady' : 'month'
}

/**
 * 집계가 끝난 마지막 날(어제)을 YYYY-MM-DD로 반환합니다.
 * @param {Date} now 기준 시각
 * @returns {string} 기준일
 */
function getBaseDate(now) {
  return dateutil.formatDate(dateutil.addDays(now, -1), dateutil.FORMATS.DATE)
}

function formatDateOnly(value) {
  return dateutil.formatDate(value, dateutil.FORMATS.DATE)
}

function toPopularBook(doc) {
  return {
    isbn13: String(doc.isbn13 || '').trim(),
    title: bookTitleService.getMainTitle(doc.bookname),
    author: bookAuthorView.formatDisplayAuthor(doc.authors),
    publisher: String(doc.publisher || '').trim(),
    publicationYear: String(doc.publication_year || '').trim(),
    coverUrl: /^https?:\/\//.test(String(doc.bookImageURL || '')) ? String(doc.bookImageURL) : '',
    detailUrl: /^https?:\/\//.test(String(doc.bookDtlUrl || '')) ? String(doc.bookDtlUrl) : '',
    loanCount: Number(doc.loan_count || 0),
    loanCountText: String(Number(doc.loan_count || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    rankChange: Number(doc.difference || 0),
  }
}

// 같은 책의 다른 판본이 따로 순위에 잡혀서, 제목과 저자가 같으면 앞 순위 하나만 남깁니다.
function dedupeBooks(books) {
  const seen = {}

  return books.filter(function (book) {
    const key = book.title.replace(/\s+/g, '') + '|' + book.author.replace(/\s+/g, '')

    if (!book.title || seen[key]) return false
    seen[key] = true
    return true
  })
}

/**
 * 탭별 인기대출도서 요청 조건을 만듭니다.
 * @param {'month' | 'steady'} tab 탭 이름
 * @param {Date} now 기준 시각
 * @returns {{ startDt: string, endDt: string, age: string, addCode: string, pageSize: number }} 요청 조건
 */
function buildListRequest(tab, now) {
  const option = POPULAR_TABS[tab]
  const endDt = getBaseDate(now)

  return {
    startDt: formatDateOnly(dateutil.addDays(now, -option.days)),
    endDt: endDt,
    age: ADULT_AGES,
    addCode: option.addCode,
    pageSize: LIST_SIZE + 20,
  }
}

function getListCacheKey(tab, now) {
  return 'list:' + tab + ':' + getBaseDate(now)
}

function getHotTrendCacheKey(now) {
  return 'hot:' + getBaseDate(now)
}

function readCache(key) {
  return storeCache.get(CACHE_NAMESPACE, key, { maxEntries: CACHE_MAX_ENTRIES })
}

function writeCache(key, value, ttlMs) {
  storeCache.set(CACHE_NAMESPACE, key, value, { ttlMs: ttlMs, maxEntries: CACHE_MAX_ENTRIES })
}

function storeFreshList(name, dayKey, value) {
  writeCache(dayKey, value, CACHE_TTL_MS)
  writeCache('last:' + name, value, LAST_GOOD_TTL_MS)
  storeCache.remove(CACHE_NAMESPACE, 'failed:' + name)
}

function markListFailed(name, exception) {
  writeCache('failed:' + name, String(exception && exception.message ? exception.message : exception), FAILURE_WAIT_MS)
}

// 실패하면 10분 동안은 다시 부르지 않고, 마지막으로 받은 목록(전날 것이라도)을 대신 보여 줍니다.
function loadWithFallback(name, dayKey, load) {
  const cached = readCache(dayKey)
  let failure = null

  if (cached !== undefined) return cached

  if (readCache('failed:' + name) === undefined) {
    try {
      const value = load()
      storeFreshList(name, dayKey, value)
      return value
    } catch (exception) {
      failure = exception
      markListFailed(name, exception)
    }
  }

  const lastGood = readCache('last:' + name)
  if (lastGood !== undefined) return lastGood
  throw failure || new Error('도서관정보나루 목록을 잠시 불러올 수 없습니다. ' + readCache('failed:' + name))
}

function fetchPopularList(deps, tab, now) {
  const result = deps.data4libraryService.getPopularLoanBooks(deps.config, buildListRequest(tab, now))

  return dedupeBooks(result.docs.map(toPopularBook)).slice(0, LIST_SIZE)
}

function fetchHotTrend(deps, now) {
  const days = deps.data4libraryService.getHotTrendBooks(deps.config, { searchDt: getBaseDate(now) })
  const docs = []

  days.forEach(function (day) {
    day.docs.forEach(function (doc) {
      if (!CHILDREN_ADDITION_SYMBOL.test(String(doc.addition_symbol || ''))) docs.push(doc)
    })
  })

  return dedupeBooks(docs.map(toPopularBook)).slice(0, HOT_TREND_SIZE)
}

/**
 * 바로 보여 줄 수 있는 탭 목록을 읽습니다. 오늘 목록이 없고 최근 받기가 실패했으면 마지막 목록을 줍니다.
 * @param {'month' | 'steady'} tab 탭 이름
 * @param {Date} now 기준 시각
 * @returns {types.PopularBook[] | undefined} 보여 줄 목록
 */
function readCachedPopularList(tab, now) {
  const cached = readCache(getListCacheKey(tab, now))

  if (cached !== undefined || readCache('failed:list:' + tab) === undefined) return cached
  return readCache('last:list:' + tab)
}

/**
 * 탭 목록을 캐시에서 읽고, 없으면 도서관정보나루에서 받아 저장합니다. 실패하면 마지막 목록을 씁니다.
 * @param {types.PopularBooksDeps} deps API 서비스와 호출 설정
 * @param {'month' | 'steady'} tab 탭 이름
 * @param {Date} now 기준 시각
 * @returns {types.PopularBook[]} 인기 도서 목록
 */
function loadPopularList(deps, tab, now) {
  return loadWithFallback('list:' + tab, getListCacheKey(tab, now), function () {
    return fetchPopularList(deps, tab, now)
  })
}

/**
 * 최근 3일 대출 급상승 도서 중 아동서를 뺀 5권을 최근 날짜부터 고릅니다. 실패하면 마지막 목록을 씁니다.
 * @param {types.PopularBooksDeps} deps API 서비스와 호출 설정
 * @param {Date} now 기준 시각
 * @returns {types.PopularBook[]} 급상승 도서 목록
 */
function loadHotTrend(deps, now) {
  return loadWithFallback('hot', getHotTrendCacheKey(now), function () {
    return fetchHotTrend(deps, now)
  })
}

/**
 * 모든 탭과 급상승 목록을 새로 받아 오늘 캐시를 덮어씁니다.
 * @param {types.PopularBooksDeps} deps API 서비스와 호출 설정
 * @param {Date} now 기준 시각
 * @returns {Record<string, boolean>} 목록별 새로 받기 성공 여부
 */
function refreshAll(deps, now) {
  const targets = Object.keys(POPULAR_TABS).map(function (tab) {
    return {
      name: 'list:' + tab,
      dayKey: getListCacheKey(tab, now),
      load: function () {
        return fetchPopularList(deps, tab, now)
      },
    }
  })
  const result = {}

  targets.push({
    name: 'hot',
    dayKey: getHotTrendCacheKey(now),
    load: function () {
      return fetchHotTrend(deps, now)
    },
  })
  targets.forEach(function (target) {
    try {
      storeFreshList(target.name, target.dayKey, target.load())
      result[target.name] = true
    } catch (exception) {
      markListFailed(target.name, exception)
      result[target.name] = false
    }
  })

  return result
}

/**
 * 목록의 ISBN 중 사용자 도서함에 있는 책을 찾아 책 ID로 연결합니다.
 * @param {string} userId 사용자 ID
 * @param {types.PopularBook[]} books 인기 도서 목록
 * @returns {Record<string, string>} ISBN13별 책 ID
 */
function findShelfBookIds(userId, books) {
  const filterValues = { userId: userId }
  const conditions = []
  const bookIdsByIsbn = {}

  books.forEach(function (book) {
    if (!book.isbn13 || filterValues['isbn' + book.isbn13]) return
    filterValues['isbn' + book.isbn13] = book.isbn13
    conditions.push('book_id.isbn13 = {:isbn' + book.isbn13 + '}')
  })

  if (!conditions.length) return bookIdsByIsbn

  const shelves = $app.findRecordsByFilter(
    'book_shelves',
    'user_id = {:userId} && (' + conditions.join(' || ') + ')',
    '',
    0,
    0,
    filterValues
  )
  const bookIds = shelves.map(function (shelf) {
    return String(shelf.get('book_id') || '')
  })

  if (!bookIds.length) return bookIdsByIsbn

  $app.findRecordsByIds('books', bookIds).forEach(function (book) {
    bookIdsByIsbn[String(book.get('isbn13') || '')] = String(book.get('id') || '')
  })

  return bookIdsByIsbn
}

module.exports = {
  POPULAR_TABS,
  findShelfBookIds,
  normalizeTab,
  buildListRequest,
  readCachedPopularList,
  loadPopularList,
  loadHotTrend,
  refreshAll,
}
