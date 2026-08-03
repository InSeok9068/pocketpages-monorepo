import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const anniversaryReminderJob = require('../pb_hooks/jobs/anniversary-reminder-job.js')

function createRecord(values) {
  return {
    get(name) {
      return values[name]
    },
  }
}

test('relationship reminder uses a conversational anniversary message', () => {
  assert.deepEqual(anniversaryReminderJob.createRelationshipMessage('2023-08-03', '2026-08-03'), {
    title: '우리의 기념일 ❤️',
    contents: '우리 벌써 함께한 지 3년이야. 오늘도 서로에게 다정한 하루 보내자.',
  })
})

test('birthday reminder speaks warmly to the partner', () => {
  assert.deepEqual(anniversaryReminderJob.createBirthdayMessage('솔미'), {
    title: '솔미의 생일이야 🎂',
    contents: '오늘은 솔미가 태어난 날이야. 누구보다 가까이에서 따뜻하게 축하해줘.',
  })
})

test('birthday person receives a separate celebration message', () => {
  assert.deepEqual(anniversaryReminderJob.createBirthdayCelebrationMessage('솔미'), {
    title: '솔미야, 생일 축하해 🎂',
    contents: '오늘은 네가 태어난 특별한 날이야. 우리 오늘 더 다정하게 보내자.',
  })
  assert.equal(anniversaryReminderJob.createBirthdayCelebrationMessage('인석').title, '인석아, 생일 축하해 🎂')
})

test('birthday reminder uses a natural subject particle', () => {
  assert.equal(
    anniversaryReminderJob.createBirthdayMessage('인석').contents,
    '오늘은 인석이가 태어난 날이야. 누구보다 가까이에서 따뜻하게 축하해줘.'
  )
})

test('annual reminders match by Korean calendar month and day', () => {
  assert.equal(anniversaryReminderJob.isDueToday('2020-08-03T00:00:00.000Z', '2026-08-03'), true)
  assert.equal(anniversaryReminderJob.isDueToday('2020-08-04T00:00:00.000Z', '2026-08-03'), false)
})

test('birthday reminder identifies the birthday person and partner separately', () => {
  const users = [
    createRecord({ id: 'inseok', name: '인석', pushEnabled: true }),
    createRecord({ id: 'solmi', name: '솔미', pushEnabled: true }),
  ]
  const anniversary = createRecord({ relatedUser: 'solmi', title: '솔미 생일' })
  const birthdayPerson = anniversaryReminderJob.findBirthdayPerson(anniversary, users)

  assert.equal(birthdayPerson, users[1])
  assert.deepEqual(anniversaryReminderJob.getRecipientIds('birthday', birthdayPerson, users), ['inseok'])
  assert.deepEqual(anniversaryReminderJob.getRecipientIds('relationship_start', null, users), ['inseok', 'solmi'])
})
