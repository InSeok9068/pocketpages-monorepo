/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = ({ meta, params, response }) => {
  const boardSlug = String(params.boardSlug || '').trim()
  const postSlug = String(params.postSlug || '').trim()
  let board = null
  let post = null

  try {
    board = $app.findFirstRecordByFilter(
      'boards',
      'slug = {:slug} && is_active = true',
      { slug: boardSlug }
    )
  } catch (error) {
    board = null
  }

  if (!board) {
    response.status(404)
    meta('title', 'Board Not Found')

    return {
      board: null,
      post: null,
      error: 'Board not found',
    }
  }

  try {
    post = $app.findFirstRecordByFilter(
      'posts',
      'board = {:boardId} && slug = {:slug}',
      { boardId: board.id, slug: postSlug }
    )
  } catch (error) {
    post = null
  }

  if (!post) {
    response.status(404)
    meta('title', 'Post Not Found')

    return {
      board,
      post: null,
      error: 'Post not found',
    }
  }

  meta('title', `${post.get('title') || postSlug} | ${board.get('name') || boardSlug}`)
  meta('description', board.get('description') || `Post ${postSlug}`)

  return {
    board,
    post,
    error: '',
  }
}
