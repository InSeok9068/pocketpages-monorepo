const { dateutil } = require('@pocketpages/utils')
const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')

const CLAIMABLE_FILTER =
  "(status = 'queued'"
  + " || (status = 'failed' && attempt_count < {:maxAttempts} && (next_retry_at = '' || next_retry_at <= {:now}))"
  + " || (status = 'generating' && generation_started_at < {:staleBefore}))"

/**
 * 파일과 낭독 설정의 오디오북 작업을 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @returns {core.Record | null} 오디오북 작업
 */
function findJob(app, fileId, configHash) {
  return (
    app.findRecordsByFilter('book_audio_jobs', 'file_id = {:fileId} && config_hash = {:configHash}', '', 1, 0, {
      fileId,
      configHash,
    })[0] || null
  )
}

/**
 * 생성 작업을 예약합니다. 책 분석과 구간 등록은 cron이 다음 실행에서 처리합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} userId 요청한 관리자 ID
 * @param {types.BookAudioSettings} settings 예약할 낭독 설정
 * @returns {core.Record} 저장한 작업
 */
function requestJob(app, fileId, userId, settings) {
  let job = null
  app.runInTransaction(function (txApp) {
    job = findJob(txApp, fileId, settings.configHash)
    if (!job) job = new Record(txApp.findCollectionByNameOrId('book_audio_jobs'))
    job.set('file_id', fileId)
    job.set('requested_by', userId)
    job.set('config_hash', settings.configHash)
    job.set('provider', settings.provider)
    job.set('model', settings.model)
    job.set('voice', settings.voice)
    job.set('style', settings.style)
    job.set('pipeline_version', settings.pipelineVersion)
    job.set('status', String(job.get('started_at')) ? 'running' : 'queued')
    // total_chunks 0은 cron이 책을 다시 분석해 구간을 등록해야 한다는 표시입니다.
    job.set('total_chunks', 0)
    job.set('next_run_at', '')
    job.set('completed_at', '')
    job.set('error_message', '')
    txApp.save(job)
  })
  return job
}

/**
 * 작업의 구간 등록이 필요한지 확인합니다.
 * @param {core.Record} job 오디오북 작업
 * @returns {boolean} 구간 등록 필요 여부
 */
function needsPlanning(job) {
  return Number(job.get('total_chunks') || 0) === 0
}

/**
 * 예약 시점 설정으로 책 전체 구간을 대기 상태로 등록합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} jobId 오디오북 작업 ID
 * @param {types.BookAudioSection[]} sections 챕터별 낭독 구간
 * @returns {core.Record} 갱신한 작업
 */
function planJob(app, jobId, sections) {
  let job = null
  app.runInTransaction(function (txApp) {
    job = txApp.findRecordById('book_audio_jobs', jobId)
    const fileId = String(job.get('file_id'))
    const settings = {
      provider: String(job.get('provider')),
      model: String(job.get('model')),
      voice: String(job.get('voice')),
      style: String(job.get('style')),
      pipelineVersion: String(job.get('pipeline_version')),
      configHash: String(job.get('config_hash')),
    }
    const known = {}
    txApp
      .findRecordsByFilter('book_audio_chunks', 'file_id = {:fileId} && config_hash = {:configHash}', '', 0, 0, {
        fileId,
        configHash: settings.configHash,
      })
      .forEach(function (record) {
        known[[record.get('section_index'), record.get('chunk_index'), record.get('text_hash')].join(':')] = record
      })
    const chunkCollection = txApp.findCollectionByNameOrId('book_audio_chunks')
    sections.forEach(function (section) {
      section.chunks.forEach(function (text, chunkIndex) {
        const textHash = $security.sha256(text)
        const key = [section.sectionIndex, chunkIndex, textHash].join(':')
        const existing = known[key]
        delete known[key]
        if (existing) {
          if (existing.get('status') === 'failed') {
            existing.set('attempt_count', 0)
            existing.set('next_retry_at', '')
            txApp.save(existing)
          }
          return
        }
        const chunk = new Record(chunkCollection)
        chunk.set('file_id', fileId)
        chunk.set('section_index', section.sectionIndex)
        chunk.set('chunk_index', chunkIndex)
        chunk.set('text_hash', textHash)
        chunk.set('config_hash', settings.configHash)
        chunk.set('input_text', text)
        chunk.set('provider', settings.provider)
        chunk.set('model', settings.model)
        chunk.set('voice', settings.voice)
        chunk.set('style', settings.style)
        chunk.set('pipeline_version', settings.pipelineVersion)
        chunk.set('status', 'queued')
        txApp.save(chunk)
      })
    })
    // 현재 본문과 맞지 않는 구간은 재생에 쓰이지 않고 완료 집계만 막습니다.
    Object.keys(known).forEach(function (key) {
      txApp.delete(known[key])
    })
    syncJobProgress(txApp, job)
  })
  return job
}

