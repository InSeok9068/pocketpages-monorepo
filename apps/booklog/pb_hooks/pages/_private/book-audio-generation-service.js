const CLAIM_TTL_MS = 180000
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 600000

/**
 * 구간을 지금 생성할 수 있는지 판단합니다.
 * @param {core.Record} chunk 음성 구간
 * @param {number} nowMs 현재 시각(ms)
 * @returns {boolean} 생성 가능 여부
 */
function isClaimable(chunk, nowMs) {
  const status = String(chunk.get('status'))
  if (status === 'ready' && chunk.get('audio_file')) return false
  if (status === 'generating') return !(nowMs - toMs(chunk.get('generation_started_at')) < CLAIM_TTL_MS)
  if (status !== 'failed') return true
  const retryAt = toMs(chunk.get('next_retry_at'))
  return Number(chunk.get('attempt_count') || 0) < MAX_ATTEMPTS && !(retryAt > nowMs)
}

/**
 * PocketBase date 값을 ms로 바꿉니다.
 * @param {any} value date 필드 값
 * @returns {number} ms, 비어 있으면 NaN
 */
function toMs(value) {
  const text = String(value || '').trim()
  return text ? Date.parse(text.replace(' ', 'T')) : NaN
}

/**
 * ms를 PocketBase date 필터 비교용 문자열로 바꿉니다.
 * @param {number} ms 시각(ms)
 * @returns {string} `YYYY-MM-DD HH:mm:ss.SSSZ`
 */
function toDbDate(ms) {
  return new Date(ms).toISOString().replace('T', ' ')
}

/**
 * 트랜잭션 안에서 구간 생성 소유권을 확보합니다.
 * @param {types.BooklogApp} txApp 트랜잭션 앱
 * @param {core.Record} chunk 생성할 구간
 * @returns {string} 결과 저장 시 확인할 소유권 시각
 */
function claimChunk(txApp, chunk) {
  chunk.set('status', 'generating')
  chunk.set('generation_started_at', new Date().toISOString())
  chunk.set('error_message', '')
  txApp.save(chunk)
  // PocketBase date 필드의 정규화된 문자열을 작업 소유권으로 사용합니다.
  return String(chunk.get('generation_started_at'))
}

function updateClaimed(app, chunkId, claimedAt, apply) {
  let saved = null
  app.runInTransaction(function (txApp) {
    const current = txApp.findRecordById('book_audio_chunks', chunkId)
    if (current.get('status') !== 'generating' || String(current.get('generation_started_at')) !== claimedAt) return
    apply(current)
    txApp.save(current)
    saved = current
  })
  return saved
}

function markFailed(app, chunkId, claimedAt, message, countAttempt) {
  updateClaimed(app, chunkId, claimedAt, function (current) {
    const attempts = Number(current.get('attempt_count') || 0) + (countAttempt ? 1 : 0)
    current.set('status', 'failed')
    current.set('error_message', message)
    current.set('attempt_count', attempts)
    current.set('next_retry_at', new Date(Date.now() + (countAttempt ? RETRY_DELAY_MS * attempts : 0)).toISOString())
  })
}

/**
 * 소유권을 확보한 구간의 음성을 Gemini로 생성해 저장합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} apiKey Gemini API 키
 * @param {string} chunkId 음성 구간 ID
 * @param {string} claimedAt 생성 소유권 시각
 * @returns {types.BookAudioGenerationResult} 생성 결과
 */
