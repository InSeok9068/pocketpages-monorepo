import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let envProvider = () => ''
const pocketpagesGlobalApi = {
  env(name) {
    return envProvider(name)
  },
}
const originalLoad = Module._load

Module._load = function loadTestModule(request, parent, isMain) {
  if (request === 'pocketpages') {
    return {
      globalApi: pocketpagesGlobalApi,
    }
  }

  return originalLoad.call(this, request, parent, isMain)
}

const { createTossApiClient } = require('../pb_hooks/pages/_private/toss-api.js')

afterEach(() => {
  delete global.$http
  envProvider = () => ''
})

test('request skips empty query values and encodes arrays as comma-separated symbols', () => {
  const calls = []
  global.$http = {
    send(options) {
      calls.push(options)
      return {
        statusCode: 200,
        headers: {},
        json: {
          result: [],
        },
        body: [],
      }
    },
  }

  const client = createTossApiClient({
    baseUrl: 'https://example.test',
    accessToken: 'access-token',
  })
  const result = client.request({
    operationId: 'testQuery',
    method: 'GET',
    path: '/api/v1/test',
    query: {
      symbols: ['AAPL', 'MSFT'],
      empty: '',
      adjusted: false,
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.test/api/v1/test?symbols=AAPL%2CMSFT&adjusted=false')
})

test('getPrices sends bearer token and symbol query', () => {
  const calls = []
  global.$http = {
    send(options) {
      calls.push(options)
      return {
        statusCode: 200,
        headers: {
          'X-Request-Id': ['req-1'],
          'X-RateLimit-Limit': ['10'],
        },
        json: {
          result: [{ symbol: 'AAPL' }],
        },
        body: [],
      }
    },
  }

  const client = createTossApiClient({
    baseUrl: 'https://example.test/',
    accessToken: 'access-token',
  })
  const result = client.getPrices({ symbols: ['AAPL', 'MSFT'] })

  assert.equal(result.ok, true)
  assert.deepEqual(result.result, [{ symbol: 'AAPL' }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'https://example.test/api/v1/prices?symbols=AAPL%2CMSFT')
  assert.equal(calls[0].headers.Authorization, 'Bearer access-token')
  assert.equal(calls[0].headers['X-Tossinvest-Account'], undefined)
})

test('account APIs issue token and attach X-Tossinvest-Account', () => {
  const calls = []
  global.$http = {
    send(options) {
      calls.push(options)
      if (options.url === 'https://example.test/oauth2/token') {
        return {
          statusCode: 200,
          headers: {},
          json: {
            access_token: 'issued-token',
            token_type: 'Bearer',
            expires_in: 3600,
          },
          body: [],
        }
      }

      return {
        statusCode: 200,
        headers: {},
        json: {
          result: {
            holdings: [],
          },
        },
        body: [],
      }
    },
  }

  const client = createTossApiClient({
    baseUrl: 'https://example.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accountSeq: 12,
  })
  const result = client.getHoldings({ symbol: 'AAPL' })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body, 'grant_type=client_credentials&client_id=client-id&client_secret=client-secret')
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(calls[1].url, 'https://example.test/api/v1/holdings?symbol=AAPL')
  assert.equal(calls[1].headers.Authorization, 'Bearer issued-token')
  assert.equal(calls[1].headers['X-Tossinvest-Account'], '12')
})

test('account APIs surface OAuth error descriptions from token response', () => {
  const calls = []
  global.$http = {
    send(options) {
      calls.push(options)
      return {
        statusCode: 401,
        headers: {},
        json: {
          error: 'invalid_client',
          error_description: 'Client authentication failed.',
        },
        body: [],
      }
    },
  }

  const client = createTossApiClient({
    baseUrl: 'https://example.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  })
  const result = client.getAccounts()

  assert.equal(result.ok, false)
  assert.equal(result.operationId, 'issueOAuth2Token')
  assert.equal(result.statusCode, 401)
  assert.equal(result.errorMessage, 'Client authentication failed.')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.test/oauth2/token')
})

test('client reads Toss credential env names', () => {
  const calls = []
  const envValues = {
    TOSS_APIKEY: 'env-client-id',
    TOSS_SECRET: 'env-client-secret',
    TOSSINVEST_ACCOUNT_SEQ: '34',
  }

  envProvider = (name) => envValues[name] || ''
  global.$http = {
    send(options) {
      calls.push(options)
      if (options.url === 'https://openapi.tossinvest.com/oauth2/token') {
        return {
          statusCode: 200,
          headers: {},
          json: {
            access_token: 'issued-token',
            token_type: 'Bearer',
            expires_in: 3600,
          },
          body: [],
        }
      }

      return {
        statusCode: 200,
        headers: {},
        json: {
          result: {
            currency: 'USD',
            cashBuyingPower: '10',
          },
        },
        body: [],
      }
    },
  }

  const client = createTossApiClient()
  const result = client.getBuyingPower({ currency: 'USD' })

  assert.equal(result.ok, true)
  assert.equal(calls[0].body, 'grant_type=client_credentials&client_id=env-client-id&client_secret=env-client-secret')
  assert.equal(calls[1].headers['X-Tossinvest-Account'], '34')
})
