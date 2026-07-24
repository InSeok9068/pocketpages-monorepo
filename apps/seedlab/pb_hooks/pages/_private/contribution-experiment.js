'use strict'

const allocationBuckets = require('./allocation-buckets')

/**
 * 숫자 값을 읽습니다.
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
 * 비율 값을 반올림합니다.
 * @param {number} value 원본 값입니다.
 * @returns {number} 비율 값입니다.
 */
function roundPct(value) {
  return Math.round(readNumber(value) * 10) / 10
}

/**
 * 금액 값을 반올림합니다.
 * @param {number} value 원본 값입니다.
 * @returns {number} 금액 값입니다.
 */
function roundAmount(value) {
  return Math.round(readNumber(value))
}

/**
 * 소수 수량을 정리합니다.
 * @param {number} value 원본 수량입니다.
 * @returns {number} 수량 값입니다.
 */
function roundFractionalQuantity(value) {
  return Math.floor(readNumber(value) * 1000000) / 1000000
}

/**
 * 통화 값을 정리합니다.
 * @param {unknown} value 원본 통화입니다.
 * @returns {string} 통화입니다.
 */
function normalizeCurrency(value) {
  const currency = String(value || 'KRW')
    .trim()
    .toUpperCase()
  return currency === 'USD' ? 'USD' : 'KRW'
}

/**
 * 가격 변경률을 적용합니다.
 * @param {number} price 원본 가격입니다.
 * @param {number} changePct 변경률입니다.
 * @returns {number} 변경 가격입니다.
 */
function applyPriceChange(price, changePct) {
  const sourcePrice = readNumber(price)
  const multiplier = 1 + readNumber(changePct) / 100
  return sourcePrice > 0 && multiplier > 0 ? sourcePrice * multiplier : sourcePrice
}

/**
 * 보유 종목 가격 기준을 만듭니다.
 * @param {Record<string, any>} holding 보유 종목입니다.
 * @param {Record<string, any>} priceOverrides 가격 재조회 값입니다.
 * @param {number} priceChangePct 가격 변경률입니다.
 * @param {number} usdKrwRate USD/KRW 환율입니다.
 * @returns {Record<string, any>} 가격 기준입니다.
 */
function buildPriceBasis(holding, priceOverrides, priceChangePct, usdKrwRate) {
  const symbol = String(holding.symbol || '').toUpperCase()
  const currency = normalizeCurrency(holding.currency)
  const overrides = readObject(priceOverrides)
  const rawOverride = readObject(overrides[symbol])
  const overridePrice = readNumber(rawOverride.price)
  const sourcePrice = overridePrice > 0 ? overridePrice : readNumber(holding.currentPrice)
  const changedPrice = applyPriceChange(sourcePrice, priceChangePct)
  const exchangeRate = currency === 'USD' ? readNumber(rawOverride.exchangeRate || usdKrwRate) : 1
  const priceKrw = currency === 'USD' ? changedPrice * exchangeRate : changedPrice

  return {
    currency,
    sourcePrice,
    price: changedPrice,
    priceKrw,
    exchangeRate,
    source: overridePrice > 0 ? 'refresh' : 'stored',
  }
}

/**
 * 자산군별 보유 종목을 고릅니다.
 * @param {Record<string, any>[]} holdings 보유 종목 목록입니다.
 * @param {string} bucketKey 자산군 키입니다.
 * @param {Record<string, string>} preferredHoldingIds 자산군별 선택 종목입니다.
 * @returns {Record<string, any> | null} 매수 대상입니다.
 */
function pickHoldingForBucket(holdings, bucketKey, preferredHoldingIds) {
  const preferredHoldingId = String(readObject(preferredHoldingIds)[bucketKey] || '')
  let selected = null

  for (let index = 0; index < holdings.length; index += 1) {
    const holding = holdings[index]
    if (allocationBuckets.normalizeBucket(holding.allocationBucket) !== bucketKey) continue
    if (preferredHoldingId && String(holding.holdingId || '') === preferredHoldingId) return holding
    if (!selected || readNumber(holding.marketValueKrw) > readNumber(selected.marketValueKrw)) selected = holding
  }

  return selected
}

