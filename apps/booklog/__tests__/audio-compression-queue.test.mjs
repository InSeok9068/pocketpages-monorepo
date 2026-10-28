import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../pb_hooks/pages/_private/book-audio-compress-service.js', import.meta.url), 'utf8')
const cacheSource = readFileSync(new URL('../../../packages/utils/store-cache.js', import.meta.url), 'utf8')
const retryNamespace = 'booklog:audio-compress-retry'
const retryDelay = 30 * 60 * 1000

function record(fields) {
  return {
    fields: { ...fields },
    get(name) {
      return this.fields[name] ?? ''
    },
    set(name, value) {
      this.fields[name] = value
    },
    baseFilesPath() {
      return 'files/' + this.get('id')
    },
  }
}

function job(id, fields = {}) {
  return record({ id, file_id: 'file-' + id, config_hash: 'config', compress_kbps: 64, updated: id, ...fields })
}

function chunk(id, parent, fields = {}) {
  return record({
    id,
    file_id: parent.get('file_id'),
    config_hash: parent.get('config_hash'),
    section_index: 0,
    chunk_index: Number(id.replace(/\D/g, '')) || 0,
    split_path: '',
    status: 'ready',
    audio_file: id + '.mp3',
    audio_kbps: 0,
    generated_at: '2026-10-28 00:00:00.000Z',
    ...fields,
  })
}

function retryKey(item, kbps) {
  return [item.get('id'), kbps, item.get('audio_file'), item.get('generated_at')].join(':')
}

function harness(jobs, chunks) {
  let now = Date.parse('2026-10-28T01:00:00Z')
  const store = new Map()
  const attempts = []
  const failures = new Set()
  const queries = []
  const errors = []
  const removed = []
  const cacheRemovals = []
  let readersClosed = 0
  let filesystemsClosed = 0
  let beforeTransaction = null
  const app = {
    store: () => ({ get: (key) => store.get(key), set: (key, value) => store.set(key, value) }),
    findRecordsByFilter(collection, _filter, sort, limit, offset, params) {
      queries.push({ collection, offset, limit })
      const records = collection === 'book_audio_jobs'
        ? jobs.filter((entry) => entry.get('compress_kbps') > 0)
        : chunks.filter((entry) =>
          entry.get('file_id') === params.fileId
          && entry.get('config_hash') === params.configHash
          && entry.get('status') === 'ready'
          && entry.get('audio_file') !== ''
          && (entry.get('audio_kbps') === 0 || entry.get('audio_kbps') > params.kbps)
        )
      records.sort((left, right) => {
        for (const field of sort.split(',')) {
          if (left.get(field) < right.get(field)) return -1
          if (left.get(field) > right.get(field)) return 1
        }
        return 0
      })
      return records.slice(offset, offset + limit)
    },
    findRecordById(_collection, id) {
      const found = chunks.find((entry) => entry.get('id') === id)
      assert.ok(found, 'the selected chunk exists')
      return found
    },
    newFilesystem: () => ({
      getReader: () => ({ close: () => { readersClosed += 1 } }),
      close: () => { filesystemsClosed += 1 },
    }),
    runInTransaction(callback) {
      if (beforeTransaction) beforeTransaction()
      callback(app)
    },
    save() {},
    logger: () => ({ error: (...args) => errors.push(args) }),
  }
  class Clock extends Date {
    static now() {
      return now
    }
  }
  const cacheContext = { module: { exports: {} }, $app: app, Date: Clock }
  vm.runInNewContext(cacheSource, cacheContext)
  const storeCache = cacheContext.module.exports
  const remove = storeCache.remove
  storeCache.remove = (namespace, key) => {
    cacheRemovals.push(key)
    return remove(namespace, key)
  }
  const context = {
    module: { exports: {} },
    __hooks: '/hooks',
    require: (name) => name === '@pocketpages/utils' ? { storeCache } : { mp3Duration: () => 12.5 },
    $filepath: { join: (...parts) => parts.join('/') },
    $os: {
      tempDir: () => '/tmp',
      writeFile() {},
      readFile: () => new Uint8Array([1, 2, 3]),
      remove: (path) => removed.push(path),
      cmd: (...args) => ({
        combinedOutput() {
          const id = args.at(-1).match(/booklog-audio-(.*)\.mp3$/)[1]
          attempts.push({ id, kbps: Number(args[4]) })
          if (failures.has(id)) throw new Error('encoder failed for ' + id)
          return ''
        },
      }),
    },
    $filesystem: { fileFromPath: (path) => path.split('/').at(-1) + '-compressed' },
    toBytes: () => new Uint8Array([1]),
    toString: (value) => String(value),
  }
  vm.runInNewContext(source, context)
  return {
    run: () => JSON.parse(JSON.stringify(context.module.exports.compressNextChunks(app))),
    hold: (item, kbps = 64) => storeCache.set(retryNamespace, retryKey(item, kbps), true, { ttlMs: retryDelay }),
    advance: (ms) => { now += ms },
    resetStore: () => store.clear(),
    beforeSave: (callback) => { beforeTransaction = callback },
    attempts,
    failures,
    queries,
    errors,
    removed,
    cacheRemovals,
    resources: () => ({ readersClosed, filesystemsClosed }),
  }
}

