'use strict'

/**
 * 공백을 제거한 문자열을 만듭니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 문자열 값입니다.
 */
function cleanText(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/**
 * 대문자 검색 문자열을 만듭니다.
 * @param {unknown[]} values 검색할 값 목록입니다.
 * @returns {string} 검색 문자열입니다.
 */
function buildSearchText(values) {
  const parts = []
  for (let index = 0; index < values.length; index += 1) {
    const text = cleanText(values[index])
    if (text) parts.push(text.toUpperCase())
  }
  return parts.join(' ')
}

/**
 * 허용된 자산군 값을 정리합니다.
 * @param {unknown} value 자산군 값입니다.
 * @returns {types.SeedLabAssetClass | ''} 자산군입니다.
 */
function normalizeAssetClass(value) {
  const assetClass = cleanText(value)
  if (assetClass === 'equity' || assetClass === 'fixed_income' || assetClass === 'cash' || assetClass === 'alternative')
    return assetClass
  return ''
}

/**
 * 허용된 상품 형태 값을 정리합니다.
 * @param {unknown} value 상품 형태 값입니다.
 * @returns {types.SeedLabAssetType | ''} 상품 형태입니다.
 */
function normalizeAssetType(value) {
  const assetType = cleanText(value)
  if (
    assetType === 'stock'
    || assetType === 'etf'
    || assetType === 'bond'
    || assetType === 'index'
    || assetType === 'cash'
    || assetType === 'fund'
  )
    return assetType
  return ''
}

/**
 * 키워드 포함 여부를 확인합니다.
 * @param {string} text 검색 문자열입니다.
 * @param {string[]} keywords 키워드 목록입니다.
 * @returns {boolean} 포함 여부입니다.
 */
function hasKeyword(text, keywords) {
  for (let index = 0; index < keywords.length; index += 1) {
    if (text.indexOf(keywords[index]) >= 0) return true
  }
  return false
}

/**
 * 분류 출처 값을 정리합니다.
 * @param {unknown} value 분류 출처입니다.
 * @param {types.SeedLabAssetClassification["classificationSource"]} fallback 기본 출처입니다.
 * @returns {types.SeedLabAssetClassification["classificationSource"]} 분류 출처입니다.
 */
function normalizeClassificationSource(value, fallback) {
  const source = cleanText(value)
  if (source === 'auto' || source === 'manual' || source === 'toss' || source === 'import') return source
  return fallback
}

/**
 * 종목 정보를 리밸런싱용 자산군으로 분류합니다.
 * @param {Record<string, any>} input 종목 정보입니다.
 * @returns {types.SeedLabAssetClassification} 분류 결과입니다.
 */
function classifyAsset(input) {
  const source = input || {}
  const explicitClass = normalizeAssetClass(source.assetClass)
  const explicitType = normalizeAssetType(source.assetType)
  const searchText = buildSearchText([
    source.symbol,
    source.name,
    source.displayName,
    source.productType,
    source.securityType,
    source.category,
  ])
  let assetType = explicitType || 'stock'
  let assetClass = explicitClass || 'equity'
  let confidence = explicitClass || explicitType ? 0.95 : 0.65

  if (!explicitType) {
    if (hasKeyword(searchText, ['CASH', '현금', '예수금', 'MMF', 'RP'])) assetType = 'cash'
    else if (hasKeyword(searchText, ['ETF', 'ETN'])) assetType = 'etf'
    else if (hasKeyword(searchText, ['BOND', '채권', '국채', '회사채', 'TREASURY'])) assetType = 'bond'
    else if (hasKeyword(searchText, ['FUND', '펀드', 'REIT', '리츠'])) assetType = 'fund'
    else if (hasKeyword(searchText, ['INDEX', '지수'])) assetType = 'index'
  }

  if (!explicitClass) {
    if (assetType === 'cash' || hasKeyword(searchText, ['CASH', '현금', '예수금', 'MMF', 'RP'])) {
      assetClass = 'cash'
      confidence = 0.9
    } else if (
      assetType === 'bond'
      || hasKeyword(searchText, ['BOND', '채권', '국채', '회사채', 'TREASURY', 'TLT', 'IEF', 'SHY'])
    ) {
      assetClass = 'fixed_income'
      confidence = assetType === 'etf' ? 0.8 : 0.9
    } else if (hasKeyword(searchText, ['GOLD', '금', '원자재', 'COMMODITY', 'REIT', '리츠'])) {
      assetClass = 'alternative'
      confidence = 0.75
    } else {
      assetClass = 'equity'
      confidence = assetType === 'stock' ? 0.9 : 0.7
    }
  }

  return {
    assetType,
    assetClass,
    classificationSource: normalizeClassificationSource(
      source.classificationSource,
      explicitClass || explicitType ? 'manual' : 'auto'
    ),
    classificationConfidence: confidence,
  }
}

module.exports = {
  classifyAsset,
  normalizeAssetClass,
  normalizeAssetType,
}
