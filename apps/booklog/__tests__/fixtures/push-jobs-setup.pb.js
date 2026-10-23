/* global onBootstrap, routerAdd, require, $app, $os, __hooks, Record */
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
  function sentLog(userId, key, days, extra) {
    save(
      'push_send_logs',
      Object.assign(
        {
          user_id: userId,
          notification_key: key,
          channel: 'push',
          send_status: 'sent',
          sent_at: daysAgo(days),
        },
        extra || {}
      )
    )
  }
  function reader(id, settings) {
    save('users', {
      id: id,
      email: id + '@example.com',
      password: 'test-password-1234',
      verified: true,
      booklog_enabled: true,
    })
    save('user_settings', Object.assign({ user_id: id, preferred_view_mode: 'scrolled' }, settings))
  }
  function shelf(userId, status, lastReadDaysAgo) {
    save('book_shelves', {
      user_id: userId,
      book_id: 'pushbook0000001',
      status: status,
      last_read_at: daysAgo(lastReadDaysAgo),
    })
  }

  save('books', { id: 'pushbook0000001', title: '알림 책 :부제' })

  reader('readuser0000001', { push_enabled: true, reading_reminder_cycle: 3 })
  shelf('readuser0000001', 'reading', 5)
  reader('readuser0000002', { push_enabled: true, reading_reminder_cycle: 3 })
  shelf('readuser0000002', 'reading', 1)
  reader('readuser0000003', { push_enabled: false, reading_reminder_cycle: 3 })
  shelf('readuser0000003', 'reading', 5)
  reader('readuser0000004', { push_enabled: true, reading_reminder_cycle: 3 })
  shelf('readuser0000004', 'finished', 5)
  reader('readuser0000005', { push_enabled: true, reading_reminder_cycle: 3 })
  shelf('readuser0000005', 'reading', 6)

  reader('hluser000000001', { push_enabled: true, highlight_push_cycle: 1 })
  save('book_highlights', {
    id: 'hlquotea0000001',
    user_id: 'hluser000000001',
    book_id: 'pushbook0000001',
    quote_text: '이틀 전에 보낸 문구',
  })
  save('book_highlights', {
    id: 'hlquoteb0000001',
    user_id: 'hluser000000001',
    book_id: 'pushbook0000001',
    quote_text: '아직 보내지 않은 문구',
  })
  sentLog('hluser000000001', 'highlight_reminder', 2, { highlight_id: 'hlquotea0000001' })
  reader('hluser000000002', { push_enabled: true, highlight_push_cycle: 1 })
  reader('hluser000000003', { push_enabled: true, highlight_push_cycle: 3 })
  save('book_highlights', {
    id: 'hlquotec0000001',
    user_id: 'hluser000000003',
    book_id: 'pushbook0000001',
    quote_text: '어제 보낸 문구',
  })
  sentLog('hluser000000003', 'highlight_reminder', 1, { highlight_id: 'hlquotec0000001' })

  reader('weekuser0000001', { push_enabled: true, weekly_reading_nudge_enabled: true })
  reader('weekuser0000002', { push_enabled: true, weekly_reading_nudge_enabled: true })
  save('reading_sessions', {
    user_id: 'weekuser0000002',
    book_id: 'pushbook0000001',
    started_at: dateutil.toDbDateTime(new Date(Date.now() - 60 * 1000)),
    ended_at: dateutil.toDbDateTime(new Date(Date.now() - 30 * 1000)),
    duration_seconds: 600,
  })
  reader('weekuser0000003', { push_enabled: true, weekly_reading_nudge_enabled: false })
  reader('weekuser0000004', { push_enabled: true, weekly_reading_nudge_enabled: true })
  save('reading_sessions', {
    user_id: 'weekuser0000004',
    book_id: 'pushbook0000001',
    started_at: daysAgo(8),
    ended_at: daysAgo(8),
    duration_seconds: 600,
  })

  reader('cleanuser000001', {})
  sentLog('cleanuser000001', 'reading_reminder', 100, { title: 'old' })
  sentLog('cleanuser000001', 'reading_reminder', 10, { title: 'recent' })
})

routerAdd('POST', '/_test/push/run', function (event) {
  const job = event.request.url.query().get('job')
  if (job === 'cleanup') {
    return event.json(200, { deletedCount: require(__hooks + '/jobs/push-send-log-service.js').cleanupExpiredLogs(90) })
  }
  const files = {
    reading: 'reading-reminder-job.js',
    highlight: 'highlight-reminder-job.js',
    weekly: 'weekly-reading-nudge-job.js',
  }
  return event.json(200, require(__hooks + '/jobs/' + files[job]).run())
})

routerAdd('POST', '/_test/push/fail', function (event) {
  const users = String(event.request.url.query().get('users') || '')
  $app.store().set('test:push:failFor', users ? users.split(',') : [])
  return event.json(200, { ok: true })
})

// 며칠이 지난 상황을 만들려고, 보낸 기록의 날짜와 중복 방지 키를 함께 과거로 옮깁니다.
routerAdd('POST', '/_test/push/backdate', function (event) {
  const { dateutil } = require('@pocketpages/utils')
  const query = event.request.url.query()
  const days = Number(query.get('days'))
  const dateText = dateutil.formatDate(dateutil.addDays(new Date(), -days), dateutil.FORMATS.DATE)
  const records = $app.findRecordsByFilter(
    'push_send_logs',
    'user_id = {:userId} && notification_key = {:key} && send_status = "sent"',
    '',
    0,
    0,
    { userId: query.get('user'), key: query.get('key') }
  )
  records.forEach(function (record) {
    record.set('sent_at', dateutil.toDateOnlyIso(dateText))
    const dedupeKey = String(record.get('dedupe_key') || '')
    if (dedupeKey) record.set('dedupe_key', dedupeKey.replace(/\d{4}-\d{2}-\d{2}$/, dateText))
    $app.save(record)
  })
  return event.json(200, { moved: records.length })
})

routerAdd('GET', '/_test/push/state', function (event) {
  const logs = $app.findRecordsByFilter('push_send_logs', 'id != ""', 'created', 0, 0).map(function (record) {
    return {
      userId: record.get('user_id'),
      key: record.get('notification_key'),
      status: record.get('send_status'),
      reason: record.get('error_message'),
      highlightId: record.get('highlight_id'),
      dedupeKey: record.get('dedupe_key'),
      title: record.get('title'),
      body: record.get('body_text'),
    }
  })
  return event.json(200, { attempts: $app.store().get('test:push:attempts') || [], logs: logs })
})
