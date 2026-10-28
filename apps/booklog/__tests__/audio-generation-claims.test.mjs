import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const generationSource = readFileSync(
  new URL('../pb_hooks/pages/_private/book-audio-generation-service.js', import.meta.url),
  'utf8'
)
const cronSource = readFileSync(new URL('../pb_hooks/jobs/audio-book-job.js', import.meta.url), 'utf8')
const nowMs = Date.parse('2026-10-28T01:00:00.000Z')
const claimedAt = '2026-10-28 00:59:00.000Z'
const newerClaim = '2026-10-28 01:00:01.000Z'

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [nowMs]))
  }

  static now() {
    return nowMs
  }
}

class MockRecord {
  constructor(fields) {
    this.fields = { ...fields }
  }

  get(field) {
    return this.fields[field] ?? ''
  }

  set(field, value) {
    this.fields[field] = value
  }
}

// 실제 디코더를 통과하는 MPEG-1 Layer III 프레임입니다. AI/네트워크는 전부 대체합니다.
const mp3 = Buffer.alloc(417)
mp3.set([0xff, 0xfb, 0x90, 0x64])
const speechSuccess = { ok: true, audio: { data: mp3.toString('base64'), mimeType: 'audio/mp3' } }
const providerFailure = (statusCode, errorMessage = 'provider unavailable') => ({
  ok: false,
  statusCode,
  errorMessage,
  responseJson: { error: { message: errorMessage } },
})

function loadModule(source, globals) {
  const context = vm.createContext({ module: { exports: {} }, Date: FixedDate, ...globals })
  vm.runInContext(source, context)
  return context.module.exports
}

function createHarness(options = {}) {
  const state = {
    chunk: {
      id: 'chunk-1',
      status: 'generating',
      generation_started_at: claimedAt,
      input_text: options.text || '짧은 본문',
      model: 'test-model',
      voice: 'test-voice',
      style: 'test-style',
      attempt_count: 0,
      audio_file: '',
      error_message: '',
      next_retry_at: '',
    },
    job: {
      id: 'job-1',
      status: 'running',
      started_at: claimedAt,
      next_run_at: '',
      error_message: '기존 안내',
    },
    aiClients: 0,
    speechCalls: [],
    fileCalls: 0,
    saves: [],
    logs: [],
    progressCalls: 0,
    transactions: 0,
  }
  const app = {
    findRecordById(collection, id) {
      const fields = collection === 'book_audio_chunks' ? state.chunk : state.job
      assert.equal(id, fields.id)
      return new MockRecord(fields)
    },
    findRecordsByFilter(collection) {
      return collection === 'book_audio_chunks' ? [] : [new MockRecord(state.job)]
    },
    runInTransaction(callback) {
      state.transactions += 1
      const chunk = { ...state.chunk }
      const job = { ...state.job }
      try {
        callback(app)
      } catch (error) {
        state.chunk = chunk
        state.job = job
        throw error
      }
    },
    save(record) {
      if (options.onSave) options.onSave(state, record)
      const target = record.get('id') === 'chunk-1' ? 'chunk' : 'job'
      state[target] = { ...record.fields }
      state.saves.push(target)
    },
    logger() {
      return Object.fromEntries(
        ['info', 'warn', 'error'].map((level) => [
          level,
          (...args) => state.logs.push({ level, event: args[0], args: args.slice(1) }),
        ])
      )
    },
  }
  const generation = loadModule(generationSource, {
    require(name) {
      assert.equal(name, '@pocketpages/ai')
      return {
        createAiClient(config) {
          state.aiClients += 1
          assert.equal(config.geminiApiKey, 'fake-key')
          assert.equal(config.maxAttempts, 1)
          return {
            geminiSpeech(input) {
              state.speechCalls.push(input)
              if (options.onSpeech) options.onSpeech(state)
              return options.response || speechSuccess
            },
          }
        },
      }
    },
    $filesystem: {
      fileFromBytes(bytes, filename) {
        state.fileCalls += 1
        assert.equal(filename, 'audio.mp3')
        assert.deepEqual(Buffer.from(bytes), mp3)
        if (options.onFile) options.onFile(state)
        return 'generated-audio.mp3'
      },
    },
  })
  const jobService = {
    applyRegenerateRequests() {
      return 0
    },
    needsPlanning() {
      return false
    },
    findNextChunk() {
      return new MockRecord(state.chunk)
    },
    syncJobProgress(txApp, job) {
      state.progressCalls += 1
      job.set('progress_marker', 'synced')
      txApp.save(job)
    },
  }
  const cron = loadModule(cronSource, {
    $app: app,
    __hooks: '/hooks',
    process: { env: { GEMINI_API_KEY: 'fake-key' } },
    require(name) {
      if (name === '@pocketpages/utils') {
        return { dateutil: { toDbDateTime: (value) => new Date(value).toISOString().replace('T', ' ') } }
      }
      if (name === '/hooks/pages/_private/book-audio-generation-service.js') return generation
      assert.equal(name, '/hooks/pages/_private/book-audio-job-service.js')
      return jobService
    },
  })
  return {
    state,
    generate: () => generation.generateClaimedChunk(app, 'fake-key', 'chunk-1', claimedAt),
    run: () => cron.run(),
  }
}