/**
 * 자산군별 현재 값을 계산합니다.
 * @param {Record<string, any>[]} holdings 보유 종목 목록입니다.
 * @param {number} cashValue 현금 금액입니다.
 * @returns {Record<string, any>} 현재 값입니다.
 */
function buildCurrentState(holdings, cashValue) {
  const buckets = allocationBuckets.listBuckets()
  const totals = {}
  let holdingTotal = 0

  for (let index = 0; index < buckets.length; index += 1) {
    totals[buckets[index].key] = 0
  }

  for (let index = 0; index < holdings.length; index += 1) {
    const holding = holdings[index]
    const bucket = allocationBuckets.normalizeBucket(holding.allocationBucket) || 'other'
    const value = readNumber(holding.marketValueKrw)
    totals[bucket] += value
    holdingTotal += value
  }

  totals.cash += readNumber(cashValue)

  return {
    totals,
    totalValue: holdingTotal + readNumber(cashValue),
  }
}

/**
 * 추가금 배분 예산을 계산합니다.
 * @param {Record<string, number>} currentTotals 현재 자산군 금액입니다.
 * @param {Record<string, number>} targets 목표 비중입니다.
 * @param {number} currentTotal 현재 총액입니다.
 * @param {number} contributionAmount 추가금입니다.
 * @param {number} investableAmount 매수에 쓸 금액입니다.
 * @returns {Record<string, any>} 배분 예산입니다.
 */
function allocateContribution(currentTotals, targets, currentTotal, contributionAmount, investableAmount) {
  const buckets = allocationBuckets.listBuckets()
  const futureTotal = readNumber(currentTotal) + readNumber(contributionAmount)
  const budgetAmount = Math.max(0, readNumber(investableAmount))
  const shortages = {}
  const budgets = {}
  let shortageTotal = 0

  for (let index = 0; index < buckets.length; index += 1) {
    const key = buckets[index].key
    const targetPct = readNumber(targets[key])
    const targetValue = futureTotal * (targetPct / 100)
    const shortage = Math.max(0, targetValue - readNumber(currentTotals[key]))
    shortages[key] = shortage
    budgets[key] = 0
    shortageTotal += shortage
  }

  if (shortageTotal <= 0) {
    budgets.cash = budgetAmount
    return { futureTotal, shortages, budgets }
  }

  for (let index = 0; index < buckets.length; index += 1) {
    const key = buckets[index].key
    budgets[key] = budgetAmount * (readNumber(shortages[key]) / shortageTotal)
  }

  return { futureTotal, shortages, budgets }
}

/**
 * 자산군 비교 값을 만듭니다.
 * @param {Record<string, number>} beforeTotals 현재 금액입니다.
 * @param {Record<string, number>} afterTotals 매수 후 금액입니다.
 * @param {Record<string, number>} targets 목표 비중입니다.
 * @param {number} beforeTotal 현재 총액입니다.
 * @param {number} afterTotal 매수 후 총액입니다.
 * @returns {Record<string, any>} 비교 결과입니다.
 */
function buildBucketResults(beforeTotals, afterTotals, targets, beforeTotal, afterTotal) {
  const buckets = allocationBuckets.listBuckets()
  const results = []
  let maxBeforeDriftPct = 0
  let maxAfterDriftPct = 0

  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]
    const key = bucket.key
    const beforeValue = readNumber(beforeTotals[key])
    const afterValue = readNumber(afterTotals[key])
    const targetPct = readNumber(targets[key])
    const beforePct = beforeTotal > 0 ? roundPct((beforeValue / beforeTotal) * 100) : 0
    const afterPct = afterTotal > 0 ? roundPct((afterValue / afterTotal) * 100) : 0
    const beforeDriftPct = roundPct(beforePct - targetPct)
    const afterDriftPct = roundPct(afterPct - targetPct)

    maxBeforeDriftPct = Math.max(maxBeforeDriftPct, Math.abs(beforeDriftPct))
    maxAfterDriftPct = Math.max(maxAfterDriftPct, Math.abs(afterDriftPct))

    if (beforeValue > 0 || afterValue > 0 || targetPct > 0) {
      results.push({
        key,
        label: bucket.label,
        color: bucket.color,
        tone: bucket.tone,
        targetPct,
        beforePct,
        afterPct,
        beforeValue: roundAmount(beforeValue),
        afterValue: roundAmount(afterValue),
        beforeDriftPct,
        afterDriftPct,
        targetValue: roundAmount(afterTotal * (targetPct / 100)),
        remainingAmount: roundAmount(afterTotal * (targetPct / 100) - afterValue),
      })
    }
  }

  return {
    buckets: results,
    maxBeforeDriftPct: roundPct(maxBeforeDriftPct),
    maxAfterDriftPct: roundPct(maxAfterDriftPct),
  }
}

