/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ data, dbg }) {
  dbg('page/lab:loader:delete', { loadedBy: data.loadedBy })

  return {
    methodLoader: 'delete',
  }
}
