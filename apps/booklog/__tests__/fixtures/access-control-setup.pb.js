/* global onBootstrap, $app, $os, __hooks, Record, $filesystem, $security, routerAdd, $dbx, onRecordCreate */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  for (let index = 1; index <= 4; index += 1) {
    const user = new Record($app.findCollectionByNameOrId('users'))
    user.set('id', 'reviewuser0000' + index)
    user.set('email', 'reader' + index + '@example.com')
    user.set('password', 'test-password-1234')
    user.set('verified', true)
    user.set('booklog_enabled', index !== 3)
    user.set('admin_manager', index === 4)
    $app.save(user)
  }
  const book = new Record($app.findCollectionByNameOrId('books'))
  book.set('id', 'reviewbook00001')
  book.set('title', '권한 테스트 책')
  $app.save(book)
  const file = new Record($app.findCollectionByNameOrId('book_files'))
  file.set('book_id', book.id)
  file.set('stored_file', $filesystem.fileFromBytes([80, 75, 3, 4], 'fixture.epub'))
  file.set('original_name', 'fixture.epub')
  file.set('mime_type', 'application/epub+zip')
  file.set('file_size', 4)
  file.set('file_hash', $security.sha256('fixture'))
  $app.save(file)
  const shelf = new Record($app.findCollectionByNameOrId('book_shelves'))
  shelf.set('user_id', 'reviewuser00001')
  shelf.set('book_id', book.id)
  shelf.set('book_file_id', file.id)
  shelf.set('status', 'reading')
  $app.save(shelf)

  function saveRecord(collection, fields) {
    const record = new Record($app.findCollectionByNameOrId(collection))
    Object.keys(fields).forEach(function (key) {
      record.set(key, fields[key])
    })
    $app.save(record)
    return record
  }

  saveRecord('books', { id: 'adminbook000001', title: '관리 대상 책', author: '관리 저자' })
  saveRecord('books', { id: 'unusedbook00001', title: '미사용 관리 책' })
  saveRecord('books', {
    id: 'sharedbook00001',
    title: '공유 원본 책',
    author: '원본 저자',
    publisher: '원본 출판사',
    publication_year: '2020',
    isbn: '1100000011',
    isbn13: '9791100000014',
    book_image_url: 'https://example.com/cover.jpg',
    description: '원본 설명',
    estimated_page_count: 123,
    metadata_json: { source: 'original' },
  })
  saveRecord('books', { id: 'blankbook000001', title: '빈칸 책', isbn13: '9791100000021' })
  for (let index = 1; index <= 2; index += 1) {
    const fileId = 'adminfile00000' + index
    saveRecord('book_files', {
      id: fileId,
      book_id: 'adminbook000001',
      stored_file: $filesystem.fileFromBytes([80, 75, 3, 4], 'admin.epub'),
      original_name: 'admin.epub',
      mime_type: 'application/epub+zip',
      file_size: 4,
      file_hash: $security.sha256('admin-' + index),
    })
    const ownerId = index === 1 ? 'reviewuser00001' : 'reviewuser00004'
    const adminShelf = saveRecord('book_shelves', {
      user_id: ownerId,
      book_id: 'adminbook000001',
      book_file_id: fileId,
      status: 'reading',
    })
    const relation = { user_id: ownerId, book_id: 'adminbook000001', shelf_id: adminShelf.id }
    saveRecord('book_reviews', Object.assign({}, relation, { visibility: 'private', review_text: '관리 감상' }))
    const highlight = saveRecord(
      'book_highlights',
      Object.assign({}, relation, { file_id: fileId, quote_text: '관리 문장' })
    )
    saveRecord('book_bookmarks', Object.assign({}, relation, { file_id: fileId }))
    saveRecord(
      'reading_sessions',
      Object.assign({}, relation, {
        file_id: fileId,
        started_at: '2026-10-20 01:00:00.000Z',
        ended_at: '2026-10-20 01:01:00.000Z',
        duration_seconds: 60,
      })
    )
    const chunk = saveRecord('book_audio_chunks', {
      file_id: fileId,
      pipeline_version: 'test',
      text_hash: $security.sha256('chunk'),
      config_hash: $security.sha256('config'),
      input_text: '관리 음성',
      provider: 'gemini',
      model: 'test',
      voice: 'test',
      status: 'ready',
      audio_file: $filesystem.fileFromBytes([255, 251, 144, 0], 'admin.mp3'),
    })
    saveRecord('book_audio_progress', {
      user_id: ownerId,
      file_id: fileId,
      audio_chunk_id: chunk.id,
      config_hash: $security.sha256('config'),
    })
    saveRecord('book_audio_jobs', {
      file_id: fileId,
      requested_by: ownerId,
      pipeline_version: 'test',
      config_hash: $security.sha256('config'),
      provider: 'gemini',
      model: 'test',
      voice: 'test',
      status: 'completed',
    })
    saveRecord(
      'push_send_logs',
      Object.assign({}, relation, {
        highlight_id: highlight.id,
        notification_key: 'test',
        channel: 'push',
        send_status: 'sent',
      })
    )
  }
})

routerAdd('GET', '/_test/access-state', function (event) {
  const pending = $app.findRecordById('users', 'reviewuser00003')
  return event.json(200, {
    strangerShelfCount: $app.countRecords('book_shelves', $dbx.hashExp({ user_id: 'reviewuser00002' })),
    pendingApproved: pending.get('booklog_enabled'),
  })
})