function assertClaimLost(result) {
  assert.deepEqual({ ...result }, {
    ok: false,
    statusCode: 409,
    blocked: false,
    split: false,
    error: 'claim expired',
    detail: '',
  })
}

for (const changed of [{ status: 'queued' }, { status: 'ready' }, { generation_started_at: newerClaim }]) {
  test('사전 claim 상실은 AI 클라이언트 생성과 호출을 생략한다: ' + JSON.stringify(changed), () => {
    const { state, generate } = createHarness()
    Object.assign(state.chunk, changed)
    const before = { ...state.chunk }
    assertClaimLost(generate())
    assert.equal(state.aiClients, 0)
    assert.equal(state.speechCalls.length, 0)
    assert.equal(state.fileCalls, 0)
    assert.equal(state.transactions, 0)
    assert.deepEqual(state.saves, [])
    assert.deepEqual(state.chunk, before)
  })
}

test('claim을 유지한 성공은 실제 저장 후에만 ok:true/200을 반환한다', () => {
  const { state, generate } = createHarness()
  const result = generate()
  assert.equal(result.ok, true)
  assert.equal(result.statusCode, 200)
  assert.equal(result.error, '')
  assert.equal(state.speechCalls.length, 1)
  assert.equal(state.speechCalls[0].input, '짧은 본문')
  assert.equal(state.chunk.status, 'ready')
  assert.equal(state.chunk.audio_file, 'generated-audio.mp3')
  assert.equal(state.chunk.duration_seconds, 1152 / 44100)
  assert.equal(state.chunk.generated_at, new Date(nowMs).toISOString())
  assert.equal(state.chunk.error_message, '')
  assert.equal(state.chunk.next_retry_at, '')
  assert.equal(state.chunk.attempt_count, 0)
  assert.deepEqual(state.saves, ['chunk'])
})

const outcomes = [
  { name: '생성 성공', response: speechSuccess },
  { name: '공급자 실패', response: providerFailure(503) },
  { name: '429 한도', response: providerFailure(429) },
  { name: '정책 차단', response: providerFailure(400, 'blocked by safety policy') },
  { name: '짧은 음성', text: '가'.repeat(300), response: speechSuccess },
  { name: '누락된 음성 예외', response: { ok: true } },
  { name: 'MP3 디코딩 예외', response: { ok: true, audio: { data: 'AAAA', mimeType: 'audio/wav' } } },
  { name: '공급자 호출 예외', throws: true },
]

for (const outcome of outcomes) {
  for (const changed of [{ status: 'ready' }, { generation_started_at: newerClaim }]) {
    test('응답 중 claim 상실은 새 구간을 보존한다: ' + outcome.name + ' / ' + JSON.stringify(changed), () => {
      let replacement
      const { state, generate } = createHarness({
        ...outcome,
        onSpeech(current) {
          Object.assign(current.chunk, changed, {
            audio_file: 'new-owner.mp3',
            error_message: '새 실행 안내',
            next_retry_at: '2026-10-28 02:00:00.000Z',
            attempt_count: 3,
          })
          replacement = { ...current.chunk }
          if (outcome.throws) throw new Error('provider threw')
        },
      })
      assertClaimLost(generate())
      assert.equal(state.speechCalls.length, 1)
      assert.deepEqual(state.chunk, replacement)
      assert.deepEqual(state.saves, [])
    })
  }
}

test('파일 준비 중 claim을 잃어도 성공 저장으로 보고하지 않는다', () => {
  const { state, generate } = createHarness({
    onFile(current) {
      current.chunk.generation_started_at = newerClaim
    },
  })
  assertClaimLost(generate())
  assert.equal(state.chunk.audio_file, '')
  assert.deepEqual(state.saves, [])
})

