const { dateutil } = require('@pocketpages/utils')

const DEFAULT_RECURRING_USER_ID = 'hyzwag0k7gxnc31'
const DEFAULT_RECURRING_DEVELOPER_ID = '0d6t74mv8rehja5'

/**
 * 반복 업무 생성 환경 설정을 읽습니다.
 *
 * @returns {{userId: string, developerId: string}} 반복 업무 소유자와 담당자 ID
 */
function getConfiguration() {
  return {
    userId: String($os.getenv('TODO_RECURRING_USER_ID') || DEFAULT_RECURRING_USER_ID).trim(),
    developerId: String($os.getenv('TODO_RECURRING_DEVELOPER_ID') || DEFAULT_RECURRING_DEVELOPER_ID).trim(),
  }
}

/**
 * 반복 업무 생성 대상 사용자와 담당자를 확인합니다.
 *
 * @param {any} txApp 트랜잭션 앱
 * @param {{userId: string, developerId: string}} configuration 반복 업무 설정
 * @returns {void}
 */
function validateConfiguration(txApp, configuration) {
  if (!configuration.userId) {
    throw new Error('TODO_RECURRING_USER_ID 설정이 필요합니다.')
  }

  txApp.findRecordById('users', configuration.userId)

  if (!configuration.developerId) {
    return
  }

  const developer = txApp.findRecordById('developers', configuration.developerId)
  const developerUserId = String(developer.get('user') || '').trim()

  if (developerUserId !== configuration.userId) {
    throw new Error('TODO_RECURRING_DEVELOPER_ID가 반복 업무 소유자의 담당자가 아닙니다.')
  }

  if (developer.get('del')) {
    throw new Error('TODO_RECURRING_DEVELOPER_ID가 삭제된 담당자입니다.')
  }
}

/**
 * 업무와 즉시 표시할 예약 알림을 함께 생성합니다.
 *
 * @param {{scheduleId: string, title: string}} input 반복 일정 정보
 * @returns {{workId: string, notificationId: string}} 생성된 레코드 ID
 */
function run(input) {
  const scheduleId = String(input && input.scheduleId ? input.scheduleId : '').trim()
  const title = String(input && input.title ? input.title : '').trim()
  const configuration = getConfiguration()
  const createdAt = new Date()
  let workId = ''
  let notificationId = ''

  if (!scheduleId || !title) {
    throw new Error('반복 업무 일정 ID와 제목이 필요합니다.')
  }

  $app.runInTransaction(function (txApp) {
    validateConfiguration(txApp, configuration)

    const work = new Record(txApp.findCollectionByNameOrId('works'))
    work.set('user', configuration.userId)
    work.set('title', title)
    work.set('content', '')
    work.set('time', 0)
    work.set('done', false)
    work.set('dueDate', dateutil.toDateOnlyIso(createdAt))
    work.set('state', 'wait')

    if (configuration.developerId) {
      work.set('developer', configuration.developerId)
    }

    txApp.save(work)
    workId = String(work.get('id') || '')

    const scheduledNotification = new Record(txApp.findCollectionByNameOrId('scheduledNotifications'))
    scheduledNotification.set('user', configuration.userId)
    scheduledNotification.set('title', title)
    scheduledNotification.set('message', '')
    scheduledNotification.set('time', createdAt.toISOString())
    txApp.save(scheduledNotification)
    notificationId = String(scheduledNotification.get('id') || '')
  })

  return {
    workId: workId,
    notificationId: notificationId,
  }
}

module.exports = {
  run,
}
