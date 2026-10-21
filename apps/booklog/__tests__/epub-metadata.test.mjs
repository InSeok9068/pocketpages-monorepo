import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const serviceRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
globalThis.__hooks = serviceRoot + 'pb_hooks'

function createService() {
  const context = { module: { exports: {} }, require, __hooks: serviceRoot + 'pb_hooks' }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/epub-book-metadata-service.js', import.meta.url), 'utf8'),
    context
  )
  const detailRequests = []
  const service = context.module.exports.create({
    data4libraryService: {
      searchBooks() {
        return { numFound: 0, docs: [], raw: {} }
      },
      getBookDetail(_config, input) {
        detailRequests.push(input.isbn13)
        return { book: null }
      },
    },
    toBytes() {},
    dbg() {},
    info() {},
    warn() {},
    apiKey: 'test',
  })
  return { service, detailRequests }
}

function parseOpf(service, metadataXml) {
  return service.parseEpubMetadata(
    service.parseXmlDocument(
      '<package version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><metadata>'
        + metadataXml
        + '</metadata></package>'
    )
  )
}

test('Plain OPF title, creator, publisher, language and a single identifier are read', () => {
  const { service } = createService()
  const metadata = parseOpf(
    service,
    '<dc:title>최강록의 요리 노트</dc:title><dc:creator>최강록</dc:creator><dc:publisher>출판사 클</dc:publisher>'
      + '<dc:language>ko</dc:language><dc:identifier>9791192512433</dc:identifier>'
  )
  assert.equal(metadata.title, '최강록의 요리 노트')
  assert.equal(metadata.author, '최강록')
  assert.equal(metadata.publisher, '출판사 클')
  assert.equal(metadata.languageCode, 'ko')
  assert.equal(metadata.isbn13, '9791192512433')
})

test('OPF values with attributes or repeated elements keep working', () => {
  const { service } = createService()
  const metadata = parseOpf(
    service,
    '<dc:title id="t">불편한 편의점</dc:title><dc:creator opf:role="aut">김호연</dc:creator>'
      + '<dc:language>ko</dc:language><dc:language>KO</dc:language>'
      + '<dc:identifier id="bookid">urn:uuid:29d919dd-24f5-4384-be78-b447c9dc299b</dc:identifier>'
      + '<dc:identifier opf:scheme="ISBN">979-11-6157-119-5</dc:identifier>'
  )
  assert.equal(metadata.title, '불편한 편의점')
  assert.equal(metadata.author, '김호연')
  assert.equal(metadata.languageCode, 'ko')
  assert.equal(metadata.isbn13, '9791161571195')
})

test('A translator creator is skipped when choosing the author', () => {
  const { service } = createService()
  const metadata = parseOpf(
    service,
    '<dc:title>코스모스</dc:title><dc:creator opf:role="trl">홍승수</dc:creator><dc:creator opf:role="aut">칼 세이건</dc:creator>'
  )
  assert.equal(metadata.author, '칼 세이건')
  const translatorOnly = parseOpf(service, '<dc:title>번역서</dc:title><dc:creator opf:role="trl">홍승수</dc:creator>')
  assert.equal(translatorOnly.author, '')
})

test('Primary author names drop role labels found in real EPUB creators', () => {
  const { service } = createService()
  const cases = {
    '하시구치 유키오 저 / 구수진 역': '하시구치 유키오',
    '지은이 | 이시한 지음': '이시한',
    '게일 가젤 지음│손현선 옮김': '게일 가젤',
    '데일 카네기 지음 | 임상훈 옮김': '데일 카네기',
    '김호연': '김호연',
    '알랭 드 보통': '알랭 드 보통',
    '데이비드 A. 케슬러': '데이비드 A. 케슬러',
    '폴커 키츠, 마누엘 투쉬': '폴커 키츠, 마누엘 투쉬',
  }
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(service.extractPrimaryAuthorName(input), expected, input)
  }
})

test('ISBN candidates with a wrong check digit or placeholder digits are ignored', () => {
  const { service, detailRequests } = createService()
  const metadata = parseOpf(
    service,
    '<dc:title>체크섬</dc:title><dc:identifier opf:scheme="ISBN">979-11-6157-119-6</dc:identifier>'
      + '<dc:identifier opf:scheme="ISBN">000-00-000-0000-0 (00000)</dc:identifier>'
  )
  assert.equal(metadata.isbn13, '')
  const entries = {
    'OPS/copyright.xhtml': new TextEncoder().encode(
      '<html><body><p>종이책 ISBN 979-11-6157-118-9 03810</p><p>전자책 ISBN 979-11-6157-119-5 05810</p></body></html>'
    ),
  }
  service.resolveBookLookup(
    metadata,
    entries,
    [{ id: 'c', href: 'copyright.xhtml', mediaType: 'application/xhtml+xml' }],
    'OPS/book.opf',
    Object.keys(entries),
    'book.epub'
  )
  assert.deepEqual(detailRequests, ['9791161571195'])
})

test('A data4library network error never carries the API key', () => {
  const context = {
    module: { exports: {} },
    require: (name) => (name === 'pocketpages' ? { globalApi: { dbg() {} } } : require(name)),
    $http: {
      send(options) {
        throw new Error('Get "' + options.url + '": context deadline exceeded')
      },
    },
  }
  vm.runInNewContext(
    readFileSync(new URL('../pb_hooks/pages/_private/data4library-service.js', import.meta.url), 'utf8'),
    context
  )
  assert.throws(
    () => context.module.exports.searchBooks({ apiKey: 'SECRET-KEY/1' }, { keyword: '책' }),
    (error) => /요청에 실패했습니다/.test(error.message) && !/SECRET-KEY/.test(error.message)
  )
})

test('Unpacked EPUB text is limited to 16MB per file and 200MB per book', () => {
  const { createTextEntrySizeGuard } = require('./pb_hooks/pages/_private/epub-reading-metrics.js')
  const MB = 1024 * 1024

  const realBook = createTextEntrySizeGuard()
  realBook('OPS/footnote.xhtml', 234 * 1024)
  realBook('OPS/chapter.xhtml', 16 * MB)

  assert.throws(() => createTextEntrySizeGuard()('OPS/huge.xhtml', 16 * MB + 1), {
    userMessage: '압축을 푼 본문 크기가 너무 커서 처리할 수 없는 EPUB입니다.',
  })

  const manyFiles = createTextEntrySizeGuard()
  for (let index = 0; index < 12; index += 1) manyFiles('OPS/part' + index + '.xhtml', 16 * MB)
  assert.throws(() => manyFiles('OPS/part12.xhtml', 16 * MB), /total/)
})
