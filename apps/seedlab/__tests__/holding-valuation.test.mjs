import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const holdingValuation = require('../pb_hooks/pages/_private/holding-valuation.js')

test('readKrwAmount uses stored KRW value before USD conversion', () => {
  const amount = holdingValuation.readKrwAmount({
    currency: 'USD',
    storedAmount: 14892274.2,
    sourceKey: 'marketValueSource',
    krwKey: 'marketValueKrw',
    latestUsdKrwRate: 1532.6,
    raw: {
      quantity: '300',
      lastPrice: '32.39',
      seedlab: {
        marketValueSource: 9717,
        marketValueKrw: 14892274.2,
        exchangeRate: 1532.6,
      },
    },
  })

  assert.equal(amount, 14892274.2)
})

test('readKrwAmount converts USD source only when KRW value is missing', () => {
  const amount = holdingValuation.readKrwAmount({
    currency: 'USD',
    storedAmount: 0,
    sourceKey: 'marketValueSource',
    krwKey: 'marketValueKrw',
    latestUsdKrwRate: 1532.6,
    raw: {
      quantity: '300',
      lastPrice: '32.39',
      seedlab: {
        marketValueSource: 9717,
      },
    },
  })

  assert.equal(amount, 14892274.2)
})

test('readKrwAmount reads JSON string raw values', () => {
  const amount = holdingValuation.readKrwAmount({
    currency: 'USD',
    storedAmount: 0,
    sourceKey: 'marketValueSource',
    krwKey: 'marketValueKrw',
    latestUsdKrwRate: 1532.6,
    raw: JSON.stringify({
      seedlab: {
        marketValueSource: 9717,
        marketValueKrw: 14892274.2,
      },
    }),
  })

  assert.equal(amount, 14892274.2)
})

test('readUsdSourceAmount ignores legacy KRW source values', () => {
  const amount = holdingValuation.readUsdSourceAmount({
    sourceKey: 'marketValueSource',
    raw: {
      quantity: '300',
      lastPrice: '32.39',
      seedlab: {
        marketValueSource: 14892274.2,
      },
    },
  })

  assert.equal(amount, 9717)
})
