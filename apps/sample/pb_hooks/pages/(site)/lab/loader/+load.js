/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = function ({ dbg, request, response }) {
  const mode = String(request.url.query.mode || '').trim()

  dbg('page/lab:loader:load', { method: request.method, mode })

  if (mode === 'stop') {
    dbg('page/lab:loader:load:stopped', { status: 200 })
    response.json(200, { stoppedBy: 'load' })
    return {}
  }

  if (mode === 'throw') {
    throw new Error('Loader throw from +load.js')
  }

  return {
    loadedBy: 'load',
  }
}
