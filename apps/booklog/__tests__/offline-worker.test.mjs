import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const workerSource = readFileSync(new URL('../pb_hooks/pages/assets/booklog-offline-worker.js', import.meta.url), 'utf8')
const pushWorkerSource = readFileSync(new URL('../pb_public/OneSignalSDKWorker.js', import.meta.url), 'utf8')
const origin = 'https://booklog.test'
const SHELL = ['/offline.html', '/assets/booklog-offline.js']
const ALL_FILES = [...SHELL, '/assets/vendor/jszip-3.10.1.min.js', '/assets/vendor/epubjs-0.3.93.min.js', '/assets/favicon.svg']

function createWorker(options = {}) {
  const listeners = {}
  const stores = new Map(
    Object.entries(options.caches || {}).map(([name, urls]) => [name, new Map(urls.map((url) => [url, 'old']))])
  )
  const pageFetches = []
  const fileFetches = []
  const state = { preloadEnabled: false }
  const openStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      addAll: async (requests) => {
        for (const request of requests) {
          fileFetches.push(request.url + ' ' + request.cache)
          if (options.offline) throw new TypeError('Failed to fetch')
        }
        for (const request of requests) store.set(request.url, 'file:' + request.url)
      },
      add: async (url) => {
        fileFetches.push(url + ' default')
        store.set(url, 'file:' + url)
      },
      match: async (url) => store.get(url),
    }
  }
  const context = {
    URL,
    Promise,
    Request: class {
      constructor(url, init) {
        this.url = url
        this.cache = init && init.cache
      }
    },
    Response: { error: () => 'response-error' },
    fetch: async (request) => {
      pageFetches.push(request.url)
      if (options.offline) throw new TypeError('Failed to fetch')
      return 'network:' + request.url
    },
    caches: {
      open: async (name) => openStore(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (url, matchOptions) => openStore(matchOptions.cacheName).match(url),
    },
    self: {
      location: new URL(origin + '/'),
      registration: {
        navigationPreload: {
          enable: async () => {
            state.preloadEnabled = true
          },
        },
      },
      skipWaiting() {},
      addEventListener(type, listener) {
        listeners[type] = listener
      },
    },
  }
  vm.runInNewContext(workerSource, context)
  return { listeners, stores, pageFetches, fileFetches, state }
}

async function dispatch(worker, type, init = {}) {
  const pending = []
  let response
  let responded = false
  worker.listeners[type]({
    request: init.request,
    preloadResponse: init.preloadResponse,
    waitUntil: (promise) => pending.push(promise),
    respondWith: (promise) => {
      responded = true
      response = promise
    },
  })
  const result = await response
  await Promise.all(pending)
  return { responded, response: result }
}

function navigation(path, method = 'GET') {
  return { url: origin + path, mode: 'navigate', method }
}

test('Installing downloads every offline shelf file fresh once', async () => {
  const worker = createWorker()
  await dispatch(worker, 'install')
  assert.deepEqual([...worker.stores.get('booklog-offline-v1').keys()], ALL_FILES)
  assert.deepEqual(worker.fileFetches, ALL_FILES.map((file) => file + ' reload'))
})

test('Installing while offline still installs the worker, so push keeps working', async () => {
  const worker = createWorker({ offline: true })
  await assert.doesNotReject(dispatch(worker, 'install'))
})

test('Activating turns on navigation preload, so page moves do not wait for the worker to wake up', async () => {
  const worker = createWorker()
  await dispatch(worker, 'activate')
  assert.equal(worker.state.preloadEnabled, true)
})

test('A preloaded page is used as is, without asking the server for the same page again', async () => {
  const worker = createWorker()
  const { responded, response } = await dispatch(worker, 'fetch', {
    request: navigation('/books/b1/read'),
    preloadResponse: Promise.resolve('preloaded:/books/b1/read'),
  })
  assert.equal(responded, true)
  assert.equal(response, 'preloaded:/books/b1/read')
  assert.deepEqual(worker.pageFetches, [])
})

