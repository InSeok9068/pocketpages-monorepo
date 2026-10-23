// 운영 환경에서만 예약 작업을 등록합니다. UTC 기준이며 한국 시간은 +9시간입니다.
if (String(process.env.APP_ENV || '').trim() === 'production') {
  cronAdd('booklog-reading-reminder', '0 11 * * *', function () {
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

  // 인기 도서 새벽 미리 받기(한국 시간 05:10)는 일부러 꺼 둡니다.
  // 인기 도서는 자주 열리지 않아, 아무도 안 보는 날에도 매일 API를 부르는 대신 그날 첫 방문자가 한 번 기다리는 쪽을 감수합니다.
  // 첫 조회 대기가 불편해지면 아래 주석을 풀면 됩니다. 실행 코드는 jobs/popular-books-job.js에 있습니다.
  // cronAdd('booklog-popular-books', '10 20 * * *', function () {
  //   try {
  //     const popularBooksJob = require(__hooks + '/jobs/popular-books-job.js')
  //
  //     popularBooksJob.run()
  //   } catch (exception) {
  //     $app
  //       .logger()
  //       .error(
  //         'jobs/popular-books:failed',
  //         'error',
  //         String(exception && exception.message ? exception.message : exception)
  //       )
  //   }
  // })
}
