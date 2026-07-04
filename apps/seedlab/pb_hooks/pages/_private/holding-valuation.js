'use strict'

/**
 * 숫자 값을 정리합니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {number} 숫자 값입니다.
 */
function readNumber(value) {
  const number = Number(value || 0)
  return isFinite(number) ? number : 0
}

/**
 * 일반 객체를 읽습니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {Record<string, any>} 객체 값입니다.
 */
function readObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch (_exception) {
      return {}
    }
  }
  return {}
}

/**
 * 객체 필드 존재 여부를 확인합니다.
 * @param {Record<string, any>} source 확인할 객체입니다.
 * @param {string} key 필드 이름입니다.
 * @returns {boolean} 값 존재 여부입니다.
 */
function hasOwnValue(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null
}

/**
 * 수량과 단가로 달러 기준 금액을 계산합니다.
 * @param {Record<string, any>} raw 원본 보유 종목입니다.
 * @param {string} sourceKey 금액 종류입니다.
 * @returns {number} 달러 기준 금액입니다.
 */
function readUsdAmountFromPrice(raw, sourceKey) {
  const quantity = readNumber(raw.quantity)
  const lastPrice = readNumber(raw.lastPrice)
  const averagePrice = readNumber(raw.averagePurchasePrice)

  if (sourceKey === 'marketValueSource' && quantity > 0 && lastPrice > 0) return quantity * lastPrice
  if (sourceKey === 'costAmountSource' && quantity > 0 && averagePrice > 0) return quantity * averagePrice
  if (sourceKey === 'profitLossSource' && quantity > 0 && lastPrice > 0 && averagePrice > 0) return (lastPrice - averagePrice) * quantity
  return 0
}

/**
 * 원화값이 달러 원본 필드에 들어간 과거 데이터를 판별합니다.
 * @param {number} amount 저장된 원본 금액입니다.
 * @param {number} expectedUsdAmount 가격 기반 달러 금액입니다.
 * @returns {boolean} 원화로 보이는지 여부입니다.
 */
function looksLikeKrwSourceAmount(amount, expectedUsdAmount) {
  const value = Math.abs(readNumber(amount))
  const expectedUsd = Math.abs(readNumber(expectedUsdAmount))
  if (value <= 0 || expectedUsd <= 0) return false
  return value > expectedUsd * 20
}

/**
 * 달러 원본 금액을 읽습니다.
 * @param {types.SeedLabValuationSourceInput | undefined} input 원본 금액 입력입니다.
 * @returns {number} 달러 원본 금액입니다.
 */
function readUsdSourceAmount(input) {
  /** @type {types.SeedLabValuationSourceInput} */
  const safeInput = input || { sourceKey: '' }
  const raw = readObject(safeInput.raw)
  const seedlab = readObject(raw.seedlab)
  const sourceKey = String(safeInput.sourceKey || '')
  const priceAmount = readUsdAmountFromPrice(raw, sourceKey)

  if (sourceKey && hasOwnValue(seedlab, sourceKey)) {
    const sourceAmount = readNumber(seedlab[sourceKey])
    return looksLikeKrwSourceAmount(sourceAmount, priceAmount) ? priceAmount : sourceAmount
  }

  return priceAmount
}

/**
 * 보유 종목 금액을 원화 기준으로 읽습니다.
 * @param {types.SeedLabValuationAmountInput | undefined} input 평가금 입력입니다.
 * @returns {number} 원화 기준 금액입니다.
 */
function readKrwAmount(input) {
  /** @type {types.SeedLabValuationAmountInput} */
  const safeInput = input || { sourceKey: '', krwKey: '' }
  const currency = String(safeInput.currency || 'KRW')
  const storedAmount = readNumber(safeInput.storedAmount)
  if (currency !== 'USD') return storedAmount

  const raw = readObject(safeInput.raw)
  const seedlab = readObject(raw.seedlab)
  const krwKey = String(safeInput.krwKey || '')
  const krwAmount = krwKey && hasOwnValue(seedlab, krwKey) ? readNumber(seedlab[krwKey]) : 0
  if (krwAmount !== 0) return krwAmount

  const exchangeRate = readNumber(seedlab.exchangeRate || safeInput.latestUsdKrwRate)
  const sourceAmount = readUsdSourceAmount({
    raw,
    sourceKey: safeInput.sourceKey,
  })
  if (sourceAmount !== 0 && exchangeRate > 0) return sourceAmount * exchangeRate

  return storedAmount
}

module.exports = {
  readKrwAmount,
  readUsdSourceAmount,
}
