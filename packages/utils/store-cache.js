/* global $app */

'use strict';

const STORE_VERSION = 1;

/**
 * store에 저장할 수 있도록 JSON 값을 복제합니다.
 *
 * @param {any} value 복제할 값
 * @returns {any} 복제된 값
 */
function cloneJsonValue(value) {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

/**
 * TTL millisecond 값을 검증합니다.
 *
 * @param {{ ttlMs?: number }} [options] 호출 옵션
 * @returns {number} TTL millisecond
 */
function resolveRequiredTtlMs(options) {
  const ttlMs = options && typeof options.ttlMs === 'number' ? options.ttlMs : 0;

  if (!isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('storeCache ttlMs must be a positive number.');
  }

  return ttlMs;
}

/**
 * cache key 문자열을 정규화합니다.
 *
 * @param {string} value key 값
 * @returns {string} 정규화된 key
 */
function normalizeKey(value) {
  return String(value || '').trim();
}

/**
 * cache namespace 문자열을 정규화합니다.
 *
 * @param {string} value namespace 값
 * @returns {string} 정규화된 namespace
 */
function normalizeNamespace(value) {
  const namespace = normalizeKey(value);

  if (!namespace) {
    throw new Error('storeCache namespace is required.');
  }

  return namespace;
}

/**
 * PocketBase app runtime store를 반환합니다.
 *
 * @returns {{ get: Function, set: Function }} PocketBase runtime store
 */
function getRuntimeStore() {
  const runtimeStore = $app.store();

  if (!runtimeStore || typeof runtimeStore.get !== 'function' || typeof runtimeStore.set !== 'function') {
    throw new Error('storeCache requires PocketBase $app.store().');
  }

  return runtimeStore;
}

/**
 * store namespace 값을 읽습니다.
 *
 * @param {string} namespace cache namespace
 * @returns {any} 저장된 namespace 값
 */
function readStoreValue(namespace) {
  return getRuntimeStore().get(namespace);
}

/**
 * store namespace 값을 저장합니다.
 *
 * @param {string} namespace cache namespace
 * @param {any} value 저장할 값
 */
function writeStoreValue(namespace, value) {
  getRuntimeStore().set(namespace, value);
}

/**
 * namespace cache 객체를 정규화합니다.
 *
 * @param {any} value 저장된 namespace 값
 * @returns {{ version: number, entries: Record<string, any> }} cache 객체
 */
function normalizeBucket(value) {
  const bucket = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const entries = bucket && bucket.entries && typeof bucket.entries === 'object' && !Array.isArray(bucket.entries)
    ? bucket.entries
    : {};

  return {
    version: STORE_VERSION,
    entries: entries,
  };
}

/**
 * 만료된 cache entry인지 확인합니다.
 *
 * @param {any} entry cache entry
 * @param {number} nowMs 현재 시각
 * @returns {boolean} 만료 여부
 */
function isExpiredEntry(entry, nowMs) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return true;
  }

  if (!entry.expiresAt) {
    return false;
  }

  return Number(entry.expiresAt) <= nowMs;
}

/**
 * 오래된 entry를 maxEntries 수만큼 남깁니다.
 *
 * @param {{ entries: Record<string, any> }} bucket cache 객체
 * @param {number} maxEntries 최대 entry 수
 */
function trimEntries(bucket, maxEntries) {
  if (!isFinite(maxEntries) || maxEntries <= 0) {
    return;
  }

  const keys = Object.keys(bucket.entries);

  if (keys.length <= maxEntries) {
    return;
  }

  keys
    .sort((left, right) => {
      const leftEntry = bucket.entries[left] || {};
      const rightEntry = bucket.entries[right] || {};
      const leftMs = Number(leftEntry.updatedAt || leftEntry.createdAt || 0);
      const rightMs = Number(rightEntry.updatedAt || rightEntry.createdAt || 0);

      return leftMs - rightMs;
    })
    .slice(0, keys.length - maxEntries)
    .forEach((key) => {
      delete bucket.entries[key];
    });
}

/**
 * namespace cache를 읽고 만료 entry를 정리합니다.
 *
 * @param {string} namespace cache namespace
 * @param {{ maxEntries?: number }} [options] 호출 옵션
 * @returns {{ bucket: { version: number, entries: Record<string, any> }, nowMs: number }}
 */
