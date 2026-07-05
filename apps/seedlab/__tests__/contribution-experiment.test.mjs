import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const contributionExperiment = require(path.resolve(testDir, '../pb_hooks/pages/_private/contribution-experiment.js'))
const simulationView = require(path.resolve(testDir, '../pb_hooks/pages/_private/simulation-view.js'))

test('contribution experiment suggests buys for underweight buckets', () => {
  const result = contributionExperiment.buildContributionExperiment({
    contributionAmount: 1000000,
    latestUsdKrwRate: 1500,
    cashValue: 0,
    targets: {
      cash: 0,
      growth_stock: 50,
      dividend_stock: 30,
      bond: 20,
      gold: 0,
      real_estate: 0,
      other: 0,
    },
    holdings: [
      {
        holdingId: 'h1',
        accountId: 'a1',
        assetId: 'samsung',
        symbol: '005930',
        name: '삼성전자',
        currency: 'KRW',
        allocationBucket: 'growth_stock',
        currentPrice: 80000,
        marketValueKrw: 6000000,
      },
      {
        holdingId: 'h2',
        accountId: 'a1',
        assetId: 'schd',
        symbol: 'SCHD',
        name: 'SCHD',
        currency: 'USD',
        allocationBucket: 'dividend_stock',
        currentPrice: 30,
        marketValueKrw: 1000000,
      },
      {
        holdingId: 'h3',
        accountId: 'a1',
        assetId: 'bond',
        symbol: '0091C0',
        name: 'KODEX 미국10년국채',
        currency: 'KRW',
        allocationBucket: 'bond',
        currentPrice: 10000,
        marketValueKrw: 1000000,
      },
    ],
  })

  assert.equal(result.experimentType, 'contribution_rebalance')
  assert.equal(result.actionableCount > 0, true)
  assert.equal(
    result.candidates.some((candidate) => candidate.symbol === 'SCHD' && candidate.quantity > 0),
    true
  )
  assert.equal(result.maxAfterDriftPct <= result.maxBeforeDriftPct, true)
})

test('scenario price change reduces fractional USD quantity', () => {
  const base = {
    contributionAmount: 300000,
    latestUsdKrwRate: 1500,
    targets: {
      cash: 0,
      growth_stock: 0,
      dividend_stock: 100,
      bond: 0,
      gold: 0,
      real_estate: 0,
      other: 0,
    },
    holdings: [
      {
        holdingId: 'h1',
        accountId: 'a1',
        assetId: 'schd',
        symbol: 'SCHD',
        name: 'SCHD',
        currency: 'USD',
        allocationBucket: 'dividend_stock',
        currentPrice: 30,
        marketValueKrw: 1000000,
      },
    ],
  }
  const stored = contributionExperiment.buildContributionExperiment(base)
  const changed = contributionExperiment.buildContributionExperiment(
    Object.assign({}, base, {
      priceChangePct: 20,
    })
  )

  assert.equal(stored.candidates[0].quantity > changed.candidates[0].quantity, true)
  assert.equal(changed.candidates[0].price, 36)
})

test('reserve cash and minimum order amount keep small buys as cash', () => {
  const result = contributionExperiment.buildContributionExperiment({
    contributionAmount: 1000000,
    reserveCashAmount: 200000,
    minimumOrderAmount: 900000,
    targets: {
      cash: 0,
      growth_stock: 100,
      dividend_stock: 0,
      bond: 0,
      gold: 0,
      real_estate: 0,
      other: 0,
    },
    holdings: [
      {
        holdingId: 'h1',
        accountId: 'a1',
        assetId: 'spy',
        symbol: 'SPY',
        name: 'SPY',
        currency: 'KRW',
        allocationBucket: 'growth_stock',
        currentPrice: 100000,
        marketValueKrw: 1000000,
      },
    ],
  })

  assert.equal(result.reserveCashAmount, 200000)
  assert.equal(result.investableAmount, 800000)
  assert.equal(result.actionableCount, 0)
  assert.equal(result.leftoverCash, 1000000)
  assert.equal(result.candidates[0].missingReason, 'below_minimum_order')
})

test('preferred holding controls which stock is used inside a bucket', () => {
  const result = contributionExperiment.buildContributionExperiment({
    contributionAmount: 1000000,
    preferredHoldingIds: {
      growth_stock: 'h2',
    },
    targets: {
      cash: 0,
      growth_stock: 100,
      dividend_stock: 0,
      bond: 0,
      gold: 0,
      real_estate: 0,
      other: 0,
    },
    holdings: [
      {
        holdingId: 'h1',
        accountId: 'a1',
        assetId: 'spy',
        symbol: 'SPY',
        name: 'SPY',
        currency: 'KRW',
        allocationBucket: 'growth_stock',
        currentPrice: 100000,
        marketValueKrw: 5000000,
      },
      {
        holdingId: 'h2',
        accountId: 'a1',
        assetId: 'googl',
        symbol: 'GOOGL',
        name: 'Alphabet',
        currency: 'KRW',
        allocationBucket: 'growth_stock',
        currentPrice: 200000,
        marketValueKrw: 1000000,
      },
    ],
  })

  assert.equal(result.candidates[0].holdingId, 'h2')
  assert.equal(result.candidates[0].symbol, 'GOOGL')
})