/**
 * 추가 투자 실험을 계산합니다.
 * @param {Record<string, any>} input 계산 입력입니다.
 * @returns {Record<string, any>} 계산 결과입니다.
 */
function buildContributionExperiment(input) {
  const safeInput = input || {}
  const holdings = Array.isArray(safeInput.holdings) ? safeInput.holdings : []
  const targets = readObject(safeInput.targets)
  const contributionAmount = readNumber(safeInput.contributionAmount)
  const preferredHoldingIds = readObject(safeInput.preferredHoldingIds)
  const reserveCashAmount = Math.min(contributionAmount, Math.max(0, readNumber(safeInput.reserveCashAmount)))
  const investableAmount = Math.max(0, contributionAmount - reserveCashAmount)
  const minimumOrderAmount = Math.max(0, readNumber(safeInput.minimumOrderAmount))
  const priceOverrides = readObject(safeInput.priceOverrides)
  const priceChangePct = readNumber(safeInput.priceChangePct)
  const latestUsdKrwRate = readNumber(safeInput.latestUsdKrwRate)
  const current = buildCurrentState(holdings, safeInput.cashValue)
  const allocation = allocateContribution(
    current.totals,
    targets,
    current.totalValue,
    contributionAmount,
    investableAmount
  )
  const afterTotals = Object.assign({}, current.totals)
  const buckets = allocationBuckets.listBuckets()
  const candidates = []
  let usedAmount = 0
  let unassignedAmount = 0
  afterTotals.cash += reserveCashAmount
  unassignedAmount += reserveCashAmount

  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]
    const budget = readNumber(allocation.budgets[bucket.key])
    if (budget <= 0) continue

    if (bucket.key === 'cash') {
      afterTotals.cash += budget
      unassignedAmount += budget
      continue
    }

    const holding = pickHoldingForBucket(holdings, bucket.key, preferredHoldingIds)
    if (!holding) {
      unassignedAmount += budget
      candidates.push({
        bucketKey: bucket.key,
        bucketLabel: bucket.label,
        missingReason: 'bucket_holding_missing',
        budgetKrw: roundAmount(budget),
        spendKrw: 0,
        quantity: 0,
      })
      continue
    }

    const priceBasis = buildPriceBasis(holding, priceOverrides, priceChangePct, latestUsdKrwRate)
    if (priceBasis.priceKrw <= 0) {
      unassignedAmount += budget
      candidates.push({
        holdingId: holding.holdingId,
        accountId: holding.accountId,
        assetId: holding.assetId,
        symbol: holding.symbol,
        name: holding.name,
        bucketKey: bucket.key,
        bucketLabel: bucket.label,
        currency: priceBasis.currency,
        missingReason: 'price_missing',
        budgetKrw: roundAmount(budget),
        spendKrw: 0,
        quantity: 0,
      })
      continue
    }

    const quantity =
      priceBasis.currency === 'USD'
        ? roundFractionalQuantity(budget / priceBasis.priceKrw)
        : Math.floor(budget / priceBasis.priceKrw)
    const spendKrw = quantity > 0 ? quantity * priceBasis.priceKrw : 0
    const leftover = Math.max(0, budget - spendKrw)

    if (minimumOrderAmount > 0 && spendKrw > 0 && spendKrw < minimumOrderAmount) {
      afterTotals.cash += budget
      unassignedAmount += budget
      candidates.push({
        holdingId: holding.holdingId,
        accountId: holding.accountId,
        assetId: holding.assetId,
        symbol: holding.symbol,
        name: holding.name,
        bucketKey: bucket.key,
        bucketLabel: bucket.label,
        currency: priceBasis.currency,
        missingReason: 'below_minimum_order',
        budgetKrw: roundAmount(budget),
        price: priceBasis.price,
        priceKrw: roundAmount(priceBasis.priceKrw),
        exchangeRate: priceBasis.exchangeRate,
        quantity: 0,
        spendKrw: 0,
        calculatedQuantity: quantity,
        calculatedSpendKrw: roundAmount(spendKrw),
      })
      continue
    }

    afterTotals[bucket.key] += spendKrw
    afterTotals.cash += leftover
    usedAmount += spendKrw
    unassignedAmount += leftover
    candidates.push({
      holdingId: holding.holdingId,
      accountId: holding.accountId,
      assetId: holding.assetId,
      symbol: holding.symbol,
      name: holding.name,
      bucketKey: bucket.key,
      bucketLabel: bucket.label,
      currency: priceBasis.currency,
      budgetKrw: roundAmount(budget),
      price: priceBasis.price,
      priceKrw: roundAmount(priceBasis.priceKrw),
      exchangeRate: priceBasis.exchangeRate,
      quantity,
      spendKrw: roundAmount(spendKrw),
      leftoverKrw: roundAmount(leftover),
      priceSource: priceBasis.source,
      missingReason: '',
    })
  }

  const afterTotal = current.totalValue + contributionAmount
  const comparison = buildBucketResults(current.totals, afterTotals, targets, current.totalValue, afterTotal)

  return {
    experimentType: 'contribution_rebalance',
    currentTotalValue: roundAmount(current.totalValue),
    contributionAmount: roundAmount(contributionAmount),
    investableAmount: roundAmount(investableAmount),
    reserveCashAmount: roundAmount(reserveCashAmount),
    minimumOrderAmount: roundAmount(minimumOrderAmount),
    preferredHoldingIds,
    afterTotalValue: roundAmount(afterTotal),
    usedAmount: roundAmount(usedAmount),
    leftoverCash: roundAmount(contributionAmount - usedAmount),
    unassignedAmount: roundAmount(unassignedAmount),
    priceChangePct,
    latestUsdKrwRate,
    candidateCount: candidates.length,
    actionableCount: candidates.filter(function (candidate) {
      return readNumber(candidate.spendKrw) > 0 && readNumber(candidate.quantity) > 0 && !candidate.missingReason
    }).length,
    maxBeforeDriftPct: comparison.maxBeforeDriftPct,
    maxAfterDriftPct: comparison.maxAfterDriftPct,
    buckets: comparison.buckets,
    candidates,
  }
}

