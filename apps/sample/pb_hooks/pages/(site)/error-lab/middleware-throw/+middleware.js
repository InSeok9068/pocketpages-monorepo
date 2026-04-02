/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function () {
  throw new Error('Page throw from JS middleware')
}
