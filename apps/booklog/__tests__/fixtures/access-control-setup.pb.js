/* global onBootstrap, $app, $os, __hooks, Record, $filesystem, $security, routerAdd, $dbx */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  for (let index = 1; index <= 3; index += 1) {
    const user = new Record($app.findCollectionByNameOrId('users'))
    user.set('id', 'reviewuser0000' + index)
    user.set('email', 'reader' + index + '@example.com')
    user.set('password', 'test-password-1234')
    user.set('verified', true)
    user.set('booklog_enabled', index !== 3)
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
})

routerAdd('GET', '/_test/access-state', function (event) {
  const pending = $app.findRecordById('users', 'reviewuser00003')
  return event.json(200, {
    strangerShelfCount: $app.countRecords('book_shelves', $dbx.hashExp({ user_id: 'reviewuser00002' })),
    pendingApproved: pending.get('booklog_enabled'),
  })
})

routerAdd('POST', '/_test/approve', function (event) {
  const pending = $app.findRecordById('users', 'reviewuser00003')
  pending.set('booklog_enabled', true)
  $app.save(pending)
  return event.json(200, { ok: true })
})
