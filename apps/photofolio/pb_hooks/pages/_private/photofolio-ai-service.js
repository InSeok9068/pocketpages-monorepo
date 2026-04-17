const { extractJsonObjectText, normalizeAssetClassCode, normalizeIsoDate, normalizeText, normalizeUpperCode, parseJsonSafely, parseNumber } = require('./photofolio-asset-utils')

const GEMINI_MODEL_NAME = 'gemini-2.5-flash-lite'

function createEmptyLogger() {
  return {
    dbg: function () {},
    info: function () {},
    warn: function () {},
    error: function () {},
  }
}

function buildPrompt() {
  return (
    '토스 자산 캡처 이미지를 보고 photofolio 스키마에 맞는 JSON 객체만 반환해.\n' +
    '반드시 코드펜스 없이 순수 JSON 객체만 반환.\n' +
    '금액은 가능한 숫자형으로 반환하고, 모르면 null.\n' +
    'asset_class_code는 아래 enum 중 하나만 사용.\n' +
    '\n' +
    'asset_class_code enum:\n' +
    '- cash = 현금, 예금, 적금, CMA, MMF, 예수금\n' +
    '- stock_growth = 일반 주식, 성장형 ETF, 성장주\n' +
    '- stock_dividend = 배당주, 배당 ETF, 월배당 상품\n' +
    '- bond = 채권, 국채, 채권 ETF\n' +
    '- gold = 금, 금 ETF\n' +
    '- real_estate = 부동산, 리츠, 부동산 ETF\n' +
    '- other = 위 분류가 애매한 모든 항목\n' +
    '\n' +
    '응답 스키마:\n' +
    '{\n' +
    '  "snapshot_title": "스냅샷 제목 또는 빈 문자열",\n' +
    '  "snapshot_date": "YYYY-MM-DD 또는 null",\n' +
    '  "total_amount_krw": number | null,\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "institution_name": "금융사/기관명",\n' +
    '      "account_label": "계좌/상품명",\n' +
    '      "asset_name": "자산명",\n' +
    '      "asset_class_code": "cash|stock_growth|stock_dividend|bond|gold|real_estate|other",\n' +
    '      "market_code": "KR|US 등 또는 빈 문자열",\n' +
    '      "currency_code": "KRW|USD 등 또는 빈 문자열",\n' +
    '      "quantity": number | null,\n' +
    '      "unit_price": number | null,\n' +
    '      "amount_original": number | null,\n' +
    '      "exchange_rate": number | null,\n' +
    '      "amount_krw": number | null,\n' +
    '      "memo": "짧은 메모 또는 빈 문자열"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n'
  )
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

function normalizeExtractResult(parsedJson, rawText) {
  const sourceJson = parsedJson && typeof parsedJson === 'object' ? parsedJson : {}
  const normalizedItems = Array.isArray(sourceJson.items) ? sourceJson.items.map(normalizeItem) : []
  const validItems = normalizedItems.filter(function (item) {
    return item.asset_name && item.amount_krw !== null && item.amount_krw > 0
  })
  let totalAmountKrw = parseNumber(pickFirstValue([sourceJson.total_amount_krw, sourceJson.totalAmountKrw]))

  if (totalAmountKrw === null) {
    totalAmountKrw = validItems.reduce(function (sum, item) {
      return sum + Number(item.amount_krw || 0)
    }, 0)
  }

  return {
    snapshot_title: normalizeText(pickFirstValue([sourceJson.snapshot_title, sourceJson.snapshotTitle, sourceJson.title]), 200),
    snapshot_date: normalizeIsoDate(pickFirstValue([sourceJson.snapshot_date, sourceJson.snapshotDate, sourceJson.date])),
    total_amount_krw: totalAmountKrw > 0 ? totalAmountKrw : null,
    items: validItems,
    raw_text: rawText,
    raw_json: sourceJson,
  }
}

/**
 * 업로드 이미지를 Gemini로 분석해 스냅샷 초안을 만듭니다.
 * @param {{ geminiApiKey: string, mimeType: string, fileBase64: string, logger?: { dbg?: Function, info?: Function, warn?: Function, error?: Function } }} input 분석 입력값입니다.
 * @returns {types.PhotofolioAiExtractResult} 정규화된 추출 결과입니다.
 */
function extractAssetSnapshot(input) {
  const logger = input && input.logger ? input.logger : createEmptyLogger()
  const geminiApiKey = String((input && input.geminiApiKey) || '').trim()
  const mimeType = String((input && input.mimeType) || 'image/png').trim() || 'image/png'
  const fileBase64 = String((input && input.fileBase64) || '').trim()

  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY 또는 GEMINI_AI_KEY가 설정되지 않았습니다.')
  }

  if (!fileBase64) {
    throw new Error('분석할 이미지 데이터가 비어 있습니다.')
  }

  logger.info('xapi/snapshots/upload:gemini:start', {
    mimeType: mimeType,
    model: GEMINI_MODEL_NAME,
  })

  const response = $http.send({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${geminiApiKey}`,
    method: 'POST',
    timeout: 60,
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildPrompt() },
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

  if (!normalizedResult.items.length) {
    throw new Error('이미지에서 저장할 자산 항목을 찾지 못했습니다.')
  }

  return normalizedResult
}

module.exports = {
  extractAssetSnapshot,
}
