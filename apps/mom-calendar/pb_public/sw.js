const CACHE_NAME = 'mom-calendar-shell-v1'

const APP_SHELL_URLS = [
  '/',
  '/assets/favicon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-512-maskable.png',
  '/assets/manifest.webmanifest',
  '/assets/style.css',
  '/assets/js/mom-calendar-db.js',
  '/assets/js/mom-calendar-app.js',
  '/assets/vendor/alpine-3.15.11-cdn.min.js',
  '/assets/vendor/fullcalendar-6.1.21.global.min.js',
]

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(APP_SHELL_URLS)
      })
      .then(function () {
        return self.skipWaiting()
      })
  )
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (cacheNames) {
        return Promise.all(
          cacheNames
            .filter(function (cacheName) {
              return cacheName !== CACHE_NAME
            })
            .map(function (cacheName) {
              return caches.delete(cacheName)
            })
        )
      })
      .then(function () {
        return self.clients.claim()
      })
  )
})

self.addEventListener('fetch', function (event) {
  const request = event.request

  if (request.method !== 'GET') {
    return
  }

  const requestUrl = new URL(request.url)

  if (requestUrl.origin !== self.location.origin) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(function () {
      return caches.match('/')
    }))
    return
  }

  if (requestUrl.pathname.startsWith('/assets/')) {
    event.respondWith(fetchAndCacheAsset(request))
  }
})

function fetchAndCacheAsset(request) {
  return fetch(request)
    .then(function (response) {
      const responseCopy = response.clone()

      caches.open(CACHE_NAME).then(function (cache) {
        cache.put(request, responseCopy)
      })

      return response
    })
    .catch(function () {
      return caches.match(request).then(function (cachedResponse) {
        return cachedResponse || caches.match(toUnfingerprintedAssetUrl(request.url))
      })
    })
}

function toUnfingerprintedAssetUrl(url) {
  const requestUrl = new URL(url)
  requestUrl.search = ''
  requestUrl.pathname = requestUrl.pathname.replace(/\.([a-f0-9]{8,})(\.[^/.]+)$/i, '$2')

  return requestUrl.toString()
}
