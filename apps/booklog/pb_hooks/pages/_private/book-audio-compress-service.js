const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')

const COMPRESS_BITRATES = [96, 64, 48]
const CHUNKS_PER_RUN = 5

/**
 * 관리자가 고를 수 있는 압축 비트레이트인지 확인합니다.
 * @param {number} kbps 비트레이트(kbps)
 * @returns {boolean} 지원 여부
 */
function isSupportedBitrate(kbps) {
  return COMPRESS_BITRATES.indexOf(Number(kbps)) >= 0
}

/**
 * 압축 팝업의 비트레이트 선택지를 돌려줍니다.
 * @returns {number[]} 비트레이트(kbps), 높은 순
 */
function getBitrateOptions() {
  return COMPRESS_BITRATES.slice()
}

function candidateFilter() {
  // audio_kbps 0은 Gemini가 만든 128kbps 원본이라, 목표보다 높은 음성만 다시 압축합니다.
  return (
    "file_id = {:fileId} && config_hash = {:configHash} && status = 'ready' && audio_file != ''"
    + ' && (audio_kbps = 0 || audio_kbps > {:kbps})'
  )
}

/**
 * 작업의 압축 진행 상황을 셉니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {core.Record} job 오디오북 작업
 * @returns {{ kbps: number, done: number, total: number }} 목표 비트레이트, 압축을 마친 구간 수, 음성이 있는 구간 수
 */
function getCompressionProgress(app, job) {
  const kbps = Number(job.get('compress_kbps') || 0)
  const scope = $dbx.hashExp({ file_id: String(job.get('file_id')), config_hash: String(job.get('config_hash')) })
  const withAudio = $dbx.exp("status = 'ready' AND audio_file != ''")
  const total = app.countRecords('book_audio_chunks', scope, withAudio)
  const done =
    kbps > 0
      ? app.countRecords(
          'book_audio_chunks',
          scope,
          withAudio,
          $dbx.exp('audio_kbps > 0 AND audio_kbps <= {:kbps}', { kbps: kbps })
        )
      : 0
  return { kbps, done, total }
}

/**
 * 음성 구간 하나를 lame으로 다시 압축해 저장합니다. 그사이 재생성·삭제된 구간이면 저장하지 않습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} chunkId 음성 구간 ID
 * @param {number} kbps 목표 비트레이트(kbps)
 * @returns {boolean} 저장 여부
 */
function compressChunk(app, chunkId, kbps) {
  const chunk = app.findRecordById('book_audio_chunks', chunkId)
  const fileName = String(chunk.get('audio_file'))
  const generatedAt = String(chunk.get('generated_at'))
  const directory = $os.tempDir()
  const inputPath = $filepath.join(directory, 'booklog-audio-' + chunkId + '-source.mp3')
  const outputPath = $filepath.join(directory, 'booklog-audio-' + chunkId + '.mp3')
  try {
    const fsys = app.newFilesystem()
    try {
      const reader = fsys.getReader(chunk.baseFilesPath() + '/' + fileName)
      try {
        // FileMode는 Go 권한 값이라 JSVM에는 숫자로 넘기며, 타입 정의만 인터페이스로 되어 있습니다.
        $os.writeFile(inputPath, /** @type {any} */ (toBytes(reader)), /** @type {any} */ (0o600))
      } finally {
        reader.close()
      }
    } finally {
      fsys.close()
    }
    // 낭독은 모노 한 목소리라 모노로 저장하고, 원본 MP3를 바로 읽어 다시 인코딩합니다.
    toString(
      $os.cmd('lame', '--quiet', '--mp3input', '-b', String(kbps), '-m', 'm', inputPath, outputPath).combinedOutput()
    )
    const durationSeconds = generation.mp3Duration(new Uint8Array(/** @type {any} */ ($os.readFile(outputPath))))
    const audioFile = $filesystem.fileFromPath(outputPath)
    let saved = false
    app.runInTransaction(function (txApp) {
      const current = txApp.findRecordById('book_audio_chunks', chunkId)
      if (
        current.get('status') !== 'ready'
        || String(current.get('audio_file')) !== fileName
        || String(current.get('generated_at')) !== generatedAt
      ) {
        return
      }
      current.set('audio_file', audioFile)
      current.set('duration_seconds', durationSeconds)
      current.set('audio_kbps', kbps)
      txApp.save(current)
      saved = true
    })
    return saved
  } finally {
    ;[inputPath, outputPath].forEach(function (path) {
      try {
        $os.remove(path)
      } catch (_error) {
        /* 이미 없거나 만들지 못한 임시 파일입니다. */
      }
    })
  }
}

/**
 * 압축을 요청한 작업에서 아직 목표보다 큰 구간을 몇 개씩 다시 압축합니다.
 * @param {types.BooklogApp} app DB 앱
 * @returns {{ jobId: string, compressed: number, failed: number }} 처리 결과
 */
function compressNextChunks(app) {
  const jobs = app.findRecordsByFilter('book_audio_jobs', 'compress_kbps > 0', 'updated,id', 50, 0)
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]
    const complete = require(__hooks + '/pages/_private/book-audio-complete-service.js')
    if (complete.available(app)) {
      const pending = app.findRecordsByFilter(
        'book_audio_complete',
        "file_id = {:fileId} && (status = 'queued' || status = 'running' || status = 'ready')",
        '',
        1,
        0,
        { fileId: job.get('file_id') }
      )
      if (pending.length) continue
    }
    const kbps = Number(job.get('compress_kbps'))
    if (!isSupportedBitrate(kbps)) continue
    const chunks = app.findRecordsByFilter(
      'book_audio_chunks',
      candidateFilter(),
      'section_index,chunk_index,split_path',
      CHUNKS_PER_RUN,
      0,
      { fileId: String(job.get('file_id')), configHash: String(job.get('config_hash')), kbps: kbps }
    )
    if (!chunks.length) continue
    const result = { jobId: String(job.get('id')), compressed: 0, failed: 0 }
    chunks.forEach(function (chunk) {
      try {
        if (compressChunk(app, String(chunk.get('id')), kbps)) result.compressed += 1
      } catch (exception) {
        result.failed += 1
        app
          .logger()
          .error(
            'jobs/audio-compress:chunk-failed',
            'chunkId',
            String(chunk.get('id')),
            'error',
            String(exception && exception.message ? exception.message : exception)
          )
      }
    })
    return result
  }
  return { jobId: '', compressed: 0, failed: 0 }
}

module.exports = {
  isSupportedBitrate,
  getBitrateOptions,
  getCompressionProgress,
  compressChunk,
  compressNextChunks,
}
