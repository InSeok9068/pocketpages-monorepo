routerAdd('GET', '/lab-hook', (e) => {
  const { globalApi } = require('pocketpages')

  return e.json(200, {
    hook: 'routerAdd',
    stringified: globalApi.stringify({ via: 'globalApi' }),
  })
})

onRecordCreate((e) => {
  const slug = String(e.record.get('slug') || '')

  if (slug.indexOf('hooked-') === 0) {
    e.record.set('description', 'set by onRecordCreate')
  }

  e.next()
}, 'boards')