onRecordCreate(function (event) {
  if ($app.store().get('failShelfSave') === true) {
    throw new Error('forced shelf save failure')
  }
  event.next()
}, 'book_shelves')

routerAdd('POST', '/_test/fail-shelf-save', function (event) {
  $app.store().set('failShelfSave', String(event.request.url.query().get('on')) === 'true')
  return event.json(200, { ok: true })
})

routerAdd('GET', '/_test/upload-state', function (event) {
  const title = String(event.request.url.query().get('title'))
  const books = $app.findRecordsByFilter('books', 'title = {:title}', '', 0, 0, { title })
  const files = []
  const shelves = []
  books.forEach(function (book) {
    $app.findRecordsByFilter('book_files', 'book_id = {:bookId}', '', 0, 0, { bookId: book.id }).forEach(function (file) {
      files.push({ id: file.id, path: file.baseFilesPath() + '/' + file.get('stored_file') })
    })
    $app.findRecordsByFilter('book_shelves', 'book_id = {:bookId}', '', 0, 0, { bookId: book.id }).forEach(function (shelf) {
      shelves.push({ userId: shelf.get('user_id'), bookFileId: shelf.get('book_file_id') })
    })
  })
  return event.json(200, { bookCount: books.length, files, shelves, storageRoot: $app.dataDir() + '/storage' })
})

routerAdd('GET', '/_test/book', function (event) {
  const query = event.request.url.query()
  const book = query.get('id')
    ? $app.findRecordById('books', String(query.get('id')))
    : $app.findFirstRecordByFilter('books', 'isbn13 = {:isbn13}', { isbn13: String(query.get('isbn13')) })
  const fields = {}
  ;['title', 'author', 'publisher', 'isbn13', 'book_image_url', 'description', 'estimated_page_count'].forEach(
    function (field) {
      fields[field] = book.get(field)
    }
  )
  return event.json(200, {
    id: book.id,
    fields,
    metadataJson: book.getString('metadata_json'),
    fileCount: $app.findRecordsByFilter('book_files', 'book_id = {:bookId}', '', 0, 0, { bookId: book.id }).length,
    shelves: $app
      .findRecordsByFilter('book_shelves', 'book_id = {:bookId}', '', 0, 0, { bookId: book.id })
      .map(function (shelf) {
        const file = $app.findRecordById('book_files', shelf.get('book_file_id'))
        return { userId: shelf.get('user_id'), fileBookId: file.get('book_id') }
      }),
  })
})

routerAdd('POST', '/_test/prepare-move', function (event) {
  const book = $app.findRecordById('books', String(event.request.url.query().get('bookId')))
  const isbn13 = book.get('isbn13')
  book.set('isbn13', '9791100000045')
  book.set('estimated_page_count', 0)
  $app.save(book)
  const other = new Record($app.findCollectionByNameOrId('books'))
  other.set('title', '같은 ISBN의 다른 책')
  other.set('isbn13', isbn13)
  $app.save(other)
  return event.json(200, { otherId: other.id })
})

routerAdd('POST', '/_test/approve', function (event) {
  const pending = $app.findRecordById('users', 'reviewuser00003')
  pending.set('booklog_enabled', true)
  $app.save(pending)
  return event.json(200, { ok: true })
})

routerAdd('GET', '/_test/admin-state', function (event) {
  const counts = {}
  ;[
    'books',
    'book_shelves',
    'book_reviews',
    'book_highlights',
    'book_bookmarks',
    'reading_sessions',
    'push_send_logs',
  ].forEach(function (collection) {
    counts[collection] = $app.countRecords(
      collection,
      $dbx.hashExp(collection === 'books' ? { id: 'adminbook000001' } : { book_id: 'adminbook000001' })
    )
  })
  const paths = []
  ;['book_files', 'book_audio_progress', 'book_audio_chunks', 'book_audio_jobs'].forEach(function (collection) {
    const filter =
      collection === 'book_files'
        ? "id = 'adminfile000001' || id = 'adminfile000002'"
        : "file_id = 'adminfile000001' || file_id = 'adminfile000002'"
    const records = $app.findRecordsByFilter(collection, filter, '', 0, 0)
    counts[collection] = records.length
    if (collection === 'book_files' || collection === 'book_audio_chunks') {
      records.forEach(function (record) {
        paths.push(
          record.baseFilesPath() + '/' + record.get(collection === 'book_files' ? 'stored_file' : 'audio_file')
        )
      })
    }
  })
  return event.json(200, {
    counts,
    paths,
    storageRoot: $app.dataDir() + '/storage',
    ownerAdmin: $app.findRecordById('users', 'reviewuser00001').get('admin_manager'),
    forgedAdminCount: $app.countRecords(
      'users',
      $dbx.hashExp({ email: 'forged-admin@example.com', admin_manager: true })
    ),
    originalBookCount: $app.countRecords('books', $dbx.hashExp({ id: 'reviewbook00001' })),
    originalFileCount: $app.countRecords('book_files', $dbx.hashExp({ book_id: 'reviewbook00001' })),
    unusedBookCount: $app.countRecords('books', $dbx.hashExp({ id: 'unusedbook00001' })),
  })
})
