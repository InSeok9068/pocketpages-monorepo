/* global $app, module */
function sendPushNotification(input) {
  const store = $app.store()
  const attempts = store.get('test:push:attempts') || []
  const failFor = store.get('test:push:failFor') || []
  const userId = String(input.externalIds[0] || '')
  const failed = failFor.indexOf(userId) >= 0

  attempts.push({ userId: userId, title: input.title, contents: input.contents, ok: !failed })
  store.set('test:push:attempts', attempts)
  if (failed) throw new Error('OneSignal 푸시 발송에 실패했습니다. status=500')
  return { id: 'notification-' + attempts.length }
}

module.exports = { sendPushNotification }
