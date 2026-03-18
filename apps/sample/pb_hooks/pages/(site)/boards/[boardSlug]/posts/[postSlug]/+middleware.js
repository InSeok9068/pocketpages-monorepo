/** @type {import('pocketpages').MiddlewareLoaderFunc} */
module.exports = function ({ data, params, resolve }) {
  const postService = resolve('post-service')
  const sharedData = data || {}
  const board = sharedData.board || null
  const boardId = board ? board.id : ''
  const postSlug = String(params.postSlug || '').trim()
  const post = postService.findPostByBoardAndSlug(boardId, postSlug)

  return {
    post,
  }
}
