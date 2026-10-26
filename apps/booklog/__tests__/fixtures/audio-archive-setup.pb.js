/* global onBootstrap, $app, $os, __hooks, Record, $filesystem, $security, routerAdd, require, toBytes */
// 격리된 보관·복원 HTTP 테스트 서비스에만 복사하는 초기 데이터와 제어 경로입니다.
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)
  ;[
    { id: 'user00000000001', email: 'admin-manager@example.com', admin: true },
    { id: 'user00000000002', email: 'reader@example.com', admin: false },
  ].forEach(function (entry) {
    const user = new Record($app.findCollectionByNameOrId('users'))
    user.set('id', entry.id)
    user.set('email', entry.email)
    user.set('password', 'test-password-1234')
    user.set('verified', true)
    user.set('admin_manager', entry.admin)
    user.set('booklog_enabled', true)
    $app.save(user)
  })
  for (let index = 1; index <= 8; index += 1) {
    const suffix = ('00000000000' + index).slice(-11)
    const book = new Record($app.findCollectionByNameOrId('books'))
    book.set('id', 'book' + suffix)
    book.set('title', '보관 테스트 책 ' + index)
    $app.save(book)
    const file = new Record($app.findCollectionByNameOrId('book_files'))
    file.set('id', 'file' + suffix)
    file.set('book_id', book.id)
    file.set('original_name', 'test.epub')
    file.set('stored_file', $filesystem.fileFromBytes([80, 75, 3, 4], 'test.epub'))
    file.set('mime_type', 'application/epub+zip')
    file.set('file_size', 4)
    file.set('file_hash', $security.sha256('archive-' + index))
    $app.save(file)
    ;['user00000000001', 'user00000000002'].forEach(function (userId) {
      const shelf = new Record($app.findCollectionByNameOrId('book_shelves'))
      shelf.set('user_id', userId)
      shelf.set('book_id', book.id)
      shelf.set('book_file_id', file.id)
      shelf.set('status', 'reading')
      $app.save(shelf)
    })
  }
})

routerAdd('POST', '/_test/archive-epub', function (event) {
  try {
    const input = event.requestInfo().body
    const file = $app.findRecordById('book_files', String(input.fileId))
    const bytes = []
    for (let index = 0; index < input.bytes.length; index += 1) bytes.push(Number(input.bytes[index]))
    file.set('stored_file', $filesystem.fileFromBytes(bytes, 'book.epub'))
    file.set('file_size', bytes.length)
    $app.save(file)
    const sections = require(__hooks + '/pages/_private/book-audio-data.js').readBookSections($app, file, toBytes)
    return event.json(200, { sections: sections.length })
  } catch (exception) {
    return event.json(500, { error: String(exception && exception.stack ? exception.stack : exception) })
  }
})

