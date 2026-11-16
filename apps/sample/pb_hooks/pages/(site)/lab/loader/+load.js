/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = function ({ dbg, request, response }) {
  dbg('page/lab:loader:load', { method: request.method })

  if (String(request.url.query.stop || '') === '1') {
    dbg('page/lab:loader:load:stopped', { status: 200 })
    response.json(200, { stoppedBy: 'load' })
    return {}
  }

  return {
    loadedBy: 'load',
  }
}
