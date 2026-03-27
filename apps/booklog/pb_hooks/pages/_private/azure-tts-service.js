const DEFAULT_AZURE_TTS_REGION = 'koreacentral'
const DEFAULT_AZURE_TTS_API_PATH = '/cognitiveservices/v1'
const DEFAULT_AZURE_TTS_VOICE_NAME = 'ko-KR-SunHiNeural'
const DEFAULT_AZURE_TTS_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'
const DEFAULT_AZURE_TTS_TIMEOUT_SECONDS = 20
const DEFAULT_AZURE_TTS_USER_AGENT = 'booklog-reader'
const VOICE_NAME_PATTERN = /^[A-Za-z0-9:-]+$/

/**
 * 지정 상태코드를 가진 오류 객체를 만듭니다.
 * @param {string} message 사용자에게 보여줄 오류 메시지입니다.
 * @param {number} statusCode HTTP 상태코드입니다.
 * @returns {Error & { statusCode: number }} 상태코드를 포함한 오류입니다.
 */
function createStatusError(message, statusCode) {
  var error = new Error(String(message || '').trim() || 'Azure TTS 요청에 실패했습니다.')

  error.statusCode = statusCode
  return error
}

/**
 * 환경 변수 숫자 값을 읽고 기본값으로 보정합니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @param {string} key 읽을 환경 변수 이름입니다.
 * @param {number} fallback 유효한 값이 없을 때 사용할 기본값입니다.
 * @returns {number} 사용할 숫자 값입니다.
 */
function readPositiveIntegerEnv(envGetter, key, fallback) {
  var parsed = parseInt(String(envGetter(key) || '').trim(), 10)

  if (!parsed || parsed < 1) {
    return fallback
  }

  return parsed
}

/**
 * Azure TTS 엔드포인트를 읽습니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {string} 최종 합성 엔드포인트입니다.
 */
function readAzureTtsApiUrl(envGetter) {
  var configuredApiUrl = String(envGetter('AZURE_TTS_APIURL') || '')
    .trim()
    .replace(/\/+$/, '')
  var configuredRegion = String(envGetter('AZURE_TTS_REGION') || '').trim()
  var region = configuredRegion || DEFAULT_AZURE_TTS_REGION

  if (configuredApiUrl) {
    if (configuredApiUrl.indexOf(DEFAULT_AZURE_TTS_API_PATH) >= 0) {
      return configuredApiUrl
    }

    return configuredApiUrl + DEFAULT_AZURE_TTS_API_PATH
  }

  return 'https://' + region + '.tts.speech.microsoft.com' + DEFAULT_AZURE_TTS_API_PATH
}

/**
 * Azure TTS 설정을 읽습니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {{ apiKey: string, apiUrl: string, voiceName: string, outputFormat: string, timeoutSeconds: number, userAgent: string }} Azure TTS 설정입니다.
 */
function readAzureTtsConfig(envGetter) {
  var apiKey = String(envGetter('AZURE_TTS_APIKEY') || '').trim()
  var voiceName = String(envGetter('AZURE_TTS_VOICE_NAME') || DEFAULT_AZURE_TTS_VOICE_NAME).trim() || DEFAULT_AZURE_TTS_VOICE_NAME

  if (!apiKey) {
    throw createStatusError('AZURE_TTS_APIKEY 환경변수가 필요합니다.', 503)
  }

  return {
    apiKey: apiKey,
    apiUrl: readAzureTtsApiUrl(envGetter),
    voiceName: VOICE_NAME_PATTERN.test(voiceName) ? voiceName : DEFAULT_AZURE_TTS_VOICE_NAME,
    outputFormat: String(envGetter('AZURE_TTS_OUTPUT_FORMAT') || DEFAULT_AZURE_TTS_OUTPUT_FORMAT).trim() || DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
    timeoutSeconds: readPositiveIntegerEnv(envGetter, 'AZURE_TTS_TIMEOUT_SECONDS', DEFAULT_AZURE_TTS_TIMEOUT_SECONDS),
    userAgent: String(envGetter('AZURE_TTS_USER_AGENT') || DEFAULT_AZURE_TTS_USER_AGENT).trim() || DEFAULT_AZURE_TTS_USER_AGENT,
  }
}

