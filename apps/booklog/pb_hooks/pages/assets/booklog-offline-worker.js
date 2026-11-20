// 푸시 서비스 워커에 함께 실리며, 네트워크 오류 때 오프라인 서재와 필요한 파일을 제공합니다.
var BOOKLOG_OFFLINE_CACHE = 'booklog-offline-v1'
var BOOKLOG_OFFLINE_PAGE = '/offline.html'
var BOOKLOG_OFFLINE_SHELL = [BOOKLOG_OFFLINE_PAGE, '/assets/booklog-offline.js']
var BOOKLOG_OFFLINE_FILES = BOOKLOG_OFFLINE_SHELL.concat([
  '/assets/vendor/jszip-3.10.1.min.js',
  '/assets/vendor/epubjs-0.3.93.min.js',
  '/assets/favicon.svg',
])
var booklogOfflineShellRefreshed = false

function cacheBooklogOfflineFiles(urls, cacheMode) {
  return caches.open(BOOKLOG_OFFLINE_CACHE).then(function (cache) {
    return cache.addAll(
      urls.map(function (url) {
        return new Request(url, { cache: cacheMode })
      })
    )
  })
}

// 서버가 바뀌었는지만 확인해 주므로(304), 바뀌지 않았으면 본문을 다시 받지 않습니다.
function refreshBooklogOfflineShell() {
  return cacheBooklogOfflineFiles(BOOKLOG_OFFLINE_SHELL, 'no-cache')
    .then(function () {
      return caches.open(BOOKLOG_OFFLINE_CACHE)
    })
    .then(function (cache) {
      return Promise.all(
        BOOKLOG_OFFLINE_FILES.map(function (file) {
          return cache.match(file).then(function (hit) {
            return hit ? null : cache.add(file)
          })
        })
      )
    })
    .catch(function () {})
}

function serveBooklogOfflinePage() {
  return caches.match(BOOKLOG_OFFLINE_PAGE, { cacheName: BOOKLOG_OFFLINE_CACHE }).then(function (cached) {
    return cached || Response.error()
  })
}

self.addEventListener('install', function (event) {
  self.skipWaiting()
  event.waitUntil(cacheBooklogOfflineFiles(BOOKLOG_OFFLINE_FILES, 'reload').catch(function () {}))
})

self.addEventListener('activate', function (event) {
  var navigationPreload = self.registration && self.registration.navigationPreload

  event.waitUntil(
    Promise.all([
      caches.keys().then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf('booklog-offline-') === 0 && key !== BOOKLOG_OFFLINE_CACHE
            })
            .map(function (key) {
              return caches.delete(key)
            })
        )
      }),
      // 워커가 깨어나는 동안 브라우저가 페이지 요청을 먼저 보내, 이동이 워커 때문에 늦어지지 않게 합니다.
      navigationPreload ? navigationPreload.enable().catch(function () {}) : null,
    ])
  )
})

self.addEventListener('fetch', function (event) {
  var request = event.request
  var url = new URL(request.url)
  var adminPage = url.pathname.indexOf('/_/') === 0

  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode !== 'navigate') {
    // 오프라인 HTML이 참조하는 파일만 대상으로 삼고 버전 쿼리가 붙은 온라인 자산은 건드리지 않습니다.
    if (url.search || url.pathname === BOOKLOG_OFFLINE_PAGE || BOOKLOG_OFFLINE_FILES.indexOf(url.pathname) === -1)
      return

    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(url.pathname, { cacheName: BOOKLOG_OFFLINE_CACHE }).then(function (cached) {
          return cached || Response.error()
        })
      })
    )
    return
  }

  // 미리 보낸 페이지 요청을 쓰지 않으면 같은 페이지를 두 번 받게 되어, 관리자 화면도 같은 응답을 그대로 넘깁니다.
  event.respondWith(
    Promise.resolve(event.preloadResponse)
      .then(function (preloaded) {
        return preloaded || fetch(request)
      })
      .then(function (response) {
        if (!adminPage && !booklogOfflineShellRefreshed) {
          booklogOfflineShellRefreshed = true
          event.waitUntil(refreshBooklogOfflineShell())
        }

        return response
      })
      .catch(function (error) {
        if (adminPage) throw error
        return serveBooklogOfflinePage()
      })
  )
})
