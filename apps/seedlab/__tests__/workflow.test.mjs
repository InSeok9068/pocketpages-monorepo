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

test('manual account, contribution simulation, and mock order flow works through service harness', async () => {
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
    cookieHeader
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
  const accountEditHref = accountsPage.$('a[href*="/accounts/manual/"][href$="/edit"]').attr('href') || ''
  assert.match(accountEditHref, /^\/accounts\/manual\/[a-z0-9]{15}\/edit$/u)

  const editAccountPage = await getAuthedPage(accountEditHref, cookieHeader)
  assert.equal(editAccountPage.body.includes('계좌 수정'), true)
  const editAccountId = editAccountPage.$('input[name="accountId"]').attr('value') || ''
  assert.match(editAccountId, /^[a-z0-9]{15}$/u)
  assert.equal(editAccountPage.$('input[name="name"]').attr('value'), '테스트 연금저축')

  const updateAccountResponse = await postForm(
    '/xapi/accounts/manual/update',
    {
      accountId: editAccountId,
      name: '테스트 ISA 수정',
      accountType: 'isa',
      providerName: '수정증권',
      accountSeq: '9999999999',
      baseCurrency: 'KRW',
      totalValue: '710,000원',
      cashValue: '10,000원',
      profitLoss: '+60,000원',
      isTaxAdvantaged: 'on',
      memo: 'updated account memo',
    },
    cookieHeader
  )

  assert.equal(updateAccountResponse.status, 303)
  assert.match(updateAccountResponse.headers.get('location') || '', /^\/accounts/u)

  const updatedAccountPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(updatedAccountPage.body.includes('테스트 ISA 수정'), true)
  assert.equal(updatedAccountPage.body.includes('수정증권'), true)

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
    cookieHeader
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
    cookieHeader
  )

  assert.equal(targetResponse.status, 303)
  assert.match(targetResponse.headers.get('location') || '', /^\/accounts/u)

  const targetedAccountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(targetedAccountsPage.body.includes('주식(성장형)'), true)
  assert.equal(targetedAccountsPage.body.includes('목표금'), false)
  assert.equal(targetedAccountsPage.$('input[name="cashTargetPct"]').attr('value'), '5')
  assert.equal(targetedAccountsPage.$('input[name="growthStockTargetPct"]').attr('value'), '60')
  assert.equal(targetedAccountsPage.$('input[name="dividendStockTargetPct"]').attr('value'), '15')
  assert.equal(targetedAccountsPage.body.includes('목표 60%'), true)

  const holdingId = targetedAccountsPage.$('input[name="holdingId"]').first().attr('value') || ''
  assert.match(holdingId, /^[a-z0-9]{15}$/u)

  const holdingDetailHref = targetedAccountsPage.$(`a[href="/accounts/holdings/${holdingId}"]`).attr('href') || ''
  assert.equal(holdingDetailHref, `/accounts/holdings/${holdingId}`)
  assert.equal(targetedAccountsPage.$(`a[href="/accounts/holdings/${holdingId}/edit"]`).length, 0)

  const holdingDetailPage = await getAuthedPage(holdingDetailHref, cookieHeader)
  assert.equal(holdingDetailPage.body.includes('보유 종목 상세'), true)
  assert.equal(holdingDetailPage.body.includes('삼성전자'), true)
  assert.equal(holdingDetailPage.$('form[action="/xapi/holdings/allocation/update"]').length, 1)
  const editHref = holdingDetailPage.$(`a[href="/accounts/holdings/${holdingId}/edit"]`).attr('href') || ''
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
    cookieHeader
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
    cookieHeader
  )

  assert.equal(allocationResponse.status, 303)
  assert.match(allocationResponse.headers.get('location') || '', /^\/accounts/u)

  const allocatedAccountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(allocatedAccountsPage.body.includes('주식(배당형)'), true)

  const simulationResponse = await postForm(
    '/xapi/simulations/create',
    {
      name: '테스트 추가 투자',
      accountId: manualAccountId,
      contributionAmount: '5000000',
      monthlyContributionAmount: '500000',
      projectionMonths: '12',
      reserveCashAmount: '500000',
      minimumOrderAmount: '100000',
      priceMode: 'scenario',
      priceChangePct: '5',
      cashTargetPct: '5',
      growthStockTargetPct: '60',
      dividendStockTargetPct: '15',
      bondTargetPct: '20',
      goldTargetPct: '0',
      realEstateTargetPct: '0',
      otherTargetPct: '0',
      return_cash: '2',
      return_growth_stock: '7',
      return_dividend_stock: '5',
      return_bond: '3',
      return_gold: '2',
      return_real_estate: '3',
      return_other: '0',
      buyHolding_dividend_stock: holdingId,
      createActions: 'on',
    },
    cookieHeader
  )

  assert.equal(simulationResponse.status, 303)
  assert.match(simulationResponse.headers.get('location') || '', /^\/actions/u)

  const actionsPage = await getAuthedPage('/actions', cookieHeader)
  const actionItemId = actionsPage.$('form[action="/xapi/actions/skip"] input[name="actionItemId"]').attr('value') || ''

  assert.match(actionItemId, /^[a-z0-9]{15}$/u)

  const simulationsPage = await getAuthedPage('/simulations', cookieHeader)
  assert.equal(simulationsPage.body.includes('투자 실험'), true)
  assert.equal(simulationsPage.body.includes('테스트 추가 투자'), true)
  assert.equal(simulationsPage.body.includes('예상 평가액'), true)
  assert.equal(simulationsPage.body.includes('자산 배분을 바꾸면'), false)
  assert.equal(simulationsPage.$('[data-nav-key="simulations"][aria-current="page"]').length, 1)
  assert.equal(simulationsPage.$('form[action="/xapi/simulations/delete"]').length, 0)
  assert.equal(simulationsPage.$('form[action="/xapi/simulations/recalculate"]').length, 0)
  const simulationHref = simulationsPage.$('a[href^="/simulations/detail/"]').first().attr('href') || ''
  const simulationId = simulationHref.replace('/simulations/detail/', '')
  assert.match(simulationId, /^[a-z0-9]{15}$/u)
  assert.equal(simulationsPage.$(`a[href="/simulations/detail/${simulationId}"]`).length > 0, true)
  assert.equal(simulationsPage.$(`a[href="/simulations/edit/${simulationId}"]`).length, 0)

  const simulationEditPage = await getAuthedPage(`/simulations/edit/${simulationId}`, cookieHeader)
  assert.equal(simulationEditPage.body.includes('투자 실험 수정'), true)
  assert.equal(simulationEditPage.body.includes('수정 저장'), true)
  assert.equal(simulationEditPage.$('input[name="editMode"][value="on"]').length, 1)

  const simulationDetailPage = await getAuthedPage(`/simulations/detail/${simulationId}`, cookieHeader)
  assert.equal(simulationDetailPage.body.includes('자산군 변화'), true)
  assert.equal(simulationDetailPage.body.includes('첫 달 매수 후보'), true)
  assert.equal(simulationDetailPage.body.includes('보유 종목 근거'), true)
  assert.equal(simulationDetailPage.body.includes('월별 흐름'), true)
  assert.equal(simulationDetailPage.$('form[action="/xapi/simulations/recalculate"]').length, 1)
  assert.equal(simulationDetailPage.$(`a[href="/simulations/edit/${simulationId}"]`).length, 1)
  assert.equal(simulationDetailPage.$('form[action="/xapi/simulations/delete"]').length, 1)

  const recalcHoldingResponse = await postForm(
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
      marketValue: '900,000원',
      profitLoss: '+120,000원',
    },
    cookieHeader
  )

  assert.equal(recalcHoldingResponse.status, 303)

  const recalculateResponse = await postForm(
    '/xapi/simulations/recalculate',
    {
      simulationId,
    },
    cookieHeader
  )

  assert.equal(recalculateResponse.status, 303)
  assert.match(recalculateResponse.headers.get('location') || '', new RegExp('^/simulations/detail/' + simulationId))

  const recalculatedDetailPage = await getAuthedPage(`/simulations/detail/${simulationId}`, cookieHeader)
  assert.equal(recalculatedDetailPage.body.includes('900,000원'), true)
  assert.equal(recalculatedDetailPage.body.includes('최신 기준'), true)

  const editSimulationResponse = await postForm(
    '/xapi/simulations/recalculate',
    {
      simulationId,
      editMode: 'on',
      name: '수정된 추가 투자',
      accountId: manualAccountId,
      contributionAmount: '3000000',
      monthlyContributionAmount: '300000',
      projectionMonths: '18',
      reserveCashAmount: '300000',
      minimumOrderAmount: '100000',
      priceMode: 'stored',
      priceChangePct: '0',
      cashTargetPct: '5',
      growthStockTargetPct: '60',
      dividendStockTargetPct: '15',
      bondTargetPct: '20',
      goldTargetPct: '0',
      realEstateTargetPct: '0',
      otherTargetPct: '0',
      return_cash: '2',
      return_growth_stock: '7',
      return_dividend_stock: '5',
      return_bond: '3',
      return_gold: '0',
      return_real_estate: '0',
      return_other: '0',
      buyHolding_growth_stock: holdingId,
      createActions: 'on',
    },
    cookieHeader
  )

  assert.equal(editSimulationResponse.status, 303)
  assert.match(editSimulationResponse.headers.get('location') || '', new RegExp('^/simulations/detail/' + simulationId))

  const editedSimulationDetailPage = await getAuthedPage(`/simulations/detail/${simulationId}`, cookieHeader)
  assert.equal(editedSimulationDetailPage.body.includes('수정된 추가 투자'), true)

  assert.equal(actionsPage.body.includes('검토할 매수 후보'), true)
  assert.equal(actionsPage.body.includes('기록만 남기기'), true)
  assert.equal(actionsPage.body.includes('안 함'), true)
  assert.equal(actionsPage.body.includes('삼성전자'), true)
  assert.equal(actionsPage.$('[data-nav-key="actions"][aria-current="page"]').length, 1)
  assert.equal(actionsPage.$('form[action="/xapi/actions/skip"]').length > 0, true)

  const mockOrderResponse = await postForm(
    '/xapi/orders/mock-submit',
    {
      actionItemId,
    },
    cookieHeader
  )

  assert.equal(mockOrderResponse.status, 303)
  assert.match(mockOrderResponse.headers.get('location') || '', /^\/actions/u)

  const orderHome = await getAuthedHome(cookieHeader)
  const homeSectionTexts = orderHome
    .$('section')
    .map((index, element) => orderHome.$(element).text().replace(/\s+/g, ' ').trim())
    .get()

  assert.equal(
    homeSectionTexts.some((text) => text.includes('검토') && text.includes('1')),
    false
  )
  assert.equal(orderHome.body.includes('주문 후보를 검토하세요'), false)
  assert.equal(orderHome.body.includes('제출 대기 주문 또는 초안이 있습니다.'), false)

  const deleteSimulationResponse = await postForm(
    '/xapi/simulations/delete',
    {
      simulationId,
    },
    cookieHeader
  )

  assert.equal(deleteSimulationResponse.status, 303)
  assert.match(deleteSimulationResponse.headers.get('location') || '', /^\/simulations/u)

  const deletedSimulationsPage = await getAuthedPage('/simulations', cookieHeader)
  assert.equal(deletedSimulationsPage.body.includes('테스트 추가 투자'), false)
})

