;(function () {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return

  // 푸시를 켜지 않은 기기에도 오프라인 서재가 생기도록, 등록된 워커가 없을 때만 같은 푸시 워커를 등록합니다.
  window.addEventListener('load', function () {
    navigator.serviceWorker
      .getRegistration('/')
      .then(function (registration) {
        if (!registration) return navigator.serviceWorker.register('/OneSignalSDKWorker.js', { scope: '/' })
      })
      .catch(function () {})
  })
})()
