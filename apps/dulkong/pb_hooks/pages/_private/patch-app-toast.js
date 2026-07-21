const ToastDuration = 2800
const ToastTones = ['info', 'success', 'error']

/**
 * 앱 전역 토스트를 표시합니다.
 * @param {typeof datastar} datastarApi Datastar 응답 API
 * @param {string} message 표시할 문구
 * @param {'info' | 'success' | 'error'} [tone='info'] 토스트 색상
 */
function patchAppToast(datastarApi, message, tone) {
  const displayMessage = String(message || '').trim()
  const displayTone = ToastTones.indexOf(tone) >= 0 ? tone : 'info'

  datastarApi.patchSignals({
    appToastMessage: displayMessage,
    appToastTone: displayTone,
  })
  datastarApi.executeScript(
    'window.clearTimeout(window.dulkongToastTimer);' +
      'window.dulkongToastTimer = window.setTimeout(function () {' +
      "window.patchSignals && window.patchSignals({appToastMessage: ''})" +
      '}, ' +
      String(ToastDuration) +
      ')'
  )
}

module.exports = {
  patchAppToast,
}