test('mock order route cannot call Toss order APIs', () => {
  const mockRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/orders/mock-submit.ejs'), 'utf8')

  assert.equal(/createTossApiClient|createOrder|modifyOrder|cancelOrder|toss-api/u.test(mockRoute), false)
  assert.equal(mockRoute.includes('didNotCallTossApi'), true)
})

test('skip action route marks candidates as skipped', () => {
  const skipRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/actions/skip.ejs'), 'utf8')

  assert.equal(skipRoute.includes("actionItem.set('status', 'skipped')"), true)
  assert.equal(skipRoute.includes('건너뛸 수 있는 주문 후보가 아닙니다.'), true)
  assert.equal(skipRoute.includes('매수 후보를 건너뛰었습니다.'), true)
})

test('toss account sync route reads holdings, cash, and records sync state', () => {
  const syncRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/accounts/toss/sync.ejs'), 'utf8')
  const accountUpdateRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/accounts/manual/update.ejs'), 'utf8')
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
  assert.equal(accountsPage.includes("editHref: '/accounts/manual/'"), true)
  assert.equal(accountsPage.includes('/xapi/allocation-targets/update'), true)
  assert.equal(accountsPage.includes('/xapi/holdings/allocation/update'), true)
  assert.equal(accountsPage.includes('chart.umd.4.5.1.min.js'), true)
  assert.equal(accountsPage.includes('readAssetRecord'), true)
  assert.equal(accountsPage.includes('account_holdings'), true)
  assert.equal(accountUpdateRoute.includes('manual_account_edit'), true)
  assert.equal(accountUpdateRoute.includes('dateutil.startOfDay'), true)
})

