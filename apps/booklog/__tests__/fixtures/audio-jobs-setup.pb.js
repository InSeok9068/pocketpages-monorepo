/* global onBootstrap, $app, $os, __hooks, Record, $filesystem, $security, routerAdd, DynamicModel, require */
// 격리된 HTTP 테스트 서비스에만 복사하는 초기 데이터와 제어 경로입니다.
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)
  const user = new Record($app.findCollectionByNameOrId('users'))
  user.set('id', 'user00000000001')
  user.set('email', 'admin-manager@example.com')
  user.set('password', 'test-password-1234')
  user.set('verified', true)
  user.set('admin_manager', true)
  user.set('booklog_enabled', true)
  $app.save(user)
  for (let index = 1; index <= 6; index += 1) {
    const suffix = ('00000000000' + index).slice(-11)
    const book = new Record($app.findCollectionByNameOrId('books'))
    book.set('id', 'book' + suffix)
    book.set('title', '테스트 책 ' + index + ' <제목>')
    $app.save(book)
    const file = new Record($app.findCollectionByNameOrId('book_files'))
    file.set('id', 'file' + suffix)
    file.set('book_id', book.id)
    file.set('original_name', 'test.epub')
    file.set('stored_file', $filesystem.fileFromBytes([80, 75, 3, 4], 'test.epub'))
    file.set('mime_type', 'application/epub+zip')
    file.set('file_size', 4)
    file.set('file_hash', $security.sha256(String(index)))
    $app.save(file)
    const shelf = new Record($app.findCollectionByNameOrId('book_shelves'))
    shelf.set('user_id', user.id)
    shelf.set('book_id', book.id)
    shelf.set('book_file_id', file.id)
    shelf.set('status', 'reading')
    $app.save(shelf)
  }
})

routerAdd('GET', '/_test/audio-state', function (event) {
  const jobs = $app.findRecordsByFilter('book_audio_jobs', '', 'created,id', 0, 0)
  return event.json(200, {
    jobs: jobs.map(function (job) {
      return job.publicExport()
    }),
  })
})

routerAdd('POST', '/_test/audio-control', function (event) {
  const input = new DynamicModel({ fileId: '', status: '', playback: false, regenerate: false, apply: false })
  event.bindBody(input)
  const audioData = require(__hooks + '/pages/_private/book-audio-data.js')
  const service = require(__hooks + '/pages/_private/book-audio-job-service.js')
  const job = audioData.findFileJob($app, input.fileId)
  if (input.status) {
    job.set('status', input.status)
    $app.save(job)
  }
  if (input.playback) {
    service.planJob($app, job.id, [{ sectionIndex: 0, chunks: ['낭독 테스트 문장입니다.'] }])
    const chunk = $app.findFirstRecordByFilter('book_audio_chunks', 'file_id = {:fileId}', { fileId: input.fileId })
    chunk.set('status', 'ready')
    chunk.set('audio_file', $filesystem.fileFromBytes([255, 251, 144, 0], 'test.mp3'))
    chunk.set('duration_seconds', 60.4)
    chunk.set('generated_at', new Date().toISOString())
    $app.save(chunk)
    service.syncJobProgress($app, $app.findRecordById('book_audio_jobs', job.id))
  }
  if (input.regenerate) {
    const chunk = $app.findFirstRecordByFilter('book_audio_chunks', 'file_id = {:fileId}', { fileId: input.fileId })
    chunk.set('regenerate_requested', true)
    $app.save(chunk)
  }
  const reset = input.apply ? service.applyRegenerateRequests($app, Date.now()) : 0
  return event.json(200, { reset })
})

// 모델 예약 흐름과 섞이지 않도록 작업을 직접 만들고, 구간 상태를 시나리오대로 바꿉니다.
routerAdd('POST', '/_test/audio-scenario', function (event) {
  const input = new DynamicModel({ fileId: '', name: '' })
  event.bindBody(input)
  const audioData = require(__hooks + '/pages/_private/book-audio-data.js')
  const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')
  const service = require(__hooks + '/pages/_private/book-audio-job-service.js')
  const settings = audioData.getSettings('gemini-3.8-flash-tts')
  let job = audioData.findFileJob($app, input.fileId)
  if (!job) {
    job = new Record($app.findCollectionByNameOrId('book_audio_jobs'))
    job.set('config_hash', settings.configHash)
    job.set('provider', settings.provider)
    job.set('model', settings.model)
    job.set('voice', settings.voice)
    job.set('style', settings.style)
    job.set('pipeline_version', settings.pipelineVersion)
    job.set('file_id', input.fileId)
    job.set('requested_by', 'user00000000001')
    job.set('status', 'running')
    job.set('total_chunks', 0)
    $app.save(job)
  }
  const chunks = function () {
    return $app.findRecordsByFilter('book_audio_chunks', 'file_id = {:fileId}', 'section_index,chunk_index', 0, 0, {
      fileId: input.fileId,
    })
  }
  if (input.name === 'blocked') {
    service.planJob($app, job.id, [{ sectionIndex: 0, chunks: ['첫 구간입니다.', '차단된 구간입니다.'] }])
    const planned = chunks()
    planned[0].set('status', 'ready')
    planned[0].set('audio_file', $filesystem.fileFromBytes([255, 251, 144, 0], 'test.mp3'))
    planned[0].set('duration_seconds', 60)
    $app.save(planned[0])
    planned[1].set('status', 'failed')
    planned[1].set('attempt_count', generation.MAX_ATTEMPTS)
    planned[1].set('error_message', generation.BLOCKED_EXHAUSTED_MESSAGE + ' 400 Request blocked')
    $app.save(planned[1])
    service.syncJobProgress($app, $app.findRecordById('book_audio_jobs', job.id))
  }
  if (input.name === 'plan') {
    service.planJob($app, job.id, [
      { sectionIndex: 0, chunks: ['가 구간', '나 구간', '다 구간'] },
      { sectionIndex: 2, chunks: ['라 구간'] },
      { sectionIndex: 4, chunks: ['마 구간'] },
    ])
  }
  if (input.name === 'replan') {
    service.planJob($app, job.id, [
      { sectionIndex: 0, chunks: ['가 구간'] },
      { sectionIndex: 4, chunks: ['마 구간'] },
    ])
  }
  return event.json(200, {
    job: $app.findRecordById('book_audio_jobs', job.id).publicExport(),
    chunks: chunks().map(function (chunk) {
      return { id: chunk.id, sectionIndex: chunk.get('section_index'), chunkIndex: chunk.get('chunk_index') }
    }),
  })
})
