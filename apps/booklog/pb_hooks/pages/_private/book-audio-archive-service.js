const { dateutil } = require('@pocketpages/utils')
const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')
const jobService = require(__hooks + '/pages/_private/book-audio-job-service.js')
const audioData = require(__hooks + '/pages/_private/book-audio-data.js')
const compressService = require(__hooks + '/pages/_private/book-audio-compress-service.js')
const bookTitleService = require(__hooks + '/pages/_private/book-title.js')

const ARCHIVE_FORMAT = 'booklog-audio-archive'
const ARCHIVE_VERSION = 1
const MANIFEST_NAME = 'manifest.json'
const AUDIO_DIR = 'audio'
const ARCHIVE_NAME = 'archive.tar'
const WORKSPACE_PREFIX = 'booklog-audio-archive-'
const STALE_WORKSPACE_MS = 6 * 60 * 60 * 1000
const AUDIO_ENTRY = /^audio\/[A-Za-z0-9_-]+\.mp3$/
const CHUNK_STATUSES = ['ready', 'split', 'failed', 'queued']
// FileMode는 Go 권한 값이라 JSVM에는 숫자로 넘기며, 타입 정의만 인터페이스로 되어 있습니다.
const PRIVATE_DIR_MODE = /** @type {any} */ (0o700)

function userError(message) {
  return Object.assign(new Error(message), { userMessage: true })
}

function chunkKey(sectionIndex, chunkIndex, splitPath) {
  return [Number(sectionIndex), Number(chunkIndex), String(splitPath || '')].join(':')
}

function recordKey(chunk) {
  return chunkKey(chunk.get('section_index'), chunk.get('chunk_index'), chunk.get('split_path'))
}

function pruneStaleWorkspaces() {
  const base = $os.tempDir()
  try {
    $os.readDir(base).forEach(function (entry) {
      const name = String(entry.name())
      if (name.indexOf(WORKSPACE_PREFIX) !== 0) return
      if (Date.now() - entry.info().modTime().unixMilli() < STALE_WORKSPACE_MS) return
      $os.removeAll($filepath.join(base, name))
    })
  } catch (_error) {
    /* 정리하지 못한 임시 폴더는 다음 작업에서 다시 정리합니다. */
  }
}

function createWorkspace() {
  pruneStaleWorkspaces()
  const directory = $filepath.join($os.tempDir(), WORKSPACE_PREFIX + $security.randomString(16))
  $os.mkdirAll(directory, PRIVATE_DIR_MODE)
  return directory
}

/**
 * 보관 파일 작업 폴더를 지웁니다.
 * @param {string} directory 작업 폴더
 */
function removeWorkspace(directory) {
  if (!directory || $filepath.base(directory).indexOf(WORKSPACE_PREFIX) !== 0) return
  try {
    $os.removeAll(directory)
  } catch (_error) {
    /* 남은 폴더는 다음 보관·복원 때 오래된 폴더로 정리합니다. */
  }
}

function copyReader(reader, root, name) {
  let output = null
  try {
    output = root.create(name)
    output.readFrom(reader)
  } finally {
    if (output) output.close()
    reader.close()
  }
}

// GNU tar는 `C:\...`의 `C:`를 원격 호스트로 읽으므로, 작업 폴더에서 실행하고 상대 경로만 넘깁니다.
function runTar(directory, ...args) {
  try {
    const command = $os.cmd('tar', ...args)
    command.dir = directory
    return toString(command.output())
  } catch (exception) {
    throw Object.assign(
      new Error('tar 실행에 실패했습니다: ' + String(exception && exception.message ? exception.message : exception)),
      { cause: exception }
    )
  }
}

function archivedChunk(chunk, audio) {
  const status = String(chunk.get('status'))
  const exhausted = generation.isBlockedExhausted(chunk)
  // 생성 중이거나 아직 재시도할 수 있는 구간은 복원 뒤 다시 생성 대상이 되도록 대기 상태로 보관합니다.
  const archivedStatus = audio ? 'ready' : status === 'split' ? 'split' : exhausted ? 'failed' : 'queued'
  const keepsHistory = archivedStatus === 'failed' || archivedStatus === 'split'
  return {
    sectionIndex: Number(chunk.get('section_index')),
    chunkIndex: Number(chunk.get('chunk_index')),
    splitPath: String(chunk.get('split_path') || ''),
    textHash: String(chunk.get('text_hash')),
    inputText: String(chunk.get('input_text')),
    status: archivedStatus,
    attemptCount: keepsHistory ? Number(chunk.get('attempt_count') || 0) : 0,
    errorMessage: keepsHistory ? String(chunk.get('error_message') || '') : '',
    durationSeconds: audio ? Number(chunk.get('duration_seconds') || 0) : 0,
    audioKbps: audio ? Number(chunk.get('audio_kbps') || 0) : 0,
    generatedAt: audio ? String(chunk.get('generated_at') || '') : '',
    audio,
  }
}