/**
 * 월별 수익률을 계산합니다.
 * @param {number} annualReturnPct 연 수익률입니다.
 * @returns {number} 월 수익률입니다.
 */
function monthlyReturnRate(annualReturnPct) {
  return Math.pow(1 + readNumber(annualReturnPct) / 100, 1 / 12) - 1
}

/**
 * 자산군별 기본 연수익률을 만듭니다.
 * @returns {Record<string, number>} 연수익률입니다.
 */
function defaultAnnualReturnPcts() {
  return {
    cash: 2,
    growth_stock: 7,
    dividend_stock: 5,
    bond: 3,
    gold: 2,
    real_estate: 3,
    other: 0,
  }
}

/**
 * 자산군별 연수익률을 정리합니다.
 * @param {Record<string, any>} input 입력값입니다.
 * @returns {Record<string, number>} 연수익률입니다.
 */
function normalizeAnnualReturnPcts(input) {
  const defaults = defaultAnnualReturnPcts()
  const source = readObject(input)
  const buckets = allocationBuckets.listBuckets()

  for (let index = 0; index < buckets.length; index += 1) {
    const key = buckets[index].key
    if (Object.prototype.hasOwnProperty.call(source, key)) defaults[key] = readNumber(source[key])
  }

  return defaults
}

/**
 * 월별 자산 비중을 만듭니다.
 * @param {Record<string, number>} totals 자산군 금액입니다.
 * @param {number} totalValue 총액입니다.
 * @returns {Record<string, number>} 자산군 비중입니다.
 */
