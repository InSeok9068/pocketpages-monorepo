const CLAIM_TTL_MS = 600000
const MAX_ATTEMPTS = 5
const RETRY_DELAY_MS = 600000
const SPLIT_AFTER_ATTEMPTS = 1
const MIN_SPLIT_CHARS = 300
const MIN_REGENERATE_SPLIT_CHARS = 80
const SHORT_CHECK_MIN_CHARS = 250
const MAX_CHARS_PER_SECOND = 6.5
const SHORT_RETRY_LIMIT = 2
const BLOCKED_MAX_ATTEMPTS = 2
const BLOCKED_EXHAUSTED_MESSAGE = 'Gemini 정책 필터에 반복 차단되어 이 부분은 기기 음성으로 읽습니다.'

/**
 * 구간을 지금 생성할 수 있는지 판단합니다.
 * @param {core.Record} chunk 음성 구간
 * @param {number} nowMs 현재 시각(ms)
 * @returns {boolean} 생성 가능 여부
 */
function isClaimable(chunk, nowMs) {
  const status = String(chunk.get('status'))
  if (status === 'split' || (status === 'ready' && chunk.get('audio_file'))) return false
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
 * 트랜잭션 안에서 구간 생성 소유권을 확보합니다.
 * @param {types.BooklogApp} txApp 트랜잭션 앱
 * @param {core.Record} chunk 생성할 구간
 * @returns {string} 결과 저장 시 확인할 소유권 시각
 */
function claimChunk(txApp, chunk) {
  // 생성 중 서버가 꺼져 다시 가져가는 구간도 시도 1회로 세어, 같은 원인으로 계속 꺼질 때 한도를 끝없이 쓰지 않게 합니다.
  if (String(chunk.get('status')) === 'generating') {
    const attempts = Number(chunk.get('attempt_count') || 0) + 1
    chunk.set('attempt_count', attempts)
    if (attempts >= MAX_ATTEMPTS) {
      chunk.set('status', 'failed')
      chunk.set('error_message', '생성 중 서버가 여러 번 중단되어 이 구간은 기기 음성으로 읽습니다.')
      chunk.set('next_retry_at', '')
      txApp.save(chunk)
      return ''
    }
  }
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
    apply(current, txApp)
    txApp.save(current)
    saved = current
  })
  return saved
}

function markFailed(app, chunkId, claimedAt, message, countAttempt, splitWhenRepeated) {
  let split = false
  updateClaimed(app, chunkId, claimedAt, function (current, txApp) {
    const attempts = Number(current.get('attempt_count') || 0) + (countAttempt ? 1 : 0)
    const parts =
      splitWhenRepeated && attempts >= SPLIT_AFTER_ATTEMPTS ? splitInHalf(String(current.get('input_text'))) : null
    current.set('attempt_count', attempts)
    if (parts) {
      splitChunk(txApp, current, parts)
      split = true
      return
    }
    // 더 나눌 수 없는 차단 조각은 다시 보내도 대부분 또 막혀, 한 번만 재시도하고 하루 한도를 아낍니다.
    if (splitWhenRepeated && attempts >= BLOCKED_MAX_ATTEMPTS) {
      current.set('attempt_count', MAX_ATTEMPTS)
      current.set('status', 'failed')
      current.set('error_message', (BLOCKED_EXHAUSTED_MESSAGE + ' ' + message).slice(0, 2000))
      current.set('next_retry_at', '')
      return
    }
    current.set('status', 'failed')
    current.set('error_message', message)
    current.set('next_retry_at', new Date(Date.now() + (countAttempt ? RETRY_DELAY_MS * attempts : 0)).toISOString())
  })
  return split
}

function splitChunk(txApp, parent, parts) {
  const collection = txApp.findCollectionByNameOrId('book_audio_chunks')
  const copied = [
    'file_id',
    'section_index',
    'chunk_index',
    'config_hash',
    'provider',
    'model',
    'voice',
    'style',
    'pipeline_version',
  ]
  parts.forEach(function (text, index) {
    const child = new Record(collection)
    copied.forEach(function (field) {
      child.set(field, parent.get(field))
    })
    child.set('split_path', String(parent.get('split_path') || '') + index)
    child.set('text_hash', $security.sha256(text))
    child.set('input_text', text)
    child.set('status', 'queued')
    txApp.save(child)
  })
  parent.set('status', 'split')
  parent.set('error_message', '정책 차단이 반복되어 조각 2개로 나눠 다시 만듭니다.')
  parent.set('next_retry_at', '')
}

/**
 * 본문을 가운데에 가까운 문단·문장 경계에서 둘로 나눕니다.
 * @param {string} text 낭독 본문
 * @param {number} [minChars] 나눌 수 있는 최소 글자 수
 * @returns {string[] | null} 앞뒤 조각, 너무 짧아 나눌 수 없으면 null
 */
