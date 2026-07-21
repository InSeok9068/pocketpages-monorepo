import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { getMessagePage } = require('../pb_hooks/pages/_private/couple-data.js')

function messageRecord(id, created, sender, body) {
  const fields = { id, created, sender, body }

  return {
    get(name) {
      return fields[name] || ''
    },
  }
}

test('message pagination returns a stable oldest-to-newest page and cursor filter', () => {
  const calls = []
  const records = [
    messageRecord('message-3', '2026-07-21 14:03:03.000Z', 'inseok', '셋'),
    messageRecord('message-2', '2026-07-21 14:03:02.000Z', 'solmi', '둘'),
    messageRecord('message-1', '2026-07-21 14:03:01.000Z', 'inseok', '하나'),
  ]
  const app = {
    findRecordsByFilter(...args) {
      calls.push(args)
      return records
    },
  }

  const page = getMessagePage(app, 'inseok', {
    limit: 2,
    beforeCreated: '2026-07-21 14:04:00.000Z',
    beforeId: 'message-4',
  })

  assert.equal(page.hasMore, true)
  assert.deepEqual(
    page.messages.map((message) => message.id),
    ['message-2', 'message-3']
  )
  assert.deepEqual(
    page.messages.map((message) => message.mine),
    [false, true]
  )
  assert.equal(calls[0][0], 'messages')
  assert.match(calls[0][1], /created < \{:beforeCreated\}/)
  assert.equal(calls[0][2], '-created,-id')
  assert.equal(calls[0][3], 3)
  assert.deepEqual(calls[0][5], {
    beforeCreated: '2026-07-21 14:04:00.000Z',
    beforeId: 'message-4',
  })
})
