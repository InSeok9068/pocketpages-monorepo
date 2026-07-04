'use strict'

// 사용자별 외부 API secret을 저장 전 암호화하고, 호출 직전에 복호화하는 모듈입니다.

const { globalApi } = require('pocketpages')
const { dbg, env, warn } = globalApi
const CREDENTIAL_KEY_ENV = 'SEEDLAB_CREDENTIAL_KEY'

/**
 * 공백을 제거한 문자열을 만듭니다.
 * @param {unknown} value 원본 값입니다.
 * @returns {string} 문자열 값입니다.
 */
function cleanText(value) {
  return String(value == null ? '' : value).trim()
}

/**
 * 필수 문자열 값을 확인합니다.
 * @param {unknown} value 확인할 값입니다.
 * @param {string} name 값 이름입니다.
 * @returns {string} 정리한 문자열입니다.
 */
function requireText(value, name) {
  const text = cleanText(value)
  if (!text) throw new Error(`${name} is required`)
  return text
}

/**
 * SeedLab credential 암호화 키를 읽습니다.
 * @param {types.SeedLabCredentialCryptoOptions} [options] 암호화 옵션입니다.
 * @returns {string} 32글자 암호화 키입니다.
 */
function readCredentialKey(options) {
  const safeOptions = options || {}
  const optionKey = cleanText(safeOptions.credentialKey || safeOptions.key)
  const envKey = optionKey ? '' : cleanText(env(CREDENTIAL_KEY_ENV))
  const key = optionKey || envKey
  const source = optionKey ? 'options' : 'env'

  dbg('seedlab/credential-crypto:read-key', {
    source,
    keyLength: key.length,
    hasEnvFunction: typeof env === 'function',
    hasOptionKey: !!optionKey,
  })

  if (key.length !== 32) {
    warn('seedlab/credential-crypto:read-key', {
      source,
      keyLength: key.length,
      expectedLength: 32,
      hasEnvFunction: typeof env === 'function',
      hasOptionKey: !!optionKey,
    })
    throw new Error(`${CREDENTIAL_KEY_ENV} must be exactly 32 characters`)
  }

  return key
}

/**
 * PocketBase security 헬퍼를 가져옵니다.
 * @param {types.SeedLabCredentialCryptoOptions} [options] 암호화 옵션입니다.
 * @returns {{ encrypt: Function, decrypt: Function }} 암복호화 헬퍼입니다.
 */
function resolveSecurity(options) {
  const safeOptions = options || {}
  const security = safeOptions.security || (typeof $security === 'undefined' ? null : $security)

  if (!security || typeof security.encrypt !== 'function' || typeof security.decrypt !== 'function') {
    throw new Error('$security.encrypt/decrypt is required')
  }

  return security
}

/**
 * 화면에 보여줄 secret 미리보기 값을 만듭니다.
 * @param {unknown} secret 원본 secret입니다.
 * @returns {string} 마스킹된 secret입니다.
 */
function maskSecret(secret) {
  const text = cleanText(secret)
  if (!text) return ''
  if (text.length <= 4) return '****'
  return '****' + text.slice(-4)
}

/**
 * 외부 API secret을 암호화합니다.
 * @param {unknown} secret 원본 secret입니다.
 * @param {types.SeedLabCredentialCryptoOptions} [options] 암호화 옵션입니다.
 * @returns {string} 암호화된 secret입니다.
 */
function encryptSecret(secret, options) {
  const plainSecret = requireText(secret, 'secret')
  const key = readCredentialKey(options)
  const security = resolveSecurity(options)

  return String(security.encrypt(plainSecret, key) || '')
}

/**
 * 외부 API secret을 복호화합니다.
 * @param {unknown} encryptedSecret 암호화된 secret입니다.
 * @param {types.SeedLabCredentialCryptoOptions} [options] 암호화 옵션입니다.
 * @returns {string} 복호화된 secret입니다.
 */
function decryptSecret(encryptedSecret, options) {
  const cipherText = requireText(encryptedSecret, 'encryptedSecret')
  const key = readCredentialKey(options)
  const security = resolveSecurity(options)
  const plainSecret = security.decrypt(cipherText, key)

  return cleanText(plainSecret)
}

/**
 * 저장용 secret 필드 값을 만듭니다.
 * @param {unknown} secret 원본 secret입니다.
 * @param {types.SeedLabCredentialCryptoOptions} [options] 암호화 옵션입니다.
 * @returns {types.SeedLabEncryptedSecret} 저장할 secret 값입니다.
 */
function buildEncryptedSecret(secret, options) {
  const plainSecret = requireText(secret, 'secret')

  return {
    encryptedSecret: encryptSecret(plainSecret, options),
    secretPreview: maskSecret(plainSecret),
  }
}

/**
 * PocketBase Record 또는 일반 객체에서 필드를 읽습니다.
 * @param {types.SeedLabTossConnectionLike} connection 연결 레코드입니다.
 * @param {string} fieldName 필드 이름입니다.
 * @returns {string} 필드 값입니다.
 */
function readConnectionField(connection, fieldName) {
  if (!connection) return ''
  if (typeof connection.get === 'function') return cleanText(connection.get(fieldName))
  return cleanText(connection[fieldName])
}

/**
 * broker_connections 레코드에서 Toss API 클라이언트 옵션을 만듭니다.
 * @param {types.SeedLabTossConnectionLike} connection 연결 레코드입니다.
 * @param {types.SeedLabCredentialCryptoOptions} [options] 암호화 옵션입니다.
 * @returns {types.TossApiClientOptions} Toss API 클라이언트 옵션입니다.
 */
function buildTossClientOptions(connection, options) {
  return {
    clientId: requireText(readConnectionField(connection, 'clientId'), 'clientId'),
    clientSecret: decryptSecret(readConnectionField(connection, 'encryptedSecret'), options),
    accountSeq: readConnectionField(connection, 'accountSeq'),
  }
}

module.exports = {
  buildEncryptedSecret,
  buildTossClientOptions,
}