function downloadName(title, fileId) {
  const safeTitle = Array.from(String(title || ''))
    .filter(function (character) {
      return character.charCodeAt(0) >= 32 && '\\/:*?"<>|'.indexOf(character) < 0
    })
    .join('')
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return (safeTitle || fileId) + '-audiobook-' + dateutil.formatDate(Date.now(), dateutil.FORMATS.COMPACT_DATE) + '.tar'
}

/**
 * EPUB 파일의 AI 오디오북을 목록 파일과 MP3 원본으로 묶은 보관 파일을 만듭니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @returns {types.BookAudioArchive} 만든 보관 파일, 내려받은 뒤 `removeWorkspace`로 지웁니다
 */
function createArchive(app, fileId) {
  const job = audioData.findFileJob(app, fileId)
  if (!job) throw userError('보관할 AI 오디오북이 없습니다.')
  const file = app.findRecordById('book_files', fileId)
  const book = app.findRecordById('books', String(file.get('book_id')))
  const configHash = String(job.get('config_hash'))
  const chunks = app.findRecordsByFilter(
    'book_audio_chunks',
    'file_id = {:fileId} && config_hash = {:configHash}',
    'section_index,chunk_index,split_path',
    0,
    0,
    { fileId, configHash }
  )
  const chunksById = {}
  chunks.forEach(function (chunk) {
    chunksById[String(chunk.get('id'))] = chunk
  })
  const progress = app
    .findRecordsByFilter(
      'book_audio_progress',
      'file_id = {:fileId} && config_hash = {:configHash}',
      'user_id,section_index',
      0,
      0,
      {
        fileId,
        configHash,
      }
    )
    .map(function (record) {
      const chunk = chunksById[String(record.get('audio_chunk_id'))]
      return {
        userId: String(record.get('user_id')),
        sectionIndex: Number(record.get('section_index')),
        chunkIndex: Number(record.get('chunk_index')),
        chunkKey: chunk ? recordKey(chunk) : '',
        chunkTextHash: chunk ? String(chunk.get('text_hash')) : '',
        positionSeconds: Number(record.get('position_seconds') || 0),
        isCompleted: !!record.get('is_completed'),
        lastListenedAt: String(record.get('last_listened_at') || ''),
      }
    })
  const directory = createWorkspace()
  try {
    $os.mkdirAll($filepath.join(directory, AUDIO_DIR), PRIVATE_DIR_MODE)
    const root = $os.openRoot(directory)
    const fsys = app.newFilesystem()
    let audioCount = 0
    let entries = []
    try {
      entries = chunks.map(function (chunk) {
        const audioFile = String(chunk.get('audio_file') || '')
        let audio = ''
        if (chunk.get('status') === 'ready' && audioFile) {
          audio = AUDIO_DIR + '/' + String(chunk.get('id')) + '.mp3'
          copyReader(fsys.getReader(chunk.baseFilesPath() + '/' + audioFile), root, audio)
          audioCount += 1
        }
        return archivedChunk(chunk, audio)
      })
      const manifest = {
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        exportedAt: new Date().toISOString(),
        book: { id: String(book.get('id')), title: String(book.get('title') || '') },
        file: {
          id: fileId,
          originalName: String(file.get('original_name') || ''),
          fileHash: String(file.get('file_hash') || ''),
        },
        job: {
          provider: String(job.get('provider')),
          model: String(job.get('model')),
          voice: String(job.get('voice')),
          style: String(job.get('style') || ''),
          pipelineVersion: String(job.get('pipeline_version')),
          configHash,
          compressKbps: Number(job.get('compress_kbps') || 0),
          startedAt: String(job.get('started_at') || ''),
        },
        chunks: entries,
        progress,
      }
      const output = root.create(MANIFEST_NAME)
      try {
        output.writeString(JSON.stringify(manifest, null, 2))
      } finally {
        output.close()
      }
    } finally {
      fsys.close()
      root.close()
    }
    runTar(directory, '-cf', ARCHIVE_NAME, MANIFEST_NAME, AUDIO_DIR)
    return {
      directory,
      archiveName: ARCHIVE_NAME,
      downloadName: downloadName(bookTitleService.getMainTitle(String(book.get('title') || '')), fileId),
      chunkCount: entries.length,
      audioCount,
    }
  } catch (exception) {
    removeWorkspace(directory)
    throw exception
  }
}

