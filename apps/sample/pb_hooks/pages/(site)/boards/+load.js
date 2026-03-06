/** @type {import('pocketpages').PageDataLoaderFunc} */
module.exports = ({ meta }) => {
  meta('title', 'Boards')
  meta('description', 'Simple boards list page')

  try {
    const boards = $app.findRecordsByFilter('boards', '', '+sort_order,+name', 50, 0)

    return {
      boards,
      error: '',
    }
  } catch (error) {
    return {
      boards: [],
      error: String(error.message || error),
    }
  }
}
