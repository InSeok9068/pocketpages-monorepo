window.booklogAudio = (function () {
  var config = window.booklogReaderConfig || {}
  var activeSession = null
  var previewRequest = null
  var progressQueue = Promise.resolve()
  var CACHE_NAME = 'booklog-audio-v3'
  var CACHE_LIMIT = 16
  var SAVE_INTERVAL_MS = 15000
  var BUFFER_AHEAD_SECONDS = 120
  var BUFFER_BEHIND_SECONDS = 30
  var outboxKey = 'booklog-audio-pending:' + config.readerCacheKey
  var pendingSaves = {}
  var saveSequence = 0
  var SLEEP_MODES = ['', '15', '30', '60', 'chapter']
  var sleepTimer = { mode: '', endsAt: 0, timerId: 0 }
  var diagnosticsAvailable = !!document.getElementById('reader-audio-diagnostics-copy')
  var diagnosticsEnabled = false
  var diagnosticsKey = 'booklog-audio-diagnostics:' + config.readerCacheKey
  var diagnosticsUser = String(config.readerCacheKey || '').split(':')[0]
  var diagnosticsPrefix = 'booklog-audio-diagnostics:' + diagnosticsUser + ':'
  var diagnostics = []
  var diagnosticsPage = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
  var diagnosticsStorage = true
  var diagnosticsLastProgress = 0
  var DIAGNOSTICS_LIMIT = 1000
  if (diagnosticsAvailable) {
    pruneDiagnostics()
    try {
      var storedDiagnostics = JSON.parse(localStorage.getItem(diagnosticsKey) || '[]')
      if (Array.isArray(storedDiagnostics)) diagnostics = storedDiagnostics.slice(-DIAGNOSTICS_LIMIT)
    } catch (_error) {
      diagnosticsStorage = false
    }
  }
  try {
    pendingSaves = JSON.parse(localStorage.getItem(outboxKey) || '{}') || {}
  } catch (_error) {
    /* 저장 없이 동기화합니다. */
  }

  // 같은 사용자의 진단만 최근 7일·최대 3권까지 남깁니다.
  function pruneDiagnostics() {
    try {
      var records = []
      var keys = []
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index)
        if (key === diagnosticsKey || key.indexOf(diagnosticsPrefix) === 0) keys.push(key)
      }
      keys.forEach(function (key) {
        var at = 0
        try {
          var entries = JSON.parse(localStorage.getItem(key) || '[]')
          if (Array.isArray(entries) && entries.length) at = Date.parse(entries[entries.length - 1].at) || 0
        } catch (_error) {
          /* 잘못 저장된 진단은 정리합니다. */
        }
        if (at < Date.now() - 7 * 86400000) localStorage.removeItem(key)
        else records.push({ key: key, at: at })
      })
      records.sort(function (left, right) {
        if (left.key === diagnosticsKey) return -1
        if (right.key === diagnosticsKey) return 1
        return right.at - left.at
      })
      records.slice(3).forEach(function (entry) {
        localStorage.removeItem(entry.key)
      })
    } catch (_error) {
      /* 저장소 접근이 막혀도 재생합니다. */
    }
  }

  /**
   * 이 화면의 진단 기록을 시작하거나 중지합니다.
   * @returns {void}
   */
  function toggleDiagnostics() {
    if (!diagnosticsAvailable) return
    if (diagnosticsEnabled) recordDiagnostic('diagnostics-stop', activeSession)
    diagnosticsEnabled = !diagnosticsEnabled
    updateDiagnosticsButton()
    if (diagnosticsEnabled) {
      recordDiagnostic('diagnostics-start', activeSession, { wasDiscarded: !!document.wasDiscarded })
      pruneDiagnostics()
    }
  }

  function updateDiagnosticsButton() {
    var button = document.getElementById('reader-audio-diagnostics-toggle')
    if (button) {
      button.textContent = diagnosticsEnabled ? '기록 중지' : '기록 시작'
      button.setAttribute('aria-pressed', String(diagnosticsEnabled))
    }
  }

  /**
   * 이 기기의 현재 책 진단을 삭제하고 기록을 중지합니다.
   * @returns {void}
   */
  function clearDiagnostics() {
    if (!diagnosticsAvailable) return
    diagnosticsEnabled = false
    diagnostics = []
    updateDiagnosticsButton()
    try {
      localStorage.removeItem(diagnosticsKey)
      diagnosticsStorage = true
    } catch (_error) {
      diagnosticsStorage = false
    }
    var field = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('reader-audio-diagnostics-text'))
    if (field) {
      field.value = ''
      field.hidden = true
    }
    var status = document.getElementById('reader-audio-diagnostics-status')
    if (status) {
      status.hidden = false
      status.textContent = diagnosticsStorage
        ? '이 책의 진단 기록을 삭제하고 기록을 중지했습니다.'
        : '기록은 중지했지만 기기에 저장된 기록을 삭제하지 못했습니다.'
    }
  }

  // 진단 기록 실패가 재생을 방해하지 않도록 본문·URL 없이 상태만 기기에 보관합니다.
  function recordDiagnostic(event, session, details, always) {
    if (!diagnosticsEnabled && !always) return
    try {
      var player = session && session.player
      var part = session && session.parts[session.partIndex]
      var entry = {
        at: new Date().toISOString(),
        page: diagnosticsPage,
        event: event,
        visibility: document.visibilityState || 'unknown',
        online: navigator.onLine,
      }
      if (session) {
        Object.assign(entry, {
          session: session.diagnosticsId,
          section: session.sectionIndex,
          chunk: session.chunkIndex,
          chunkId: session.chunkId,
          part: session.partIndex,
          audioId: part ? part.audioId || '' : '',
          deviceVoice: session.fallback,
          busy: session.state.cloudAudioBusy,
          positionReady: session.positionReady,
          seconds: Math.round((player.currentTime || 0) * 10) / 10,
          duration: isFinite(player.duration) ? player.duration : null,
          paused: player.paused,
          ended: player.ended,
          readyState: player.readyState,
          networkState: player.networkState,
          bufferedEnd: player.buffered && player.buffered.length ? player.buffered.end(player.buffered.length - 1) : 0,
          rate: player.playbackRate,
          sleepMode: sleepTimer.mode,
          playbackMode: session.stream ? 'buffer' : 'file',
          partSeconds: audioSeconds(session),
        })
      }
      if (details) entry.details = details
      diagnostics.push(entry)
      diagnostics = diagnostics.slice(-DIAGNOSTICS_LIMIT)
      try {
        localStorage.setItem(diagnosticsKey, JSON.stringify(diagnostics))
        diagnosticsStorage = true
      } catch (_error) {
        diagnosticsStorage = false
      }
    } catch (_error) {
      /* 진단 실패와 관계없이 재생합니다. */
    }
  }

  function errorDetails(error, extra) {
    return Object.assign(
      { error: error && error.name, message: String((error && error.message) || '').slice(0, 200) },
      extra
    )
  }

  /**
   * 이 기기의 재생 진단을 내보냅니다.
   * @returns {string} 진단 JSON
   */
  function exportDiagnostics() {
    recordDiagnostic('export', activeSession)
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        bookId: config.bookId,
        fileId: config.bookFileId,
        userAgent: navigator.userAgent || '',
        storageAvailable: diagnosticsStorage,
        recording: diagnosticsEnabled,
        events: diagnostics,
      },
      null,
      2
    )
  }

  /**
   * 오디오 진단을 복사하고 실패 시 직접 복사할 칸을 표시합니다.
   * @param {HTMLButtonElement} button 복사 버튼
   * @returns {void}
   */
  function copyDiagnostics(button) {
    var text = exportDiagnostics()
    var field = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('reader-audio-diagnostics-text'))
    var status = document.getElementById('reader-audio-diagnostics-status')
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
      if (status) {
        status.hidden = false
        status.textContent = copied
          ? '진단 기록을 복사했습니다. 채팅에 붙여넣어 주세요.'
          : '자동 복사가 안 됩니다. 아래 기록을 길게 눌러 복사해 주세요.'
      }
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

  function persistPendingSaves() {
    try {
      localStorage.setItem(outboxKey, JSON.stringify(pendingSaves))
    } catch (_error) {
      /* 메모리에 보관합니다. */
    }
  }

  function sendSnapshot(snapshot) {
    var form = formForBook()
    Object.keys(snapshot.fields).forEach(function (key) {
      form.set(key, snapshot.fields[key])
    })
    return fetch('/api/books/audio-progress', { method: 'POST', body: form, keepalive: true })
      .then(function (response) {
        // 다시 보내도 받아들여지지 않는 요청(삭제·교체된 구간 등)은 버려서 새 청취를 막지 않습니다.
        var rejected = response.status >= 400 && response.status < 500 && [401, 408, 429].indexOf(response.status) < 0
        return rejected ? { ok: true } : readJson(response)
      })
      .then(function () {
        if (pendingSaves[snapshot.key] && pendingSaves[snapshot.key].revision === snapshot.revision) {
          delete pendingSaves[snapshot.key]
          persistPendingSaves()
        }
      })
  }

  function flushPendingSaves() {
    return Object.keys(pendingSaves).reduce(function (queue, key) {
      return queue.then(function () {
        return sendSnapshot(pendingSaves[key])
      })
    }, Promise.resolve())
  }

  function isActive(session) {
    return activeSession === session && !session.controller.signal.aborted
  }

  function formForBook() {
    var form = new FormData()
    form.set('bookId', config.bookId)
    form.set('fileId', config.bookFileId)
    return form
  }

  function readJson(response) {
    return response.json().then(function (result) {
      if (!response.ok || !result.ok)
        throw new Error(result.message || '오디오북을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
      return result
    })
  }

  function savePosition(session, force, completed) {
    if (!session || !session.positionReady || session.completed || !session.chunkId) return
    if (!force && Date.now() - session.lastSavedAt < SAVE_INTERVAL_MS) return
    session.lastSavedAt = Date.now()
    var snapshot = {
      key: config.bookFileId + ':' + session.configHash + ':' + session.sectionIndex,
      sectionIndex: session.sectionIndex,
      revision: String(Date.now()) + ':' + String(++saveSequence),
      fields: {
        configHash: session.configHash,
        chunkId: session.chunkId,
        seconds: String(session.partOffset + (session.fallback ? session.fallbackElapsed : audioSeconds(session))),
        isCompleted: String(!!completed),
        restart: String(session.restartPending),
        listenedAt: new Date().toISOString(),
      },
    }
    pendingSaves[snapshot.key] = snapshot
    persistPendingSaves()
    // 이 탭의 이전 저장이 끝난 뒤 다음 위치를 저장하여 늦은 요청의 역전을 막습니다.
    progressQueue = progressQueue
      .then(function () {
        return sendSnapshot(snapshot).then(function () {
          if (snapshot.fields.restart === 'true' && snapshot.sectionIndex === session.sectionIndex) {
            session.restartPending = false
          }
          session.syncFailed = false
        })
      })
      .catch(function () {
        session.syncFailed = true
        if (isActive(session))
          session.state.cloudAudioMessage =
            '인터넷 연결이 불안정해 들은 위치를 이 기기에 잠시 보관했습니다. 연결되면 자동으로 저장합니다.'
      })
  }

  function openCache() {
    try {
      return window.caches
        ? window.caches.open(CACHE_NAME).catch(function () {
            return null
          })
        : Promise.resolve(null)
    } catch (_error) {
      return Promise.resolve(null)
    }
  }

  function loadChunk(session, sectionIndex, index) {
    if (!isActive(session)) return Promise.reject(new DOMException('Playback stopped', 'AbortError'))
    var query = new URLSearchParams({
      bookId: config.bookId,
      fileId: config.bookFileId,
      sectionIndex: String(sectionIndex),
      chunkIndex: String(index),
    })
    recordDiagnostic('chunk-request', session, { section: sectionIndex, chunk: index })
    return fetch('/api/books/audio-chunk?' + query.toString(), { cache: 'no-store', signal: session.controller.signal })
      .then(function (response) {
        recordDiagnostic('chunk-response', session, { section: sectionIndex, chunk: index, status: response.status })
        return response.json().then(function (result) {
          if (response.ok && result.ok) return result
          // 표지·이미지 페이지처럼 본문이 없는 곳에서 시작하면 뒤쪽 첫 본문 챕터부터 재생합니다.
          if (result.reason === 'no-text' && index === 0 && result.nextSectionIndex > sectionIndex) {
            return loadChunk(session, result.nextSectionIndex, 0).then(function (moved) {
              return { moved: moved }
            })
          }
          throw Object.assign(new Error(result.message || '오디오북 요청에 실패했습니다.'), {
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          })
        })
      })
      .then(function (result) {
        if (result.moved) return result.moved
        if (!isActive(session)) throw new DOMException('Playback stopped', 'AbortError')
        if (result.configHash !== session.configHash)
          throw new Error('오디오북이 새로 만들어졌습니다. 이어 듣기를 다시 눌러 주세요.')
        if (
          !Number.isInteger(result.chunkCount)
          || result.chunkCount <= index
          || !result.chunkId
          || !Array.isArray(result.parts)
          || !result.parts.length
        ) {
          throw new Error('오디오북을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
        }
        return Promise.all(
          result.parts.map(function (part) {
            var text = String(part.text || part.fallbackText || '')
            if (part.fallbackText) {
              return {
                fallbackText: part.fallbackText,
                pending: !!part.pending,
                text: text,
                duration: Number(part.durationSeconds) || 0,
              }
            }
            return fetchAudioBlob(session, part.audioUrl).then(function (blob) {
              return {
                blob: blob,
                audioId: new URL(part.audioUrl, window.location.origin).searchParams.get('chunkId') || '',
                text: text,
                duration: Number(part.durationSeconds) || 0,
              }
            })
          })
        ).then(function (parts) {
          return {
            sectionIndex: sectionIndex,
            chapterOrder: result.chapterNumber > 0 ? result.chapterNumber + ' / ' + result.chapterTotal : '',
            parts: parts,
            timeline: Array.isArray(result.timeline) ? result.timeline.map(Number) : [],
            previousSectionIndex: Number.isInteger(result.previousSectionIndex) ? result.previousSectionIndex : -1,
            count: result.chunkCount,
            chunkId: result.chunkId,
            nextSectionIndex: Number.isInteger(result.nextSectionIndex) ? result.nextSectionIndex : -1,
          }
        })
      })
  }

  // 이동 중 잠깐 끊긴 연결로 듣기가 끝나지 않도록, 연결·응답 오류만 몇 초 뒤 다시 받습니다.
  function loadChunkRetrying(session, sectionIndex, index, retries) {
    return loadChunk(session, sectionIndex, index).catch(function (error) {
      var network = error && (error.retryable || error.name === 'TypeError' || error.name === 'SyntaxError')
      recordDiagnostic(
        'chunk-request-error',
        session,
        errorDetails(error, { section: sectionIndex, chunk: index, retries: retries })
      )
      if (!network || !isActive(session)) throw error
      if (!(retries > 0)) {
        throw new Error('인터넷 연결이 불안정해 다음 구간을 받지 못했습니다. 연결을 확인한 뒤 이어 듣기를 눌러 주세요.')
      }
      return new Promise(function (resolve) {
        setTimeout(resolve, 3000)
      }).then(function () {
        return loadChunkRetrying(session, sectionIndex, index, retries - 1)
      })
    })
  }

  function fetchAudioBlob(session, audioUrl) {
    var audioId = new URL(audioUrl, window.location.origin).searchParams.get('chunkId') || ''
    var url = new URL(
      '/_booklog-audio-cache/' + encodeURIComponent(config.readerCacheKey + ':' + audioUrl),
      window.location.origin
    ).href
    return openCache().then(function (cache) {
      if (!cache) session.cacheUnavailable = true
      return (
        cache
          ? cache.match(url).catch(function () {
              return null
            })
          : Promise.resolve(null)
      ).then(function (cached) {
        if (cached) {
          recordDiagnostic('audio-cache-hit', session, { audioId: audioId })
          return cached.blob()
        }
        if (!isActive(session)) throw new DOMException('Playback stopped', 'AbortError')
        recordDiagnostic('audio-request', session, { audioId: audioId })
        return fetch(audioUrl, { signal: session.controller.signal })
          .then(function (response) {
            recordDiagnostic('audio-response', session, { audioId: audioId, status: response.status })
            if (!response.ok)
              throw Object.assign(new Error('음성을 내려받지 못했습니다. 인터넷 연결을 확인해 주세요.'), {
                retryable: response.status === 408 || response.status === 429 || response.status >= 500,
              })
            return response.blob()
          })
          .then(function (blob) {
            recordDiagnostic('audio-downloaded', session, { audioId: audioId, bytes: blob.size })
            if (!cache) return blob
            return cache
              .put(url, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }))
              .then(function () {
                return cache.keys()
              })
              .then(function (keys) {
                return Promise.all(
                  keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT)).map(function (key) {
                    return cache.delete(key)
                  })
                )
              })
              .catch(function () {
                session.cacheUnavailable = true
              })
              .then(function () {
                return blob
              })
          })
      })
    })
  }

  function setError(session, error) {
    if (!isActive(session) || error.name === 'AbortError') return
    recordDiagnostic('session-error', session, errorDetails(error))
    session.failed = true
    endSession(session, error.message || '음성을 재생하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  }

  // 재생이 끝나거나 막히면 시작 화면으로 돌아가, 이유와 함께 이어 들을 위치를 보여줍니다.
  function endSession(session, message) {
    if (!isActive(session)) return
    recordDiagnostic('session-end', session)
    var state = session.state
    stop()
    state.cloudAudioMessage = message
  }

  function nextPosition(session) {
    if (session.chunkIndex + 1 < session.chunkCount) {
      return { sectionIndex: session.sectionIndex, chunkIndex: session.chunkIndex + 1 }
    }
    return session.nextSectionIndex >= 0 ? { sectionIndex: session.nextSectionIndex, chunkIndex: 0 } : null
  }

  function prepareNextChunk(session) {
    if (session.stream) return
    var next = nextPosition(session)
    var key = next ? next.sectionIndex + ':' + next.chunkIndex : ''
    if (!isActive(session) || !next || session.prefetchedKey === key) return
    session.prefetchedKey = key
    session.nextChunk = loadChunk(session, next.sectionIndex, next.chunkIndex).then(
      function (value) {
        return { value: value }
      },
      function (error) {
        return { error: error }
      }
    )
  }

  // 리더가 화면이 꺼진 동안 기기 음성 구간을 독서 시간에서 빼도록 화면 상태에도 함께 알립니다.
  function setDeviceVoice(session, value) {
    session.fallback = value
    session.state.cloudAudioDeviceVoice = value
  }

  function playAudio(session) {
    recordDiagnostic('play-request', session)
    return session.player.play().catch(function (error) {
      recordDiagnostic('play-rejected', session, errorDetails(error))
      if (!isActive(session)) return
      if (error.name === 'NotAllowedError') {
        session.state.cloudAudioActive = false
        session.state.cloudAudioMessage = '음성이 준비됐습니다. 재생 버튼을 눌러 주세요.'
        return
      }
      setError(session, error)
    })
  }

  function showPlayback(session) {
    session.state.cloudAudioDetail =
      String(session.chunkIndex + 1)
      + ' / '
      + String(session.chunkCount)
      + ' 구간'
      + (session.parts.length > 1 ? ' · 조각 ' + (session.partIndex + 1) + ' / ' + session.parts.length : '')
    var part = session.parts[session.partIndex]
    session.state.cloudAudioMessage = session.fallback
      ? part && part.pending
        ? '이 부분은 아직 AI 음성을 만드는 중이라 기기 음성으로 읽고 있습니다.'
        : '이 부분은 AI 음성을 만들지 못해 기기 음성으로 읽는 중입니다.'
      : session.syncFailed
        ? '들은 위치를 아직 저장하지 못했습니다. 연결되면 자동으로 저장합니다.'
        : ''
  }

  function chapterLabel(session) {
    return chapterLabelAt(session.sectionIndex)
  }

  function chapterLabelAt(sectionIndex) {
    return window.booklogReaderLogic && window.booklogReaderLogic.audioChapterLabel
      ? window.booklogReaderLogic.audioChapterLabel(sectionIndex)
      : ''
  }

  // 긴 챕터명만 줄여 보이고 이어질 시간은 항상 보이도록 둘을 나눠 돌려줍니다.
  function resumeLabel(progress) {
    if (!progress) return { chapter: '', label: '처음 듣는 책 · 현재 챕터 처음부터' }
    if (progress.isCompleted) return { chapter: '', label: '마지막 챕터까지 모두 들었습니다' }
    var chapter = chapterLabelAt(progress.sectionIndex)
    if (progress.startsNextSection) return { chapter: chapter || '다음 챕터', label: '처음부터' }
    return { chapter: chapter, label: formatTime(progress.chapterSeconds || 0) + '부터' }
  }

  function showResume(state, resume) {
    state.cloudAudioResumeChapter = resume.chapter
    state.cloudAudioResumeLabel = resume.label
  }

  /**
   * 재생 전 화면에 이어 들을 위치를 표시합니다.
   * @param {any} state 리더 UI 상태
   * @returns {void}
   */
  function preview(state) {
    if (activeSession) return
    var request = {}
    previewRequest = request
    progressQueue
      .then(flushPendingSaves)
      .catch(function () {
        /* 임시 보관한 위치는 다음 재생에서 다시 보냅니다. */
      })
      .then(function () {
        var query = new URLSearchParams({ bookId: config.bookId, fileId: config.bookFileId })
        return fetch('/api/books/audio-progress?' + query.toString(), { cache: 'no-store' }).then(readJson)
      })
      .then(function (result) {
        if (!activeSession && request === previewRequest) showResume(state, resumeLabel(result.progress))
      })
      .catch(function () {
        if (!activeSession && request === previewRequest)
          showResume(state, { chapter: '', label: '마지막 청취 위치부터' })
      })
  }

  function mediaSessionApi() {
    return typeof navigator !== 'undefined' && navigator.mediaSession ? navigator.mediaSession : null
  }

  function setMediaPlaybackState(state) {
    var mediaSession = mediaSessionApi()
    if (!mediaSession) return
    try {
      mediaSession.playbackState = state
    } catch (_error) {
      /* 상태 표시 없이 재생합니다. */
    }
  }

  function updateMediaSession(session) {
    var mediaSession = mediaSessionApi()
    if (!mediaSession || typeof window.MediaMetadata !== 'function') return
    var bookTitle = session.player.getAttribute('data-book-title') || ''
    try {
      mediaSession.metadata = new window.MediaMetadata({
        title: chapterLabel(session) || bookTitle || 'AI 오디오북',
        artist: bookTitle,
        album: '북로그 AI 오디오북',
      })
    } catch (_error) {
      /* 메타데이터 없이 재생합니다. */
    }
  }

  function sumUntil(values, end) {
    var total = 0
    for (var index = 0; index < Math.min(end, values.length); index += 1) total += values[index]
    return total
  }

  function chapterDuration(session) {
    return sumUntil(session.timeline, session.timeline.length)
  }

  function chapterPosition(session) {
    var within = session.fallback ? session.fallbackElapsed : audioSeconds(session)
    return Math.min(
      sumUntil(session.timeline, session.chunkIndex) + session.partOffset + within,
      chapterDuration(session)
    )
  }

  function sleepLabel() {
    if (sleepTimer.mode === 'chapter') return '챕터 끝'
    if (!sleepTimer.mode) return ''
    return Math.max(1, Math.ceil((sleepTimer.endsAt - Date.now()) / 60000)) + '분'
  }

  function clearSleepTimer(state) {
    if (sleepTimer.timerId) clearTimeout(sleepTimer.timerId)
    sleepTimer = { mode: '', endsAt: 0, timerId: 0 }
    state.cloudAudioSleep = ''
    state.cloudAudioSleepLabel = ''
  }

  function sleepNow(session, message) {
    recordDiagnostic('sleep-stop', session)
    clearSleepTimer(session.state)
    endSession(session, message)
  }

  // 백그라운드에서는 브라우저가 타이머를 늦출 수 있어, 재생 진행이 갱신될 때도 시간을 확인합니다.
  function checkSleepTimer(session) {
    if (!sleepTimer.mode || sleepTimer.mode === 'chapter') return
    if (Date.now() >= sleepTimer.endsAt) {
      sleepNow(session, '잠자기 타이머로 재생을 멈췄습니다. 이어 듣기로 들은 곳부터 계속 들을 수 있습니다.')
      return
    }
    session.state.cloudAudioSleepLabel = sleepLabel()
  }

  /**
   * 잠자기 타이머를 끄기 → 15분 → 30분 → 60분 → 챕터 끝 순서로 바꿉니다.
   * @returns {void}
   */
  function cycleSleepTimer() {
    var session = activeSession
    if (!session) return
    var mode = SLEEP_MODES[(SLEEP_MODES.indexOf(sleepTimer.mode) + 1) % SLEEP_MODES.length]
    clearSleepTimer(session.state)
    if (!mode) return
    sleepTimer.mode = mode
    if (mode !== 'chapter') {
      sleepTimer.endsAt = Date.now() + Number(mode) * 60000
      sleepTimer.timerId = setTimeout(
        function () {
          if (activeSession) checkSleepTimer(activeSession)
        },
        Number(mode) * 60000
      )
    }
    session.state.cloudAudioSleep = mode
    session.state.cloudAudioSleepLabel = sleepLabel()
  }

  function updateProgress(session) {
    if (!isActive(session)) return
    checkSleepTimer(session)
    if (!isActive(session)) return
    session.state.cloudAudioDuration = chapterDuration(session)
    session.state.cloudAudioHasPrevious = session.previousSectionIndex >= 0
    session.state.cloudAudioHasNext = session.nextSectionIndex >= 0
    if (!session.state.cloudAudioSeeking) session.state.cloudAudioPosition = chapterPosition(session)
    updateMediaPosition(session)
  }

  /**
   * 음성 구간이 있는 이전·다음 챕터의 처음으로 옮깁니다. 재생 중이었으면 이어 재생하고, 멈춰 있었으면 멈춘 채로 둡니다.
   * @param {number} direction 1이면 다음 챕터, -1이면 이전 챕터
   * @returns {void}
   */
  function moveChapter(direction) {
    var session = activeSession
    if (!session || session.state.cloudAudioBusy) return
    syncBufferedPosition(session)
    if (!isActive(session)) return
    var target = direction > 0 ? session.nextSectionIndex : session.previousSectionIndex
    if (!(target >= 0)) return
    var wasPaused = !session.state.cloudAudioActive
    savePosition(session, true, false)
    haltCurrent(session)
    session.completed = false
    session.failed = false
    // 새 챕터의 첫 저장은 이전 완료 기록을 덮어써야 하므로 처음부터 듣는 것으로 표시합니다.
    session.restartPending = true
    session.sectionIndex = target
    session.chunkIndex = 0
    session.resumeSeconds = 0
    session.nextChunk = null
    session.prefetchedKey = ''
    session.holdPaused = wasPaused
    playChunk(session)
  }

  function updateMediaPosition(session) {
    var mediaSession = mediaSessionApi()
    var duration = chapterDuration(session)
    if (!mediaSession || typeof mediaSession.setPositionState !== 'function' || !(duration > 0)) return
    try {
      mediaSession.setPositionState({
        duration: duration,
        playbackRate: session.player.playbackRate || 1,
        position: chapterPosition(session),
      })
    } catch (_error) {
      /* 위치 표시 없이 재생합니다. */
    }
  }

  function haltCurrent(session) {
    session.positionReady = false
    if (session.fallback && window.speechSynthesis) {
      setDeviceVoice(session, false)
      session.speechToken += 1
      window.speechSynthesis.cancel()
      window.speechSynthesis.resume()
    }
    session.player.pause()
    closeAudioBuffer(session)
  }

  /**
   * 현재 챕터의 재생 위치로 이동합니다. 재생 중이었으면 옮긴 곳에서 이어 재생하고, 멈춰 있었으면 멈춘 채로 둡니다.
   * @param {number} seconds 챕터 처음부터의 시간(초)
   * @returns {void}
   */
  function seekTo(seconds) {
    var session = activeSession
    if (!session || session.state.cloudAudioBusy || !session.timeline.length || !session.parts.length) return
    syncBufferedPosition(session)
    if (!isActive(session)) return
    var target = Math.max(0, Math.min(Number(seconds) || 0, chapterDuration(session) - 0.5))
    var chunkIndex = 0
    var chunkStart = 0
    while (chunkIndex < session.timeline.length - 1 && target >= chunkStart + session.timeline[chunkIndex]) {
      chunkStart += session.timeline[chunkIndex]
      chunkIndex += 1
    }
    var within = target - chunkStart
    session.completed = false
    session.failed = false
    var wasPaused = !session.state.cloudAudioActive
    if (chunkIndex !== session.chunkIndex) {
      haltCurrent(session)
      session.chunkIndex = chunkIndex
      session.resumeSeconds = within
      session.nextChunk = null
      session.prefetchedKey = ''
      session.holdPaused = wasPaused
      playChunk(session)
      return
    }
    var partIndex = 0
    var partStart = 0
    while (partIndex < session.parts.length - 1 && within >= partStart + session.parts[partIndex].duration) {
      partStart += session.parts[partIndex].duration
      partIndex += 1
    }
    var playerTarget = (session.streamEntry ? session.streamEntry.start : 0) + within - partStart
    var canSeekInPlace = true
    if (session.stream) {
      canSeekInPlace = false
      var ranges = session.stream.buffer.buffered
      for (var range = 0; range < ranges.length; range += 1) {
        if (ranges.start(range) <= playerTarget && playerTarget < ranges.end(range)) canSeekInPlace = true
      }
    }
    if (partIndex === session.partIndex && !session.fallback && session.positionReady && canSeekInPlace) {
      session.player.currentTime = playerTarget
      updateProgress(session)
      savePosition(session, true, false)
      return
    }
    haltCurrent(session)
    session.partIndex = partIndex
    session.partOffset = partStart
    session.resumeSeconds = within - partStart
    session.holdPaused = wasPaused
    playPart(session)
  }

  /**
   * 지금 읽고 있는 문장을 추정합니다. 조각 안의 재생 시간 비율로 원문 위치를 잡고 그 문장 처음부터 돌려줍니다.
   * @returns {{ sectionIndex: number, text: string } | null} 챕터와 문장, 재생 중이 아니면 null
   */
  function currentAnchor() {
    var session = activeSession
    var part = session ? session.parts[session.partIndex] : null
    if (!part || !part.text) return null
    // 기기 음성은 지금 읽는 문장을 알고 있어, 시간 비율로 추정하지 않고 그 문장을 그대로 씁니다.
    if (session.fallback && session.fallbackSpeaking) {
      return { sectionIndex: session.sectionIndex, text: session.fallbackSpeaking.replace(/\s+/g, ' ').trim() }
    }
    var elapsed = session.fallback ? session.fallbackElapsed : audioSeconds(session)
    var ratio = part.duration > 0 ? Math.min(1, elapsed / part.duration) : 0
    var text = part.text
    // 낭독 속도는 공백을 뺀 글자 수에 비례하므로, 줄바꿈·공백이 많은 대사 부분에서 위치가 앞서가지 않게 공백 제외 글자로 셉니다.
    var target = Math.floor(ratio * text.replace(/\s+/g, '').length)
    var offset = 0
    for (var counted = 0; offset < text.length && counted < target; offset += 1) {
      if (!/\s/.test(text[offset])) counted += 1
    }
    var start = Math.max(
      text.lastIndexOf('. ', offset),
      text.lastIndexOf('? ', offset),
      text.lastIndexOf('! ', offset),
      text.lastIndexOf('\n', offset)
    )
    var sentence = text
      .slice(start < 0 ? 0 : start + 1)
      .trim()
      .split('\n')[0]
    return { sectionIndex: session.sectionIndex, text: sentence.replace(/\s+/g, ' ').trim() }
  }

  /**
   * 현재 위치에서 앞뒤로 이동합니다. 챕터 처음과 끝을 넘지 않습니다.
   * @param {number} seconds 이동할 시간(초), 음수면 뒤로
   * @returns {void}
   */
  function seekBy(seconds) {
    var session = activeSession
    if (!session) return
    var position = chapterPosition(session)
    var target = position + seconds
    // 기기 음성은 문장 처음부터 다시 읽으므로, 앞으로 갈 때는 적어도 지금 문장 다음으로 넘어가게 합니다.
    if (session.fallback && seconds > 0)
      target = Math.max(target, position + (session.fallbackPieceSeconds || 0) + 0.01)
    seekTo(target)
  }

  /**
   * 재생 중이면 일시 정지하고, 멈춰 있으면 이어서 재생합니다.
   * @returns {boolean} 처리 여부. 재생 세션이 없거나 끝났으면 false
   */
  function toggle() {
    var session = activeSession
    if (!session || session.completed || session.failed) return false
    recordDiagnostic('toggle-request', session)
    // 다른 구간을 불러오는 중에는 이전 음성이 다시 재생되지 않도록 잠금화면 재생 요청도 무시합니다.
    if (session.state.cloudAudioBusy) return true
    if (session.fallback && window.speechSynthesis) {
      if (session.state.cloudAudioActive) {
        window.speechSynthesis.pause()
        session.state.cloudAudioActive = false
        setMediaPlaybackState('paused')
        savePosition(session, true, false)
      } else {
        // 오래 멈춘 발화는 iOS가 버려 resume으로는 소리가 나지 않을 수 있어, 멈춘 문장부터 다시 읽습니다.
        session.resumeSeconds = session.fallbackElapsed
        speakFallback(session, session.parts[session.partIndex].fallbackText, false)
      }
      return true
    }
    if (session.player.paused) playAudio(session)
    else session.player.pause()
    return true
  }

  /**
   * 재생 시간을 `분:초` 또는 `시:분:초`로 표시합니다.
   * @param {number} seconds 시간(초)
   * @returns {string} 표시 문자열
   */
  function formatTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0))
    var hours = Math.floor(total / 3600)
    var minutes = Math.floor((total % 3600) / 60)
    var rest = String(total % 60).padStart(2, '0')
    return hours > 0 ? hours + ':' + String(minutes).padStart(2, '0') + ':' + rest : minutes + ':' + rest
  }

  function bindMediaSession(session) {
    var mediaSession = mediaSessionApi()
    if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return
    var player = session.player
    var handlers = {
      play: function () {
        if (!isActive(session)) return
        if (session.fallback ? !session.state.cloudAudioActive : player.paused) toggle()
      },
      pause: function () {
        if (!isActive(session)) return
        if (session.fallback ? session.state.cloudAudioActive : !player.paused) toggle()
      },
      stop: function () {
        if (isActive(session)) stop()
      },
      seekbackward: function (details) {
        if (isActive(session)) seekBy(-((details && details.seekOffset) || 15))
      },
      seekforward: function (details) {
        if (isActive(session)) seekBy((details && details.seekOffset) || 15)
      },
      seekto: function (details) {
        if (isActive(session) && details && typeof details.seekTime === 'number') seekTo(details.seekTime)
      },
      previoustrack: function () {
        if (isActive(session)) moveChapter(-1)
      },
      nexttrack: function () {
        if (isActive(session)) moveChapter(1)
      },
    }
    Object.keys(handlers).forEach(function (action) {
      try {
        mediaSession.setActionHandler(action, function (details) {
          recordDiagnostic('media-action', session, { action: action })
          return handlers[action](details)
        })
      } catch (_error) {
        /* 지원하지 않는 동작은 건너뜁니다. */
      }
    })
  }

  function clearMediaSession() {
    var mediaSession = mediaSessionApi()
    if (!mediaSession) return
    ;['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach(
      function (action) {
        try {
          mediaSession.setActionHandler(action, null)
        } catch (_error) {
          /* 지원하지 않는 동작은 건너뜁니다. */
        }
      }
    )
    setMediaPlaybackState('none')
  }

  function playChunk(session, prepared) {
    recordDiagnostic('chunk-transition', session, { prepared: !!prepared })
    // 재생 바를 연달아 옮기면 늦게 도착한 이전 구간이 새 위치를 덮지 않도록 마지막 요청만 반영합니다.
    var token = (session.loadToken += 1)
    session.positionReady = false
    session.failed = false
    session.state.cloudAudioBusy = true
    return (prepared || loadChunkRetrying(session, session.sectionIndex, session.chunkIndex, 2))
      .then(function (result) {
        if (!isActive(session) || token !== session.loadToken) return
        if (result.sectionIndex !== session.sectionIndex) {
          session.sectionIndex = result.sectionIndex
          session.chunkIndex = 0
          session.restartPending = true
        }
        session.timeline = result.timeline.length ? result.timeline : session.timeline
        session.state.cloudAudioChapter = chapterLabel(session)
        session.state.cloudAudioChapterOrder = result.chapterOrder
        session.chunkCount = result.count
        session.chunkId = result.chunkId
        session.nextSectionIndex = result.nextSectionIndex
        session.previousSectionIndex = result.previousSectionIndex
        session.nextChunk = null
        session.prefetchedKey = ''
        session.parts = result.parts
        session.chunkData = result
        session.partIndex = 0
        session.partOffset = 0
        recordDiagnostic('chunk-ready', session, { parts: result.parts.length })
        // 저장 위치는 조각 길이를 이어 붙인 구간 내 시간이라, 해당 조각과 조각 안의 시간으로 되돌립니다.
        while (
          session.partIndex < session.parts.length - 1
          && session.parts[session.partIndex].duration > 0
          && session.resumeSeconds >= session.partOffset + session.parts[session.partIndex].duration
        ) {
          session.partOffset += session.parts[session.partIndex].duration
          session.partIndex += 1
        }
        session.resumeSeconds = Math.max(0, session.resumeSeconds - session.partOffset)
        return playPart(session)
      })
      .catch(function (error) {
        if (token !== session.loadToken) return
        session.holdPaused = false
        setError(session, error)
      })
  }

  function audioSeconds(session) {
    var entry = session.streamEntry
    var seconds = session.player.currentTime || 0
    return entry ? Math.max(0, Math.min(seconds - entry.start, entry.end - entry.start)) : seconds
  }

  function closeAudioBuffer(session) {
    var stream = session.stream
    if (!stream) return
    session.stream = null
    session.streamEntry = null
    stream.controller.abort()
    stream.source.removeEventListener('sourceopen', stream.onOpen)
    stream.source.removeEventListener('sourceclose', stream.onClose)
    try {
      if (stream.buffer && stream.buffer.updating) stream.buffer.abort()
    } catch (_error) {
      /* 이미 분리된 버퍼입니다. */
    }
    URL.revokeObjectURL(stream.url)
    stream.entries = []
    stream.cursor = null
  }

  function isCurrentBuffer(session, stream) {
    return isActive(session) && session.stream === stream
  }

  // 버퍼의 전역 시간을 기존 챕터·구간·조각 위치로 바꿉니다.
  function syncBufferedPosition(session) {
    var stream = session.stream
    if (!stream || !stream.started || stream.syncing) return
    stream.syncing = true
    try {
      var time = session.player.currentTime || 0
      var index = stream.entries.indexOf(session.streamEntry) + 1
      while (index < stream.entries.length && stream.entries[index].start <= time + 0.001) {
        var entry = stream.entries[index++]
        var previous = session.streamEntry
        var chapterChanged = session.sectionIndex !== entry.data.sectionIndex
        if (previous) savePosition(session, true, chapterChanged)
        if (previous && chapterChanged && sleepTimer.mode === 'chapter') {
          sleepNow(
            session,
            '챕터를 끝까지 들어 잠자기 타이머로 멈췄습니다. 이어 듣기로 다음 챕터부터 들을 수 있습니다.'
          )
          return
        }
        session.streamEntry = entry
        session.sectionIndex = entry.data.sectionIndex
        session.chunkIndex = entry.chunkIndex
        session.chunkData = entry.data
        session.chunkId = entry.data.chunkId
        session.chunkCount = entry.data.count
        session.parts = entry.data.parts
        session.partIndex = entry.partIndex
        session.partOffset = entry.partOffset
        session.timeline = entry.data.timeline
        session.nextSectionIndex = entry.data.nextSectionIndex
        session.previousSectionIndex = entry.data.previousSectionIndex
        session.state.cloudAudioChapter = chapterLabel(session)
        session.state.cloudAudioChapterOrder = entry.data.chapterOrder
        if (chapterChanged) session.restartPending = true
        showPlayback(session)
        updateMediaSession(session)
        recordDiagnostic('buffer-boundary', session)
        if (previous) savePosition(session, true, false)
      }
    } finally {
      stream.syncing = false
    }
  }

  function mutateAudioBuffer(session, stream, mutate) {
    return new Promise(function (resolve, reject) {
      var buffer = stream.buffer
      function cleanup() {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', failed)
        buffer.removeEventListener('abort', failed)
        stream.controller.signal.removeEventListener('abort', failed)
      }
      function done() {
        cleanup()
        resolve()
      }
      function failed() {
        cleanup()
        reject(new Error('오디오 버퍼를 준비하지 못했습니다.'))
      }
      if (!isCurrentBuffer(session, stream)) {
        failed()
        return
      }
      buffer.addEventListener('updateend', done)
      buffer.addEventListener('error', failed)
      buffer.addEventListener('abort', failed)
      stream.controller.signal.addEventListener('abort', failed)
      try {
        mutate(buffer)
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  function useFilePlayback(session, stream, error) {
    if (!isCurrentBuffer(session, stream)) return
    syncBufferedPosition(session)
    if (!isCurrentBuffer(session, stream)) return
    var seconds = stream.started ? audioSeconds(session) : stream.resume
    var hold = stream.started ? session.player.paused : stream.hold
    recordDiagnostic('buffer-fallback', session, errorDetails(error))
    session.positionReady = false
    session.player.pause()
    closeAudioBuffer(session)
    session.streamDisabled = true
    session.resumeSeconds = seconds
    session.holdPaused = hold
    playPart(session)
  }

  // 현재 음성과 앞쪽 약 2분을 준비합니다. 한 파일이 길면 그 파일 끝까지 받을 수 있습니다.
  function pumpAudioBuffer(session) {
    var stream = session.stream
    if (!stream || !stream.buffer || stream.pumping || stream.terminal || !isActive(session)) return
    stream.pumping = true
    function step() {
      if (!isCurrentBuffer(session, stream)) return
      var cutoff = (session.player.currentTime || 0) - BUFFER_BEHIND_SECONDS
      if (cutoff >= stream.trimmed + 30) {
        return mutateAudioBuffer(session, stream, function (buffer) {
          buffer.remove(0, cutoff)
        }).then(function () {
          stream.trimmed = cutoff
          stream.entries = stream.entries.filter(function (entry) {
            return entry === session.streamEntry || entry.end > cutoff
          })
          recordDiagnostic('buffer-trim', session, { before: cutoff })
          return step()
        })
      }
      if (stream.started && stream.end - session.player.currentTime >= BUFFER_AHEAD_SECONDS) return
      var cursor = stream.cursor
      if (cursor.partIndex >= cursor.data.parts.length) {
        var nextIndex = cursor.chunkIndex + 1
        var nextSection = cursor.data.sectionIndex
        if (nextIndex >= cursor.data.count) {
          nextIndex = 0
          nextSection = cursor.data.nextSectionIndex
        }
        if (nextSection < 0) {
          finish('complete')
          return
        }
        return loadChunkRetrying(session, nextSection, nextIndex, 2).then(
          function (data) {
            if (!isCurrentBuffer(session, stream)) return
            stream.cursor = { data: data, chunkIndex: nextIndex, partIndex: 0 }
            return step()
          },
          function () {
            if (!isCurrentBuffer(session, stream)) return
            finish('error')
          }
        )
      }
      var part = cursor.data.parts[cursor.partIndex]
      if (part.fallbackText) {
        finish('device-voice')
        return
      }
      return part.blob
        .arrayBuffer()
        .then(function (bytes) {
          return mutateAudioBuffer(session, stream, function (buffer) {
            buffer.appendBuffer(bytes)
          })
        })
        .then(function () {
          if (!isCurrentBuffer(session, stream)) return
          var ranges = stream.buffer.buffered
          var end = ranges.length ? ranges.end(ranges.length - 1) : stream.end
          if (!(end > stream.end)) throw new Error('오디오 버퍼에 음성이 없습니다.')
          var entry = {
            data: cursor.data,
            chunkIndex: cursor.chunkIndex,
            partIndex: cursor.partIndex,
            partOffset: cursor.data.parts.slice(0, cursor.partIndex).reduce(function (sum, item) {
              return sum + item.duration
            }, 0),
            start: stream.end,
            end: end,
          }
          stream.entries.push(entry)
          stream.end = end
          cursor.partIndex += 1
          recordDiagnostic('buffer-append', session, { audioId: part.audioId || '', start: entry.start, end: end })
          if (!stream.started) {
            stream.started = true
            session.player.currentTime = Math.min(stream.resume, Math.max(0, end - 0.1))
            session.resumeSeconds = 0
            session.positionReady = true
            session.state.cloudAudioBusy = false
            syncBufferedPosition(session)
            updateProgress(session)
            if (stream.hold) {
              session.state.cloudAudioActive = false
              setMediaPlaybackState('paused')
              savePosition(session, true, false)
            } else {
              playAudio(session)
            }
          }
          return step()
        })
    }
    function finish(reason) {
      stream.terminal = reason
      recordDiagnostic('buffer-end', session, { reason: reason })
      if (stream.source.readyState === 'open') stream.source.endOfStream()
    }
    Promise.resolve()
      .then(step)
      .catch(function (error) {
        useFilePlayback(session, stream, error)
      })
      .then(function () {
        stream.pumping = false
      })
  }

  function startBufferedAudio(session, hold) {
    var MediaSource = window.MediaSource
    var part = session.parts[session.partIndex]
    if (
      session.streamDisabled
      || !MediaSource
      || !MediaSource.isTypeSupported('audio/mpeg')
      || part.blob.type !== 'audio/mpeg'
    )
      return false
    try {
      var source = new MediaSource()
      var stream = {
        source: source,
        buffer: null,
        entries: [],
        end: 0,
        trimmed: 0,
        cursor: { data: session.chunkData, chunkIndex: session.chunkIndex, partIndex: session.partIndex },
        controller: new AbortController(),
        started: false,
        pumping: false,
        terminal: '',
        resume: session.resumeSeconds,
        hold: hold,
        url: URL.createObjectURL(source),
      }
      session.stream = stream
      stream.onOpen = function () {
        if (!isCurrentBuffer(session, stream) || stream.buffer) return
        try {
          stream.buffer = source.addSourceBuffer('audio/mpeg')
          stream.buffer.mode = 'sequence'
          pumpAudioBuffer(session)
        } catch (error) {
          useFilePlayback(session, stream, error)
        }
      }
      stream.onClose = function () {
        useFilePlayback(session, stream, new Error('MediaSource closed'))
      }
      source.addEventListener('sourceopen', stream.onOpen)
      source.addEventListener('sourceclose', stream.onClose)
      if (session.objectUrl) {
        URL.revokeObjectURL(session.objectUrl)
        session.objectUrl = ''
      }
      session.player.src = stream.url
      session.player.playbackRate = Number(session.state.readAloudRate || 1)
      recordDiagnostic('buffer-start', session)
      return true
    } catch (error) {
      closeAudioBuffer(session)
      session.streamDisabled = true
      recordDiagnostic('buffer-unavailable', session, errorDetails(error))
      return false
    }
  }

  function playPart(session) {
    closeAudioBuffer(session)
    var part = session.parts[session.partIndex]
    var hold = !!session.holdPaused
    session.holdPaused = false
    setDeviceVoice(session, false)
    recordDiagnostic('part-transition', session, { deviceVoice: !!part.fallbackText })
    if (part.fallbackText) return speakFallback(session, part.fallbackText, hold)
    session.startAnchor = ''
    session.positionReady = false
    if (startBufferedAudio(session, hold)) return
    if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
    session.objectUrl = URL.createObjectURL(part.blob)
    session.player.src = session.objectUrl
    session.player.playbackRate = Number(session.state.readAloudRate || 1)
    session.state.cloudAudioBusy = false
    showPlayback(session)
    updateMediaSession(session)
    updateProgress(session)
    if (hold) {
      session.saveWhenReady = true
      session.state.cloudAudioActive = false
      setMediaPlaybackState('paused')
      return
    }
    return playAudio(session)
  }

  function advancePart(session) {
    if (!isActive(session)) return
    if (session.partIndex + 1 >= session.parts.length) {
      advanceChunk(session)
      return
    }
    session.partOffset += session.parts[session.partIndex].duration
    session.partIndex += 1
    session.resumeSeconds = 0
    playPart(session)
  }

  function splitSpeech(text) {
    var pieces = []
    String(text)
      .split(/\n+/)
      .forEach(function (line) {
        var rest = line.trim()
        // 일부 브라우저는 긴 발화를 중간에 끊으므로 문장 단위, 최대 180자로 나눠 읽습니다.
        while (rest.length > 180) {
          var cut = Math.max(rest.lastIndexOf('. ', 180), rest.lastIndexOf('? ', 180), rest.lastIndexOf('! ', 180))
          if (cut < 40) cut = rest.lastIndexOf(' ', 180)
          if (cut < 1) cut = 180
          pieces.push(rest.slice(0, cut + 1).trim())
          rest = rest.slice(cut + 1).trim()
        }
        if (rest) pieces.push(rest)
      })
    return pieces
  }

  // 읽던 위치에서 시작할 때는 추정 시간 대신 리더의 기준 문장을 원문에서 찾아, 그 문장부터 읽도록 조각을 자릅니다.
  function cutAtAnchor(pieces, pieceSeconds, anchor) {
    var compactAnchor = String(anchor).replace(/\s+/g, '')
    // 첫 문장이 짧으면 긴 검색어가 다음 문단까지 넘어가므로 점점 줄여 찾습니다.
    for (var length = 12; length >= 5; length -= length > 8 ? 4 : 3) {
      if (compactAnchor.length < length) continue
      var found = findAnchorPiece(pieces, pieceSeconds, compactAnchor.slice(0, length))
      if (found) return found
    }
    return null
  }

  function findAnchorPiece(pieces, pieceSeconds, key) {
    var elapsed = 0
    for (var index = 0; index < pieces.length; index += 1) {
      var piece = pieces[index]
      var compact = ''
      var positions = []
      for (var at = 0; at < piece.length; at += 1) {
        if (/\s/.test(piece[at])) continue
        compact += piece[at]
        positions.push(at)
      }
      var found = compact.indexOf(key)
      if (found >= 0) {
        var cut = positions[found]
        var skipped = (pieceSeconds[index] * cut) / (piece.length || 1)
        pieces[index] = piece.slice(cut)
        pieceSeconds[index] -= skipped
        return { index: index, elapsed: elapsed + skipped }
      }
      elapsed += pieceSeconds[index]
    }
    return null
  }

  function speakFallback(session, text, hold) {
    recordDiagnostic('device-voice', session)
    var synth = window.speechSynthesis
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
      setError(session, new Error('이 구간은 AI 음성을 만들지 못했고, 이 브라우저는 기기 음성을 지원하지 않습니다.'))
      return
    }
    var pieces = splitSpeech(text)
    var voices = typeof synth.getVoices === 'function' ? synth.getVoices() : []
    var voice =
      voices.filter(function (item) {
        return item.name === session.state.readAloudVoiceName
      })[0]
      || voices.filter(function (item) {
        return /^ko/i.test(item.lang)
      })[0]
      || null
    var token = (session.speechToken += 1)
    var part = session.parts[session.partIndex]
    var totalChars = pieces.join('').length || 1
    // 기기 음성은 재생 시간을 알 수 없어, 문장마다 글자 비율만큼 조각의 추정 길이를 나눠 진행 시간으로 씁니다.
    var pieceSeconds = pieces.map(function (piece) {
      return part ? (piece.length / totalChars) * part.duration : 0
    })
    var anchored = session.startAnchor ? cutAtAnchor(pieces, pieceSeconds, session.startAnchor) : null
    session.startAnchor = ''
    // 저장한 위치나 옮긴 위치가 조각 중간이면, 그 시간 직전에 시작하는 문장부터 읽습니다.
    var index = anchored ? anchored.index : 0
    var elapsed = anchored ? anchored.elapsed : 0
    while (
      !anchored
      && session.resumeSeconds > 0
      && index < pieces.length - 1
      && pieceSeconds[index] > 0
      && elapsed + pieceSeconds[index] <= session.resumeSeconds
    ) {
      elapsed += pieceSeconds[index]
      index += 1
    }
    var speaking = -1
    session.resumeSeconds = 0
    setDeviceVoice(session, true)
    session.fallbackElapsed = elapsed
    session.positionReady = true
    session.state.cloudAudioBusy = false
    if (hold) {
      session.speechToken += 1
      synth.cancel()
      synth.resume()
      session.state.cloudAudioActive = false
      showPlayback(session)
      updateMediaSession(session)
      setMediaPlaybackState('paused')
      updateProgress(session)
      savePosition(session, true, false)
      return
    }
    session.state.cloudAudioActive = true
    showPlayback(session)
    updateMediaSession(session)
    setMediaPlaybackState('playing')
    updateProgress(session)
    prepareNextChunk(session)
    function speakNext() {
      if (!isActive(session) || !session.fallback || token !== session.speechToken) return
      if (speaking >= 0) {
        session.fallbackElapsed += pieceSeconds[speaking]
        updateProgress(session)
      }
      if (index >= pieces.length) {
        advancePart(session)
        return
      }
      var utterance = new window.SpeechSynthesisUtterance(pieces[index])
      speaking = index
      session.fallbackSpeaking = pieces[index]
      session.fallbackPieceSeconds = pieceSeconds[index]
      index += 1
      utterance.lang = 'ko-KR'
      if (voice) utterance.voice = voice
      utterance.rate = Number(session.state.readAloudRate || 1)
      utterance.onend = speakNext
      utterance.onerror = function (event) {
        if (!isActive(session) || token !== session.speechToken) return
        if (event && (event.error === 'interrupted' || event.error === 'canceled')) return
        setError(session, new Error('기기 음성으로 읽지 못했습니다.'))
      }
      synth.speak(utterance)
    }
    synth.cancel()
    // Chrome은 일시 정지 상태가 cancel 뒤에도 남아 다음 발화가 소리 없이 멈추므로 풀어 둡니다.
    synth.resume()
    speakNext()
  }

  function advanceChunk(session) {
    if (!isActive(session)) return
    var next = nextPosition(session)
    var chapterDone = session.chunkIndex + 1 >= session.chunkCount
    savePosition(session, true, chapterDone)
    closeAudioBuffer(session)
    session.positionReady = false
    setDeviceVoice(session, false)
    if (!next) {
      session.completed = true
      endSession(
        session,
        '책의 마지막 챕터까지 들었습니다. 다시 들으려면 뷰어에서 챕터로 이동한 뒤 현재 챕터 처음부터를 눌러 주세요.'
      )
      return
    }
    if (chapterDone && sleepTimer.mode === 'chapter') {
      sleepNow(session, '챕터를 끝까지 들어 잠자기 타이머로 멈췄습니다. 이어 듣기로 다음 챕터부터 들을 수 있습니다.')
      return
    }
    // 새 챕터의 첫 저장은 이전 완료 기록을 덮어써야 하므로 처음부터 듣는 것으로 표시합니다.
    if (next.sectionIndex !== session.sectionIndex) session.restartPending = true
    session.sectionIndex = next.sectionIndex
    session.chunkIndex = next.chunkIndex
    session.resumeSeconds = 0
    // 미리 받지 못한 구간도 그사이 백그라운드 생성이 끝났을 수 있어 한 번 더 조회합니다.
    var prepared = session.nextChunk
      ? session.nextChunk.then(function (result) {
          // 미리 받을 때 생성 전이던 조각이 그사이 만들어졌을 수 있어, 생성 전 조각이 있으면 한 번 더 받습니다.
          var stale =
            !result.error
            && result.value.parts.some(function (part) {
              return part.pending
            })
          return result.error || stale
            ? loadChunkRetrying(session, next.sectionIndex, next.chunkIndex, 2)
            : result.value
        })
      : null
    playChunk(session, prepared)
  }

  /**
   * 마지막 청취 위치 또는 현재 챕터의 처음부터 AI 낭독을 시작합니다.
   * @param {any} state 리더 UI 상태
   * @param {number} chapterIndex 현재 EPUB spine 순서
   * @param {boolean} [fromBeginning] 저장된 청취 위치 대신 현재 챕터에서 시작할지 여부
   * @param {string} [anchorText] 이 문장이 들어 있는 구간부터 시작할 때의 리더 기준 문장
   * @returns {void}
   */
  function start(state, chapterIndex, fromBeginning, anchorText) {
    if (
      !fromBeginning
      && activeSession
      && activeSession.positionReady
      && !activeSession.failed
      && !activeSession.completed
      && !activeSession.fallback
    ) {
      playAudio(activeSession)
      return
    }
    stop()
    var player = document.getElementById('reader-cloud-audio')
    if (!player) return
    var session = {
      state: state,
      player: player,
      sectionIndex: chapterIndex,
      chunkIndex: 0,
      chunkCount: 0,
      configHash: '',
      chunkId: '',
      parts: [],
      partIndex: 0,
      partOffset: 0,
      timeline: [],
      loadToken: 0,
      speechToken: 0,
      fallbackElapsed: 0,
      resumeSeconds: 0,
      positionReady: false,
      failed: false,
      completed: false,
      controller: new AbortController(),
      objectUrl: '',
      nextChunk: null,
      nextSectionIndex: -1,
      previousSectionIndex: -1,
      prefetchedKey: '',
      startAnchor: '',
      holdPaused: false,
      saveWhenReady: false,
      fallback: false,
      cacheUnavailable: false,
      lastSavedAt: 0,
      syncFailed: false,
      restartPending: !!fromBeginning,
    }
    activeSession = session
    session.diagnosticsId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
    recordDiagnostic('session-start', session, { fromBeginning: !!fromBeginning })
    state.cloudAudioBusy = true
    state.cloudAudioSession = true
    state.cloudAudioMessage = ''
    player.onloadedmetadata = function () {
      if (!isActive(session)) return
      if (session.stream) return
      if (session.resumeSeconds > 0 && isFinite(player.duration)) {
        player.currentTime = Math.min(session.resumeSeconds, Math.max(0, player.duration - 0.1))
      }
      session.resumeSeconds = 0
      session.positionReady = true
      updateProgress(session)
      if (session.saveWhenReady) {
        session.saveWhenReady = false
        savePosition(session, true, false)
      }
    }
    player.ontimeupdate = function () {
      if (!isActive(session)) return
      syncBufferedPosition(session)
      if (!isActive(session)) return
      if (Date.now() - diagnosticsLastProgress >= 30000) {
        diagnosticsLastProgress = Date.now()
        recordDiagnostic('progress', session)
      }
      updateProgress(session)
      savePosition(session, false, false)
      pumpAudioBuffer(session)
    }
    player.onplay = function () {
      if (!isActive(session)) return
      recordDiagnostic('play', session)
      setMediaPlaybackState('playing')
      updateProgress(session)
      state.cloudAudioActive = true
      showPlayback(session)
      savePosition(session, true, false)
      prepareNextChunk(session)
    }
    player.onpause = function () {
      syncBufferedPosition(session)
      recordDiagnostic('pause', session)
      // 기기 음성 조각으로 넘어갈 때 플레이어를 멈춘 이벤트가 늦게 와도 재생 중 표시를 지우지 않습니다.
      if (!isActive(session) || session.fallback) return
      setMediaPlaybackState('paused')
      state.cloudAudioActive = false
      savePosition(session, true, false)
    }
    player.onerror = function () {
      recordDiagnostic('media-error', session, {
        code: player.error ? player.error.code : 0,
        message: String((player.error && player.error.message) || '').slice(0, 200),
      })
      if (session.stream) {
        useFilePlayback(session, session.stream, new Error('MediaSource playback failed'))
        return
      }
      setError(session, new Error('오디오를 재생하지 못했습니다.'))
    }
    player.onended = function () {
      syncBufferedPosition(session)
      if (!isActive(session)) return
      recordDiagnostic('ended', session)
      // 미리 받기에 실패한 다음 구간도 그사이 연결이 돌아왔을 수 있어, 경계에서 한 번 더 받아 봅니다.
      advancePart(session)
    }
    bindMediaSession(session)
    progressQueue
      .then(flushPendingSaves)
      .catch(function () {
        // 보관한 위치를 아직 보내지 못해도 재생은 시작하고, 다음 저장 때 다시 보냅니다.
        session.syncFailed = true
      })
      .then(function () {
        if (!isActive(session)) throw new DOMException('Playback stopped', 'AbortError')
        var query = new URLSearchParams({ bookId: config.bookId, fileId: config.bookFileId })
        return fetch('/api/books/audio-progress?' + query.toString(), {
          cache: 'no-store',
          signal: session.controller.signal,
        }).then(readJson)
      })
      .then(function (result) {
        if (!isActive(session)) return
        session.configHash = result.configHash
        if (!fromBeginning && result.progress) {
          session.sectionIndex = result.progress.sectionIndex
          session.chunkIndex = result.progress.chunkIndex
          session.resumeSeconds = result.progress.seconds
          if (result.progress.startsNextSection) session.restartPending = true
          if (result.progress.isCompleted) {
            session.completed = true
            endSession(
              session,
              '책의 마지막 챕터까지 모두 들었습니다. 다시 들으려면 뷰어에서 챕터로 이동한 뒤 현재 챕터 처음부터를 눌러 주세요.'
            )
            return
          }
        }
        if (!anchorText) return playChunk(session)
        var position = new URLSearchParams({
          bookId: config.bookId,
          fileId: config.bookFileId,
          sectionIndex: String(session.sectionIndex),
          anchor: anchorText,
        })
        return fetch('/api/books/audio-position?' + position.toString(), {
          cache: 'no-store',
          signal: session.controller.signal,
        })
          .then(readJson)
          .then(function (located) {
            if (!isActive(session)) return
            var requestedSection = session.sectionIndex
            session.chunkIndex = located.chunkIndex >= 0 ? located.chunkIndex : 0
            session.resumeSeconds = located.chunkIndex >= 0 ? Number(located.seconds) || 0 : 0
            session.startAnchor = located.chunkIndex >= 0 ? anchorText : ''
            return playChunk(session).then(function () {
              if (!isActive(session) || located.chunkIndex >= 0 || session.failed) return
              state.cloudAudioMessage =
                session.sectionIndex !== requestedSection
                  ? '이 페이지는 낭독하지 않는 부분이라 다음 본문 챕터부터 재생합니다.'
                  : '읽던 위치를 찾지 못해 챕터 처음부터 재생합니다.'
            })
          })
      })
      .catch(function (error) {
        setError(session, error)
      })
  }

  /**
   * AI 낭독을 멈추고 진행 위치를 서버에 보관합니다.
   * @returns {void}
   */
  function stop() {
    var session = activeSession
    if (!session) return
    syncBufferedPosition(session)
    if (!isActive(session)) return
    recordDiagnostic('stop', session)
    savePosition(session, true, false)
    activeSession = null
    closeAudioBuffer(session)
    session.controller.abort()
    if (session.fallback && window.speechSynthesis) {
      window.speechSynthesis.cancel()
      // 일시 정지한 채 멈추면 Chrome은 그 상태가 남아 리더의 기기 읽어주기가 소리 없이 멈춥니다.
      window.speechSynthesis.resume()
    }
    setDeviceVoice(session, false)
    var player = session.player
    player.onpause = null
    player.onended = null
    player.ontimeupdate = null
    player.onloadedmetadata = null
    player.onplay = null
    player.onerror = null
    clearMediaSession()
    player.pause()
    player.removeAttribute('src')
    player.load()
    if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
    session.state.cloudAudioBusy = false
    session.state.cloudAudioActive = false
    session.state.cloudAudioMessage = ''
    session.state.cloudAudioSeeking = false
    session.state.cloudAudioPosition = 0
    session.state.cloudAudioDuration = 0
    session.state.cloudAudioHasPrevious = false
    session.state.cloudAudioHasNext = false
    session.state.cloudAudioChapter = ''
    session.state.cloudAudioChapterOrder = ''
    session.state.cloudAudioDetail = ''
    session.state.cloudAudioSession = false
    clearSleepTimer(session.state)
  }

  window.addEventListener('pagehide', function (event) {
    recordDiagnostic('pagehide', activeSession, { persisted: !!event.persisted })
    stop()
  })
  window.addEventListener('visibilitychange', function () {
    if (activeSession) syncBufferedPosition(activeSession)
    recordDiagnostic('visibilitychange', activeSession)
    if (activeSession) savePosition(activeSession, true, false)
  })
  if (diagnosticsAvailable) {
    // 백그라운드에서 버려졌다 다시 열린 페이지는 기록이 꺼진 채 시작해, 이전 기록 뒤에 재시작 표시만 남깁니다.
    if (diagnostics.length) {
      recordDiagnostic(
        'page-init',
        null,
        { wasDiscarded: !!document.wasDiscarded, previousEvent: diagnostics[diagnostics.length - 1].event },
        true
      )
    }
    ;['freeze', 'resume'].forEach(function (event) {
      document.addEventListener(event, function () {
        recordDiagnostic(event, activeSession)
      })
    })
    ;['online', 'offline', 'pageshow'].forEach(function (event) {
      window.addEventListener(event, function () {
        recordDiagnostic(event, activeSession)
      })
    })
    var diagnosticsPlayer = document.getElementById('reader-cloud-audio')
    if (diagnosticsPlayer) {
      ;[
        'playing',
        'waiting',
        'stalled',
        'suspend',
        'emptied',
        'loadedmetadata',
        'seeking',
        'seeked',
        'ratechange',
      ].forEach(function (event) {
        diagnosticsPlayer.addEventListener(event, function () {
          recordDiagnostic(event, activeSession)
        })
      })
    }
  }
  return {
    start: start,
    stop: stop,
    isPlaying: function () {
      return !!activeSession
    },
    toggle: toggle,
    seekTo: seekTo,
    seekBy: seekBy,
    moveChapter: moveChapter,
    cycleSleepTimer: cycleSleepTimer,
    preview: preview,
    currentAnchor: currentAnchor,
    formatTime: formatTime,
    exportDiagnostics: exportDiagnostics,
    copyDiagnostics: copyDiagnostics,
    toggleDiagnostics: toggleDiagnostics,
    clearDiagnostics: clearDiagnostics,
  }
})()
