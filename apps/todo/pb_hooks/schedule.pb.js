// PocketBase cron은 UTC 기준입니다. 아래 표현식은 기존 한국시간 일정을 그대로 유지합니다.
// 각 핸들러는 격리된 스코프에서 실행되므로 공용 모듈도 핸들러 안에서 불러옵니다.

// 매주 금요일 오전 10시
cronAdd('todo-recurring-work-weekly-report-write', '0 1 * * 5', function () {
  try {
    const recurringWorkJob = require(__hooks + '/jobs/recurring-work-job.js')
    const result = recurringWorkJob.run({ scheduleId: 'weekly-report-write', title: '주간보고서 작성' })
    $app.logger().info('todo/recurring-work:completed', 'scheduleId', 'weekly-report-write', 'workId', result.workId, 'title', '주간보고서 작성')
  } catch (exception) {
    $app.logger().error('todo/recurring-work:failed', 'scheduleId', 'weekly-report-write', 'title', '주간보고서 작성', 'error', String(exception && exception.message ? exception.message : exception))
  }
})

// 매주 금요일 오후 2시
cronAdd('todo-recurring-work-weekly-report-review', '0 5 * * 5', function () {
  try {
    const recurringWorkJob = require(__hooks + '/jobs/recurring-work-job.js')
    const result = recurringWorkJob.run({ scheduleId: 'weekly-report-review', title: '주간보고서 리뷰' })
    $app.logger().info('todo/recurring-work:completed', 'scheduleId', 'weekly-report-review', 'workId', result.workId, 'title', '주간보고서 리뷰')
  } catch (exception) {
    $app.logger().error('todo/recurring-work:failed', 'scheduleId', 'weekly-report-review', 'title', '주간보고서 리뷰', 'error', String(exception && exception.message ? exception.message : exception))
  }
})

// 매월 5일 오전 10시
cronAdd('todo-recurring-work-monthly-report-write', '0 1 5 * *', function () {
  try {
    const recurringWorkJob = require(__hooks + '/jobs/recurring-work-job.js')
    const result = recurringWorkJob.run({ scheduleId: 'monthly-report-write', title: '월간보고서 작성' })
    $app.logger().info('todo/recurring-work:completed', 'scheduleId', 'monthly-report-write', 'workId', result.workId, 'title', '월간보고서 작성')
  } catch (exception) {
    $app.logger().error('todo/recurring-work:failed', 'scheduleId', 'monthly-report-write', 'title', '월간보고서 작성', 'error', String(exception && exception.message ? exception.message : exception))
  }
})

// 매월 1일 오전 10시
cronAdd('todo-recurring-work-k-tree-write', '0 1 1 * *', function () {
  try {
    const recurringWorkJob = require(__hooks + '/jobs/recurring-work-job.js')
    const result = recurringWorkJob.run({ scheduleId: 'k-tree-write', title: 'K-Tree 작성' })
    $app.logger().info('todo/recurring-work:completed', 'scheduleId', 'k-tree-write', 'workId', result.workId, 'title', 'K-Tree 작성')
  } catch (exception) {
    $app.logger().error('todo/recurring-work:failed', 'scheduleId', 'k-tree-write', 'title', 'K-Tree 작성', 'error', String(exception && exception.message ? exception.message : exception))
  }
})

// 매월 30일 오전 10시
cronAdd('todo-recurring-work-pg-payment-mismatch-review', '0 1 30 * *', function () {
  try {
    const recurringWorkJob = require(__hooks + '/jobs/recurring-work-job.js')
    const result = recurringWorkJob.run({ scheduleId: 'pg-payment-mismatch-review', title: 'PG 결제 불일치 건 조회' })
    $app.logger().info('todo/recurring-work:completed', 'scheduleId', 'pg-payment-mismatch-review', 'workId', result.workId, 'title', 'PG 결제 불일치 건 조회')
  } catch (exception) {
    $app
      .logger()
      .error(
        'todo/recurring-work:failed',
        'scheduleId',
        'pg-payment-mismatch-review',
        'title',
        'PG 결제 불일치 건 조회',
        'error',
        String(exception && exception.message ? exception.message : exception)
      )
  }
})

// 매주 화요일, 목요일 오전 9시 55분
cronAdd('todo-recurring-work-palrago-work-review', '55 0 * * 2,4', function () {
  try {
    const recurringWorkJob = require(__hooks + '/jobs/recurring-work-job.js')
    const result = recurringWorkJob.run({ scheduleId: 'palrago-work-review', title: '팔라고 업무 리뷰' })
    $app.logger().info('todo/recurring-work:completed', 'scheduleId', 'palrago-work-review', 'workId', result.workId, 'title', '팔라고 업무 리뷰')
  } catch (exception) {
    $app.logger().error('todo/recurring-work:failed', 'scheduleId', 'palrago-work-review', 'title', '팔라고 업무 리뷰', 'error', String(exception && exception.message ? exception.message : exception))
  }
})

cronAdd('todo-promote-scheduled-notifications', '* * * * *', function () {
  const now = new Date().toISOString()

  try {
    $app.runInTransaction(function (txApp) {
      const scheduled = txApp.findRecordsByFilter('scheduledNotifications', 'time <= {:now}', '+time', 500, 0, { now: now })
      const notificationCollection = txApp.findCollectionByNameOrId('notifications')

      for (let index = 0; index < scheduled.length; index += 1) {
        const source = scheduled[index]
        const notification = new Record(notificationCollection)

        notification.set('user', String(source.get('user') || ''))
        notification.set('title', String(source.get('title') || '업무 알림'))
        notification.set('message', String(source.get('message') || ''))
        notification.set('read', false)
        txApp.save(notification)
        txApp.delete(source)
      }
    })

    $app.logger().info('todo/scheduled-notifications:completed', 'at', now)
  } catch (exception) {
    $app.logger().error('todo/scheduled-notifications:failed', 'error', String(exception && exception.message ? exception.message : exception))
  }
})
