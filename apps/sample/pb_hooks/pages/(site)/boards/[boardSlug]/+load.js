/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = ({ meta, params, response }) => {
  const boardSlug = String(params.boardSlug || '').trim()
  let board = null
  let posts = []

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
      posts: [],
      error: 'Board not found',
    }
  }

  meta('title', `${board.get('name') || boardSlug} | PocketPages Board`)
  meta('description', board.get('description') || `Board ${boardSlug}`)

  try {
    posts = $app.findRecordsByFilter(
      'posts',
      'board = {:boardId} && status = "published"',
      '-is_notice,-published_at,-created',
      50,
      0,
      { boardId: board.id }
    )
  } catch (error) {
    posts = []
  }

  return {
    board,
    posts,
    error: '',
  }
}
