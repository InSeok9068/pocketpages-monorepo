/* global onBootstrap, routerAdd, $app, $os, __hooks, Record */
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
    return new Date(Date.parse(dateText + 'T00:00:00.000Z') - 9 * HOUR_MS + minutes * 60 * 1000)
  }
  function save(collection, fields) {
    const record = new Record($app.findCollectionByNameOrId(collection))
    Object.keys(fields).forEach(function (key) {
      record.set(key, fields[key])
    })
    $app.save(record)
    return record
  }
  function session(userId, endedAt, seconds) {
    save('reading_sessions', {
      user_id: userId,
      book_id: 'recordbook00001',
      started_at: new Date(endedAt.getTime() - seconds * 1000).toISOString(),
      ended_at: endedAt.toISOString(),
      duration_seconds: seconds,
    })
  }

  ;['recorduser00001', 'homeuser0000001', 'otherreader0001'].forEach(function (id) {
    save('users', {
      id: id,
      email: id + '@example.com',
      password: 'test-password-1234',
      verified: true,
      booklog_enabled: true,
    })
  })
  save('books', { id: 'recordbook00001', title: '기록 책' })
  save('books', { id: 'recordbook00002', title: '완독 책 하나' })
  save('books', { id: 'recordbook00003', title: '완독 책 둘' })
  save('book_shelves', { user_id: 'recorduser00001', book_id: 'recordbook00001', status: 'reading' })
  save('book_shelves', { user_id: 'recorduser00001', book_id: 'recordbook00002', status: 'finished' })
  save('book_shelves', { user_id: 'recorduser00001', book_id: 'recordbook00003', status: 'finished' })
  save('book_shelves', { user_id: 'otherreader0001', book_id: 'recordbook00002', status: 'finished' })

  const today = new Date(Date.now() + 9 * HOUR_MS).toISOString().slice(0, 10)
  const weekday = new Date(today + 'T00:00:00.000Z').getUTCDay()
  const monday = addDaysText(today, weekday === 0 ? -6 : 1 - weekday)
  const firstWeek = addDaysText(monday, -21)
  session('recorduser00001', kstAt(monday, 10), 600)
  session('recorduser00001', kstAt(monday, -10), 1200)
  session('recorduser00001', kstAt(firstWeek, 10), 1800)
  session('recorduser00001', kstAt(firstWeek, -10), 2400)
  session('otherreader0001', kstAt(monday, 30), 3000)

  session('homeuser0000001', kstAt(today, 10), 300)
  session('homeuser0000001', kstAt(today, -10), 300)
  session('homeuser0000001', kstAt(addDaysText(today, -8), 600), 300)

  $app.store().set('test:records:anchors', { today: today, monday: monday })
})

routerAdd('GET', '/_test/records-anchors', function (event) {
  return event.json(200, $app.store().get('test:records:anchors'))
})
