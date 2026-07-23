onRealtimeConnectRequest(function (event) {
  const realtimeAuth = require(__hooks + '/lib/realtime-auth.js')
  realtimeAuth.attachCookieAuth(event)
  event.next()
})

onRealtimeSubscribeRequest(function (event) {
  const realtimeAuth = require(__hooks + '/lib/realtime-auth.js')
  realtimeAuth.attachCookieAuth(event)
  event.next()
})
