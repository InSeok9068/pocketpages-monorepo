/* global onBootstrap, routerAdd, require, $app, $os, __hooks, Record, $filesystem, $security */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  const HOUR_MS = 3600 * 1000
  function addDaysText(dateText, days) {
    const date = new Date(dateText + 'T00:00:00.000Z')
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
  }
  // 한국 날짜 자정에서 몇 분 뒤인 시각을 UTC로 만듭니다. 음수면 그 전날 밤입니다.
  function kstAt(dateText, minutes) {
    return new Date(Date.parse(dateText + 'T00:00:00.000Z') - 9 * HOUR_MS + minutes * 60 * 1000).toISOString()
  }
  function save(collection, fields) {
    const record = new Record($app.findCollectionByNameOrId(collection))
    Object.keys(fields).forEach(function (key) {
      record.set(key, fields[key])
    })
    $app.save(record)
    return record
  }
  function reader(id, extra) {
    save(
      'users',
      Object.assign(
        { id: id, email: id + '@example.com', password: 'test-password-1234', verified: true, booklog_enabled: true },
        extra || {}
      )
    )
  }
  function shelvedBook(userId, bookId, fileId, title) {
    save('books', { id: bookId, title: title })
    save('book_files', {
      id: fileId,
      book_id: bookId,
      stored_file: $filesystem.fileFromBytes([80, 75, 3, 4], fileId + '.epub'),
      original_name: fileId + '.epub',
      mime_type: 'application/epub+zip',
      file_size: 4,
      file_hash: $security.sha256(fileId),
    })
    save('book_shelves', { user_id: userId, book_id: bookId, book_file_id: fileId, status: 'reading' })
  }

  reader('midnightuser001')
  shelvedBook('midnightuser001', 'midnightbook001', 'midnightfile001', '자정 책')
  save('user_settings', {
    user_id: 'midnightuser001',
    preferred_view_mode: 'scrolled',
    push_enabled: true,
    weekly_reading_nudge_enabled: true,
  })

  reader('mergeuser000003')
  shelvedBook('mergeuser000003', 'mergebook000003', 'mergefile000003', '병합 책')
  const oldDay = addDaysText(new Date(Date.now() + 9 * HOUR_MS).toISOString().slice(0, 10), -40)
  function oldSession(id, startMinutes, endMinutes) {
    save('reading_sessions', {
      id: id,
      user_id: 'mergeuser000003',
      book_id: 'mergebook000003',
      file_id: 'mergefile000003',
      started_at: kstAt(oldDay, startMinutes),
      ended_at: kstAt(oldDay, endMinutes),
      duration_seconds: (endMinutes - startMinutes) * 60,
    })
  }
  // 전날 23:40에 시작해 00:20에 끝난 세션은 끝난 날(oldDay)의 오전 세션과 합쳐지고, 전날 밤에 끝난 세션과는 합치지 않습니다.
  oldSession('midnightmerge01', -20, 20)
  oldSession('midnightmerge02', 480, 510)
  oldSession('midnightmerge03', -120, -90)

  reader('deletereader001')
  reader('deleteadmin0001', { admin_manager: true })
  shelvedBook('deletereader001', 'deletebook00001', 'deletefile00001', '지워질 책')

  const today = new Date(Date.now() + 9 * HOUR_MS).toISOString().slice(0, 10)
  const weekday = new Date(today + 'T00:00:00.000Z').getUTCDay()
  const monday = addDaysText(today, weekday === 0 ? -6 : 1 - weekday)
  $app.store().set('test:edge:anchors', {
    today: today,
    monday: monday,
    oldDay: oldDay,
    thisWeekCrossing: { startedAt: kstAt(monday, -20), endedAt: kstAt(monday, 20) },
    olderWeekCrossing: {
      startedAt: kstAt(addDaysText(monday, -14), -20),
      endedAt: kstAt(addDaysText(monday, -14), 20),
    },
  })
})

routerAdd('GET', '/_test/edge-anchors', function (event) {
  return event.json(200, $app.store().get('test:edge:anchors'))
})

routerAdd('POST', '/_test/edge-run', function (event) {
  const job = String(event.request.url.query().get('job'))
  const file = job === 'merge' ? 'reading-session-merge-job.js' : 'weekly-reading-nudge-job.js'
  return event.json(200, require(__hooks + '/jobs/' + file).run() || {})
})

routerAdd('GET', '/_test/edge-state', function (event) {
  const { dateutil } = require('@pocketpages/utils')
  function count(collection, bookId) {
    return $app.findRecordsByFilter(collection, 'book_id = {:bookId}', '', 0, 0, { bookId: bookId }).length
  }
  return event.json(200, {
    mergeSessions: $app
      .findRecordsByFilter('reading_sessions', "book_id = 'mergebook000003'", 'started_at', 0, 0)
      .map(function (record) {
        return {
          endedDate: dateutil.formatDate(String(record.get('ended_at')), dateutil.FORMATS.DATE),
          minutes: Math.round(Number(record.get('duration_seconds')) / 60),
        }
      }),
    nudgeReasons: $app
      .findRecordsByFilter(
        'push_send_logs',
        "user_id = 'midnightuser001' && notification_key = 'weekly_reading_nudge'",
        'created',
        0,
        0
      )
      .map(function (record) {
        return { status: record.get('send_status'), reason: record.get('error_message') }
      }),
    deletedBook: {
      books: $app.findRecordsByFilter('books', "id = 'deletebook00001'", '', 0, 0).length,
      shelves: count('book_shelves', 'deletebook00001'),
      sessions: count('reading_sessions', 'deletebook00001'),
      bookmarks: count('book_bookmarks', 'deletebook00001'),
      highlights: count('book_highlights', 'deletebook00001'),
    },
  })
})
