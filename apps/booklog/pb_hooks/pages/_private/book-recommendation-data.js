const he = require('he')
const bookTitleService = require(__hooks + '/pages/_private/book-title.js')
const bookAuthorView = require(__hooks + '/pages/_private/book-author-view.js')

/**
 * 도서 설명의 마크업과 길이를 정리합니다.
 * @param {unknown} value 원본 설명
 * @returns {string} 추천에 사용할 설명
 */
function cleanDescription(value) {
  return he
    .decode(String(value || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s.,;:：·ㆍ'"()[\]{}!?\-]/g, '')
}

/**
 * 중복·완독 여부를 비교할 키를 만듭니다.
 * @param {types.BookRecommendationCandidate} book 도서 정보
 * @returns {string[]} ISBN과 제목·저자 키
 */
function bookKeys(book) {
  const keys = ['title:' + normalizeName(book.title) + '|' + normalizeName(book.author)]
  if (book.isbn13) keys.push('isbn:' + book.isbn13)
  return keys
}

/**
 * 사용자 도서함의 연결 정보와 완독·중단 도서 키를 읽습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} userId 현재 사용자 ID
 * @returns {types.BookRecommendationShelfData} 사용자 소유 도서와 제외 키
 */
function loadShelfData(app, userId) {
  const shelves = app.findRecordsByFilter('book_shelves', 'user_id = {:userId}', '-updated', 0, 0, { userId })
  const books = []
  const excludedKeys = []
  if (!shelves.length) return { books, excludedKeys }
  const records = app.findRecordsByIds(
    'books',
    shelves.map(function (shelf) {
      return String(shelf.get('book_id'))
    })
  )
  const byId = {}
  records.forEach(function (record) {
    byId[String(record.get('id'))] = record
  })
  shelves.forEach(function (shelf) {
    const bookId = String(shelf.get('book_id'))
    const record = byId[bookId]
    if (!record) return
    /** @type {types.BookRecommendationCandidate} */
    const book = {
      id: '',
      bookId,
      isbn13: String(record.get('isbn13') || '').trim(),
      title: bookTitleService.getMainTitle(String(record.get('title') || '')),
      author: bookAuthorView.formatDisplayAuthor(String(record.get('author') || '')),
      description: cleanDescription(record.get('description')),
      className: String(record.get('class_no') || ''),
      publicationYear: String(record.get('publication_year') || ''),
      publisher: String(record.get('publisher') || ''),
      pageCount: Math.max(0, Number(record.get('estimated_page_count')) || 0),
      coverUrl: /^https?:\/\//.test(String(record.get('book_image_url') || ''))
        ? String(record.get('book_image_url'))
        : '',
      href: '/books/' + bookId + '?from=/',
      source: 'shelf',
    }
    const status = String(shelf.get('status') || '')
    if (status === 'finished' || status === 'dropped') excludedKeys.push.apply(excludedKeys, bookKeys(book))
    else if (book.title) books.push(book)
  })
  return { books, excludedKeys }
}

/**
 * 모델 제안을 도서 검색 결과의 제목·저자·ISBN과 대조합니다.
 * @param {any} data4library 도서 검색 클라이언트
 * @param {{ apiKey: string, timeout: number }} config 검색 설정
 * @param {types.BookRecommendationSuggestion} suggestion 모델이 제안한 제목·저자
 * @returns {types.BookRecommendationCandidate | null} 확인된 도서 또는 null
 */
function findSuggestedBook(data4library, config, suggestion) {
  const result = data4library.searchBooks(config, { title: suggestion.title, pageSize: 10 })
  const titleKey = normalizeName(bookTitleService.getMainTitle(suggestion.title))
  const authorKey = normalizeName(bookAuthorView.formatDisplayAuthor(suggestion.author))
  if (!titleKey || authorKey.length < 2) return null
  const docs = Array.isArray(result.docs) ? result.docs : []
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]
    const title = bookTitleService.getMainTitle(String(doc.bookname || ''))
    const author = bookAuthorView.formatDisplayAuthor(String(doc.authors || ''))
    if (normalizeName(title) !== titleKey || normalizeName(author).indexOf(authorKey) === -1) continue
    const isbn13 = String(doc.isbn13 || '').replace(/[\s-]/g, '')
    if (!/^97[89]\d{10}$/.test(isbn13)) continue
    let sum = 0
    for (let digit = 0; digit < 12; digit += 1) sum += Number(isbn13[digit]) * (digit % 2 === 0 ? 1 : 3)
    if ((10 - (sum % 10)) % 10 !== Number(isbn13[12])) continue
    return {
      id: '',
      bookId: '',
      isbn13,
      title,
      author,
      description: cleanDescription(doc.description),
      className: String(doc.class_nm || doc.class_no || ''),
      publicationYear: String(doc.publication_year || ''),
      publisher: String(doc.publisher || ''),
      pageCount: 0,
      coverUrl: /^https?:\/\//.test(String(doc.bookImageURL || '')) ? String(doc.bookImageURL) : '',
      href: /^https?:\/\//.test(String(doc.bookDtlUrl || ''))
        ? String(doc.bookDtlUrl)
        : 'https://search.naver.com/search.naver?query=' + encodeURIComponent(isbn13),
      source: 'discovery',
    }
  }
  return null
}

/**
 * 확인된 후보에서 중복·완독 도서를 제거하고 본인 도서함 링크를 연결합니다.
 * @param {types.BookRecommendationShelfData} shelfData 사용자 도서함
 * @param {types.BookRecommendationCandidate[]} verifiedBooks 확인된 도서
 * @returns {types.BookRecommendationCandidate[]} 최종 추천 후보
 */
function buildCandidates(shelfData, verifiedBooks) {
  const seen = {}
  shelfData.excludedKeys.forEach(function (key) {
    seen[key] = true
  })
  const candidates = []
  verifiedBooks.forEach(function (book) {
    const keys = bookKeys(book)
    if (
      keys.some(function (key) {
        return seen[key]
      })
    )
      return
    keys.forEach(function (key) {
      seen[key] = true
    })
    const owned = shelfData.books.filter(function (item) {
      return bookKeys(item).some(function (key) {
        return keys.indexOf(key) !== -1
      })
    })[0]
    const candidate = Object.assign({}, book, { id: 'book' + candidates.length })
    if (owned) {
      candidate.bookId = owned.bookId
      candidate.href = owned.href
      candidate.source = 'shelf'
      candidate.pageCount = owned.pageCount
      if (!candidate.description) candidate.description = owned.description
    }
    candidates.push(candidate)
  })
  return candidates
}

module.exports = { loadShelfData, findSuggestedBook, buildCandidates, cleanDescription }