function readBucket(namespace, options) {
  const nowMs = Date.now();
  const bucket = normalizeBucket(readStoreValue(namespace));
  let changed = false;

  Object.keys(bucket.entries).forEach((key) => {
    if (isExpiredEntry(bucket.entries[key], nowMs)) {
      delete bucket.entries[key];
      changed = true;
    }
  });

  if (options && typeof options.maxEntries === 'number') {
    const beforeCount = Object.keys(bucket.entries).length;
    trimEntries(bucket, options.maxEntries);
    changed = changed || Object.keys(bucket.entries).length !== beforeCount;
  }

  if (changed) {
    writeStoreValue(namespace, bucket);
  }

  return {
    bucket: bucket,
    nowMs: nowMs,
  };
}

/**
 * TTL cache 값을 읽습니다.
 *
 * @param {string} namespace cache namespace
 * @param {string} key cache key
 * @param {{ maxEntries?: number }} [options] 호출 옵션
 * @returns {any | undefined} cache 값 또는 undefined
 */
function get(namespace, key, options) {
  const cacheKey = normalizeKey(key);

  if (!cacheKey) {
    return undefined;
  }

  const cacheNamespace = normalizeNamespace(namespace);
  const state = readBucket(cacheNamespace, options || {});
  const entry = state.bucket.entries[cacheKey];

  if (!entry) {
    return undefined;
  }

  if (isExpiredEntry(entry, state.nowMs)) {
    delete state.bucket.entries[cacheKey];
    writeStoreValue(cacheNamespace, state.bucket);
    return undefined;
  }

  return cloneJsonValue(entry.value);
}

/**
 * TTL cache 값을 저장합니다.
 *
 * @param {string} namespace cache namespace
 * @param {string} key cache key
 * @param {any} value cache 값
 * @param {{ ttlMs: number, maxEntries?: number }} options 호출 옵션
 * @returns {any} 저장한 값
 */
function set(namespace, key, value, options) {
  const cacheKey = normalizeKey(key);
  const cacheNamespace = normalizeNamespace(namespace);

  if (!cacheKey) {
    throw new Error('storeCache key is required.');
  }

  const state = readBucket(cacheNamespace, options || {});
  const ttlMs = resolveRequiredTtlMs(options || {});
  const previousEntry = state.bucket.entries[cacheKey];

  state.bucket.entries[cacheKey] = {
    createdAt: previousEntry && previousEntry.createdAt ? previousEntry.createdAt : state.nowMs,
    updatedAt: state.nowMs,
    expiresAt: state.nowMs + ttlMs,
    value: cloneJsonValue(value),
  };

  if (options && typeof options.maxEntries === 'number') {
    trimEntries(state.bucket, options.maxEntries);
  }

  writeStoreValue(cacheNamespace, state.bucket);

  return cloneJsonValue(value);
}

/**
 * TTL cache 값을 읽고, 없으면 load 결과를 저장합니다.
 *
 * @param {string} namespace cache namespace
 * @param {string} key cache key
 * @param {{ ttlMs: number, maxEntries?: number, load: Function }} options 호출 옵션
 * @returns {any} cache 값 또는 load 결과
 */
function remember(namespace, key, options) {
  if (!options || typeof options.load !== 'function') {
    throw new Error('storeCache remember requires load function.');
  }

  const cachedValue = get(namespace, key, options);

  if (cachedValue !== undefined) {
    return cachedValue;
  }

  return set(namespace, key, options.load(), options);
}

/**
 * TTL cache 값을 삭제합니다.
 *
 * @param {string} namespace cache namespace
 * @param {string} key cache key
 * @returns {boolean} 삭제 여부
 */
function remove(namespace, key) {
  const cacheKey = normalizeKey(key);
  const cacheNamespace = normalizeNamespace(namespace);
  const bucket = normalizeBucket(readStoreValue(cacheNamespace));

  if (!cacheKey || !bucket.entries[cacheKey]) {
    return false;
  }

  delete bucket.entries[cacheKey];
  writeStoreValue(cacheNamespace, bucket);

  return true;
}

/**
 * namespace cache의 만료 entry를 정리합니다.
 *
 * @param {string} namespace cache namespace
 * @param {{ maxEntries?: number }} [options] 호출 옵션
 * @returns {number} 정리 후 남은 entry 수
 */
function cleanup(namespace, options) {
  const state = readBucket(normalizeNamespace(namespace), options || {});

  return Object.keys(state.bucket.entries).length;
}

module.exports = {
  get,
  set,
  remember,
  remove,
  cleanup,
};
