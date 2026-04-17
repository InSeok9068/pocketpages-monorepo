const { extractJsonObjectText, normalizeAssetClassCode, normalizeCapturePageType, normalizeIsoDate, normalizeText, normalizeUpperCode, parseJsonSafely, parseNumber } = require('./photofolio-asset-utils')

const GEMINI_MODEL_NAME = 'gemini-2.5-flash-lite'
const PROMPT_PAGE_TYPE_ENUM = '[assets_overview,invest_overview,invest_holdings,unknown]'
const PROMPT_ASSET_CLASS_ENUM = '[cash,stock_growth,stock_dividend,bond,gold,real_estate,other]'
const PROMPT_RESPONSE_SCHEMA =
  '{"page_type":"","snapshot_title":"","snapshot_date":null,"total_amount_krw":null,"sections":[{"section_label":"","reported_amount_krw":null}],"items":[{"institution_name":"","account_label":"","asset_name":"","asset_class_code":"","source_section_label":"","market_code":"","currency_code":"","quantity":null,"unit_price":null,"amount_original":null,"exchange_rate":null,"amount_krw":null,"memo":""}]}'

function createEmptyLogger() {
  return {
    dbg: function () {},
    info: function () {},
    warn: function () {},
    error: function () {},
  }
}

function buildResponseSchemaPrompt() {
  return 'Schema: ' + PROMPT_RESPONSE_SCHEMA
}

function buildFullPrompt() {
  return [
    'Return one JSON object only. No markdown. No code fence.',
    'Read a Toss asset screenshot for photofolio.',
    'sections = visible summary totals. items = real holdings rows.',
    'If summary blocks and holdings rows both appear, set page_type=invest_holdings and fill both sections and items.',
    'If only summary is visible, use page_type=assets_overview or invest_overview and set items=[].',
    'Institution/account summary rows are not holdings. Examples: Mirae Asset Securities, Samsung Securities, Kakao Bank, NH Investment.',
    'Real holdings rows look like tickers or product names. Examples: KODEX S&P500, SCHD, JEPI, SPY, Samsung Electronics.',
    'Do not guess.',
    'Drop rows with unclear name, unclear amount, empty asset_name, or amount_krw<=0.',
    'Enums: page_type=' + PROMPT_PAGE_TYPE_ENUM + ', asset_class_code=' + PROMPT_ASSET_CLASS_ENUM + '.',
    buildResponseSchemaPrompt(),
  ].join('\n')
}

function buildSlicePrompt() {
  return [
    'Return one JSON object only. No markdown. No code fence.',
    'This image may be one vertical slice of a tall Toss screenshot.',
    'Return only sections and holdings rows fully visible in this slice.',
    'If summary blocks and holdings rows both appear, set page_type=invest_holdings and fill both sections and items.',
    'If only institution/account summary rows appear, use assets_overview and set items=[].',
    'Never turn institution/account summary rows into items.',
    'Do not guess.',
    'Drop cropped rows, unclear rows, empty asset_name rows, and rows with amount_krw<=0.',
    'Enums: page_type=' + PROMPT_PAGE_TYPE_ENUM + ', asset_class_code=' + PROMPT_ASSET_CLASS_ENUM + '.',
    buildResponseSchemaPrompt(),
  ].join('\n')
}

function buildPrompt(extractionMode) {
  return extractionMode === 'slice' ? buildSlicePrompt() : buildFullPrompt()
}

/**
 * Gemini API 키를 읽습니다.
 * @param {(key: string) => string} envGetter 환경 변수 조회 함수입니다.
 * @returns {string} Gemini API 키입니다.
 */
function readGeminiApiKey(envGetter) {
  return String(
    envGetter('GEMINI_APIKEY') ||
      envGetter('GEMINI_API_KEY') ||
      envGetter('GEMINI_AI_KEY') ||
      ''
  ).trim()
}

/**
 * 값 목록에서 첫 번째 유효 값을 찾습니다.
 * @param {any[]} values 후보 값 목록입니다.
 * @returns {any} 첫 번째 유효 값입니다.
 */