function generateClaimedChunk(app, apiKey, chunkId, claimedAt) {
  try {
    const chunk = app.findRecordById('book_audio_chunks', chunkId)
    const ai = require('@pocketpages/ai').createAiClient({ geminiApiKey: apiKey, timeoutSeconds: 120, maxAttempts: 1 })
    const result = ai.geminiSpeech({
      model: String(chunk.get('model')),
      input: String(chunk.get('input_text')),
      voice: String(chunk.get('voice')),
      style: String(chunk.get('style')),
    })
    if (!result.ok) {
      const quota = result.statusCode === 429
      const message = quota ? 'Gemini 사용 한도에 도달했습니다.' : 'Gemini 음성 생성에 실패했습니다.'
      markFailed(app, chunkId, claimedAt, message, !quota)
      return { ok: false, statusCode: quota ? 429 : 502, error: 'provider ' + result.statusCode }
    }
    if (!result.audio || result.audio.mimeType !== 'audio/wav') throw new Error('WAV 음성을 받지 못했습니다.')
    const wave = decodeWave(result.audio.data)
    // JSVM은 ArrayBuffer를 []byte로 바로 변환합니다. number[] 변환은 수백 MB 메모리를 씁니다.
    const audioFile = $filesystem.fileFromBytes(/** @type {any} */ (wave.bytes.buffer), 'audio.wav')
    const saved = updateClaimed(app, chunkId, claimedAt, function (current) {
      current.set('audio_file', audioFile)
      current.set('duration_seconds', wave.durationSeconds)
      current.set('generated_at', new Date().toISOString())
      current.set('status', 'ready')
      current.set('error_message', '')
      current.set('next_retry_at', '')
    })
    return { ok: true, statusCode: saved ? 200 : 409, error: saved ? '' : 'claim expired' }
  } catch (exception) {
    try {
      markFailed(app, chunkId, claimedAt, '음성 생성 또는 저장에 실패했습니다.', true)
    } catch (_saveError) {
      /* 소유권 만료 후 다음 생성에서 다시 시도합니다. */
    }
    return { ok: false, statusCode: 500, error: String((exception && exception.message) || exception) }
  }
}

/**
 * Gemini WAV 응답을 파일 바이트와 재생 길이로 변환합니다.
 * @param {string} data base64 WAV
 * @returns {{ bytes: Uint8Array, durationSeconds: number }} 음성 파일 데이터
 */
function decodeWave(data) {
  if (!data || data.length > 70 * 1024 * 1024 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('올바른 음성 데이터를 받지 못했습니다.')
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  // JSVM에 base64 디코더가 없어 문자 검색 대신 표 조회로 11MB 구간의 디코딩 시간을 줄입니다.
  const table = new Uint8Array(128)
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index
  const size = (data.length / 4) * 3 - (data.slice(-2) === '==' ? 2 : data.slice(-1) === '=' ? 1 : 0)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (let index = 0; index < data.length; index += 4) {
    const value =
      (table[data.charCodeAt(index)] << 18)
      | (table[data.charCodeAt(index + 1)] << 12)
      | (table[data.charCodeAt(index + 2)] << 6)
      | table[data.charCodeAt(index + 3)]
    if (offset < size) bytes[offset++] = (value >> 16) & 255
    if (offset < size) bytes[offset++] = (value >> 8) & 255
    if (offset < size) bytes[offset++] = value & 255
  }
  function label(index) {
    return String.fromCharCode(bytes[index], bytes[index + 1], bytes[index + 2], bytes[index + 3])
  }
  if (size < 44 || size > 50 * 1024 * 1024 || label(0) !== 'RIFF' || label(8) !== 'WAVE') {
    throw new Error('WAV 음성 형식을 확인하지 못했습니다.')
  }
  const view = new DataView(bytes.buffer)
  let byteRate = 0
  let dataSize = 0
  for (let index = 12; index + 8 <= size;) {
    const length = view.getUint32(index + 4, true)
    if (index + 8 + length > size) throw new Error('음성 파일이 완전하지 않습니다.')
    if (label(index) === 'fmt ' && length >= 16) byteRate = view.getUint32(index + 16, true)
    if (label(index) === 'data') dataSize += length
    index += 8 + length + (length % 2)
  }
  if (!byteRate || !dataSize) throw new Error('음성 재생 길이를 확인하지 못했습니다.')
  return { bytes, durationSeconds: dataSize / byteRate }
}

module.exports = {
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  isClaimable,
  toMs,
  toDbDate,
  claimChunk,
  generateClaimedChunk,
  decodeWave,
}