function buildAssetWeights(totals, totalValue) {
  const buckets = allocationBuckets.listBuckets()
  /** @type {Record<string, number>} */
  const weights = {}

  for (let index = 0; index < buckets.length; index += 1) {
    const key = buckets[index].key
    weights[key] = totalValue > 0 ? roundPct((readNumber(totals[key]) / totalValue) * 100) : 0
  }

  return weights
}

/**
 * 월별 추가금을 자산군에 배분합니다.
 * @param {Record<string, number>} totals 현재 자산군 금액입니다.
 * @param {Record<string, number>} targets 목표 비중입니다.
 * @param {number} depositAmount 납입금입니다.
 * @param {number} reserveAmount 현금으로 둘 금액입니다.
 * @param {number} minimumOrderAmount 최소 주문 금액입니다.
 * @returns {Record<string, any>} 배분 결과입니다.
 */
function applyMonthlyDeposit(totals, targets, depositAmount, reserveAmount, minimumOrderAmount) {
  const totalBeforeDeposit = Object.keys(totals).reduce(function (sum, key) {
    return sum + readNumber(totals[key])
  }, 0)
  const deposit = Math.max(0, readNumber(depositAmount))
  const reserve = Math.min(deposit, Math.max(0, readNumber(reserveAmount)))
  const investableAmount = Math.max(0, deposit - reserve)
  const allocation = allocateContribution(totals, targets, totalBeforeDeposit, deposit, investableAmount)
  const buckets = allocationBuckets.listBuckets()
  const buys = []
  let usedAmount = 0
  let cashAmount = reserve

  totals.cash = readNumber(totals.cash) + reserve

  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]
    const budget = readNumber(allocation.budgets[bucket.key])
    if (budget <= 0) continue

    if (bucket.key === 'cash') {
      totals.cash += budget
      cashAmount += budget
      continue
    }

    if (minimumOrderAmount > 0 && budget < minimumOrderAmount) {
      totals.cash += budget
      cashAmount += budget
      buys.push({
        bucketKey: bucket.key,
        bucketLabel: bucket.label,
        amount: 0,
        skippedAmount: roundAmount(budget),
        reason: 'below_minimum_order',
      })
      continue
    }

    totals[bucket.key] = readNumber(totals[bucket.key]) + budget
    usedAmount += budget
    buys.push({
      bucketKey: bucket.key,
      bucketLabel: bucket.label,
      amount: roundAmount(budget),
      skippedAmount: 0,
      reason: '',
    })
  }

  return {
    usedAmount: roundAmount(usedAmount),
    cashAmount: roundAmount(cashAmount),
    buys,
  }
}

/**
 * 월별 수익률을 자산군에 반영합니다.
 * @param {Record<string, number>} totals 자산군 금액입니다.
 * @param {Record<string, number>} annualReturnPcts 연수익률입니다.
 */
function applyMonthlyReturns(totals, annualReturnPcts) {
  const buckets = allocationBuckets.listBuckets()

  for (let index = 0; index < buckets.length; index += 1) {
    const key = buckets[index].key
    totals[key] = readNumber(totals[key]) * (1 + monthlyReturnRate(annualReturnPcts[key]))
  }
}

/**
 * 시간 흐름 실험을 계산합니다.
 * @param {Record<string, any>} input 계산 입력입니다.
 * @returns {Record<string, any>} 시간 흐름 결과입니다.
 */