function pickFirstValue(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value !== undefined && value !== null) {
      return value
    }
  }

  return ''
}

function readGeminiText(responseJson) {
  const candidates = responseJson && Array.isArray(responseJson.candidates) ? responseJson.candidates : []
  const firstCandidate = candidates.length > 0 && candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : {}
  const content = firstCandidate.content && typeof firstCandidate.content === 'object' ? firstCandidate.content : {}
  const parts = Array.isArray(content.parts) ? content.parts : []
  const firstPart = parts.length > 0 && parts[0] && typeof parts[0] === 'object' ? parts[0] : {}

  return normalizeText(firstPart.text || '', 0)
}

function normalizeItem(rawItem) {
  const sourceJson = rawItem && typeof rawItem === 'object' ? rawItem : {}
  const institutionName = normalizeText(pickFirstValue([sourceJson.institution_name, sourceJson.institutionName, sourceJson['기관명'], sourceJson['금융사명']]), 255)
  const accountLabel = normalizeText(pickFirstValue([sourceJson.account_label, sourceJson.accountLabel, sourceJson['계좌명'], sourceJson['상품명']]), 255)
  const assetName = normalizeText(pickFirstValue([sourceJson.asset_name, sourceJson.assetName, sourceJson.name, sourceJson['자산명'], sourceJson['종목명'], accountLabel]), 255)
  const assetClassCode = normalizeAssetClassCode(pickFirstValue([sourceJson.asset_class_code, sourceJson.assetClassCode, sourceJson.category, sourceJson['자산분류']]))
  const sourceSectionLabel = normalizeText(pickFirstValue([sourceJson.source_section_label, sourceJson.sourceSectionLabel, sourceJson.section_label, sourceJson.sectionLabel, sourceJson['섹션명']]), 255)
  const marketCode = normalizeUpperCode(pickFirstValue([sourceJson.market_code, sourceJson.marketCode, sourceJson['시장코드']]), 20)
  const currencyCode = normalizeUpperCode(pickFirstValue([sourceJson.currency_code, sourceJson.currencyCode, sourceJson['통화코드']]), 10)
  const quantity = parseNumber(pickFirstValue([sourceJson.quantity, sourceJson['수량']]))
  let unitPrice = parseNumber(pickFirstValue([sourceJson.unit_price, sourceJson.unitPrice, sourceJson['단가']]))
  const amountOriginal = parseNumber(pickFirstValue([sourceJson.amount_original, sourceJson.amountOriginal, sourceJson.amount, sourceJson['평가금액'], sourceJson['금액']]))
  const exchangeRate = parseNumber(pickFirstValue([sourceJson.exchange_rate, sourceJson.exchangeRate, sourceJson['환율']]))
  let amountKrw = parseNumber(pickFirstValue([sourceJson.amount_krw, sourceJson.amountKrw, sourceJson['원화금액'], sourceJson['평가액']]))
  const memo = normalizeText(pickFirstValue([sourceJson.memo, sourceJson.note, sourceJson['메모']]), 5000)

  if (unitPrice === null && quantity && amountOriginal !== null && quantity > 0) {
    unitPrice = amountOriginal / quantity
  }

  if (amountKrw === null && amountOriginal !== null) {
    if (!currencyCode || currencyCode === 'KRW') {
      amountKrw = amountOriginal
    } else if (exchangeRate !== null && exchangeRate > 0) {
      amountKrw = amountOriginal * exchangeRate
    }
  }

  return {
    institution_name: institutionName,
    account_label: accountLabel,
    asset_name: assetName,
    asset_class_code: assetClassCode,
    source_section_label: sourceSectionLabel,
    market_code: marketCode,
    currency_code: currencyCode,
    quantity: quantity,
    unit_price: unitPrice,
    amount_original: amountOriginal,
    exchange_rate: exchangeRate,
    amount_krw: amountKrw,
    memo: memo,
    source_json: sourceJson,
  }
}

