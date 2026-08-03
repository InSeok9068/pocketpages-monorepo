// PocketBase cron은 UTC 기준이며 매일 한국시간 자정에 실행합니다.
cronAdd('dulkong-anniversary-reminder', '0 15 * * *', function () {
  try {
    const anniversaryReminderJob = require(__hooks + '/jobs/anniversary-reminder-job.js')

    anniversaryReminderJob.run()
  } catch (exception) {
    $app
      .logger()
      .error(
        'jobs/anniversary-reminder:failed',
        'error',
        String(exception && exception.message ? exception.message : exception)
      )
  }
})
