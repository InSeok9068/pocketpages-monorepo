const CLAIM_TTL_MS = 180000
const MAX_ATTEMPTS = 5
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
      mimeType: 'audio/mp3',
    })
    if (!result.ok) {
      const quota = result.statusCode === 429
      const reason = String(result.errorMessage || '').slice(0, 500)
      // 정책 차단은 같은 본문도 재시도에서 통과하는 경우가 있어, 이 구간만 미루고 다른 구간은 계속 생성합니다.
      const blocked = result.statusCode === 400 && /policy|blocked|safety/i.test(reason)
      const summary = quota
        ? 'Gemini 사용 한도에 도달했습니다.'
        : blocked
          ? 'Gemini 정책 필터에 차단되어 나중에 다시 시도합니다.'
          : 'Gemini 음성 생성에 실패했습니다.'
      markFailed(app, chunkId, claimedAt, (summary + (reason ? ' ' + reason : '')).slice(0, 2000), !quota)
      const body = result.responseJson || {}
      return {
        ok: false,
        statusCode: quota ? 429 : 502,
        blocked,
        error: 'provider ' + result.statusCode + (reason ? ': ' + reason : ''),
        // 차단 사유 코드(status, details)를 확인하기 위해 Gemini 오류 응답 전체를 남깁니다.
        detail: JSON.stringify(body.error || body).slice(0, 4000),
      }
    }
    if (!result.audio) throw new Error('음성을 받지 못했습니다.')
    const audio = decodeMp3(result.audio.data, result.audio.mimeType)
    // JSVM은 ArrayBuffer를 []byte로 바로 변환합니다. number[] 변환은 수백 MB 메모리를 씁니다.
    const audioFile = $filesystem.fileFromBytes(/** @type {any} */ (audio.bytes.buffer), 'audio.mp3')
    const saved = updateClaimed(app, chunkId, claimedAt, function (current) {
      current.set('audio_file', audioFile)
      current.set('duration_seconds', audio.durationSeconds)
      current.set('generated_at', new Date().toISOString())
      current.set('status', 'ready')
      current.set('error_message', '')
      current.set('next_retry_at', '')
    })
    return { ok: true, statusCode: saved ? 200 : 409, blocked: false, error: saved ? '' : 'claim expired', detail: '' }
  } catch (exception) {
    try {
      markFailed(app, chunkId, claimedAt, '음성 생성 또는 저장에 실패했습니다.', true)
    } catch (_saveError) {
      /* 소유권 만료 후 다음 생성에서 다시 시도합니다. */
    }
    return {
      ok: false,
      statusCode: 500,
      blocked: false,
      error: String((exception && exception.message) || exception),
      detail: '',
    }
  }
}

/**
 * Gemini MP3 응답을 파일 바이트와 재생 길이로 변환합니다.
 * @param {string} data base64 MP3
 * @param {string} returnedMimeType 응답의 MIME 형식(`audio/mp3; rate=24000` 형태 포함)
 * @returns {{ bytes: Uint8Array, durationSeconds: number }} 음성 파일 데이터
 */
function decodeMp3(data, returnedMimeType) {
  const returned = String(returnedMimeType || '')
    .split(';')[0]
    .trim()
  if (['audio/mp3', 'audio/mpeg'].indexOf(returned) < 0) throw new Error('MP3 음성을 받지 못했습니다: ' + returned)
  const bytes = decodeBase64(data)
  if (bytes.length > 50 * 1024 * 1024) throw new Error('음성 파일이 너무 큽니다.')
  return { bytes, durationSeconds: mp3Duration(bytes) }
}

function mp3Duration(bytes) {
  let offset = 0
  if (bytes.length >= 10 && String.fromCharCode(bytes[0], bytes[1], bytes[2]) === 'ID3') {
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (bytes[5] & 0x10 ? 10 : 0)
  }
  const mpeg1Kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  const mpeg2Kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const sampleRates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
  const searchLimit = offset + 65536
  let samples = 0
  let sampleRate = 0
  let frames = 0
  while (offset + 4 <= bytes.length) {
    const version = (bytes[offset + 1] >> 3) & 3
    const layer = (bytes[offset + 1] >> 1) & 3
    const bitrateIndex = bytes[offset + 2] >> 4
    const rateIndex = (bytes[offset + 2] >> 2) & 3
    const valid =
      bytes[offset] === 0xff
      && (bytes[offset + 1] & 0xe0) === 0xe0
      && version !== 1
      && layer === 1
      && bitrateIndex > 0
      && bitrateIndex < 15
      && rateIndex < 3
    if (!valid) {
      // 첫 프레임 앞의 잡음만 건너뛰고, 프레임이 시작된 뒤 형식이 깨지면 ID3v1 꼬리표 등으로 보고 끝냅니다.
      if (frames > 0 || offset >= searchLimit) break
      offset += 1
      continue
    }
    const samplesPerFrame = version === 3 ? 1152 : 576
    sampleRate = sampleRates[version][rateIndex]
    const kbps = (version === 3 ? mpeg1Kbps : mpeg2Kbps)[bitrateIndex]
    const length = Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sampleRate) + ((bytes[offset + 2] >> 1) & 1)
    if (offset + length > bytes.length) break
    samples += samplesPerFrame
    frames += 1
    offset += length
  }
  if (!frames || !sampleRate) throw new Error('MP3 음성 형식을 확인하지 못했습니다.')
  return samples / sampleRate
}

function decodeBase64(data) {
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
  return bytes
}

module.exports = {
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  isClaimable,
  toMs,
  toDbDate,
  claimChunk,
  generateClaimedChunk,
  decodeMp3,
}
