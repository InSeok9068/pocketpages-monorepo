/**
 * 관리자가 압축을 요청한 오디오북의 음성 구간을 몇 개씩 낮은 비트레이트로 다시 압축합니다.
 * @returns {{ jobId: string, compressed: number, failed: number }} 실행 결과
 */
function run() {
  const compress = require(__hooks + '/pages/_private/book-audio-compress-service.js')
  const result = compress.compressNextChunks($app)
  if (result.compressed > 0 || result.failed > 0) {
    $app
      .logger()
      .info(
        'jobs/audio-compress:done',
        'jobId',
        result.jobId,
        'compressed',
        String(result.compressed),
        'failed',
        String(result.failed)
      )
  }
  return result
}

module.exports = { run }