/**
 * XML 특수문자를 이스케이프합니다.
 * @param {string} value SSML에 넣을 텍스트입니다.
 * @returns {string} 이스케이프된 텍스트입니다.
 */
function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 재생 속도를 Azure SSML 비율 문자열로 바꿉니다.
 * @param {number|string} value 클라이언트에서 받은 재생 속도입니다.
 * @returns {string} Azure SSML rate 값입니다.
 */
function toAzureProsodyRate(value) {
  var parsed = Number(value)
  var normalized = isFinite(parsed) ? Math.max(0.8, Math.min(1.6, parsed)) : 1
  var percentage = Math.round((normalized - 1) * 100)

  if (percentage > 0) {
    return '+' + percentage + '%'
  }

  return String(percentage) + '%'
}

/**
 * Azure TTS 요청용 SSML을 만듭니다.
 * @param {{ text?: string, ssmlText?: string, voiceName: string, rate: number|string }} input 합성 입력값입니다.
 * @returns {string} Azure REST API에 보낼 SSML 문자열입니다.
 */
function createSsml(input) {
  var source = input || {}
  var voiceName = String(source.voiceName || '').trim()
  var ssmlText = String(source.ssmlText || '').trim()
  var text = String(source.text || '')
    .replace(/\s+/g, ' ')
    .trim()
  var bodyText = ''

  if (!ssmlText && !text) {
    throw createStatusError('읽을 텍스트가 필요합니다.', 400)
  }

  bodyText = ssmlText ? '<p>' + ssmlText + '</p>' : '<p><s>' + escapeXml(text) + '</s></p>'

  return [
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">',
    '<voice name="' + escapeXml(voiceName) + '">',
    '<prosody rate="' + escapeXml(toAzureProsodyRate(source.rate)) + '">',
    bodyText,
    '</prosody>',
    '</voice>',
    '</speak>',
  ].join('')
}

/**
 * Azure 응답 헤더에서 Content-Type을 읽습니다.
 * @param {{ [key: string]: string[] }} headers Azure 응답 헤더입니다.
 * @returns {string} 응답 Content-Type입니다.
 */
function extractContentType(headers) {
  var contentTypes = headers && headers['Content-Type'] ? headers['Content-Type'] : []

  if (Array.isArray(contentTypes) && contentTypes.length) {
    return String(contentTypes[0] || '').trim() || 'audio/mpeg'
  }

  return 'audio/mpeg'
}

/**
 * Azure TTS로 음성을 합성합니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @param {{ text?: string, ssmlText?: string, voiceName?: string, rate?: number|string }} input 합성 입력값입니다.
 * @returns {{ contentType: string, body: Array<number> }} 합성된 오디오 응답입니다.
 */
function synthesizeSpeech(envGetter, input) {
  var config = readAzureTtsConfig(envGetter)
  var requestedVoiceName = String(input && input.voiceName ? input.voiceName : '').trim()
  var voiceName = VOICE_NAME_PATTERN.test(requestedVoiceName) ? requestedVoiceName : config.voiceName
  var response = null

  response = $http.send({
    url: config.apiUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/ssml+xml',
      'Ocp-Apim-Subscription-Key': config.apiKey,
      'X-Microsoft-OutputFormat': config.outputFormat,
      'User-Agent': config.userAgent,
    },
    body: createSsml({
      text: input && input.text ? input.text : '',
      ssmlText: input && input.ssmlText ? input.ssmlText : '',
      voiceName: voiceName,
      rate: input && typeof input.rate !== 'undefined' ? input.rate : 1,
    }),
    timeout: config.timeoutSeconds,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw createStatusError(
      'Azure TTS 응답이 올바르지 않습니다. status=' + response.statusCode + (response.raw ? ' message=' + String(response.raw).trim() : ''),
      response.statusCode >= 500 ? 502 : response.statusCode
    )
  }

  if (!Array.isArray(response.body) || !response.body.length) {
    throw createStatusError('Azure TTS 오디오 응답이 비어 있습니다.', 502)
  }

  return {
    contentType: extractContentType(response.headers || {}),
    body: response.body,
  }
}

module.exports = {
  readAzureTtsConfig,
  synthesizeSpeech,
}
