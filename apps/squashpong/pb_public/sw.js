const CACHE_NAME = 'squashpong-v1'
const SHELL_ASSETS = [
  '/',
  '/assets/style.css',
  '/assets/manifest.json',
  '/assets/favicon.svg',
  '/assets/squashpong/game-rules.js',
  '/assets/squashpong/game.js',
  '/assets/squashpong/court.svg',
  '/assets/squashpong/player-lime.svg',
  '/assets/squashpong/player-sky.svg',
  '/assets/squashpong/player-coral.svg',
  '/assets/squashpong/player-violet.svg',
]

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(SHELL_ASSETS)
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
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return
  }

  event.respondWith(
    fetch(request)
      .then(function (response) {
        const responseForCache = response.clone()

        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(request, responseForCache)
        })

        return response
      })
      .catch(function () {
        return caches.match(request).then(function (cachedResponse) {
          return cachedResponse || caches.match('/')
        })
      })
  )
})
