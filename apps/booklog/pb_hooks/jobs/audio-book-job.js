const QUOTA_WAIT_MS = 30 * 60 * 1000
const FAILURE_WAIT_MS = 10 * 60 * 1000

/**
 * 예약된 오디오북 작업의 다음 구간 하나를 생성합니다.
 * @returns {{ jobId: string, chunkId: string, statusCode: number }} 실행 결과
 */
function run() {
  const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')
  const jobService = require(__hooks + '/pages/_private/book-audio-job-service.js')
  const logger = $app.logger()
  const nowMs = Date.now()
  const job = $app.findRecordsByFilter(
    'book_audio_jobs',
    "(status = 'queued' || status = 'running') && (next_run_at = '' || next_run_at <= {:now})",
    'next_run_at,created',
    1,
    0,
    { now: generation.toDbDate(nowMs) }
  )[0]
  if (!job) return { jobId: '', chunkId: '', statusCode: 0 }
  const jobId = String(job.get('id'))
  if (jobService.needsPlanning(job)) {
    // 책 분석은 무거워서 이번 실행은 구간 등록만 하고, 생성은 다음 실행부터 합니다.
    try {
      const audioData = require(__hooks + '/pages/_private/book-audio-data.js')
      const file = $app.findRecordById('book_files', String(job.get('file_id')))
      const sections = audioData.readBookSections($app, file, toBytes)
      if (!sections.length) {
        jobService.failPlanning($app, jobId, '이 책에서 낭독할 본문을 찾지 못했습니다.')
        logger.warn('jobs/audio-book:no-readable-text', 'jobId', jobId)
        return { jobId, chunkId: '', statusCode: 422 }
      }
      const planned = jobService.planJob($app, jobId, sections)
      logger.info(
        'jobs/audio-book:planned',
        'jobId',
        jobId,
        'totalChunks',
        String(planned.get('total_chunks')),
        'status',
        String(planned.get('status'))
      )
      return { jobId, chunkId: '', statusCode: 201 }
    } catch (exception) {
      const message = String(exception && exception.message ? exception.message : exception)
      jobService.failPlanning($app, jobId, 'EPUB 본문을 분석하지 못했습니다. 다시 시작하면 재시도합니다.')
      logger.error('jobs/audio-book:planning-failed', 'jobId', jobId, 'error', message)
      return { jobId, chunkId: '', statusCode: 500 }
    }
  }
  const apiKey = String(
    process.env.GEMINI_API_KEY || process.env.GEMINI_APIKEY || process.env.GEMINI_AI_KEY || ''
  ).trim()
  if (!apiKey) {
    logger.warn('jobs/audio-book:missing-api-key', 'jobId', jobId)
    return { jobId, chunkId: '', statusCode: 503 }
  }
  const next = jobService.findNextChunk($app, job, nowMs)
  if (!next) {
    let status = ''
    $app.runInTransaction(function (txApp) {
      const current = txApp.findRecordById('book_audio_jobs', jobId)
      status = String(current.get('status'))
      // 재시도 대기 구간만 남은 작업이 다른 예약 작업을 막지 않도록 순서를 뒤로 미룹니다.
      if (status === 'queued' || status === 'running') {
        current.set('next_run_at', new Date(Date.now() + FAILURE_WAIT_MS).toISOString())
      }
      jobService.syncJobProgress(txApp, current)
      status = String(current.get('status'))
    })
    logger.info('jobs/audio-book:no-pending-chunk', 'jobId', jobId, 'status', status)
    return { jobId, chunkId: '', statusCode: 0 }
  }
  const chunkId = String(next.get('id'))
  let claimedAt = ''
  $app.runInTransaction(function (txApp) {
    const current = txApp.findRecordById('book_audio_jobs', jobId)
    if (current.get('status') !== 'queued' && current.get('status') !== 'running') return
    const chunk = txApp.findRecordById('book_audio_chunks', chunkId)
    if (!generation.isClaimable(chunk, Date.now())) return
    claimedAt = generation.claimChunk(txApp, chunk)
    if (current.get('status') === 'queued') current.set('status', 'running')
    if (!String(current.get('started_at'))) current.set('started_at', new Date().toISOString())
    current.set('last_run_at', new Date().toISOString())
    txApp.save(current)
  })
  if (!claimedAt) return { jobId, chunkId, statusCode: 409 }
  logger.info('jobs/audio-book:generate', 'jobId', jobId, 'chunkId', chunkId)
  const result = generation.generateClaimedChunk($app, apiKey, chunkId, claimedAt)
  $app.runInTransaction(function (txApp) {
    const current = txApp.findRecordById('book_audio_jobs', jobId)
    if (result.statusCode === 429) {
      current.set('next_run_at', new Date(Date.now() + QUOTA_WAIT_MS).toISOString())
      current.set('error_message', 'Gemini 사용 한도에 도달해 30분 뒤 이어서 생성합니다.')
    } else if (result.blocked) {
      current.set(
        'error_message',
        '일부 구간이 Gemini 정책 필터에 차단되어, 다른 구간을 먼저 만들고 나중에 다시 시도합니다.'
      )
    } else if (!result.ok) {
      current.set('next_run_at', new Date(Date.now() + FAILURE_WAIT_MS).toISOString())
      current.set('error_message', '음성 생성에 실패해 10분 뒤 다시 시도합니다.')
    } else {
      current.set('error_message', '')
    }
    jobService.syncJobProgress(txApp, current)
  })
  if (result.ok) {
    logger.info('jobs/audio-book:saved', 'jobId', jobId, 'chunkId', chunkId)
  } else {
    logger.warn(
      'jobs/audio-book:generation-failed',
      'jobId',
      jobId,
      'chunkId',
      chunkId,
      'statusCode',
      String(result.statusCode),
      'error',
      result.error,
      'blocked',
      String(result.blocked),
      'detail',
      result.detail
    )
  }
  return { jobId, chunkId, statusCode: result.statusCode }
}

module.exports = { run }
