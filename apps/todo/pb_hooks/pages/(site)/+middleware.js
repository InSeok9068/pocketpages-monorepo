/** @type {PocketPagesNextMiddlewareFunc} */
module.exports = function (api, next) {
  const { request } = api
  if (!request.auth) {
    next({ hasUnreadNotifications: false })
  } else {
    const userId = String(request.auth.get('id') || '')
    const unreadNotifications = $app.findRecordsByFilter('notifications', 'user = {:userId} && read = false', '-created', 1, 0, { userId })

    next({ hasUnreadNotifications: unreadNotifications.length > 0 })
  }
}
