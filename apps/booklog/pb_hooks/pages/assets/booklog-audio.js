window.booklogAudio = (function () {
  var config = window.booklogReaderConfig || {}
  var activeSession = null
  var previewRequest = null
  var progressQueue = Promise.resolve()
  var CACHE_NAME = 'booklog-audio-v3'
  var CACHE_LIMIT = 16
  var SAVE_INTERVAL_MS = 15000
  var outboxKey = 'booklog-audio-pending:' + config.readerCacheKey
  var pendingSaves = {}
  var saveSequence = 0
  try {
    pendingSaves = JSON.parse(localStorage.getItem(outboxKey) || '{}') || {}
  } catch (_error) {
    /* 저장 없이 동기화합니다. */
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
        seconds: String(
          session.partOffset + (session.fallback ? session.fallbackElapsed : session.player.currentTime || 0)
        ),
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
    return fetch('/api/books/audio-chunk?' + query.toString(), { cache: 'no-store', signal: session.controller.signal })
      .then(function (response) {
        return response.json().then(function (result) {
          if (response.ok && result.ok) return result
          // 표지·이미지 페이지처럼 본문이 없는 곳에서 시작하면 뒤쪽 첫 본문 챕터부터 재생합니다.
          if (result.reason === 'no-text' && index === 0 && result.nextSectionIndex > sectionIndex) {
            return loadChunk(session, result.nextSectionIndex, 0).then(function (moved) {
              return { moved: moved }
            })
          }
          throw new Error(result.message || '오디오북 요청에 실패했습니다.')
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
              return { blob: blob, text: text, duration: Number(part.durationSeconds) || 0 }
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
      var network = error && (error.name === 'TypeError' || error.name === 'SyntaxError')
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
        if (cached) return cached.blob()
        if (!isActive(session)) throw new DOMException('Playback stopped', 'AbortError')
        return fetch(audioUrl, { signal: session.controller.signal })
          .then(function (response) {
            if (!response.ok) throw new Error('음성을 내려받지 못했습니다. 인터넷 연결을 확인해 주세요.')
            return response.blob()
          })
          .then(function (blob) {
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
    session.failed = true
    endSession(session, error.message || '음성을 재생하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  }

  // 재생이 끝나거나 막히면 시작 화면으로 돌아가, 이유와 함께 이어 들을 위치를 보여줍니다.
  function endSession(session, message) {
    if (!isActive(session)) return
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

  function playAudio(session) {
    return session.player.play().catch(function (error) {
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

  function resumeLabel(progress) {
    if (!progress) return '처음 듣는 책 · 현재 챕터 처음부터'
    if (progress.isCompleted) return '마지막 챕터까지 모두 들었습니다'
    var label = chapterLabelAt(progress.sectionIndex)
    if (progress.startsNextSection) return (label || '다음 챕터') + ' 처음부터'
    return (label ? label + ' · ' : '') + formatTime(progress.chapterSeconds || 0) + '부터'
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
        if (!activeSession && request === previewRequest) state.cloudAudioResumeLabel = resumeLabel(result.progress)
      })
      .catch(function () {
        if (!activeSession && request === previewRequest) state.cloudAudioResumeLabel = '마지막 청취 위치부터'
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
    var within = session.fallback ? session.fallbackElapsed : session.player.currentTime || 0
    return Math.min(
      sumUntil(session.timeline, session.chunkIndex) + session.partOffset + within,
      chapterDuration(session)
    )
  }

  function updateProgress(session) {
    if (!isActive(session)) return
    session.state.cloudAudioDuration = chapterDuration(session)
    session.state.cloudAudioHasPrevious = session.previousSectionIndex >= 0
    session.state.cloudAudioHasNext = session.nextSectionIndex >= 0
    if (!session.state.cloudAudioSeeking) session.state.cloudAudioPosition = chapterPosition(session)
    updateMediaPosition(session)
  }

  /**
   * 음성 구간이 있는 이전·다음 챕터의 처음부터 재생합니다.
   * @param {number} direction 1이면 다음 챕터, -1이면 이전 챕터
   * @returns {void}
   */
  function moveChapter(direction) {
    var session = activeSession
    if (!session || session.state.cloudAudioBusy) return
    var target = direction > 0 ? session.nextSectionIndex : session.previousSectionIndex
    if (!(target >= 0)) return
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
      session.fallback = false
      session.speechToken += 1
      window.speechSynthesis.cancel()
      window.speechSynthesis.resume()
    }
    session.player.pause()
  }

  /**
   * 현재 챕터의 재생 위치로 이동합니다. 다른 구간·조각이면 그 음성을 불러와 이어 재생합니다.
   * @param {number} seconds 챕터 처음부터의 시간(초)
   * @returns {void}
   */
  function seekTo(seconds) {
    var session = activeSession
    if (!session || session.state.cloudAudioBusy || !session.timeline.length || !session.parts.length) return
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
    if (chunkIndex !== session.chunkIndex) {
      haltCurrent(session)
      session.chunkIndex = chunkIndex
      session.resumeSeconds = within
      session.nextChunk = null
      session.prefetchedKey = ''
      playChunk(session)
      return
    }
    var partIndex = 0
    var partStart = 0
    while (partIndex < session.parts.length - 1 && within >= partStart + session.parts[partIndex].duration) {
      partStart += session.parts[partIndex].duration
      partIndex += 1
    }
    if (partIndex === session.partIndex && !session.fallback && session.positionReady) {
      session.player.currentTime = within - partStart
      updateProgress(session)
      savePosition(session, true, false)
      return
    }
    haltCurrent(session)
    session.partIndex = partIndex
    session.partOffset = partStart
    session.resumeSeconds = within - partStart
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
    var elapsed = session.fallback ? session.fallbackElapsed : session.player.currentTime || 0
    var ratio = part.duration > 0 ? Math.min(1, elapsed / part.duration) : 0
    var text = part.text
    var offset = Math.floor(ratio * text.length)
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
    // 다른 구간을 불러오는 중에는 이전 음성이 다시 재생되지 않도록 잠금화면 재생 요청도 무시합니다.
    if (session.state.cloudAudioBusy) return true
    if (session.fallback && window.speechSynthesis) {
      if (session.state.cloudAudioActive) {
        window.speechSynthesis.pause()
        session.state.cloudAudioActive = false
        setMediaPlaybackState('paused')
        savePosition(session, true, false)
      } else {
        window.speechSynthesis.resume()
        session.state.cloudAudioActive = true
        setMediaPlaybackState('playing')
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
        mediaSession.setActionHandler(action, handlers[action])
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
        session.partIndex = 0
        session.partOffset = 0
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
        if (token === session.loadToken) setError(session, error)
      })
  }

  function playPart(session) {
    var part = session.parts[session.partIndex]
    session.fallback = false
    if (part.fallbackText) return speakFallback(session, part.fallbackText)
    session.startAnchor = ''
    session.positionReady = false
    if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
    session.objectUrl = URL.createObjectURL(part.blob)
    session.player.src = session.objectUrl
    session.player.playbackRate = Number(session.state.readAloudRate || 1)
    session.state.cloudAudioBusy = false
    showPlayback(session)
    updateMediaSession(session)
    updateProgress(session)
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

  function speakFallback(session, text) {
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
    session.fallback = true
    session.fallbackElapsed = elapsed
    session.positionReady = true
    session.state.cloudAudioBusy = false
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
    session.positionReady = false
    session.fallback = false
    if (!next) {
      session.completed = true
      endSession(
        session,
        '책의 마지막 챕터까지 들었습니다. 다시 들으려면 뷰어에서 챕터로 이동한 뒤 현재 챕터 처음부터를 눌러 주세요.'
      )
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
      fallback: false,
      cacheUnavailable: false,
      lastSavedAt: 0,
      syncFailed: false,
      restartPending: !!fromBeginning,
    }
    activeSession = session
    state.cloudAudioBusy = true
    state.cloudAudioSession = true
    state.cloudAudioMessage = ''
    player.onloadedmetadata = function () {
      if (!isActive(session)) return
      if (session.resumeSeconds > 0 && isFinite(player.duration)) {
        player.currentTime = Math.min(session.resumeSeconds, Math.max(0, player.duration - 0.1))
      }
      session.resumeSeconds = 0
      session.positionReady = true
      updateProgress(session)
    }
    player.ontimeupdate = function () {
      updateProgress(session)
      savePosition(session, false, false)
    }
    player.onplay = function () {
      if (!isActive(session)) return
      setMediaPlaybackState('playing')
      updateProgress(session)
      state.cloudAudioActive = true
      showPlayback(session)
      savePosition(session, true, false)
      prepareNextChunk(session)
    }
    player.onpause = function () {
      // 기기 음성 조각으로 넘어갈 때 플레이어를 멈춘 이벤트가 늦게 와도 재생 중 표시를 지우지 않습니다.
      if (!isActive(session) || session.fallback) return
      setMediaPlaybackState('paused')
      state.cloudAudioActive = false
      savePosition(session, true, false)
    }
    player.onerror = function () {
      setError(session, new Error('오디오를 재생하지 못했습니다.'))
    }
    player.onended = function () {
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
    savePosition(session, true, false)
    activeSession = null
    session.controller.abort()
    if (session.fallback && window.speechSynthesis) {
      window.speechSynthesis.cancel()
      // 일시 정지한 채 멈추면 Chrome은 그 상태가 남아 리더의 기기 읽어주기가 소리 없이 멈춥니다.
      window.speechSynthesis.resume()
    }
    session.fallback = false
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
  }

  window.addEventListener('pagehide', stop)
  window.addEventListener('visibilitychange', function () {
    if (activeSession) savePosition(activeSession, true, false)
  })
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
    preview: preview,
    currentAnchor: currentAnchor,
    formatTime: formatTime,
  }
})()