// 생성 cron 없이 실제 구간 등록으로 작업을 만들고, 완료·조각·차단·대기 구간과 청취 위치를 섞어 둡니다.
routerAdd('POST', '/_test/archive-seed', function (event) {
  const helpers = require(__hooks + '/test-archive-helpers.js')
  const input = event.requestInfo().body
  const fileId = String(input.fileId)
  const audioData = require(__hooks + '/pages/_private/book-audio-data.js')
  const jobService = require(__hooks + '/pages/_private/book-audio-job-service.js')
  const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')
  const settings = audioData.getSettings(audioData.DEFAULT_MODEL)
  const job = new Record($app.findCollectionByNameOrId('book_audio_jobs'))
  job.set('file_id', fileId)
  job.set('requested_by', 'user00000000001')
  job.set('config_hash', settings.configHash)
  job.set('provider', settings.provider)
  job.set('model', settings.model)
  job.set('voice', settings.voice)
  job.set('style', settings.style)
  job.set('pipeline_version', settings.pipelineVersion)
  job.set('status', 'running')
  job.set('started_at', new Date().toISOString())
  $app.save(job)
  const file = $app.findRecordById('book_files', fileId)
  jobService.planJob($app, job.id, audioData.readBookSections($app, file, toBytes))
  const top = helpers.chunksOf(fileId)
  top.forEach(function (chunk, index) {
    if (input.allReady || index === 0 || index > 2) {
      helpers.setReady(chunk, 20 + index, index === 0 ? 64 : 0)
      return
    }
    if (index === 1) {
      $app.runInTransaction(function (txApp) {
        const parent = txApp.findRecordById('book_audio_chunks', chunk.id)
        parent.set('status', 'failed')
        parent.set('attempt_count', generation.MAX_ATTEMPTS)
        parent.set('error_message', generation.BLOCKED_EXHAUSTED_MESSAGE + ' 400 Request blocked')
        if (!generation.splitBlockedChunk(txApp, parent)) throw new Error('조각 구간을 만들지 못했습니다.')
        txApp.save(parent)
      })
      const parts = helpers.chunksOf(fileId).filter(function (part) {
        return part.get('section_index') === chunk.get('section_index') && part.get('chunk_index') === chunk.get('chunk_index') && part.get('split_path')
      })
      helpers.setReady(parts[0], 31, 0)
      parts[1].set('status', 'failed')
      parts[1].set('attempt_count', generation.MAX_ATTEMPTS)
      parts[1].set('error_message', generation.BLOCKED_EXHAUSTED_MESSAGE + ' 400 Request blocked')
      $app.save(parts[1])
    }
    if (index === 2) {
      chunk.set('status', 'generating')
      chunk.set('generation_started_at', new Date().toISOString())
      $app.save(chunk)
    }
  })
  const planned = $app.findRecordById('book_audio_jobs', job.id)
  planned.set('compress_kbps', 64)
  jobService.syncJobProgress($app, planned)
  const progress = $app.findCollectionByNameOrId('book_audio_progress')
  ;[
    { userId: 'user00000000001', chunk: top[0], seconds: 12.5, completed: false },
    { userId: 'user00000000002', chunk: top[top.length - 1], seconds: 3, completed: true },
    { userId: 'user00000000001', chunk: top[top.length - 1], seconds: 1.5, completed: false },
  ].forEach(function (entry) {
    if (entry.userId === 'user00000000001' && entry.chunk === top[top.length - 1] && top.length === 1) return
    const record = new Record(progress)
    record.set('user_id', entry.userId)
    record.set('file_id', fileId)
    record.set('config_hash', settings.configHash)
    record.set('section_index', entry.chunk.get('section_index'))
    record.set('audio_chunk_id', entry.chunk.id)
    record.set('chunk_index', entry.chunk.get('chunk_index'))
    record.set('position_seconds', entry.seconds)
    record.set('is_completed', entry.completed)
    record.set('last_listened_at', new Date().toISOString())
    $app.save(record)
  })
  return event.json(200, { chunks: helpers.chunksOf(fileId).length })
})

routerAdd('GET', '/_test/archive-state', function (event) {
  const helpers = require(__hooks + '/test-archive-helpers.js')
  const fileId = String(event.request.url.query().get('fileId'))
  const job = require(__hooks + '/pages/_private/book-audio-data.js').findFileJob($app, fileId)
  const keysById = {}
  const fsys = $app.newFilesystem()
  try {
    const chunks = helpers.chunksOf(fileId).map(function (chunk) {
      keysById[chunk.id] = helpers.keyOf(chunk)
      return {
        id: chunk.id,
        key: helpers.keyOf(chunk),
        status: chunk.get('status'),
        attempts: chunk.get('attempt_count'),
        error: chunk.get('error_message'),
        duration: Math.round(chunk.get('duration_seconds') * 1000) / 1000,
        kbps: chunk.get('audio_kbps'),
        configHash: chunk.get('config_hash'),
        audio: helpers.audioDigest(fsys, chunk),
      }
    })
    const progress = $app
      .findRecordsByFilter('book_audio_progress', 'file_id = {:fileId}', 'user_id,section_index', 0, 0, { fileId })
      .map(function (record) {
        return {
          userId: record.get('user_id'),
          section: record.get('section_index'),
          chunk: record.get('chunk_index'),
          chunkKey: keysById[record.get('audio_chunk_id')] || '',
          seconds: record.get('position_seconds'),
          completed: record.get('is_completed'),
        }
      })
    const workspaces = $os.readDir($os.tempDir()).filter(function (entry) {
      return String(entry.name()).indexOf('booklog-audio-archive-') === 0
    }).length
    return event.json(200, {
      job: job
        ? {
            id: job.id,
            status: job.get('status'),
            model: job.get('model'),
            voice: job.get('voice'),
            style: job.get('style'),
            configHash: job.get('config_hash'),
            compressKbps: job.get('compress_kbps'),
            totalChunks: job.get('total_chunks'),
            readyChunks: job.get('ready_chunks'),
          }
        : null,
      chunks,
      progress,
      workspaces,
    })
  } finally {
    fsys.close()
  }
})
