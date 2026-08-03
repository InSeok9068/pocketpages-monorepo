import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { getMessagePage, getMessagesAfter, getUnreadMessageCount } = require('../pb_hooks/pages/_private/couple-data.js')

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

test('message page marks only the latest message read by the partner', () => {
  const records = [
    messageRecord('message-4', '2026-07-21 14:03:04.000Z', 'inseok', '넷'),
    messageRecord('message-3', '2026-07-21 14:03:03.000Z', 'solmi', '셋'),
    messageRecord('message-2', '2026-07-21 14:03:02.000Z', 'inseok', '둘'),
    messageRecord('message-1', '2026-07-21 14:03:01.000Z', 'inseok', '하나'),
  ]
  const app = {
    findRecordsByFilter() {
      return records
    },
  }

  const page = getMessagePage(app, 'inseok', {
    limit: 50,
    partnerLastReadAt: '2026-07-21 14:03:03.000Z',
  })

  assert.deepEqual(
    page.messages.filter((message) => message.showReadReceipt).map((message) => message.id),
    ['message-2']
  )
})

test('message updates query only messages after the latest rendered cursor', () => {
  const calls = []
  const records = [
    messageRecord('message-3', '2026-07-21 14:03:03.000Z', 'solmi', '셋'),
    messageRecord('message-4', '2026-07-21 14:03:04.000Z', 'inseok', '넷'),
  ]
  const app = {
    findRecordsByFilter(...args) {
      calls.push(args)
      return records
    },
  }

  const messages = getMessagesAfter(app, 'inseok', '2026-07-21 14:03:02.000Z', 'message-2', 100)

  assert.deepEqual(
    messages.map((message) => message.id),
    ['message-3', 'message-4']
  )
  assert.deepEqual(
    messages.map((message) => message.mine),
    [false, true]
  )
  assert.match(calls[0][1], /created > \{:afterCreated\}/)
  assert.match(calls[0][1], /created = \{:afterCreated\} && id > \{:afterId\}/)
  assert.equal(calls[0][2], 'created,id')
  assert.equal(calls[0][3], 100)
  assert.deepEqual(calls[0][5], {
    afterCreated: '2026-07-21 14:03:02.000Z',
    afterId: 'message-2',
  })
})

test('unread message count queries only newer partner messages', () => {
  const calls = []
  const app = {
    findRecordsByFilter(...args) {
      calls.push(args)
      return new Array(3)
    },
  }

  const count = getUnreadMessageCount(app, 'inseok', '2026-07-21 14:03:02.000Z')

  assert.equal(count, 3)
  assert.equal(calls[0][0], 'messages')
  assert.match(calls[0][1], /sender != \{:userId\}/)
  assert.match(calls[0][1], /created > \{:lastReadAt\}/)
  assert.equal(calls[0][3], 100)
  assert.deepEqual(calls[0][5], {
    userId: 'inseok',
    lastReadAt: '2026-07-21 14:03:02.000Z',
  })
})
