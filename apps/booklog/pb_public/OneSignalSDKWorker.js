importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

try {
  importScripts('/assets/booklog-offline-worker.js')
} catch (_error) {
  /* 오프라인 서재 없이 푸시만 동작합니다. */
}
