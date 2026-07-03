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
      baseCurrency: 'KRW',
      isTaxAdvantaged: 'on',
      memo: 'service-harness workflow',
    },
    cookieHeader,
  )

  assert.equal(manualAccountResponse.status, 303)
  assert.match(manualAccountResponse.headers.get('location') || '', /^\/accounts/u)

  const accountHome = await getAuthedHome(cookieHeader)
  assert.equal(accountHome.body.includes('계좌 등록'), false)
  assert.equal(accountHome.body.includes('연결 계좌'), true)
  assert.equal(accountHome.body.includes('1개'), true)
  assert.equal(accountHome.$('[data-nav-key]').length, 4)
  assert.equal(accountHome.$('[data-nav-key="home"][aria-current="page"]').length, 1)

  const accountsPage = await getAuthedPage('/accounts', cookieHeader)
  assert.equal(accountsPage.body.includes('계좌 목록'), true)
  assert.equal(accountsPage.body.includes('테스트 연금저축'), true)
  assert.equal(accountsPage.$('[data-nav-key="accounts"][aria-current="page"]').length, 1)

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

  assert.equal(simulationHome.body.includes('승인 전 주문 후보가 있습니다'), true)
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
  const homeArticleTexts = orderHome
    .$('article')
    .map((index, element) => orderHome.$(element).text().replace(/\s+/g, ' ').trim())
    .get()
  const homeSectionTexts = orderHome
    .$('section')
    .map((index, element) => orderHome.$(element).text().replace(/\s+/g, ' ').trim())
    .get()

  assert.equal(homeArticleTexts.some((text) => text.includes('액션') && text.includes('1') && text.includes('제출 추적')), true)
  assert.equal(homeSectionTexts.some((text) => text.includes('이번 액션') && text.includes('1개')), true)
  assert.equal(orderHome.body.includes('제출된 주문 1건을 추적 중입니다.'), true)
})

test('mock order route cannot call Toss order APIs', () => {
  const mockRoute = readFileSync(path.join(serviceDir, 'pb_hooks/pages/xapi/orders/mock-submit.ejs'), 'utf8')

  assert.equal(/createTossApiClient|createOrder|modifyOrder|cancelOrder|toss-api/u.test(mockRoute), false)
  assert.equal(mockRoute.includes('didNotCallTossApi'), true)
})
