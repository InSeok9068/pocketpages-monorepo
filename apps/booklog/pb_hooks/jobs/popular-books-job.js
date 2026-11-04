/**
 * 인기 도서 목록의 만료되거나 없는 캐시를 채웁니다.
 * @returns {Record<string, boolean>} 목록별 유효한 캐시 확보 여부
 */
function run() {
  const popularBooksData = require(__hooks + '/pages/_private/popular-books-data.js')
  const data4libraryService = require(__hooks + '/pages/_private/data4library-service.js')
  const logger = $app.logger()
  const apiKey = String(process.env.DATA4LIBRARY_APIKEY || '').trim()

  if (!apiKey) {
    logger.warn('jobs/popular-books:missing-api-key')
    return {}
  }

  const result = popularBooksData.refreshAll(
    {
      data4libraryService: data4libraryService,
      config: { apiKey: apiKey, timeout: 30 },
    },
    new Date()
  )

  logger.info(
    'jobs/popular-books:refreshed',
    'month',
    String(result['list:month']),
    'steady',
    String(result['list:steady']),
    'hot',
    String(result.hot)
  )

  return result
}

module.exports = {
  run,
}
