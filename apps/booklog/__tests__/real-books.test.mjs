import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startService } from '@pocketpages/test-support/service-harness'

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const port = 18104
const desktopDir = process.env.BOOKLOG_REAL_EPUB_DIR || 'C:/Users/kpcard/Desktop/업무/EPUB 파일'
const storageDir = path.join(serviceDir, 'pb_data/storage')

function findEpubs(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? findEpubs(path.join(root, item.name))
      : /\.epub$/i.test(item.name)
        ? [path.join(root, item.name)]
        : []
  )
}

// 평소에는 본문 파일 하나가 가장 큰(237KB) 책 한 권만 돌립니다. 전체는 BOOKLOG_REAL_EPUB_ALL=1로 돌립니다.
const sampleNames = ['z_library_dw2i47wv7h.epub']
const runAll = process.env.BOOKLOG_REAL_EPUB_ALL === '1'

// 내 컴퓨터에만 있는 실제 책들로 돌리는 확인이라, 같은 파일은 한 번만 올리고 책이 없으면 건너뜁니다.
const books = []
const seenHashes = new Set()
for (const [source, filePath] of runAll
  ? [
      ...findEpubs(desktopDir).map((filePath) => ['desktop', filePath]),
      ...findEpubs(storageDir).map((filePath) => ['db', filePath]),
    ]
  : sampleNames
      .map((name) => ['desktop', path.join(desktopDir, name)])
      .filter(([, filePath]) => existsSync(filePath))) {
  const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex')
  if (seenHashes.has(hash)) continue
  seenHashes.add(hash)
  books.push({ source, filePath, name: path.basename(filePath) })
}

let fixtureDir
let service
let session
const results = []

before(async () => {
  if (!books.length) return
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-realbooks-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  writeFileSync(
    path.join(fixtureDir, 'pb_hooks/pages/_private/data4library-service.js'),
    readFileSync(new URL('./fixtures/data4library-stub.js', import.meta.url), 'utf8')
  )
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:" + port + "' }"
    )
  )
  const binary = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'
  copyFileSync(path.join(serviceDir, binary), path.join(fixtureDir, binary))
  symlinkSync(realpathSync(path.join(serviceDir, 'node_modules')), path.join(fixtureDir, 'node_modules'), 'junction')
  const schema = JSON.parse(readFileSync(path.join(serviceDir, 'pb_schema.json'), 'utf8')).filter(
    (collection) => collection.name !== '_superusers'
  )
  writeFileSync(path.join(fixtureDir, 'pb_hooks/test-schema.json'), JSON.stringify(schema))
  copyFileSync(
    new URL('./fixtures/real-books-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  const response = await fetch(service.baseUrl + '/api/collections/users/auth-with-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'realbooks@example.com', password: 'test-password-1234' }),
  })
  const auth = await response.json()
  session = { Cookie: 'pb_auth=' + encodeURIComponent(JSON.stringify({ token: auth.token })) }
})

after(async () => {
  if (results.length) {
    const reportDir = path.join(serviceDir, 'test-results')
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(
      path.join(reportDir, 'real-books-report' + (runAll ? '-all' : '') + '.json'),
      JSON.stringify(results, null, 2)
    )
    const rows = results.map((result) => {
      const spine = result.spine || []
      const skipped = spine.filter((item) => !item.narrated && item.chars > 0)
      return [
        result.source + ': ' + result.name,
        result.status,
        (result.uploadMs / 1000).toFixed(1),
        result.file ? (result.file.size / 1048576).toFixed(1) : '',
        result.book ? result.book.title : '',
        result.book && result.book.author ? 'O' : '-',
        result.book && result.book.isbn13 ? 'O' : '-',
        result.book ? result.book.pages : '',
        result.audio ? result.audio.sectionCount + ' / ' + spine.length : '',
        result.audio ? result.audio.chunkCount : '',
        result.audio ? result.audio.shortChunks : '',
        result.audio ? (result.audio.ms / 1000).toFixed(1) : '',
        skipped.map((item) => item.href.split('/').pop() + ' ' + item.sample.slice(0, 18)).join('<br>'),
      ]
    })
    writeFileSync(
      path.join(reportDir, 'real-books-report' + (runAll ? '-all' : '') + '.md'),
      [
        '| 책 | 응답 | 업로드(초) | MB | 제목 | 저자 | ISBN | 페이지 | 낭독 챕터 / spine | 구간 | 20자 미만 구간 | 구간 나누기(초) | 낭독에서 뺀 페이지 표본 |',
        '|' + ' --- |'.repeat(13),
        ...rows.map((row) => '| ' + row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ') + ' |'),
      ].join('\n') + '\n'
    )
  }
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-realbooks-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('Real EPUB books are found on this computer', { skip: books.length ? false : 'no real EPUB folder' }, () => {
  assert.ok(books.length > 0)
})

for (const book of books) {
  test(`${book.source}: ${book.name} uploads, gets a page count and splits into narration parts`, async () => {
    const form = new FormData()
    form.set('epubFile', new Blob([readFileSync(book.filePath)], { type: 'application/epub+zip' }), book.name)
    const startedAt = Date.now()
    const response = await fetch(service.baseUrl + '/xapi/epub/upload', {
      method: 'POST',
      headers: session,
      redirect: 'manual',
      body: form,
    })
    const uploadMs = Date.now() - startedAt
    const message = decodeURIComponent(response.headers.get('location') || '')
    const result = { source: book.source, name: book.name, status: response.status, message, uploadMs }
    results.push(result)
    assert.equal(response.status, 303, message)
    assert.match(message, /EPUB 파일과 도서 메타데이터를 저장했습니다\.|기존 책과 파일을 찾아 서재에 연결했습니다\./)

    const detail = await (await fetch(service.baseUrl + '/_test/real-books/latest')).json()
    Object.assign(result, detail)
    assert.equal(detail.audio.error, '', 'narration planning did not throw')
    assert.equal(detail.readError, '')
    assert.ok(detail.book.pages > 0, 'page count ' + detail.book.pages)
    assert.ok(detail.audio.sectionCount > 0, 'some chapters are narrated')
    assert.ok(detail.audio.chunkCount > 0, 'narration parts are made')
    assert.equal(detail.audio.emptySections, 0, 'no narrated chapter is empty')
  })
}
