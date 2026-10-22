const epubReadingMetrics = require(__hooks + '/pages/_private/epub-reading-metrics.js')
const generation = require(__hooks + '/pages/_private/book-audio-generation-service.js')
const bookTitleService = require(__hooks + '/pages/_private/book-title.js')

// 새 모델은 여기 한 줄만 추가합니다. 화면 순서대로 두고, 기본 모델은 하나만 둡니다.
/** @type {types.BookAudioModelEntry[]} */
const MODELS = [
  { model: 'gemini-3.8-flash-lite-tts', label: '3.8 Flash Lite', isDefault: true },
  { model: 'gemini-3.8-flash-tts', label: '3.8 Flash', isDefault: false },
]
const DEFAULT_MODEL = MODELS.filter(function (entry) {
  return entry.isDefault
})[0].model
// 실측 Gemini 낭독 속도(공백 포함 초당 약 6.8자)로 아직 음성이 없는 구간의 재생 바 길이를 잡습니다.
const ESTIMATED_CHARS_PER_SECOND = 6.8

/**
 * EPUB에 등록된 최근 오디오북 작업을 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @returns {core.Record | null} 오디오북 작업
 */
function findFileJob(app, fileId) {
  return app.findRecordsByFilter('book_audio_jobs', 'file_id = {:fileId}', '-created,-id', 1, 0, { fileId })[0] || null
}

/**
 * 책에 고정된 낭독 설정을 읽습니다. 등록 전에는 Lite를 사용합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @returns {types.BookAudioSettings} 낭독 설정
 */
function getFileSettings(app, fileId) {
  const job = findFileJob(app, fileId)
  if (!job) return getSettings(DEFAULT_MODEL)
  return {
    provider: String(job.get('provider')),
    model: String(job.get('model')),
    voice: String(job.get('voice')),
    style: String(job.get('style')),
    pipelineVersion: String(job.get('pipeline_version')),
    configHash: String(job.get('config_hash')),
  }
}

/**
 * 모델별 미완료 작업과 새 책의 생성 가능 여부를 읽습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId 현재 EPUB 파일 ID
 * @returns {types.BookAudioModelOption[]} 모델 선택 항목
 */
function getModelOptions(app, fileId) {
  return MODELS.map(function (entry) {
    const busy = app.findRecordsByFilter(
      'book_audio_jobs',
      // 본문 분석에 실패해 구간이 하나도 없는 작업은 더 진행할 수 없으므로 모델을 차지하지 않습니다.
      "model = {:model} && file_id != {:fileId} && status != 'completed' && (status != 'failed' || total_chunks > 0)",
      'created,id',
      1,
      0,
      { model: entry.model, fileId }
    )[0]
    let bookTitle = ''
    if (busy) {
      const file = app.findRecordById('book_files', String(busy.get('file_id')))
      const book = app.findRecordById('books', String(file.get('book_id')))
      bookTitle = bookTitleService.getMainTitle(String(book.get('title') || '제목 없는 책'))
    }
    return {
      model: entry.model,
      label: entry.label,
      isDefault: entry.isDefault,
      disabled: !!busy,
      busyBookTitle: bookTitle,
    }
  })
}

/**
 * 지금 생성에 쓸 수 있는 모델을 고릅니다. 모델마다 한도가 따로라 비어 있는 모델을 쓰되, 기본 모델이 비어 있으면 그것을 고릅니다.
 * @param {types.BookAudioModelOption[]} options 모델 선택 항목
 * @returns {types.BookAudioModelOption | null} 사용할 모델, 모두 사용 중이면 null
 */
function pickAvailableModel(options) {
  const available = options.filter(function (option) {
    return !option.disabled
  })
  return (
    available.filter(function (option) {
      return option.isDefault
    })[0]
    || available[0]
    || null
  )
}

/**
 * 지원하는 TTS 모델인지 확인합니다.
 * @param {string} model 모델 이름
 * @returns {boolean} 지원 여부
 */
function isSupportedModel(model) {
  return MODELS.some(function (entry) {
    return entry.model === model
  })
}

