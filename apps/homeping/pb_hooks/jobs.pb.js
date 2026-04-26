// UTC 기준 > 한국시간보려면 +9시간
cronAdd('homeping-notice-daily', '5 0 * * *', function () {
  try {
    const noticeDailyJob = require(__hooks + '/jobs/notice-daily-job.js')

    noticeDailyJob.run()
  } catch (exception) {
    $app.logger().error('jobs/homeping-notice-daily:failed', 'error', String(exception && exception.message ? exception.message : exception))
  }
})
