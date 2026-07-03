import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const credentialCrypto = require('../pb_hooks/pages/_private/credential-crypto.js')

const validKey = '12345678901234567890123456789012'

function createFakeSecurity() {
  return {
    encrypt(data, key) {
      return `encrypted:${key}:${data}`
    },
    decrypt(cipherText, key) {
      return String(cipherText).replace(`encrypted:${key}:`, '')
    },
  }
}

afterEach(() => {
  delete global.env
  delete global.$security
})

test('buildEncryptedSecret requires a 32 character key', () => {
  assert.equal(
    credentialCrypto.buildEncryptedSecret('client-secret-value', {
      key: validKey,
      security: createFakeSecurity(),
    }).encryptedSecret,
    `encrypted:${validKey}:client-secret-value`
  )
  assert.throws(
    () =>
      credentialCrypto.buildEncryptedSecret('client-secret-value', {
        key: 'too-short',
        security: createFakeSecurity(),
      }),
    /SEEDLAB_CREDENTIAL_KEY/
  )
})

test('buildEncryptedSecret stores encrypted value and masked preview', () => {
  const result = credentialCrypto.buildEncryptedSecret('client-secret-value', {
    key: validKey,
    security: createFakeSecurity(),
  })

  assert.equal(result.encryptedSecret, `encrypted:${validKey}:client-secret-value`)
  assert.equal(result.secretPreview, '****alue')
})

test('buildTossClientOptions reads key and security helpers from PocketBase globals', () => {
  global.env = (name) => (name === 'SEEDLAB_CREDENTIAL_KEY' ? validKey : '')
  global.$security = createFakeSecurity()
  const connection = {
    clientId: 'client-id',
    encryptedSecret: `encrypted:${validKey}:client-secret-value`,
    accountSeq: '1',
  }

  assert.deepEqual(credentialCrypto.buildTossClientOptions(connection), {
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    accountSeq: '1',
  })
})

test('buildTossClientOptions decrypts broker connection secret', () => {
  const connection = {
    get(fieldName) {
      const fields = {
        clientId: 'client-id',
        encryptedSecret: `encrypted:${validKey}:client-secret-value`,
        accountSeq: '1',
      }

      return fields[fieldName]
    },
  }
  const options = credentialCrypto.buildTossClientOptions(connection, {
    key: validKey,
    security: createFakeSecurity(),
  })

  assert.deepEqual(options, {
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    accountSeq: '1',
  })
})
