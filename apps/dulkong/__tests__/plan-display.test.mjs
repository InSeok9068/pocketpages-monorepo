import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { listPlans } = require('../pb_hooks/pages/_private/couple-data.js')

function planRecord(fields) {
  return {
    get(name) {
      return fields[name] || ''
    },
  }
}

test('plan without a valid end date is displayed as a single-day plan', () => {
  const app = {
    findRecordsByFilter() {
      return [
        planRecord({
          id: 'plan-1',
          createdBy: 'user-1',
          kind: 'date',
          title: '추가',
          startDate: '2026-08-03 00:00:00.000Z',
          endDate: 'Invalid Date',
        }),
      ]
    },
  }

  const plans = listPlans(app, 'user-1', new Date('2026-08-02T00:00:00.000Z'))

  assert.equal(plans[0].endDate, '')
  assert.equal(plans[0].dateLabel, '8월 3일')
  assert.equal(plans[0].timeLabel, '하루 종일')
})

test('plan with an end date keeps its date range', () => {
  const app = {
    findRecordsByFilter() {
      return [
        planRecord({
          id: 'plan-2',
          createdBy: 'user-1',
          kind: 'trip',
          title: '여행',
          startDate: '2026-08-03 00:00:00.000Z',
          endDate: '2026-08-05 00:00:00.000Z',
        }),
      ]
    },
  }

  const plans = listPlans(app, 'user-1', new Date('2026-08-02T00:00:00.000Z'))

  assert.equal(plans[0].endDate, '2026-08-05')
  assert.equal(plans[0].dateLabel, '8월 3일 – 8월 5일')
})
