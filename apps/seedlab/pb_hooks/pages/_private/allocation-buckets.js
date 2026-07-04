'use strict'

const BUCKETS = [
  {
    key: 'cash',
    label: '현금',
    description: '예금, 적금, CMA, 예수금.',
    assetClass: 'cash',
    targetField: 'cashTargetPct',
    defaultTargetPct: 28,
    color: '#f59f00',
    tone: 'bg-[#fff6e5] text-[#b76e00]',
  },
  {
    key: 'growth_stock',
    label: '주식(성장형)',
    description: '성장주, 지수 ETF.',
    assetClass: 'equity',
    targetField: 'growthStockTargetPct',
    defaultTargetPct: 40,
    color: '#3182f6',
    tone: 'bg-[#e8f3ff] text-[#1b64da]',
  },
  {
    key: 'dividend_stock',
    label: '주식(배당형)',
    description: '배당주, 배당 ETF.',
    assetClass: 'equity',
    targetField: 'dividendStockTargetPct',
    defaultTargetPct: 12,
    color: '#1b64da',
    tone: 'bg-[#eef4ff] text-[#1b64da]',
  },
  {
    key: 'bond',
    label: '채권',
    description: '국채, 회사채, 채권 ETF.',
    assetClass: 'fixed_income',
    targetField: 'bondTargetPct',
    defaultTargetPct: 20,
    color: '#00a86b',
    tone: 'bg-[#ecfdf3] text-[#008a45]',
  },
  {
    key: 'gold',
    label: '금',
    description: '금 현물, 금 ETF.',
    assetClass: 'alternative',
    targetField: 'goldTargetPct',
    defaultTargetPct: 0,
    color: '#f6c343',
    tone: 'bg-[#fff7d6] text-[#946200]',
  },
  {
    key: 'real_estate',
    label: '부동산',
    description: '실물 부동산, 리츠.',
    assetClass: 'alternative',
    targetField: 'realEstateTargetPct',
    defaultTargetPct: 0,
    color: '#e5484d',
    tone: 'bg-[#fff0f0] text-[#c92a2a]',
  },
  {
    key: 'other',
    label: '기타',
    description: '기타 자산.',
    assetClass: 'alternative',
    targetField: 'otherTargetPct',
    defaultTargetPct: 0,
    color: '#8b95a1',
    tone: 'bg-[#f2f4f6] text-[#4e5968]',
  },
]

/**
 * 자산 배정 목록을 반환합니다.
 * @returns {Array<Record<string, any>>} 자산 배정 목록입니다.
 */
function listBuckets() {
  return BUCKETS.slice()
}

/**
 * 자산 배정 키를 정리합니다.
 * @param {unknown} value 자산 배정 키입니다.
 * @returns {string} 지원하는 자산 배정 키입니다.
 */
function normalizeBucket(value) {
  const key = String(value == null ? '' : value).trim()
  for (let index = 0; index < BUCKETS.length; index += 1) {
    if (BUCKETS[index].key === key) return key
  }
  return ''
}

/**
 * 자산 배정 메타를 찾습니다.
 * @param {unknown} value 자산 배정 키입니다.
 * @returns {Record<string, any>} 자산 배정 메타입니다.
 */
function bucketMeta(value) {
  const key = normalizeBucket(value) || 'other'
  for (let index = 0; index < BUCKETS.length; index += 1) {
    if (BUCKETS[index].key === key) return BUCKETS[index]
  }
  return BUCKETS[BUCKETS.length - 1]
}

/**
 * 기본 목표 비중을 만듭니다.
 * @returns {Record<string, number>} 자산 배정별 목표 비중입니다.
 */
function defaultTargets() {
  /** @type {Record<string, number>} */
  const targets = {}
  for (let index = 0; index < BUCKETS.length; index += 1) {
    targets[BUCKETS[index].key] = BUCKETS[index].defaultTargetPct
  }
  return targets
}

module.exports = {
  bucketMeta,
  defaultTargets,
  listBuckets,
  normalizeBucket,
}
