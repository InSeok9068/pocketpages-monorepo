/* global onBootstrap, $app, $os, __hooks, Record */
onBootstrap(function (event) {
  event.next()
  $app.importCollectionsByMarshaledJSON($os.readFile(__hooks + '/test-schema.json'), false)

  const user = new Record($app.findCollectionByNameOrId('users'))
  user.set('id', 'formsuser000001')
  user.set('email', 'forms@example.com')
  user.set('password', 'test-password-1234')
  user.set('verified', true)
  user.set('booklog_enabled', true)
  $app.save(user)
})