test('Without a preloaded page, online visits get the server page unchanged', async () => {
  const worker = createWorker()
  const { response } = await dispatch(worker, 'fetch', { request: navigation('/library') })
  assert.equal(response, 'network:' + origin + '/library')
})

test('After a page loads, the offline shelf is only revalidated, once per worker wake-up', async () => {
  const worker = createWorker({ caches: { 'booklog-offline-v1': ALL_FILES } })
  await dispatch(worker, 'fetch', { request: navigation('/library') })
  await dispatch(worker, 'fetch', { request: navigation('/reviews') })
  assert.deepEqual(worker.fileFetches, SHELL.map((file) => file + ' no-cache'))
})

test('A file missing from the offline shelf is fetched again after a page loads', async () => {
  const worker = createWorker({ caches: { 'booklog-offline-v1': SHELL } })
  await dispatch(worker, 'fetch', { request: navigation('/library') })
  assert.deepEqual(worker.fileFetches.slice(SHELL.length), ALL_FILES.slice(SHELL.length).map((file) => file + ' default'))
})

test('A page visit that fails on the network shows the offline shelf', async () => {
  const worker = createWorker({ offline: true, caches: { 'booklog-offline-v1': ['/offline.html'] } })
  const { response } = await dispatch(worker, 'fetch', {
    request: navigation('/library'),
    preloadResponse: Promise.reject(new TypeError('Failed to fetch')),
  })
  assert.equal(response, 'old')
  assert.deepEqual(worker.fileFetches, [], 'nothing is downloaded while offline')
})

test('Without a saved offline shelf, a failed visit stays the browser network error', async () => {
  const worker = createWorker({ offline: true })
  const { response } = await dispatch(worker, 'fetch', { request: navigation('/library') })
  assert.equal(response, 'response-error')
})

test('The PocketBase admin uses the preloaded page but never shows the offline shelf', async () => {
  const online = createWorker()
  const { response } = await dispatch(online, 'fetch', {
    request: navigation('/_/'),
    preloadResponse: Promise.resolve('preloaded:/_/'),
  })
  assert.equal(response, 'preloaded:/_/')
  assert.deepEqual(online.fileFetches, [], 'the admin does not refresh the offline shelf')

  const offline = createWorker({ offline: true, caches: { 'booklog-offline-v1': ['/offline.html'] } })
  await assert.rejects(dispatch(offline, 'fetch', { request: navigation('/_/') }), /Failed to fetch/)
})

test('Files, form posts and other sites are left to the browser', async () => {
  const worker = createWorker()
  for (const request of [
    { url: origin + '/assets/style.css', mode: 'no-cors', method: 'GET' },
    navigation('/xapi/epub/upload', 'POST'),
    { url: 'https://cdn.onesignal.com/page.js', mode: 'navigate', method: 'GET' },
  ]) {
    const { responded } = await dispatch(worker, 'fetch', { request })
    assert.equal(responded, false, request.url)
  }
})

test('Updating clears older offline caches but keeps the audiobook cache', async () => {
  const worker = createWorker({
    caches: { 'booklog-offline-v0': ['/offline.html'], 'booklog-audio-v3': ['/audio'], 'booklog-offline-v1': [] },
  })
  await dispatch(worker, 'activate')
  assert.deepEqual([...worker.stores.keys()].sort(), ['booklog-audio-v3', 'booklog-offline-v1'])
})

test('The push worker still loads when the offline script cannot be fetched', () => {
  const imported = []
  const context = {
    importScripts(url) {
      imported.push(url)
      if (url.startsWith('/assets/')) throw new Error('NetworkError')
    },
  }
  assert.doesNotThrow(() => vm.runInNewContext(pushWorkerSource, context))
  assert.deepEqual(imported, ['https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js', '/assets/booklog-offline-worker.js'])
})
