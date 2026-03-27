window.booklogReaderLogic = (function () {
  var readerConfig = window.booklogReaderConfig || {}
  var readerUrl = String(readerConfig.readerUrl || '')
  var bookId = String(readerConfig.bookId || '')
  var readerCacheKey = String(readerConfig.readerCacheKey || '')
  var readAloudConfig = readerConfig.readAloud || {}
  var preferredReadAloudMode = String(readAloudConfig.preferredMode || 'local') === 'cloud' ? 'cloud' : 'local'
  var cloudReadAloudConfigured = !!readAloudConfig.cloudConfigured
  var cloudReadAloudEndpoint = String(readAloudConfig.cloudEndpoint || '')
  var cloudReadAloudVoiceOptions = normalizeCloudReadAloudVoices(
    readAloudConfig.cloudVoices,
    String(readAloudConfig.cloudVoiceName || 'ko-KR-SunHiNeural').trim() || 'ko-KR-SunHiNeural',
    String(readAloudConfig.cloudVoiceLabel || 'Azure 한국어 음성').trim() || 'Azure 한국어 음성'
  )
  var cloudReadAloudVoiceName =
    String(readAloudConfig.cloudVoiceName || (cloudReadAloudVoiceOptions[0] ? cloudReadAloudVoiceOptions[0].name : 'ko-KR-SunHiNeural')).trim() ||
    'ko-KR-SunHiNeural'
  var bookInstance = null
  var renditionInstance = null
  var tocLabelByHref = {}
  var currentLocation = null
  var readerContainer = null
  var autoPagingTarget = null
  var autoPagingInFlight = false
  var settlingUntil = 0
  var autoPagingCheckFrameId = 0
  var pendingAutoPagingDirection = ''
  var intentDirection = ''
  var intentStartedAt = 0
  var releaseRequired = false
  var releaseDirection = ''
  var pendingTransitionSnapshot = null
  var boundAutoPagingTarget = null
  var boundAutoPagingHandler = null
  var lastContainerScrollTop = 0
  var EDGE_TRIGGER_DISTANCE = 32
  var EDGE_RELEASE_DISTANCE = 96
  var EDGE_INTENT_MS = 140
  var AUTO_PAGE_SETTLE_MS = 520
  var AUTO_SAVE_INTERVAL_MS = 5000
  var NAVIGATION_SAVE_WAIT_MS = 2000
  var READER_CACHE_DB_NAME = 'booklog-reader-cache'
  var READER_CACHE_STORE_NAME = 'epubBuffers'
  var READER_CACHE_LIMIT = 3
  var autoSaveTimerId = null
  var autoSaveInFlight = false
  var saveRequestInFlight = false
  var activePersistRequest = null
  var isRestoringPosition = false
  var hasAttemptedInitialRestore = false
  var lastPersistedProgressKey = ''
  var speechSynthesisInstance = null
  var speechVoices = []
  var speechVoiceSyncHandler = null
  var speechQueue = []
  var speechQueueIndex = 0
  var speechCurrentUtterance = null
  var speechCurrentAudio = null
  var speechCurrentComponent = null
  var speechCurrentMode = ''
  var speechCloudAudioByIndex = {}
  var speechRestartTimerId = null
  var speechActiveToken = 0
  var renderedContentEntries = []
  var activeReadAloudHighlight = null
  var activeComponent = null
  var isLeavingPage = false
  var isHandlingHistoryBack = false
  var skipNextPopState = false
  var CLOUD_READ_ALOUD_MAX_CHARS = 720
  var CLOUD_READ_ALOUD_MAX_ITEMS = 10
  var CLOUD_READ_ALOUD_SHORT_PREFETCH_CHARS = 220
  var CLOUD_READ_ALOUD_SHORT_PREFETCH_MS = 7600
  var CLOUD_READ_ALOUD_MAX_PREFETCH_COUNT = 2
  var CLOUD_READ_ALOUD_MIN_BREAK_MS = 30
  var CLOUD_READ_ALOUD_MAX_BREAK_MS = 220
  var READ_ALOUD_LONG_SENTENCE_CHARS = 120
  var READ_ALOUD_MAX_SENTENCE_CHARS = 180
  var READ_ALOUD_MIN_CLAUSE_CHARS = 42
  var READ_ALOUD_ALIAS_BY_TERM = {
    AI: '에이아이',
    'Alpine.js': '알파인 제이에스',
    Amazon: '아마존',
    Android: '안드로이드',
    API: '에이피아이',
    Apple: '애플',
    AWS: '에이더블유에스',
    B2B: '비투비',
    B2C: '비투씨',
    ChatGPT: '챗지피티',
    CS: '씨에스',
    CEO: '씨이오',
    CFO: '씨에프오',
    CIO: '씨아이오',
    CMO: '씨엠오',
    COO: '씨오오',
    CPU: '씨피유',
    CSS: '씨에스에스',
    CTO: '씨티오',
    DB: '디비',
    DNA: '디엔에이',
    EPUB: '이펍',
    FAQ: '에프에이큐',
    GitHub: '깃허브',
    Google: '구글',
    GPU: '지피유',
    GPT: '지피티',
    'GPT-4': '지피티 포',
    'GPT-5': '지피티 파이브',
    HTML: '에이치티엠엘',
    HTMX: '에이치티엠엑스',
    HTTP: '에이치티티피',
    HTTPS: '에이치티티피에스',
    iOS: '아이오에스',
    iPad: '아이패드',
    iPhone: '아이폰',
    ISBN: '아이에스비엔',
    IT: '아이티',
    JavaScript: '자바스크립트',
    JSON: '제이슨',
    JWT: '제이더블유티',
    Kindle: '킨들',
    LLM: '엘엘엠',
    MBA: '엠비에이',
    MBTI: '엠비티아이',
    macOS: '맥오에스',
    Meta: '메타',
    Microsoft: '마이크로소프트',
    Netflix: '넷플릭스',
    Notion: '노션',
    OpenAI: '오픈에이아이',
    PDF: '피디에프',
    PocketBase: '포켓베이스',
    PocketPages: '포켓페이지스',
    SaaS: '사스',
    SEO: '에스이오',
    SNS: '에스엔에스',
    SQL: '에스큐엘',
    SSML: '에스에스엠엘',
    TailwindCSS: '테일윈드 씨에스에스',
    Tesla: '테슬라',
    TTS: '티티에스',
    TypeScript: '타입스크립트',
    UI: '유아이',
    UnoCSS: '우노 씨에스에스',
    URL: '유알엘',
    USB: '유에스비',
    UX: '유엑스',
    VPN: '브이피엔',
    'Wi-Fi': '와이파이',
    Windows: '윈도우즈',
    YouTube: '유튜브',
  }
  var READ_ALOUD_UNIT_ALIAS_BY_TERM = {
    '°C': '도',
    TB: '테라바이트',
    GB: '기가바이트',
    MB: '메가바이트',
    KB: '킬로바이트',
    GHz: '기가헤르츠',
    MHz: '메가헤르츠',
    kHz: '킬로헤르츠',
    Hz: '헤르츠',
    kg: '킬로그램',
    mg: '밀리그램',
    g: '그램',
    km: '킬로미터',
    cm: '센티미터',
    mm: '밀리미터',
    m: '미터',
    mL: '밀리리터',
    L: '리터',
  }
  var READ_ALOUD_ALIAS_TERMS = Object.keys(READ_ALOUD_ALIAS_BY_TERM).sort(function (left, right) {
    return right.length - left.length
  })

  function normalizeText(value) {
    return String(value || '')
      .replace(/\.{3,}/g, '…')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function normalizeCloudReadAloudVoices(rawVoices, fallbackVoiceName, fallbackVoiceLabel) {
    var normalizedVoices = []
    var seenVoiceNames = {}
    var fallbackName = String(fallbackVoiceName || 'ko-KR-SunHiNeural').trim() || 'ko-KR-SunHiNeural'
    var fallbackLabel = String(fallbackVoiceLabel || 'Azure 한국어 음성').trim() || 'Azure 한국어 음성'
    var defaultAssigned = false

    ;(Array.isArray(rawVoices) ? rawVoices : []).forEach(function (voice) {
      var voiceName = String(voice && voice.name ? voice.name : '').trim()
      var voiceLang = String(voice && voice.lang ? voice.lang : 'ko-KR').trim() || 'ko-KR'
      var voiceLabel = normalizeText(voice && voice.label ? voice.label : '')
      var isDefaultVoice = !!(voice && voice.defaultVoice)

      if (!voiceName || seenVoiceNames[voiceName]) {
        return
      }

      seenVoiceNames[voiceName] = true

      if (isDefaultVoice) {
        defaultAssigned = true
      }

      normalizedVoices.push({
        name: voiceName,
        lang: voiceLang,
        label: voiceLabel || voiceName,
        defaultVoice: isDefaultVoice,
      })
    })

    if (!normalizedVoices.length) {
      return [
        {
          name: fallbackName,
          lang: 'ko-KR',
          label: fallbackLabel,
          defaultVoice: true,
        },
      ]
    }

    if (!defaultAssigned) {
      normalizedVoices[0].defaultVoice = true
    }

    return normalizedVoices
  }

  function escapeXml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  function classifyReadAloudPauseKey(boundaryChar, isHeading) {
    if (boundaryChar === '…') {
      return 'ellipsis'
    }

    if (boundaryChar === '?') {
      return 'question'
    }

    if (boundaryChar === '!') {
      return 'exclamation'
    }

    if (boundaryChar === ',') {
      return 'comma'
    }

    if (boundaryChar === ':' || boundaryChar === ';') {
      return 'colon'
    }

    if (boundaryChar === 'space') {
      return 'space'
    }

    if (boundaryChar === '.' || boundaryChar === '。') {
      return 'sentence'
    }

    return isHeading ? 'heading' : 'plain'
  }

  function getReadAloudPauseMs(pauseKey) {
    if (pauseKey === 'ellipsis') {
      return 360
    }

    if (pauseKey === 'question' || pauseKey === 'exclamation') {
      return 280
    }

    if (pauseKey === 'sentence') {
      return 100
    }

    if (pauseKey === 'colon') {
      return 95
    }

    if (pauseKey === 'comma') {
      return 60
    }

    if (pauseKey === 'space') {
      return 35
    }

    if (pauseKey === 'heading') {
      return 400
    }

    return 130
  }

  function isReadAloudSentenceBoundaryChar(value) {
    return '.!?…！？。'.indexOf(String(value || '')) >= 0
  }

  function isReadAloudTrailingBoundaryChar(value) {
    return '\'"”’)]}」』】〉》'.indexOf(String(value || '')) >= 0
  }

  function splitReadAloudSentenceBlocks(text) {
    var normalized = normalizeText(text)
    var blocks = []
    var buffer = ''
    var index = 0
    var currentChar = ''
    var nextChar = ''

    if (!normalized) {
      return blocks
    }

    while (index < normalized.length) {
      currentChar = normalized.charAt(index)
      buffer += currentChar

      if (isReadAloudSentenceBoundaryChar(currentChar)) {
        while (index + 1 < normalized.length) {
          nextChar = normalized.charAt(index + 1)

          if (!isReadAloudTrailingBoundaryChar(nextChar)) {
            break
          }

          index += 1
          buffer += nextChar
        }

        blocks.push({
          text: normalizeText(buffer),
          boundaryChar: currentChar,
        })
        buffer = ''
      }

      index += 1
    }

    if (normalizeText(buffer)) {
      blocks.push({
        text: normalizeText(buffer),
        boundaryChar: '',
      })
    }

    return blocks
  }

  function splitReadAloudBlockByClauses(block) {
    var text = normalizeText(block && block.text ? block.text : '')
    var chunks = []
    var buffer = ''
    var index = 0
    var currentChar = ''

    if (!text) {
      return chunks
    }

    if (text.length <= READ_ALOUD_LONG_SENTENCE_CHARS) {
      return [
        {
          text: text,
          boundaryChar: block && block.boundaryChar ? block.boundaryChar : '',
        },
      ]
    }

    while (index < text.length) {
      currentChar = text.charAt(index)
      buffer += currentChar

      if (',:;'.indexOf(currentChar) >= 0 && normalizeText(buffer).length >= READ_ALOUD_MIN_CLAUSE_CHARS) {
        chunks.push({
          text: normalizeText(buffer),
          boundaryChar: currentChar,
        })
        buffer = ''
      }

      index += 1
    }

    if (normalizeText(buffer)) {
      chunks.push({
        text: normalizeText(buffer),
        boundaryChar: block && block.boundaryChar ? block.boundaryChar : '',
      })
    }

    if (chunks.length <= 1) {
      return [
        {
          text: text,
          boundaryChar: block && block.boundaryChar ? block.boundaryChar : '',
        },
      ]
    }

    return chunks
  }

  function splitReadAloudBlockByLength(block) {
    var text = normalizeText(block && block.text ? block.text : '')
    var chunks = []
    var remaining = text
    var splitIndex = -1
    var chunkText = ''

    if (!text) {
      return chunks
    }

    while (remaining.length > READ_ALOUD_MAX_SENTENCE_CHARS) {
      splitIndex = remaining.lastIndexOf(' ', READ_ALOUD_MAX_SENTENCE_CHARS)

      if (splitIndex < Math.floor(READ_ALOUD_MAX_SENTENCE_CHARS * 0.55)) {
        splitIndex = remaining.indexOf(' ', READ_ALOUD_MAX_SENTENCE_CHARS)
      }

      if (splitIndex < 0) {
        break
      }

      chunkText = normalizeText(remaining.slice(0, splitIndex))

      if (!chunkText) {
        break
      }

      chunks.push({
        text: chunkText,
        boundaryChar: 'space',
      })
      remaining = normalizeText(remaining.slice(splitIndex + 1))
    }

    if (remaining) {
      chunks.push({
        text: remaining,
        boundaryChar: block && block.boundaryChar ? block.boundaryChar : '',
      })
    }

    if (!chunks.length) {
      chunks.push({
        text: text,
        boundaryChar: block && block.boundaryChar ? block.boundaryChar : '',
      })
    }

    return chunks
  }

  /**
   * 한국어 읽어주기용 문장 단위를 만듭니다.
   * @param {{ text?: string, cfi?: string, href?: string, sourceIndexes?: Array<number>, sourceIndex?: number, tagName?: string }} queueItem 원본 읽기 항목입니다.
   * @returns {Array<{ text: string, spokenText: string, pauseAfterMs: number, ssmlText: string, cfi: string, href: string, sourceIndexes: Array<number>, sourceIndex: number, tagName: string }>} 분석된 읽기 단위 목록입니다.
   */
  function buildReadAloudUnitsForQueueItem(queueItem) {
    var text = normalizeText(queueItem && queueItem.text ? queueItem.text : '')
    var isHeading = /^h[1-6]$/.test(String(queueItem && queueItem.tagName ? queueItem.tagName : '').toLowerCase())
    var sentenceBlocks = splitReadAloudSentenceBlocks(text)
    var clauseBlocks = []
    var finalBlocks = []
    var units = []

    if (!text) {
      return units
    }

    if (!sentenceBlocks.length) {
      sentenceBlocks = [
        {
          text: text,
          boundaryChar: '',
        },
      ]
    }

    sentenceBlocks.forEach(function (sentenceBlock) {
      splitReadAloudBlockByClauses(sentenceBlock).forEach(function (clauseBlock) {
        splitReadAloudBlockByLength(clauseBlock).forEach(function (lengthBlock) {
          finalBlocks.push(lengthBlock)
        })
      })
    })

    clauseBlocks = finalBlocks.length ? finalBlocks : sentenceBlocks

    clauseBlocks.forEach(function (block) {
      var pauseKey = classifyReadAloudPauseKey(block && block.boundaryChar ? block.boundaryChar : '', isHeading)
      var blockText = normalizeText(block && block.text ? block.text : '')
      var speechForms = null

      if (!blockText) {
        return
      }

      speechForms = buildReadAloudSpeechForms(blockText, {
        isHeading: isHeading,
        isLongSentence: blockText.length >= READ_ALOUD_LONG_SENTENCE_CHARS,
      })

      units.push({
        text: blockText,
        spokenText: speechForms.spokenText || blockText,
        pauseAfterMs: getReadAloudPauseMs(pauseKey),
        ssmlText: speechForms.ssmlText || '<s>' + escapeXml(blockText) + '</s>',
        cfi: queueItem && queueItem.cfi ? queueItem.cfi : '',
        href: queueItem && queueItem.href ? queueItem.href : '',
        sourceIndexes: Array.isArray(queueItem && queueItem.sourceIndexes) ? queueItem.sourceIndexes.slice() : [],
        sourceIndex: queueItem && typeof queueItem.sourceIndex === 'number' ? queueItem.sourceIndex : -1,
        tagName: String(queueItem && queueItem.tagName ? queueItem.tagName : '').toLowerCase(),
      })
    })

    return units
  }

  function estimateReadAloudSpeechMs(text) {
    var normalizedText = normalizeText(text)
    var charCount = normalizedText.length

    if (!charCount) {
      return 0
    }

    return Math.max(1400, Math.round(charCount * 42))
  }

  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function buildReadAloudAliasPattern() {
    if (!READ_ALOUD_ALIAS_TERMS.length) {
      return null
    }

    return new RegExp('\\b(?:' + READ_ALOUD_ALIAS_TERMS.map(escapeRegex).join('|') + ')\\b', 'g')
  }

  var READ_ALOUD_ALIAS_PATTERN = buildReadAloudAliasPattern()

  function normalizeReadAloudNumberToken(value) {
    return String(value || '')
      .replace(/,/g, '')
      .trim()
  }

  function normalizeReadAloudUnitToken(value) {
    var normalizedUnit = String(value || '').trim()
    var lowerUnit = normalizedUnit.toLowerCase()

    if (normalizedUnit === '℃' || lowerUnit === '°c') {
      return '°C'
    }

    if (lowerUnit === 'tb') {
      return 'TB'
    }

    if (lowerUnit === 'gb') {
      return 'GB'
    }

    if (lowerUnit === 'mb') {
      return 'MB'
    }

    if (lowerUnit === 'kb') {
      return 'KB'
    }

    if (lowerUnit === 'ghz') {
      return 'GHz'
    }

    if (lowerUnit === 'mhz') {
      return 'MHz'
    }

    if (lowerUnit === 'khz') {
      return 'kHz'
    }

    if (lowerUnit === 'hz') {
      return 'Hz'
    }

    if (lowerUnit === 'kg') {
      return 'kg'
    }

    if (lowerUnit === 'mg') {
      return 'mg'
    }

    if (lowerUnit === 'g') {
      return 'g'
    }

    if (lowerUnit === 'km') {
      return 'km'
    }

    if (lowerUnit === 'cm') {
      return 'cm'
    }

    if (lowerUnit === 'mm') {
      return 'mm'
    }

    if (lowerUnit === 'ml') {
      return 'mL'
    }

    if (lowerUnit === 'l') {
      return 'L'
    }

    if (lowerUnit === 'm') {
      return 'm'
    }

    return normalizedUnit
  }

  function createReadAloudAliasSegment(originalText, aliasText) {
    var normalizedAliasText = normalizeText(aliasText)

    if (!normalizedAliasText) {
      return null
    }

    return {
      spokenText: normalizedAliasText,
      ssmlText: '<sub alias="' + escapeXml(normalizedAliasText) + '">' + escapeXml(originalText) + '</sub>',
    }
  }

  function buildReadAloudSayAsSegment(match) {
    var value = String(match || '')
    var fullDateMatch = value.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/)
    var monthDayMatch = value.match(/^(\d{1,2})월\s*(\d{1,2})일$/)
    var meridiemTimeMatch = value.match(/^(오전|오후)\s*(\d{1,2}):(\d{2})$/)
    var percentMatch = value.match(/^(-?\d[\d,]*(?:\.\d+)?)%$/)
    var temperatureMatch = value.match(/^(-?\d[\d,]*(?:\.\d+)?)\s?(?:℃|°C)$/i)
    var numberWithUnitMatch = value.match(/^(-?\d[\d,]*(?:\.\d+)?)\s?(TB|GB|MB|KB|GHz|MHz|kHz|Hz|kg|mg|km|cm|mm|ml|mL|g|m|L|l)$/i)
    var dollarMatch = value.match(/^\$\s?(-?\d[\d,]*(?:\.\d+)?)$/)
    var alias = READ_ALOUD_ALIAS_BY_TERM[value] || ''
    var hour = 0
    var meridiem = ''
    var numericValue = ''
    var unitAlias = ''

    if (fullDateMatch) {
      return {
        spokenText: value,
        ssmlText:
          '<say-as interpret-as="date" format="ymd">' +
          fullDateMatch[1] +
          '-' +
          fullDateMatch[2] +
          '-' +
          fullDateMatch[3] +
          '</say-as>',
      }
    }

    if (monthDayMatch) {
      return {
        spokenText: value,
        ssmlText: '<say-as interpret-as="date" format="md">' + monthDayMatch[1] + '-' + monthDayMatch[2] + '</say-as>',
      }
    }

    if (meridiemTimeMatch) {
      hour = Number(meridiemTimeMatch[2] || 0)
      meridiem = meridiemTimeMatch[1] === '오후' ? 'pm' : 'am'

      if (hour === 12) {
        hour = meridiem === 'am' ? 0 : 12
      } else if (meridiem === 'pm') {
        hour += 12
      }

      return {
        spokenText: meridiemTimeMatch[1] + ' ' + meridiemTimeMatch[2] + '시 ' + meridiemTimeMatch[3] + '분',
        ssmlText: '<say-as interpret-as="time" format="hms12">' + String(hour) + ':' + meridiemTimeMatch[3] + meridiem + '</say-as>',
      }
    }

    if (percentMatch) {
      numericValue = normalizeReadAloudNumberToken(percentMatch[1])
      return createReadAloudAliasSegment(value, numericValue + ' 퍼센트')
    }

    if (temperatureMatch) {
      numericValue = normalizeReadAloudNumberToken(temperatureMatch[1])
      return createReadAloudAliasSegment(value, numericValue + READ_ALOUD_UNIT_ALIAS_BY_TERM['°C'])
    }

    if (numberWithUnitMatch) {
      numericValue = normalizeReadAloudNumberToken(numberWithUnitMatch[1])
      unitAlias = READ_ALOUD_UNIT_ALIAS_BY_TERM[normalizeReadAloudUnitToken(numberWithUnitMatch[2])] || ''

      if (unitAlias) {
        return createReadAloudAliasSegment(value, numericValue + ' ' + unitAlias)
      }
    }

    if (dollarMatch) {
      numericValue = normalizeReadAloudNumberToken(dollarMatch[1])
      return createReadAloudAliasSegment(value, numericValue + ' 달러')
    }

    if (alias) {
      return {
        spokenText: alias,
        ssmlText: '<sub alias="' + escapeXml(alias) + '">' + escapeXml(value) + '</sub>',
      }
    }

    return null
  }

  function buildReadAloudSpeechForms(text, options) {
    var normalized = normalizeText(text)
    var pattern =
      /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일|(\d{1,2})월\s*(\d{1,2})일|(오전|오후)\s*(\d{1,2}):(\d{2})|(-?\d[\d,]*(?:\.\d+)?)%|(-?\d[\d,]*(?:\.\d+)?)\s?(?:℃|°C)|(-?\d[\d,]*(?:\.\d+)?)\s?(?:TB|GB|MB|KB|GHz|MHz|kHz|Hz|kg|mg|km|cm|mm|ml|mL|g|m|L|l)|\$\s?-?\d[\d,]*(?:\.\d+)?/gi
    var dynamicPattern = READ_ALOUD_ALIAS_PATTERN
    var combinedMatches = []
    var spokenSegments = []
    var ssmlSegments = []
    var lastIndex = 0
    var match = null
    var transformed = null
    var plainText = ''
    var isHeading = !!(options && options.isHeading)
    var isLongSentence = !!(options && options.isLongSentence)
    var ssmlInner = ''

    while ((match = pattern.exec(normalized))) {
      combinedMatches.push({
        index: match.index,
        text: match[0],
      })
    }

    if (dynamicPattern) {
      while ((match = dynamicPattern.exec(normalized))) {
        combinedMatches.push({
          index: match.index,
          text: match[0],
        })
      }
      dynamicPattern.lastIndex = 0
    }

    combinedMatches.sort(function (left, right) {
      if (left.index === right.index) {
        return right.text.length - left.text.length
      }

      return left.index - right.index
    })

    combinedMatches = combinedMatches.filter(function (entry, index) {
      var previous = index > 0 ? combinedMatches[index - 1] : null

      if (!previous) {
        return true
      }

      return entry.index >= previous.index + previous.text.length
    })

    combinedMatches.forEach(function (entry) {
      if (entry.index > lastIndex) {
        plainText = normalized.slice(lastIndex, entry.index)
        spokenSegments.push(plainText)
        ssmlSegments.push(escapeXml(plainText))
      }

      transformed = buildReadAloudSayAsSegment(entry.text)

      if (!transformed) {
        spokenSegments.push(entry.text)
        ssmlSegments.push(escapeXml(entry.text))
      } else {
        spokenSegments.push(transformed.spokenText)
        ssmlSegments.push(transformed.ssmlText)
      }

      lastIndex = entry.index + entry.text.length
    })

    if (lastIndex < normalized.length) {
      plainText = normalized.slice(lastIndex)
      spokenSegments.push(plainText)
      ssmlSegments.push(escapeXml(plainText))
    }

    ssmlInner = ssmlSegments.join('')

    if (isHeading) {
      ssmlInner = '<prosody rate="-8%">' + ssmlInner + '</prosody>'
    } else if (isLongSentence) {
      ssmlInner = '<prosody rate="-4%">' + ssmlInner + '</prosody>'
    }

    return {
      spokenText: normalizeText(spokenSegments.join('')),
      ssmlText: '<s>' + ssmlInner + '</s>',
    }
  }

  function normalizeHref(value) {
    var href = String(value || '').trim()

    if (!href) {
      return ''
    }

    return href.split('#')[0]
  }

  function clearReadAloudHighlight() {
    var nodes = activeReadAloudHighlight && Array.isArray(activeReadAloudHighlight.nodes) ? activeReadAloudHighlight.nodes : []
    var className = activeReadAloudHighlight && activeReadAloudHighlight.className ? activeReadAloudHighlight.className : ''

    if (!nodes.length || !className) {
      activeReadAloudHighlight = null
      return
    }

    try {
      nodes.forEach(function (node) {
        if (!node || !node.classList) {
          return
        }

        node.classList.remove(className)
      })
    } catch (exception) {}

    activeReadAloudHighlight = null
  }

  function revokeCloudAudioEntry(entry) {
    if (!entry || !entry.objectUrl || !window.URL || typeof window.URL.revokeObjectURL !== 'function') {
      return
    }

    try {
      window.URL.revokeObjectURL(entry.objectUrl)
    } catch (exception) {}

    entry.objectUrl = ''
  }

  function clearCloudAudioCache() {
    Object.keys(speechCloudAudioByIndex).forEach(function (key) {
      revokeCloudAudioEntry(speechCloudAudioByIndex[key])
    })

    speechCloudAudioByIndex = {}
  }

  function stopCloudAudioPlayback(options) {
    var keepCache = !!(options && options.keepCache)

    if (speechCurrentAudio) {
      try {
        speechCurrentAudio.pause()
      } catch (exception) {}

      try {
        speechCurrentAudio.removeAttribute('src')
        speechCurrentAudio.load()
      } catch (exception) {}
    }

    speechCurrentAudio = null

    if (!keepCache) {
      clearCloudAudioCache()
    }
  }

  function deriveRenderedContentHref(contents, doc) {
    var candidates = [
      contents && contents.section && contents.section.href ? contents.section.href : '',
      contents && contents.href ? contents.href : '',
      doc && doc.documentElement ? doc.documentElement.getAttribute('data-booklog-href') : '',
    ]
    var index = 0
    var normalizedHref = ''

    for (index = 0; index < candidates.length; index += 1) {
      normalizedHref = normalizeHref(candidates[index])

      if (normalizedHref) {
        return normalizedHref
      }
    }

    return ''
  }

  function pruneRenderedContentEntries() {
    renderedContentEntries = renderedContentEntries.filter(function (entry) {
      var doc = entry && entry.document ? entry.document : null
      var win = doc && doc.defaultView ? doc.defaultView : null
      var frame = win && win.frameElement ? win.frameElement : null

      return !!doc && !!frame && frame.isConnected
    })
  }

  function upsertRenderedContentEntry(contents) {
    var doc = contents && contents.document ? contents.document : null
    var href = deriveRenderedContentHref(contents, doc)
    var existingIndex = -1

    if (!doc) {
      return
    }

    if (doc.documentElement && href) {
      doc.documentElement.setAttribute('data-booklog-href', href)
    }

    pruneRenderedContentEntries()
    existingIndex = renderedContentEntries.findIndex(function (entry) {
      return entry && entry.document === doc
    })

    if (existingIndex >= 0) {
      renderedContentEntries[existingIndex] = {
        href: href,
        document: doc,
      }
      return
    }

    renderedContentEntries.push({
      href: href,
      document: doc,
    })
  }

  function getRenderedContentEntryByHref(href) {
    var normalizedHref = normalizeHref(href)

    pruneRenderedContentEntries()

    return (
      renderedContentEntries.find(function (entry) {
        return entry && entry.href && entry.href === normalizedHref
      }) || null
    )
  }

  function getRenderedContentEntries() {
    pruneRenderedContentEntries()
    return renderedContentEntries.slice()
  }

  function parseHrefParts(value) {
    var href = String(value || '').trim()
    var hashIndex = -1

    if (!href) {
      return {
        href: '',
        bind: '',
        fragment: '',
      }
    }

    hashIndex = href.indexOf('#')

    return {
      href: href,
      bind: hashIndex >= 0 ? href.slice(0, hashIndex) : href,
      fragment: hashIndex >= 0 ? href.slice(hashIndex + 1) : '',
    }
  }

  function clearSpeechRestartTimer() {
    if (!speechRestartTimerId) {
      return
    }

    clearTimeout(speechRestartTimerId)
    speechRestartTimerId = null
  }

  function resetReadAloudState(component, options) {
    var keepMessage = !!(options && options.keepMessage)

    clearSpeechRestartTimer()
    clearReadAloudHighlight()
    stopCloudAudioPlayback()
    speechQueue = []
    speechQueueIndex = 0
    speechCurrentUtterance = null
    speechCurrentMode = ''
    speechCurrentComponent = component || speechCurrentComponent

    if (!component) {
      return
    }

    component.readAloudBusy = false
    component.readAloudPlaying = false

    if (!keepMessage) {
      component.readAloudMessage = ''
    }
  }

  function stopSpeechPlayback(component, options) {
    var shouldKeepMessage = !!(options && options.keepMessage)

    clearSpeechRestartTimer()
    speechActiveToken += 1

    if (speechSynthesisInstance) {
      try {
        speechSynthesisInstance.cancel()
      } catch (exception) {}
    }

    resetReadAloudState(component || speechCurrentComponent, {
      keepMessage: shouldKeepMessage,
    })
  }

  function getSpeechSynthesisInstance() {
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance === 'undefined') {
      return null
    }

    if (!speechSynthesisInstance) {
      speechSynthesisInstance = window.speechSynthesis
    }

    return speechSynthesisInstance
  }

  function isKoreanVoice(voice) {
    var lang = String(voice && voice.lang ? voice.lang : '').toLowerCase()
    var name = String(voice && voice.name ? voice.name : '').toLowerCase()

    return lang.indexOf('ko') === 0 || name.indexOf('korean') >= 0 || name.indexOf('한국') >= 0 || name.indexOf('ko-kr') >= 0
  }

  /**
   * 기기 한국어 음성 목록을 읽습니다.
   * @returns {Array<any>} 사용할 수 있는 한국어 음성 목록입니다.
   */
  function listLocalSpeechVoices() {
    var synth = getSpeechSynthesisInstance()
    var voices = []

    if (!synth) {
      speechVoices = []
      return speechVoices
    }

    try {
      voices = synth.getVoices ? synth.getVoices() : []
    } catch (exception) {
      voices = []
    }

    speechVoices = voices.filter(isKoreanVoice)
    return speechVoices
  }

  function normalizeReadAloudRate(value) {
    var parsed = Number(value)

    if (!isFinite(parsed)) {
      return 1
    }

    return Math.max(0.8, Math.min(1.6, parsed))
  }

  function syncLocalSpeechVoices(component) {
    var synth = getSpeechSynthesisInstance()
    var localVoices = listLocalSpeechVoices()

    if (!component) {
      return
    }

    component.readAloudSupported = !!synth

    if (!synth) {
      component.readAloudVoices = []
      component.readAloudVoiceName = ''
      return
    }

    component.readAloudVoices = localVoices.map(function (voice) {
      return {
        name: String(voice.name || ''),
        lang: String(voice.lang || ''),
        label: normalizeText(String(voice.name || '') + ' (' + String(voice.lang || '') + ')'),
        defaultVoice: !!voice.default,
      }
    })

    if (!component.readAloudVoices.length) {
      component.readAloudVoiceName = ''
      return
    }

    if (
      component.readAloudVoiceName &&
      component.readAloudVoices.some(function (voice) {
        return voice.name === component.readAloudVoiceName
      })
    ) {
      return
    }

    component.readAloudVoiceName = component.readAloudVoices[0].name
  }

  function syncCloudSpeechVoices(component) {
    var isSupported = !!cloudReadAloudConfigured && !!cloudReadAloudEndpoint
    var defaultVoice = null

    if (!component) {
      return
    }

    component.readAloudSupported = isSupported

    if (!isSupported) {
      component.readAloudVoices = []
      component.readAloudVoiceName = ''
      return
    }

    component.readAloudVoices = cloudReadAloudVoiceOptions.map(function (voice) {
      return {
        name: String(voice && voice.name ? voice.name : ''),
        lang: String(voice && voice.lang ? voice.lang : 'ko-KR'),
        label: normalizeText(voice && voice.label ? voice.label : ''),
        defaultVoice: !!(voice && voice.defaultVoice),
      }
    })

    if (!component.readAloudVoices.length) {
      component.readAloudVoiceName = ''
      return
    }

    if (
      component.readAloudVoiceName &&
      component.readAloudVoices.some(function (voice) {
        return voice.name === component.readAloudVoiceName
      })
    ) {
      return
    }

    defaultVoice =
      component.readAloudVoices.find(function (voice) {
        return !!voice.defaultVoice
      }) || component.readAloudVoices[0]

    component.readAloudVoiceName = defaultVoice ? defaultVoice.name : cloudReadAloudVoiceName
  }

  function switchReadAloudMode(component, mode) {
    if (!component) {
      return
    }

    component.readAloudMode = mode === 'cloud' ? 'cloud' : 'local'
    component.readAloudModeLabel = component.readAloudMode === 'cloud' ? '클라우드 음성' : '기기 음성'

    if (component.readAloudMode === 'cloud') {
      syncCloudSpeechVoices(component)
      return
    }

    syncLocalSpeechVoices(component)
  }

  /**
   * 읽어주기에서 사용할 음성 목록을 동기화합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @returns {void}
   */
  function syncSpeechVoices(component) {
    listLocalSpeechVoices()

    if (!component) {
      return
    }

    if (preferredReadAloudMode === 'cloud' && cloudReadAloudConfigured && cloudReadAloudEndpoint) {
      switchReadAloudMode(component, 'cloud')
      return
    }

    if (getSpeechSynthesisInstance()) {
      switchReadAloudMode(component, 'local')
      return
    }

    component.readAloudMode = preferredReadAloudMode
    component.readAloudModeLabel = preferredReadAloudMode === 'cloud' ? '클라우드 음성' : '기기 음성'
    component.readAloudSupported = false
    component.readAloudVoices = []
    component.readAloudVoiceName = ''
  }

  function getReadAloudMode(component) {
    return component && component.readAloudMode === 'cloud' ? 'cloud' : 'local'
  }

  function findSelectedVoice(component) {
    var targetName = component && component.readAloudVoiceName ? String(component.readAloudVoiceName) : ''

    if (!speechVoices.length) {
      return null
    }

    if (targetName) {
      return (
        speechVoices.find(function (voice) {
          return String(voice.name || '') === targetName
        }) || null
      )
    }

    return speechVoices[0]
  }

  function collectReadableTextNodes(root) {
    var selector = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre'
    var nodes = []
    var matchedNodes = null
    var index = 0

    if (!root || !root.querySelectorAll) {
      return nodes
    }

    matchedNodes = root.querySelectorAll(selector)

    for (index = 0; index < matchedNodes.length; index += 1) {
      nodes.push(matchedNodes[index])
    }

    return nodes
  }

  function annotateReadableTextNodes(root) {
    var nodes = collectReadableTextNodes(root)

    nodes.forEach(function (node, index) {
      if (!node || !node.setAttribute) {
        return
      }

      node.setAttribute('data-booklog-read-aloud-index', String(index))
    })

    return nodes
  }

  function findHighlightTarget(node) {
    var highlightSelector = 'p, li, blockquote'
    var currentNode = node

    if (!currentNode || currentNode.nodeType !== 1) {
      return null
    }

    if (typeof currentNode.matches === 'function' && currentNode.matches(highlightSelector)) {
      return currentNode
    }

    if (typeof currentNode.closest === 'function') {
      return currentNode.closest(highlightSelector) || currentNode
    }

    while (currentNode && currentNode.nodeType === 1) {
      if (typeof currentNode.matches === 'function' && currentNode.matches(highlightSelector)) {
        return currentNode
      }

      currentNode = currentNode.parentElement
    }

    return node
  }

  function buildSpeechQueueFromSection(section, currentCfi) {
    var href = normalizeHref(section && section.href ? section.href : section && section.url ? section.url : '')
    var doc = section && section.document ? section.document : null
    var nodes = collectReadableTextNodes(doc && doc.body ? doc.body : doc)
    var queue = []
    var firstMatchingIndex = -1

    nodes.forEach(function (node, index) {
      var text = normalizeText(node && node.textContent ? node.textContent : '')
      var cfi = ''

      if (!text) {
        return
      }

      if (section && typeof section.cfiFromElement === 'function') {
        try {
          cfi = String(section.cfiFromElement(node) || '')
        } catch (exception) {
          cfi = ''
        }
      }

      if (firstMatchingIndex < 0 && currentCfi && cfi && compareCfi(cfi, currentCfi) >= 0) {
        firstMatchingIndex = queue.length
      }

      queue.push({
        text: text,
        cfi: cfi,
        href: href,
        sourceIndexes: [index],
        sourceIndex: index,
        tagName: String(node && node.tagName ? node.tagName : '').toLowerCase(),
      })
    })

    if (!queue.length) {
      return []
    }

    if (firstMatchingIndex >= 0) {
      return queue.slice(firstMatchingIndex)
    }

    return queue
  }

  function activateReadAloudHighlight(queueItem) {
    var entries = []
    var entry = null
    var doc = null
    var nodes = null
    var matchedNodes = []
    var node = null
    var entryIndex = 0
    var sourceIndexes = queueItem && Array.isArray(queueItem.sourceIndexes) ? queueItem.sourceIndexes : []
    var className = 'booklog-read-aloud-active'

    clearReadAloudHighlight()

    if (!queueItem) {
      return
    }

    entry = getRenderedContentEntryByHref(queueItem.href)

    if (entry) {
      entries.push(entry)
    }

    getRenderedContentEntries().forEach(function (candidateEntry) {
      if (candidateEntry && candidateEntry !== entry) {
        entries.push(candidateEntry)
      }
    })

    for (entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      doc = entries[entryIndex] && entries[entryIndex].document ? entries[entryIndex].document : null

      if (!doc) {
        continue
      }

      nodes = collectReadableTextNodes(doc.body || doc)

      sourceIndexes.forEach(function (sourceIndex) {
        var indexedNode = null

        if (typeof sourceIndex !== 'number' || sourceIndex < 0) {
          return
        }

        indexedNode = nodes[sourceIndex] || null

        if (!indexedNode && doc.querySelector) {
          indexedNode = doc.querySelector('[data-booklog-read-aloud-index="' + String(sourceIndex) + '"]')
        }

        if (indexedNode) {
          matchedNodes.push(indexedNode)
        }
      })

      if (matchedNodes.length) {
        break
      }

      if (typeof queueItem.sourceIndex === 'number' && queueItem.sourceIndex >= 0) {
        node = nodes[queueItem.sourceIndex] || null
      }

      if (node && queueItem.text && normalizeText(node.textContent || '') !== queueItem.text) {
        node = null
      }

      if (!node && queueItem.text) {
        node =
          nodes.find(function (candidate) {
            return normalizeText(candidate && candidate.textContent ? candidate.textContent : '') === queueItem.text
          }) || null
      }

      if (node) {
        matchedNodes.push(node)
        break
      }
    }

    matchedNodes = matchedNodes
      .map(function (matchedNode) {
        return findHighlightTarget(matchedNode)
      })
      .filter(function (matchedNode, index, list) {
        return !!matchedNode && !!matchedNode.classList && list.indexOf(matchedNode) === index
      })

    if (!matchedNodes.length) {
      return
    }

    matchedNodes.forEach(function (matchedNode) {
      matchedNode.classList.add(className)
    })
    activeReadAloudHighlight = {
      nodes: matchedNodes,
      className: className,
    }

    if (typeof matchedNodes[0].scrollIntoView === 'function') {
      matchedNodes[0].scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'smooth',
      })
    }
  }

  function buildCloudSpeechQueue(queue) {
    var groupedQueue = []
    var currentGroup = null
    var itemSsmlText = ''
    var itemPauseAfterMs = 0
    var itemSpokenText = ''
    var previousPauseAfterMs = 0

    ;(queue || []).forEach(function (item) {
      var itemText = normalizeText(item && item.text ? item.text : '')
      var combinedLength = currentGroup ? currentGroup.text.length + 1 + itemText.length : itemText.length
      var shouldStartNewGroup = false

      if (!itemText) {
        return
      }

      if (!currentGroup) {
        shouldStartNewGroup = true
      } else if (currentGroup.items.length >= CLOUD_READ_ALOUD_MAX_ITEMS) {
        shouldStartNewGroup = true
      } else if (combinedLength > CLOUD_READ_ALOUD_MAX_CHARS) {
        shouldStartNewGroup = true
      }

      itemSsmlText = String(item && item.ssmlText ? item.ssmlText : '').trim() || escapeXml(itemText)
      itemPauseAfterMs = Math.max(CLOUD_READ_ALOUD_MIN_BREAK_MS, Math.min(CLOUD_READ_ALOUD_MAX_BREAK_MS, Number(item && item.pauseAfterMs ? item.pauseAfterMs : 0) || 0))
      itemSpokenText = normalizeText(item && item.spokenText ? item.spokenText : itemText)

      if (shouldStartNewGroup) {
        currentGroup = {
          text: itemText,
          spokenText: itemSpokenText,
          ssmlText: itemSsmlText,
          cfi: item && item.cfi ? item.cfi : '',
          href: item && item.href ? item.href : '',
          items: [item],
          estimatedPlaybackMs: estimateReadAloudSpeechMs(itemSpokenText),
          pendingPauseAfterMs: itemPauseAfterMs,
          sourceIndexes: Array.isArray(item && item.sourceIndexes) ? item.sourceIndexes.slice() : [],
        }
        groupedQueue.push(currentGroup)
        return
      }

      previousPauseAfterMs = Math.max(
        CLOUD_READ_ALOUD_MIN_BREAK_MS,
        Math.min(CLOUD_READ_ALOUD_MAX_BREAK_MS, Number(currentGroup && currentGroup.pendingPauseAfterMs ? currentGroup.pendingPauseAfterMs : 0) || 0)
      )
      currentGroup.text += ' ' + itemText
      currentGroup.spokenText += ' ' + itemSpokenText
      currentGroup.ssmlText += (previousPauseAfterMs ? '<break time="' + String(previousPauseAfterMs) + 'ms"/>' : '') + itemSsmlText
      currentGroup.items.push(item)
      currentGroup.estimatedPlaybackMs += previousPauseAfterMs + estimateReadAloudSpeechMs(itemSpokenText)
      currentGroup.pendingPauseAfterMs = itemPauseAfterMs

      if (Array.isArray(item && item.sourceIndexes)) {
        currentGroup.sourceIndexes = currentGroup.sourceIndexes.concat(item.sourceIndexes)
      }
    })

    groupedQueue.forEach(function (group) {
      if (!group || typeof group !== 'object') {
        return
      }

      delete group.pendingPauseAfterMs
    })

    return groupedQueue
  }

  /**
   * 현재 챕터에서 읽어줄 문단 큐를 만듭니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @returns {Promise<Array<{text:string,cfi:string}>>} 읽을 문단 큐
   */
  function buildReadAloudQueue(component) {
    var location = currentLocation && currentLocation.start ? currentLocation.start : null
    var href = normalizeHref(location && location.href ? location.href : '')
    var cfi = location && location.cfi ? String(location.cfi) : ''
    var section = null

    if (!bookInstance || typeof bookInstance.section !== 'function') {
      return Promise.reject(new Error('리더가 아직 준비되지 않았습니다.'))
    }

    if (!href) {
      return Promise.reject(new Error('현재 챕터 위치를 찾지 못했습니다.'))
    }

    try {
      section = bookInstance.section(href)
    } catch (exception) {
      section = null
    }

    if (!section || typeof section.load !== 'function') {
      return Promise.reject(new Error('현재 챕터를 읽어오지 못했습니다.'))
    }

    return Promise.resolve(section.load(bookInstance.load.bind(bookInstance)))
      .then(function () {
        var queue = buildSpeechQueueFromSection(section, cfi)
        var analyzedQueue = []

        if (!queue.length) {
          throw new Error('현재 챕터에서 읽을 문단을 찾지 못했습니다.')
        }

        queue.forEach(function (queueItem) {
          buildReadAloudUnitsForQueueItem(queueItem).forEach(function (unit) {
            analyzedQueue.push(unit)
          })
        })

        if (!analyzedQueue.length) {
          throw new Error('현재 챕터에서 읽을 문장을 찾지 못했습니다.')
        }

        if (getReadAloudMode(component) === 'cloud') {
          return buildCloudSpeechQueue(analyzedQueue)
        }

        return analyzedQueue
      })
      .finally(function () {
        try {
          section.unload()
        } catch (exception) {}
      })
  }

  function parseReadAloudErrorResponse(response) {
    var contentType = response && response.headers ? String(response.headers.get('Content-Type') || '') : ''

    if (!response) {
      return Promise.resolve('클라우드 읽어주기 요청에 실패했습니다.')
    }

    if (contentType.indexOf('application/json') >= 0) {
      return response
        .json()
        .then(function (payload) {
          return String(payload && payload.message ? payload.message : '').trim() || '클라우드 읽어주기 요청에 실패했습니다.'
        })
        .catch(function () {
          return '클라우드 읽어주기 요청에 실패했습니다.'
        })
    }

    return response
      .text()
      .then(function (text) {
        return String(text || '').trim() || '클라우드 읽어주기 요청에 실패했습니다.'
      })
      .catch(function () {
        return '클라우드 읽어주기 요청에 실패했습니다.'
      })
  }

  function requestCloudSpeechAudio(component, queueItem) {
    var formData = new FormData()

    if (!window.URL || typeof window.URL.createObjectURL !== 'function') {
      return Promise.reject(new Error('이 브라우저는 클라우드 읽어주기 오디오 재생을 지원하지 않습니다.'))
    }

    formData.set('text', queueItem && queueItem.spokenText ? queueItem.spokenText : queueItem && queueItem.text ? queueItem.text : '')
    formData.set('ssml', queueItem && queueItem.ssmlText ? queueItem.ssmlText : '')
    formData.set('voiceName', component && component.readAloudVoiceName ? String(component.readAloudVoiceName) : cloudReadAloudVoiceName)
    formData.set('rate', String(normalizeReadAloudRate(component && component.readAloudRate ? component.readAloudRate : 1)))
    formData.set('chapterLabel', component && component.currentChapterLabel ? component.currentChapterLabel : getChapterLabelForHref(queueItem && queueItem.href ? queueItem.href : ''))

    return fetch(cloudReadAloudEndpoint, {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    }).then(function (response) {
      if (!response.ok) {
        return parseReadAloudErrorResponse(response).then(function (message) {
          throw new Error(message)
        })
      }

      return response.blob().then(function (blob) {
        if (!blob || !blob.size) {
          throw new Error('클라우드 읽어주기 오디오가 비어 있습니다.')
        }

        return {
          blob: blob,
          objectUrl: window.URL.createObjectURL(blob),
        }
      })
    })
  }

  function ensureCloudSpeechAudio(component, queueIndex) {
    var queueItem = speechQueue[queueIndex]
    var entry = speechCloudAudioByIndex[queueIndex]

    if (!queueItem) {
      return Promise.reject(new Error('현재 챕터 읽기가 끝났습니다.'))
    }

    if (entry && entry.promise) {
      return entry.promise
    }

    entry = {
      objectUrl: '',
      promise: null,
    }
    speechCloudAudioByIndex[queueIndex] = entry
    entry.promise = requestCloudSpeechAudio(component, queueItem)
      .then(function (result) {
        if (speechCloudAudioByIndex[queueIndex] !== entry) {
          revokeCloudAudioEntry(result)
          return null
        }

        entry.objectUrl = result.objectUrl
        return entry
      })
      .catch(function (exception) {
        if (speechCloudAudioByIndex[queueIndex] === entry) {
          delete speechCloudAudioByIndex[queueIndex]
        }

        throw exception
      })

    return entry.promise
  }

  function estimateCloudQueueItemPlaybackMs(component, queueItem) {
    var rate = normalizeReadAloudRate(component && component.readAloudRate ? component.readAloudRate : 1)
    var basePlaybackMs =
      Number(queueItem && queueItem.estimatedPlaybackMs ? queueItem.estimatedPlaybackMs : 0) ||
      estimateReadAloudSpeechMs(queueItem && queueItem.spokenText ? queueItem.spokenText : queueItem && queueItem.text ? queueItem.text : '')

    if (!basePlaybackMs) {
      return 0
    }

    return Math.round(basePlaybackMs / rate)
  }

  function getCloudPrefetchCount(component, queueIndex) {
    var queueItem = speechQueue[queueIndex]
    var textLength = normalizeText(queueItem && queueItem.text ? queueItem.text : '').length
    var estimatedPlaybackMs = estimateCloudQueueItemPlaybackMs(component, queueItem)
    var unitCount = Array.isArray(queueItem && queueItem.items) ? queueItem.items.length : 1

    if (!queueItem) {
      return 0
    }

    if (estimatedPlaybackMs <= CLOUD_READ_ALOUD_SHORT_PREFETCH_MS || textLength <= CLOUD_READ_ALOUD_SHORT_PREFETCH_CHARS || unitCount <= 2) {
      return CLOUD_READ_ALOUD_MAX_PREFETCH_COUNT
    }

    return 1
  }

  function prefetchCloudSpeechAudio(component, token, queueIndex) {
    var prefetchCount = getCloudPrefetchCount(component, queueIndex)
    var offset = 1
    var nextIndex = 0

    if (token !== speechActiveToken || prefetchCount < 1) {
      return
    }

    for (offset = 1; offset <= prefetchCount; offset += 1) {
      nextIndex = queueIndex + offset

      if (!speechQueue[nextIndex]) {
        break
      }

      ensureCloudSpeechAudio(component, nextIndex).catch(function () {})
    }
  }

  function tryFallbackToLocalSpeech(component, token, message) {
    stopCloudAudioPlayback()
    switchReadAloudMode(component, 'local')

    if (!component.readAloudSupported || !component.readAloudVoices.length) {
      return false
    }

    component.readAloudBusy = true
    component.readAloudPlaying = false
    component.readAloudMessage = message || '클라우드 읽어주기 연결이 불안정해 기기 음성으로 이어서 재생합니다.'
    speakLocalQueueItem(component, token)
    return true
  }

  function playCloudQueueItem(component, token) {
    var currentQueueIndex = speechQueueIndex
    var queueItem = speechQueue[currentQueueIndex]

    if (!component) {
      return
    }

    if (token !== speechActiveToken) {
      return
    }

    if (!queueItem) {
      clearReadAloudHighlight()
      component.readAloudBusy = false
      component.readAloudPlaying = false
      component.readAloudMessage = '현재 챕터 읽기가 끝났습니다.'
      return
    }

    component.readAloudBusy = true
    component.readAloudPlaying = false
    activateReadAloudHighlight(queueItem)

    ensureCloudSpeechAudio(component, currentQueueIndex)
      .then(function (entry) {
        var audio = null

        if (token !== speechActiveToken || !entry || !entry.objectUrl) {
          return
        }

        stopCloudAudioPlayback({
          keepCache: true,
        })
        speechCurrentMode = 'cloud'
        speechCurrentComponent = component
        speechCurrentAudio = new window.Audio(entry.objectUrl)
        audio = speechCurrentAudio
        audio.preload = 'auto'

        audio.onplay = function () {
          if (token !== speechActiveToken) {
            return
          }

          component.readAloudBusy = false
          component.readAloudPlaying = true
          component.readAloudMessage = '현재 챕터를 읽는 중입니다.'
          prefetchCloudSpeechAudio(component, token, currentQueueIndex)
        }

        audio.onended = function () {
          var finishedIndex = currentQueueIndex

          if (token !== speechActiveToken) {
            return
          }

          speechCurrentAudio = null
          revokeCloudAudioEntry(speechCloudAudioByIndex[finishedIndex])
          delete speechCloudAudioByIndex[finishedIndex]
          speechQueueIndex = finishedIndex + 1
          playCloudQueueItem(component, token)
        }

        audio.onerror = function () {
          if (token !== speechActiveToken) {
            return
          }

          if (tryFallbackToLocalSpeech(component, token, '클라우드 읽어주기 연결이 불안정해 기기 음성으로 이어서 재생합니다.')) {
            return
          }

          resetReadAloudState(component, {
            keepMessage: true,
          })
          component.readAloudMessage = '클라우드 읽어주기 재생에 실패했습니다.'
        }

        audio.play().catch(function (exception) {
          if (token !== speechActiveToken) {
            return
          }

          if (tryFallbackToLocalSpeech(component, token, '클라우드 읽어주기 재생에 실패해 기기 음성으로 이어서 재생합니다.')) {
            return
          }

          resetReadAloudState(component, {
            keepMessage: true,
          })
          component.readAloudMessage = String(exception && exception.message ? exception.message : exception)
        })
      })
      .catch(function (exception) {
        if (token !== speechActiveToken) {
          return
        }

        if (tryFallbackToLocalSpeech(component, token, '클라우드 읽어주기 연결이 불안정해 기기 음성으로 이어서 재생합니다.')) {
          return
        }

        resetReadAloudState(component, {
          keepMessage: true,
        })
        component.readAloudMessage = String(exception && exception.message ? exception.message : exception)
      })
  }

  function speakLocalQueueItem(component, token) {
    var synth = getSpeechSynthesisInstance()
    var queueItem = speechQueue[speechQueueIndex]
    var voice = findSelectedVoice(component)
    var utterance = null
    var rate = normalizeReadAloudRate(component && component.readAloudRate ? component.readAloudRate : 1)

    if (!component || !synth) {
      return
    }

    if (token !== speechActiveToken) {
      return
    }

    if (!queueItem) {
      clearReadAloudHighlight()
      component.readAloudBusy = false
      component.readAloudPlaying = false
      component.readAloudMessage = '현재 챕터 읽기가 끝났습니다.'
      return
    }

    utterance = new window.SpeechSynthesisUtterance(queueItem && queueItem.spokenText ? queueItem.spokenText : queueItem.text)
    utterance.lang = voice && voice.lang ? String(voice.lang) : 'ko-KR'
    utterance.rate = rate

    if (voice) {
      utterance.voice = voice
    }

    utterance.onstart = function () {
      if (token !== speechActiveToken) {
        return
      }

      speechCurrentUtterance = utterance
      speechCurrentComponent = component
      speechCurrentMode = 'local'
      component.readAloudBusy = false
      component.readAloudPlaying = true
      activateReadAloudHighlight(queueItem)
      component.readAloudMessage = '현재 챕터를 읽는 중입니다.'
    }

    utterance.onend = function () {
      if (token !== speechActiveToken) {
        return
      }

      speechCurrentUtterance = null
      speechQueueIndex += 1
      clearSpeechRestartTimer()
      speechRestartTimerId = setTimeout(function () {
        speakQueueItem(component, token)
      }, Math.max(40, Number(queueItem && queueItem.pauseAfterMs ? queueItem.pauseAfterMs : 40)))
    }

    utterance.onerror = function (event) {
      if (token !== speechActiveToken) {
        return
      }

      console.error('page/books/[bookId]/read:read-aloud:failed', {
        message: event && event.error ? String(event.error) : 'speech error',
      })
      stopSpeechPlayback(component, { keepMessage: true })
      component.readAloudMessage = '읽어주기 재생에 실패했습니다.'
    }

    synth.speak(utterance)
  }

  function speakQueueItem(component, token) {
    if (getReadAloudMode(component) === 'cloud') {
      playCloudQueueItem(component, token)
      return
    }

    speakLocalQueueItem(component, token)
  }

  function registerTocItems(items) {
    ;(items || []).forEach(function (item) {
      var href = normalizeHref(item && item.href ? item.href : '')
      var label = normalizeText(item && item.label ? item.label : '')

      if (href && label) {
        tocLabelByHref[href] = label
      }

      if (item && item.subitems && item.subitems.length) {
        registerTocItems(item.subitems)
      }
    })
  }

  function getChapterLabelForSection(section) {
    var candidates = [section && section.href ? section.href : '', section && section.url ? section.url : '']
    var i = 0
    var href = ''
    var normalizedHref = ''

    for (i = 0; i < candidates.length; i += 1) {
      href = String(candidates[i] || '').trim()
      normalizedHref = normalizeHref(href)

      if (normalizedHref && tocLabelByHref[normalizedHref]) {
        return tocLabelByHref[normalizedHref]
      }
    }

    return ''
  }

  function getChapterLabelForHref(href) {
    var normalizedHref = normalizeHref(href)

    if (normalizedHref && tocLabelByHref[normalizedHref]) {
      return tocLabelByHref[normalizedHref]
    }

    return ''
  }

  function buildTocTree(items, depth) {
    var currentDepth = typeof depth === 'number' ? depth : 1

    return (items || []).map(function (item) {
      var hrefParts = parseHrefParts(item && item.href ? item.href : '')
      var itemId = item && item.id ? String(item.id) : ''
      var itemHref = hrefParts.href

      return {
        id: itemId,
        key: itemId || itemHref || normalizeText(item && item.label ? item.label : ''),
        href: itemHref,
        bind: hrefParts.bind,
        fragment: hrefParts.fragment,
        cfi: '',
        label: normalizeText(item && item.label ? item.label : '') || '제목 없음',
        subitems: currentDepth < 2 ? buildTocTree(item && item.subitems ? item.subitems : [], currentDepth + 1) : [],
      }
    })
  }

  function flattenTocItems(items, collector) {
    ;(items || []).forEach(function (item) {
      collector.push(item)

      if (item && item.subitems && item.subitems.length) {
        flattenTocItems(item.subitems, collector)
      }
    })
  }

  function compareCfi(left, right) {
    if (!left || !right || !window.ePub || !window.ePub.CFI) {
      return 0
    }

    try {
      return new window.ePub.CFI().compare(String(left), String(right))
    } catch (exception) {
      return 0
    }
  }

  function findActiveTocItem(location, items) {
    var start = location && location.start ? location.start : null
    var currentHref = start && start.href ? String(start.href) : ''
    var currentUrl = start && start.url ? String(start.url) : ''
    var currentBind = normalizeHref(currentHref || currentUrl)
    var currentCfi = start && start.cfi ? String(start.cfi) : ''
    var flatItems = []
    var candidates = []
    var bestItem = null

    flattenTocItems(items, flatItems)
    candidates = flatItems.filter(function (item) {
      return item && item.bind && item.bind === currentBind
    })

    candidates.forEach(function (item) {
      if (!item || !item.cfi || !currentCfi) {
        return
      }

      if (compareCfi(item.cfi, currentCfi) <= 0 && (!bestItem || compareCfi(item.cfi, bestItem.cfi) >= 0)) {
        bestItem = item
      }
    })

    if (bestItem) {
      return bestItem
    }

    return candidates.length ? candidates[0] : null
  }

  function syncActiveTocState(component, location) {
    var activeItem = findActiveTocItem(location, component && component.tocItems ? component.tocItems : [])
    var start = location && location.start ? location.start : null
    var href = start && start.href ? String(start.href) : ''
    var url = start && start.url ? String(start.url) : ''

    component.activeTocKey = activeItem && activeItem.key ? String(activeItem.key) : ''
    component.activeTocHref = normalizeHref(href || url)

    if (activeItem && activeItem.label) {
      component.currentChapterLabel = String(activeItem.label)
      scrollActiveTocItemIntoView(component)
      return
    }

    component.currentChapterLabel = getChapterLabelForHref(href)
    scrollActiveTocItemIntoView(component)
  }

  /**
   * 현재 활성 목차가 패널 안에서 보이도록 스크롤합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @returns {void}
   */
  function scrollActiveTocItemIntoView(component) {
    var activeKey = component && component.activeTocKey ? String(component.activeTocKey) : ''

    if (!component || !component.tocOpen || !activeKey) {
      return
    }

    window.requestAnimationFrame(function () {
      var container = document.getElementById('reader-toc-scroll')
      var selector = '[data-toc-key="' + activeKey.replace(/"/g, '\\"') + '"]'
      var activeButton = container ? container.querySelector(selector) : null

      if (!container || !activeButton || typeof activeButton.scrollIntoView !== 'function') {
        return
      }

      activeButton.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'smooth',
      })
    })
  }

  /**
   * 목차 항목의 실제 문서 위치 CFI를 미리 계산합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @returns {Promise<void>} 계산 완료 promise
   */
  function resolveTocItemCfis(component) {
    var flatItems = []
    var groupedItems = {}
    var bindKeys = []

    if (!bookInstance || typeof bookInstance.section !== 'function') {
      return Promise.resolve()
    }

    flattenTocItems(component && component.tocItems ? component.tocItems : [], flatItems)

    flatItems.forEach(function (item) {
      var bind = item && item.bind ? String(item.bind) : ''

      if (!bind) {
        return
      }

      if (!groupedItems[bind]) {
        groupedItems[bind] = []
        bindKeys.push(bind)
      }

      groupedItems[bind].push(item)
    })

    return Promise.all(
      bindKeys.map(function (bind) {
        var section = null
        var sectionItems = groupedItems[bind] || []

        try {
          section = bookInstance.section(bind)
        } catch (exception) {
          section = null
        }

        if (!section || typeof section.load !== 'function') {
          return Promise.resolve()
        }

        return Promise.resolve(section.load(bookInstance.load.bind(bookInstance)))
          .then(function () {
            var doc = section.document
            var fallbackElement = doc && doc.body ? doc.body : doc && doc.documentElement ? doc.documentElement : null

            sectionItems.forEach(function (item) {
              var targetElement = fallbackElement
              var fragment = item && item.fragment ? String(item.fragment) : ''

              if (doc && fragment) {
                targetElement =
                  doc.getElementById(fragment) || doc.getElementById(decodeURIComponent(fragment)) || doc.querySelector('[name="' + fragment.replace(/"/g, '\\"') + '"]') || fallbackElement
              }

              if (targetElement && typeof section.cfiFromElement === 'function') {
                try {
                  item.cfi = String(section.cfiFromElement(targetElement) || '')
                } catch (exception) {
                  item.cfi = ''
                }
              }
            })
          })
          .catch(function (exception) {
            console.warn('page/books/[bookId]/read:toc-cfi-skip', {
              href: bind,
              message: String(exception && exception.message ? exception.message : exception),
            })
          })
          .finally(function () {
            try {
              section.unload()
            } catch (exception) {}
          })
      })
    ).then(function () {
      if (currentLocation) {
        syncActiveTocState(component, currentLocation)
      }
    })
  }

  /**
   * 컴포넌트에 목차 상태를 반영합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @param {Array<any>} items epub.js 목차 목록
   * @returns {void}
   */
  function syncTocState(component, items) {
    var tocItems = buildTocTree(items, 1)

    component.tocItems = tocItems
    component.tocReady = true
    component.tocMessage = tocItems.length ? '' : '목차 정보가 없습니다.'

    if (tocItems.length) {
      resolveTocItemCfis(component)
    }
  }

  function getPageNumberFromLocation(location) {
    if (!location) {
      return ''
    }

    if (location.displayed && typeof location.displayed.page === 'number') {
      return String(location.displayed.page)
    }

    if (location.start && location.start.displayed && typeof location.start.displayed.page === 'number') {
      return String(location.start.displayed.page)
    }

    return ''
  }

  /**
   * 현재 locator를 읽기 진행률 퍼센트로 바꿉니다.
   * @param {string} locator 현재 위치 CFI
   * @returns {string} 0~100 정수 퍼센트 문자열
   */
  function getProgressPercentFromLocator(locator) {
    var progressPercent = ''

    try {
      if (locator && bookInstance && bookInstance.locations && typeof bookInstance.locations.percentageFromCfi === 'function') {
        progressPercent = String(Math.max(0, Math.min(100, Math.round(bookInstance.locations.percentageFromCfi(locator) * 100))))
      }
    } catch (exception) {
      progressPercent = ''
    }

    return progressPercent
  }

  /**
   * 현재 위치 기준 진행률 표시값을 컴포넌트 상태에 반영합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @returns {void}
   */
  function syncCurrentProgressState(component) {
    var location = currentLocation && currentLocation.start ? currentLocation.start : null
    var locator = location && location.cfi ? String(location.cfi) : ''
    var progressPercent = getProgressPercentFromLocator(locator)

    component.currentProgressPercent = progressPercent

    if (!component.progressJumpEditing) {
      component.progressJumpValue = progressPercent
    }
  }

  /**
   * 입력된 진행률 값을 0~100 범위 정수로 정리합니다.
   * @param {string} value 입력값
   * @returns {number | null} 이동 가능한 진행률 값
   */
  function parseProgressJumpValue(value) {
    var parsed = Number(value)

    if (!isFinite(parsed)) {
      return null
    }

    return Math.max(0, Math.min(100, Math.round(parsed)))
  }

  function updateCurrentLocation(component, location) {
    var target = autoPagingTarget || resolveAutoPagingTarget()

    currentLocation = location || null
    syncActiveTocState(component, currentLocation)

    if (target) {
      autoPagingTarget = target
      lastContainerScrollTop = target.scrollTop || 0
    }

    syncCurrentProgressState(component)
  }

  function buildProgressKey(progress) {
    var locator = progress && progress.locator ? String(progress.locator) : ''
    var href = progress && progress.href ? String(progress.href) : ''
    var pageNumber = progress && progress.pageNumber ? String(progress.pageNumber) : ''

    return [locator, href, pageNumber].join('::')
  }

  function getCurrentProgressPayload(component) {
    var location = currentLocation && currentLocation.start ? currentLocation.start : null
    var locator = location && location.cfi ? String(location.cfi) : ''
    var href = location && location.href ? String(location.href) : ''
    var chapterLabel = component && component.currentChapterLabel ? String(component.currentChapterLabel) : getChapterLabelForHref(href)
    var pageNumber = getPageNumberFromLocation(currentLocation)
    var progressPercent = ''

    if (!locator && renditionInstance && typeof renditionInstance.currentLocation === 'function') {
      updateCurrentLocation(component, renditionInstance.currentLocation())
      location = currentLocation && currentLocation.start ? currentLocation.start : null
      locator = location && location.cfi ? String(location.cfi) : ''
      href = location && location.href ? String(location.href) : ''
      chapterLabel = component && component.currentChapterLabel ? String(component.currentChapterLabel) : getChapterLabelForHref(href)
      pageNumber = getPageNumberFromLocation(currentLocation)
    }

    progressPercent = getProgressPercentFromLocator(locator)

    return {
      locator: locator,
      href: href,
      chapterLabel: chapterLabel,
      pageNumber: pageNumber,
      progressPercent: progressPercent,
    }
  }

  function requestSavedProgress() {
    var formData = new FormData()

    formData.set('bookId', bookId)

    return fetch('/api/books/load-progress', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    })
      .then(function (response) {
        return response
          .json()
          .then(function (payload) {
            return {
              ok: response.ok,
              payload: payload || {},
            }
          })
          .catch(function () {
            return {
              ok: response.ok,
              payload: {},
            }
          })
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(String(result.payload && result.payload.message ? result.payload.message : '읽기 위치를 불러오지 못했습니다.'))
        }

        return result.payload || {}
      })
  }

  function persistProgress(component, options) {
    var progress = getCurrentProgressPayload(component)
    var formData = new FormData()
    var shouldShowMessage = !options || !options.silent
    var progressKey = buildProgressKey(progress)

    if (saveRequestInFlight) {
      if (shouldShowMessage) {
        component.showSavePositionMessage('읽기 위치를 저장하는 중입니다.')
      }

      return activePersistRequest || Promise.resolve(false)
    }

    if (!progress.locator && !progress.href) {
      if (shouldShowMessage) {
        component.showSavePositionMessage('아직 저장할 읽기 위치를 찾지 못했습니다.')
      }

      return Promise.resolve(false)
    }

    if (options && options.skipIfUnchanged && progressKey && progressKey === lastPersistedProgressKey) {
      return Promise.resolve(false)
    }

    formData.set('bookId', bookId)
    formData.set('locator', progress.locator)
    formData.set('href', progress.href)
    formData.set('chapterLabel', progress.chapterLabel)
    formData.set('pageNumber', progress.pageNumber)
    formData.set('progressPercent', progress.progressPercent)
    saveRequestInFlight = true

    activePersistRequest = fetch('/api/books/save-progress', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    })
      .then(function (response) {
        return response
          .json()
          .then(function (payload) {
            return {
              ok: response.ok,
              payload: payload || {},
            }
          })
          .catch(function () {
            return {
              ok: response.ok,
              payload: {},
            }
          })
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(String(result.payload && result.payload.message ? result.payload.message : '읽던 위치 저장에 실패했습니다.'))
        }

        lastPersistedProgressKey = progressKey

        if (shouldShowMessage) {
          component.showSavePositionMessage(String(result.payload && result.payload.message ? result.payload.message : '읽던 위치를 저장했습니다.'))
        }

        return true
      })
      .finally(function () {
        saveRequestInFlight = false
        activePersistRequest = null
      })

    return activePersistRequest
  }

  function waitForProgressSave(component, options) {
    return new Promise(function (resolve) {
      var waitTimerId = setTimeout(function () {
        console.warn('page/books/[bookId]/read:navigation-save-timeout', {
          waitMs: NAVIGATION_SAVE_WAIT_MS,
        })
        resolve(false)
      }, NAVIGATION_SAVE_WAIT_MS)

      persistProgress(component, options)
        .then(function (saved) {
          clearTimeout(waitTimerId)
          resolve(saved)
        })
        .catch(function (exception) {
          clearTimeout(waitTimerId)
          console.warn('page/books/[bookId]/read:navigation-save-failed', {
            message: String(exception && exception.message ? exception.message : exception),
          })
          resolve(false)
        })
    })
  }

  function leavePageWithSavedProgress(component, options) {
    var nextLocation = options && options.nextLocation ? String(options.nextLocation) : ''
    var historyBack = !!(options && options.historyBack)
    var saveOptions =
      options && options.saveOptions
        ? options.saveOptions
        : {
            silent: true,
            skipIfUnchanged: false,
          }

    if (!component || isLeavingPage) {
      return
    }

    isLeavingPage = true

    waitForProgressSave(component, saveOptions).finally(function () {
      if (historyBack) {
        skipNextPopState = true
        window.history.back()
        return
      }

      if (nextLocation) {
        window.location.href = nextLocation
        return
      }

      isLeavingPage = false
    })
  }

  function handlePopState() {
    if (skipNextPopState) {
      skipNextPopState = false
      return
    }

    if (!activeComponent || isHandlingHistoryBack || isLeavingPage) {
      return
    }

    isHandlingHistoryBack = true
    console.debug('page/books/[bookId]/read:history-back-intercepted', {
      bookId: bookId,
    })

    leavePageWithSavedProgress(activeComponent, {
      historyBack: true,
      saveOptions: {
        silent: true,
        skipIfUnchanged: false,
      },
    })

    isHandlingHistoryBack = false
  }

  function restoreSavedPosition(component, options) {
    var shouldShowMessage = !options || !options.silent

    if (!renditionInstance) {
      if (shouldShowMessage) {
        component.showSavePositionMessage('리더가 아직 준비되지 않았습니다.')
      }

      return Promise.resolve(false)
    }

    isRestoringPosition = true
    prepareManualNavigation()

    if (shouldShowMessage) {
      component.showSavePositionMessage('')
    }

    return requestSavedProgress()
      .then(function (payload) {
        var locator = String(payload && payload.locator ? payload.locator : '')
        var href = String(payload && payload.href ? payload.href : '')
        var target = locator || href

        if (!target) {
          throw new Error('저장된 읽기 위치가 없습니다.')
        }

        return Promise.resolve(renditionInstance.display(target))
          .catch(function () {
            if (locator && href) {
              return renditionInstance.display(href)
            }

            throw new Error('저장된 위치로 이동하지 못했습니다.')
          })
          .then(function (location) {
            var progress = null

            component.currentChapterLabel = String(payload && payload.chapterLabel ? payload.chapterLabel : component.currentChapterLabel || '')
            updateCurrentLocation(component, location || renditionInstance.currentLocation())

            progress = getCurrentProgressPayload(component)
            lastPersistedProgressKey = buildProgressKey(progress)

            if (shouldShowMessage) {
              component.showSavePositionMessage(String(payload && payload.message ? payload.message : '저장된 읽기 위치를 불러왔습니다.'))
            }

            return true
          })
      })
      .catch(function (exception) {
        if (shouldShowMessage) {
          component.showSavePositionMessage(String(exception && exception.message ? exception.message : exception))
        } else {
          console.warn('page/books/[bookId]/read:restore-saved-position-skipped', {
            message: String(exception && exception.message ? exception.message : exception),
          })
        }

        return false
      })
      .finally(function () {
        isRestoringPosition = false
      })
  }

  function shouldSkipAutoSave(component) {
    if (!component || component.loading || component.loadingSavedPosition || component.savingPosition) {
      return true
    }

    if (!renditionInstance || !hasAttemptedInitialRestore || isRestoringPosition || autoSaveInFlight) {
      return true
    }

    return false
  }

  function runAutoSave(component) {
    if (shouldSkipAutoSave(component)) {
      return
    }

    autoSaveInFlight = true

    persistProgress(component, {
      silent: true,
      skipIfUnchanged: true,
    })
      .catch(function (exception) {
        console.warn('page/books/[bookId]/read:auto-save:failed', {
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
      .finally(function () {
        autoSaveInFlight = false
      })
  }

  function startAutoSave(component) {
    if (autoSaveTimerId) {
      clearInterval(autoSaveTimerId)
    }

    autoSaveTimerId = setInterval(function () {
      runAutoSave(component)
    }, AUTO_SAVE_INTERVAL_MS)
  }

  function buildSearchResultLabel(result) {
    var chapterLabel = normalizeText(result && result.chapterLabel ? result.chapterLabel : '')
    var excerpt = normalizeText(result && result.excerpt ? result.excerpt : '')

    if (chapterLabel && excerpt) {
      return chapterLabel + ' · ' + excerpt
    }

    return chapterLabel || excerpt || '검색 결과'
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function buildSearchResultLabelHtml(result, query) {
    var label = buildSearchResultLabel(result)
    var normalizedQuery = normalizeText(query)
    var escapedLabel = escapeHtml(label)
    var matcher = null

    if (!normalizedQuery) {
      return escapedLabel
    }

    matcher = new RegExp('(' + escapeRegExp(normalizedQuery) + ')', 'gi')

    return escapedLabel.replace(matcher, '<mark class="bg-transparent font-semibold text-stone-900 underline decoration-[#b68454] decoration-[2px] underline-offset-[0.22em]">$1</mark>')
  }

  function canUseReaderCache() {
    return !!window.indexedDB
  }

  function openReaderCacheDb() {
    return new Promise(function (resolve, reject) {
      var request = null

      if (!canUseReaderCache()) {
        resolve(null)
        return
      }

      request = window.indexedDB.open(READER_CACHE_DB_NAME, 1)

      request.onupgradeneeded = function (event) {
        var db = event.target.result

        if (!db.objectStoreNames.contains(READER_CACHE_STORE_NAME)) {
          db.createObjectStore(READER_CACHE_STORE_NAME, { keyPath: 'cacheKey' })
        }
      }

      request.onsuccess = function () {
        resolve(request.result)
      }

      request.onerror = function () {
        reject(request.error || new Error('IndexedDB를 열지 못했습니다.'))
      }
    })
  }

  function readCachedBookBuffer() {
    return openReaderCacheDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = null
        var store = null
        var request = null

        if (!db) {
          resolve(null)
          return
        }

        transaction = db.transaction(READER_CACHE_STORE_NAME, 'readonly')
        store = transaction.objectStore(READER_CACHE_STORE_NAME)
        request = store.get(readerCacheKey)

        request.onsuccess = function () {
          var cacheEntry = request.result || null

          resolve(cacheEntry && cacheEntry.buffer ? cacheEntry.buffer : null)
        }

        request.onerror = function () {
          reject(request.error || new Error('EPUB 캐시를 읽지 못했습니다.'))
        }
      }).finally(function () {
        db.close()
      })
    })
  }

  function pruneReaderCache(store) {
    return new Promise(function (resolve, reject) {
      var request = store.getAll()

      request.onsuccess = function () {
        var records = request.result || []
        var removable = null
        var pendingDeletes = 0
        var failed = false

        records.sort(function (left, right) {
          return Number(right && right.lastOpenedAt ? right.lastOpenedAt : 0) - Number(left && left.lastOpenedAt ? left.lastOpenedAt : 0)
        })

        removable = records.slice(READER_CACHE_LIMIT)

        if (!removable.length) {
          resolve()
          return
        }

        pendingDeletes = removable.length

        removable.forEach(function (cacheEntry) {
          var deleteRequest = store.delete(cacheEntry.cacheKey)

          deleteRequest.onsuccess = function () {
            pendingDeletes -= 1

            if (!pendingDeletes && !failed) {
              resolve()
            }
          }

          deleteRequest.onerror = function () {
            if (failed) {
              return
            }

            failed = true
            reject(deleteRequest.error || new Error('EPUB 캐시 정리에 실패했습니다.'))
          }
        })
      }

      request.onerror = function () {
        reject(request.error || new Error('EPUB 캐시 목록을 읽지 못했습니다.'))
      }
    })
  }

  function writeCachedBookBuffer(buffer) {
    return openReaderCacheDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = null
        var store = null
        var request = null

        if (!db || !buffer) {
          resolve()
          return
        }

        transaction = db.transaction(READER_CACHE_STORE_NAME, 'readwrite')
        store = transaction.objectStore(READER_CACHE_STORE_NAME)
        request = store.put({
          cacheKey: readerCacheKey,
          buffer: buffer,
          byteLength: Number(buffer.byteLength || 0),
          lastOpenedAt: Date.now(),
        })

        request.onsuccess = function () {
          pruneReaderCache(store)
            .then(function () {
              resolve()
            })
            .catch(function (exception) {
              reject(exception)
            })
        }

        request.onerror = function () {
          reject(request.error || new Error('EPUB 캐시에 저장하지 못했습니다.'))
        }
      }).finally(function () {
        db.close()
      })
    })
  }

  function touchCachedBookBuffer() {
    return openReaderCacheDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = null
        var store = null
        var request = null

        if (!db) {
          resolve()
          return
        }

        transaction = db.transaction(READER_CACHE_STORE_NAME, 'readwrite')
        store = transaction.objectStore(READER_CACHE_STORE_NAME)
        request = store.get(readerCacheKey)

        request.onsuccess = function () {
          var cacheEntry = request.result || null
          var putRequest = null

          if (!cacheEntry || !cacheEntry.buffer) {
            resolve()
            return
          }

          cacheEntry.lastOpenedAt = Date.now()
          putRequest = store.put(cacheEntry)

          putRequest.onsuccess = function () {
            resolve()
          }

          putRequest.onerror = function () {
            reject(putRequest.error || new Error('EPUB 캐시 사용 시각을 갱신하지 못했습니다.'))
          }
        }

        request.onerror = function () {
          reject(request.error || new Error('EPUB 캐시 갱신에 실패했습니다.'))
        }
      }).finally(function () {
        db.close()
      })
    })
  }

  function fetchBookBuffer() {
    return fetch(readerUrl, {
      method: 'GET',
      credentials: 'same-origin',
    }).then(function (response) {
      console.debug('page/books/[bookId]/read:fetch-response', {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('Content-Type') || '',
      })

      if (!response.ok) {
        throw new Error('EPUB 파일 응답이 올바르지 않습니다. status=' + response.status)
      }

      return response.arrayBuffer()
    })
  }

  function isAutoPagingSettling() {
    return Date.now() < settlingUntil
  }

  function setAutoPagingSettling() {
    settlingUntil = Date.now() + AUTO_PAGE_SETTLE_MS
  }

  /**
   * 자동 페이지 전환 의도 상태를 초기화합니다.
   * @returns {void}
   */
  function resetAutoPagingIntent() {
    intentDirection = ''
    intentStartedAt = 0
  }

  /**
   * 예약된 자동 페이지 전환 검사와 상태를 초기화합니다.
   * @param {{ keepSettling?: boolean, keepRelease?: boolean, keepInFlight?: boolean }=} options 유지할 상태 옵션
   * @returns {void}
   */
  function resetAutoPagingState(options) {
    var keepSettling = !!(options && options.keepSettling)
    var keepRelease = !!(options && options.keepRelease)
    var keepInFlight = !!(options && options.keepInFlight)

    if (autoPagingCheckFrameId) {
      window.cancelAnimationFrame(autoPagingCheckFrameId)
      autoPagingCheckFrameId = 0
    }

    pendingAutoPagingDirection = ''
    pendingTransitionSnapshot = null
    resetAutoPagingIntent()

    if (!keepRelease) {
      releaseRequired = false
      releaseDirection = ''
    }

    if (!keepSettling) {
      settlingUntil = 0
    }

    if (!keepInFlight) {
      autoPagingInFlight = false
    }
  }

  /**
   * 수동 이동 전에 자동 페이지 전환 상태를 정리합니다.
   * @returns {void}
   */
  function prepareManualNavigation() {
    resetAutoPagingState()
    setAutoPagingSettling()
  }

  /**
   * 자동 페이지 전환에 사용할 스크롤 대상을 중복 없이 추가합니다.
   * @param {HTMLElement[]} targets 수집 중인 스크롤 대상 목록
   * @param {HTMLElement | null | undefined} target 검사할 DOM 요소
   */
  function appendAutoPagingTarget(targets, target) {
    if (!target || targets.indexOf(target) !== -1) {
      return
    }

    targets.push(target)
  }

  /**
   * 현재 리더에서 스크롤 이벤트를 받을 수 있는 후보들을 반환합니다.
   * @returns {HTMLElement[]} 자동 페이지 전환 후보 목록
   */
  function getAutoPagingTargets() {
    var targets = []
    var rootContainer = document.getElementById('epub-reader')
    var managerContainer = renditionInstance && renditionInstance.manager ? renditionInstance.manager.container : null

    appendAutoPagingTarget(targets, readerContainer)
    appendAutoPagingTarget(targets, rootContainer)
    appendAutoPagingTarget(targets, managerContainer)

    return targets
  }

  /**
   * 스크롤 앵커링을 끄고 상단 prepend 시 점프를 줄입니다.
   * @param {HTMLElement | null | undefined} target 적용할 DOM 요소
   */
  function disableScrollAnchoring(target) {
    if (!target || !target.style) {
      return
    }

    try {
      target.style.overflowAnchor = 'none'
    } catch (exception) {}
  }

  /**
   * 자동 페이지 전환 기준으로 쓸 수 있는 스크롤 컨테이너인지 확인합니다.
   * @param {HTMLElement | null | undefined} target 검사할 DOM 요소
   * @returns {boolean} 스크롤 판단에 사용할 수 있는지 여부
   */
  function isScrollableAutoPagingTarget(target) {
    var overflowY = ''

    if (!target || target.scrollHeight <= target.clientHeight) {
      return false
    }

    try {
      overflowY = window.getComputedStyle(target).overflowY || ''
    } catch (exception) {
      overflowY = ''
    }

    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
  }

  /**
   * 자동 페이지 전환에 사용할 대표 스크롤 컨테이너를 고릅니다.
   * @returns {HTMLElement | null} 실제 판단 기준이 될 스크롤 컨테이너
   */
  function resolveAutoPagingTarget() {
    var targets = getAutoPagingTargets()
    var i = 0

    for (i = 0; i < targets.length; i += 1) {
      if (isScrollableAutoPagingTarget(targets[i])) {
        return targets[i]
      }
    }

    return targets.length ? targets[0] : null
  }

  /**
   * 현재 자동 페이지 전환 기준 컨테이너와 스크롤 위치 상태를 동기화합니다.
   * @returns {HTMLElement | null} 현재 기준 스크롤 컨테이너
   */
  function syncAutoPagingTarget() {
    var target = resolveAutoPagingTarget()

    if (!target) {
      return null
    }

    if (autoPagingTarget !== target) {
      lastContainerScrollTop = target.scrollTop || 0
    }

    autoPagingTarget = target
    readerContainer = target

    return target
  }

  /**
   * 현재 방향 기준으로 경계까지 남은 거리를 계산합니다.
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {number} 경계까지 남은 거리
   */
  function getDistanceToEdge(target, direction) {
    if (!target) {
      return Number.POSITIVE_INFINITY
    }

    if (direction === 'prev') {
      return Number(target.scrollTop || 0)
    }

    if (direction === 'next') {
      return Math.max(target.scrollHeight - (target.scrollTop + target.clientHeight), 0)
    }

    return Number.POSITIVE_INFINITY
  }

  /**
   * 자동 페이지 전환을 다시 허용할 만큼 경계에서 벗어났는지 확인합니다.
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @returns {boolean} 재발동 가능한지 여부
   */
  function hasReleasedAutoPagingEdge(target) {
    if (!releaseRequired || !releaseDirection) {
      return true
    }

    return getDistanceToEdge(target, releaseDirection) > EDGE_RELEASE_DISTANCE
  }

  /**
   * 현재 위치가 자동 페이지 전환 트리거 범위인지 확인합니다.
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {boolean} 트리거 가능한 경계 근처인지 여부
   */
  function isWithinAutoPagingTrigger(target, direction) {
    return getDistanceToEdge(target, direction) <= EDGE_TRIGGER_DISTANCE
  }

  /**
   * 현재 위치가 자동 페이지 전환의 시작/끝 경계인지 확인합니다.
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {boolean} 더 이상 자동 이동하면 안 되는지 여부
   */
  function isAutoPagingBoundary(direction) {
    var spineItems = bookInstance && bookInstance.spine && bookInstance.spine.spineItems ? bookInstance.spine.spineItems : []
    var start = currentLocation && currentLocation.start ? currentLocation.start : null
    var end = currentLocation && currentLocation.end ? currentLocation.end : null
    var lastSpineIndex = spineItems.length ? spineItems.length - 1 : -1
    var startIndex = start && typeof start.index === 'number' ? start.index : null
    var endIndex = end && typeof end.index === 'number' ? end.index : startIndex
    var displayed = currentLocation && currentLocation.displayed ? currentLocation.displayed : null
    var startDisplayed = start && start.displayed ? start.displayed : null
    var page = displayed && typeof displayed.page === 'number' ? displayed.page : startDisplayed && typeof startDisplayed.page === 'number' ? startDisplayed.page : null
    var total = displayed && typeof displayed.total === 'number' ? displayed.total : startDisplayed && typeof startDisplayed.total === 'number' ? startDisplayed.total : null
    var progressPercent = Number(getProgressPercentFromLocator(start && start.cfi ? String(start.cfi) : ''))

    if (direction === 'prev') {
      if (startIndex === 0 && page === 1) {
        return true
      }

      if (startIndex === 0 && (progressPercent === 0 || !isFinite(progressPercent))) {
        return true
      }
    }

    if (direction === 'next') {
      if (lastSpineIndex >= 0 && endIndex === lastSpineIndex && page !== null && total !== null && page >= total) {
        return true
      }

      if (lastSpineIndex >= 0 && endIndex === lastSpineIndex && progressPercent === 100) {
        return true
      }
    }

    return false
  }

  /**
   * 자동 페이지 전환 전 스크롤 위치 스냅샷을 기록합니다.
   * @param {'next' | 'prev'} direction 이동 방향
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @returns {{ direction: 'next' | 'prev', beforeScrollTop: number, beforeScrollHeight: number, beforeClientHeight: number } | null} 전환 보정 스냅샷
   */
  function createAutoPagingTransitionSnapshot(direction, target) {
    if (!target || (direction !== 'next' && direction !== 'prev')) {
      return null
    }

    return {
      direction: direction,
      beforeScrollTop: Number(target.scrollTop || 0),
      beforeScrollHeight: Number(target.scrollHeight || 0),
      beforeClientHeight: Number(target.clientHeight || 0),
    }
  }

  /**
   * 자동 페이지 전환 완료 후 공통 상태를 마무리합니다.
   * @param {'next' | 'prev'} direction 이동 방향
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @returns {void}
   */
  function finalizeAutoPagingTransition(direction, target) {
    var activeTarget = target || syncAutoPagingTarget()

    autoPagingInFlight = false
    pendingTransitionSnapshot = null
    releaseRequired = true
    releaseDirection = direction
    setAutoPagingSettling()
    resetAutoPagingIntent()

    if (activeTarget) {
      lastContainerScrollTop = activeTarget.scrollTop || 0
    }
  }

  /**
   * 이전 섹션 prepend 후 높이 차이만큼 스크롤 위치를 보정합니다.
   * @param {{ direction: 'next' | 'prev', beforeScrollTop: number, beforeScrollHeight: number, beforeClientHeight: number } | null} snapshot 전환 전 스냅샷
   * @returns {void}
   */
  function schedulePrevAutoPagingCompensation(snapshot) {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        var target = syncAutoPagingTarget()
        var afterScrollHeight = 0
        var heightDelta = 0

        if (!target || !snapshot || snapshot.direction !== 'prev') {
          finalizeAutoPagingTransition(snapshot && snapshot.direction ? snapshot.direction : 'prev', target)
          return
        }

        afterScrollHeight = Number(target.scrollHeight || 0)
        heightDelta = Math.max(afterScrollHeight - snapshot.beforeScrollHeight, 0)
        target.scrollTop = snapshot.beforeScrollTop + heightDelta
        lastContainerScrollTop = target.scrollTop || 0

        finalizeAutoPagingTransition('prev', target)
      })
    })
  }

  function goToAdjacentSection(component, direction) {
    var action = null
    var target = autoPagingTarget || syncAutoPagingTarget()

    if (!renditionInstance || !target || autoPagingInFlight || isAutoPagingSettling()) {
      return
    }

    if (direction !== 'next' && direction !== 'prev') {
      return
    }

    if (isAutoPagingBoundary(direction)) {
      resetAutoPagingIntent()
      return
    }

    action = direction === 'next' ? renditionInstance.next : renditionInstance.prev

    if (typeof action !== 'function') {
      return
    }

    pendingTransitionSnapshot = createAutoPagingTransitionSnapshot(direction, target)

    if (!pendingTransitionSnapshot) {
      return
    }

    autoPagingInFlight = true
    resetAutoPagingIntent()

    Promise.resolve(action.call(renditionInstance))
      .then(function () {
        console.debug('page/books/[bookId]/read:auto-page:requested', {
          direction: direction,
        })
      })
      .catch(function (exception) {
        resetAutoPagingState()
        console.warn('page/books/[bookId]/read:auto-page:failed', {
          direction: direction,
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
  }

  /**
   * 스크롤 연속 이벤트를 한 프레임으로 합쳐 자동 페이지 전환을 검사합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {void}
   */
  function scheduleAutoPagingEvaluation(component, direction) {
    if (direction !== 'next' && direction !== 'prev') {
      return
    }

    pendingAutoPagingDirection = direction

    if (autoPagingCheckFrameId) {
      return
    }

    autoPagingCheckFrameId = window.requestAnimationFrame(function () {
      var queuedDirection = pendingAutoPagingDirection

      autoPagingCheckFrameId = 0
      pendingAutoPagingDirection = ''
      evaluateAutoPaging(component, queuedDirection)
    })
  }

  /**
   * 현재 스크롤 위치와 입력 방향을 바탕으로 자동 페이지 전환 여부를 평가합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {void}
   */
  function evaluateAutoPaging(component, direction) {
    var target = autoPagingTarget || syncAutoPagingTarget()

    if (!target || (direction !== 'next' && direction !== 'prev')) {
      resetAutoPagingIntent()
      return
    }

    if (component.loading || isRestoringPosition || autoPagingInFlight || isAutoPagingSettling()) {
      resetAutoPagingIntent()
      return
    }

    if (releaseRequired) {
      if (!hasReleasedAutoPagingEdge(target)) {
        resetAutoPagingIntent()
        return
      }

      releaseRequired = false
      releaseDirection = ''
    }

    if (!isWithinAutoPagingTrigger(target, direction)) {
      if (intentDirection === direction) {
        resetAutoPagingIntent()
      }

      return
    }

    if (intentDirection !== direction) {
      intentDirection = direction
      intentStartedAt = Date.now()
      return
    }

    if (Date.now() - intentStartedAt < EDGE_INTENT_MS) {
      return
    }

    goToAdjacentSection(component, direction)
  }

  function bindAutoPaging(component, target) {
    if (!target) {
      return
    }

    if (boundAutoPagingTarget === target && boundAutoPagingHandler) {
      return
    }

    if (boundAutoPagingTarget && boundAutoPagingHandler) {
      boundAutoPagingTarget.removeEventListener('scroll', boundAutoPagingHandler)
    }

    boundAutoPagingTarget = target
    readerContainer = target
    lastContainerScrollTop = target.scrollTop || 0

    boundAutoPagingHandler = function () {
      var currentScrollTop = boundAutoPagingTarget ? boundAutoPagingTarget.scrollTop || 0 : 0
      var direction = ''

      if (currentScrollTop > lastContainerScrollTop) {
        direction = 'next'
      } else if (currentScrollTop < lastContainerScrollTop) {
        direction = 'prev'
      }

      lastContainerScrollTop = currentScrollTop

      if (direction) {
        scheduleAutoPagingEvaluation(component, direction)
      }
    }

    target.addEventListener('scroll', boundAutoPagingHandler, { passive: true })
  }

  function renderBookBuffer(component, buffer) {
    console.debug('page/books/[bookId]/read:fetch-buffer', {
      byteLength: buffer && buffer.byteLength ? buffer.byteLength : 0,
    })

    bookInstance = window.ePub(buffer)
    renditionInstance = bookInstance.renderTo('epub-reader', {
      width: '100%',
      height: '100%',
      manager: 'continuous',
      flow: 'scrolled',
      allowScriptedContent: false,
    })

    getAutoPagingTargets().forEach(function (target) {
      disableScrollAnchoring(target)
    })

    renditionInstance.hooks.content.register(function (contents) {
      var doc = contents && contents.document ? contents.document : null
      var styleElement = null

      if (!doc) {
        return
      }

      upsertRenderedContentEntry(contents)
      annotateReadableTextNodes(doc.body || doc)

      if (doc.documentElement && doc.documentElement.style) {
        doc.documentElement.style.setProperty('overflow-anchor', 'none', 'important')
      }

      if (doc.body && doc.body.style) {
        doc.body.style.setProperty('overflow-anchor', 'none', 'important')
      }

      if (doc.head && !doc.getElementById('booklog-read-aloud-style')) {
        styleElement = doc.createElement('style')
        styleElement.id = 'booklog-read-aloud-style'
        styleElement.textContent =
          '.booklog-read-aloud-active{background:rgba(245,204,96,0.38)!important;border-radius:0.4rem;box-shadow:0 0 0 0.18rem rgba(245,204,96,0.16);transition:background-color 120ms ease;}'
        doc.head.appendChild(styleElement)
      }
    })

    renditionInstance.on('relocated', function (location) {
      var target = null
      var snapshot = pendingTransitionSnapshot

      target = syncAutoPagingTarget()
      if (target) {
        bindAutoPaging(component, target)
      }
      updateCurrentLocation(component, location)

      if (!autoPagingInFlight || !snapshot) {
        return
      }

      if (snapshot.direction === 'prev') {
        schedulePrevAutoPagingCompensation(snapshot)
        return
      }

      finalizeAutoPagingTransition(snapshot.direction, target)
    })

    return bookInstance.ready.then(function () {
      var locationsPromise = Promise.resolve()

      try {
        if (bookInstance.locations && typeof bookInstance.locations.generate === 'function') {
          locationsPromise = Promise.resolve(bookInstance.locations.generate(1600))
        }
      } catch (exception) {
        locationsPromise = Promise.resolve()
      }

      try {
        registerTocItems(bookInstance.navigation && bookInstance.navigation.toc ? bookInstance.navigation.toc : [])
        syncTocState(component, bookInstance.navigation && bookInstance.navigation.toc ? bookInstance.navigation.toc : [])
      } catch (exception) {}

      return locationsPromise.then(function () {
        return renditionInstance.display().then(function (location) {
          var target = null

          getAutoPagingTargets().forEach(function (candidateTarget) {
            disableScrollAnchoring(candidateTarget)
          })
          target = syncAutoPagingTarget()

          if (target) {
            bindAutoPaging(component, target)
          }
          updateCurrentLocation(component, location || renditionInstance.currentLocation())
        })
      })
    })
  }

  function init(component) {
    var container = document.getElementById('epub-reader')

    activeComponent = component
    syncSpeechVoices(component)
    window.history.pushState({ readerSaveGuard: true }, '', window.location.href)
    window.addEventListener('popstate', handlePopState)

    if (getSpeechSynthesisInstance() && !speechVoiceSyncHandler) {
      speechVoiceSyncHandler = function () {
        syncSpeechVoices(activeComponent)
      }

      getSpeechSynthesisInstance().addEventListener('voiceschanged', speechVoiceSyncHandler)
    }

    window.addEventListener('beforeunload', function () {
      stopSpeechPlayback(activeComponent, {
        keepMessage: true,
      })
    })

    if (!container || !window.ePub) {
      component.loading = false
      component.errorMessage = 'EPUB 뷰어를 불러오지 못했습니다.'
      return
    }

    console.debug('page/books/[bookId]/read:init', {
      bookId: bookId,
      readerUrl: readerUrl,
      readerCacheKey: readerCacheKey,
    })

    readerContainer = container

    readCachedBookBuffer()
      .then(function (cachedBuffer) {
        if (cachedBuffer) {
          console.debug('page/books/[bookId]/read:cache-hit', {
            bookId: bookId,
            cacheKey: readerCacheKey,
          })

          return touchCachedBookBuffer()
            .catch(function () {})
            .then(function () {
              return cachedBuffer
            })
        }

        console.debug('page/books/[bookId]/read:cache-miss', {
          bookId: bookId,
          cacheKey: readerCacheKey,
        })

        return fetchBookBuffer().then(function (buffer) {
          return writeCachedBookBuffer(buffer)
            .catch(function (exception) {
              console.warn('page/books/[bookId]/read:cache-write-skipped', {
                message: String(exception && exception.message ? exception.message : exception),
              })
            })
            .then(function () {
              return buffer
            })
        })
      })
      .then(function (buffer) {
        return renderBookBuffer(component, buffer)
      })
      .then(function () {
        component.loadingSavedPosition = true

        return restoreSavedPosition(component, {
          silent: true,
        }).finally(function () {
          hasAttemptedInitialRestore = true
          component.loadingSavedPosition = false
        })
      })
      .then(function () {
        component.loading = false
        startAutoSave(component)
        console.debug('page/books/[bookId]/read:rendered', {
          bookId: bookId,
        })
      })
      .catch(function (exception) {
        component.loading = false
        component.errorMessage = String(exception && exception.message ? exception.message : exception)
        console.error('page/books/[bookId]/read:failed', {
          message: component.errorMessage,
        })
      })
  }

  function startReadAloud(component) {
    if (!component) {
      return
    }

    syncSpeechVoices(component)

    if (!component.readAloudSupported) {
      component.readAloudMessage = getReadAloudMode(component) === 'cloud' ? '클라우드 읽어주기 설정을 확인하지 못했습니다.' : '이 브라우저는 읽어주기를 지원하지 않습니다.'
      return
    }

    if (!component.readAloudVoices.length) {
      component.readAloudMessage = getReadAloudMode(component) === 'cloud' ? '클라우드 읽어주기 음성 설정을 찾지 못했습니다.' : '사용 가능한 한국어 음성을 찾지 못했습니다.'
      return
    }

    stopSpeechPlayback(component, {
      keepMessage: true,
    })

    component.readAloudBusy = true
    component.readAloudPlaying = false
    component.readAloudMessage = '현재 챕터를 준비하는 중입니다.'
    speechActiveToken += 1
    speechCurrentComponent = component
    speechCurrentMode = getReadAloudMode(component)

    buildReadAloudQueue(component)
      .then(function (queue) {
        if (speechCurrentComponent !== component) {
          return
        }

        speechQueue = queue
        speechQueueIndex = 0
        speakQueueItem(component, speechActiveToken)
      })
      .catch(function (exception) {
        resetReadAloudState(component, {
          keepMessage: true,
        })
        component.readAloudMessage = String(exception && exception.message ? exception.message : exception)
      })
  }

  function stopReadAloud(component) {
    stopSpeechPlayback(component, {
      keepMessage: true,
    })

    if (component) {
      component.readAloudMessage = '읽어주기를 멈췄습니다.'
    }
  }

  function performSearch(component) {
    var query = normalizeText(component.searchQuery)
    var spineItems = null
    var results = []
    var searchPromises = []

    if (!query) {
      component.searchResults = []
      component.searchMessage = '검색어를 입력해 주세요.'
      return
    }

    if (!bookInstance || !bookInstance.spine) {
      component.searchResults = []
      component.searchMessage = '리더가 아직 준비되지 않았습니다.'
      return
    }

    spineItems = bookInstance.spine.spineItems || []

    if (!spineItems.length) {
      component.searchResults = []
      component.searchMessage = '검색할 본문이 없습니다.'
      return
    }

    component.searching = true
    component.searchMessage = ''
    component.searchResults = []

    spineItems.forEach(function (section) {
      if (!section || typeof section.find !== 'function') {
        return
      }

      searchPromises.push(
        Promise.resolve(section.load(bookInstance.load.bind(bookInstance)))
          .then(function () {
            var found = section.find(query) || []
            var chapterLabel = getChapterLabelForSection(section)

            found.forEach(function (item) {
              results.push({
                cfi: String(item && item.cfi ? item.cfi : ''),
                excerpt: normalizeText(item && item.excerpt ? item.excerpt : ''),
                chapterLabel: chapterLabel,
                label: buildSearchResultLabel({
                  chapterLabel: chapterLabel,
                  excerpt: item && item.excerpt ? item.excerpt : '',
                }),
                labelHtml: buildSearchResultLabelHtml(
                  {
                    chapterLabel: chapterLabel,
                    excerpt: item && item.excerpt ? item.excerpt : '',
                  },
                  query
                ),
              })
            })
          })
          .catch(function (exception) {
            console.warn('page/books/[bookId]/read:search-section-skipped', {
              href: section && section.href ? section.href : '',
              message: String(exception && exception.message ? exception.message : exception),
            })
          })
          .finally(function () {
            try {
              section.unload()
            } catch (exception) {}
          })
      )
    })

    Promise.all(searchPromises)
      .then(function () {
        component.searching = false
        component.searchResults = results
        component.searchMessage = results.length ? results.length + '개의 결과를 찾았습니다.' : '검색 결과가 없습니다.'
      })
      .catch(function (exception) {
        component.searching = false
        component.searchResults = []
        component.searchMessage = '검색 중 오류가 발생했습니다.'
        console.error('page/books/[bookId]/read:search-failed', {
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
  }

  function goToSearchResult(component, result) {
    var target = result && result.cfi ? String(result.cfi) : ''

    if (!target || !renditionInstance) {
      return
    }

    component.loading = true
    component.searchOpen = false
    stopSpeechPlayback(component, {
      keepMessage: true,
    })
    prepareManualNavigation()

    renditionInstance
      .display(target)
      .then(function () {
        component.loading = false
      })
      .catch(function (exception) {
        component.loading = false
        component.errorMessage = String(exception && exception.message ? exception.message : exception)
        console.error('page/books/[bookId]/read:goto-search-result:failed', {
          message: component.errorMessage,
          cfi: target,
        })
      })
  }

  function goToTocItem(component, item) {
    var target = item && item.href ? String(item.href) : ''

    if (!target || !renditionInstance) {
      return
    }

    component.tocOpen = false
    component.controlsVisible = false
    component.loading = true
    stopSpeechPlayback(component, {
      keepMessage: true,
    })
    prepareManualNavigation()

    renditionInstance
      .display(target)
      .then(function (location) {
        updateCurrentLocation(component, location || renditionInstance.currentLocation())
        component.loading = false
      })
      .catch(function (exception) {
        component.loading = false
        component.errorMessage = String(exception && exception.message ? exception.message : exception)
        console.error('page/books/[bookId]/read:goto-toc-item:failed', {
          message: component.errorMessage,
          href: target,
        })
      })
  }

  function isActiveTocItem(component, item) {
    var activeKey = component && component.activeTocKey ? String(component.activeTocKey) : ''
    var itemKey = item && item.key ? String(item.key) : ''

    return !!activeKey && !!itemKey && activeKey === itemKey
  }

  function saveHighlight(component) {
    var location = currentLocation && currentLocation.start ? currentLocation.start : null
    var locator = location && location.cfi ? String(location.cfi) : ''
    var href = location && location.href ? String(location.href) : ''
    var formData = new FormData()

    component.highlightMessage = ''

    if (!normalizeText(component.highlightQuoteText)) {
      component.highlightMessage = '문구를 입력해 주세요.'
      return
    }

    formData.set('bookId', bookId)
    formData.set('quoteText', component.highlightQuoteText)
    formData.set('noteText', component.highlightNoteText)
    formData.set('locator', locator)
    formData.set('href', href)
    formData.set('chapterLabel', component.currentChapterLabel || getChapterLabelForHref(href))

    component.savingHighlight = true

    fetch('/api/books/save-highlight', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    })
      .then(function (response) {
        return response
          .json()
          .then(function (payload) {
            return {
              ok: response.ok,
              status: response.status,
              payload: payload || {},
            }
          })
          .catch(function () {
            return {
              ok: response.ok,
              status: response.status,
              payload: {},
            }
          })
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(String(result.payload && result.payload.message ? result.payload.message : '문구 저장에 실패했습니다.'))
        }

        component.savingHighlight = false
        component.highlightOpen = false
        component.highlightQuoteText = ''
        component.highlightNoteText = ''
        component.highlightMessage = ''
        component.showSavePositionMessage(String(result.payload && result.payload.message ? result.payload.message : '인상 깊은 문구를 저장했습니다.'))
      })
      .catch(function (exception) {
        component.savingHighlight = false
        component.highlightMessage = String(exception && exception.message ? exception.message : exception)
        console.error('page/books/[bookId]/read:save-highlight:failed', {
          message: component.highlightMessage,
        })
      })
  }

  function saveCurrentPosition(component) {
    component.showSavePositionMessage('')

    component.savingPosition = true

    persistProgress(component, {
      silent: false,
      skipIfUnchanged: false,
    })
      .then(function () {
        component.savingPosition = false
      })
      .catch(function (exception) {
        component.savingPosition = false
        component.showSavePositionMessage(String(exception && exception.message ? exception.message : exception))
        console.error('page/books/[bookId]/read:save-progress:failed', {
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
  }

  function goToBookDetail(component) {
    leavePageWithSavedProgress(component, {
      nextLocation: '/books/' + bookId,
      saveOptions: {
        silent: false,
        skipIfUnchanged: false,
      },
    })
  }

  function loadSavedPosition(component) {
    if (!renditionInstance) {
      component.showSavePositionMessage('리더가 아직 준비되지 않았습니다.')
      return
    }

    component.loadingSavedPosition = true
    component.loading = true
    stopSpeechPlayback(component, {
      keepMessage: true,
    })

    restoreSavedPosition(component, {
      silent: false,
    })
      .then(function () {
        component.loadingSavedPosition = false
        component.loading = false
      })
      .catch(function (exception) {
        component.loadingSavedPosition = false
        component.loading = false
        component.showSavePositionMessage(String(exception && exception.message ? exception.message : exception))
        console.error('page/books/[bookId]/read:load-progress:failed', {
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
  }

  function goToProgress(component) {
    var progressValue = parseProgressJumpValue(component.progressJumpValue)
    var locator = ''

    if (!renditionInstance || !bookInstance || !bookInstance.locations) {
      component.showSavePositionMessage('리더가 아직 준비되지 않았습니다.')
      return
    }

    if (progressValue === null) {
      component.showSavePositionMessage('0부터 100 사이의 진행률을 입력해 주세요.')
      return
    }

    if (typeof bookInstance.locations.cfiFromPercentage !== 'function') {
      component.showSavePositionMessage('진행률 이동을 지원하지 않는 책입니다.')
      return
    }

    component.jumpingProgress = true
    component.progressJumpValue = String(progressValue)
    component.progressJumpEditing = false

    try {
      locator = String(bookInstance.locations.cfiFromPercentage(progressValue / 100) || '')
    } catch (exception) {
      locator = ''
    }

    if (!locator) {
      component.jumpingProgress = false
      component.showSavePositionMessage('해당 진행률 위치를 찾지 못했습니다.')
      return
    }

    prepareManualNavigation()
    stopSpeechPlayback(component, {
      keepMessage: true,
    })

    Promise.resolve(renditionInstance.display(locator))
      .then(function (location) {
        updateCurrentLocation(component, location || renditionInstance.currentLocation())
        component.showSavePositionMessage(progressValue + '% 지점으로 이동했습니다.')
      })
      .catch(function (exception) {
        component.showSavePositionMessage(String(exception && exception.message ? exception.message : '진행률 이동에 실패했습니다.'))
        console.error('page/books/[bookId]/read:go-to-progress:failed', {
          message: String(exception && exception.message ? exception.message : exception),
          progressValue: progressValue,
        })
      })
      .finally(function () {
        component.jumpingProgress = false
      })
  }

  return {
    init: init,
    performSearch: performSearch,
    goToSearchResult: goToSearchResult,
    goToTocItem: goToTocItem,
    isActiveTocItem: isActiveTocItem,
    scrollActiveTocItemIntoView: scrollActiveTocItemIntoView,
    startReadAloud: startReadAloud,
    stopReadAloud: stopReadAloud,
    saveHighlight: saveHighlight,
    saveCurrentPosition: saveCurrentPosition,
    goToBookDetail: goToBookDetail,
    loadSavedPosition: loadSavedPosition,
    goToProgress: goToProgress,
  }
})()
