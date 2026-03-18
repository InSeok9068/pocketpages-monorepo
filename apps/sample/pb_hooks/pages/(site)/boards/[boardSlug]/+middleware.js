/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ params, resolve }) {
  const boardService = resolve('board-service')
  const boardSlug = String(params.boardSlug || '').trim()
  const board = boardService.findActiveBoardBySlug(boardSlug)

  return {
    board,
  }
}
