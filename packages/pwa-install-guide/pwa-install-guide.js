;(function () {
  'use strict'

  const script = document.currentScript
  if (!script || script.dataset.pwaInstallGuideReady === 'true') return
  script.dataset.pwaInstallGuideReady = 'true'

  const appName = String(script.dataset.appName || '이 서비스').trim()
  const delay = readPositiveNumber(script.dataset.delay, 3000)
  const dismissDays = readPositiveNumber(script.dataset.dismissDays, 14)
  const storageKey = String(script.dataset.storageKey || 'pwa-install-guide-dismissed-at').trim()
  const autoShow = script.dataset.autoShow !== 'false'
  const isIos = detectIos()
  const isAndroid = /Android/i.test(navigator.userAgent)
  let installPrompt = null
  let banner = null
  let sheet = null
  let showTimer = null
  let previousFocus = null

  function readPositiveNumber(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : fallback
  }

  function detectIos() {
    return (
      /iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  }

  function readDismissedAt() {
    try {
      return Number(window.localStorage.getItem(storageKey) || 0)
    } catch (_error) {
      return 0
    }
  }

  function isDismissed() {
    const dismissedAt = readDismissedAt()
    if (!dismissedAt) return false
    return Date.now() - dismissedAt < dismissDays * 24 * 60 * 60 * 1000
  }

  function saveDismissedAt() {
    try {
      window.localStorage.setItem(storageKey, String(Date.now()))
    } catch (_error) {
      // 저장할 수 없는 환경에서는 현재 화면에서만 닫습니다.
    }
  }

  function clearDismissedAt() {
    try {
      window.localStorage.removeItem(storageKey)
    } catch (_error) {
      // 저장소 접근이 막혀 있어도 다시 표시할 수 있습니다.
    }
  }

  function ensureStyles() {
    if (document.getElementById('pwa-install-guide-styles')) return

    const style = document.createElement('style')
    style.id = 'pwa-install-guide-styles'
    style.textContent = `
      .pwa-install-guide,
      .pwa-install-guide *,
      .pwa-install-guide-sheet,
      .pwa-install-guide-sheet * {
        box-sizing: border-box;
      }

      .pwa-install-guide {
        position: fixed;
        right: 16px;
        bottom: calc(16px + env(safe-area-inset-bottom));
        left: 16px;
        z-index: 2147483000;
        max-width: 420px;
        margin: 0 auto;
        color: #171717;
        font-family: inherit;
      }

      .pwa-install-guide__card {
        position: relative;
        display: grid;
        grid-template-columns: 44px minmax(0, 1fr);
        gap: 12px;
        padding: 16px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
      }

      .pwa-install-guide__icon {
        display: flex;
        width: 44px;
        height: 44px;
        align-items: center;
        justify-content: center;
        border-radius: 13px;
        background: #171717;
        color: #fff;
      }

      .pwa-install-guide__icon svg,
      .pwa-install-guide__button svg,
      .pwa-install-guide__step-icon svg {
        width: 22px;
        height: 22px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }

      .pwa-install-guide__content {
        min-width: 0;
        padding-right: 24px;
      }

      .pwa-install-guide__title,
      .pwa-install-guide__description {
        margin: 0;
      }

      .pwa-install-guide__title {
        overflow: hidden;
        color: #171717;
        font-size: 15px;
        font-weight: 750;
        line-height: 1.4;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pwa-install-guide__description {
        margin-top: 3px;
        color: #666;
        font-size: 13px;
        line-height: 1.5;
      }

      .pwa-install-guide__actions {
        display: flex;
        grid-column: 1 / -1;
        justify-content: flex-end;
        margin-top: 2px;
      }

      .pwa-install-guide__button {
        display: inline-flex;
        min-height: 42px;
        align-items: center;
        justify-content: center;
        gap: 7px;
        padding: 0 17px;
        border: 0;
        border-radius: 13px;
        background: #171717;
        color: #fff;
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }

      .pwa-install-guide__button:focus-visible,
      .pwa-install-guide__close:focus-visible {
        outline: 3px solid rgba(40, 113, 255, 0.35);
        outline-offset: 2px;
      }

      .pwa-install-guide__button:disabled {
        cursor: wait;
        opacity: 0.6;
      }

      .pwa-install-guide__close {
        position: absolute;
        top: 9px;
        right: 9px;
        display: flex;
        width: 34px;
        height: 34px;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #777;
        font: inherit;
        font-size: 23px;
        line-height: 1;
        cursor: pointer;
      }

      .pwa-install-guide-sheet {
        position: fixed;
        inset: 0;
        z-index: 2147483001;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
        background: rgba(0, 0, 0, 0.46);
        font-family: inherit;
      }

      .pwa-install-guide-sheet__panel {
        position: relative;
        width: 100%;
        max-width: 460px;
        max-height: min(620px, calc(100vh - 32px));
        overflow: auto;
        padding: 24px 20px 20px;
        border-radius: 24px;
        background: #fff;
        color: #171717;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.25);
      }

      .pwa-install-guide-sheet__eyebrow,
      .pwa-install-guide-sheet__title,
      .pwa-install-guide-sheet__description,
      .pwa-install-guide__step p {
        margin: 0;
      }

      .pwa-install-guide-sheet__eyebrow {
        color: #666;
        font-size: 12px;
        font-weight: 700;
      }

      .pwa-install-guide-sheet__title {
        margin-top: 4px;
        padding-right: 34px;
        font-size: 21px;
        font-weight: 800;
        line-height: 1.35;
      }

      .pwa-install-guide-sheet__description {
        margin-top: 7px;
        color: #666;
        font-size: 14px;
        line-height: 1.55;
      }

      .pwa-install-guide__steps {
        display: grid;
        gap: 10px;
        margin: 20px 0;
        padding: 0;
        list-style: none;
      }

      .pwa-install-guide__step {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        gap: 12px;
        align-items: center;
        min-height: 64px;
        padding: 11px 13px;
        border: 1px solid #e7e7e7;
        border-radius: 16px;
        background: #fafafa;
        font-size: 14px;
        line-height: 1.5;
      }

      .pwa-install-guide__step-icon {
        display: flex;
        width: 42px;
        height: 42px;
        align-items: center;
        justify-content: center;
        border-radius: 13px;
        background: #ededed;
        color: #171717;
        font-size: 15px;
        font-weight: 800;
      }

      .pwa-install-guide-sheet__button {
        width: 100%;
      }

      @media (prefers-reduced-motion: no-preference) {
        .pwa-install-guide {
          animation: pwa-install-guide-enter 220ms ease-out both;
        }

        .pwa-install-guide-sheet__panel {
          animation: pwa-install-guide-sheet-enter 220ms ease-out both;
        }
      }

      @media (prefers-color-scheme: dark) {
        .pwa-install-guide__card,
        .pwa-install-guide-sheet__panel {
          border-color: rgba(255, 255, 255, 0.12);
          background: #202020;
          color: #f7f7f7;
        }

        .pwa-install-guide__title,
        .pwa-install-guide-sheet__title {
          color: #f7f7f7;
        }

        .pwa-install-guide__description,
        .pwa-install-guide-sheet__description,
        .pwa-install-guide-sheet__eyebrow {
          color: #b8b8b8;
        }

        .pwa-install-guide__icon,
        .pwa-install-guide__button {
          background: #f5f5f5;
          color: #171717;
        }

        .pwa-install-guide__close {
          color: #b8b8b8;
        }

        .pwa-install-guide__step {
          border-color: #3a3a3a;
          background: #292929;
        }

        .pwa-install-guide__step-icon {
          background: #393939;
          color: #f7f7f7;
        }
      }

      @keyframes pwa-install-guide-enter {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes pwa-install-guide-sheet-enter {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `
    document.head.appendChild(style)
  }

  function createDownloadIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v12"></path>
        <path d="m7 10 5 5 5-5"></path>
        <path d="M5 21h14"></path>
      </svg>
    `
  }

  function createShareIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 16V3"></path>
        <path d="m8 7 4-4 4 4"></path>
        <path d="M5 11v9h14v-9"></path>
      </svg>
    `
  }

  function removeBanner() {
    if (!banner) return
    banner.remove()
    banner = null
  }

  function removeSheet() {
    if (!sheet) return
    sheet.remove()
    sheet = null
    document.removeEventListener('keydown', handleSheetKeydown)
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
    previousFocus = null
  }

  function dismiss() {
    window.clearTimeout(showTimer)
    saveDismissedAt()
    removeSheet()
    removeBanner()
  }

  function handleSheetKeydown(event) {
    if (event.key !== 'Escape') return
    dismiss()
  }

  function openIosInstructions() {
    if (!isIos || sheet) return
    ensureStyles()
    previousFocus = document.activeElement

    sheet = document.createElement('div')
    sheet.className = 'pwa-install-guide-sheet'
    sheet.innerHTML = `
      <section
        class="pwa-install-guide-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pwa-install-guide-sheet-title"
        aria-describedby="pwa-install-guide-sheet-description">
        <button class="pwa-install-guide__close" type="button" aria-label="설치 안내 닫기">×</button>
        <p class="pwa-install-guide-sheet__eyebrow">홈 화면에 추가</p>
        <h2 id="pwa-install-guide-sheet-title" class="pwa-install-guide-sheet__title">iPhone·iPad에 설치하기</h2>
        <p id="pwa-install-guide-sheet-description" class="pwa-install-guide-sheet__description">브라우저 메뉴에서 세 단계면 설치할 수 있어요.</p>
        <ol class="pwa-install-guide__steps">
          <li class="pwa-install-guide__step">
            <span class="pwa-install-guide__step-icon">${createShareIcon()}</span>
            <p>브라우저 도구 막대에서 <strong>공유</strong> 버튼을 눌러주세요.</p>
          </li>
          <li class="pwa-install-guide__step">
            <span class="pwa-install-guide__step-icon">2</span>
            <p>메뉴에서 <strong>홈 화면에 추가</strong>를 선택해 주세요.</p>
          </li>
          <li class="pwa-install-guide__step">
            <span class="pwa-install-guide__step-icon">3</span>
            <p><strong>웹 앱으로 열기</strong>가 보이면 켠 뒤 <strong>추가</strong>를 눌러주세요.</p>
          </li>
        </ol>
        <button class="pwa-install-guide__button pwa-install-guide-sheet__button" type="button">확인했어요</button>
      </section>
    `

    const panel = sheet.querySelector('.pwa-install-guide-sheet__panel')
    const closeButton = sheet.querySelector('.pwa-install-guide__close')
    const confirmButton = sheet.querySelector('.pwa-install-guide-sheet__button')
    closeButton.addEventListener('click', dismiss)
    confirmButton.addEventListener('click', dismiss)
    sheet.addEventListener('click', function (event) {
      if (event.target === sheet) dismiss()
    })
    document.body.appendChild(sheet)
    document.addEventListener('keydown', handleSheetKeydown)
    removeBanner()
    panel.setAttribute('tabindex', '-1')
    panel.focus()
  }

  function requestAndroidInstall(button) {
    if (!installPrompt) return
    const promptEvent = installPrompt
    button.disabled = true
    const promptResult = promptEvent.prompt()
    const choicePromise =
      promptResult && typeof promptResult.then === 'function' ? promptResult : promptEvent.userChoice
    Promise.resolve(choicePromise)
      .then(function (choice) {
        installPrompt = null
        removeBanner()
        if (choice && choice.outcome === 'dismissed') saveDismissedAt()
      })
      .catch(function () {
        installPrompt = null
        removeBanner()
      })
  }

  function showBanner(options) {
    const force = options && options.force === true
    if (banner || sheet || isStandalone()) return
    if (!force && isDismissed()) return
    if (!isIos && !(isAndroid && installPrompt)) return
    if (!document.body) {
      document.addEventListener(
        'DOMContentLoaded',
        function () {
          showBanner(options)
        },
        { once: true }
      )
      return
    }

    ensureStyles()
    banner = document.createElement('aside')
    banner.className = 'pwa-install-guide'
    banner.setAttribute('aria-label', '앱 설치 안내')
    banner.innerHTML = `
      <div class="pwa-install-guide__card">
        <span class="pwa-install-guide__icon">${createDownloadIcon()}</span>
        <div class="pwa-install-guide__content">
          <p class="pwa-install-guide__title"></p>
          <p class="pwa-install-guide__description">홈 화면에 추가하면 앱처럼 바로 열 수 있어요.</p>
        </div>
        <button class="pwa-install-guide__close" type="button" aria-label="나중에 보기">×</button>
        <div class="pwa-install-guide__actions">
          <button class="pwa-install-guide__button" type="button"></button>
        </div>
      </div>
    `

    const title = banner.querySelector('.pwa-install-guide__title')
    const actionButton = banner.querySelector('.pwa-install-guide__button')
    const closeButton = banner.querySelector('.pwa-install-guide__close')
    title.textContent = appName
    actionButton.textContent = isIos ? '설치 방법 보기' : '앱 설치'
    actionButton.addEventListener('click', function () {
      if (isIos) {
        openIosInstructions()
        return
      }
      requestAndroidInstall(actionButton)
    })
    closeButton.addEventListener('click', dismiss)
    document.body.appendChild(banner)
  }

  function scheduleBanner() {
    if (!autoShow || isStandalone() || isDismissed() || showTimer) return
    showTimer = window.setTimeout(function () {
      showTimer = null
      showBanner()
    }, delay)
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    if (!isAndroid || isStandalone()) return
    event.preventDefault()
    installPrompt = event
    scheduleBanner()
  })

  window.addEventListener('appinstalled', function () {
    installPrompt = null
    removeSheet()
    removeBanner()
  })

  window.pwaInstallGuide = {
    show: function () {
      showBanner({ force: true })
    },
    open: function () {
      if (isIos) openIosInstructions()
      else showBanner({ force: true })
    },
    dismiss,
    reset: function () {
      clearDismissedAt()
    },
  }

  if (isIos) scheduleBanner()
})()