test('timeline experiment creates monthly snapshots and grows values over time', () => {
  const result = contributionExperiment.buildTimelineExperiment({
    contributionAmount: 1000000,
    monthlyContributionAmount: 500000,
    projectionMonths: 12,
    reserveCashAmount: 100000,
    minimumOrderAmount: 10000,
    annualReturnPcts: {
      cash: 0,
      growth_stock: 12,
      dividend_stock: 6,
      bond: 3,
    },
    targets: {
      cash: 5,
      growth_stock: 60,
      dividend_stock: 15,
      bond: 20,
      gold: 0,
      real_estate: 0,
      other: 0,
    },
    holdings: [
      {
        holdingId: 'h1',
        accountId: 'a1',
        assetId: 'growth',
        symbol: 'SPY',
        name: 'SPY',
        currency: 'KRW',
        allocationBucket: 'growth_stock',
        currentPrice: 100000,
        marketValueKrw: 6000000,
      },
      {
        holdingId: 'h2',
        accountId: 'a1',
        assetId: 'bond',
        symbol: '0091C0',
        name: 'KODEX 미국10년국채',
        currency: 'KRW',
        allocationBucket: 'bond',
        currentPrice: 10000,
        marketValueKrw: 2000000,
      },
    ],
  })

  assert.equal(result.experimentType, 'timeline_rebalance')
  assert.equal(result.snapshots.length, 13)
  assert.equal(result.projectionMonths, 12)
  assert.equal(result.finalTotalValue > result.initialTotalValue, true)
  assert.equal(result.snapshots[1].depositAmount, 1000000)
  assert.equal(result.snapshots[2].depositAmount, 500000)
})

test('simulation view reads JSONRaw-like object values', () => {
  const summaryValue = {}
  Object.defineProperty(summaryValue, 'toString', {
    value: () =>
      JSON.stringify({
        experimentType: 'timeline_rebalance',
        contributionAmount: 1000000,
        actionableCount: 1,
        annualReturnPcts: {
          growth_stock: 7,
          dividend_stock: 5,
          bond: 3,
        },
        buckets: [
          {
            key: 'growth_stock',
            beforePct: 60,
            beforeValue: 6000000,
            targetPct: 70,
          },
        ],
        candidates: [
          {
            symbol: 'SPY',
            name: 'SPY',
            bucketLabel: '주식(성장형)',
            spendKrw: 500000,
            quantity: 1,
          },
        ],
        timeline: {
          initialTotalValue: 10000000,
          finalTotalValue: 11200000,
          finalProfitLoss: 1200000,
          returnPct: 12,
          projectionMonths: 12,
          monthlyContributionAmount: 500000,
          snapshots: [
            {
              month: 0,
              totalValue: 10000000,
              profitLoss: 0,
              bucketValues: {
                growth_stock: 6000000,
              },
            },
            {
              month: 12,
              totalValue: 11200000,
              profitLoss: 1200000,
              bucketValues: {
                growth_stock: 7840000,
              },
              assetWeights: {
                growth_stock: 70,
              },
            },
          ],
        },
      }),
  })

  const model = simulationView.buildSimulationModel({
    get(name) {
      const values = {
        id: 'simjsonraw001',
        name: 'JSONRaw 실험',
        status: 'complete',
        summary: summaryValue,
        settings: '{}',
        monthlyContribution: 500000,
      }
      return values[name]
    },
  })

  assert.equal(model.isLegacy, false)
  assert.equal(model.finalTotalText, '11,200,000원')
  assert.equal(model.returnText, '12%')
  assert.equal(model.actionText, '후보 1개')
})

test('simulation view reads JSONRaw byte arrays', () => {
  const summaryText = JSON.stringify({
    experimentType: 'timeline_rebalance',
    contributionAmount: 1000000,
    actionableCount: 0,
    annualReturnPcts: {
      growth_stock: 7,
      dividend_stock: 5,
      bond: 3,
    },
    buckets: [],
    candidates: [
      {
        symbol: '379800',
        bucketKey: 'growth_stock',
        bucketLabel: 'ì£¼ì(ì±ì¥í)',
        spendKrw: 500000,
        quantity: 19,
      },
    ],
    timeline: {
      initialTotalValue: 10000000,
      finalTotalValue: 11000000,
      finalProfitLoss: 1000000,
      returnPct: 10,
      projectionMonths: 12,
      monthlyContributionAmount: 500000,
      snapshots: [],
    },
  })

  const model = simulationView.buildSimulationModel({
    get(name) {
      const values = {
        id: 'simjsonbytes01',
        name: 'JSONRaw 바이트 실험',
        status: 'complete',
        summary: Array.from(Buffer.from(summaryText, 'utf8')),
        settings: '{}',
        monthlyContribution: 500000,
      }
      return values[name]
    },
  })

  assert.equal(model.isLegacy, false)
  assert.equal(model.finalTotalText, '11,000,000원')
  assert.equal(model.returnText, '10%')
  assert.equal(model.candidateRows[0].bucketLabel, '주식(성장형)')
})
