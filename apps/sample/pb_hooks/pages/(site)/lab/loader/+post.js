/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ body, data, dbg }) {
  const payload = body()
  const form = payload && typeof payload === 'object' ? payload : {}
  const note = String(form.note || '').trim()

  dbg('page/lab:loader:post', { note, loadedBy: data.loadedBy })

  return {
    methodLoader: 'post',
    postedNote: note,
    loadedBeforePost: data.loadedBy,
  }
}