function splitInHalf(text, minChars) {
  if (text.length < (minChars || MIN_SPLIT_CHARS)) return null
  const middle = text.length / 2
  for (const pattern of [/\n\n+/g, /[.!?。！？][”’"']?\s+/g, /\s+/g]) {
    let best = -1
    let match = pattern.exec(text)
    while (match) {
      const end = match.index + match[0].length
      const balanced = end >= text.length / 4 && end <= (text.length * 3) / 4
      if (balanced && (best < 0 || Math.abs(end - middle) < Math.abs(best - middle))) best = end
      match = pattern.exec(text)
    }
    if (best > 0) return [text.slice(0, best).trim(), text.slice(best).trim()]
  }
  return null
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
    const ai = require('@pocketpages/ai').createAiClient({ geminiApiKey: apiKey, timeoutSeconds: 300, maxAttempts: 1 })
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
      const split = markFailed(
        app,
        chunkId,
        claimedAt,
        (summary + (reason ? ' ' + reason : '')).slice(0, 2000),
        !quota,
        blocked
      )
      const body = result.responseJson || {}
      return {
        ok: false,
        statusCode: quota ? 429 : 502,
        blocked,
        split,
        error: 'provider ' + result.statusCode + (reason ? ': ' + reason : ''),
        // 차단 사유 코드(status, details)를 확인하기 위해 Gemini 오류 응답 전체를 남깁니다.
        detail: JSON.stringify(body.error || body).slice(0, 4000),
      }
    }
    if (!result.audio) throw new Error('음성을 받지 못했습니다.')
    const audio = decodeMp3(result.audio.data, result.audio.mimeType)
    const inputText = String(chunk.get('input_text'))
    const rate = inputText.replace(/\s+/g, '').length / Math.max(audio.durationSeconds, 1)
    // 실측 정상 낭독은 공백 제외 초당 5.1~5.8자이고, 문장을 건너뛴 음성은 6.5자를 넘었습니다.
    const short = inputText.length >= SHORT_CHECK_MIN_CHARS && rate > MAX_CHARS_PER_SECOND
    const rateLabel = '초당 ' + rate.toFixed(1) + '자'
    if (short && Number(chunk.get('attempt_count') || 0) < SHORT_RETRY_LIMIT) {
      markFailed(app, chunkId, claimedAt, '음성이 원문보다 짧게 생성되어(' + rateLabel + ') 다시 만듭니다.', true)
      return {
        ok: false,
        statusCode: 502,
        blocked: false,
        split: false,
        error: 'audio shorter than text (' + rate.toFixed(2) + ' chars/s)',
        detail: '',
      }
    }
    // JSVM은 ArrayBuffer를 []byte로 바로 변환합니다. number[] 변환은 수백 MB 메모리를 씁니다.
    const audioFile = $filesystem.fileFromBytes(/** @type {any} */ (audio.bytes.buffer), 'audio.mp3')
    const saved = updateClaimed(app, chunkId, claimedAt, function (current) {
      current.set('audio_file', audioFile)
      current.set('duration_seconds', audio.durationSeconds)
      current.set('audio_kbps', 0)
      current.set('generated_at', new Date().toISOString())
      current.set('status', 'ready')
      current.set(
        'error_message',
        short
          ? '음성이 원문보다 짧게 생성됐습니다(' + rateLabel + '). 내용이 빠졌는지 들어 보고 필요하면 재생성해 주세요.'
          : ''
      )
      current.set('next_retry_at', '')
    })
    return {
      ok: true,
      statusCode: saved ? 200 : 409,
      blocked: false,
      split: false,
      error: saved ? '' : 'claim expired',
      detail: '',
    }
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
      split: false,
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

/**
 * MP3 프레임을 세어 재생 길이를 계산합니다.
 * @param {Uint8Array} bytes MP3 파일 바이트
 * @returns {number} 재생 길이(초)
 */
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

/**
 * 정책 차단으로 재시도를 끝낸 구간인지 확인합니다.
 * @param {core.Record} chunk 음성 구간
 * @returns {boolean} 반복 차단으로 끝난 구간 여부
 */
function isBlockedExhausted(chunk) {
  return chunk.get('status') === 'failed' && String(chunk.get('error_message')).indexOf(BLOCKED_EXHAUSTED_MESSAGE) === 0
}

/**
 * 반복 차단으로 끝난 구간을 재생성 요청 시 더 작은 조각 2개로 나눕니다.
 * @param {types.BooklogApp} txApp 트랜잭션 앱
 * @param {core.Record} chunk 재생성을 요청한 구간
 * @returns {boolean} 나눴는지 여부, 차단 구간이 아니거나 너무 짧으면 false
 */
function splitBlockedChunk(txApp, chunk) {
  if (!isBlockedExhausted(chunk)) return false
  const parts = splitInHalf(String(chunk.get('input_text')), MIN_REGENERATE_SPLIT_CHARS)
  if (!parts) return false
  splitChunk(txApp, chunk, parts)
  return true
}

module.exports = {
  BLOCKED_EXHAUSTED_MESSAGE,
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  MIN_REGENERATE_SPLIT_CHARS,
  isBlockedExhausted,
  isClaimable,
  splitBlockedChunk,
  toMs,
  claimChunk,
  generateClaimedChunk,
  splitInHalf,
  decodeMp3,
  mp3Duration,
}