function normalizeSection(rawSection) {
  const sourceJson = rawSection && typeof rawSection === 'object' ? rawSection : {}

  return {
    section_label: normalizeText(pickFirstValue([sourceJson.section_label, sourceJson.sectionLabel, sourceJson.label, sourceJson.name, sourceJson.title, sourceJson['섹션명']]), 255),
    reported_amount_krw: parseNumber(
      pickFirstValue([
        sourceJson.reported_amount_krw,
        sourceJson.reportedAmountKrw,
        sourceJson.amount_krw,
        sourceJson.amountKrw,
        sourceJson.total_amount_krw,
        sourceJson.totalAmountKrw,
        sourceJson.amount,
        sourceJson.total,
        sourceJson['금액'],
        sourceJson['합계'],
      ])
    ),
    source_json: sourceJson,
  }
}

function normalizeSectionKey(value) {
  return normalizeText(value, 255).replace(/\s+/g, '').toLowerCase()
}

function hasAssetsOverviewSection(sections) {
  for (let index = 0; index < sections.length; index += 1) {
    const sectionKey = normalizeSectionKey(sections[index].section_label)

    if (
      sectionKey.indexOf('입출금') !== -1 ||
      sectionKey.indexOf('저축') !== -1 ||
      sectionKey.indexOf('증권') !== -1 ||
      sectionKey.indexOf('연금') !== -1 ||
      sectionKey.indexOf('외화') !== -1
    ) {
      return true
    }
  }

  return false
}

function isInstitutionLikeAssetName(assetName) {
  const normalizedName = normalizeText(assetName, 255).replace(/\s+/g, '').toLowerCase()

  if (!normalizedName) {
    return false
  }

  if (
    normalizedName.indexOf('kodex') !== -1 ||
    normalizedName.indexOf('tiger') !== -1 ||
    normalizedName.indexOf('ace') !== -1 ||
    normalizedName.indexOf('arirang') !== -1 ||
    normalizedName.indexOf('sol') !== -1 ||
    normalizedName.indexOf('schd') !== -1 ||
    normalizedName.indexOf('jepi') !== -1 ||
    normalizedName.indexOf('jepq') !== -1 ||
    normalizedName.indexOf('spy') !== -1 ||
    normalizedName.indexOf('qqq') !== -1 ||
    normalizedName.indexOf('s&p') !== -1 ||
    normalizedName.indexOf('나스닥') !== -1 ||
    normalizedName.indexOf('국채') !== -1 ||
    normalizedName.indexOf('채권') !== -1 ||
    normalizedName.indexOf('etf') !== -1 ||
    normalizedName.indexOf('tdf') !== -1 ||
    normalizedName.indexOf('삼성전자') !== -1 ||
    normalizedName.indexOf('알파벳') !== -1 ||
    normalizedName.indexOf('애플') !== -1 ||
    normalizedName.indexOf('아마존') !== -1 ||
    normalizedName.indexOf('테슬라') !== -1 ||
    normalizedName.indexOf('마이크로소프트') !== -1 ||
    normalizedName.indexOf('엔비디아') !== -1 ||
    normalizedName.indexOf('현금성자산') !== -1
  ) {
    return false
  }

  if (
    normalizedName.indexOf('증권') !== -1 ||
    normalizedName.indexOf('투자증권') !== -1 ||
    normalizedName.indexOf('은행') !== -1 ||
    normalizedName.indexOf('뱅크') !== -1 ||
    normalizedName.indexOf('카드') !== -1 ||
    normalizedName.indexOf('페이') !== -1 ||
    normalizedName.indexOf('예금') !== -1 ||
    normalizedName.indexOf('적금') !== -1 ||
    normalizedName.indexOf('연금') !== -1 ||
    normalizedName.indexOf('월렛') !== -1 ||
    normalizedName.indexOf('조합') !== -1 ||
    normalizedName.indexOf('입출금') !== -1 ||
    normalizedName.indexOf('고유계정') !== -1 ||
    normalizedName.indexOf('보유계정') !== -1
  ) {
    return true
  }

  return normalizedName.length <= 4
}