for (const outcome of outcomes) {
  test('cron 409는 job 상태·쿨다운·오류와 새 구간을 보존한다: ' + outcome.name, () => {
    let replacementJob
    let replacementChunk
    const { state, run } = createHarness({
      ...outcome,
      onSpeech(current) {
        Object.assign(current.chunk, { generation_started_at: newerClaim, error_message: '새 구간 오류' })
        Object.assign(current.job, {
          status: 'paused',
          next_run_at: '2026-10-28 03:00:00.000Z',
          error_message: '새 작업 안내',
          progress_marker: 'new-owner',
        })
        replacementJob = { ...current.job }
        replacementChunk = { ...current.chunk }
        if (outcome.throws) throw new Error('provider threw')
      },
    })
    state.chunk.status = 'queued'
    assert.deepEqual({ ...run() }, { jobId: 'job-1', chunkId: 'chunk-1', statusCode: 409 })
    assert.deepEqual(state.job, replacementJob)
    assert.deepEqual(state.chunk, replacementChunk)
    assert.equal(state.progressCalls, 0)
    assert.deepEqual(state.saves, ['chunk', 'job'], 'claim 획득 이후에는 저장하지 않아야 합니다.')
    assert.equal(state.logs.filter((log) => log.event === 'jobs/audio-book:claim-lost').length, 1)
    assert.ok(!state.logs.some((log) => ['jobs/audio-book:saved', 'jobs/audio-book:generation-failed'].includes(log.event)))
  })
}

const failures = [
  { name: '일반 공급자 실패', response: providerFailure(503), statusCode: 502, attempts: 1, wait: 10 },
  { name: '429', response: providerFailure(429), statusCode: 429, attempts: 0, wait: 30 },
  { name: '정책 차단', response: providerFailure(400, 'blocked by safety policy'), statusCode: 502, attempts: 1, wait: 0 },
  { name: '짧은 음성', text: '가'.repeat(300), response: speechSuccess, statusCode: 502, attempts: 1, wait: 10 },
  { name: '예외', response: { ok: true }, statusCode: 500, attempts: 1, wait: 10 },
]

for (const failure of failures) {
  test('claim 유지 시 cron의 기존 실패 동작을 유지한다: ' + failure.name, () => {
    const { state, run } = createHarness(failure)
    state.chunk.status = 'queued'
    assert.equal(run().statusCode, failure.statusCode)
    assert.equal(state.chunk.status, 'failed')
    assert.equal(state.chunk.attempt_count, failure.attempts)
    assert.equal(Date.parse(state.chunk.next_retry_at), nowMs + (failure.attempts ? 600000 : 0))
    assert.equal(state.job.status, 'running')
    assert.equal(
      state.job.next_run_at,
      failure.wait ? new Date(nowMs + failure.wait * 60000).toISOString() : ''
    )
    assert.match(state.job.error_message, failure.wait === 30 ? /30분/ : failure.wait === 10 ? /10분/ : /정책 필터/)
    assert.equal(state.progressCalls, 1)
    assert.ok(state.logs.some((log) => log.event === 'jobs/audio-book:generation-failed'))
    assert.ok(!state.logs.some((log) => ['jobs/audio-book:saved', 'jobs/audio-book:claim-lost'].includes(log.event)))
  })
}

test('cron 성공은 저장·진행도 반영 후 성공 로그를 남긴다', () => {
  const { state, run } = createHarness()
  state.chunk.status = 'queued'
  assert.equal(run().statusCode, 200)
  assert.equal(state.chunk.status, 'ready')
  assert.equal(state.job.error_message, '')
  assert.equal(state.job.next_run_at, '')
  assert.equal(state.progressCalls, 1)
  assert.ok(state.logs.some((log) => log.event === 'jobs/audio-book:saved'))
  assert.ok(!state.logs.some((log) => log.event === 'jobs/audio-book:claim-lost'))
})

test('저장 예외는 실제 성공으로 보고하지 않고 기존 실패 처리한다', () => {
  const { state, generate } = createHarness({
    onSave(current, record) {
      if (record.get('status') === 'ready') throw new Error('disk full')
    },
  })
  const result = generate()
  assert.equal(result.ok, false)
  assert.equal(result.statusCode, 500)
  assert.equal(result.error, 'disk full')
  assert.equal(state.chunk.status, 'failed')
  assert.equal(state.chunk.audio_file, '')
  assert.equal(state.chunk.attempt_count, 1)
})
