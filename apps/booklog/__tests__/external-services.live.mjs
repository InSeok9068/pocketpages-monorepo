import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 실제 외부 서비스에 읽기 전용 요청만 보내 키·모델·응답 형식이 그대로인지 확인합니다. 음성 생성·추천·알림 발송은 하지 않습니다.
// 실행: node --test apps/booklog/__tests__/external-services.live.mjs

const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const envPath = serviceDir + '.env'
if (existsSync(envPath)) process.loadEnvFile(envPath)

const TIMEOUT_MS = 15_000

function readSource(relativePath) {
  return readFileSync(serviceDir + relativePath, 'utf8')
}

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim()
    if (value) return value
  }
  return ''
}

function requireEnv(...names) {
  const value = envValue(...names)
  assert.ok(value, names.join(' 또는 ') + ' 환경변수가 없습니다.')
  return value
}

function kstDate(offsetDays) {
  const date = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000)
  return date.toISOString().slice(0, 10)
}

async function getJson(url, headers, secrets) {
  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redact('요청 실패: ' + (error && error.message ? error.message : error), secrets))
  }
  const text = await response.text()
  return { status: response.status, json: parseJson(text), text: redact(text.slice(0, 300), secrets) }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function redact(text, secrets) {
  let result = String(text)
  for (const secret of secrets || []) {
    if (secret) result = result.split(encodeURIComponent(secret)).join('[REDACTED]').split(secret).join('[REDACTED]')
  }
  return result
}

function data4library(path, query) {
  const apiKey = requireEnv('DATA4LIBRARY_APIKEY')
  const params = new URLSearchParams({ authKey: apiKey, format: 'json', ...query })
  return getJson('https://data4library.kr/api' + path + '?' + params, {}, [apiKey]).then((result) => {
    assert.equal(result.status, 200, path + ' status ' + result.status + ': ' + result.text)
    assert.ok(result.json && result.json.response, path + ' 응답에 response가 없습니다: ' + result.text)
    assert.ok(!result.json.response.error, path + ' 오류: ' + redact(result.json.response.error, [apiKey]))
    return result.json.response
  })
}

test('data4library: 도서 검색과 상세 조회가 앱이 읽는 필드를 돌려준다', async () => {
  const search = await data4library('/srchBooks', { title: '어린 왕자', pageNo: 1, pageSize: 1, sort: 'loan_count', direction: 'desc' })
  const doc = search.docs && search.docs[0] && search.docs[0].doc
  assert.ok(doc, '검색 결과 docs[0].doc가 없습니다.')
  for (const field of ['bookname', 'authors', 'publisher', 'isbn13', 'bookImageURL']) {
    assert.ok(field in doc, '검색 결과에 ' + field + ' 필드가 없습니다.')
  }

  const detail = await data4library('/srchDtlList', { isbn13: doc.isbn13, loaninfoYN: 'Y' })
  const book = detail.detail && detail.detail[0] && detail.detail[0].book
  assert.ok(book, '상세 조회 detail[0].book이 없습니다.')
  assert.ok('bookname' in book && 'isbn13' in book, '상세 조회 book에 bookname·isbn13이 없습니다.')
})

test('data4library: 인기 대출 도서와 급상승 도서를 불러온다', async () => {
  const loans = await data4library('/loanItemSrch', { startDt: kstDate(-31), endDt: kstDate(-1), pageSize: 1 })
  const loan = loans.docs && loans.docs[0] && loans.docs[0].doc
  assert.ok(loan && loan.isbn13 && loan.bookname, '인기 대출 도서 docs[0].doc에 isbn13·bookname이 없습니다.')

  const trend = await data4library('/hotTrend', { searchDt: kstDate(-1) })
  assert.ok(Array.isArray(trend.results), '급상승 도서 응답에 results 배열이 없습니다.')
})

test('Gemini: 키가 유효하고 낭독 모델이 모두 남아 있다', async () => {
  const apiKey = requireEnv('GEMINI_API_KEY', 'GEMINI_APIKEY', 'GEMINI_AI_KEY')
  const expected = [...readSource('pb_hooks/pages/_private/book-audio-data.js').matchAll(/model: '(gemini-[^']+)'/g)].map(
    (match) => match[1]
  )
  assert.ok(expected.length, 'book-audio-data.js에서 낭독 모델을 찾지 못했습니다.')

  const names = new Set()
  let pageToken = ''
  do {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' + (pageToken ? '&pageToken=' + pageToken : '')
    const result = await getJson(url, { 'x-goog-api-key': apiKey }, [apiKey])
    assert.equal(result.status, 200, 'Gemini 모델 목록 status ' + result.status + ': ' + result.text)
    for (const model of result.json.models || []) names.add(String(model.name).replace(/^models\//, ''))
    pageToken = result.json.nextPageToken || ''
  } while (pageToken)

  const missing = expected.filter((model) => !names.has(model))
  assert.deepEqual(missing, [], 'Gemini에서 사라진 낭독 모델이 있습니다.')
})

test('Vercel AI Gateway: 키가 유효하고 추천 모델이 모두 남아 있다', async () => {
  const apiKey = requireEnv('VERCEL_AI_GATEWAY_API_KEY')
  const source = readSource('pb_hooks/pages/xapi/books/recommend.ejs')
  const expected = ['BOOKLOG_RECOMMENDATION_SUGGESTION_MODEL', 'BOOKLOG_RECOMMENDATION_TEXT_MODEL'].map((name) => {
    const fallback = (source.match(new RegExp("env\\('" + name + "'\\) \\|\\| '([^']+)'")) || [])[1]
    assert.ok(fallback, 'recommend.ejs에서 ' + name + ' 기본 모델을 찾지 못했습니다.')
    return envValue(name) || fallback
  })

  const credits = await getJson('https://ai-gateway.vercel.sh/v1/credits', { authorization: 'Bearer ' + apiKey }, [apiKey])
  assert.equal(credits.status, 200, 'AI Gateway 키 확인 status ' + credits.status + ': ' + credits.text)
  assert.ok(Number(credits.json && credits.json.balance) > 0, 'AI Gateway 잔액이 없습니다: ' + credits.text)

  const models = await getJson('https://ai-gateway.vercel.sh/v1/models', {}, [apiKey])
  assert.equal(models.status, 200, 'AI Gateway 모델 목록 status ' + models.status + ': ' + models.text)
  const ids = new Set((models.json.data || []).map((model) => model.id))
  const missing = expected.filter((model) => !ids.has(model))
  assert.deepEqual(missing, [], 'AI Gateway에서 사라진 추천 모델이 있습니다.')
})

test('OneSignal: 앱 ID와 키로 알림 기록을 조회할 수 있다', async () => {
  const appId = requireEnv('ONESIGNAL_APPID')
  const apiKey = requireEnv('ONESIGNAL_APIKEY')
  const result = await getJson(
    'https://api.onesignal.com/notifications?app_id=' + encodeURIComponent(appId) + '&limit=1',
    { authorization: 'Key ' + apiKey },
    [apiKey]
  )
  assert.equal(result.status, 200, 'OneSignal status ' + result.status + ': ' + result.text)
  assert.ok(Array.isArray(result.json && result.json.notifications), 'OneSignal 응답에 notifications 배열이 없습니다.')
})