test('contribution simulation route supports stored, refresh, and scenario price bases', () => {
  const createRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/simulations/create.ejs'), 'utf8')
  const recalculateRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/simulations/recalculate.ejs'), 'utf8')
  const deleteRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/simulations/delete.ejs'), 'utf8')
  const newPage = readFileSync(path.join(serviceDir, 'pb_hooks/pages/(site)/simulations/new.ejs'), 'utf8')
  const editPage = readFileSync(path.join(serviceDir, 'pb_hooks/pages/(site)/simulations/edit/[id].ejs'), 'utf8')
  const indexPage = readFileSync(path.join(serviceDir, 'pb_hooks/pages/(site)/simulations/index.ejs'), 'utf8')
  const detailPage = readFileSync(path.join(serviceDir, 'pb_hooks/pages/(site)/simulations/detail/[id].ejs'), 'utf8')
  const calculator = readFileSync(path.join(serviceDir, 'pb_hooks/pages/_private/contribution-experiment.js'), 'utf8')
  const simulationView = readFileSync(path.join(serviceDir, 'pb_hooks/pages/_private/simulation-view.js'), 'utf8')

  assert.equal(newPage.includes('value="stored"'), true)
  assert.equal(newPage.includes('value="refresh"'), true)
  assert.equal(newPage.includes('value="scenario"'), true)
  assert.equal(newPage.includes('name="reserveCashAmount"'), true)
  assert.equal(newPage.includes('name="minimumOrderAmount"'), true)
  assert.equal(newPage.includes('name="monthlyContributionAmount"'), true)
  assert.equal(newPage.includes('name="projectionMonths"'), true)
  assert.equal(newPage.includes('연수익률 가정'), true)
  assert.equal(newPage.includes('매수 종목'), true)
  assert.equal(newPage.includes('buyHolding_'), true)
  assert.equal(newPage.includes('targetField'), true)
  assert.equal(editPage.includes('name="editMode"'), true)
  assert.equal(editPage.includes('투자 실험 수정'), true)
  assert.equal(editPage.includes('주문 후보 다시 만들기'), true)
  assert.equal(createRoute.includes('toss.getPrices'), true)
  assert.equal(createRoute.includes('toss.getExchangeRate'), true)
  assert.equal(createRoute.includes('summary.priceMode = priceMode'), true)
  assert.equal(createRoute.includes('reserveCashAmount'), true)
  assert.equal(createRoute.includes('minimumOrderAmount'), true)
  assert.equal(createRoute.includes('buildTimelineExperiment'), true)
  assert.equal(createRoute.includes('simulation_snapshots'), true)
  assert.equal(createRoute.includes('readAnnualReturnPcts'), true)
  assert.equal(createRoute.includes('readPreferredHoldingIds'), true)
  assert.equal(createRoute.includes('preferredHoldingIds'), true)
  assert.equal(createRoute.includes("new Record(txApp.findCollectionByNameOrId('action_items'))"), true)
  assert.equal(indexPage.includes('/xapi/simulations/delete'), false)
  assert.equal(indexPage.includes('/xapi/simulations/recalculate'), false)
  assert.equal(indexPage.includes('/simulations/detail/<%= simulationCards[index].id %>'), true)
  assert.equal(indexPage.includes('/simulations/edit/<%= simulationCards[index].id %>'), false)
  assert.equal(detailPage.includes('/xapi/simulations/recalculate'), true)
  assert.equal(detailPage.includes('/xapi/simulations/delete'), true)
  assert.equal(detailPage.includes('/simulations/edit/<%= simulationCard.id %>'), true)
  assert.equal(detailPage.includes('자산군 변화'), true)
  assert.equal(detailPage.includes('보유 종목 근거'), true)
  assert.equal(simulationView.includes('buildSimulationModel'), true)
  assert.equal(recalculateRoute.includes('initialSummary'), true)
  assert.equal(recalculateRoute.includes('saveTimelineSnapshots'), true)
  assert.equal(recalculateRoute.includes('previousSummary'), true)
  assert.equal(recalculateRoute.includes('readTargetSettings'), true)
  assert.equal(recalculateRoute.includes('saveActionCandidates'), true)
  assert.equal(deleteRoute.includes('simulation_snapshots'), true)
  assert.equal(deleteRoute.includes('action_batches'), true)
  assert.equal(deleteRoute.includes('txApp.delete(simulationRecord)'), true)
  assert.equal(calculator.includes('applyPriceChange'), true)
  assert.equal(calculator.includes('roundFractionalQuantity'), true)
  assert.equal(calculator.includes('below_minimum_order'), true)
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
