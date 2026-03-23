// UTC 기준 > 한국시간보려면 +9시간
cronAdd('booklog-reading-reminder', '10 0 * * *', function () {
  try {
    const readingReminderJob = require(__hooks + '/jobs/reading-reminder-job.js')

    readingReminderJob.run()
  } catch (exception) {
    $app.logger().error('jobs/reading-reminder:failed', 'error', String(exception && exception.message ? exception.message : exception))
  }
})

cronAdd('booklog-highlight-reminder', '0 0 * * *', function () {
  // cronAdd('booklog-highlight-reminder', '*/1 * * * *', function () {
  try {
    const highlightReminderJob = require(__hooks + '/jobs/highlight-reminder-job.js')

    highlightReminderJob.run()
  } catch (exception) {
    $app.logger().error('jobs/highlight-reminder:failed', 'error', String(exception && exception.message ? exception.message : exception))
  }
})
