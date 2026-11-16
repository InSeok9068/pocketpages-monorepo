/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ data, dbg }) {
  dbg('page/lab:loader:put', { loadedBy: data.loadedBy })

  return {
    methodLoader: 'put',
  }
}