function normalizeEntry(name) {
  return String(name).trim().replace(/^\.\//, '')
}

// 직접 만든 보관 파일만 받도록, 압축을 풀기 전에 경로와 종류(일반 파일·폴더)를 확인합니다.
function listArchive(directory, verbose) {
  try {
    return runTar(directory, verbose ? '-tvf' : '-tf', ARCHIVE_NAME)
      .split(/\r?\n/)
      .filter(function (line) {
        return line.trim()
      })
  } catch (_error) {
    throw userError('보관 파일 형식을 확인해 주세요.')
  }
}

function verifyArchiveEntries(directory) {
  const names = listArchive(directory, false).map(normalizeEntry)
  const types = listArchive(directory, true)
  if (!names.length || names.length !== types.length) throw userError('보관 파일 형식을 확인해 주세요.')
  types.forEach(function (line) {
    const kind = line.trim().charAt(0)
    // tar 종류마다 링크 표기가 달라, 종류 문자와 링크 표시를 함께 확인합니다.
    if ((kind !== '-' && kind !== 'd') || / -> | link to /.test(line)) {
      throw userError('보관 파일에 허용하지 않는 항목이 있습니다.')
    }
  })
  const seen = {}
  names.forEach(function (name) {
    if (name !== MANIFEST_NAME && name !== AUDIO_DIR && name !== AUDIO_DIR + '/' && !AUDIO_ENTRY.test(name)) {
      throw userError('보관 파일에 허용하지 않는 항목이 있습니다.')
    }
    if (seen[name]) throw userError('보관 파일에 같은 이름의 항목이 여러 개 있습니다.')
    seen[name] = true
  })
  if (names.indexOf(MANIFEST_NAME) < 0) throw userError('보관 파일에 목록 파일이 없습니다.')
  return names
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value) throw userError('보관 파일의 ' + label + ' 정보를 확인해 주세요.')
  return value
}

function readManifest(directory, names) {
  let manifest = null
  try {
    manifest = JSON.parse(toString($os.readFile($filepath.join(directory, MANIFEST_NAME))))
  } catch (_error) {
    throw userError('보관 파일의 목록을 읽지 못했습니다.')
  }
  if (!manifest || manifest.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION) {
    throw userError('북로그 오디오북 보관 파일이 아니거나 지원하지 않는 버전입니다.')
  }
  const job = manifest.job || {}
  ;['provider', 'model', 'voice', 'pipelineVersion', 'configHash'].forEach(function (field) {
    requireText(job[field], '낭독 설정')
  })
  if (typeof job.style !== 'string') throw userError('보관 파일의 낭독 설정 정보를 확인해 주세요.')
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw userError('보관 파일에 구간이 없습니다.')
  const seen = {}
  manifest.chunks.forEach(function (chunk) {
    const key = chunk && chunkKey(chunk.sectionIndex, chunk.chunkIndex, chunk.splitPath)
    if (
      !chunk
      || !Number.isInteger(chunk.sectionIndex)
      || chunk.sectionIndex < 0
      || !Number.isInteger(chunk.chunkIndex)
      || chunk.chunkIndex < 0
      || typeof chunk.splitPath !== 'string'
      || !/^[01]*$/.test(chunk.splitPath)
      || CHUNK_STATUSES.indexOf(chunk.status) < 0
      || seen[key]
    ) {
      throw userError('보관 파일의 구간 정보를 확인해 주세요.')
    }
    seen[key] = true
    requireText(chunk.inputText, '구간 본문')
    if ($security.sha256(chunk.inputText) !== chunk.textHash) throw userError('보관 파일의 구간 본문이 손상되었습니다.')
    if (chunk.status === 'ready') {
      if (!AUDIO_ENTRY.test(String(chunk.audio || '')) || names.indexOf(chunk.audio) < 0) {
        throw userError('보관 파일에 음성 파일이 빠져 있습니다.')
      }
      if (!(Number(chunk.durationSeconds) > 0)) throw userError('보관 파일의 음성 길이 정보를 확인해 주세요.')
    } else if (chunk.audio) {
      throw userError('보관 파일의 구간 정보를 확인해 주세요.')
    }
  })
  if (manifest.progress !== undefined && !Array.isArray(manifest.progress)) {
    throw userError('보관 파일의 청취 기록 정보를 확인해 주세요.')
  }
  return manifest
}

