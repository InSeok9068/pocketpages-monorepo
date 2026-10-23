/* global onBootstrap, routerAdd, $app, $os, __hooks */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)
})

routerAdd('POST', '/_test/lifecycle/approve', function (event) {
  const user = $app.findFirstRecordByFilter('users', 'email = {:email}', {
    email: event.request.url.query().get('email'),
  })
  user.set('booklog_enabled', true)
  $app.save(user)
  return event.json(200, { ok: true })
})

routerAdd('GET', '/_test/lifecycle/state', function (event) {
  const query = event.request.url.query()
  const user = $app.findFirstRecordByFilter('users', 'email = {:email}', { email: query.get('email') })
  const shelves = $app.findRecordsByFilter('book_shelves', 'user_id = {:userId}', '', 0, 0, { userId: user.id })
  const shelf = shelves[0] || null
  const bookId = shelf ? String(shelf.get('book_id')) : String(query.get('bookId') || '')

  function count(collection) {
    return $app.findRecordsByFilter(collection, 'user_id = {:userId}', '', 0, 0, { userId: user.id }).length
  }

  return event.json(200, {
    shelfCount: shelves.length,
    bookId: bookId,
    bookFileId: shelf ? String(shelf.get('book_file_id')) : '',
    status: shelf ? String(shelf.get('status')) : '',
    progressPercent: shelf ? shelf.get('progress_percent') : null,
    personal: {
      sessions: count('reading_sessions'),
      highlights: count('book_highlights'),
      bookmarks: count('book_bookmarks'),
      reviews: count('book_reviews'),
    },
    sharedBooks: bookId ? $app.findRecordsByFilter('books', 'id = {:id}', '', 0, 0, { id: bookId }).length : 0,
    sharedFiles: bookId
      ? $app.findRecordsByFilter('book_files', 'book_id = {:id}', '', 0, 0, { id: bookId }).length
      : 0,
  })
})