/**
 * 서버의 낭독 설정과 재사용 식별자를 만듭니다.
 * @param {string} model 모델 이름
 * @returns {types.BookAudioSettings} 낭독 설정
 */
function getSettings(model) {
  if (!isSupportedModel(model)) {
    throw new Error('서버의 TTS 모델 설정을 확인해 주세요.')
  }
  const settings = {
    provider: 'gemini',
    model,
    voice: 'Sulafat',
    pipelineVersion: 'v2',
    style: '차분하고 따뜻한 한국어 오디오북 낭독. 일정한 속도와 자연스러운 문장 사이 호흡.',
    configHash: '',
  }
  settings.configHash = $security.sha256(
    JSON.stringify([settings.provider, settings.model, settings.voice, settings.style, settings.pipelineVersion])
  )
  return settings
}

/**
 * 사용자 서재에 연결된 원본 파일을 조회합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} userId 사용자 ID
 * @param {string} bookId 책 ID
 * @param {string} fileId EPUB 파일 ID
 * @returns {core.Record} 접근 가능한 파일
 */
function findAuthorizedFile(app, userId, bookId, fileId) {
  app.findFirstRecordByFilter(
    'book_shelves',
    'user_id = {:userId} && book_id = {:bookId} && book_file_id = {:fileId}',
    { userId, bookId, fileId }
  )
  return app.findFirstRecordByFilter('book_files', 'id = {:fileId} && book_id = {:bookId}', { fileId, bookId })
}

/**
 * 원본 EPUB 전체를 챕터별 낭독 구간으로 읽습니다.
 * @param {types.BooklogApp} app 파일 저장소 앱
 * @param {core.Record} file 원본 파일
 * @param {Function} readBytes 바이트 읽기 함수
 * @returns {types.BookAudioSection[]} 본문이 있는 챕터 목록
 */
function readBookSections(app, file, readBytes) {
  return epubReadingMetrics.buildAudioBookFromBytes(readEpubBytes(app, file, readBytes))
}

function readEpubBytes(app, file, readBytes) {
  const fileSize = Number(file.get('file_size') || 0)
  if (fileSize <= 0 || fileSize > 100 * 1024 * 1024) throw new Error('EPUB 파일 크기를 확인해 주세요.')
  const fsys = app.newFilesystem()
  let reader = null
  try {
    reader = fsys.getReader(String(file.baseFilesPath()) + '/' + String(file.get('stored_file')))
    const bytes = new Uint8Array(readBytes(reader, fileSize))
    if (bytes.length !== fileSize) throw new Error('EPUB 파일을 모두 읽지 못했습니다.')
    return bytes
  } finally {
    if (reader) reader.close()
    fsys.close()
  }
}

/**
 * 챕터에 등록된 낭독 구간 수를 셉니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex spine 순서
 * @returns {number} 챕터의 구간 수
 */
function countSectionChunks(app, fileId, configHash, sectionIndex) {
  return app.countRecords(
    'book_audio_chunks',
    $dbx.hashExp({ file_id: fileId, config_hash: configHash, section_index: sectionIndex, split_path: '' })
  )
}

/**
 * 낭독 구간이 등록된 다음 챕터를 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex 현재 spine 순서
 * @returns {number} 다음 챕터 spine 순서, 없으면 -1
 */
function findNextSectionIndex(app, fileId, configHash, sectionIndex) {
  const next = app.findRecordsByFilter(
    'book_audio_chunks',
    'file_id = {:fileId} && config_hash = {:configHash} && section_index > {:sectionIndex}',
    'section_index',
    1,
    0,
    { fileId, configHash, sectionIndex }
  )[0]
  return next ? Number(next.get('section_index')) : -1
}

/**
 * 낭독 구간이 있는 챕터의 spine 순서를 차례대로 읽습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @returns {number[]} 오름차순 spine 순서
 */
function readSectionOrder(app, fileId, configHash) {
  const order = []
  app
    .findRecordsByFilter(
      'book_audio_chunks',
      "file_id = {:fileId} && config_hash = {:configHash} && split_path = '' && chunk_index = 0",
      'section_index',
      0,
      0,
      { fileId, configHash }
    )
    .forEach(function (record) {
      const sectionIndex = Number(record.get('section_index'))
      if (order.indexOf(sectionIndex) < 0) order.push(sectionIndex)
    })
  return order
}

