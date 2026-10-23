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
/** @type {types.BookAudioVoiceEntry[]} */
const VOICES = [
  { voice: 'Sulafat', description: '따뜻한 여성', isDefault: true },
  { voice: 'Achernar', description: '부드러운 여성', isDefault: false },
  { voice: 'Zephyr', description: '밝은 여성', isDefault: false },
  { voice: 'Gacrux', description: '성숙한 남성', isDefault: false },
  { voice: 'Charon', description: '또렷한 남성', isDefault: false },
]
// 작업에는 문구를 저장하므로, 이미 쓰인 문구를 바꾸면 그 책들은 화면에서 이름 대신 문구로 보입니다.
/** @type {types.BookAudioStyleEntry[]} */
const STYLES = [
  {
    key: 'calm',
    label: '차분한 낭독',
    text: '차분하고 따뜻한 한국어 오디오북 낭독. 일정한 속도와 자연스러운 문장 사이 호흡.',
    isDefault: true,
  },
  {
    key: 'literary',
    label: '담담한 문학 낭독',
    text: '문학 작품을 읽는 오디오북 낭독가. 담담하고 절제된 톤으로, 조금 느리게 읽고 문장 끝에서 여운을 남김.',
    isDefault: false,
  },
  {
    key: 'dialogue',
    label: '대사를 살리는 낭독',
    text: '오디오북 낭독가. 지문은 차분하게 읽고, 대사는 인물의 감정을 자연스럽게 살리되 과장하지 않음. 일정한 속도 유지.',
    isDefault: false,
  },
  {
    key: 'nonfiction',
    label: '설명형 낭독 (비소설)',
    text: '논픽션 오디오북 낭독가. 또렷하고 신뢰감 있는 톤으로, 핵심 개념과 예시를 구분해 읽음. 일정한 속도, 문단 사이 짧은 쉼.',
    isDefault: false,
  },
  {
    key: 'essay',
    label: '에세이 낭독',
    text: '에세이를 읽는 오디오북 낭독가. 편안하고 담백하게, 말을 건네듯 자연스러운 속도로 읽음.',
    isDefault: false,
  },
]
const DEFAULT_VOICE = VOICES.filter(function (entry) {
  return entry.isDefault
})[0].voice
const DEFAULT_STYLE = STYLES.filter(function (entry) {
  return entry.isDefault
})[0].key
// 실측 Gemini 낭독 속도(공백 포함 초당 약 6.8자)로 아직 음성이 없는 구간의 재생 바 길이를 잡습니다.
const ESTIMATED_CHARS_PER_SECOND = 6.8
// 생성 요청 전에는 공백 제외 본문 글자 수(text_char_count)만 있어, 실측 공백 제외 낭독 속도(초당 5.1~5.8자)를 씁니다.
const ESTIMATED_NONSPACE_CHARS_PER_SECOND = 5.3

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
 * 목소리 후보를 찾습니다.
 * @param {string} voice 목소리 이름
 * @returns {types.BookAudioVoiceEntry | null} 목소리 후보, 없으면 null
 */
function findVoice(voice) {
  return (
    VOICES.filter(function (entry) {
      return entry.voice === voice
    })[0] || null
  )
}

/**
 * 스타일 후보를 찾습니다.
 * @param {string} key 스타일 키
 * @returns {types.BookAudioStyleEntry | null} 스타일 후보, 없으면 null
 */
function findStyle(key) {
  return (
    STYLES.filter(function (entry) {
      return entry.key === key
    })[0] || null
  )
}

/**
 * 생성 요청 화면의 목소리·스타일 선택 항목을 돌려줍니다.
 * @returns {{ voices: types.BookAudioVoiceEntry[], styles: types.BookAudioStyleEntry[] }} 선택 항목
 */
function getVoiceStyleOptions() {
  return { voices: VOICES, styles: STYLES }
}

/**
 * 작업에 저장된 목소리·스타일을 화면 이름으로 바꿉니다. 후보에 없는 값은 저장된 값을 그대로 보여 줍니다.
 * @param {string} voice 저장된 목소리 이름
 * @param {string} style 저장된 스타일 문구
 * @returns {{ voiceLabel: string, styleLabel: string }} 화면 이름
 */
function describeVoiceStyle(voice, style) {
  const voiceEntry = findVoice(voice)
  const styleEntry = STYLES.filter(function (entry) {
    return entry.text === style
  })[0]
  return {
    voiceLabel: voiceEntry ? voiceEntry.voice + ' · ' + voiceEntry.description : voice,
    styleLabel: styleEntry ? styleEntry.label : style,
  }
}

/**
 * 서버의 낭독 설정과 재사용 식별자를 만듭니다.
 * @param {string} model 모델 이름
 * @param {string} [voice] 목소리 이름, 없으면 기본 목소리
 * @param {string} [styleKey] 스타일 키, 없으면 기본 스타일
 * @returns {types.BookAudioSettings} 낭독 설정
 */
