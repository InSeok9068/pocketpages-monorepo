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
  for (let index = 1; index <= 4; index += 1) {
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
    chunk.set('duration_seconds', 60)
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
