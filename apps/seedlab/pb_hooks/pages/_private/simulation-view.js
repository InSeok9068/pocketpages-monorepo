'use strict'

const allocationBuckets = require('./allocation-buckets')

/**
 * JSON 문자열을 객체로 읽습니다.
 * @param {unknown} value 원본 문자열입니다.
 * @returns {Record<string, any>} 객체 값입니다.
 */
function parseObjectText(value) {
  const text = String(value || '').trim()
  if (!text || text.indexOf('{') !== 0) return {}

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch (_exception) {
    return {}
  }

  return {}
}

/**
 * UTF-8 바이트 배열을 문자열로 읽습니다.
 * @param {unknown[]} value 원본 배열입니다.
 * @returns {string} 문자열입니다.
 */
function decodeUtf8Bytes(value) {
  let text = ''

  for (let index = 0; index < value.length; index += 1) {
    const first = Number(value[index] || 0)
    if (!isFinite(first) || first < 0) return ''

    if (first < 0x80) {
      text += String.fromCharCode(first)
      continue
    }

    if ((first & 0xe0) === 0xc0) {
      const second = Number(value[index + 1] || 0)
      if ((second & 0xc0) !== 0x80) return ''
      text += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f))
      index += 1
      continue
    }

    if ((first & 0xf0) === 0xe0) {
      const second = Number(value[index + 1] || 0)
      const third = Number(value[index + 2] || 0)
      if ((second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) return ''
      text += String.fromCharCode(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f))
      index += 2
      continue
    }

    if ((first & 0xf8) === 0xf0) {
      const second = Number(value[index + 1] || 0)
      const third = Number(value[index + 2] || 0)
      const fourth = Number(value[index + 3] || 0)
      if ((second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 || (fourth & 0xc0) !== 0x80) return ''
      let codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
      codePoint -= 0x10000
      text += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff))
      index += 3
      continue
    }

    return ''
  }

  return text
}

/**
 * JSON 바이트 배열을 객체로 읽습니다.
 * @param {unknown[]} value 원본 배열입니다.
 * @returns {Record<string, any>} 객체 값입니다.
 */
function parseObjectBytes(value) {
  if (!Array.isArray(value) || value.length === 0) return {}
  return parseObjectText(decodeUtf8Bytes(value))
}

/**
 * 객체 값을 읽습니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {Record<string, any>} 객체 값입니다.
 */
function readObject(value) {
  if (!value) return {}
  if (typeof value === 'string') return parseObjectText(value)
  if (Array.isArray(value)) return parseObjectBytes(value)

  if (typeof value === 'object') {
    const objectValue = /** @type {Record<string, any>} */ (value)
    if (typeof objectValue.experimentType !== 'undefined' || typeof objectValue.timeline !== 'undefined') return objectValue
    if (typeof objectValue.string === 'function') {
      const parsedString = parseObjectText(objectValue.string())
      if (Object.keys(parsedString).length > 0) return parsedString
    }
    if (typeof objectValue.marshalJSON === 'function') {
      const marshaled = objectValue.marshalJSON()
      const parsedMarshaled = Array.isArray(marshaled) ? parseObjectBytes(marshaled) : parseObjectText(marshaled)
      if (Object.keys(parsedMarshaled).length > 0) return parsedMarshaled
    }
    if (typeof objectValue.value === 'function') {
      const rawValue = objectValue.value()
      const parsedValue = Array.isArray(rawValue) ? parseObjectBytes(rawValue) : parseObjectText(rawValue)
      if (Object.keys(parsedValue).length > 0) return parsedValue
    }
    if (typeof objectValue.raw === 'string') {
      const parsedRaw = parseObjectText(objectValue.raw)
      if (Object.keys(parsedRaw).length > 0) return parsedRaw
    }
    if (typeof objectValue.value === 'string') {
      const parsedValue = parseObjectText(objectValue.value)
      if (Object.keys(parsedValue).length > 0) return parsedValue
    }

    const text = String(value || '').trim()
    if (text && text !== '[object Object]') {
      const parsedText = parseObjectText(text)
      if (Object.keys(parsedText).length > 0) return parsedText
    }

    try {
      const serialized = JSON.stringify(value)
      const parsedSerialized = parseObjectText(serialized)
      if (Object.keys(parsedSerialized).length > 0) return parsedSerialized
    } catch (_exception) {
      return {}
    }

    return Object.keys(objectValue).length > 0 ? objectValue : {}
  }

  return {}
}

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
 * 숫자를 표시합니다.
 * @param {unknown} value 원본 값입니다.
 * @param {number} maximumFractionDigits 최대 소수 자리입니다.
 * @returns {string} 표시 숫자입니다.
 */
function formatNumber(value, maximumFractionDigits) {
  const number = readNumber(value)
  const sign = number < 0 ? '-' : ''
  const fixed = Math.abs(number).toFixed(maximumFractionDigits)
  const parts = fixed.split('.')
  const decimal = String(parts[1] || '').replace(/0+$/, '')
  let integer = parts[0]
  let formattedInteger = ''

  while (integer.length > 3) {
    formattedInteger = ',' + integer.slice(-3) + formattedInteger
    integer = integer.slice(0, -3)
  }

  return sign + integer + formattedInteger + (decimal ? '.' + decimal : '')
}