function getSettings(model, voice, styleKey) {
  const voiceEntry = findVoice(voice || DEFAULT_VOICE)
  const styleEntry = findStyle(styleKey || DEFAULT_STYLE)
  if (!isSupportedModel(model) || !voiceEntry || !styleEntry) {
    throw new Error('서버의 TTS 모델 설정을 확인해 주세요.')
  }
  const settings = {
    provider: 'gemini',
    model,
    voice: voiceEntry.voice,
    pipelineVersion: 'v2',
    style: styleEntry.text,
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
 * 만든 음성 길이와 책 전체 예상 길이를 계산합니다. 아직 음성이 없는 구간·조각은 재생 바와 같은 속도로 추정합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @returns {types.BookAudioDuration} 음성 길이
 */
function getAudioDuration(app, fileId, configHash) {
  const row = new DynamicModel({ readySeconds: 0, pendingChars: 0, deviceChars: 0 })
  app
    .db()
    .newQuery(
      // 음성 길이는 소수라 정수로 선언한 DynamicModel에 그대로 담기지 않아, 초 단위로 반올림해 받습니다.
      "SELECT CAST(round(coalesce(sum(CASE WHEN status = 'ready' THEN duration_seconds ELSE 0 END), 0)) AS INTEGER) AS readySeconds,"
        + " coalesce(sum(CASE WHEN status != 'ready' THEN length(input_text) ELSE 0 END), 0) AS pendingChars,"
        + " coalesce(sum(CASE WHEN status = 'failed' AND error_message LIKE {:blocked} THEN length(input_text) ELSE 0 END), 0)"
        + ' AS deviceChars'
        + " FROM book_audio_chunks WHERE file_id = {:fileId} AND config_hash = {:configHash} AND status != 'split'"
    )
    .bind({ fileId, configHash, blocked: generation.BLOCKED_EXHAUSTED_MESSAGE + '%' })
    .one(row)
  const readySeconds = Number(row.readySeconds) || 0
  return {
    readySeconds,
    totalSeconds: readySeconds + (Number(row.pendingChars) || 0) / ESTIMATED_CHARS_PER_SECOND,
    deviceSeconds: (Number(row.deviceChars) || 0) / ESTIMATED_CHARS_PER_SECOND,
  }
}

/**
 * 생성 요청 전 본문 글자 수로 오디오북 길이를 추정합니다. 목차·주석처럼 낭독하지 않는 부분도 들어 있어 조금 길게 나옵니다.
 * @param {number} textCharCount 공백 제외 본문 글자 수
 * @returns {number} 예상 길이(초), 글자 수가 없으면 0
 */
function estimateSecondsFromText(textCharCount) {
  return Number(textCharCount) > 0 ? Number(textCharCount) / ESTIMATED_NONSPACE_CHARS_PER_SECOND : 0
}

/**
 * 재시도를 끝내 관리자가 검토할 구간·조각을 책 순서대로 읽습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} limit 최대 개수
 * @returns {types.BookAudioFailedChunkView[]} 실패 구간
 */
function listFinalFailedChunks(app, fileId, configHash, limit) {
  return app
    .findRecordsByFilter(
      'book_audio_chunks',
      "file_id = {:fileId} && config_hash = {:configHash} && status = 'failed' && attempt_count >= {:maxAttempts}",
      'section_index,chunk_index,split_path',
      limit,
      0,
      { fileId, configHash, maxAttempts: generation.MAX_ATTEMPTS }
    )
    .map(function (record) {
      const text = String(record.get('input_text') || '')
      const splitPath = String(record.get('split_path') || '')
      const id = String(record.get('id'))
      const blocked = generation.isBlockedExhausted(record)
      return {
        id,
        position: record.get('section_index') + ':' + record.get('chunk_index') + (splitPath ? '.' + splitPath : ''),
        textLength: text.length,
        preview: text.replace(/\s+/g, ' ').trim().slice(0, 60),
        reasonLabel: !blocked
          ? '생성 실패'
          : text.length >= generation.MIN_REGENERATE_SPLIT_CHARS
            ? '정책 차단(나눠서 재생성 가능)'
            : '정책 차단(' + generation.MIN_REGENERATE_SPLIT_CHARS + '자 미만)',
        regenerateRequested: !!record.get('regenerate_requested'),
        errorMessage: blocked ? '' : String(record.get('error_message') || '').slice(0, 120),
        adminHref: '/_/#/collections?collection=book_audio_chunks&filter=' + encodeURIComponent("id = '" + id + "'"),
      }
    })
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
  findVoice,
  findStyle,
  getVoiceStyleOptions,
  describeVoiceStyle,
  getSettings,
  findAuthorizedFile,
  readBookSections,
  countSectionChunks,
  countFileChunks,
  getAudioDuration,
  estimateSecondsFromText,
  listFinalFailedChunks,
  findNextSectionIndex,
  readSectionOrder,
  findChunkPositionByText,
  findChunk,
  findChunkParts,
  sectionTimeline,
  chunkView,
}
