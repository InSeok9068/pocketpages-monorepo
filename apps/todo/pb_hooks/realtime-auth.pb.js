onRealtimeSubscribeRequest(function (event) {
  const realtimeAuth = require(__hooks + '/lib/realtime-auth.js')
  const authResult = realtimeAuth.attachCookieAuth(event)
  const logAttributes = [
    'clientId',
    event.client.id(),
    'authStatus',
    authResult.status,
    'userId',
    authResult.userId,
    'subscriptionCount',
    event.subscriptions.length,
    'subscriptions',
    event.subscriptions.join(','),
  ]

  if (authResult.error) {
    logAttributes.push('error', authResult.error)
    $app.logger().warn('todo/realtime:subscribe-auth-failed', ...logAttributes)
  } else {
    $app.logger().debug('todo/realtime:subscribe', ...logAttributes)
  }

  event.next()
})