function shouldDemoteToAssetsOverview(pageType, sections, items) {
  if (!items.length) {
    return false
  }

  if (pageType !== 'invest_holdings' && pageType !== 'assets_overview' && pageType !== 'invest_overview') {
    return false
  }

  if (!hasAssetsOverviewSection(sections)) {
    return false
  }

  let institutionLikeCount = 0

  for (let index = 0; index < items.length; index += 1) {
    if (isInstitutionLikeAssetName(items[index].asset_name)) {
      institutionLikeCount += 1
    }
  }

  return institutionLikeCount >= Math.max(2, Math.ceil(items.length * 0.5))
}

function buildExtractItemMergeKey(item) {
  return normalizeText(item && item.asset_name, 255).toLowerCase()
}

function getExtractPageTypePriority(pageType) {
  const normalizedPageType = normalizeCapturePageType(pageType)

  if (normalizedPageType === 'invest_holdings') {
    return 4
  }

  if (normalizedPageType === 'invest_overview') {
    return 3
  }

  if (normalizedPageType === 'assets_overview') {
    return 2
  }

  return 1
}

function scoreExtractItem(item) {
  let score = 0

  if (normalizeText(item.asset_name, 255)) score += 4
  if (typeof item.amount_krw === 'number' && isFinite(item.amount_krw) && item.amount_krw > 0) score += 4
  if (normalizeText(item.account_label, 255)) score += 2
  if (normalizeText(item.institution_name, 255)) score += 1
  if (normalizeText(item.source_section_label, 255)) score += 1
  if (normalizeUpperCode(item.market_code, 20)) score += 1
  if (normalizeUpperCode(item.currency_code, 10)) score += 1
  if (typeof item.quantity === 'number' && isFinite(item.quantity)) score += 1
  if (typeof item.amount_original === 'number' && isFinite(item.amount_original) && item.amount_original > 0) score += 1
  if (normalizeText(item.memo, 255)) score += 0.5

  return score
}

function pickPreferredExtractItem(baseItem, incomingItem) {
  const baseScore = scoreExtractItem(baseItem)
  const incomingScore = scoreExtractItem(incomingItem)

  if (incomingScore > baseScore) {
    return incomingItem
  }

  if (incomingScore < baseScore) {
    return baseItem
  }

  if (Number(incomingItem.amount_krw || 0) > Number(baseItem.amount_krw || 0)) {
    return incomingItem
  }

  return baseItem
}

function normalizeExtractResult(parsedJson, rawText) {
  const sourceJson = parsedJson && typeof parsedJson === 'object' ? parsedJson : {}
  const pageType = normalizeCapturePageType(pickFirstValue([sourceJson.page_type, sourceJson.pageType, sourceJson.screen_type, sourceJson.screenType]))
  const normalizedSections = Array.isArray(sourceJson.sections) ? sourceJson.sections.map(normalizeSection) : []
  const validSections = normalizedSections.filter(function (section) {
    return !!section.section_label || section.reported_amount_krw !== null
  })
  const normalizedItems = Array.isArray(sourceJson.items) ? sourceJson.items.map(normalizeItem) : []
  const extractableItems = normalizedItems.filter(function (item) {
    return item.asset_name && item.amount_krw !== null && item.amount_krw > 0
  })
  let resolvedPageType =
    (pageType === 'assets_overview' || pageType === 'invest_overview') && extractableItems.length >= 3 ? 'invest_holdings' : pageType

  if (shouldDemoteToAssetsOverview(resolvedPageType, validSections, extractableItems)) {
    resolvedPageType = 'assets_overview'
  }

  const allowsDetailItems = resolvedPageType === 'invest_holdings' || resolvedPageType === 'unknown'
  const validItems = allowsDetailItems
    ? extractableItems
    : []
  let totalAmountKrw = parseNumber(pickFirstValue([sourceJson.total_amount_krw, sourceJson.totalAmountKrw]))

  if (totalAmountKrw === null) {
    if (validItems.length > 0) {
      totalAmountKrw = validItems.reduce(function (sum, item) {
        return sum + Number(item.amount_krw || 0)
      }, 0)
    } else if (validSections.length > 0) {
      totalAmountKrw = validSections.reduce(function (sum, section) {
        return sum + Number(section.reported_amount_krw || 0)
      }, 0)
    }
  }

  return {
    page_type: resolvedPageType,
    snapshot_title: normalizeText(pickFirstValue([sourceJson.snapshot_title, sourceJson.snapshotTitle, sourceJson.title]), 200),
    snapshot_date: normalizeIsoDate(pickFirstValue([sourceJson.snapshot_date, sourceJson.snapshotDate, sourceJson.date])),
    total_amount_krw: totalAmountKrw > 0 ? totalAmountKrw : null,
    sections: validSections,
    items: validItems,
    raw_text: rawText,
    raw_json: sourceJson,
  }
}

