// 운영 환경에서만 예약 작업을 등록합니다. UTC 기준이며 한국 시간은 +9시간입니다.
if (String(process.env.APP_ENV || '').trim() === 'production') {
  cronAdd('booklog-reading-reminder', '10 0 * * *', function () {
    try {
      const readingReminderJob = require(__hooks + '/jobs/reading-reminder-job.js')

      readingReminderJob.run()
    } catch (exception) {
      $app
        .logger()
        .error(
          'jobs/reading-reminder:failed',
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  })

  cronAdd('booklog-highlight-reminder', '0 0 * * *', function () {
    // cronAdd('booklog-highlight-reminder', '*/1 * * * *', function () {
    try {
      const highlightReminderJob = require(__hooks + '/jobs/highlight-reminder-job.js')

      highlightReminderJob.run()
    } catch (exception) {
      $app
        .logger()
        .error(
          'jobs/highlight-reminder:failed',
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  })

  cronAdd('booklog-weekly-reading-nudge', '0 9 * * 0', function () {
    try {
      const weeklyReadingNudgeJob = require(__hooks + '/jobs/weekly-reading-nudge-job.js')

      weeklyReadingNudgeJob.run()
    } catch (exception) {
      $app
        .logger()
        .error(
          'jobs/weekly-reading-nudge:failed',
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  })

  cronAdd('booklog-push-send-log-cleanup', '20 18 * * *', function () {
    try {
      const pushSendLogService = require(__hooks + '/jobs/push-send-log-service.js')
      const deletedCount = pushSendLogService.cleanupExpiredLogs(90)

      $app.logger().info('jobs/push-send-log-cleanup:completed', 'deletedCount', String(deletedCount))
    } catch (exception) {
      $app
        .logger()
        .error(
          'jobs/push-send-log-cleanup:failed',
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  })

  cronAdd('booklog-audio-book', '*/2 * * * *', function () {
    try {
      const audioBookJob = require(__hooks + '/jobs/audio-book-job.js')

      audioBookJob.run()
    } catch (exception) {
      $app
        .logger()
        .error(
          'jobs/audio-book:failed',
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  })

  cronAdd('booklog-reading-session-merge', '30 18 * * *', function () {
    try {
      const readingSessionMergeJob = require(__hooks + '/jobs/reading-session-merge-job.js')

      readingSessionMergeJob.run()
    } catch (exception) {
      $app
        .logger()
        .error(
          'jobs/reading-session-merge:failed',
          'error',
          String(exception && exception.message ? exception.message : exception)
        )
    }
  })
}