/**
 * 책 분석에 실패한 작업을 실패 상태로 저장합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} jobId 오디오북 작업 ID
 * @param {string} message 관리자에게 보여줄 사유
 */
function failPlanning(app, jobId, message) {
  app.runInTransaction(function (txApp) {
    const job = txApp.findRecordById('book_audio_jobs', jobId)
    job.set('status', 'failed')
    job.set('error_message', message)
    txApp.save(job)
  })
}

/**
 * 대기·진행 중인 작업을 일시 정지합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @returns {boolean} 일시 정지 여부
 */
function pauseJob(app, fileId, configHash) {
  let paused = false
  app.runInTransaction(function (txApp) {
    const job = findJob(txApp, fileId, configHash)
    if (!job || (job.get('status') !== 'queued' && job.get('status') !== 'running')) return
    job.set('status', 'paused')
    txApp.save(job)
    paused = true
  })
  return paused
}

/**
 * EPUB의 오디오북 음성·작업·청취 기록을 모든 낭독 설정에 대해 삭제합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @returns {{ chunks: number, jobs: number, progress: number }} 삭제한 레코드 수
 */
function deleteAudioBook(app, fileId) {
  const deleted = { chunks: 0, jobs: 0, progress: 0 }
  app.runInTransaction(function (txApp) {
    // 청취 기록이 구간을 참조하므로 먼저 지웁니다. 음성 파일은 구간 레코드 삭제 시 함께 지워집니다.
    ;[
      ['book_audio_progress', 'progress'],
      ['book_audio_chunks', 'chunks'],
      ['book_audio_jobs', 'jobs'],
    ].forEach(function (entry) {
      txApp.findRecordsByFilter(entry[0], 'file_id = {:fileId}', '', 0, 0, { fileId }).forEach(function (record) {
        txApp.delete(record)
        deleted[entry[1]] += 1
      })
    })
  })
  return deleted
}

/**
 * 구간 상태를 집계해 작업 진행률과 종료 상태를 저장합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {core.Record} job 오디오북 작업
 * @returns {types.BookAudioJobCounts} 집계 결과
 */
function syncJobProgress(app, job) {
  const counts = countChunks(app, String(job.get('file_id')), String(job.get('config_hash')))
  job.set('total_chunks', counts.total)
  job.set('ready_chunks', counts.ready)
  job.set('failed_chunks', counts.failed)
  if (counts.total > 0 && counts.ready >= counts.total) {
    job.set('status', 'completed')
    if (!String(job.get('completed_at'))) job.set('completed_at', new Date().toISOString())
    job.set('error_message', '')
  } else if (counts.total > 0 && counts.ready + counts.failed >= counts.total && job.get('status') !== 'paused') {
    job.set('status', 'failed')
    job.set('error_message', counts.failed + '개 구간을 만들지 못했습니다. 다시 예약하면 실패한 구간만 재시도합니다.')
  }
  app.save(job)
  return counts
}

function countChunks(app, fileId, configHash) {
  const scope = $dbx.hashExp({ file_id: fileId, config_hash: configHash })
  return {
    total: app.countRecords('book_audio_chunks', scope),
    ready: app.countRecords('book_audio_chunks', scope, $dbx.hashExp({ status: 'ready' })),
    failed: app.countRecords(
      'book_audio_chunks',
      scope,
      $dbx.hashExp({ status: 'failed' }),
      $dbx.exp('attempt_count >= {:maxAttempts}', { maxAttempts: generation.MAX_ATTEMPTS })
    ),
  }
}

/**
 * 책의 처음부터 순서대로 다음에 생성할 구간을 고릅니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {core.Record} job 오디오북 작업
 * @param {number} nowMs 현재 시각(ms)
 * @returns {core.Record | null} 생성할 구간
 */
