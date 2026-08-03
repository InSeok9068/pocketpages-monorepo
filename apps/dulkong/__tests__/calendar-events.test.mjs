import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createCalendarDisplayEvents, eventOccursOn } = require('../pb_hooks/pages/assets/calendar-page.js')

test('여러 날 약속을 시작일부터 종료일까지 날짜별 달력 이벤트로 펼친다', function () {
  const sourceEvent = {
    id: 'plan:trip',
    title: '여행',
    start: '2026-08-17',
    end: '2026-08-20',
    allDay: true,
    extendedProps: {
      sourceKind: 'plan',
      startDate: '2026-08-17',
      endDate: '2026-08-19',
    },
  }

  const displayEvents = createCalendarDisplayEvents([sourceEvent])

  assert.deepEqual(
    displayEvents.map(function (event) {
      return event.start
    }),
    ['2026-08-17', '2026-08-18', '2026-08-19']
  )
  assert.ok(
    displayEvents.every(function (event) {
      return event.extendedProps.calendarSourceId === 'plan:trip'
    })
  )
})

test('선택한 날짜의 목록에는 기간 약속이 한 번만 포함된다', function () {
  const sourceEvent = {
    start: '2026-08-17',
    extendedProps: {
      startDate: '2026-08-17',
      endDate: '2026-08-19',
    },
  }

  assert.equal(eventOccursOn(sourceEvent, '2026-08-17'), true)
  assert.equal(eventOccursOn(sourceEvent, '2026-08-18'), true)
  assert.equal(eventOccursOn(sourceEvent, '2026-08-19'), true)
  assert.equal(eventOccursOn(sourceEvent, '2026-08-20'), false)
})