/**
 * 금액을 표시합니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 금액 문자열입니다.
 */
function formatAmount(value) {
  return formatNumber(value, 0)
}

/**
 * 비율을 표시합니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 비율 문자열입니다.
 */
function formatPct(value) {
  return formatNumber(value, 1) + '%'
}

function signedAmount(value) {
  const number = readNumber(value)
  return (number > 0 ? '+' : '') + formatAmount(number)
}

function signedPct(value) {
  const number = readNumber(value)
  return (number > 0 ? '+' : '') + formatPct(number)
}

function quantityText(value) {
  const number = readNumber(value)
  if (number <= 0) return ''
  return formatNumber(number, 6) + '주'
}

function candidateReasonText(reason) {
  const labels = {
    bucket_holding_missing: '종목 선택 필요',
    price_missing: '현재가 없음',
    below_minimum_order: '최소 주문 미달',
  }

  return labels[String(reason || '')] || '후보 제외'
}

function firstSnapshot(timeline) {
  const snapshots = Array.isArray(timeline.snapshots) ? timeline.snapshots : []
  return snapshots.length > 0 ? readObject(snapshots[0]) : {}
}

function lastSnapshot(timeline) {
  const snapshots = Array.isArray(timeline.snapshots) ? timeline.snapshots : []
  return snapshots.length > 0 ? readObject(snapshots[snapshots.length - 1]) : {}
}

function bucketTargetText(buckets) {
  const rows = []
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]
    const targetPct = readNumber(bucket.targetPct)
    if (targetPct <= 0) continue
    rows.push(bucket.label.replace('주식(', '').replace(')', '') + ' ' + formatPct(targetPct))
  }
  return rows.slice(0, 4).join(' / ')
}

function buildBucketRows(summary, timeline) {
  const summaryBuckets = Array.isArray(summary.buckets) ? summary.buckets : []
  const finalSnapshot = lastSnapshot(timeline)
  const finalWeights = readObject(timeline.finalAssetWeights || finalSnapshot.assetWeights)
  const finalValues = readObject(finalSnapshot.bucketValues)
  const rows = []

  for (let index = 0; index < summaryBuckets.length; index += 1) {
    const bucket = readObject(summaryBuckets[index])
    const key = String(bucket.key || '')
    const meta = allocationBuckets.bucketMeta(key)
    const currentPct = readNumber(bucket.beforePct)
    const finalPct = readNumber(finalWeights[key] || bucket.afterPct)
    const targetPct = readNumber(bucket.targetPct)
    const driftPct = Math.round((finalPct - targetPct) * 10) / 10
    const currentValue = readNumber(bucket.beforeValue)
    const finalValue = readNumber(finalValues[key] || bucket.afterValue)

    if (currentValue <= 0 && finalValue <= 0 && targetPct <= 0) continue

    rows.push({
      key,
      label: meta.label,
      color: meta.color,
      tone: meta.tone,
      currentPct,
      finalPct,
      targetPct,
      driftPct,
      currentPctText: formatPct(currentPct),
      finalPctText: formatPct(finalPct),
      targetPctText: formatPct(targetPct),
      driftPctText: signedPct(driftPct),
      currentValueText: formatAmount(currentValue) + '원',
      finalValueText: formatAmount(finalValue) + '원',
      barWidth: Math.max(2, Math.min(100, finalPct)),
      driftTone: driftPct > 0 ? 'text-[#f04452]' : driftPct < 0 ? 'text-[#1b64da]' : 'text-[#4e5968]',
    })
  }

  return rows
}

function candidateAmountText(candidate, isActionable, spendKrw) {
  if (isActionable) return formatAmount(spendKrw) + '원'
  if (candidate.budgetKrw) return '배정 ' + formatAmount(candidate.budgetKrw) + '원'
  return '-'
}

function buildCandidateRows(candidates) {
  const rows = []
  const candidateRows = Array.isArray(candidates) ? candidates : []

  for (let index = 0; index < candidateRows.length; index += 1) {
    const candidate = readObject(candidateRows[index])
    const spendKrw = readNumber(candidate.spendKrw)
    const quantity = readNumber(candidate.quantity)
    const missingReason = String(candidate.missingReason || '')
    const isActionable = spendKrw > 0 && quantity > 0 && !missingReason
    const bucket = allocationBuckets.bucketMeta(candidate.bucketKey)
    const symbol = String(candidate.symbol || 'UNKNOWN')
    const name = String(candidate.name || '')

    rows.push({
      symbol,
      name,
      displayName: name || symbol,
      bucketLabel: bucket.label,
      statusText: isActionable ? '매수 후보' : candidateReasonText(missingReason),
      amountText: candidateAmountText(candidate, isActionable, spendKrw),
      quantityText: isActionable ? quantityText(quantity) : '',
      isActionable,
      tone: isActionable ? 'text-[#191f28]' : 'text-[#8b95a1]',
    })
  }

  return rows
}