function createJob(txApp, fileId, userId, settings) {
  const job = new Record(txApp.findCollectionByNameOrId('book_audio_jobs'))
  job.set('file_id', fileId)
  job.set('requested_by', userId)
  job.set('config_hash', settings.configHash)
  job.set('provider', settings.provider)
  job.set('model', settings.model)
  job.set('voice', settings.voice)
  job.set('style', settings.style)
  job.set('pipeline_version', settings.pipelineVersion)
  // 본문이 달라져 다시 만들 구간이 생겨도 관리자가 다시 시작하기 전에는 한도를 쓰지 않도록 멈춘 상태로 복원합니다.
  job.set('status', 'paused')
  job.set('total_chunks', 0)
  job.set(
    'compress_kbps',
    compressService.isSupportedBitrate(settings.compressKbps) ? Number(settings.compressKbps) : 0
  )
  if (settings.startedAt) job.set('started_at', settings.startedAt)
  txApp.save(job)
  return job
}

function createChunk(txApp, collection, fileId, settings, entry, directory) {
  const chunk = new Record(collection)
  chunk.set('file_id', fileId)
  chunk.set('section_index', entry.sectionIndex)
  chunk.set('chunk_index', entry.chunkIndex)
  chunk.set('split_path', entry.splitPath)
  chunk.set('text_hash', entry.textHash)
  chunk.set('config_hash', settings.configHash)
  chunk.set('input_text', entry.inputText)
  chunk.set('provider', settings.provider)
  chunk.set('model', settings.model)
  chunk.set('voice', settings.voice)
  chunk.set('style', settings.style)
  chunk.set('pipeline_version', settings.pipelineVersion)
  chunk.set('status', entry.status)
  if (entry.status === 'ready') {
    chunk.set('audio_file', $filesystem.fileFromPath($filepath.join(directory, entry.audio)))
    chunk.set('duration_seconds', Number(entry.durationSeconds))
    chunk.set('audio_kbps', Number(entry.audioKbps) || 0)
    chunk.set('generated_at', entry.generatedAt || new Date().toISOString())
  }
  if (entry.status === 'failed') {
    chunk.set('attempt_count', Number(entry.attemptCount) || generation.MAX_ATTEMPTS)
    chunk.set('error_message', String(entry.errorMessage || ''))
  }
  if (entry.status === 'split') {
    chunk.set('attempt_count', Number(entry.attemptCount) || 0)
    chunk.set('error_message', String(entry.errorMessage || ''))
  }
  txApp.save(chunk)
}

function restoreProgress(txApp, fileId, configHash, entries) {
  const chunksByKey = {}
  txApp
    .findRecordsByFilter('book_audio_chunks', 'file_id = {:fileId} && config_hash = {:configHash}', '', 0, 0, {
      fileId,
      configHash,
    })
    .forEach(function (chunk) {
      chunksByKey[recordKey(chunk)] = chunk
    })
  const collection = txApp.findCollectionByNameOrId('book_audio_progress')
  let restored = 0
  const seen = {}
  ;(entries || []).forEach(function (entry) {
    if (!entry || typeof entry.userId !== 'string' || !Number.isInteger(entry.sectionIndex)) return
    const key = entry.userId + ':' + entry.sectionIndex
    if (seen[key]) return
    seen[key] = true
    // 청취 위치가 가리키는 구간이 현재 본문과 맞지 않으면 엉뚱한 곳에서 이어 듣지 않도록 버립니다.
    const chunk = chunksByKey[String(entry.chunkKey || '')]
    if (!chunk || Number(chunk.get('section_index')) !== entry.sectionIndex) return
    if (String(chunk.get('text_hash')) !== String(entry.chunkTextHash || '')) return
    try {
      txApp.findRecordById('users', entry.userId)
    } catch (_error) {
      return
    }
    const record = new Record(collection)
    record.set('user_id', entry.userId)
    record.set('file_id', fileId)
    record.set('config_hash', configHash)
    record.set('section_index', entry.sectionIndex)
    record.set('audio_chunk_id', String(chunk.get('id')))
    record.set('chunk_index', Number(chunk.get('chunk_index')))
    record.set('position_seconds', Math.max(0, Number(entry.positionSeconds) || 0))
    record.set('is_completed', !!entry.isCompleted)
    if (entry.lastListenedAt) record.set('last_listened_at', entry.lastListenedAt)
    txApp.save(record)
    restored += 1
  })
  return restored
}

