;(function () {
  const button = document.querySelector('[data-hp-notification-button]')
  const label = document.querySelector('[data-hp-notification-label]')
  const status = document.querySelector('[data-hp-notification-status]')

  if (!button || !label || !status) {
    return
  }

  function setState(state, labelText, statusText, disabled) {
    button.dataset.state = state
    label.textContent = labelText
    status.textContent = statusText
    button.disabled = !!disabled
  }

  function getNativePermission() {
    if (!('Notification' in window)) {
      return 'unsupported'
    }

    return window.Notification.permission
  }

  function getPushSubscription(OneSignal) {
    if (!OneSignal || !OneSignal.User || !OneSignal.User.PushSubscription) {
      return null
    }

    return OneSignal.User.PushSubscription
  }

  function getPushSubscriptionId(OneSignal) {
    const pushSubscription = getPushSubscription(OneSignal)

    return String(pushSubscription && pushSubscription.id ? pushSubscription.id : '').trim()
  }

  function isPushOptedIn(OneSignal) {
    const pushSubscription = getPushSubscription(OneSignal)

    if (pushSubscription && typeof pushSubscription.optedIn === 'boolean') {
      return pushSubscription.optedIn && !!getPushSubscriptionId(OneSignal)
    }

    return false
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, milliseconds)
    })
  }

  async function waitForSubscriptionId(OneSignal) {
    for (let index = 0; index < 20; index += 1) {
      const subscriptionId = getPushSubscriptionId(OneSignal)

      if (subscriptionId) {
        return subscriptionId
      }

      await delay(300)
    }

    return ''
  }

  async function syncTags(OneSignal) {
    if (!OneSignal || !OneSignal.User) {
      return
    }

    const tags = {
      homeping_region: button.getAttribute('data-region') || '',
      homeping_include_closed: button.getAttribute('data-include-closed') || '0',
    }

    if (typeof OneSignal.User.addTags === 'function') {
      await OneSignal.User.addTags(tags)
      return
    }

    if (typeof OneSignal.User.addTag === 'function') {
      const keys = Object.keys(tags)

      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        await OneSignal.User.addTag(key, tags[key])
      }
    }
  }

  async function syncState(OneSignal) {
    const permission = getNativePermission()

    if (permission === 'unsupported') {
      setState('unsupported', '알림 불가', '지원 안 됨', true)
      return
    }

    if (permission === 'denied') {
      setState('blocked', '알림 차단됨', '브라우저 설정 필요', true)
      return
    }

    if (isPushOptedIn(OneSignal)) {
      await syncTags(OneSignal)
      setState('enabled', '알림 끄기', '알림 켜짐', false)
      return
    }

    setState('idle', '알림 받기', permission === 'granted' ? '구독 꺼짐' : '알림 꺼짐', false)
  }

  async function requestBrowserPermission(OneSignal) {
    if (OneSignal && OneSignal.Notifications && typeof OneSignal.Notifications.requestPermission === 'function') {
      await OneSignal.Notifications.requestPermission()
      return getNativePermission()
    }

    if ('Notification' in window && typeof window.Notification.requestPermission === 'function') {
      return window.Notification.requestPermission()
    }

    return getNativePermission()
  }

  async function setPushOptedIn(OneSignal, optedIn) {
    const pushSubscription = getPushSubscription(OneSignal)

    if (!pushSubscription) {
      return
    }

    if (optedIn && typeof pushSubscription.optIn === 'function') {
      await pushSubscription.optIn()
      return
    }

    if (!optedIn && typeof pushSubscription.optOut === 'function') {
      await pushSubscription.optOut()
    }
  }

  window.OneSignalDeferred = window.OneSignalDeferred || []
  window.OneSignalDeferred.push(async function (OneSignal) {
    setState('pending', '확인 중', '알림 상태 확인', true)
    await syncState(OneSignal)

    if (OneSignal.Notifications && typeof OneSignal.Notifications.addEventListener === 'function') {
      OneSignal.Notifications.addEventListener('permissionChange', function () {
        syncState(OneSignal)
      })
    }

    const pushSubscription = getPushSubscription(OneSignal)
    if (pushSubscription && typeof pushSubscription.addEventListener === 'function') {
      pushSubscription.addEventListener('change', function () {
        syncState(OneSignal)
      })
    }

    button.addEventListener('click', async function () {
      try {
        setState('pending', '처리 중', '브라우저 확인 중', true)

        if (isPushOptedIn(OneSignal)) {
          await setPushOptedIn(OneSignal, false)
          await syncState(OneSignal)
          return
        }

        const permission = await requestBrowserPermission(OneSignal)

        if (permission === 'granted') {
          await setPushOptedIn(OneSignal, true)
          await waitForSubscriptionId(OneSignal)
          await syncTags(OneSignal)
        }

        await syncState(OneSignal)
      } catch {
        setState('idle', '알림 받기', '다시 시도', false)
      }
    })
  })
})()
