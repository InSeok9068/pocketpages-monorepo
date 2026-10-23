/* global onBootstrap, require, $app, $os, __hooks, Record, $filesystem, $security */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)
  const { dateutil } = require('@pocketpages/utils')

  function save(collection, fields) {
    const record = new Record($app.findCollectionByNameOrId(collection))
    Object.keys(fields).forEach(function (key) {
      record.set(key, fields[key])
    })
    $app.save(record)
    return record
  }
  function daysAgo(days) {
    return dateutil.toDbDateTime(dateutil.addDays(new Date(), -days))
  }

  ;[
    ['richreader00001', 'rich@example.com', true, false],
    ['emptyreader0001', 'empty@example.com', true, false],
    ['pendingreader01', 'pending@example.com', false, false],
    ['adminreader0001', 'admin@example.com', true, true],
  ].forEach(function (user) {
    save('users', {
      id: user[0],
      email: user[1],
      password: 'test-password-1234',
      verified: true,
      booklog_enabled: user[2],
      admin_manager: user[3],
    })
  })

  save('books', {
    id: 'fullbook0000001',
    title: '모든 정보가 있는 책 :부제',
    author: '지은이: 첫 저자, 옮긴이: 둘째',
    publisher: '테스트 출판사',
    publication_date: dateutil.toDateOnlyIso('2024-03-01'),
    publication_year: '2024',
    isbn13: '9791100000101',
    book_image_url: 'https://image.example.com/full.jpg',
    estimated_page_count: 320,
    description: '<p>책 소개</p>',
  })
  save('book_files', {
    id: 'fullfile0000001',
    book_id: 'fullbook0000001',
    stored_file: $filesystem.fileFromBytes([80, 75, 3, 4], 'full.epub'),
    original_name: 'full.epub',
    mime_type: 'application/epub+zip',
    file_size: 4,
    file_hash: $security.sha256('full-file'),
  })
  // 제목 외에는 모두 비어 있는 책들로, 템플릿이 빈 값을 견디는지 봅니다.
  ;['barebook0000001', 'finishedbook001', 'droppedbook0001', 'unshelvedbook01'].forEach(function (id) {
    save('books', { id: id, title: id })
  })

  const rich = 'richreader00001'
  const fullShelf = save('book_shelves', {
    user_id: rich,
    book_id: 'fullbook0000001',
    book_file_id: 'fullfile0000001',
    status: 'reading',
    progress_percent: 42,
    current_label: '3장',
    current_page: 120,
    started_at: daysAgo(20),
    last_read_at: daysAgo(1),
  })
  save('book_shelves', { user_id: rich, book_id: 'barebook0000001', status: 'queued' })
  save('book_shelves', {
    user_id: rich,
    book_id: 'finishedbook001',
    status: 'finished',
    progress_percent: 100,
    finished_at: daysAgo(3),
  })
  save('book_shelves', { user_id: rich, book_id: 'droppedbook0001', status: 'dropped' })

  const owned = { user_id: rich, book_id: 'fullbook0000001', shelf_id: fullShelf.id }
  save(
    'book_reviews',
    Object.assign({ visibility: 'app', rating: 4, review_text: '<b>굵게</b> 감상', reviewed_at: daysAgo(2) }, owned)
  )
  save('book_reviews', {
    user_id: rich,
    book_id: 'finishedbook001',
    visibility: 'private',
    review_text: '날짜와 별점 없는 감상',
  })
  save('book_highlights', Object.assign({ quote_text: '메모와 장 이름이 있는 문구', note_text: '메모' }, owned))
  save('book_highlights', { user_id: rich, book_id: 'barebook0000001', quote_text: '날짜도 위치도 없는 문구' })
  save('book_highlights', {
    user_id: rich,
    book_id: 'fullbook0000001',
    quote_text: '파일 경로가 장 이름에 남은 문구',
    chapter_label: 'OEBPS/Text/section0003.xhtml',
    highlighted_at: daysAgo(5),
  })
  save('book_bookmarks', Object.assign({ href: 'chapter.xhtml', file_id: 'fullfile0000001' }, owned))
  save(
    'reading_sessions',
    Object.assign(
      {
        file_id: 'fullfile0000001',
        started_at: daysAgo(0),
        ended_at: daysAgo(0),
        duration_seconds: 1200,
        start_progress_percent: 40,
        end_progress_percent: 42,
        start_chapter_label: '3장',
      },
      owned
    )
  )
  save('reading_sessions', {
    user_id: rich,
    book_id: 'barebook0000001',
    started_at: daysAgo(9),
    ended_at: daysAgo(9),
    duration_seconds: 60,
  })
  save('user_settings', {
    user_id: rich,
    push_enabled: true,
    reading_reminder_cycle: 3,
    highlight_push_cycle: 5,
    weekly_reading_nudge_enabled: true,
    preferred_view_mode: 'scrolled',
  })

  save('book_shelves', { user_id: 'adminreader0001', book_id: 'fullbook0000001', status: 'reading' })
})