/**
 * 세로 분할된 추출 결과를 하나의 캡처 결과로 병합합니다.
 * @param {types.PhotofolioAiExtractResult[]} extractResults 추출 결과 목록입니다.
 * @returns {types.PhotofolioAiExtractResult} 병합된 추출 결과입니다.
 */
function mergeExtractResults(extractResults) {
  const results = Array.isArray(extractResults) ? extractResults.filter(Boolean) : []
  const sectionsByLabel = {}
  const itemsByKey = {}
  let snapshotTitle = ''
  let snapshotDate = ''
  let totalAmountKrw = null
  let resolvedPageType = 'unknown'
  const rawTexts = []
  const rawSegments = []

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const pageType = normalizeCapturePageType(result.page_type)
    const resultSections = Array.isArray(result.sections) ? result.sections : []
    const resultItems = Array.isArray(result.items) ? result.items : []

    if (!snapshotTitle && normalizeText(result.snapshot_title, 200)) {
      snapshotTitle = normalizeText(result.snapshot_title, 200)
    }

    if (!snapshotDate && normalizeIsoDate(result.snapshot_date)) {
      snapshotDate = normalizeIsoDate(result.snapshot_date)
    }

    if (typeof result.total_amount_krw === 'number' && isFinite(result.total_amount_krw) && result.total_amount_krw > 0) {
      totalAmountKrw = totalAmountKrw === null ? result.total_amount_krw : Math.max(totalAmountKrw, result.total_amount_krw)
    }

    if (resultItems.length > 0) {
      resolvedPageType = 'invest_holdings'
    } else if (getExtractPageTypePriority(pageType) > getExtractPageTypePriority(resolvedPageType)) {
      resolvedPageType = pageType
    }

    for (let sectionIndex = 0; sectionIndex < resultSections.length; sectionIndex += 1) {
      const section = resultSections[sectionIndex]
      const sectionLabel = normalizeText(section.section_label, 255)

      if (!sectionLabel) {
        continue
      }

      if (!sectionsByLabel[sectionLabel]) {
        sectionsByLabel[sectionLabel] = section
        continue
      }

      const existingSection = sectionsByLabel[sectionLabel]
      const existingAmount = typeof existingSection.reported_amount_krw === 'number' && isFinite(existingSection.reported_amount_krw) ? existingSection.reported_amount_krw : null
      const incomingAmount = typeof section.reported_amount_krw === 'number' && isFinite(section.reported_amount_krw) ? section.reported_amount_krw : null

      if (existingAmount === null || (incomingAmount !== null && incomingAmount > existingAmount)) {
        sectionsByLabel[sectionLabel] = section
      }
    }

    for (let itemIndex = 0; itemIndex < resultItems.length; itemIndex += 1) {
      const item = resultItems[itemIndex]
      const itemKey = buildExtractItemMergeKey(item)

      if (!itemKey) {
        continue
      }

      if (!itemsByKey[itemKey]) {
        itemsByKey[itemKey] = item
        continue
      }

      itemsByKey[itemKey] = pickPreferredExtractItem(itemsByKey[itemKey], item)
    }

    if (normalizeText(result.raw_text, 0)) {
      rawTexts.push(normalizeText(result.raw_text, 0))
    }

    rawSegments.push({
      page_type: pageType,
      total_amount_krw: result.total_amount_krw,
      section_count: resultSections.length,
      item_count: resultItems.length,
      raw_json: result.raw_json || {},
    })
  }

  const mergedItems = Object.keys(itemsByKey).map(function (itemKey) {
    return itemsByKey[itemKey]
  })
  const mergedSections = Object.keys(sectionsByLabel).map(function (sectionLabel) {
    return sectionsByLabel[sectionLabel]
  })

  if (totalAmountKrw === null && mergedItems.length > 0) {
    totalAmountKrw = mergedItems.reduce(function (sum, item) {
      return sum + Number(item.amount_krw || 0)
    }, 0)
  }

  if (totalAmountKrw === null && mergedSections.length > 0) {
    totalAmountKrw = mergedSections.reduce(function (sum, section) {
      return sum + Number(section.reported_amount_krw || 0)
    }, 0)
  }

  return {
    page_type: mergedItems.length > 0 ? 'invest_holdings' : resolvedPageType,
    snapshot_title: snapshotTitle,
    snapshot_date: snapshotDate,
    total_amount_krw: totalAmountKrw > 0 ? totalAmountKrw : null,
    sections: mergedSections,
    items: mergedItems,
    raw_text: rawTexts.join('\n\n-----\n\n'),
    raw_json: {
      merged_from_segments: true,
      segments: rawSegments,
    },
  }
}

