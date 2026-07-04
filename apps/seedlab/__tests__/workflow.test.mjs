import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { signInAndGetCookieHeader } from '@pocketpages/test-support/auth-cookie'
import { startService } from '@pocketpages/test-support/service-harness'
import { load } from 'cheerio'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const serviceDir = path.resolve(testDir, '..')

let service

before(async () => {
  service = await startService({
    serviceName: 'seedlab',
    timeoutMs: 60000,
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

function buildForm(payload) {
  const form = new URLSearchParams()

  for (const [key, value] of Object.entries(payload)) {
    form.set(key, value == null ? '' : String(value))
  }

  return form
}

async function postForm(pathname, payload, cookieHeader) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  if (cookieHeader) {
    headers.Cookie = cookieHeader
  }

  return fetch(`${service.baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: buildForm(payload),
    redirect: 'manual',
  })
}

async function signUpAndGetCookieHeader() {
  const email = `seedlab-flow-${Date.now()}@example.test`
  const password = 'Seedlab1234!'
  const response = await postForm('/xapi/auth/sign-up', {
    email,
    password,
    passwordConfirm: password,
  })

  assert.equal(response.status, 303)

  const cookieHeader = await signInAndGetCookieHeader(service.baseUrl, {
    email,
    password,
    path: '/xapi/auth/sign-in',
  })
  assert.equal(cookieHeader.length > 0, true)

  return cookieHeader
}

async function getAuthedPage(pathname, cookieHeader) {
  const response = await fetch(`${service.baseUrl}${pathname}`, {
    headers: {
      Cookie: cookieHeader,
    },
  })
  const body = await response.text()

  assert.equal(response.status, 200)

  return {
    body,
    $: load(body),
  }
}

function getAuthedHome(cookieHeader) {
  return getAuthedPage('/', cookieHeader)
}

test('manual account, virtual simulation, and mock order flow works through service harness', async () => {
  const cookieHeader = await signUpAndGetCookieHeader()

  const manualAccountResponse = await postForm(
    '/xapi/accounts/manual/create',
    {
      name: '테스트 연금저축',
      accountType: 'pension_saving',
      providerName: '테스트증권',
      accountSeq: '1234567890',
      baseCurrency: 'KRW',
      totalValue: '700,000원',
      cashValue: '0원',
      profitLoss: '+50,000원',
      isTaxAdvantaged: 'on',
      memo: 'service-harness workflow',
    },
    cookieHeader,
  )

  assert.equal(manualAccountResponse.status, 303)
  assert.match(manualAccountResponse.headers.get('location') || '', /^\/accounts/u)

  const accountHome = await getAuthedHome(cookieHeader)
  assert.equal(accountHome.body.includes('계좌 등록'), false)
  assert.equal(accountHome.body.includes('투자 상태'), true)
  assert.equal(accountHome.body.includes('총 평가금'), true)
  assert.equal(accountHome.$('[data-nav-key]').length, 4)
  assert.equal(accountHome.$('[data-nav-key="home"][aria-current="page"]').length, 1)

  const accountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(accountsPage.body.includes('현재 비중'), true)
  assert.equal(accountsPage.body.includes('자산 목록'), true)
  assert.equal(accountsPage.body.includes('아직 불러온 보유 종목이 없습니다'), true)
  assert.equal(accountsPage.body.includes('테스트 연금저축'), true)
  assert.equal(accountsPage.$('[data-nav-key="accounts"][aria-current="page"]').length, 1)

  const manualHoldingPage = await getAuthedPage('/accounts/holdings/new', cookieHeader)
  assert.equal(manualHoldingPage.body.includes('평가금액'), true)
  const manualAccountId = manualHoldingPage.$('select[name="accountId"] option').first().attr('value') || ''
  assert.match(manualAccountId, /^[a-z0-9]{15}$/u)

  const manualHoldingResponse = await postForm(
    '/xapi/holdings/manual/create',
    {
      accountId: manualAccountId,
      symbol: '005930',
      name: '삼성전자',
      currency: 'KRW',
      assetType: 'stock',
      assetClass: 'equity',
      quantity: '10주',
      marketValue: '700,000원',
      profitLoss: '+50,000원 (7.7%)',
    },
    cookieHeader,
  )

  assert.equal(manualHoldingResponse.status, 303)
  assert.match(manualHoldingResponse.headers.get('location') || '', /^\/accounts/u)

  const holdingAccountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(holdingAccountsPage.body.includes('삼성전자'), true)
  assert.equal(holdingAccountsPage.body.includes('목표와 현재'), true)
  assert.equal(holdingAccountsPage.body.includes('목표 비율'), true)
  assert.equal(holdingAccountsPage.$('#asset-class-chart').length, 1)

  const targetResponse = await postForm(
    '/xapi/allocation-targets/update',
    {
      cashTargetPct: '5',
      growthStockTargetPct: '60',
      dividendStockTargetPct: '15',
      bondTargetPct: '20',
      goldTargetPct: '0',
      realEstateTargetPct: '0',
      otherTargetPct: '0',
    },
    cookieHeader,
  )

  assert.equal(targetResponse.status, 303)
  assert.match(targetResponse.headers.get('location') || '', /^\/accounts/u)

  const targetedAccountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(targetedAccountsPage.body.includes('주식(성장형)'), true)
  assert.equal(targetedAccountsPage.body.includes('차이'), true)
  assert.equal(targetedAccountsPage.$('input[name="cashTargetPct"]').attr('value'), '5')
  assert.equal(targetedAccountsPage.$('input[name="growthStockTargetPct"]').attr('value'), '60')
  assert.equal(targetedAccountsPage.$('input[name="dividendStockTargetPct"]').attr('value'), '15')
  assert.equal(targetedAccountsPage.body.includes('목표 60%'), true)

  const holdingId = targetedAccountsPage.$('input[name="holdingId"]').first().attr('value') || ''
  assert.match(holdingId, /^[a-z0-9]{15}$/u)

  const editHref = targetedAccountsPage.$(`a[href="/accounts/holdings/${holdingId}/edit"]`).attr('href') || ''
  assert.equal(editHref, `/accounts/holdings/${holdingId}/edit`)

  const editHoldingPage = await getAuthedPage(editHref, cookieHeader)
  assert.equal(editHoldingPage.body.includes('수정 저장'), true)
  assert.equal(editHoldingPage.$('input[name="marketValue"]').attr('value'), '700,000원')

  const updateHoldingResponse = await postForm(
    '/xapi/holdings/manual/update',
    {
      holdingId,
      accountId: manualAccountId,
      symbol: '005930',
      name: '삼성전자',
      currency: 'KRW',
      assetType: 'stock',
      assetClass: 'equity',
      quantity: '10주',
      marketValue: '800,000원',
      profitLoss: '+100,000원',
    },
    cookieHeader,
  )

  assert.equal(updateHoldingResponse.status, 303)
  assert.match(updateHoldingResponse.headers.get('location') || '', /^\/accounts/u)

  const updatedHoldingAccountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(updatedHoldingAccountsPage.body.includes('800,000원'), true)

  const allocationResponse = await postForm(
    '/xapi/holdings/allocation/update',
    {
      holdingId,
      allocationBucket: 'dividend_stock',
    },
    cookieHeader,
  )

  assert.equal(allocationResponse.status, 303)
  assert.match(allocationResponse.headers.get('location') || '', /^\/accounts/u)

  const allocatedAccountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(allocatedAccountsPage.body.includes('주식(배당형)'), true)

  const simulationResponse = await postForm(
    '/xapi/simulations/create',
    {
      personaName: '테스트 장기 투자자',
      riskProfile: 'balanced',
      behaviorProfile: 'disciplined',
      initialCapital: '10000000',
      monthlyContribution: '500000',
      startDate: '2021-01-01',
      endDate: '2026-06-30',
    },
    cookieHeader,
  )

  assert.equal(simulationResponse.status, 303)
  assert.match(simulationResponse.headers.get('location') || '', /^\/actions/u)

  const simulationHome = await getAuthedHome(cookieHeader)
  const actionItemId = simulationHome.$('input[name="actionItemId"]').attr('value') || ''

  assert.equal(simulationHome.body.includes('주문 후보를 검토하세요'), true)
  assert.match(actionItemId, /^[a-z0-9]{15}$/u)

  const simulationsPage = await getAuthedPage('/simulations', cookieHeader)
  assert.equal(simulationsPage.body.includes('실험 목록'), true)
  assert.equal(simulationsPage.body.includes('테스트 장기 투자자 적립식 실험'), true)
  assert.equal(simulationsPage.$('[data-nav-key="simulations"][aria-current="page"]').length, 1)

  const actionsPage = await getAuthedPage('/actions', cookieHeader)
  assert.equal(actionsPage.body.includes('검토할 액션'), true)
  assert.equal(actionsPage.body.includes('모의 제출'), true)
  assert.equal(actionsPage.$('[data-nav-key="actions"][aria-current="page"]').length, 1)

  const mockOrderResponse = await postForm(
    '/xapi/orders/mock-submit',
    {
      actionItemId,
    },
    cookieHeader,
  )

  assert.equal(mockOrderResponse.status, 303)
  assert.match(mockOrderResponse.headers.get('location') || '', /^\/actions/u)

  const orderHome = await getAuthedHome(cookieHeader)
  const homeSectionTexts = orderHome
    .$('section')
    .map((index, element) => orderHome.$(element).text().replace(/\s+/g, ' ').trim())
    .get()

  assert.equal(homeSectionTexts.some((text) => text.includes('검토') && text.includes('1')), true)
  assert.equal(orderHome.body.includes('제출 대기 주문 또는 초안이 있습니다.'), true)
})

test('mock order route cannot call Toss order APIs', () => {
  const mockRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/orders/mock-submit.ejs'), 'utf8')

  assert.equal(/createTossApiClient|createOrder|modifyOrder|cancelOrder|toss-api/u.test(mockRoute), false)
  assert.equal(mockRoute.includes('didNotCallTossApi'), true)
})

test('toss account sync route reads holdings, cash, and records sync state', () => {
  const syncRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/accounts/toss/sync.ejs'), 'utf8')
  const accountsPage = readFileSync(path.join(serviceDir, 'pb_hooks/pages/(site)/accounts/index.ejs'), 'utf8')

  assert.equal(syncRoute.includes('toss.getHoldings'), true)
  assert.equal(syncRoute.includes('toss.getExchangeRate'), true)
  assert.equal(syncRoute.includes('toss.getBuyingPower'), true)
  assert.equal(syncRoute.includes('buildTossClientOptions'), true)
  assert.equal(syncRoute.includes('sync_runs'), true)
  assert.equal(syncRoute.includes('account_holdings'), true)
  assert.equal(syncRoute.includes('account_snapshots'), true)
  assert.equal(syncRoute.includes('holding_snapshots'), true)
  assert.equal(syncRoute.includes('assetClassWeights'), true)
  assert.equal(syncRoute.includes('asset-classifier'), true)
  assert.equal(/createOrder|modifyOrder|cancelOrder/u.test(syncRoute), false)
  assert.equal(accountsPage.includes('/xapi/accounts/toss/sync'), true)
  assert.equal(accountsPage.includes('/xapi/allocation-targets/update'), true)
  assert.equal(accountsPage.includes('/xapi/holdings/allocation/update'), true)
  assert.equal(accountsPage.includes('chart.umd.4.5.1.min.js'), true)
  assert.equal(accountsPage.includes('readAssetRecord'), true)
  assert.equal(accountsPage.includes('account_holdings'), true)
})

test('rebalance schema supports asset class targets and draft items', () => {
  const schema = readFileSync(path.join(serviceDir, 'pb_schema.json'), 'utf8')
  const manualHoldingRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/holdings/manual/create.ejs'), 'utf8')
  const rebalanceRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/rebalance/runs/create.ejs'), 'utf8')

  assert.equal(schema.includes('"assetClass"'), true)
  assert.equal(schema.includes('"strategy_asset_targets"'), true)
  assert.equal(schema.includes('"rebalance_runs"'), true)
  assert.equal(schema.includes('"rebalance_items"'), true)
  assert.equal(manualHoldingRoute.includes('assetClassOverride'), true)
  assert.equal(rebalanceRoute.includes('strategy_asset_targets'), true)
  assert.equal(rebalanceRoute.includes('rebalance_items'), true)
  assert.equal(/createOrder|modifyOrder|cancelOrder|toss-api/u.test(rebalanceRoute), false)
})
