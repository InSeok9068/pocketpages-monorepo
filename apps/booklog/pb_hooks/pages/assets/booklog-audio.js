window.booklogAudio = (function () {
  var config = window.booklogReaderConfig || {}
  var activeSession = null
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
        // 삭제되거나 교체된 구간의 임시 저장이 새 청취를 막지 않도록 합니다.
        return response.status === 409 ? { ok: true } : readJson(response)
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
      if (!response.ok || !result.ok) throw new Error(result.message || '오디오북 요청에 실패했습니다.')
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
        seconds: String(session.fallback ? 0 : session.player.currentTime || 0),
        isCompleted: String(!!completed),
        restart: String(session.restartPending),
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
            '청취 위치를 임시 보관했습니다. 재생 중 또는 다음 이어 듣기에서 다시 동기화합니다.'
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
      .then(readJson)
      .then(function (result) {
        if (!isActive(session)) throw new DOMException('Playback stopped', 'AbortError')
        if (result.configHash !== session.configHash)
          throw new Error('낭독 설정이 바뀌었습니다. 다시 이어 듣기를 시작해 주세요.')
        if (!Number.isInteger(result.chunkCount) || result.chunkCount <= index || !result.chunkId) {
          throw new Error('낭독 구간 정보를 확인하지 못했습니다.')
        }
        if (result.fallbackText) {
          return {
            fallbackText: result.fallbackText,
            count: result.chunkCount,
            chunkId: result.chunkId,
            nextSectionIndex: Number.isInteger(result.nextSectionIndex) ? result.nextSectionIndex : -1,
          }
        }
        var url = new URL(
          '/_booklog-audio-cache/' + encodeURIComponent(config.readerCacheKey + ':' + result.audioUrl),
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
          )
            .then(function (cached) {
              if (cached) return cached.blob()
              if (!isActive(session)) throw new DOMException('Playback stopped', 'AbortError')
              return fetch(result.audioUrl, { signal: session.controller.signal })
                .then(function (response) {
                  if (!response.ok) throw new Error('저장된 음성을 내려받지 못했습니다.')
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
            .then(function (blob) {
              return {
                blob: blob,
                count: result.chunkCount,
                chunkId: result.chunkId,
                nextSectionIndex: Number.isInteger(result.nextSectionIndex) ? result.nextSectionIndex : -1,
              }
            })
        })
      })
  }

  function setError(session, error) {
    if (!isActive(session) || error.name === 'AbortError') return
    session.failed = true
    session.state.cloudAudioBusy = false
    session.state.cloudAudioActive = false
    session.state.cloudAudioMessage = error.message || '음성 재생에 실패했습니다.'
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
        session.state.cloudAudioMessage = '음성이 준비됐습니다. 아래 오디오의 재생 버튼을 눌러 주세요.'
        return
      }
      setError(session, error)
    })
  }

  function playbackMessage(session) {
    var label = chapterLabel(session)
    return (
      (label ? label + ' · ' : '')
      + String(session.chunkIndex + 1)
      + ' / '
      + String(session.chunkCount)
      + (session.fallback ? ' 구간 · AI 음성을 만들지 못해 기기 음성으로 읽는 중' : ' 구간 · AI 생성 음성')
      + (session.syncFailed ? ' · 청취 위치 동기화 대기' : '')
    )
  }

  function chapterLabel(session) {
    return window.booklogReaderLogic && window.booklogReaderLogic.audioChapterLabel
      ? window.booklogReaderLogic.audioChapterLabel(session.sectionIndex)
      : ''
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
        album: 'Booklog AI 오디오북',
      })
    } catch (_error) {
      /* 메타데이터 없이 재생합니다. */
    }
  }

  function updateMediaPosition(session) {
    var mediaSession = mediaSessionApi()
    var player = session.player
    if (!mediaSession || typeof mediaSession.setPositionState !== 'function' || !isFinite(player.duration)) return
    try {
      mediaSession.setPositionState({
        duration: player.duration,
        playbackRate: player.playbackRate || 1,
        position: Math.min(player.currentTime || 0, player.duration),
      })
    } catch (_error) {
      /* 위치 표시 없이 재생합니다. */
    }
  }

  function bindMediaSession(session) {
    var mediaSession = mediaSessionApi()
    if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return
    var player = session.player
    var handlers = {
      play: function () {
        if (!isActive(session)) return
        if (session.fallback && window.speechSynthesis) {
          window.speechSynthesis.resume()
          setMediaPlaybackState('playing')
          return
        }
        playAudio(session)
      },
      pause: function () {
        if (!isActive(session)) return
        if (session.fallback && window.speechSynthesis) {
          window.speechSynthesis.pause()
          setMediaPlaybackState('paused')
          return
        }
        player.pause()
      },
      stop: function () {
        if (isActive(session)) stop()
      },
      seekbackward: function (details) {
        if (!isActive(session)) return
        player.currentTime = Math.max(0, player.currentTime - ((details && details.seekOffset) || 15))
      },
      seekforward: function (details) {
        if (!isActive(session) || !isFinite(player.duration)) return
        player.currentTime = Math.min(
          Math.max(0, player.duration - 0.1),
          player.currentTime + ((details && details.seekOffset) || 15)
        )
      },
      seekto: function (details) {
        if (!isActive(session) || !details || typeof details.seekTime !== 'number') return
        player.currentTime = details.seekTime
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
    ;['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto'].forEach(function (action) {
      try {
        mediaSession.setActionHandler(action, null)
      } catch (_error) {
        /* 지원하지 않는 동작은 건너뜁니다. */
      }
    })
    setMediaPlaybackState('none')
  }

  function playChunk(session, prepared) {
    session.positionReady = false
    session.failed = false
    session.state.cloudAudioBusy = true
    session.state.cloudAudioMessage = '저장된 AI 오디오북을 불러오고 있습니다.'
    return (prepared || loadChunk(session, session.sectionIndex, session.chunkIndex))
      .then(function (result) {
        if (!isActive(session)) return
        session.chunkCount = result.count
        session.chunkId = result.chunkId
        session.nextSectionIndex = result.nextSectionIndex
        session.nextChunk = null
        session.prefetchedKey = ''
        if (result.fallbackText) return speakFallback(session, result.fallbackText)
        if (session.objectUrl) URL.revokeObjectURL(session.objectUrl)
        session.objectUrl = URL.createObjectURL(result.blob)
        session.player.src = session.objectUrl
        session.player.playbackRate = Number(session.state.readAloudRate || 1)
        session.state.cloudAudioBusy = false
        session.state.cloudAudioMessage = playbackMessage(session)
        updateMediaSession(session)
        return playAudio(session)
      })
      .catch(function (error) {
        setError(session, error)
      })
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
    var index = 0
    session.fallback = true
    session.positionReady = true
    session.state.cloudAudioBusy = false
    session.state.cloudAudioActive = true
    session.state.cloudAudioMessage = playbackMessage(session)
    updateMediaSession(session)
    setMediaPlaybackState('playing')
    prepareNextChunk(session)
    function speakNext() {
      if (!isActive(session) || !session.fallback) return
      if (index >= pieces.length) {
        advanceChunk(session)
        return
      }
      var utterance = new window.SpeechSynthesisUtterance(pieces[index])
      index += 1
      utterance.lang = 'ko-KR'
      if (voice) utterance.voice = voice
      utterance.rate = Number(session.state.readAloudRate || 1)
      utterance.onend = speakNext
      utterance.onerror = function (event) {
        if (!isActive(session) || (event && (event.error === 'interrupted' || event.error === 'canceled'))) return
        setError(session, new Error('기기 음성으로 읽지 못했습니다.'))
      }
      synth.speak(utterance)
    }
    synth.cancel()
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
      session.state.cloudAudioActive = false
      session.state.cloudAudioMessage = '책의 마지막 챕터까지 들었습니다. 완료 기록을 동기화하고 있습니다.'
      progressQueue.then(function () {
        if (!isActive(session)) return
        session.state.cloudAudioMessage = session.syncFailed
          ? '마지막 챕터까지 들었습니다. 서버에 연결되면 다음 이어 듣기에서 완료 기록을 동기화합니다.'
          : '책의 마지막 챕터까지 들었습니다. 완료 기록을 저장했습니다.'
      })
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
          return result.error ? loadChunk(session, next.sectionIndex, next.chunkIndex) : result.value
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
      resumeSeconds: 0,
      positionReady: false,
      failed: false,
      completed: false,
      controller: new AbortController(),
      objectUrl: '',
      nextChunk: null,
      nextSectionIndex: -1,
      prefetchedKey: '',
      fallback: false,
      cacheUnavailable: false,
      lastSavedAt: 0,
      syncFailed: false,
      restartPending: !!fromBeginning,
    }
    activeSession = session
    state.cloudAudioBusy = true
    state.cloudAudioMessage = '서버에서 마지막 청취 위치를 불러오고 있습니다.'
    player.onloadedmetadata = function () {
      if (!isActive(session)) return
      if (session.resumeSeconds > 0 && isFinite(player.duration)) {
        player.currentTime = Math.min(session.resumeSeconds, Math.max(0, player.duration - 0.1))
      }
      session.resumeSeconds = 0
      session.positionReady = true
      updateMediaPosition(session)
    }
    player.ontimeupdate = function () {
      savePosition(session, false, false)
    }
    player.onplay = function () {
      if (!isActive(session)) return
      setMediaPlaybackState('playing')
      updateMediaPosition(session)
      state.cloudAudioActive = true
      state.cloudAudioMessage = playbackMessage(session)
      savePosition(session, true, false)
      prepareNextChunk(session)
    }
    player.onpause = function () {
      if (!isActive(session)) return
      setMediaPlaybackState('paused')
      state.cloudAudioActive = false
      savePosition(session, true, false)
    }
    player.onerror = function () {
      setError(session, new Error('오디오를 재생하지 못했습니다.'))
    }
    player.onended = function () {
      advanceChunk(session)
    }
    bindMediaSession(session)
    progressQueue
      .then(flushPendingSaves)
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
            state.cloudAudioBusy = false
            state.cloudAudioMessage =
              '책의 마지막 챕터까지 모두 들었습니다. 현재 챕터 처음부터 버튼으로 다시 들을 수 있습니다.'
            return
          }
        }
        if (!anchorText) return playChunk(session)
        state.cloudAudioMessage = '읽던 위치의 음성 구간을 찾고 있습니다.'
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
            session.chunkIndex = located.chunkIndex >= 0 ? located.chunkIndex : 0
            return playChunk(session).then(function () {
              if (isActive(session) && located.chunkIndex < 0 && !session.failed) {
                state.cloudAudioMessage = '읽던 위치를 찾지 못해 챕터 처음부터 재생합니다. ' + playbackMessage(session)
              }
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
    if (session.fallback && window.speechSynthesis) window.speechSynthesis.cancel()
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
  }

  window.addEventListener('pagehide', stop)
  window.addEventListener('visibilitychange', function () {
    if (activeSession) savePosition(activeSession, true, false)
  })
  return { start: start, stop: stop }
})()
