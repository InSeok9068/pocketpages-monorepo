/* global onBootstrap, routerAdd, require, $app, $os, __hooks, Record, $filesystem, $security */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  function save(collection, fields) {
    const record = new Record($app.findCollectionByNameOrId(collection))
    Object.keys(fields).forEach(function (key) {
      record.set(key, fields[key])
    })
    $app.save(record)
    return record
  }

  // 한국 날짜 경계를 정확히 맞추려고 UTC 시각을 직접 정합니다.
  function utcAt(daysAgo, hours, minutes) {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() - daysAgo)
    date.setUTCHours(hours, minutes, 0, 0)
    return date.toISOString()
  }

  ;[
    ['owneruser000001', 'owner@example.com'],
    ['stranger0000001', 'stranger@example.com'],
    ['outsider0000001', 'outsider@example.com'],
    ['mergeuser000001', 'merge1@example.com'],
    ['mergeuser000002', 'merge2@example.com'],
  ].forEach(function (user) {
    save('users', {
      id: user[0],
      email: user[1],
      password: 'test-password-1234',
      verified: true,
      booklog_enabled: true,
    })
  })

  save('books', { id: 'ownedbook000001', title: '소유권 책', author: '원래 저자', estimated_page_count: 77 })
  save('book_files', {
    id: 'ownedfile000001',
    book_id: 'ownedbook000001',
    stored_file: $filesystem.fileFromBytes([80, 75, 3, 4], 'owned.epub'),
    original_name: 'owned.epub',
    mime_type: 'application/epub+zip',
    file_size: 4,
    file_hash: $security.sha256('owned'),
  })
  const ownerShelf = save('book_shelves', {
    id: 'ownershelf00001',
    user_id: 'owneruser000001',
    book_id: 'ownedbook000001',
    book_file_id: 'ownedfile000001',
    status: 'reading',
  })
  save('book_shelves', {
    id: 'strangershelf01',
    user_id: 'stranger0000001',
    book_id: 'ownedbook000001',
    book_file_id: 'ownedfile000001',
    status: 'reading',
  })
  const owned = { user_id: 'owneruser000001', book_id: 'ownedbook000001', shelf_id: ownerShelf.id }
  save(
    'book_reviews',
    Object.assign({ id: 'ownerreview0001', visibility: 'private', review_text: '주인 감상평' }, owned)
  )
  save(
    'book_highlights',
    Object.assign({ id: 'ownerquote00001', quote_text: '주인 문구', note_text: '주인 메모' }, owned)
  )
  save('book_bookmarks', Object.assign({ id: 'ownermark000001', href: 'chapter.xhtml' }, owned))
  ;[1, 2].forEach(function (index) {
    save(
      'reading_sessions',
      Object.assign(
        {
          id: 'ownersession00' + index,
          file_id: 'ownedfile000001',
          started_at: utcAt(1, index, 0),
          ended_at: utcAt(1, index, 30),
          duration_seconds: 1800,
        },
        owned
      )
    )
  })
  save('book_audio_progress', {
    id: 'owneraudio00001',
    user_id: 'owneruser000001',
    file_id: 'ownedfile000001',
    config_hash: $security.sha256('fixture-config'),
    section_index: 2,
  })
  save('user_settings', {
    id: 'ownersettings01',
    user_id: 'owneruser000001',
    push_enabled: true,
    reading_reminder_cycle: 3,
    highlight_push_cycle: 5,
    preferred_view_mode: 'scrolled',
  })

  save('books', { id: 'mergebook000001', title: '병합 책' })
  ;['mergefile000001', 'mergefile000002'].forEach(function (fileId) {
    save('book_files', {
      id: fileId,
      book_id: 'mergebook000001',
      stored_file: $filesystem.fileFromBytes([80, 75, 3, 4], fileId + '.epub'),
      original_name: fileId + '.epub',
      mime_type: 'application/epub+zip',
      file_size: 4,
      file_hash: $security.sha256(fileId),
    })
  })

  function session(id, userId, fileId, startedAt, endedAt, seconds, extra) {
    save(
      'reading_sessions',
      Object.assign(
        {
          id: id,
          user_id: userId,
          book_id: 'mergebook000001',
          file_id: fileId,
          started_at: startedAt,
          ended_at: endedAt,
          duration_seconds: seconds,
        },
        extra || {}
      )
    )
  }

  // 40일 전 한국 시간 오전: 하나로 합쳐질 세 세션. 가장 늦게 끝난 것은 두 번째로 시작한 세션입니다.
  session('mergea000000001', 'mergeuser000001', 'mergefile000001', utcAt(40, 1, 0), utcAt(40, 1, 10), 600, {
    start_progress_percent: 10,
    end_progress_percent: 12,
    start_page: 20,
    end_page: 24,
    start_locator: 'first-start',
    end_locator: 'first-end',
    start_chapter_label: '1장',
    end_chapter_label: '1장',
  })
  session('mergea000000002', 'mergeuser000001', 'mergefile000001', utcAt(40, 2, 0), utcAt(40, 4, 0), 1200, {
    start_progress_percent: 12,
    end_progress_percent: 16,
    start_page: 24,
    end_page: 40,
    start_locator: 'second-start',
    end_locator: 'latest-end',
    start_chapter_label: '1장',
    end_chapter_label: '3장',
  })
  session('mergea000000003', 'mergeuser000001', 'mergefile000001', utcAt(40, 3, 0), utcAt(40, 3, 5), 300, {
    start_progress_percent: 14,
    end_progress_percent: 15,
    start_locator: 'third-start',
    end_locator: 'third-end',
  })
  // 45일 전 UTC 14시대와 15시대는 한국 날짜로 서로 다른 날입니다.
  session('mergeb000000001', 'mergeuser000001', 'mergefile000001', utcAt(45, 14, 0), utcAt(45, 14, 20), 1200)
  session('mergeb000000002', 'mergeuser000001', 'mergefile000001', utcAt(45, 15, 10), utcAt(45, 15, 30), 1200)
  // UTC로는 다른 날이지만 한국 날짜로는 같은 날이라 합쳐야 하는 두 세션입니다.
  session('mergef000000001', 'mergeuser000001', 'mergefile000001', utcAt(55, 15, 10), utcAt(55, 15, 30), 900)
  session('mergef000000002', 'mergeuser000001', 'mergefile000001', utcAt(54, 1, 0), utcAt(54, 1, 10), 600)
  // 보존 기간(30일) 안의 세션은 같은 날이어도 그대로 둡니다.
  session('mergec000000001', 'mergeuser000001', 'mergefile000001', utcAt(5, 1, 0), utcAt(5, 1, 10), 600)
  session('mergec000000002', 'mergeuser000001', 'mergefile000001', utcAt(5, 2, 0), utcAt(5, 2, 10), 600)
  // 같은 날이라도 파일이 다르거나 사용자가 다르면 합치지 않습니다.
  session('merged000000001', 'mergeuser000001', 'mergefile000001', utcAt(50, 1, 0), utcAt(50, 1, 10), 600)
  session('merged000000002', 'mergeuser000001', 'mergefile000002', utcAt(50, 2, 0), utcAt(50, 2, 10), 600)
  session('mergee000000001', 'mergeuser000002', 'mergefile000001', utcAt(40, 1, 30), utcAt(40, 1, 40), 600)
})