/**
 * 리더의 현재 문장이 들어 있는 챕터 내 구간과 그 구간 안의 글자 위치를 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex spine 순서
 * @param {string} anchorText 리더 화면의 기준 문장
 * @returns {{ chunkIndex: number, ratio: number }} 구간 순서(찾지 못하면 -1)와 구간 안 위치 비율(0~1)
 */
function findChunkPositionByText(app, fileId, configHash, sectionIndex, anchorText) {
  // 리더 DOM과 낭독 원문의 줄바꿈·공백 처리가 달라 공백을 모두 지운 뒤 비교합니다.
  const anchor = String(anchorText || '').replace(/[\s\u00ad]+/g, '')
  if (!anchor) return { chunkIndex: -1, ratio: 0 }
  const chunks = app.findRecordsByFilter(
    'book_audio_chunks',
    "file_id = {:fileId} && config_hash = {:configHash} && section_index = {:sectionIndex} && split_path = ''",
    'chunk_index',
    0,
    0,
    { fileId, configHash, sectionIndex }
  )
  const texts = chunks.map(function (chunk) {
    return String(chunk.get('input_text')).replace(/[\s\u00ad]+/g, '')
  })
  // \uc5ec\ub7ec \ubb38\ub2e8\uc744 \uc774\uc740 \uae30\uc900 \ubb38\uc7a5\uc740 \uad6c\uac04 \uacbd\uacc4\uc5d0 \uac78\uce60 \uc218 \uc788\uc5b4, \uccab \ubb38\ub2e8 \ucabd \uc55e\ubd80\ubd84\uc73c\ub85c \uc904\uc5ec \uac00\uba70 \ucc3e\uc2b5\ub2c8\ub2e4.
  for (const length of [anchor.length, 40, 20, 10]) {
    if (length > anchor.length) continue
    const prefix = anchor.slice(0, length)
    for (let index = 0; index < texts.length; index += 1) {
      const at = texts[index].indexOf(prefix)
      if (at >= 0) return { chunkIndex: Number(chunks[index].get('chunk_index')), ratio: at / texts[index].length }
    }
  }
  return { chunkIndex: -1, ratio: 0 }
}

/**
 * 낭독 설정과 관계없이 EPUB에 저장된 음성 구간 수를 셉니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @returns {number} 저장된 구간 수
 */
function countFileChunks(app, fileId) {
  return app.countRecords('book_audio_chunks', $dbx.hashExp({ file_id: fileId }))
}

/**
 * 재생할 원래 구간을 찾습니다. 생성 상태와 관계없이 찾고, 아직 음성이 없는 부분은 기기 음성으로 대신 읽습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex spine 순서
 * @param {number} chunkIndex 챕터 내 구간 순서
 * @returns {core.Record | null} 원래 구간
 */
function findChunk(app, fileId, configHash, sectionIndex, chunkIndex) {
  return (
    app.findRecordsByFilter(
      'book_audio_chunks',
      'file_id = {:fileId} && config_hash = {:configHash} && section_index = {:sectionIndex}'
        + " && chunk_index = {:chunkIndex} && split_path = ''",
      '',
      1,
      0,
      { fileId, configHash, sectionIndex, chunkIndex }
    )[0] || null
  )
}

/**
 * 구간을 재생 순서의 조각으로 펼칩니다. 나누지 않은 구간은 그 구간 하나입니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {core.Record} chunk 원래 구간
 * @returns {core.Record[]} 재생할 조각
 */
function findChunkParts(app, chunk) {
  if (String(chunk.get('status')) !== 'split') return [chunk]
  // 나눈 조각 중 더 나뉘지 않은 조각만 split_path 순서로 이으면 원문 순서가 됩니다.
  return app.findRecordsByFilter(
    'book_audio_chunks',
    'file_id = {:fileId} && config_hash = {:configHash} && section_index = {:sectionIndex}'
      + " && chunk_index = {:chunkIndex} && split_path != '' && status != 'split'",
    'split_path',
    0,
    0,
    {
      fileId: String(chunk.get('file_id')),
      configHash: String(chunk.get('config_hash')),
      sectionIndex: Number(chunk.get('section_index')),
      chunkIndex: Number(chunk.get('chunk_index')),
    }
  )
}