function buildTimelineRows(timeline) {
  const snapshots = Array.isArray(timeline.snapshots) ? timeline.snapshots : []
  if (snapshots.length === 0) return []

  const indexes = [0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1]
  const seen = {}
  const rows = []

  for (let index = 0; index < indexes.length; index += 1) {
    const snapshotIndex = indexes[index]
    if (seen[snapshotIndex]) continue
    seen[snapshotIndex] = true

    const snapshot = readObject(snapshots[snapshotIndex])
    const month = readNumber(snapshot.month)
    const profitLoss = readNumber(snapshot.profitLoss)
    rows.push({
      label: month === 0 ? '현재' : formatNumber(month, 0) + '개월',
      totalText: formatAmount(snapshot.totalValue) + '원',
      profitText: signedAmount(profitLoss) + '원',
      tone: profitLoss >= 0 ? 'text-[#f04452]' : 'text-[#1b64da]',
    })
  }

  return rows
}

function returnAssumptionText(annualReturnPcts) {
  const growth = readNumber(readObject(annualReturnPcts).growth_stock)
  const dividend = readNumber(readObject(annualReturnPcts).dividend_stock)
  const bond = readNumber(readObject(annualReturnPcts).bond)
  return '성장 ' + formatPct(growth) + ' / 배당 ' + formatPct(dividend) + ' / 채권 ' + formatPct(bond)
}

/**
 * 실험 표시 모델을 만듭니다.
 * @param {Record<string, any>} record 실험 레코드입니다.
 * @returns {Record<string, any>} 표시 모델입니다.
 */
function buildSimulationModel(record) {
  const summary = readObject(record.get('summary'))
  const timeline = readObject(summary.timeline)
  const experimentType = String(summary.experimentType || '')
  const isTimelineExperiment = experimentType === 'timeline_rebalance'
  const isContributionExperiment = experimentType === 'contribution_rebalance'
  const first = firstSnapshot(timeline)
  const last = lastSnapshot(timeline)
  const bucketRows = buildBucketRows(summary, timeline)
  const candidateRows = buildCandidateRows(summary.candidates)
  const actionableCount = readNumber(summary.actionableCount)
  const finalProfitLoss = readNumber(timeline.finalProfitLoss)
  const currentTotal = readNumber(timeline.initialTotalValue || summary.currentTotalValue || first.totalValue)
  const finalTotal = readNumber(timeline.finalTotalValue || summary.afterTotalValue || last.totalValue)
  const projectionMonths = readNumber(timeline.projectionMonths || summary.projectionMonths)
  const monthlyContribution = readNumber(timeline.monthlyContributionAmount || summary.monthlyContributionAmount || record.get('monthlyContribution'))
  const contributionAmount = readNumber(summary.contributionAmount)
  const targetText = bucketTargetText(bucketRows)

  if (!isTimelineExperiment && !isContributionExperiment) {
    return {
      id: String(record.get('id') || ''),
      name: String(record.get('name') || '실험'),
      status: String(record.get('status') || 'ready'),
      isLegacy: true,
      badgeText: '저장됨',
      thesisText: '기존 계산',
      targetText: '상세 정보 없음',
      currentTotalText: '-',
      finalTotalText: '-',
      profitText: '-',
      profitValue: 0,
      returnText: '-',
      contributionText: '추가금 ' + formatAmount(record.get('monthlyContribution')) + '원',
      returnAssumptionText: '-',
      actionText: '후보 없음',
      actionCandidateCount: 0,
      bucketRows: [],
      candidateRows: [],
      timelineRows: [],
    }
  }

  return {
    id: String(record.get('id') || ''),
    name: String(record.get('name') || '추가 투자 실험'),
    status: String(record.get('status') || 'ready'),
    isLegacy: false,
    badgeText: projectionMonths > 0 ? formatAmount(projectionMonths) + '개월' : '계산됨',
    thesisText: '첫 달 ' + formatAmount(contributionAmount) + '원, 이후 월 ' + formatAmount(monthlyContribution) + '원',
    targetText: targetText || '목표 비중 없음',
    currentTotalText: formatAmount(currentTotal) + '원',
    finalTotalText: formatAmount(finalTotal) + '원',
    profitText: signedAmount(finalProfitLoss) + '원',
    profitValue: finalProfitLoss,
    returnText: formatPct(timeline.returnPct || 0),
    contributionText: '첫 달 ' + formatAmount(contributionAmount) + '원 · 월 ' + formatAmount(monthlyContribution) + '원',
    returnAssumptionText: returnAssumptionText(summary.annualReturnPcts),
    actionText: actionableCount > 0 ? '후보 ' + formatAmount(actionableCount) + '개' : '후보 없음',
    actionCandidateCount: actionableCount,
    bucketRows,
    candidateRows,
    timelineRows: buildTimelineRows(timeline),
  }
}

module.exports = {
  buildSimulationModel,
  formatAmount,
  formatNumber,
  formatPct,
  readObject,
}