routerAdd('POST', '/_test/reading-session-merge', function (event) {
  return event.json(200, require(__hooks + '/jobs/reading-session-merge-job.js').run())
})

routerAdd('GET', '/_test/ownership-state', function (event) {
  function exists(collection, id) {
    return $app.findRecordsByFilter(collection, 'id = {:id}', '', 1, 0, { id: id })[0] || null
  }
  function count(collection, filter, values) {
    return $app.findRecordsByFilter(collection, filter, '', 0, 0, values || {}).length
  }
  function settingsOf(userId) {
    const records = $app.findRecordsByFilter('user_settings', 'user_id = {:userId}', '', 0, 0, { userId: userId })
    return records.map(function (record) {
      return {
        pushEnabled: record.get('push_enabled'),
        readingReminderCycle: record.get('reading_reminder_cycle'),
        highlightPushCycle: record.get('highlight_push_cycle'),
      }
    })
  }
  const owner = { userId: 'owneruser000001', bookId: 'ownedbook000001' }
  const highlight = exists('book_highlights', 'ownerquote00001')
  const book = exists('books', 'ownedbook000001')
  const sessions = $app
    .findRecordsByFilter('reading_sessions', "book_id = 'mergebook000001'", 'id', 0, 0)
    .map(function (record) {
      return {
        id: record.id,
        userId: record.get('user_id'),
        startedAt: String(record.get('started_at')),
        endedAt: String(record.get('ended_at')),
        durationSeconds: record.get('duration_seconds'),
        startProgressPercent: record.get('start_progress_percent'),
        endProgressPercent: record.get('end_progress_percent'),
        progressDeltaPercent: record.get('progress_delta_percent'),
        startPage: record.get('start_page'),
        endPage: record.get('end_page'),
        pageDelta: record.get('page_delta'),
        startLocator: record.get('start_locator'),
        endLocator: record.get('end_locator'),
        endChapterLabel: record.get('end_chapter_label'),
      }
    })

  return event.json(200, {
    highlight: highlight ? { quote: highlight.get('quote_text'), note: highlight.get('note_text') } : null,
    review: !!exists('book_reviews', 'ownerreview0001'),
    bookmark: !!exists('book_bookmarks', 'ownermark000001'),
    audioProgress: !!exists('book_audio_progress', 'owneraudio00001'),
    ownerShelf: !!exists('book_shelves', 'ownershelf00001'),
    strangerShelf: !!exists('book_shelves', 'strangershelf01'),
    ownerSessions: count('reading_sessions', 'user_id = {:userId} && book_id = {:bookId}', owner),
    book: book
      ? { title: book.get('title'), author: book.get('author'), pages: book.get('estimated_page_count') }
      : null,
    settings: {
      owner: settingsOf('owneruser000001'),
      stranger: settingsOf('stranger0000001'),
    },
    users: $app.findRecordsByFilter('users', "email ~ 'signup'", '', 0, 0).map(function (user) {
      return {
        email: user.get('email'),
        booklogEnabled: user.get('booklog_enabled'),
        adminManager: user.get('admin_manager'),
      }
    }),
    mergeSessions: sessions,
  })
})
