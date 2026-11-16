/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ data, dbg }) {
  dbg('page/lab:loader:patch', { loadedBy: data.loadedBy })

  return {
    methodLoader: 'patch',
  }
}
