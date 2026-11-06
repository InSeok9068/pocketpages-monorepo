import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../pb_hooks/pages/_private/book-audio-job-service.js', import.meta.url), 'utf8')
const generation = { MAX_ATTEMPTS: 5, BLOCKED_EXHAUSTED_MESSAGE: 'Gemini 정책 필터에 반복 차단되어 이 부분은 기기 음성으로 읽습니다.' }

function runProgress(chunks, fields = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE book_audio_chunks (file_id TEXT, config_hash TEXT, status TEXT, attempt_count NUMERIC, error_message TEXT)')
  const insert = db.prepare('INSERT INTO book_audio_chunks VALUES (?, ?, ?, ?, ?)')
  for (const chunk of chunks) {
    insert.run(chunk.fileId ?? 'file', chunk.configHash ?? 'config', chunk.status, chunk.attempts ?? 0, chunk.error ?? '')
  }
  const jobFields = { file_id: 'file', config_hash: 'config', total_chunks: 1, status: 'running', completed_at: '', ...fields }
  const job = { get: (name) => jobFields[name], set: (name, value) => { jobFields[name] = value } }
  let queries = 0
  let saves = 0
  const app = {
    db: () => ({
      newQuery(sql) {
        queries += 1
        return {
          bind(params) {
            return {
              one(model) {
                const statement = db.prepare(sql.replace(/\{:(\w+)\}/g, ':$1'))
                Object.assign(model, statement.get(params))
              },
            }
          },
        }
      },
    }),
    save(record) { assert.equal(record, job); saves += 1 },
  }
  const context = {
    module: { exports: {} },
    __hooks: '',
    require: (name) => name.endsWith('book-audio-generation-service.js') ? generation : {},
    DynamicModel: function (values) { Object.assign(this, values) },
  }
  vm.runInNewContext(source, context)
  try {
    const counts = context.module.exports.syncJobProgress(app, job)
    assert.equal(queries, 1)
    assert.equal(saves, 1)
    return { counts: { ...counts }, fields: jobFields }
  } finally {
    db.close()
  }
}

test('상태 집계는 파일·설정 범위를 지키고 기존 네 카운트의 조건을 유지한다', () => {
  const blocked = generation.BLOCKED_EXHAUSTED_MESSAGE
  const { counts, fields } = runProgress([
    { status: 'split', attempts: 5, error: blocked },
    { status: 'queued' },
    { status: 'generating' },
    { status: 'ready', error: blocked },
    { status: 'failed', attempts: 4 },
    { status: 'failed', attempts: 5 },
    { status: 'failed', attempts: 6, error: blocked + ' reason' },
    { status: 'failed', attempts: 1, error: blocked },
    { status: 'failed', attempts: 5, error: 'prefix ' + blocked },
    { status: 'ready', fileId: 'other-file' },
    { status: 'failed', attempts: 5, error: blocked, configHash: 'other-config' },
  ])
  assert.deepEqual(counts, { total: 8, ready: 1, failed: 3, blocked: 2 })
  assert.equal(fields.status, 'running')
  assert.equal(fields.total_chunks, 8)
  assert.equal(fields.ready_chunks, 1)
  assert.equal(fields.failed_chunks, 3)
})

test('빈 결과와 분할 부모만 있는 결과는 모두 0으로 집계한다', () => {
  for (const chunks of [[], [{ status: 'split' }]]) {
    assert.deepEqual(runProgress(chunks).counts, { total: 0, ready: 0, failed: 0, blocked: 0 })
  }
})

test('모두 준비되거나 정책 차단으로 끝난 작업의 완료 판정을 유지한다', () => {
  for (const chunks of [
    [{ status: 'ready' }],
    [{ status: 'ready' }, { status: 'failed', attempts: 5, error: generation.BLOCKED_EXHAUSTED_MESSAGE + ' reason' }],
  ]) {
    const { fields } = runProgress(chunks)
    assert.equal(fields.status, 'completed')
    assert.ok(fields.completed_at)
  }
})

test('최종 실패 판정과 일시정지 상태를 유지한다', () => {
  const chunks = [{ status: 'ready' }, { status: 'failed', attempts: 5 }]
  assert.equal(runProgress(chunks).fields.status, 'failed')
  assert.equal(runProgress(chunks, { status: 'paused' }).fields.status, 'paused')
})

test('구간 재등록을 기다리는 작업은 집계해도 재등록 표시를 유지한다', () => {
  const { counts, fields } = runProgress([{ status: 'ready' }], { total_chunks: 0 })
  assert.deepEqual(counts, { total: 1, ready: 1, failed: 0, blocked: 0 })
  assert.equal(fields.total_chunks, 0)
  assert.equal(fields.status, 'running')
})
