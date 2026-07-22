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