function countByStatus(app, fileId, configHash, status) {
  return app.countRecords(
    'book_audio_chunks',
    $dbx.hashExp({ file_id: fileId, config_hash: configHash, status: status })
  )
}

/**
 * 업로드한 보관 파일로 EPUB 파일의 AI 오디오북을 되살립니다. 현재 본문과 맞는 구간만 쓰고 나머지는 생성 대기로 둡니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId 복원할 EPUB 파일 ID
 * @param {string} userId 복원한 관리자 ID
 * @param {any} upload 업로드한 보관 파일(`findUploadedFiles` 항목)
 * @returns {types.BookAudioArchiveRestoreResult} 복원 결과
 */
function restoreUpload(app, fileId, userId, upload) {
  if (!upload || !upload.reader) throw userError('보관 파일을 선택해 주세요.')
  let sections = []
  try {
    sections = audioData.readBookSections(app, app.findRecordById('book_files', fileId), toBytes)
  } catch (_error) {
    throw userError('EPUB 본문을 읽지 못해 복원할 수 없습니다.')
  }
  if (!sections.length) throw userError('이 책에서 낭독할 본문을 찾지 못했습니다.')
  const directory = createWorkspace()
  try {
    const root = $os.openRoot(directory)
    try {
      copyReader(upload.reader.open(), root, ARCHIVE_NAME)
    } finally {
      root.close()
    }
    const names = verifyArchiveEntries(directory)
    const extracted = $filepath.join(directory, 'extracted')
    $os.mkdirAll(extracted, PRIVATE_DIR_MODE)
    try {
      runTar(directory, '-xf', ARCHIVE_NAME, '-C', 'extracted')
    } catch (_error) {
      throw userError('보관 파일 형식을 확인해 주세요.')
    }
    const manifest = readManifest(extracted, names)
    const settings = manifest.job
    const configHash = settings.configHash
    let jobId = ''
    let progress = 0
    app.runInTransaction(function (txApp) {
      if (audioData.findFileJob(txApp, fileId) || audioData.countFileChunks(txApp, fileId) > 0) {
        throw userError('이미 AI 오디오북이 있습니다. 삭제한 뒤 복원해 주세요.')
      }
      const job = createJob(txApp, fileId, userId, settings)
      jobId = String(job.get('id'))
      const collection = txApp.findCollectionByNameOrId('book_audio_chunks')
      manifest.chunks.forEach(function (entry) {
        createChunk(txApp, collection, fileId, settings, entry, extracted)
      })
      // 구간 등록과 같은 기준(챕터·구간 순서와 본문 해시)으로 현재 EPUB과 맞추고, 달라진 구간은 생성 대기로 바꿉니다.
      jobService.planJob(txApp, jobId, sections)
      progress = restoreProgress(txApp, fileId, configHash, manifest.progress)
    })
    const job = app.findRecordById('book_audio_jobs', jobId)
    const archivedAudio = manifest.chunks.filter(function (entry) {
      return entry.status === 'ready'
    }).length
    const readyChunks = countByStatus(app, fileId, configHash, 'ready')
    return {
      jobId,
      status: String(job.get('status')),
      readyChunks,
      queuedChunks: countByStatus(app, fileId, configHash, 'queued'),
      discardedAudio: Math.max(0, archivedAudio - readyChunks),
      progress,
    }
  } finally {
    removeWorkspace(directory)
  }
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  createArchive,
  restoreUpload,
  removeWorkspace,
}