function findNextChunk(app, job, nowMs) {
  return (
    app.findRecordsByFilter(
      'book_audio_chunks',
      'file_id = {:fileId} && config_hash = {:configHash} && ' + CLAIMABLE_FILTER,
      'section_index,chunk_index',
      1,
      0,
      {
        fileId: String(job.get('file_id')),
        configHash: String(job.get('config_hash')),
        maxAttempts: generation.MAX_ATTEMPTS,
        now: generation.toDbDate(nowMs),
        staleBefore: generation.toDbDate(nowMs - generation.CLAIM_TTL_MS),
      }
    )[0] || null
  )
}

/**
 * 작업을 관리자 화면 표시 값으로 만듭니다.
 * @param {core.Record} job 오디오북 작업
 * @returns {types.BookAudioJobView} 진행 상태
 */
function jobView(job) {
  const status = String(job.get('status'))
  const total = Number(job.get('total_chunks') || 0)
  const ready = Number(job.get('ready_chunks') || 0)
  const failed = Number(job.get('failed_chunks') || 0)
  const percent = total > 0 ? Math.floor((ready / total) * 100) : 0
  const nextRunMs = generation.toMs(job.get('next_run_at'))
  const labels = {
    queued: '생성 대기',
    running: '생성 중',
    paused: '일시 정지',
    completed: '생성 완료',
    failed: '일부 실패',
  }
  return {
    status,
    totalChunks: total,
    readyChunks: ready,
    failedChunks: failed,
    percent,
    statusLabel:
      total === 0
        ? status === 'failed'
          ? '생성 실패'
          : '구간 준비 중 · 2분 안에 책을 분석해 생성을 시작합니다'
        : (labels[status] || status)
          + ' · '
          + percent
          + '% ('
          + ready
          + ' / '
          + total
          + ' 구간)'
          + (failed > 0 ? ' · 실패 ' + failed : ''),
    nextRunLabel:
      nextRunMs > Date.now() && (status === 'queued' || status === 'running')
        ? dateutil.formatDate(nextRunMs, dateutil.FORMATS.DATE_TIME_MINUTES) + ' 이후 이어서 생성'
        : '',
    errorMessage: String(job.get('error_message') || ''),
    canStart: status === 'paused' || status === 'failed',
    canPause: status === 'queued' || status === 'running',
  }
}

/**
 * 관리자가 `regenerate_requested`를 켠 구간을 처음 상태로 되돌리고, 끝난 작업은 다시 진행 상태로 바꿉니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {number} nowMs 현재 시각(ms)
 * @returns {number} 초기화한 구간 수
 */
function applyRegenerateRequests(app, nowMs) {
  const touched = {}
  let reset = 0
  app.findRecordsByFilter('book_audio_chunks', 'regenerate_requested = true', '', 100, 0).forEach(function (record) {
    app.runInTransaction(function (txApp) {
      const chunk = txApp.findRecordById('book_audio_chunks', String(record.get('id')))
      if (!chunk.get('regenerate_requested')) return
      // 생성 중인 구간은 결과 저장과 겹치지 않도록 끝난 뒤 다음 실행에서 초기화합니다.
      if (chunk.get('status') === 'generating' && !generation.isClaimable(chunk, nowMs)) return
      chunk.set('status', 'queued')
      chunk.set('audio_file', '')
      chunk.set('duration_seconds', 0)
      chunk.set('attempt_count', 0)
      chunk.set('next_retry_at', '')
      chunk.set('error_message', '')
      chunk.set('generation_started_at', '')
      chunk.set('generated_at', '')
      chunk.set('regenerate_requested', false)
      txApp.save(chunk)
      touched[chunk.get('file_id') + ':' + chunk.get('config_hash')] = {
        fileId: String(chunk.get('file_id')),
        configHash: String(chunk.get('config_hash')),
      }
      reset += 1
    })
  })
  Object.keys(touched).forEach(function (key) {
    app.runInTransaction(function (txApp) {
      const job = findJob(txApp, touched[key].fileId, touched[key].configHash)
      if (!job) return
      if (job.get('status') === 'completed' || job.get('status') === 'failed') {
        job.set('status', 'running')
        job.set('completed_at', '')
        job.set('next_run_at', '')
        job.set('error_message', '')
      }
      syncJobProgress(txApp, job)
    })
  })
  return reset
}

module.exports = {
  applyRegenerateRequests,
  findJob,
  requestJob,
  needsPlanning,
  planJob,
  failPlanning,
  pauseJob,
  deleteAudioBook,
  syncJobProgress,
  findNextChunk,
  jobView,
}
