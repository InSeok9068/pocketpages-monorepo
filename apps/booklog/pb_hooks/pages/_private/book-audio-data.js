const epubReadingMetrics = require(__hooks + '/pages/_private/epub-reading-metrics.js')

/**
 * 서버의 낭독 설정과 재사용 식별자를 만듭니다.
 * @param {string} model 모델 이름
 * @returns {types.BookAudioSettings} 낭독 설정
 */
function getSettings(model) {
  if (['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'].indexOf(model) < 0) {
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
    $dbx.hashExp({ file_id: fileId, config_hash: configHash, section_index: sectionIndex })
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
 * 리더의 현재 문장이 들어 있는 챕터 내 구간을 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex spine 순서
 * @param {string} anchorText 리더 화면의 기준 문장
 * @returns {number} 구간 순서, 찾지 못하면 -1
 */
function findChunkIndexByText(app, fileId, configHash, sectionIndex, anchorText) {
  // 리더 DOM과 낭독 원문의 줄바꿈·공백 처리가 달라 공백을 모두 지운 뒤 비교합니다.
  const anchor = String(anchorText || '').replace(/[\s\u00ad]+/g, '')
  if (!anchor) return -1
  const chunks = app.findRecordsByFilter(
    'book_audio_chunks',
    'file_id = {:fileId} && config_hash = {:configHash} && section_index = {:sectionIndex}',
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
      if (texts[index].indexOf(prefix) >= 0) return Number(chunks[index].get('chunk_index'))
    }
  }
  return -1
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
 * 재생할 수 있는 생성 완료 구간을 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB 파일 ID
 * @param {string} configHash 낭독 설정 해시
 * @param {number} sectionIndex spine 순서
 * @param {number} chunkIndex 챕터 내 구간 순서
 * @returns {core.Record | null} 생성 완료 구간
 */
function findReadyChunk(app, fileId, configHash, sectionIndex, chunkIndex) {
  return (
    app.findRecordsByFilter(
      'book_audio_chunks',
      'file_id = {:fileId} && config_hash = {:configHash} && section_index = {:sectionIndex}'
        + " && chunk_index = {:chunkIndex} && status = 'ready' && audio_file != ''",
      '',
      1,
      0,
      { fileId, configHash, sectionIndex, chunkIndex }
    )[0] || null
  )
}

/**
 * 생성 완료 구간을 재생 정보로 만듭니다.
 * @param {core.Record} chunk 생성 완료 구간
 * @param {string} bookId 접근을 확인한 책 ID
 * @param {number} chunkCount 챕터의 구간 수
 * @param {number} nextSectionIndex 다음 챕터 spine 순서, 없으면 -1
 * @returns {types.BookAudioChunkView} 재생 정보
 */
function chunkView(chunk, bookId, chunkCount, nextSectionIndex) {
  const query =
    'bookId='
    + encodeURIComponent(bookId)
    + '&fileId='
    + encodeURIComponent(String(chunk.get('file_id')))
    + '&chunkId='
    + encodeURIComponent(String(chunk.get('id')))
  return {
    chunkId: String(chunk.get('id')),
    configHash: String(chunk.get('config_hash')),
    chunkCount,
    nextSectionIndex,
    audioUrl: '/xapi/books/audio-file?' + query + '&v=' + $security.sha256(String(chunk.get('generated_at'))),
  }
}

module.exports = {
  getSettings,
  findAuthorizedFile,
  readBookSections,
  countSectionChunks,
  countFileChunks,
  findNextSectionIndex,
  findChunkIndexByText,
  findReadyChunk,
  chunkView,
}