const emptyResult = { jobId: '', compressed: 0, failed: 0 }

test('Compression finds unfinished work after two full pages of completed jobs', () => {
  const jobs = Array.from({ length: 101 }, (_, index) => job('job' + String(index).padStart(3, '0')))
  const last = chunk('chunk1', jobs.at(-1))
  const h = harness(jobs, [last])
  assert.deepEqual(h.run(), { jobId: jobs.at(-1).get('id'), compressed: 1, failed: 0 })
  assert.deepEqual(h.queries.filter((query) => query.collection === 'book_audio_jobs').map((query) => query.offset), [0, 50, 100])
  assert.equal(last.get('audio_kbps'), 64)
  assert.deepEqual(h.attempts, [{ id: 'chunk1', kbps: 64 }])
})

test('Compression skips a full page of cooling-down chunks and never skips candidates after writes', () => {
  const parent = job('job')
  const chunks = Array.from({ length: 61 }, (_, index) => chunk('chunk' + index, parent))
  const h = harness([parent], chunks)
  chunks.slice(0, 55).forEach((item) => h.hold(item))
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 5, failed: 0 })
  assert.deepEqual(h.attempts.map((entry) => entry.id), chunks.slice(55, 60).map((item) => item.get('id')))
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 1, failed: 0 })
  assert.deepEqual(h.attempts.map((entry) => entry.id), chunks.slice(55).map((item) => item.get('id')))
  assert.deepEqual(h.run(), emptyResult)
  assert.ok(h.queries.some((query) => query.collection === 'book_audio_chunks' && query.offset === 50))
})

test('Five persistent failures do not block another job and retry only after thirty minutes', () => {
  const first = job('a')
  const second = job('b')
  const failed = Array.from({ length: 5 }, (_, index) => chunk('failed' + index, first))
  const h = harness([first, second], [...failed, chunk('other1', second)])
  failed.forEach((item) => h.failures.add(item.get('id')))
  assert.deepEqual(h.run(), { jobId: 'a', compressed: 0, failed: 5 })
  assert.equal(h.attempts.length, 5, 'failures count towards the per-run attempt limit')
  assert.deepEqual(h.run(), { jobId: 'b', compressed: 1, failed: 0 })
  assert.deepEqual(h.run(), emptyResult)
  h.advance(retryDelay - 1)
  assert.deepEqual(h.run(), emptyResult)
  assert.equal(h.attempts.length, 6)
  h.failures.clear()
  h.advance(1)
  const retryKeys = failed.map((item) => retryKey(item, 64))
  assert.deepEqual(h.run(), { jobId: 'a', compressed: 5, failed: 0 })
  assert.equal(h.attempts.length, 11)
  retryKeys.forEach((key) => assert.ok(h.cacheRemovals.includes(key), 'successful retries clear the failure marker'))
  assert.equal(h.errors.length, 5)
})

