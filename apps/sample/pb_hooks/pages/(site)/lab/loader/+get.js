/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ data, dbg }) {
  dbg('page/lab:loader:get', { loadedBy: data.loadedBy })

  return {
    methodLoader: 'get',
  }
}
