/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = ({ meta, params, response }) => {
  const boardSlug = String(params.boardSlug || '').trim()
  let board = null

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
      error: 'Board not found',
    }
  }

  meta('title', `Write Post | ${board.get('name') || boardSlug}`)
  meta('description', board.get('description') || `Write post in ${boardSlug}`)

  return {
    board,
    error: '',
  }
}
