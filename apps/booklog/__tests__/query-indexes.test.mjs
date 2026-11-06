import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const schema = JSON.parse(readFileSync(new URL('../pb_schema.json', import.meta.url), 'utf8'))

function createDatabase() {
  // PocketBase에서 사용하는 기존 스키마의 큰따옴표 문자열 표기를 허용합니다.
  const db = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true })
  for (const collection of schema) {
    const columns = collection.fields.map((field) => {
      const type = field.type === 'number' || field.type === 'bool' ? 'NUMERIC' : 'TEXT'
      return `"${field.name}" ${type}${field.primaryKey ? ' PRIMARY KEY' : ''}`
    })
    db.exec(`CREATE TABLE "${collection.name}" (${columns.join(', ')})`)
    for (const index of collection.indexes) db.exec(index)
  }
  return db
}

const cases = [
  {
    name: '책별 사용자 집계는 책 중심 책장 인덱스를 사용한다',
    sql: 'SELECT count(DISTINCT user_id) FROM book_shelves WHERE book_id = ?',
    params: ['book'],
    index: 'idx_book_shelves_book_user',
  },
  {
    name: '사용자 문구 목록은 날짜순 인덱스로 정렬한다',
    sql: 'SELECT book_highlights.id FROM book_highlights JOIN books ON books.id = book_highlights.book_id WHERE book_highlights.user_id = ? ORDER BY book_highlights.highlighted_at DESC, book_highlights.updated DESC LIMIT 31',
    params: ['user'],
    index: 'idx_book_highlights_user_time',
  },
  {
    name: '사용자 리뷰 목록은 날짜순 인덱스로 정렬한다',
    sql: 'SELECT book_reviews.book_id FROM book_reviews JOIN books ON books.id = book_reviews.book_id WHERE book_reviews.user_id = ? ORDER BY book_reviews.reviewed_at DESC, book_reviews.updated DESC LIMIT 31',
    params: ['user'],
    index: 'idx_book_reviews_user_time',
  },
  {
    name: '만료 로그 조회는 발송 시각 인덱스를 사용한다',
    sql: "SELECT id FROM push_send_logs WHERE sent_at != '' AND sent_at < ?",
    params: ['2026-01-01 00:00:00.000Z'],
    index: 'idx_push_send_logs_sent_at',
  },
  {
    name: '파일별 청취 기록은 파일 중심 인덱스로 조회하고 정렬한다',
    sql: 'SELECT id FROM book_audio_progress WHERE file_id = ? AND config_hash = ? ORDER BY user_id, section_index',
    params: ['file', 'config'],
    index: 'idx_book_audio_progress_file_config_user_section',
  },
  {
    name: '빈 값 제외 조건이 있는 ISBN 조회는 부분 인덱스를 사용한다',
    sql: "SELECT id FROM books WHERE isbn13 != '' AND isbn13 = ? LIMIT 1",
    params: ['9781234567890'],
    index: 'idx_books_isbn13',
  },
  {
    name: '빈 값 제외 조건이 있는 발송 중복 조회는 부분 인덱스를 사용한다',
    sql: "SELECT id FROM push_send_logs WHERE dedupe_key != '' AND dedupe_key = ? AND send_status = 'sent' LIMIT 1",
    params: ['weekly:user:2026-11-02'],
    index: 'idx_push_send_logs_dedupe_key',
  },
]

for (const entry of cases) {
  test(entry.name, () => {
    const db = createDatabase()
    try {
      const details = db
        .prepare('EXPLAIN QUERY PLAN ' + entry.sql)
        .all(...entry.params)
        .map((row) => row.detail)
      assert.ok(
        details.some((detail) => detail.startsWith('SEARCH ') && detail.includes(entry.index)),
        details.join('\n')
      )
      assert.ok(!details.some((detail) => detail.includes('TEMP B-TREE')), details.join('\n'))
    } finally {
      db.close()
    }
  })
}
