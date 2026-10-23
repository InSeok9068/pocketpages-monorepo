/* global onBootstrap, routerAdd, require, $app, $os, __hooks, Record */
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

  const otherBookHighlight = new Record($app.findCollectionByNameOrId('book_highlights'))
  otherBookHighlight.set('id', 'otherquote00001')
  otherBookHighlight.set('user_id', user.id)
  otherBookHighlight.set('book_id', 'book00000000002')
  otherBookHighlight.set('quote_text', '다른 책의 문구')
  otherBookHighlight.set('highlighted_at', new Date(Date.UTC(2026, 2, 1)).toISOString())
  $app.save(otherBookHighlight)

  // 홈은 읽는 중인 책부터 50권만 보여 주므로, 이 완독 책은 홈 목록 밖에 있습니다.
  const finishedBook = new Record($app.findCollectionByNameOrId('books'))
  finishedBook.set('id', 'finishedbook001')
  finishedBook.set('title', '완독한 책')
  finishedBook.set('isbn13', '9791100000001')
  $app.save(finishedBook)

  const otherBook = new Record($app.findCollectionByNameOrId('books'))
  otherBook.set('id', 'notonshelf00001')
  otherBook.set('title', '도서함에 없는 책')
  otherBook.set('isbn13', '9791100000002')
  $app.save(otherBook)
  const finishedShelf = new Record($app.findCollectionByNameOrId('book_shelves'))
  finishedShelf.set('user_id', user.id)
  finishedShelf.set('book_id', finishedBook.id)
  finishedShelf.set('status', 'finished')
  $app.save(finishedShelf)
})

// 이전 버전에서 저장된 '푸시만 켜고 알림 종류는 모두 꺼진' 상태처럼, 화면을 거치지 않은 설정을 만듭니다.
routerAdd('POST', '/_test/settings', function (event) {
  const query = event.request.url.query()
  let record = $app.findRecordsByFilter('user_settings', 'user_id = {:userId}', '', 1, 0, {
    userId: 'user00000000001',
  })[0]
  if (!record) {
    record = new Record($app.findCollectionByNameOrId('user_settings'))
    record.set('user_id', 'user00000000001')
    record.set('preferred_view_mode', 'scrolled')
  }
  record.set('push_enabled', String(query.get('push')) === 'true')
  record.set('reading_reminder_cycle', Number(query.get('reading') || 0) || null)
  record.set('highlight_push_cycle', Number(query.get('highlight') || 0) || null)
  record.set('weekly_reading_nudge_enabled', String(query.get('weekly')) === 'true')
  $app.save(record)
  return event.json(200, { ok: true })
})

routerAdd('GET', '/_test/settings', function (event) {
  const record = $app.findRecordsByFilter('user_settings', 'user_id = {:userId}', '', 1, 0, {
    userId: 'user00000000001',
  })[0]
  return event.json(200, {
    push: !!record.get('push_enabled'),
    reading: record.get('reading_reminder_cycle'),
    highlight: record.get('highlight_push_cycle'),
    weekly: !!record.get('weekly_reading_nudge_enabled'),
  })
})

routerAdd('POST', '/_test/popular-books-job', function (event) {
  return event.json(200, require(__hooks + '/jobs/popular-books-job.js').run())
})