/**
 * 업로드 이미지를 Gemini로 분석해 스냅샷 초안을 만듭니다.
 * @param {{ geminiApiKey: string, mimeType: string, fileBase64: string, extractionMode?: 'full' | 'slice', logger?: { dbg?: Function, info?: Function, warn?: Function, error?: Function } }} input 분석 입력값입니다.
 * @returns {types.PhotofolioAiExtractResult} 정규화된 추출 결과입니다.
 */
function extractAssetSnapshot(input) {
  const logger = input && input.logger ? input.logger : createEmptyLogger()
  const geminiApiKey = String((input && input.geminiApiKey) || '').trim()
  const mimeType = String((input && input.mimeType) || 'image/png').trim() || 'image/png'
  const fileBase64 = String((input && input.fileBase64) || '').trim()
  const extractionMode = input && input.extractionMode === 'slice' ? 'slice' : 'full'

  if (!geminiApiKey) {
    throw new Error('GEMINI_APIKEY 또는 GEMINI_API_KEY가 설정되지 않았습니다.')
  }

  if (!fileBase64) {
    throw new Error('분석할 이미지 데이터가 비어 있습니다.')
  }

  logger.info('xapi/snapshots/upload:gemini:start', {
    mimeType: mimeType,
    model: GEMINI_MODEL_NAME,
    extractionMode: extractionMode,
  })

  const response = $http.send({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${geminiApiKey}`,
    method: 'POST',
    timeout: 120,
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildPrompt(extractionMode) },
            {
              inline_data: {
                mime_type: mimeType,
                data: fileBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    }),
    headers: {
      'content-type': 'application/json',
    },
  })

  const statusCode = Number(response.statusCode || 0)
  const responseBody = toString(response.body)

  logger.info('xapi/snapshots/upload:gemini:done', {
    statusCode: statusCode,
  })

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('이미지 분석 처리에 실패했습니다.')
  }

  const responseJson = parseJsonSafely(responseBody, {})
  const rawText = readGeminiText(responseJson)
  const parsedJson = parseJsonSafely(extractJsonObjectText(rawText), {})
  const normalizedResult = normalizeExtractResult(parsedJson, rawText)

  if (!normalizedResult.sections.length && !normalizedResult.items.length && normalizedResult.total_amount_krw === null) {
    throw new Error('이미지에서 저장할 자산 정보나 합계를 찾지 못했습니다.')
  }

  return normalizedResult
}

module.exports = {
  extractAssetSnapshot,
  mergeExtractResults,
  readGeminiApiKey,
}
