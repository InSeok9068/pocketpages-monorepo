/* global onBootstrap, $app, $os, __hooks, Record */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  const user = new Record($app.findCollectionByNameOrId('users'))
  user.set('id', 'user00000000001')
  user.set('email', 'reader@example.com')
  user.set('password', 'test-password-1234')
  user.set('verified', true)
  user.set('booklog_enabled', true)
  $app.save(user)

  for (let index = 1; index <= 55; index += 1) {
    const suffix = ('00000000000' + index).slice(-11)
    const book = new Record($app.findCollectionByNameOrId('books'))
    book.set('id', 'book' + suffix)
    book.set('title', '테스트 책 ' + index)
    $app.save(book)

    const shelf = new Record($app.findCollectionByNameOrId('book_shelves'))
    shelf.set('user_id', user.id)
    shelf.set('book_id', book.id)
    shelf.set('status', 'reading')
    $app.save(shelf)

    const review = new Record($app.findCollectionByNameOrId('book_reviews'))
    review.set('user_id', user.id)
    review.set('book_id', book.id)
    review.set('review_text', '저장된 감상평 ' + index)
    review.set('visibility', 'private')
    review.set('reviewed_at', new Date(Date.UTC(2026, 0, index)).toISOString())
    $app.save(review)

    const highlight = new Record($app.findCollectionByNameOrId('book_highlights'))
    highlight.set('id', 'quote' + ('0000000000' + index).slice(-10))
    highlight.set('user_id', user.id)
    highlight.set('book_id', 'book00000000001')
    highlight.set('quote_text', '저장된 문구 ' + index)
    highlight.set('highlighted_at', new Date(Date.UTC(2026, 0, index)).toISOString())
    $app.save(highlight)
  }
})
