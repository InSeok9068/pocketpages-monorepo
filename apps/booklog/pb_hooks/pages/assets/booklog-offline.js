// 오프라인 서재입니다. 기존 리더(booklog-reader.js)를 불러오지 않고, 이어 보기 스크롤에 필요한 함수만 그대로 옮겨 와 같은 읽기 경험을 냅니다.
// "옮겨 온 리더 스크롤" 구간은 booklog-reader.js의 같은 이름 함수와 내용이 같아야 하며, 리더 쪽을 고치면 함께 맞춥니다.
window.booklogOfflineReader = (function () {
  var CACHE_DB_NAME = 'booklog-reader-cache'
  var CACHE_STORE_NAME = 'epubBuffers'
  var POSITION_KEY_PREFIX = 'booklog-offline:position:'
  var TITLE_KEY_PREFIX = 'booklog-offline:title:'
  var SETTINGS_KEY_PREFIX = 'booklog:reader-settings:'
  var POSITION_SAVE_DELAY_MS = 500
  var PROGRESS_LOCATION_BREAK = 1600
  var PROGRESS_LOCATIONS_CACHE_VERSION = 'epubjs-0.3.93:' + PROGRESS_LOCATION_BREAK
  var shelf = document.getElementById('offline-shelf')
  var list = document.getElementById('offline-book-list')
  var message = document.getElementById('offline-message')
  var reader = document.getElementById('offline-reader')
  var loadingNotice = document.getElementById('offline-loading')
  var backButton = document.getElementById('offline-back')
  var progressBar = document.getElementById('offline-progress')
  var progressFill = progressBar.firstElementChild
  var bookInstance = null
  var renditionInstance = null
  var currentLocation = null
  var readerContainer = null
  var isRestoringPosition = false
  var activeComponent = { loading: true, progressLocationsStatus: 'pending' }
  var openKey = ''
  var lastLocator = ''
  var positionSaveTimerId = 0

  function traceReader() {}

  function isReaderTraceOn() {
    return false
  }

  function markReadingSessionActivity() {}

  function scheduleFinishPromptIfNeeded() {}

  // ---- 옮겨 온 리더 스크롤 (booklog-reader.js) ----
  var autoPagingTarget = null
  var autoPagingInFlight = false
  var settlingUntil = 0
  var autoPagingCheckFrameId = 0
  var pendingAutoPagingDirection = ''
  var intentDirection = ''
  var intentStartedAt = 0
  var intentTimerId = 0
  var lastEdgeRetryAt = 0
  var readingAnchor = null
  var readingAnchorFrameId = 0
  var releaseRequired = false
  var releaseDirection = ''
  var autoPagingGeneration = 0
  var boundAutoPagingTarget = null
  var boundAutoPagingHandler = null
  var lastContainerScrollTop = 0
  var readerLayoutSyncFrameId = 0
  var readerLayoutSyncTimerId = 0
  var EDGE_TRIGGER_DISTANCE = 32
  var EDGE_RELEASE_DISTANCE = 96
  var EDGE_INTENT_MS = 140
  var AUTO_PAGE_SETTLE_MS = 520
  var EDGE_RETRY_INTERVAL_MS = 700
  var INITIAL_FONT_TIMEOUT_MS = 500
  var SCROLL_IDLE_TRIM_MS = 500
  var SCROLL_STABLE_MS = 300
  var SCROLL_REVERT_MIN_PX = 150
  var CHAPTER_PRELOAD_OFFSET_PX = 1500
  var DISPLAY_SETTLE_TIMEOUT_MS = 1500
  var DISPLAY_SETTLE_RETRY_MS = 80
  var VISIBLE_TOP_TOLERANCE_PX = 4
  var PROGRAMMATIC_SCROLL_MS = 1500
  var programmaticScrollUntil = 0
  var DEFAULT_FONT_SIZE_PERCENT = 100
  var FONT_SIZE_OPTIONS = [90, 100, 110, 120, 130]
  var DEFAULT_READER_THEME = 'paper'
  var DEFAULT_READER_FONT_FAMILY = 'original'
  var DEFAULT_READER_LINE_HEIGHT = 'normal'
  var DEFAULT_READER_PAGE_MARGIN = 'normal'
  var READER_THEME_OPTIONS = ['paper', 'sepia', 'night']
  var READER_FONT_FAMILY_OPTIONS = ['original', 'sans', 'serif']
  var READER_LINE_HEIGHT_OPTIONS = ['normal', 'relaxed', 'loose']
  var READER_PAGE_MARGIN_OPTIONS = ['narrow', 'normal', 'wide']
  var READER_SETTINGS_STYLE_ID = 'booklog-reader-settings-style'
  var lastEdgeSkipTraceAt = 0

  function getDefaultReaderSettings() {
    return {
      theme: DEFAULT_READER_THEME,
      fontSizePercent: DEFAULT_FONT_SIZE_PERCENT,
      fontFamily: DEFAULT_READER_FONT_FAMILY,
      lineHeight: DEFAULT_READER_LINE_HEIGHT,
      pageMargin: DEFAULT_READER_PAGE_MARGIN,
    }
  }

  /**
   * 리더 글자 크기를 허용된 퍼센트 값으로 정리합니다.
   * @param {number | string} value 글자 크기 값
   * @returns {number} 허용된 글자 크기 퍼센트
   */
  function normalizeReaderFontSizePercent(value) {
    var parsed = parseInt(String(value || ''), 10)
    var index = 0

    if (!isFinite(parsed)) {
      return DEFAULT_FONT_SIZE_PERCENT
    }

    for (index = 0; index < FONT_SIZE_OPTIONS.length; index += 1) {
      if (FONT_SIZE_OPTIONS[index] === parsed) {
        return parsed
      }
    }

    return DEFAULT_FONT_SIZE_PERCENT
  }

  function normalizeReaderOption(value, options, fallback) {
    var normalizedValue = String(value || '').trim()
    var index = 0

    for (index = 0; index < options.length; index += 1) {
      if (options[index] === normalizedValue) {
        return normalizedValue
      }
    }

    return fallback
  }

  function normalizeReaderSettings(input) {
    var defaults = getDefaultReaderSettings()
    var source = input && typeof input === 'object' ? input : {}

    return {
      theme: normalizeReaderOption(source.theme, READER_THEME_OPTIONS, defaults.theme),
      fontSizePercent: normalizeReaderFontSizePercent(source.fontSizePercent),
      fontFamily: normalizeReaderOption(source.fontFamily, READER_FONT_FAMILY_OPTIONS, defaults.fontFamily),
      lineHeight: normalizeReaderOption(source.lineHeight, READER_LINE_HEIGHT_OPTIONS, defaults.lineHeight),
      pageMargin: normalizeReaderOption(source.pageMargin, READER_PAGE_MARGIN_OPTIONS, defaults.pageMargin),
    }
  }

  function syncReaderPageTheme(theme) {
    var themeColorMeta = document.querySelector('meta[name="theme-color"]')
    var themeColor = '#ffffff'

    if (theme === 'sepia') {
      themeColor = '#f7f2e6'
    } else if (theme === 'night') {
      themeColor = '#161616'
    }

    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', themeColor)
    }

    if (document.documentElement) {
      document.documentElement.style.backgroundColor = themeColor
    }

    if (document.body) {
      document.body.style.backgroundColor = themeColor
    }
  }

  // 코드가 바꾼 스크롤 위치가 다음 프레임에도 남아 있는지 기록합니다. iOS는 관성 스크롤·바운스 중에 이 값을 덮어씁니다.
  function traceScrollWrite(kind, container, before, details) {
    if (!container || !isReaderTraceOn()) {
      return
    }

    var written = container.scrollTop

    window.requestAnimationFrame(function () {
      var next = container.scrollTop

      traceReader(
        'scroll-write',
        Object.assign(
          {
            kind: kind,
            before: Math.round(before),
            written: Math.round(written),
            next: Math.round(next),
            reverted: Math.abs(written - before) > 2 && Math.abs(next - before) < Math.abs(next - written),
          },
          details || {}
        )
      )
    })
  }

  function traceEdgeSkip(target, direction, reasons) {
    if (!isReaderTraceOn() || getDistanceToEdge(target, direction) > 1 || Date.now() - lastEdgeSkipTraceAt < 500) {
      return
    }

    lastEdgeSkipTraceAt = Date.now()
    traceReader('edge-skip', Object.assign({ direction: direction }, reasons))
  }

  function markProgrammaticScroll() {
    programmaticScrollUntil = Date.now() + PROGRAMMATIC_SCROLL_MS
  }

  // 줄이 시작하는 자리의 폭 없는 범위를 Chrome은 윗줄 끝으로 재므로, 그 자리 바로 뒤 글자로 줄 위치를 잽니다.
  function getRangeTop(range) {
    var node = range.startContainer
    var offset = range.startOffset

    if (range.collapsed && node.nodeType === 3 && offset < node.length) {
      var character = node.ownerDocument.createRange()

      character.setStart(node, offset)
      character.setEnd(node, offset + 1)

      var rect = character.getBoundingClientRect()

      if (rect.height) {
        return rect.top
      }
    }

    return range.getBoundingClientRect().top
  }

  function getCfiScreenTop(cfi) {
    var range = null
    var frame = null

    try {
      range = renditionInstance.getRange(cfi)
      frame = range ? range.startContainer.ownerDocument.defaultView.frameElement : null
    } catch (exception) {
      return null
    }

    return range && frame ? frame.getBoundingClientRect().top + getRangeTop(range) : null
  }

  /**
   * 화면 위쪽에서 보이는 첫 문자를 범위로 찾습니다.
   * @param {Document} doc EPUB 문서
   * @param {Text} node 본문 텍스트
   * @param {DOMRect} rect 글자 줄 위치
   * @param {number} visibleTop 화면 위쪽
   * @param {number} visibleBottom 화면 아래쪽
   * @returns {Range | null} 첫 글자 범위
   */
  function getVisibleTextRange(doc, node, rect, visibleTop, visibleBottom) {
    var x = rect.left + 1
    var y = Math.max(rect.top + 1, Math.min(visibleTop + 1, rect.bottom - 1))
    var start = 0
    var caret = null
    var range = doc.createRange()

    if (typeof doc.caretRangeFromPoint === 'function') {
      caret = doc.caretRangeFromPoint(x, y)
      start = caret && caret.startContainer === node ? caret.startOffset : 0
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      caret = doc.caretPositionFromPoint(x, y)
      start = caret && caret.offsetNode === node ? caret.offset : 0
    }

    // Chrome은 줄 첫 자리를 물으면 윗줄 끝 위치를 돌려줄 때가 있어, 글자의 실제 위치로 화면 맨 위 줄인지 확인하며 넘깁니다.
    // 줄이 바뀌는 공백은 윗줄 끝에 붙어 다시 열 때 윗줄로 돌아가므로, epub.js처럼 공백 다음 글자를 고릅니다.
    for (var offset = start; offset < node.length; offset += 1) {
      if (/\s/.test(node.data.charAt(offset))) {
        continue
      }

      range.setStart(node, offset)
      range.setEnd(node, offset + 1)

      var characterRect = range.getBoundingClientRect()

      if (!characterRect.height) {
        continue
      }

      if (characterRect.top >= visibleBottom) {
        return null
      }

      if (characterRect.bottom > visibleTop) {
        range.collapse(true)
        return range
      }
    }

    return null
  }

  /**
   * epub.js 위치가 화면 위에 있으면 화면에서 처음 보이는 글자 위치를 찾습니다.
   * @param {string} locator epub.js가 계산한 시작 CFI
   * @returns {{ locator: string, href: string } | null} 바꿀 위치, 그대로 쓰면 null
   */
  function findVisibleTopPosition(locator) {
    var container = renditionInstance && renditionInstance.manager ? renditionInstance.manager.container : null
    var containerRect = null
    var startTop = null
    var views = []

    if (!container || !locator || String(locator).indexOf('epubcfi(') !== 0) {
      return null
    }

    containerRect = container.getBoundingClientRect()
    startTop = getCfiScreenTop(locator)

    // epub.js는 화면 맨 위 아래에서 시작하는 첫 단어를 고르므로 정상이면 위치가 화면 위로 올라가지 않습니다.
    // 화면 맨 위가 문단 마지막 줄에 걸리면 그런 단어가 없어 문단 첫 단어를, 그림 페이지면 그림 앞을 돌려주므로 그때만 바꿉니다.
    if (startTop !== null && startTop >= containerRect.top - VISIBLE_TOP_TOLERANCE_PX) {
      return null
    }

    views = renditionInstance.manager.views
      .all()
      .slice()
      .sort(function (left, right) {
        return left.element.getBoundingClientRect().top - right.element.getBoundingClientRect().top
      })

    for (var viewIndex = 0; viewIndex < views.length; viewIndex += 1) {
      var view = views[viewIndex]
      var frameRect = view.iframe ? view.iframe.getBoundingClientRect() : null
      var doc = view.contents && view.contents.document ? view.contents.document : null
      var walker = null
      var node = null
      var visibleTop = 0
      var visibleBottom = 0

      if (
        !frameRect
        || !doc
        || !doc.body
        || frameRect.bottom <= containerRect.top
        || frameRect.top >= containerRect.bottom
      ) {
        continue
      }

      visibleTop = containerRect.top - frameRect.top
      visibleBottom = containerRect.bottom - frameRect.top
      walker = doc.createTreeWalker(doc.body, 4)

      while ((node = walker.nextNode())) {
        var range = null
        var rect = null

        if (!String(node.textContent || '').trim()) {
          continue
        }

        range = doc.createRange()
        range.selectNodeContents(node)
        var rects = range.getClientRects()

        for (var rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
          rect = rects[rectIndex]

          if (rect.bottom <= visibleTop) {
            continue
          }

          if (rect.top >= visibleBottom) {
            return null
          }

          var visibleRange = getVisibleTextRange(doc, node, rect, visibleTop, visibleBottom)

          if (!visibleRange) {
            return null
          }

          try {
            return {
              locator: String(view.contents.cfiFromRange(visibleRange) || ''),
              href: String(view.section && view.section.href ? view.section.href : ''),
            }
          } catch (exception) {
            return null
          }
        }
      }
    }

    return null
  }

  function canAppendSection(direction) {
    var views = renditionInstance && renditionInstance.manager ? renditionInstance.manager.views.all() : []
    var edgeView = direction === 'next' ? views[views.length - 1] : views[0]
    var section = edgeView && edgeView.section ? edgeView.section : null
    var method = direction === 'next' ? 'next' : 'prev'

    return !!(section && typeof section[method] === 'function' && section[method]())
  }

  /**
   * 이동한 CFI가 화면 맨 위에 오도록 스크롤을 다시 맞춥니다.
   * @param {string} target 이동한 CFI 또는 href
   * @returns {Promise<void>} 보정 완료
   */
  function settleDisplayedTarget(target) {
    var startedAt = Date.now()

    return new Promise(function (resolve) {
      function attempt() {
        var container = renditionInstance && renditionInstance.manager ? renditionInstance.manager.container : null
        var range = null
        var frame = null
        var delta = 0
        var desiredScrollTop = 0
        var maxScrollTop = 0

        if (!container || String(target || '').indexOf('epubcfi(') !== 0) {
          resolve()
          return
        }

        try {
          range = renditionInstance.getRange(target)
          frame = range ? range.startContainer.ownerDocument.defaultView.frameElement : null
        } catch (exception) {
          range = null
        }

        if (!range || !frame) {
          resolve()
          return
        }

        delta = frame.getBoundingClientRect().top + getRangeTop(range) - container.getBoundingClientRect().top
        desiredScrollTop = container.scrollTop + delta
        maxScrollTop = container.scrollHeight - container.clientHeight

        if (Math.abs(delta) < 2) {
          resolve()
          return
        }

        // 챕터 끝 근처는 다음 챕터가 붙기 전까지 스크롤할 공간이 없어 기다렸다가 맞춥니다.
        if (
          (desiredScrollTop >= 0 && desiredScrollTop <= maxScrollTop)
          || !canAppendSection(desiredScrollTop > maxScrollTop ? 'next' : 'prev')
          || Date.now() - startedAt >= DISPLAY_SETTLE_TIMEOUT_MS
        ) {
          prepareManualNavigation()
          traceReader('settle-target', {
            delta: Math.round(delta),
            waitedMs: Date.now() - startedAt,
            clamped: desiredScrollTop < 0 || desiredScrollTop > maxScrollTop,
          })
          var settleBefore = container.scrollTop
          container.scrollTop = Math.max(0, Math.min(maxScrollTop, desiredScrollTop))
          traceScrollWrite('settle', container, settleBefore, { delta: Math.round(delta) })
          resolve()
          return
        }

        window.setTimeout(attempt, DISPLAY_SETTLE_RETRY_MS)
      }

      window.requestAnimationFrame(attempt)
    })
  }

  /**
   * 대상 위치로 이동한 뒤 스크롤 보정을 마친 현재 위치를 반환합니다.
   * @param {string} target 이동할 CFI 또는 href
   * @returns {Promise<any>} 보정 후 epub.js 위치
   */
  function displayAt(target) {
    var rendition = renditionInstance
    var queue = rendition.manager ? rendition.manager.q : null
    // 이동은 보이지 않는 챕터를 모두 지우므로, 큐에서 챕터를 불러오던 확인이 있으면 끝난 뒤에 옮깁니다.
    var waitsForQueue = !!(queue && (queue.running || queue.length()))

    traceReader(
      'display-at',
      { target: String(target || '').slice(0, 100), waitsForQueue: waitsForQueue },
      { caller: true }
    )

    var displaying = waitsForQueue
      ? Promise.resolve(queue.enqueue(function () {})).then(function () {
          return rendition.display(target)
        })
      : rendition.display(target)

    return Promise.resolve(displaying).then(function (location) {
      return settleDisplayedTarget(target).then(function () {
        refillSectionsAfterMove()
        return rendition.currentLocation() || location
      })
    })
  }

  // epub.js는 직접 스크롤을 옮긴 뒤 다음 스크롤 이벤트 하나를 무시하는데, 이미 그 자리여서 이벤트가 생기지 않으면 무시 표시가 남아
  // 사용자의 첫 스크롤이 버려집니다. 첫 챕터가 화면보다 조금만 길면 그 한 번이 끝까지 내린 스크롤이라 다음 챕터가 영영 붙지 않습니다.
  function refillSectionsAfterMove() {
    var manager = renditionInstance && renditionInstance.manager ? renditionInstance.manager : null

    if (!manager || typeof manager.check !== 'function') {
      return
    }

    manager.ignore = false
    traceReader('refill-after-move')

    try {
      // 큐 밖에서 확인하면 다른 확인과 겹쳐, 불러오던 챕터를 epub.js가 두 번 표시하거나 지워 이동이 끝나지 않습니다.
      Promise.resolve(
        manager.q.enqueue(function () {
          return manager.check()
        })
      ).catch(function (exception) {
        console.warn('page/books/[bookId]/read:refill-sections:failed', {
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
    } catch (exception) {
      console.warn('page/books/[bookId]/read:refill-sections:failed', {
        message: String(exception && exception.message ? exception.message : exception),
      })
    }
  }

  // epub.js(0.3.93 continuous)는 위에 붙인 챕터가 커질 때마다 그만큼 스크롤을 옮기는데, 챕터가 화면 아래로 내려온 뒤에도 계속 옮겨
  // 그림 페이지가 다시 잴 때마다 화면이 튑니다. 바뀐 높이가 보던 화면보다 위일 때만 옮기도록 prepend를 같은 동작으로 다시 둡니다.
  // 또 epub.js는 스크롤할 때만 다음 챕터를 붙이므로, 챕터가 줄어 화면보다 짧아지면 스크롤할 곳이 없어 그대로 멈춥니다.
  function watchContainerScroll(manager) {
    var container = manager.container

    if (!container || container.booklogScrollWatched) {
      return
    }

    container.booklogScrollWatched = true
    container.addEventListener(
      'scroll',
      function () {
        manager.booklogLastScrollAt = Date.now()
      },
      { passive: true }
    )
  }

  function isContainerScrolling(manager) {
    return Date.now() - (manager.booklogLastScrollAt || 0) < SCROLL_IDLE_TRIM_MS
  }

  // iOS는 관성 스크롤이 느려지는 끝 무렵에 scroll 이벤트를 드문드문 보내, 이벤트가 끊긴 것만으로는 멈췄는지 알 수 없습니다.
  // 위쪽 챕터 정리가 기다리는 동안만 매 프레임 스크롤 위치를 보고, 위치가 그대로 머물고 이벤트도 끊겼을 때 정리합니다.
  function scheduleIdleTrim(manager) {
    if (manager.booklogIdleFrameId || !manager.container) {
      return
    }

    var lastTop = manager.container.scrollTop
    var stableSince = performance.now()

    function check(now) {
      manager.booklogIdleFrameId = 0

      if (!renditionInstance || renditionInstance.manager !== manager || !manager.container) {
        return
      }

      var top = manager.container.scrollTop

      if (top !== lastTop) {
        lastTop = top
        stableSince = now
      }

      if (now - stableSince < SCROLL_STABLE_MS || isContainerScrolling(manager)) {
        manager.booklogIdleFrameId = window.requestAnimationFrame(check)
        return
      }

      traceReader('trim-after-idle', { stableMs: Math.round(now - stableSince) })
      Promise.resolve(
        manager.q.enqueue(function () {
          manager.booklogIdleTrimming = true

          try {
            return manager.trim()
          } finally {
            manager.booklogIdleTrimming = false
          }
        })
      ).catch(function (exception) {
        console.warn('page/books/[bookId]/read:idle-trim:failed', {
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
    }

    manager.booklogIdleFrameId = window.requestAnimationFrame(check)
  }

  function stopMomentum(container) {
    var overflowY = container.style.overflowY

    container.style.overflowY = 'hidden'
    container.getBoundingClientRect()
    window.requestAnimationFrame(function () {
      container.style.overflowY = overflowY
    })
  }

  // iOS는 관성 스크롤 중에 코드가 쓴 스크롤 위치를 다음 프레임에 자기 값으로 덮어씁니다. 덮어쓴 것이 보이면 관성을 잠깐 멈추고
  // 잃은 만큼만 다시 옮깁니다. 보정은 더하기라 그 사이 다른 챕터가 더 붙었어도 잃은 양만 더하면 위치가 맞습니다.
  function guardScrollWrite(kind, container, before, details) {
    if (!container) {
      return
    }

    var written = container.scrollTop

    window.requestAnimationFrame(function () {
      var next = container.scrollTop
      var lost = written - before
      // 같은 방향으로 빠르게 스크롤한 경우를 되돌림으로 오인하지 않도록, 보정 쪽으로 전혀 움직이지 않고 보정 전 위치 근처에 남은 경우만 되돌림으로 봅니다.
      var reverted =
        Math.abs(lost) >= SCROLL_REVERT_MIN_PX
        && (next - before) * Math.sign(lost) <= 5
        && Math.abs(next - before) < Math.abs(lost) / 4

      traceReader(
        'scroll-write',
        Object.assign(
          {
            kind: kind,
            before: Math.round(before),
            written: Math.round(written),
            next: Math.round(next),
            reverted: reverted,
          },
          details || {}
        )
      )

      if (!reverted) {
        return
      }

      stopMomentum(container)
      markProgrammaticScroll()

      var from = container.scrollTop

      container.scrollTop = from + lost

      var reapplied = container.scrollTop

      window.requestAnimationFrame(function () {
        var settled = container.scrollTop

        traceReader(
          'scroll-write-recovered',
          Object.assign(
            {
              kind: kind,
              lost: Math.round(lost),
              from: Math.round(from),
              written: Math.round(reapplied),
              next: Math.round(settled),
              held: Math.abs(settled - reapplied) < Math.abs(lost) / 2,
            },
            details || {}
          )
        )
      })
    })
  }

  // epub.js는 첫 챕터를 그릴 때 챕터 목록을 만들어, 그 목록이 생긴 뒤 한 번만 붙이기·지우기를 기록하도록 감쌉니다.
  function traceViewList(views) {
    if (!views || views.booklogTraced) {
      return
    }

    views.booklogTraced = true
    ;['append', 'prepend', 'remove'].forEach(function (name) {
      var original = views[name]

      if (typeof original !== 'function') {
        return
      }

      views[name] = function (view) {
        traceReader(
          'view-' + name,
          { index: view && view.section ? view.section.index : -1 },
          { caller: name === 'remove' }
        )
        return original.apply(this, arguments)
      }
    })
  }

  function patchContinuousViews(manager) {
    if (!manager || typeof manager.prepend !== 'function' || typeof manager.createView !== 'function') {
      return
    }

    var createView = manager.createView

    manager.createView = function () {
      var view = createView.apply(this, arguments)
      var rendition = renditionInstance

      // 이미지·본문 스타일을 적용한 뒤 첫 높이를 재야 임시 스크롤 범위가 줄면서 화면이 되돌아가지 않습니다.
      view.prepareContents = function () {
        var startedAt = Date.now()

        return rendition.hooks.content.trigger(view.contents, rendition).then(function () {
          var hooksMs = Date.now() - startedAt

          return waitForInitialContentFonts(view.contents).then(function () {
            view.contentsPrepared = true
            traceReader('view-prepared', {
              index: view.section ? view.section.index : -1,
              hooksMs: hooksMs,
              fontsMs: Date.now() - startedAt - hooksMs,
            })
          })
        })
      }
      var viewManager = this

      view.on('resized', function (size) {
        var height = size ? Math.round(Number(size.height) || 0) : 0
        var delta = size ? Math.round(Number(size.heightDelta) || 0) : 0
        var container = viewManager.container
        var viewTop = 0
        var position = ''

        if (isReaderTraceOn() && container && view.element) {
          viewTop = Math.round(view.element.getBoundingClientRect().top - container.getBoundingClientRect().top)
          position = viewTop + height - delta <= 1 ? 'above' : viewTop < -1 ? 'straddling' : 'below'
        }

        traceReader('view-resized', {
          index: view.section ? view.section.index : -1,
          height: height,
          delta: delta,
          viewTop: viewTop,
          position: position,
        })
      })
      // epub.js는 위에 붙인 챕터만 보정합니다. 처음 띄운 챕터나 아래에 붙인 챕터도 화면 위로 지나간 뒤 늦은 그림 로딩으로 커지면
      // 보던 곳이 밀리므로 같은 기준으로 보정합니다.
      view.on('resized', function (size) {
        if (!view.booklogPrepended) {
          counterResizeAbove(viewManager, view, size, false)
        }
      })
      traceViewList(this.views)
      watchContainerScroll(this)
      checkAfterShrink(this, view)
      keepReadingAnchorOnResize(this, view)
      return view
    }

    var erase = manager.erase

    // iOS는 관성 스크롤 중에 코드가 바꾼 스크롤 위치를 덮어씁니다. 위쪽 챕터를 지우며 줄인 위치가 되돌아가면 내용 끝을 넘어 흰 화면이 되고,
    // 지운 높이만큼 앞으로 건너뛰어 진행률이 튑니다. 스크롤이 움직이는 동안에는 위쪽 챕터를 남겨 두고 멈춘 뒤에 정리합니다.
    // 아래쪽 챕터는 지워도 보던 위치가 바뀌지 않아 바로 지웁니다.
    manager.erase = function (view, above) {
      if (above && this.settings.axis === 'vertical' && !this.booklogIdleTrimming) {
        if (!this.booklogIdleFrameId) {
          traceReader('trim-deferred', { index: view && view.section ? view.section.index : -1 })
        }
        scheduleIdleTrim(this)
        return
      }

      var eraseContainer = this.container
      var eraseBefore = eraseContainer ? eraseContainer.scrollTop : 0
      var erased = erase.apply(this, arguments)

      if (above) {
        guardScrollWrite('erase-above', eraseContainer, eraseBefore, {
          index: view && view.section ? view.section.index : -1,
        })
      }

      return erased
    }

    var clear = manager.clear

    manager.clear = function () {
      traceReader('manager-clear', { views: this.views ? this.views.length : 0 }, { caller: true })
      return clear.apply(this, arguments)
    }

    function counterResizeAbove(self, view, size, prepended) {
      var counterIndex = view.section ? view.section.index : -1
      var counterDelta = Math.round(Number(size && size.heightDelta) || 0)

      if (shouldCounterPrependedResize(self, view, size, prepended)) {
        var counterBefore = self.container ? self.container.scrollTop : 0

        traceReader('counter', { index: counterIndex, delta: counterDelta, prepended: prepended })
        self.counter(size)
        guardScrollWrite('counter', self.container, counterBefore, { index: counterIndex, delta: counterDelta })
      } else if (prepended && counterDelta && isReaderTraceOn() && self.container && view.element) {
        traceReader('counter-skipped', {
          index: counterIndex,
          delta: counterDelta,
          height: Math.round(Number(size && size.height) || 0),
          viewTop: Math.round(view.element.getBoundingClientRect().top - self.container.getBoundingClientRect().top),
          scrollTop: Math.round(self.container.scrollTop),
        })
      }
      view.expanded = true
    }

    manager.prepend = function (section) {
      var self = this
      var view = self.createView(section)

      view.booklogPrepended = true
      view.on('resized', function (size) {
        counterResizeAbove(self, view, size, true)
      })
      view.on('axis', function (axis) {
        self.updateAxis(axis)
      })
      view.on('writingMode', function (mode) {
        self.updateWritingMode(mode)
      })
      self.views.prepend(view)
      view.onDisplayed = self.afterDisplayed.bind(self)
      return view
    }

    var resize = manager.resize

    // iOS 주소창·도구막대가 접히면 높이만 바뀌는데, epub.js는 그때마다 모든 챕터를 지우고 다시 그려 흰 화면과 위치 튐이 생깁니다.
    // 이어 보기의 챕터 높이는 본문 길이로 정해져 화면 높이와 무관하므로, 폭이 같으면 스크롤 범위만 갱신합니다.
    manager.resize = function (width, height) {
      var size = this.stage.size(width, height)
      var previous = this._stageSize

      traceReader('manager-resize', {
        from: previous ? previous.width + 'x' + previous.height : '',
        to: size.width + 'x' + size.height,
        heightOnly: !!previous && size.width === previous.width && size.height !== previous.height,
      })

      if (
        this.settings.axis === 'vertical'
        && this._stageSize
        && size.width === this._stageSize.width
        && size.height !== this._stageSize.height
      ) {
        this._stageSize = size
        this._bounds = this.bounds()
        this.viewSettings.height = size.height
        return
      }

      return resize.apply(this, arguments)
    }
  }

  // 본문 폰트가 반영된 뒤 첫 높이를 재되, 지연된 폰트 때문에 챕터 표시를 무한히 기다리지 않습니다.
  function waitForInitialContentFonts(contents) {
    var doc = contents && contents.document ? contents.document : null
    var fonts = doc && doc.fonts ? doc.fonts : null

    if (!fonts || !doc.body) return Promise.resolve()

    // 레이아웃을 읽어 이번 본문에서 실제 사용하는 폰트의 로딩을 시작합니다.
    doc.body.getBoundingClientRect()
    if (fonts.status !== 'loading') return Promise.resolve(fonts.ready)

    return new Promise(function (resolve) {
      var timerId = window.setTimeout(function () {
        console.debug('page/books/[bookId]/read:initial-font-timeout', {
          timeoutMs: INITIAL_FONT_TIMEOUT_MS,
        })
        traceReader('font-timeout', { timeoutMs: INITIAL_FONT_TIMEOUT_MS })
        resolve()
      }, INITIAL_FONT_TIMEOUT_MS)

      function finish() {
        window.clearTimeout(timerId)
        resolve()
      }

      Promise.resolve(fonts.ready).then(finish, finish)
    })
  }

  function checkAfterShrink(manager, view) {
    if (!view || typeof view.on !== 'function') {
      return
    }

    view.on('resized', function (size) {
      if (!size || !(Number(size.heightDelta) < 0) || manager.booklogCheckPending) {
        return
      }

      manager.booklogCheckPending = true
      window.requestAnimationFrame(function () {
        manager.booklogCheckPending = false

        var container = manager.container

        // 이동 중에 챕터를 더 붙이면 epub.js의 display가 끝나지 않습니다. 이동 뒤에는 refillSectionsAfterMove가 확인합니다.
        // 저장 위치 응답을 기다리는 동안 붙이기 시작하면, 곧 이어질 이동이 불러오던 챕터를 지워 같은 문제가 생깁니다.
        if (
          !renditionInstance
          || renditionInstance.manager !== manager
          || renditionInstance.displaying
          || isRestoringPosition
          || !container
          || container.scrollHeight > container.clientHeight + 1
        ) {
          return
        }

        traceReader('check-after-shrink', { index: view.section ? view.section.index : -1 })

        try {
          Promise.resolve(
            manager.q.enqueue(function () {
              return manager.check()
            })
          ).catch(function (exception) {
            console.warn('page/books/[bookId]/read:check-after-shrink:failed', {
              message: String(exception && exception.message ? exception.message : exception),
            })
          })
        } catch (exception) {
          console.warn('page/books/[bookId]/read:check-after-shrink:failed', {
            message: String(exception && exception.message ? exception.message : exception),
          })
        }
      })
    })
  }

  // 화면 맨 위에 걸친 챕터의 높이가 바뀌면 통째로 옮기지 않고, 보던 문단이 챕터 안에서 움직인 만큼만 옮겨 제자리에 둡니다.
  function keepReadingAnchorOnResize(manager, view) {
    if (!view || typeof view.on !== 'function') {
      return
    }

    view.on('resized', function () {
      var anchor = readingAnchor
      var delta = 0

      if (!anchor || anchor.view !== view || !anchor.node.isConnected || renditionInstance.manager !== manager) {
        scheduleReadingAnchorCapture()
        return
      }

      delta = Math.round(anchor.node.getBoundingClientRect().top - anchor.top)

      if (Math.abs(delta) >= 1) {
        var anchorBefore = manager.container ? manager.container.scrollTop : 0

        traceReader('anchor-correct', { index: view.section ? view.section.index : -1, delta: delta })
        markProgrammaticScroll()
        manager.scrollBy(0, delta, true)
        traceScrollWrite('anchor', manager.container, anchorBefore, { delta: delta })
        anchor.top += delta
      }

      scheduleReadingAnchorCapture()
    })
  }

  function captureReadingAnchor() {
    var manager = renditionInstance && renditionInstance.manager ? renditionInstance.manager : null
    var container = manager ? manager.container : null
    var visibleTop = 0
    var views = []
    var view = null
    var frameTop = 0
    var nodes = null
    var low = 0
    var high = 0
    var middle = 0
    var previous = readingAnchor

    readingAnchor = null

    if (!container || !manager.views || manager.settings.axis !== 'vertical') {
      return
    }

    visibleTop = container.getBoundingClientRect().top
    views = manager.views.all()

    for (var index = 0; index < views.length; index += 1) {
      var box = views[index].element.getBoundingClientRect()

      if (box.bottom > visibleTop + 1) {
        view = box.top < visibleTop - 1 && views[index].contents && views[index].iframe ? views[index] : null
        frameTop = box.top
        break
      }
    }

    if (!view || !view.contents.document || !view.contents.document.body) {
      return
    }

    // 본문은 이미 바뀌었는데 epub.js가 아직 챕터 높이를 다시 재지 않았다면, 바뀌기 전 기준을 그대로 둡니다.
    if (
      previous
      && previous.view === view
      && Date.now() - previous.at < 1000
      && Math.abs(view.contents.textHeight() - view.height()) > 1
    ) {
      readingAnchor = previous
      return
    }

    // 스크롤할 때마다 긴 챕터의 문단을 다시 모으지 않도록, 같은 문서면 처음 모은 목록을 그대로 씁니다.
    if (!view.booklogAnchorNodes || view.booklogAnchorDocument !== view.contents.document) {
      view.booklogAnchorDocument = view.contents.document
      view.booklogAnchorNodes = view.contents.document.body.querySelectorAll(
        'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,table,figure,img,svg'
      )
    }

    nodes = view.booklogAnchorNodes
    high = nodes.length - 1

    if (high < 0) {
      return
    }

    while (low < high) {
      middle = (low + high) >> 1

      if (frameTop + nodes[middle].getBoundingClientRect().bottom > visibleTop + 1) {
        high = middle
      } else {
        low = middle + 1
      }
    }

    readingAnchor = { view: view, node: nodes[low], top: nodes[low].getBoundingClientRect().top, at: Date.now() }
  }

  function scheduleReadingAnchorCapture() {
    if (readingAnchorFrameId) {
      return
    }

    readingAnchorFrameId = window.requestAnimationFrame(function () {
      readingAnchorFrameId = 0
      captureReadingAnchor()
    })
  }

  function shouldCounterPrependedResize(manager, view, size, prepended) {
    var element = view && view.element ? view.element : null
    var container = manager.container

    if (manager.settings.axis !== 'vertical' || manager.settings.fullsize || !element || !container || !size) {
      return prepended
    }

    var visibleTop = container.getBoundingClientRect().top
    var viewTop = element.getBoundingClientRect().top
    var previousHeight = (Number(size.height) || 0) - (Number(size.heightDelta) || 0)

    // 아래에 막 붙인 챕터는 화면 아래에 생기므로 처음 높이가 잡힐 때 옮기면 안 됩니다.
    if (!prepended && previousHeight <= 0) {
      return false
    }

    // 막 붙인 챕터는 맨 위에 끼워 넣은 것이라 항상 그만큼 옮깁니다. iOS 바운스로 scrollTop이 음수면 새 챕터가 화면 맨 위보다
    // 아래에 있는 것처럼 보여 걸친 챕터로 오판했고, 보정 없이 계속 맨 위에 머물러 앞 챕터가 표지까지 연달아 붙었습니다.
    if (previousHeight <= 0) {
      return true
    }

    // 화면 맨 위에 걸친 챕터는 보던 문단 아래에서 높이가 바뀌는 경우가 많아, 통째로 옮기면 보던 곳이 그만큼 튑니다.
    return viewTop + previousHeight <= visibleTop + 1
  }

  function buildReaderSettingsCss(settings) {
    var normalizedSettings = normalizeReaderSettings(settings)
    var cssRules = [
      'html{background:#ffffff !important;}',
      'body{background:#ffffff !important;color:#1c1917 !important;}',
      'a{color:#57534e !important;}',
    ]

    if (normalizedSettings.theme === 'sepia') {
      cssRules = [
        'html{background:#f7f2e6 !important;}',
        'body{background:#f7f2e6 !important;color:#33281f !important;}',
        'a{color:#79553b !important;}',
      ]
    }

    if (normalizedSettings.theme === 'night') {
      cssRules = [
        'html{background:#161616 !important;}',
        'body{background:#161616 !important;color:#e8e1d6 !important;}',
        'a{color:#d8b16d !important;}',
      ]
    }

    if (normalizedSettings.fontFamily === 'sans') {
      cssRules.push(
        'body,body p,body li,body blockquote{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif !important;}'
      )
    }

    if (normalizedSettings.fontFamily === 'serif') {
      cssRules.push(
        'body,body p,body li,body blockquote{font-family:Georgia,"Times New Roman","Noto Serif KR","Nanum Myeongjo",serif !important;}'
      )
    }

    if (normalizedSettings.lineHeight === 'relaxed') {
      cssRules.push(
        'body,body p,body div,body li,body blockquote,body section,body article{line-height:2.05 !important;}'
      )
    }

    if (normalizedSettings.lineHeight === 'loose') {
      cssRules.push(
        'body,body p,body div,body li,body blockquote,body section,body article{line-height:2.3 !important;}'
      )
    }

    if (normalizedSettings.pageMargin === 'narrow') {
      cssRules.push(
        'body{box-sizing:border-box !important;width:auto !important;max-width:none !important;min-width:0 !important;margin-left:0.75rem !important;margin-right:0.75rem !important;padding-left:0 !important;padding-right:0 !important;}'
      )
    }

    if (normalizedSettings.pageMargin === 'wide') {
      cssRules.push(
        'body{box-sizing:border-box !important;margin-left:0 !important;margin-right:0 !important;padding-left:3rem !important;padding-right:3rem !important;}'
      )
    }

    return cssRules.join('\n')
  }

  function applyReaderSettingsToDocument(doc, settings) {
    var styleElement = null
    var target = null

    if (!doc || !doc.createElement) {
      return
    }

    target = doc.head || doc.documentElement

    if (!target) {
      return
    }

    styleElement = doc.getElementById(READER_SETTINGS_STYLE_ID)

    if (!styleElement) {
      styleElement = doc.createElement('style')
      styleElement.id = READER_SETTINGS_STYLE_ID
      styleElement.type = 'text/css'
      target.appendChild(styleElement)
    }

    styleElement.textContent = buildReaderSettingsCss(settings)
  }

  function isAutoPagingSettling() {
    return Date.now() < settlingUntil
  }

  function setAutoPagingSettling() {
    settlingUntil = Date.now() + AUTO_PAGE_SETTLE_MS
  }

  /**
   * 자동 페이지 전환 의도 상태를 초기화합니다.
   * @returns {void}
   */
  function resetAutoPagingIntent() {
    intentDirection = ''
    intentStartedAt = 0
    window.clearTimeout(intentTimerId)
    intentTimerId = 0
  }

  /**
   * 예약된 자동 페이지 전환 검사와 상태를 초기화합니다.
   * @param {{ keepSettling?: boolean, keepRelease?: boolean, keepInFlight?: boolean }=} options 유지할 상태 옵션
   * @returns {void}
   */
  function resetAutoPagingState(options) {
    var keepSettling = !!(options && options.keepSettling)
    var keepRelease = !!(options && options.keepRelease)
    var keepInFlight = !!(options && options.keepInFlight)

    if (autoPagingCheckFrameId) {
      window.cancelAnimationFrame(autoPagingCheckFrameId)
      autoPagingCheckFrameId = 0
    }

    pendingAutoPagingDirection = ''
    resetAutoPagingIntent()

    if (!keepRelease) {
      releaseRequired = false
      releaseDirection = ''
    }

    if (!keepSettling) {
      settlingUntil = 0
    }

    if (!keepInFlight) {
      autoPagingGeneration += 1
      autoPagingInFlight = false
    }
  }

  /**
   * 수동 이동 전에 자동 페이지 전환 상태를 정리합니다.
   * @returns {void}
   */
  function prepareManualNavigation() {
    resetAutoPagingState()
    setAutoPagingSettling()
  }

  /**
   * 자동 페이지 전환에 사용할 스크롤 대상을 중복 없이 추가합니다.
   * @param {HTMLElement[]} targets 수집 중인 스크롤 대상 목록
   * @param {HTMLElement | null | undefined} target 검사할 DOM 요소
   */
  function appendAutoPagingTarget(targets, target) {
    if (!target || targets.indexOf(target) !== -1) {
      return
    }

    targets.push(target)
  }

  /**
   * 현재 리더에서 스크롤 이벤트를 받을 수 있는 후보들을 반환합니다.
   * @returns {HTMLElement[]} 자동 페이지 전환 후보 목록
   */
  function getAutoPagingTargets() {
    var targets = []
    var rootContainer = document.getElementById('epub-reader')
    var managerContainer = renditionInstance && renditionInstance.manager ? renditionInstance.manager.container : null

    appendAutoPagingTarget(targets, readerContainer)
    appendAutoPagingTarget(targets, rootContainer)
    appendAutoPagingTarget(targets, managerContainer)

    return targets
  }

  /**
   * 스크롤 앵커링을 끄고 상단 prepend 시 점프를 줄입니다.
   * @param {HTMLElement | null | undefined} target 적용할 DOM 요소
   */
  function disableScrollAnchoring(target) {
    if (!target || !target.style) {
      return
    }

    try {
      target.style.overflowAnchor = 'none'
    } catch (exception) {}
  }

  /**
   * 자동 페이지 전환 기준으로 쓸 수 있는 스크롤 컨테이너인지 확인합니다.
   * @param {HTMLElement | null | undefined} target 검사할 DOM 요소
   * @returns {boolean} 스크롤 판단에 사용할 수 있는지 여부
   */
  function isScrollableAutoPagingTarget(target) {
    var overflowY = ''

    if (!target || target.scrollHeight <= target.clientHeight) {
      return false
    }

    try {
      overflowY = window.getComputedStyle(target).overflowY || ''
    } catch (exception) {
      overflowY = ''
    }

    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
  }

  /**
   * 자동 페이지 전환에 사용할 대표 스크롤 컨테이너를 고릅니다.
   * @returns {HTMLElement | null} 실제 판단 기준이 될 스크롤 컨테이너
   */
  function resolveAutoPagingTarget() {
    var targets = getAutoPagingTargets()
    var i = 0

    for (i = 0; i < targets.length; i += 1) {
      if (isScrollableAutoPagingTarget(targets[i])) {
        return targets[i]
      }
    }

    return targets.length ? targets[0] : null
  }

  /**
   * 현재 자동 페이지 전환 기준 컨테이너와 스크롤 위치 상태를 동기화합니다.
   * @returns {HTMLElement | null} 현재 기준 스크롤 컨테이너
   */
  function syncAutoPagingTarget() {
    var target = resolveAutoPagingTarget()

    if (!target) {
      return null
    }

    if (autoPagingTarget !== target) {
      lastContainerScrollTop = target.scrollTop || 0
    }

    autoPagingTarget = target
    readerContainer = target

    return target
  }

  /**
   * 예약된 리더 레이아웃 재동기화를 정리합니다.
   * @returns {void}
   */
  function resetScheduledReaderLayoutSync() {
    if (readerLayoutSyncFrameId) {
      window.cancelAnimationFrame(readerLayoutSyncFrameId)
      readerLayoutSyncFrameId = 0
    }

    if (readerLayoutSyncTimerId) {
      window.clearTimeout(readerLayoutSyncTimerId)
      readerLayoutSyncTimerId = 0
    }
  }

  /**
   * 현재 리더 레이아웃 기준으로 스크롤 컨테이너를 다시 맞춥니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @returns {void}
   */
  function syncReaderLayout(component) {
    var target = null

    getAutoPagingTargets().forEach(function (candidateTarget) {
      disableScrollAnchoring(candidateTarget)
    })
    target = syncAutoPagingTarget()

    if (target) {
      bindAutoPaging(component, target)
    }
  }

  /**
   * 최초 렌더 직후 늦게 커지는 본문 높이를 반영하기 위해 재측정을 예약합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @param {{ frameCount?: number, delayMs?: number }=} options 재측정 옵션
   * @returns {void}
   */
  function scheduleReaderLayoutSync(component, options) {
    var remainingFrames = options && typeof options.frameCount === 'number' ? Math.max(1, options.frameCount) : 2
    var delayMs = options && typeof options.delayMs === 'number' ? Math.max(0, options.delayMs) : 160

    resetScheduledReaderLayoutSync()

    function runOnNextFrame() {
      readerLayoutSyncFrameId = window.requestAnimationFrame(function () {
        if (remainingFrames > 1) {
          remainingFrames -= 1
          runOnNextFrame()
          return
        }

        readerLayoutSyncFrameId = 0
        syncReaderLayout(component)

        if (delayMs > 0) {
          readerLayoutSyncTimerId = window.setTimeout(function () {
            readerLayoutSyncTimerId = 0
            syncReaderLayout(component)
          }, delayMs)
        }
      })
    }

    runOnNextFrame()
  }

  /**
   * 현재 방향 기준으로 경계까지 남은 거리를 계산합니다.
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {number} 경계까지 남은 거리
   */
  function getDistanceToEdge(target, direction) {
    if (!target) {
      return Number.POSITIVE_INFINITY
    }

    if (direction === 'prev') {
      return Number(target.scrollTop || 0)
    }

    if (direction === 'next') {
      return Math.max(target.scrollHeight - (target.scrollTop + target.clientHeight), 0)
    }

    return Number.POSITIVE_INFINITY
  }

  /**
   * 자동 페이지 전환을 다시 허용할 만큼 경계에서 벗어났는지 확인합니다.
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @returns {boolean} 재발동 가능한지 여부
   */
  function hasReleasedAutoPagingEdge(target) {
    if (!releaseRequired || !releaseDirection) {
      return true
    }

    return getDistanceToEdge(target, releaseDirection) > EDGE_RELEASE_DISTANCE
  }

  /**
   * 현재 위치가 자동 페이지 전환 트리거 범위인지 확인합니다.
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {boolean} 트리거 가능한 경계 근처인지 여부
   */
  function isWithinAutoPagingTrigger(target, direction) {
    return getDistanceToEdge(target, direction) <= EDGE_TRIGGER_DISTANCE
  }

  /**
   * 현재 위치가 자동 페이지 전환의 시작/끝 경계인지 확인합니다.
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {boolean} 더 이상 자동 이동하면 안 되는지 여부
   */
  function isAutoPagingBoundary(direction) {
    var spineItems =
      bookInstance && bookInstance.spine && bookInstance.spine.spineItems ? bookInstance.spine.spineItems : []
    var start = currentLocation && currentLocation.start ? currentLocation.start : null
    var end = currentLocation && currentLocation.end ? currentLocation.end : null
    var lastSpineIndex = spineItems.length ? spineItems.length - 1 : -1
    var startIndex = start && typeof start.index === 'number' ? start.index : null
    var endIndex = end && typeof end.index === 'number' ? end.index : startIndex
    var displayed = currentLocation && currentLocation.displayed ? currentLocation.displayed : null
    var startDisplayed = start && start.displayed ? start.displayed : null
    var page =
      displayed && typeof displayed.page === 'number'
        ? displayed.page
        : startDisplayed && typeof startDisplayed.page === 'number'
          ? startDisplayed.page
          : null
    var total =
      displayed && typeof displayed.total === 'number'
        ? displayed.total
        : startDisplayed && typeof startDisplayed.total === 'number'
          ? startDisplayed.total
          : null
    var progressPercent = Number(getProgressPercentFromLocator(start && start.cfi ? String(start.cfi) : ''))

    if (direction === 'prev') {
      if (startIndex === 0 && page === 1) {
        return true
      }

      if (startIndex === 0 && (progressPercent === 0 || !isFinite(progressPercent))) {
        return true
      }
    }

    if (direction === 'next') {
      if (lastSpineIndex >= 0 && endIndex === lastSpineIndex && page !== null && total !== null && page >= total) {
        return true
      }

      if (lastSpineIndex >= 0 && endIndex === lastSpineIndex && progressPercent === 100) {
        return true
      }
    }

    return false
  }

  /**
   * 자동 페이지 전환 완료 후 공통 상태를 마무리합니다.
   * @param {'next' | 'prev'} direction 이동 방향
   * @param {HTMLElement | null} target 현재 스크롤 컨테이너
   * @returns {void}
   */
  function finalizeAutoPagingTransition(direction, target) {
    var activeTarget = target || syncAutoPagingTarget()

    autoPagingInFlight = false
    releaseRequired = true
    releaseDirection = direction
    setAutoPagingSettling()
    resetAutoPagingIntent()

    if (activeTarget) {
      lastContainerScrollTop = activeTarget.scrollTop || 0
    }
  }

  // continuous 모드의 연결·위치 보정을 사용해 경계에서 추가 화면 이동이 생기지 않도록 합니다.
  function fillAdjacentSections(component, direction) {
    var manager = renditionInstance && renditionInstance.manager ? renditionInstance.manager : null
    var target = autoPagingTarget || syncAutoPagingTarget()
    var generation = autoPagingGeneration

    if (!renditionInstance || !target || autoPagingInFlight || isAutoPagingSettling()) {
      return
    }

    if (direction !== 'next' && direction !== 'prev') {
      return
    }

    if (isAutoPagingBoundary(direction)) {
      resetAutoPagingIntent()
      if (direction === 'next') {
        scheduleFinishPromptIfNeeded(component)
      }
      return
    }

    if (!manager || typeof manager.fill !== 'function') {
      return
    }

    autoPagingInFlight = true
    resetAutoPagingIntent()
    traceReader('edge-fill', { direction: direction })

    Promise.resolve()
      .then(function () {
        if (generation !== autoPagingGeneration) return
        return manager.fill()
      })
      .then(function () {
        if (generation !== autoPagingGeneration) return
        traceReader('edge-fill-done', { direction: direction })
        finalizeAutoPagingTransition(direction, syncAutoPagingTarget())
        console.debug('page/books/[bookId]/read:auto-page:requested', {
          direction: direction,
        })
      })
      .catch(function (exception) {
        if (generation !== autoPagingGeneration) return
        resetAutoPagingState()
        traceReader('edge-fill-failed', {
          direction: direction,
          message: String(exception && exception.message ? exception.message : exception).slice(0, 200),
        })
        console.warn('page/books/[bookId]/read:auto-page:failed', {
          direction: direction,
          message: String(exception && exception.message ? exception.message : exception),
        })
      })
  }

  /**
   * 스크롤 연속 이벤트를 한 프레임으로 합쳐 자동 페이지 전환을 검사합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {void}
   */
  function scheduleAutoPagingEvaluation(component, direction) {
    if (direction !== 'next' && direction !== 'prev') {
      return
    }

    pendingAutoPagingDirection = direction

    if (autoPagingCheckFrameId) {
      return
    }

    autoPagingCheckFrameId = window.requestAnimationFrame(function () {
      var queuedDirection = pendingAutoPagingDirection

      autoPagingCheckFrameId = 0
      pendingAutoPagingDirection = ''
      evaluateAutoPaging(component, queuedDirection)
    })
  }

  /**
   * 현재 스크롤 위치와 입력 방향을 바탕으로 자동 페이지 전환 여부를 평가합니다.
   * @param {any} component Alpine 컴포넌트 상태
   * @param {'next' | 'prev'} direction 이동 방향
   * @returns {void}
   */
  // 붙인 뒤에도 같은 끝에 그대로 있고 이웃 챕터가 여전히 없으면 붙지 않은 것이라, 큐가 비었을 때 간격을 두고 다시 시도합니다.
  function canRetryEdgeAttach(target, direction) {
    var manager = renditionInstance && renditionInstance.manager ? renditionInstance.manager : null
    var edgeView = null

    if (!manager || !manager.views || !manager.q || releaseDirection !== direction) {
      return false
    }

    edgeView = direction === 'prev' ? manager.views.first() : manager.views.last()

    if (
      getDistanceToEdge(target, direction) > 1
      || !edgeView
      || !edgeView.section
      || !(direction === 'prev' ? edgeView.section.prev() : edgeView.section.next())
      || manager.q.running
      || manager.q.length()
      || Date.now() - lastEdgeRetryAt < EDGE_RETRY_INTERVAL_MS
    ) {
      return false
    }

    lastEdgeRetryAt = Date.now()
    traceReader('edge-retry', { direction: direction })
    return true
  }

  function evaluateAutoPaging(component, direction) {
    var target = autoPagingTarget || syncAutoPagingTarget()

    if (!target || (direction !== 'next' && direction !== 'prev')) {
      resetAutoPagingIntent()
      return
    }

    if (component.loading || isRestoringPosition || autoPagingInFlight || isAutoPagingSettling()) {
      traceEdgeSkip(target, direction, {
        loading: !!component.loading,
        restoring: isRestoringPosition,
        inFlight: autoPagingInFlight,
        settling: isAutoPagingSettling(),
      })
      resetAutoPagingIntent()
      if (getDistanceToEdge(target, direction) <= 1) {
        intentTimerId = window.setTimeout(function () {
          intentTimerId = 0
          scheduleAutoPagingEvaluation(component, direction)
        }, AUTO_PAGE_SETTLE_MS)
      }
      return
    }

    if (releaseRequired) {
      if (!hasReleasedAutoPagingEdge(target) && !canRetryEdgeAttach(target, direction)) {
        traceEdgeSkip(target, direction, { releaseRequired: true, releaseDirection: releaseDirection })
        resetAutoPagingIntent()
        return
      }

      releaseRequired = false
      releaseDirection = ''
    }

    if (!isWithinAutoPagingTrigger(target, direction)) {
      if (intentDirection === direction) {
        resetAutoPagingIntent()
      }

      return
    }

    if (intentDirection !== direction) {
      intentDirection = direction
      intentStartedAt = Date.now()
      // 끝에 닿으면 더 스크롤되지 않아 다음 scroll 이벤트가 오지 않으므로, 머문 시간을 따로 확인합니다.
      intentTimerId = window.setTimeout(function () {
        intentTimerId = 0
        scheduleAutoPagingEvaluation(component, direction)
      }, EDGE_INTENT_MS + 20)
      return
    }

    if (Date.now() - intentStartedAt < EDGE_INTENT_MS) {
      return
    }

    fillAdjacentSections(component, direction)
  }

  function bindAutoPaging(component, target) {
    if (!target) {
      return
    }

    if (boundAutoPagingTarget === target && boundAutoPagingHandler) {
      return
    }

    if (boundAutoPagingTarget && boundAutoPagingHandler) {
      boundAutoPagingTarget.removeEventListener('scroll', boundAutoPagingHandler)
    }

    boundAutoPagingTarget = target
    readerContainer = target
    lastContainerScrollTop = target.scrollTop || 0

    boundAutoPagingHandler = function () {
      var currentScrollTop = boundAutoPagingTarget ? boundAutoPagingTarget.scrollTop || 0 : 0
      var direction = ''

      markReadingSessionActivity(component)
      scheduleReadingAnchorCapture()

      if (currentScrollTop > lastContainerScrollTop) {
        direction = 'next'
      } else if (currentScrollTop < lastContainerScrollTop) {
        direction = 'prev'
      }

      lastContainerScrollTop = currentScrollTop

      if (direction) {
        scheduleAutoPagingEvaluation(component, direction)
      }
    }

    target.addEventListener('scroll', boundAutoPagingHandler, { passive: true })

    if (!target.__booklogEdgeWheelBound) {
      target.__booklogEdgeWheelBound = true
      target.addEventListener('wheel', handleEdgeWheel, { passive: true })
    }
  }

  // 끝에서 계속 굴려도 scroll 이벤트가 생기지 않아, 휠 방향으로 앞뒤 챕터 붙이기를 확인합니다.
  function handleEdgeWheel(event) {
    var target = boundAutoPagingTarget
    var direction = event.deltaY < 0 ? 'prev' : event.deltaY > 0 ? 'next' : ''

    if (direction && target && activeComponent && getDistanceToEdge(target, direction) <= 1) {
      scheduleAutoPagingEvaluation(activeComponent, direction)
    }
  }

  // epub.js는 그림 최대 높이를 본문 높이의 95%로 정하는데, 본문이 높이 100% 상자뿐인 그림 페이지는 그 값이 0이 되어 그림이 사라집니다.
  function restoreCollapsedImages(doc) {
    var win = doc.defaultView
    var container = renditionInstance && renditionInstance.manager ? renditionInstance.manager.container : null
    var screenHeight = container && container.clientHeight ? container.clientHeight : window.innerHeight

    if (!win || !screenHeight) {
      return
    }

    var pictureOnly = !!doc.body && String(doc.body.textContent || '').replace(/\s+/g, '').length < 40
    var fixes = { collapsed: 0, pictureOnly: 0, svg: 0 }

    Array.prototype.forEach.call(doc.querySelectorAll('img, svg'), function (image) {
      var maxHeight = parseFloat(win.getComputedStyle(image).maxHeight)

      // 그림만 있는 페이지는 epub.js가 접힌 본문 높이로 최대 높이를 정해, 그림이 몇 px로 줄어듭니다.
      if (maxHeight === 0 || (pictureOnly && maxHeight < screenHeight * 0.5)) {
        fixes[maxHeight === 0 ? 'collapsed' : 'pictureOnly'] += 1
        image.style.setProperty('max-height', Math.round(screenHeight * 0.95) + 'px', 'important')
      }
    })

    // 높이 100% 상자에 둔 SVG 표지는 본문 높이를 내용에 맞추면 높이가 거의 0이 되어, viewBox 비율로 높이를 정합니다.
    Array.prototype.forEach.call(doc.querySelectorAll('svg[viewBox]'), function (svg) {
      var box = svg.getBoundingClientRect()
      var viewBox = String(svg.getAttribute('viewBox') || '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)

      if (box.height >= 50 || box.width <= 0 || viewBox.length !== 4 || !(viewBox[2] > 0) || !(viewBox[3] > 0)) {
        return
      }

      fixes.svg += 1
      svg.style.setProperty(
        'height',
        Math.round(Math.min(screenHeight * 0.95, (box.width * viewBox[3]) / viewBox[2])) + 'px',
        'important'
      )
    })

    if ((fixes.collapsed || fixes.pictureOnly || fixes.svg) && isReaderTraceOn()) {
      var fixedView = renditionInstance.manager.views.all().find(function (candidate) {
        return candidate.contents && candidate.contents.document === doc
      })

      traceReader(
        'image-height-fix',
        Object.assign({ index: fixedView && fixedView.section ? fixedView.section.index : -1 }, fixes)
      )
    }
  }

  // ---- 오프라인 서재 ----

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key)
    } catch (_error) {
      return null
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch (_error) {
      /* 저장 공간이 없으면 위치를 기억하지 않고 읽게 둡니다. */
    }
  }

  function readJson(key) {
    try {
      return JSON.parse(readStorage(key) || 'null')
    } catch (_error) {
      return null
    }
  }

  // 기존 리더가 만든 캐시만 읽고, 아직 캐시가 없는 기기에서 빈 DB를 새로 만들지 않습니다.
  function readCachedBooks() {
    return new Promise(function (resolve) {
      var request = null

      if (!window.indexedDB) {
        resolve([])
        return
      }

      try {
        request = window.indexedDB.open(CACHE_DB_NAME)
      } catch (_error) {
        resolve([])
        return
      }

      request.onupgradeneeded = function () {
        request.transaction.abort()
      }
      request.onerror = function () {
        resolve([])
      }
      request.onsuccess = function () {
        var db = request.result
        var entries = null

        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.close()
          resolve([])
          return
        }

        entries = db.transaction(CACHE_STORE_NAME, 'readonly').objectStore(CACHE_STORE_NAME).getAll()
        entries.onsuccess = function () {
          db.close()
          resolve(
            (entries.result || [])
              .filter(function (entry) {
                return entry && entry.cacheKey && entry.buffer
              })
              .sort(function (left, right) {
                return Number(right.lastOpenedAt || 0) - Number(left.lastOpenedAt || 0)
              })
          )
        }
        entries.onerror = function () {
          db.close()
          resolve([])
        }
      }
    })
  }

  function describeBook(entry) {
    var stored = readJson(TITLE_KEY_PREFIX + entry.cacheKey)
    var book = null

    if (stored && stored.title) {
      return Promise.resolve(stored)
    }

    try {
      book = window.ePub(entry.buffer)
    } catch (_error) {
      return Promise.resolve({ title: '제목을 읽지 못한 책', author: '' })
    }

    return Promise.resolve(book.loaded.metadata)
      .then(function (metadata) {
        var description = {
          title: String((metadata && metadata.title) || '').trim() || '제목 없는 책',
          author: String((metadata && metadata.creator) || '').trim(),
        }

        writeStorage(TITLE_KEY_PREFIX + entry.cacheKey, JSON.stringify(description))
        return description
      })
      .catch(function () {
        return { title: '제목을 읽지 못한 책', author: '' }
      })
      .finally(function () {
        try {
          book.destroy()
        } catch (_error) {
          /* 목록에는 영향이 없습니다. */
        }
      })
  }

  function renderShelf(entries, notice) {
    list.replaceChildren()

    if (!entries.length) {
      message.textContent =
        '이 기기에 저장된 책이 없습니다. 인터넷에 연결된 상태에서 책을 한 번 열어 두면 오프라인에서도 읽을 수 있습니다.'
      return Promise.resolve()
    }

    message.textContent = notice || ''

    return Promise.all(entries.map(describeBook)).then(function (descriptions) {
      entries.forEach(function (entry, index) {
        var item = document.createElement('li')
        var button = document.createElement('button')
        var title = document.createElement('span')
        var meta = document.createElement('span')
        var position = readJson(POSITION_KEY_PREFIX + entry.cacheKey)

        button.type = 'button'
        button.className = 'book-button'
        title.className = 'book-title'
        title.textContent = descriptions[index].title
        meta.className = 'book-meta'
        meta.textContent = [descriptions[index].author, position && position.locator ? '이어 읽기' : '처음부터 읽기']
          .filter(Boolean)
          .join(' · ')
        button.append(title, meta)
        button.addEventListener('click', function () {
          openEntry(entry)
        })
        item.append(button)
        list.append(item)
      })
    })
  }

  function loadShelf(notice) {
    message.textContent = '저장된 책을 찾는 중입니다.'
    return readCachedBooks().then(function (entries) {
      return renderShelf(entries, notice)
    })
  }

  function readOfflineSettings(cacheKey) {
    var userKey = String(cacheKey || '').split(':')[0] || 'default'

    return normalizeReaderSettings(readJson(SETTINGS_KEY_PREFIX + userKey))
  }

  function readVisibleLocator() {
    var start = currentLocation && currentLocation.start ? currentLocation.start : null
    var cfi = start && start.cfi ? String(start.cfi) : ''
    var visibleTop = findVisibleTopPosition(cfi)

    return visibleTop && visibleTop.locator ? visibleTop.locator : cfi
  }

  function savePosition() {
    var locator = ''

    if (positionSaveTimerId) {
      window.clearTimeout(positionSaveTimerId)
      positionSaveTimerId = 0
    }

    if (!openKey || !renditionInstance || isRestoringPosition || activeComponent.loading) return

    locator = readVisibleLocator() || lastLocator

    if (!locator) return

    lastLocator = locator
    writeStorage(POSITION_KEY_PREFIX + openKey, JSON.stringify({ locator: locator, savedAt: Date.now() }))
  }

  function schedulePositionSave() {
    if (positionSaveTimerId) window.clearTimeout(positionSaveTimerId)
    positionSaveTimerId = window.setTimeout(savePosition, POSITION_SAVE_DELAY_MS)
  }

  function getProgressPercentFromLocator(locator) {
    var progressPercent = ''
    var progressRatio = null

    if (!activeComponent || activeComponent.progressLocationsStatus !== 'ready') {
      return ''
    }

    try {
      if (
        locator
        && bookInstance
        && bookInstance.locations
        && typeof bookInstance.locations.percentageFromCfi === 'function'
      ) {
        progressRatio = bookInstance.locations.percentageFromCfi(locator)

        if (progressRatio === null || progressRatio === undefined || !isFinite(progressRatio)) {
          return ''
        }

        progressPercent = String(Math.max(0, Math.min(100, Math.round(progressRatio * 100))))
      }
    } catch (exception) {
      progressPercent = ''
    }

    return progressPercent
  }

  function updateOfflineProgress() {
    var start = currentLocation && currentLocation.start
    var percent = getProgressPercentFromLocator(start && start.cfi)

    progressBar.hidden = percent === ''
    progressFill.style.width = (percent || '0') + '%'
    if (percent === '') {
      progressBar.removeAttribute('aria-valuenow')
    } else {
      progressBar.setAttribute('aria-valuenow', percent)
    }
  }

  function prepareOfflineProgress(entry, book) {
    var locations = book.locations
    var cached = null

    if (entry.progressLocationsVersion === PROGRESS_LOCATIONS_CACHE_VERSION) {
      try {
        cached = JSON.parse(entry.progressLocations)
        if (
          Array.isArray(cached)
          && cached.length > 0
          && cached.every(function (locator) {
            return typeof locator === 'string' && /^epubcfi\(.+\)$/.test(locator) && !!book.spine.get(locator)
          })
        ) {
          locations.load(cached)
          activeComponent.progressLocationsStatus = 'ready'
          updateOfflineProgress()
          return
        }
      } catch (_error) {
        /* 캐시를 읽지 못하면 EPUB에서 위치를 계산합니다. */
      }
    }

    Promise.resolve()
      .then(function () {
        if (book === bookInstance) return locations.generate(PROGRESS_LOCATION_BREAK)
      })
      .then(function (generated) {
        if (book !== bookInstance) return
        activeComponent.progressLocationsStatus = generated && generated.length > 0 ? 'ready' : 'failed'
        updateOfflineProgress()
      })
      .catch(function () {
        if (book === bookInstance) activeComponent.progressLocationsStatus = 'failed'
      })
  }

  function updateOfflineLocation(location) {
    var target = autoPagingTarget || resolveAutoPagingTarget()

    scheduleReadingAnchorCapture()
    currentLocation = location || null

    if (target) {
      autoPagingTarget = target
      lastContainerScrollTop = target.scrollTop || 0
    }

    updateOfflineProgress()
    schedulePositionSave()
  }

  function setLoading(loading) {
    activeComponent.loading = loading
    loadingNotice.hidden = !loading
  }

  // 기존 리더의 renderBookBuffer와 같은 설정·본문 처리로 책을 그리고, 서버 대신 이 기기에 남긴 위치로 옮깁니다.
  function openEntry(entry) {
    var settings = readOfflineSettings(entry.cacheKey)
    var saved = readJson(POSITION_KEY_PREFIX + entry.cacheKey)
    var startedRendition = null

    closeBook()
    openKey = entry.cacheKey
    shelf.hidden = true
    reader.hidden = false
    setLoading(true)
    syncReaderPageTheme(settings.theme)
    progressBar.dataset.theme = settings.theme
    window.history.pushState({ booklogOfflineBook: entry.cacheKey }, '')

    readerContainer = document.getElementById('epub-reader')
    bookInstance = window.ePub(entry.buffer)
    renditionInstance = bookInstance.renderTo('epub-reader', {
      width: '100%',
      height: '100%',
      manager: 'continuous',
      flow: 'scrolled',
      offset: CHAPTER_PRELOAD_OFFSET_PX,
      allowScriptedContent: false,
    })
    startedRendition = renditionInstance
    Promise.resolve(startedRendition.started).then(function () {
      patchContinuousViews(startedRendition.manager)
    })

    if (renditionInstance.themes && typeof renditionInstance.themes.fontSize === 'function') {
      renditionInstance.themes.fontSize(String(settings.fontSizePercent) + '%')
    }

    getAutoPagingTargets().forEach(function (target) {
      disableScrollAnchoring(target)
    })

    renditionInstance.hooks.content.register(function (contents) {
      var doc = contents && contents.document ? contents.document : null

      if (!doc) return

      applyReaderSettingsToDocument(doc, settings)

      if (doc.documentElement && doc.documentElement.style) {
        doc.documentElement.style.setProperty('overflow-anchor', 'none', 'important')
        doc.documentElement.style.setProperty('height', 'auto', 'important')
      }

      if (doc.body && doc.body.style) {
        doc.body.style.setProperty('overflow-anchor', 'none', 'important')
        doc.body.style.setProperty('height', 'auto', 'important')
      }

      restoreCollapsedImages(doc)
      scheduleReaderLayoutSync(activeComponent, {
        frameCount: 2,
        delayMs: 180,
      })
    })

    renditionInstance.on('relocated', function (location) {
      if (startedRendition !== renditionInstance) return

      var target = syncAutoPagingTarget()

      if (target) bindAutoPaging(activeComponent, target)
      updateOfflineLocation(location)
    })

    new Promise(function (resolve, reject) {
      bookInstance.on('openFailed', function () {
        reject(new Error('EPUB 파일을 열지 못했습니다.'))
      })
      bookInstance.ready.then(resolve, reject)
    })
      .then(function () {
        return renditionInstance.display()
      })
      .then(function (location) {
        if (startedRendition !== renditionInstance) return
        refillSectionsAfterMove()
        syncReaderLayout(activeComponent)
        scheduleReaderLayoutSync(activeComponent, {
          frameCount: 2,
          delayMs: 180,
        })
        updateOfflineLocation(location || renditionInstance.currentLocation())

        if (!saved || !saved.locator) return

        isRestoringPosition = true
        prepareManualNavigation()
        return Promise.resolve(displayAt(saved.locator))
          .then(function (restored) {
            if (startedRendition === renditionInstance) updateOfflineLocation(restored)
          })
          .catch(function () {
            /* 이 파일에서 찾을 수 없는 위치면 처음부터 보여 줍니다. */
          })
          .finally(function () {
            isRestoringPosition = false
          })
      })
      .then(function () {
        if (startedRendition !== renditionInstance) return
        setLoading(false)
        lastLocator = readVisibleLocator()
        prepareOfflineProgress(entry, bookInstance)
      })
      .catch(function () {
        if (startedRendition !== renditionInstance) return
        setLoading(false)
        showShelf('이 책을 열지 못했습니다. 다른 책을 골라 주세요.')
      })
  }

  function closeBook() {
    var container = document.getElementById('epub-reader')

    savePosition()
    resetAutoPagingState()
    resetScheduledReaderLayoutSync()

    try {
      if (renditionInstance) renditionInstance.destroy()
      if (bookInstance) bookInstance.destroy()
    } catch (_error) {
      /* 다음 책을 여는 데에는 영향이 없습니다. */
    }

    renditionInstance = null
    bookInstance = null
    currentLocation = null
    activeComponent.progressLocationsStatus = 'pending'
    updateOfflineProgress()
    readingAnchor = null
    autoPagingTarget = null
    isRestoringPosition = false
    openKey = ''
    lastLocator = ''

    if (container) container.innerHTML = ''
  }

  function showShelf(notice) {
    var themeColorMeta = document.querySelector('meta[name="theme-color"]')

    closeBook()
    document.documentElement.style.backgroundColor = ''
    document.body.style.backgroundColor = ''
    if (themeColorMeta) themeColorMeta.setAttribute('content', '#f7f2e6')
    reader.hidden = true
    shelf.hidden = false
    loadShelf(notice)
  }

  backButton.addEventListener('click', function () {
    window.history.back()
  })
  window.addEventListener('popstate', function () {
    if (openKey) showShelf()
  })
  window.addEventListener('pagehide', savePosition)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') savePosition()
  })

  if (!window.ePub) {
    message.textContent = '오프라인 리더를 준비하지 못했습니다. 인터넷에 연결된 뒤 북로그를 한 번 열어 주세요.'
  } else {
    loadShelf()
  }

  return {
    savePosition: savePosition,
  }
})()
