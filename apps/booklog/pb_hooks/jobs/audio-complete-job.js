/**
 * 예약된 완성본 통합·압축과 유예된 파일 정리를 실행합니다.
 * @returns {{ id: string, status: string }} 처리 결과
 */
function run() {
  const result = require(__hooks + '/pages/_private/book-audio-complete-service.js').run($app)
  if (result.id) $app.logger().info('jobs/audio-complete:done', 'id', result.id, 'status', result.status)
  return result
}
module.exports = { run }
