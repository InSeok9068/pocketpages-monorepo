;(function () {
  const realtimeElement = document.getElementById('notification-realtime')
  const toastElement = document.getElementById('notification-realtime-toast')
  const unreadIndicator = document.getElementById('notification-unread-indicator')
  let toastTimer = 0

  function notificationPermission() {
    if (!window.isSecureContext) return 'insecure'
    if (!('Notification' in window)) return 'unsupported'
    return Notification.permission
  }

  function updatePermissionButtons() {
    const permission = notificationPermission()
    const buttons = document.querySelectorAll('[data-enable-browser-notifications]')

    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons[index]
      button.disabled = permission !== 'default'

      if (permission === 'granted') button.textContent = '브라우저 알림 사용 중'
      else if (permission === 'denied') button.textContent = '브라우저에서 알림이 차단됨'
      else if (permission === 'insecure') button.textContent = 'HTTPS 연결 필요'
      else if (permission === 'unsupported') button.textContent = '이 브라우저에서는 지원하지 않음'
      else button.textContent = '브라우저 알림 켜기'
    }

    const descriptions = document.querySelectorAll('[data-browser-notification-description]')
    for (let index = 0; index < descriptions.length; index += 1) {
      const description = descriptions[index]
      if (permission === 'granted') description.textContent = '예약한 일정이 되면 브라우저 알림으로 알려드립니다.'
      else if (permission === 'denied') description.textContent = '브라우저 사이트 설정에서 알림 권한을 허용해 주세요.'
      else if (permission === 'insecure') description.textContent = '내부망 주소에도 HTTPS를 적용해야 브라우저 알림을 사용할 수 있습니다.'
      else if (permission === 'unsupported') description.textContent = '현재 브라우저에서는 시스템 알림을 사용할 수 없습니다.'
      else description.textContent = '알림 권한은 이 버튼을 누를 때만 요청합니다.'
    }
  }

  function showToast(title, message) {
    if (!toastElement) return
    toastElement.textContent = message ? title + ' · ' + message : title
    toastElement.classList.remove('hidden')
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(function () {
      toastElement.classList.add('hidden')
    }, 6000)
  }

  function showBrowserNotification(notificationData) {
    if (notificationPermission() !== 'granted') return

    const notification = new Notification(notificationData['title'] || '업무 알림', {
      body: notificationData['message'] || '',
      tag: 'todo-notification-' + String(notificationData['id'] || ''),
    })

    notification.onclick = function () {
      window.focus()
      window.location.href = '/notification'
      notification.close()
    }
  }

  document.addEventListener('click', function (event) {
    const button = event.target instanceof Element ? event.target.closest('[data-enable-browser-notifications]') : null
    if (!button || notificationPermission() !== 'default') return

    Notification.requestPermission()
      .then(function () {
        updatePermissionButtons()
      })
      .catch(function () {
        updatePermissionButtons()
      })
  })

  if (realtimeElement) {
    realtimeElement.addEventListener('htmx:sseMessage', function (event) {
      let payload
      try {
        payload = JSON.parse(event.detail.data)
      } catch (_exception) {
        return
      }

      if (!payload || payload.action !== 'create' || !payload.record) return

      if (unreadIndicator) unreadIndicator.classList.remove('hidden')
      showToast(payload.record.title || '업무 알림', payload.record.message || '')
      showBrowserNotification(payload.record)
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updatePermissionButtons)
  else updatePermissionButtons()
})()
