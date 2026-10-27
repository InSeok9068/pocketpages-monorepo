window.booklogReaderDiagnostics = (function () {
  var config = window.booklogReaderConfig || {}
  var LIMIT = 2000
  var ENABLED_TTL_MS = 24 * 3600000
  var SAVE_DELAY_MS = 1000
  var storageKey = 'booklog-reader-diagnostics:' + config.readerCacheKey
  var enabledKey = 'booklog-reader-diagnostics-on:' + config.readerCacheKey
  var page = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
  var available = !!document.getElementById('reader-scroll-diagnostics-copy')
  var enabled = false
  var entries = []
  var storageOk = true
  var saveTimerId = 0
  var snapshot = null
  var sampler = { frameId: 0, blankSince: 0, blankFrames: 0, frame: null, frameTop: 0, scrollTop: 0, lastFrameAt: 0 }
  // 자주 생기는 기록은 스크롤 위치와 진행률만 남기고, 원인을 가려야 하는 기록에만 챕터 목록 전체를 남깁니다.
  var LIGHT_EVENTS = [
    'view-prepared',
    'view-resized',
    'view-append',
    'view-prepend',
    'view-remove',
    'relocated',
    'window-resize',
    'visual-viewport-resize',
    'settings-apply',
    'long-frame',
    'visibility',
    'pageshow',
    'pagehide',
    'edge-fill-done',
    'scroll-write',
    'image-height-fix',
    'follow-scroll',
    'refill-after-move',
  ]

  if (available) {
    try {
      var stored = JSON.parse(localStorage.getItem(storageKey) || '[]')
      if (Array.isArray(stored)) entries = stored.slice(-LIMIT)
      enabled = Date.now() - Number(localStorage.getItem(enabledKey) || 0) < ENABLED_TTL_MS
    } catch (_error) {
      storageOk = false
    }
  }

  function save() {
    saveTimerId = 0
    try {
      localStorage.setItem(storageKey, JSON.stringify(entries))
      storageOk = true
    } catch (_error) {
      storageOk = false
    }
  }

  function scheduleSave() {
    if (!saveTimerId) saveTimerId = window.setTimeout(save, SAVE_DELAY_MS)
  }

  function callerNames() {
    var names = []
    String(new Error().stack || '')
      .split('\n')
      .forEach(function (line) {
        var match = line.match(/^\s*at\s+([^\s(]+)/) || line.match(/^([^@\s]+)@/)
        var name = match ? match[1].split('.').pop() : ''
        if (
          name.length > 2
          && !/[/:]/.test(name)
          && ['callerNames', 'record', 'traceReader', 'Error', 'async'].indexOf(name) < 0
          && names.length < 8
        ) {
          names.push(name)
        }
      })
    return names
  }

  /**
   * 기록이 켜져 있는지 알려 줍니다.
   * @returns {boolean} 기록 중 여부
   */
  function isEnabled() {
    return enabled
  }

  /**
   * 리더 상태 요약을 만드는 함수를 등록합니다.
   * @param {() => object} producer 상태 요약 함수
   * @returns {void}
   */
  function setSnapshot(producer) {
    snapshot = producer
  }

  /**
   * 리더 동작 하나를 기록합니다. 기록이 꺼져 있으면 아무것도 하지 않습니다.
   * @param {string} event 동작 이름
   * @param {object} [details] 함께 남길 값
   * @param {{ caller?: boolean }} [options] 호출 경로를 함께 남길지 여부
   * @returns {void}
   */
  function record(event, details, options) {
    if (!enabled) return
    try {
      var entry = {
        at: new Date().toISOString(),
        t: Math.round(performance.now()),
        page: page,
        event: event,
      }
      if (details) entry.details = details
      if (options && options.caller) entry.caller = callerNames()
      if (snapshot) entry.state = snapshot(LIGHT_EVENTS.indexOf(event) < 0)
      entries.push(entry)
      if (entries.length > LIMIT) entries = entries.slice(-LIMIT)
      scheduleSave()
    } catch (_error) {
      /* 기록 실패와 관계없이 읽기를 계속합니다. */
    }
  }

  function readerContainer() {
    return document.querySelector('#epub-reader .epub-container')
  }

  // 화면을 덮는 챕터가 하나도 없는 프레임(흰 화면)과, 보이던 챕터가 한 프레임에 화면 1.5배 넘게 움직인 순간을 잡습니다.
  // 위에 챕터가 붙어 스크롤 위치만 바뀌는 보정은 화면 내용이 그대로라 세지 않습니다.
  function sampleFrame() {
    sampler.frameId = window.requestAnimationFrame(sampleFrame)
    var now = performance.now()
    var gap = sampler.lastFrameAt ? now - sampler.lastFrameAt : 0
    sampler.lastFrameAt = now
    var container = readerContainer()
    if (!container) return
    var box = container.getBoundingClientRect()
    var visible = null
    var visibleTop = 0
    var covered = Array.prototype.some.call(container.querySelectorAll('iframe'), function (frame) {
      var bounds = frame.getBoundingClientRect()
      var shown =
        bounds.height > 0
        && bounds.top < box.bottom
        && bounds.bottom > box.top
        && window.getComputedStyle(frame).visibility !== 'hidden'
      if (shown) {
        visible = frame
        visibleTop = bounds.top
      }
      return shown
    })
    if (!covered && !sampler.blankSince) {
      sampler.blankSince = now
      sampler.blankFrames = 0
      record('blank-start')
    }
    if (!covered) sampler.blankFrames += 1
    if (covered && sampler.blankSince) {
      record('blank-end', { ms: Math.round(now - sampler.blankSince), frames: sampler.blankFrames })
      sampler.blankSince = 0
    }
    if (visible && visible === sampler.frame && Math.abs(visibleTop - sampler.frameTop) > box.height * 1.5) {
      // 스크롤이 같은 만큼 움직였으면 사용자가 넘긴 것이고, 스크롤은 그대로인데 내용만 움직였으면 배치가 바뀐 것입니다.
      record('content-jump', {
        moved: Math.round(visibleTop - sampler.frameTop),
        scrolled: Math.round(container.scrollTop - sampler.scrollTop),
      })
    }
    if (gap > 250 && document.visibilityState === 'visible') record('long-frame', { ms: Math.round(gap) })
    sampler.frame = visible
    sampler.frameTop = visibleTop
    sampler.scrollTop = container.scrollTop
  }

  function viewportDetails() {
    var visual = window.visualViewport
    return {
      inner: window.innerWidth + 'x' + window.innerHeight,
      visual: visual ? Math.round(visual.width) + 'x' + Math.round(visual.height) : '',
      orientation: screen.orientation ? screen.orientation.type : String(window.orientation || ''),
    }
  }

  function onResize() {
    record('window-resize', viewportDetails())
  }

  function onVisualResize() {
    record('visual-viewport-resize', viewportDetails())
  }

  function onOrientation() {
    record('orientation-change', viewportDetails())
  }

  function onVisibility() {
    record('visibility', { state: document.visibilityState })
  }

  function onPageShow(event) {
    record('pageshow', { persisted: !!event.persisted })
  }

  function onPageHide(event) {
    record('pagehide', { persisted: !!event.persisted })
    save()
  }

  function onError(event) {
    record('error', { message: String(event.message || '').slice(0, 200), source: String(event.filename || '').split('/').pop() })
  }

  function onRejection(event) {
    var reason = event.reason
    record('unhandled-rejection', { message: String((reason && reason.message) || reason || '').slice(0, 200) })
  }

  function setListeners(on) {
    var method = on ? 'addEventListener' : 'removeEventListener'
    window[method]('resize', onResize)
    window[method]('orientationchange', onOrientation)
    window[method]('pageshow', onPageShow)
    window[method]('pagehide', onPageHide)
    window[method]('error', onError)
    window[method]('unhandledrejection', onRejection)
    document[method]('visibilitychange', onVisibility)
    if (window.visualViewport) window.visualViewport[method]('resize', onVisualResize)
    window.cancelAnimationFrame(sampler.frameId)
    sampler.frameId = 0
    sampler.blankSince = 0
    sampler.frame = null
    sampler.lastFrameAt = 0
    if (on) sampler.frameId = window.requestAnimationFrame(sampleFrame)
  }

  function updateToggle() {
    var button = document.getElementById('reader-scroll-diagnostics-toggle')
    if (button) {
      button.textContent = enabled ? '기록 중지' : '기록 시작'
      button.setAttribute('aria-pressed', String(enabled))
    }
  }

  function showStatus(text) {
    var status = document.getElementById('reader-scroll-diagnostics-status')
    if (status) {
      status.hidden = false
      status.textContent = text
    }
  }

  function startSession(reason) {
    setListeners(true)
    record('diagnostics-start', {
      reason: reason,
      userAgent: navigator.userAgent || '',
      standalone: !!navigator.standalone || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches),
      dpr: window.devicePixelRatio || 1,
      viewport: viewportDetails(),
      wasDiscarded: !!document.wasDiscarded,
    })
  }

  /**
   * 스크롤 진단 기록을 시작하거나 중지합니다. 켜 두면 리더를 다시 열어도 24시간 동안 이어서 기록합니다.
   * @returns {void}
   */
  function toggle() {
    if (!available) return
    if (enabled) {
      record('diagnostics-stop')
      setListeners(false)
      enabled = false
      save()
      try {
        localStorage.removeItem(enabledKey)
      } catch (_error) {}
      showStatus('기록을 중지했습니다.')
    } else {
      enabled = true
      try {
        localStorage.setItem(enabledKey, String(Date.now()))
      } catch (_error) {}
      startSession('button')
      showStatus('기록을 시작했습니다. 다시 열어도 중지할 때까지 이어서 기록합니다.')
    }
    updateToggle()
  }

  /**
   * 이 책의 스크롤 진단을 지우고 기록을 중지합니다.
   * @returns {void}
   */
  function clear() {
    if (!available) return
    setListeners(false)
    enabled = false
    entries = []
    window.clearTimeout(saveTimerId)
    saveTimerId = 0
    try {
      localStorage.removeItem(storageKey)
      localStorage.removeItem(enabledKey)
      storageOk = true
    } catch (_error) {
      storageOk = false
    }
    updateToggle()
    var field = document.getElementById('reader-scroll-diagnostics-text')
    if (field) {
      field.value = ''
      field.hidden = true
    }
    showStatus(storageOk ? '진단 기록을 삭제하고 기록을 중지했습니다.' : '기록은 중지했지만 기기에 저장된 기록을 삭제하지 못했습니다.')
  }

  /**
   * 진단을 JSON으로 내보냅니다.
   * @returns {string} 진단 JSON
   */
  function exportText() {
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      bookId: config.bookId,
      fileId: config.bookFileId,
      userAgent: navigator.userAgent || '',
      viewport: viewportDetails(),
      storageAvailable: storageOk,
      recording: enabled,
      events: entries,
    })
  }

  /**
   * 진단을 복사하고, 복사가 막히면 직접 복사할 칸을 보여 줍니다.
   * @param {HTMLButtonElement} button 복사 버튼
   * @returns {void}
   */
  function copy(button) {
    save()
    var text = exportText()
    var field = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('reader-scroll-diagnostics-text'))
    button.disabled = true
    function showResult(copied) {
      button.disabled = false
      if (field) {
        field.value = text
        field.hidden = copied
        if (!copied) {
          field.focus()
          field.select()
        }
      }
      showStatus(
        copied
          ? '진단 기록 ' + entries.length + '개를 복사했습니다. 채팅에 붙여넣어 주세요.'
          : '자동 복사가 안 됩니다. 아래 기록을 길게 눌러 복사해 주세요.'
      )
    }
    try {
      navigator.clipboard.writeText(text).then(
        function () {
          showResult(true)
        },
        function () {
          showResult(false)
        }
      )
    } catch (_error) {
      showResult(false)
    }
  }

  if (available) {
    updateToggle()
    if (enabled) startSession('reopen')
  }

  return {
    isEnabled: isEnabled,
    setSnapshot: setSnapshot,
    record: record,
    toggle: toggle,
    clear: clear,
    copy: copy,
    exportText: exportText,
  }
})()