function buildTimelineExperiment(input) {
  const safeInput = input || {}
  const holdings = Array.isArray(safeInput.holdings) ? safeInput.holdings : []
  const targets = readObject(safeInput.targets)
  const annualReturnPcts = normalizeAnnualReturnPcts(safeInput.annualReturnPcts)
  const projectionMonths = Math.max(1, Math.min(360, Math.floor(readNumber(safeInput.projectionMonths) || 12)))
  const initialContributionAmount = Math.max(0, readNumber(safeInput.contributionAmount))
  const monthlyContributionAmount = Math.max(0, readNumber(safeInput.monthlyContributionAmount))
  const reserveCashAmount = Math.max(0, readNumber(safeInput.reserveCashAmount))
  const minimumOrderAmount = Math.max(0, readNumber(safeInput.minimumOrderAmount))
  const current = buildCurrentState(holdings, safeInput.cashValue)
  const totals = Object.assign({}, current.totals)
  const snapshots = []
  let investedAmount = current.totalValue
  let peakValue = current.totalValue
  let totalBuyAmount = 0

  snapshots.push({
    month: 0,
    depositAmount: 0,
    buyAmount: 0,
    investedAmount: roundAmount(investedAmount),
    totalValue: roundAmount(current.totalValue),
    cashValue: roundAmount(totals.cash),
    profitLoss: 0,
    drawdownPct: 0,
    assetWeights: buildAssetWeights(totals, current.totalValue),
    bucketValues: Object.assign({}, totals),
    buys: [],
  })

  for (let month = 1; month <= projectionMonths; month += 1) {
    const depositAmount = month === 1 ? initialContributionAmount : monthlyContributionAmount
    const depositResult = applyMonthlyDeposit(
      totals,
      targets,
      depositAmount,
      month === 1 ? reserveCashAmount : 0,
      minimumOrderAmount
    )
    investedAmount += depositAmount
    totalBuyAmount += depositResult.usedAmount
    applyMonthlyReturns(totals, annualReturnPcts)

    const totalValue = Object.keys(totals).reduce(function (sum, key) {
      return sum + readNumber(totals[key])
    }, 0)
    peakValue = Math.max(peakValue, totalValue)
    const profitLoss = totalValue - investedAmount
    const drawdownPct = peakValue > 0 ? roundPct(((totalValue - peakValue) / peakValue) * 100) : 0

    snapshots.push({
      month,
      depositAmount: roundAmount(depositAmount),
      buyAmount: depositResult.usedAmount,
      cashAddedAmount: depositResult.cashAmount,
      investedAmount: roundAmount(investedAmount),
      totalValue: roundAmount(totalValue),
      cashValue: roundAmount(totals.cash),
      profitLoss: roundAmount(profitLoss),
      drawdownPct,
      assetWeights: buildAssetWeights(totals, totalValue),
      bucketValues: Object.assign({}, totals),
      buys: depositResult.buys,
    })
  }

  const finalSnapshot = snapshots[snapshots.length - 1]
  const finalProfitLoss = readNumber(finalSnapshot.profitLoss)
  const returnPct = investedAmount > 0 ? roundPct((finalProfitLoss / investedAmount) * 100) : 0

  return {
    experimentType: 'timeline_rebalance',
    projectionMonths,
    initialTotalValue: roundAmount(current.totalValue),
    initialContributionAmount: roundAmount(initialContributionAmount),
    monthlyContributionAmount: roundAmount(monthlyContributionAmount),
    reserveCashAmount: roundAmount(reserveCashAmount),
    minimumOrderAmount: roundAmount(minimumOrderAmount),
    annualReturnPcts,
    finalTotalValue: finalSnapshot.totalValue,
    investedAmount: roundAmount(investedAmount),
    totalBuyAmount: roundAmount(totalBuyAmount),
    finalProfitLoss: roundAmount(finalProfitLoss),
    returnPct,
    maxDrawdownPct: snapshots.reduce(function (value, snapshot) {
      return Math.min(value, readNumber(snapshot.drawdownPct))
    }, 0),
    finalAssetWeights: finalSnapshot.assetWeights,
    snapshots,
  }
}

module.exports = {
  buildContributionExperiment,
  buildTimelineExperiment,
  defaultAnnualReturnPcts,
  readNumber,
  readObject,
}