test('Mixed successes and failures leave every later chunk available on the next run', () => {
  const parent = job('job')
  const chunks = Array.from({ length: 8 }, (_, index) => chunk('chunk' + index, parent))
  const h = harness([parent], chunks)
  h.failures.add('chunk0')
  h.failures.add('chunk1')
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 3, failed: 2 })
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 3, failed: 0 })
  assert.deepEqual(h.attempts.map((entry) => entry.id), chunks.map((item) => item.get('id')))
  assert.deepEqual(h.run(), emptyResult)
  assert.deepEqual(h.resources(), { readersClosed: 8, filesystemsClosed: 8 })
  assert.equal(h.removed.length, 16, 'temporary files are cleaned up even when encoding fails')
})

for (const [field, value] of [['audio_file', 'regenerated.mp3'], ['generated_at', '2026-10-28 02:00:00.000Z']]) {
  test('A regenerated source bypasses an old compression failure when ' + field + ' changes', () => {
    const parent = job('job')
    const item = chunk('chunk1', parent)
    const h = harness([parent], [item])
    h.hold(item)
    assert.deepEqual(h.run(), emptyResult)
    item.set(field, value)
    assert.deepEqual(h.run(), { jobId: 'job', compressed: 1, failed: 0 })
  })
}

test('Changing the bitrate bypasses cooldown for a different target', () => {
  const parent = job('job')
  const item = chunk('chunk1', parent)
  const h = harness([parent], [item])
  h.hold(item, 64)
  assert.deepEqual(h.run(), emptyResult)
  parent.set('compress_kbps', 48)
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 1, failed: 0 })
  assert.deepEqual(h.attempts, [{ id: 'chunk1', kbps: 48 }])
})

test('A server-store reset safely allows a previously failed compression to retry', () => {
  const parent = job('job')
  const item = chunk('chunk1', parent)
  const h = harness([parent], [item])
  h.hold(item)
  assert.deepEqual(h.run(), emptyResult)
  h.resetStore()
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 1, failed: 0 })
})

test('Already compressed, non-ready and mismatched chunks are not attempted', () => {
  const parent = job('job')
  const chunks = [
    chunk('chunk1', parent, { audio_kbps: 64 }),
    chunk('chunk2', parent, { audio_kbps: 48 }),
    chunk('chunk3', parent, { status: 'generating' }),
    chunk('chunk4', parent, { audio_file: '' }),
    chunk('chunk5', parent, { config_hash: 'different' }),
    chunk('chunk6', parent, { file_id: 'different' }),
  ]
  const h = harness([parent], chunks)
  assert.deepEqual(h.run(), emptyResult)
  assert.equal(h.attempts.length, 0)
})

test('A source replaced during compression is not overwritten or treated as an encoder failure', () => {
  const parent = job('job')
  const item = chunk('chunk1', parent)
  const h = harness([parent], [item])
  h.beforeSave(() => {
    item.set('audio_file', 'new-source.mp3')
    item.set('generated_at', '2026-10-28 03:00:00.000Z')
  })
  assert.deepEqual(h.run(), { jobId: 'job', compressed: 0, failed: 0 })
  assert.equal(item.get('audio_file'), 'new-source.mp3')
  assert.equal(item.get('audio_kbps'), 0)
  assert.equal(h.errors.length, 0)
  assert.equal(h.removed.length, 2)
  assert.deepEqual(h.resources(), { readersClosed: 1, filesystemsClosed: 1 })
})

test('Empty queues and unsupported bitrate settings finish without compression', () => {
  assert.deepEqual(harness([], []).run(), emptyResult)
  const parent = job('job', { compress_kbps: 32 })
  const h = harness([parent], [chunk('chunk1', parent)])
  assert.deepEqual(h.run(), emptyResult)
  assert.equal(h.attempts.length, 0)
})