function partDuration(record) {
  const seconds = String(record.get('status')) === 'ready' ? Number(record.get('duration_seconds') || 0) : 0
  if (seconds > 0) return seconds
  return Math.max(1, Math.round((String(record.get('input_text')).length / ESTIMATED_CHARS_PER_SECOND) * 10) / 10)
}

/**
 * 챕터 재생 바에 쓸 구간별 길이를 읽습니다. 음성이 없는 구간·조각은 글자 수로 추정합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex spine 순서
 * @returns {number[]} 구간 순서별 길이(초)
 */
function sectionTimeline(app, fileId, configHash, sectionIndex) {
  const timeline = []
  app
    .findRecordsByFilter(
      'book_audio_chunks',
      "file_id = {:fileId} && config_hash = {:configHash} && section_index = {:sectionIndex} && status != 'split'",
      'chunk_index,split_path',
      0,
      0,
      { fileId, configHash, sectionIndex }
    )
    .forEach(function (record) {
      const index = Number(record.get('chunk_index'))
      timeline[index] = (timeline[index] || 0) + partDuration(record)
    })
  for (let index = 0; index < timeline.length; index += 1) timeline[index] = Number(timeline[index] || 0)
  return timeline
}

/**
 * 재생할 구간을 재생 정보로 만듭니다. 음성이 없는 조각(생성 전·생성 실패)은 기기 음성으로 읽을 원문을 담습니다.
 * @param {core.Record} chunk 재생할 구간
 * @param {core.Record[]} parts 재생 순서의 조각
 * @param {string} bookId 접근을 확인한 책 ID
 * @param {number} chunkCount 챕터의 구간 수
 * @param {number[]} order 낭독 구간이 있는 챕터 spine 순서
 * @param {number[]} timeline 챕터의 구간별 길이(초)
 * @returns {types.BookAudioChunkView} 재생 정보
 */
function chunkView(chunk, parts, bookId, chunkCount, order, timeline) {
  const position = order.indexOf(Number(chunk.get('section_index')))
  return {
    chunkId: String(chunk.get('id')),
    configHash: String(chunk.get('config_hash')),
    chunkCount,
    nextSectionIndex: position >= 0 && position + 1 < order.length ? order[position + 1] : -1,
    previousSectionIndex: position > 0 ? order[position - 1] : -1,
    chapterNumber: position + 1,
    chapterTotal: order.length,
    timeline,
    parts: parts.map(function (part) {
      const ready = String(part.get('status')) === 'ready' && !!part.get('audio_file')
      const exhausted =
        String(part.get('status')) === 'failed' && Number(part.get('attempt_count') || 0) >= generation.MAX_ATTEMPTS
      const query =
        'bookId='
        + encodeURIComponent(bookId)
        + '&fileId='
        + encodeURIComponent(String(part.get('file_id')))
        + '&chunkId='
        + encodeURIComponent(String(part.get('id')))
      return {
        audioUrl: ready
          ? '/xapi/books/audio-file?' + query + '&v=' + $security.sha256(String(part.get('generated_at')))
          : '',
        fallbackText: ready ? '' : String(part.get('input_text')),
        pending: !ready && !exhausted,
        text: String(part.get('input_text')),
        durationSeconds: partDuration(part),
      }
    }),
  }
}

module.exports = {
  DEFAULT_MODEL,
  findFileJob,
  getFileSettings,
  getModelOptions,
  pickAvailableModel,
  isSupportedModel,
  getSettings,
  findAuthorizedFile,
  readBookSections,
  countSectionChunks,
  countFileChunks,
  findNextSectionIndex,
  readSectionOrder,
  findChunkPositionByText,
  findChunk,
  findChunkParts,
  sectionTimeline,
  chunkView,
}
