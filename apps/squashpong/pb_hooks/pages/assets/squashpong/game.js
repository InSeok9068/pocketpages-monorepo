;(function () {
  const rules = window.SquashpongRules
  const WORLD = rules.WORLD
  const CHARACTERS = rules.CHARACTERS
  const CHARACTER_BY_ID = CHARACTERS.reduce((acc, character) => {
    acc[character.id] = character
    return acc
  }, {})
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
  const TICK_SEND_MS = 33
  const CANDIDATE_POLL_MS = 700
  const ANSWER_POLL_MS = 900

  const elements = {
    lobbyScreen: document.getElementById('lobby-screen'),
    roomScreen: document.getElementById('room-screen'),
    gameScreen: document.getElementById('game-screen'),
    canvas: document.getElementById('game-canvas'),
    banner: document.getElementById('connection-banner'),
    soloPlay: document.getElementById('solo-play'),
    createRoom: document.getElementById('create-room'),
    joinRoom: document.getElementById('join-room'),
    copyLink: document.getElementById('copy-link'),
    leaveGame: document.getElementById('leave-game'),
    roomCode: document.getElementById('room-code'),
    roomCodeDisplay: document.getElementById('room-code-display'),
    roleLabel: document.getElementById('role-label'),
    peerLabel: document.getElementById('peer-label'),
    scoreLabel: document.getElementById('score-label'),
    rallyLabel: document.getElementById('rally-label'),
    turnLabel: document.getElementById('turn-label'),
    characterList: document.getElementById('character-list'),
  }
  const ctx = elements.canvas.getContext('2d')

  const runtime = {
    screen: 'lobby',
    role: '',
    roomCode: '',
    peer: null,
    channel: null,
    mode: '',
    connected: false,
    localCharacter: getSelectedCharacter(),
    aiSwingCooldown: 0,
    lastTime: 0,
    lastSentAt: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    pixelRatio: 1,
    pointerControl: {
      active: false,
      pointerId: 0,
      targetX: 0,
      targetY: 0,
      screenX: 0,
      screenY: 0,
      shotType: 'drive',
      shotSide: 1,
      history: [],
    },
    answerPoll: 0,
    candidatePoll: 0,
    seenCandidates: {},
    localInput: createInput(),
    remoteInput: createInput(),
    state: rules.createInitialState({}),
  }

  /**
   * 새 입력 상태를 만든다.
   * @returns {{ up: boolean, down: boolean, left: boolean, right: boolean, swingId: number, shotType: 'drive' | 'drop' | 'boast', shotSide: -1 | 1 }}
   */
  function createInput() {
    return {
      up: false,
      down: false,
      left: false,
      right: false,
      swingId: 0,
      shotType: 'drive',
      shotSide: 1,
    }
  }

  /**
   * 현재 선택된 캐릭터를 반환한다.
   * @returns {string}
   */
  function getSelectedCharacter() {
    const checked = document.querySelector('input[name="character"]:checked')
    return rules.normalizeCharacter(checked ? checked.value : 'lime')
  }

  /**
   * 캐릭터 선택 UI를 갱신한다.
   */
  function syncCharacterOptions() {
    document.querySelectorAll('.character-option').forEach((option) => {
      const input = option.querySelector('input')
      option.classList.toggle('is-selected', Boolean(input && input.checked))
    })
  }

  /**
   * 방 코드를 정규화한다.
   * @param {string} value
   * @returns {string}
   */
  function normalizeRoomCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
  }

  /**
   * 값을 범위 안으로 제한한다.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  const COURT_VIEW = {
    frontTopY: 70,
    floorTopY: 560,
    floorBackY: 916,
    frontLeftX: 134,
    frontRightX: 406,
    floorFrontLeftX: 124,
    floorFrontRightX: 416,
    floorBackLeftX: 22,
    floorBackRightX: 518,
  }

  /**
   * 두 값 사이를 보간한다.
   * @param {number} start
   * @param {number} end
   * @param {number} amount
   * @returns {number}
   */
  function lerp(start, end, amount) {
    return start + (end - start) * amount
  }

  /**
   * 코트 안 깊이 비율을 반환한다.
   * @param {number} y
   * @returns {number}
   */
  function getCourtDepth(y) {
    return clamp((y - WORLD.frontWallY) / (WORLD.backWallY - WORLD.frontWallY), 0, 1)
  }

  /**
   * 바닥의 원근 좌표를 반환한다.
   * @param {number} x
   * @param {number} y
   * @returns {{ x: number, y: number, scale: number, depth: number }}
   */
  function projectCourtPoint(x, y) {
    const depth = getCourtDepth(y)
    const left = lerp(COURT_VIEW.floorFrontLeftX, COURT_VIEW.floorBackLeftX, depth)
    const right = lerp(COURT_VIEW.floorFrontRightX, COURT_VIEW.floorBackRightX, depth)
    const normalizedX = clamp((x - WORLD.leftX) / (WORLD.rightX - WORLD.leftX), 0, 1)

    return {
      x: lerp(left, right, normalizedX),
      y: lerp(COURT_VIEW.floorTopY, COURT_VIEW.floorBackY, depth),
      scale: lerp(0.58, 1.12, depth),
      depth,
    }
  }

  /**
   * 바닥 위 원근 좌표를 반환한다.
   * @param {number} normalizedX
   * @param {number} depth
   * @returns {{ x: number, y: number }}
   */
  function projectFloorLocal(normalizedX, depth) {
    const left = lerp(COURT_VIEW.floorFrontLeftX, COURT_VIEW.floorBackLeftX, depth)
    const right = lerp(COURT_VIEW.floorFrontRightX, COURT_VIEW.floorBackRightX, depth)

    return {
      x: lerp(left, right, normalizedX),
      y: lerp(COURT_VIEW.floorTopY, COURT_VIEW.floorBackY, depth),
    }
  }

  /**
   * 점 목록으로 다각형을 그린다.
   * @param {Array<{ x: number, y: number }>} points
   */
  function drawPolygon(points) {
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)

    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y)
    }

    ctx.closePath()
  }

  /**
   * 상태 문구를 갱신한다.
   * @param {string} message
   */
  function setBanner(message) {
    elements.banner.textContent = message
  }

  /**
   * 현재 보이는 화면을 바꾼다.
   * @param {'lobby' | 'room' | 'game'} screen
   */
  function setScreen(screen) {
    runtime.screen = screen
    document.body.dataset.screen = screen
    elements.lobbyScreen.hidden = screen !== 'lobby'
    elements.roomScreen.hidden = screen !== 'room'
    elements.gameScreen.hidden = screen !== 'game'

    if (screen === 'game') {
      elements.canvas.focus()
    }
  }

  /**
   * 대기 화면의 방 코드를 갱신한다.
   */
  function syncRoomCodeDisplay() {
    elements.roomCodeDisplay.textContent = runtime.roomCode || '------'
  }

  /**
   * 연결 상태 표시를 갱신한다.
   */
  function syncLabels() {
    const active = runtime.state.active === 'host' ? 'Host' : 'Guest'

    syncRoomCodeDisplay()
    elements.roleLabel.textContent = runtime.role ? (runtime.role === 'host' ? 'Host' : 'Guest') : '대기'
    elements.peerLabel.textContent = runtime.mode === 'solo' ? '컴퓨터' : runtime.connected ? '연결됨' : '끊김'
    elements.scoreLabel.textContent = `${runtime.state.hostScore} : ${runtime.state.guestScore}`
    elements.rallyLabel.textContent = String(runtime.state.rally)
    elements.turnLabel.textContent = runtime.role ? `${active} ${runtime.state.awaitingServe ? '서브' : '차례'}` : '대기'
  }

  /**
   * API 요청을 보낸다.
   * @param {string} path
   * @param {Record<string, any>} options
   * @returns {Promise<any>}
   */
  async function requestJson(path, options) {
    const response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
      },
      ...options,
    })
    const payload = await response.json()

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Request failed.')
    }

    return payload
  }

  /**
   * 방별 API 경로를 만든다.
   * @param {string} suffix
   * @returns {string}
   */
  function roomPath(suffix) {
    return `/api/rooms/${encodeURIComponent(runtime.roomCode)}${suffix}`
  }

  /**
   * 기존 연결을 닫는다.
   */
  function closePeer() {
    if (runtime.answerPoll) {
      clearInterval(runtime.answerPoll)
      runtime.answerPoll = 0
    }

    if (runtime.candidatePoll) {
      clearInterval(runtime.candidatePoll)
      runtime.candidatePoll = 0
    }

    if (runtime.channel) {
      runtime.channel.close()
      runtime.channel = null
    }

    if (runtime.peer) {
      runtime.peer.close()
      runtime.peer = null
    }

    runtime.connected = false
    runtime.mode = ''
    runtime.seenCandidates = {}
    resetPointerControl()
    stopLocalMove()
    syncLabels()
  }

  /**
   * PeerConnection을 만든다.
   * @returns {RTCPeerConnection}
   */
  function createPeer() {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    peer.onicecandidate = (event) => {
      if (!event.candidate) {
        return
      }

      postCandidate(event.candidate).catch((exception) => {
        setBanner(`ICE candidate 전송 실패: ${exception.message}`)
      })
    }

    peer.onconnectionstatechange = () => {
      runtime.connected = peer.connectionState === 'connected'
      syncLabels()

      if (peer.connectionState === 'connected') {
        setBanner('P2P 연결 완료')
        setScreen('game')
      } else if (peer.connectionState === 'failed') {
        setBanner('P2P 연결 실패')
      }
    }

    return peer
  }

  /**
   * DataChannel을 설정한다.
   * @param {RTCDataChannel} channel
   */
  function attachChannel(channel) {
    runtime.channel = channel

    channel.onopen = () => {
      runtime.connected = true
      syncLabels()
      sendProfile()
      setBanner(runtime.role === 'host' ? 'Guest 연결됨' : 'Host 연결됨')
      setScreen('game')
    }

    channel.onclose = () => {
      runtime.connected = false
      syncLabels()
      setBanner('상대 연결 끊김')

      if (runtime.mode === 'online') {
        setScreen('room')
      }
    }

    channel.onmessage = (event) => {
      handlePeerMessage(event.data)
    }
  }

  /**
   * 선택된 프로필을 상대에게 보낸다.
   */
  function sendProfile() {
    sendPeerMessage({
      type: 'profile',
      role: runtime.role,
      character: runtime.localCharacter,
    })
  }

  /**
   * 상대 메시지를 처리한다.
   * @param {string} rawMessage
   */
  function handlePeerMessage(rawMessage) {
    let message

    try {
      message = JSON.parse(rawMessage)
    } catch (exception) {
      return
    }

    if (message.type === 'input' && runtime.role === 'host') {
      runtime.remoteInput = rules.normalizeInput(message.input || runtime.remoteInput)
      return
    }

    if (message.type === 'profile') {
      applyProfile(message.role, message.character)
      return
    }

    if (message.type === 'state' && runtime.role === 'guest') {
      runtime.state = message.state || runtime.state
      syncLabels()
    }
  }

  /**
   * 캐릭터 프로필을 게임 상태에 반영한다.
   * @param {string} role
   * @param {string} character
   */
  function applyProfile(role, character) {
    const playerKey = role === 'guest' ? 'guest' : 'host'

    runtime.state.players[playerKey].character = rules.normalizeCharacter(character)
    syncLabels()
  }

  /**
   * 상대에게 메시지를 보낸다.
   * @param {Record<string, any>} message
   */
  function sendPeerMessage(message) {
    if (!runtime.channel || runtime.channel.readyState !== 'open') {
      return
    }

    runtime.channel.send(JSON.stringify(message))
  }

  /**
   * ICE candidate를 서버에 잠깐 저장한다.
   * @param {RTCIceCandidate} candidate
   * @returns {Promise<void>}
   */
  async function postCandidate(candidate) {
    await requestJson(roomPath(`/candidates/${runtime.role}`), {
      method: 'POST',
      body: JSON.stringify({
        candidate: candidate.toJSON ? candidate.toJSON() : candidate,
      }),
    })
  }

  /**
   * 상대 ICE candidate를 가져온다.
   * @returns {Promise<void>}
   */
  async function pollCandidates() {
    if (!runtime.peer || !runtime.roomCode || !runtime.role) {
      return
    }

    const payload = await requestJson(roomPath(`/candidates/${runtime.role}`), {
      method: 'GET',
    })

    for (const candidate of payload.candidates || []) {
      const key = JSON.stringify(candidate)

      if (runtime.seenCandidates[key]) {
        continue
      }

      runtime.seenCandidates[key] = true
      await runtime.peer.addIceCandidate(candidate)
    }
  }

  /**
   * candidate polling을 시작한다.
   */
  function startCandidatePolling() {
    if (runtime.candidatePoll) {
      clearInterval(runtime.candidatePoll)
    }

    runtime.candidatePoll = setInterval(() => {
      pollCandidates().catch((exception) => {
        setBanner(`candidate 수신 실패: ${exception.message}`)
      })
    }, CANDIDATE_POLL_MS)
  }

  /**
   * 방을 만들고 Host 연결을 준비한다.
   */
  async function createRoom() {
    closePeer()
    runtime.mode = 'online'
    runtime.role = ''
    runtime.roomCode = ''
    runtime.localCharacter = getSelectedCharacter()
    setBanner('방 생성 중')
    setScreen('room')

    const payload = await requestJson('/api/rooms/create', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    runtime.role = 'host'
    runtime.roomCode = payload.room.code
    runtime.state = rules.createInitialState({
      hostCharacter: runtime.localCharacter,
    })
    elements.roomCode.value = runtime.roomCode
    syncLabels()

    runtime.peer = createPeer()
    attachChannel(runtime.peer.createDataChannel('squashpong'))

    const offer = await runtime.peer.createOffer()
    await runtime.peer.setLocalDescription(offer)
    await requestJson(roomPath('/offer'), {
      method: 'POST',
      body: JSON.stringify({
        offer: runtime.peer.localDescription,
      }),
    })

    const inviteUrl = `${location.origin}/?room=${encodeURIComponent(runtime.roomCode)}`
    history.replaceState(null, '', `/?room=${encodeURIComponent(runtime.roomCode)}`)
    setBanner(`방 ${runtime.roomCode} 대기 중`)
    startAnswerPolling()
    startCandidatePolling()

    if (navigator.clipboard) {
      navigator.clipboard.writeText(inviteUrl).catch(() => {})
    }
  }

  /**
   * Host가 answer를 기다린다.
   */
  function startAnswerPolling() {
    if (runtime.answerPoll) {
      clearInterval(runtime.answerPoll)
    }

    runtime.answerPoll = setInterval(async () => {
      if (!runtime.peer || runtime.peer.remoteDescription) {
        return
      }

      const payload = await requestJson(roomPath('/answer'), {
        method: 'GET',
      })

      if (payload.answer) {
        await runtime.peer.setRemoteDescription(payload.answer)
        clearInterval(runtime.answerPoll)
        runtime.answerPoll = 0
        setBanner('Guest 응답 수신')
      }
    }, ANSWER_POLL_MS)
  }

  /**
   * 기존 방에 Guest로 참가한다.
   */
  async function joinRoom() {
    closePeer()
    runtime.mode = 'online'
    runtime.localCharacter = getSelectedCharacter()
    runtime.roomCode = normalizeRoomCode(elements.roomCode.value || window.SQUASHPONG_ROOM_CODE)

    if (!runtime.roomCode) {
      setBanner('방 코드를 입력하세요.')
      setScreen('lobby')
      return
    }

    runtime.role = 'guest'
    runtime.state = rules.createInitialState({
      guestCharacter: runtime.localCharacter,
    })
    syncLabels()
    setBanner(`방 ${runtime.roomCode} 참가 중`)
    setScreen('room')

    const offerPayload = await requestJson(roomPath('/offer'), {
      method: 'GET',
    })

    if (!offerPayload.offer) {
      setBanner('Host 대기 중')
      return
    }

    runtime.peer = createPeer()
    runtime.peer.ondatachannel = (event) => {
      attachChannel(event.channel)
    }

    await runtime.peer.setRemoteDescription(offerPayload.offer)
    const answer = await runtime.peer.createAnswer()
    await runtime.peer.setLocalDescription(answer)
    await requestJson(roomPath('/answer'), {
      method: 'POST',
      body: JSON.stringify({
        answer: runtime.peer.localDescription,
      }),
    })

    history.replaceState(null, '', `/?room=${encodeURIComponent(runtime.roomCode)}`)
    setBanner('Host 응답 대기')
    startCandidatePolling()
  }

  /**
   * 초대 링크를 복사한다.
   */
  async function copyInviteLink() {
    const code = normalizeRoomCode(elements.roomCode.value || runtime.roomCode)

    if (!code) {
      setBanner('복사할 방 코드가 없습니다.')
      return
    }

    const inviteUrl = `${location.origin}/?room=${encodeURIComponent(code)}`
    await navigator.clipboard.writeText(inviteUrl)
    setBanner('초대 링크 복사됨')
  }

  /**
   * 컴퓨터 상대와 솔로 게임을 시작한다.
   */
  function startSoloGame() {
    closePeer()
    runtime.mode = 'solo'
    runtime.role = 'host'
    runtime.roomCode = ''
    runtime.connected = true
    runtime.localCharacter = getSelectedCharacter()
    resetPointerControl()
    runtime.localInput = createInput()
    runtime.remoteInput = createInput()
    runtime.aiSwingCooldown = 0
    runtime.state = rules.createInitialState({
      hostCharacter: runtime.localCharacter,
      guestCharacter: 'sky',
    })
    elements.roomCode.value = ''
    history.replaceState(null, '', '/')
    setBanner('솔로 플레이 시작')
    setScreen('game')
    syncLabels()
  }

  /**
   * 진행 중인 게임을 닫고 로비로 돌아간다.
   */
  function leaveGame() {
    closePeer()
    runtime.role = ''
    runtime.roomCode = ''
    resetPointerControl()
    runtime.localInput = createInput()
    runtime.remoteInput = createInput()
    runtime.state = rules.createInitialState({
      hostCharacter: runtime.localCharacter,
    })
    elements.roomCode.value = ''
    history.replaceState(null, '', '/')
    setBanner('로비로 돌아왔습니다.')
    setScreen('lobby')
    syncLabels()
  }

  /**
   * 드래그 입력을 초기화한다.
   */
  function resetPointerControl() {
    const pointerId = runtime.pointerControl.pointerId

    if (pointerId && elements.canvas.hasPointerCapture && elements.canvas.hasPointerCapture(pointerId)) {
      elements.canvas.releasePointerCapture(pointerId)
    }

    runtime.pointerControl.active = false
    runtime.pointerControl.pointerId = 0
    runtime.pointerControl.targetX = 0
    runtime.pointerControl.targetY = 0
    runtime.pointerControl.screenX = 0
    runtime.pointerControl.screenY = 0
    runtime.pointerControl.shotType = 'drive'
    runtime.pointerControl.shotSide = 1
    runtime.pointerControl.history = []
    elements.canvas.parentElement.classList.remove('is-dragging')
  }

  /**
   * 현재 플레이어를 반환한다.
   * @returns {Record<string, any> | null}
   */
  function getLocalPlayer() {
    if (!runtime.role || !runtime.state.players[runtime.role]) {
      return null
    }

    return runtime.state.players[runtime.role]
  }

  /**
   * 포인터 위치를 게임 좌표로 바꾼다.
   * @param {PointerEvent} event
   * @returns {{ x: number, y: number }}
   */
  function getWorldPoint(event) {
    const screen = getScreenPoint(event)
    const depth = clamp((screen.y - COURT_VIEW.floorTopY) / (COURT_VIEW.floorBackY - COURT_VIEW.floorTopY), 0, 1)
    const left = lerp(COURT_VIEW.floorFrontLeftX, COURT_VIEW.floorBackLeftX, depth)
    const right = lerp(COURT_VIEW.floorFrontRightX, COURT_VIEW.floorBackRightX, depth)
    const normalizedX = clamp((screen.x - left) / (right - left), 0, 1)
    const x = lerp(WORLD.leftX, WORLD.rightX, normalizedX)
    const y = lerp(WORLD.frontWallY, WORLD.backWallY, depth)

    return {
      x: clamp(x, WORLD.leftX + WORLD.playerRadius, WORLD.rightX - WORLD.playerRadius),
      y: clamp(y, WORLD.playerMinY, WORLD.backWallY - WORLD.playerRadius),
    }
  }

  /**
   * 포인터 위치를 화면 좌표로 바꾼다.
   * @param {PointerEvent} event
   * @returns {{ x: number, y: number }}
   */
  function getScreenPoint(event) {
    const rect = elements.canvas.getBoundingClientRect()
    const screenX = ((event.clientX - rect.left) / rect.width) * WORLD.width
    const screenY = ((event.clientY - rect.top) / rect.height) * WORLD.height

    return {
      x: screenX,
      y: screenY,
    }
  }

  /**
   * 마지막 손동작에서 샷 종류를 읽는다.
   * @returns {{ shotType: 'drive' | 'drop' | 'boast', shotSide: -1 | 1 }}
   */
  function detectShotFromGesture() {
    const pointer = runtime.pointerControl
    const history = pointer.history

    if (history.length < 2) {
      return {
        shotType: 'drive',
        shotSide: pointer.shotSide,
      }
    }

    const latest = history[history.length - 1]
    let previous = history[0]

    for (let index = history.length - 2; index >= 0; index -= 1) {
      if (latest.time - history[index].time >= 70) {
        previous = history[index]
        break
      }
    }

    const dx = latest.x - previous.x
    const dy = latest.y - previous.y
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)

    if (dy > 24 && absY > absX * 1.05) {
      return {
        shotType: 'drop',
        shotSide: pointer.shotSide,
      }
    }

    if (absX > 28 && absX > absY + 8) {
      return {
        shotType: 'boast',
        shotSide: dx < 0 ? -1 : 1,
      }
    }

    return {
      shotType: 'drive',
      shotSide: pointer.shotSide,
    }
  }

  /**
   * 이동 입력을 멈춘다.
   */
  function stopLocalMove() {
    runtime.localInput.left = false
    runtime.localInput.right = false
    runtime.localInput.up = false
    runtime.localInput.down = false
  }

  /**
   * 드래그 목표를 입력 방향으로 바꾼다.
   */
  function updatePointerInput() {
    const pointer = runtime.pointerControl
    const player = getLocalPlayer()

    if (!pointer.active || !player) {
      return
    }

    const tolerance = 12
    const dx = pointer.targetX - player.x
    const dy = pointer.targetY - player.y

    runtime.localInput.left = dx < -tolerance
    runtime.localInput.right = dx > tolerance
    runtime.localInput.up = dy < -tolerance
    runtime.localInput.down = dy > tolerance
  }

  /**
   * 드래그 목표 위치를 저장한다.
   * @param {PointerEvent} event
   */
  function setPointerTarget(event) {
    const point = getWorldPoint(event)
    const screen = getScreenPoint(event)
    const time = Number(event.timeStamp || Date.now())

    runtime.pointerControl.targetX = point.x
    runtime.pointerControl.targetY = point.y
    runtime.pointerControl.screenX = screen.x
    runtime.pointerControl.screenY = screen.y
    runtime.pointerControl.history.push({
      x: screen.x,
      y: screen.y,
      time,
    })
    runtime.pointerControl.history = runtime.pointerControl.history.filter((entry) => time - entry.time <= 220).slice(-8)

    const shot = detectShotFromGesture()
    runtime.pointerControl.shotType = shot.shotType
    runtime.pointerControl.shotSide = shot.shotSide
    updatePointerInput()
  }

  /**
   * 컴퓨터 입력을 갱신한다.
   * @param {number} dt
   */
  function updateAiInput(dt) {
    const input = runtime.remoteInput
    const ai = runtime.state.players.guest
    const ball = runtime.state.ball
    const host = runtime.state.players.host
    const shouldServe = runtime.state.active === 'guest' && runtime.state.awaitingServe
    const shouldChase = runtime.state.active === 'guest' && !runtime.state.awaitingFrontWall
    const targetX = shouldChase ? Math.max(WORLD.leftX + 64, Math.min(WORLD.rightX - 64, ball.x + 18)) : shouldServe ? ai.x : WORLD.width * 0.6
    const targetY = shouldChase ? Math.max(WORLD.playerMinY, Math.min(WORLD.backWallY - 64, ball.y + 18)) : shouldServe ? ai.y : WORLD.height * 0.82
    const tolerance = shouldChase ? 18 : 34
    const dx = targetX - ai.x
    const dy = targetY - ai.y
    const distance = Math.sqrt(dx * dx + dy * dy)

    input.left = dx < -tolerance
    input.right = dx > tolerance
    input.up = dy < -tolerance
    input.down = dy > tolerance

    runtime.aiSwingCooldown = Math.max(0, runtime.aiSwingCooldown - dt)

    if (shouldServe && runtime.aiSwingCooldown === 0) {
      input.shotType = 'drive'
      input.shotSide = ball.x < WORLD.width / 2 ? -1 : 1
      input.swingId += 1
      runtime.aiSwingCooldown = 0.48
    } else if (shouldChase && runtime.aiSwingCooldown === 0 && distance < WORLD.hitRadius * 0.82 && runtime.state.floorBounces <= 1) {
      if (host.y > WORLD.backWallY - 110 && runtime.state.rally % 3 === 1) {
        input.shotType = 'drop'
      } else if (runtime.state.rally % 4 === 2) {
        input.shotType = 'boast'
      } else {
        input.shotType = 'drive'
      }

      input.shotSide = ball.x < WORLD.width / 2 ? -1 : 1
      input.swingId += 1
      runtime.aiSwingCooldown = 0.32
    }
  }

  /**
   * Host 게임 상태를 한 프레임 진행한다.
   * @param {number} dt
   */
  function stepHostGame(dt) {
    if (runtime.mode === 'solo') {
      updateAiInput(dt)
    }

    rules.stepState(
      runtime.state,
      {
        host: runtime.localInput,
        guest: runtime.remoteInput,
      },
      dt
    )
    syncLabels()
  }

  /**
   * 캐릭터 색상을 찾는다.
   * @param {string} characterId
   * @returns {{ id: string, label: string, primary: string, secondary: string }}
   */
  function getCharacter(characterId) {
    return CHARACTER_BY_ID[characterId] || CHARACTER_BY_ID.lime
  }

  /**
   * 화면 크기에 맞춰 고해상도 캔버스를 준비한다.
   */
  function syncCanvasResolution() {
    const rect = elements.canvas.getBoundingClientRect()
    const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3)
    const cssWidth = Math.max(1, Math.round(rect.width || WORLD.width))
    const cssHeight = Math.max(1, Math.round(rect.height || WORLD.height))
    const width = Math.round(cssWidth * pixelRatio)
    const height = Math.round(cssHeight * pixelRatio)

    if (elements.canvas.width !== width || elements.canvas.height !== height) {
      elements.canvas.width = width
      elements.canvas.height = height
      runtime.canvasWidth = width
      runtime.canvasHeight = height
      runtime.pixelRatio = pixelRatio
    }

    ctx.setTransform(width / WORLD.width, 0, 0, height / WORLD.height, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }

  /**
   * 배경 코트를 그린다.
   */
  function drawCourt() {
    ctx.clearRect(0, 0, WORLD.width, WORLD.height)
    ctx.fillStyle = '#e7ece7'
    ctx.fillRect(0, 0, WORLD.width, WORLD.height)

    const ceilingLeft = { x: COURT_VIEW.frontLeftX - 42, y: COURT_VIEW.frontTopY - 22 }
    const ceilingRight = { x: COURT_VIEW.frontRightX + 42, y: COURT_VIEW.frontTopY - 22 }
    const frontWall = [
      { x: COURT_VIEW.frontLeftX, y: COURT_VIEW.frontTopY },
      { x: COURT_VIEW.frontRightX, y: COURT_VIEW.frontTopY },
      { x: COURT_VIEW.floorFrontRightX, y: COURT_VIEW.floorTopY },
      { x: COURT_VIEW.floorFrontLeftX, y: COURT_VIEW.floorTopY },
    ]
    const leftWall = [
      { x: 0, y: 114 },
      ceilingLeft,
      { x: COURT_VIEW.floorFrontLeftX, y: COURT_VIEW.floorTopY },
      { x: COURT_VIEW.floorBackLeftX, y: COURT_VIEW.floorBackY },
      { x: 0, y: COURT_VIEW.floorBackY + 22 },
    ]
    const rightWall = [
      ceilingRight,
      { x: WORLD.width, y: 114 },
      { x: WORLD.width, y: COURT_VIEW.floorBackY + 22 },
      { x: COURT_VIEW.floorBackRightX, y: COURT_VIEW.floorBackY },
      { x: COURT_VIEW.floorFrontRightX, y: COURT_VIEW.floorTopY },
    ]
    const floor = [
      { x: COURT_VIEW.floorFrontLeftX, y: COURT_VIEW.floorTopY },
      { x: COURT_VIEW.floorFrontRightX, y: COURT_VIEW.floorTopY },
      { x: COURT_VIEW.floorBackRightX, y: COURT_VIEW.floorBackY },
      { x: COURT_VIEW.floorBackLeftX, y: COURT_VIEW.floorBackY },
    ]

    ctx.shadowColor = 'rgba(32, 28, 20, 0.22)'
    ctx.shadowBlur = 26
    ctx.shadowOffsetY = 14
    ctx.fillStyle = 'rgba(68, 54, 38, 0.22)'
    drawPolygon([
      { x: 14, y: COURT_VIEW.frontTopY - 20 },
      { x: WORLD.width - 14, y: COURT_VIEW.frontTopY - 20 },
      { x: WORLD.width - 2, y: COURT_VIEW.floorBackY + 34 },
      { x: 2, y: COURT_VIEW.floorBackY + 34 },
    ])
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0

    const ceilingGradient = ctx.createLinearGradient(0, 0, 0, COURT_VIEW.frontTopY + 24)
    ceilingGradient.addColorStop(0, '#f6fbf8')
    ceilingGradient.addColorStop(1, '#d6dfd8')
    ctx.fillStyle = ceilingGradient
    drawPolygon([
      { x: 0, y: 0 },
      { x: WORLD.width, y: 0 },
      ceilingRight,
      ceilingLeft,
    ])
    ctx.fill()

    ctx.shadowColor = 'rgba(255, 255, 255, 0.9)'
    ctx.shadowBlur = 12
    ctx.fillStyle = '#ffffff'
    ;[
      { x: 154, y: 17, w: 42, h: 8 },
      { x: 250, y: 10, w: 40, h: 10 },
      { x: 344, y: 17, w: 42, h: 8 },
      { x: 235, y: 58, w: 70, h: 7 },
    ].forEach((light) => {
      ctx.fillRect(light.x, light.y, light.w, light.h)
    })
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0

    const leftWallGradient = ctx.createLinearGradient(0, 0, COURT_VIEW.frontLeftX + 40, 0)
    leftWallGradient.addColorStop(0, '#aab8ae')
    leftWallGradient.addColorStop(0.52, '#d9e2d8')
    leftWallGradient.addColorStop(1, '#f4f8f2')
    ctx.fillStyle = leftWallGradient
    drawPolygon(leftWall)
    ctx.fill()

    const rightWallGradient = ctx.createLinearGradient(COURT_VIEW.frontRightX - 40, 0, WORLD.width, 0)
    rightWallGradient.addColorStop(0, '#f4f8f2')
    rightWallGradient.addColorStop(0.48, '#d9e2d8')
    rightWallGradient.addColorStop(1, '#aab8ae')
    ctx.fillStyle = rightWallGradient
    drawPolygon(rightWall)
    ctx.fill()

    const wallGradient = ctx.createLinearGradient(0, COURT_VIEW.frontTopY, 0, COURT_VIEW.floorTopY)
    wallGradient.addColorStop(0, '#fffef8')
    wallGradient.addColorStop(0.48, '#f7f4e8')
    wallGradient.addColorStop(1, '#e7dfcc')
    ctx.fillStyle = wallGradient
    drawPolygon(frontWall)
    ctx.fill()

    const floorGradient = ctx.createLinearGradient(0, COURT_VIEW.floorTopY, 0, COURT_VIEW.floorBackY)
    floorGradient.addColorStop(0, '#f0dca8')
    floorGradient.addColorStop(0.54, '#dfbf7b')
    floorGradient.addColorStop(1, '#c99d55')
    ctx.fillStyle = floorGradient
    drawPolygon(floor)
    ctx.fill()

    ctx.save()
    drawPolygon(floor)
    ctx.clip()

    for (let i = 0; i < 15; i += 1) {
      const start = i / 15
      const end = (i + 1) / 15
      const frontStart = projectFloorLocal(start, 0)
      const frontEnd = projectFloorLocal(end, 0)
      const backEnd = projectFloorLocal(end, 1)
      const backStart = projectFloorLocal(start, 1)

      ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 239, 184, 0.13)' : 'rgba(111, 74, 31, 0.08)'
      drawPolygon([frontStart, frontEnd, backEnd, backStart])
      ctx.fill()
    }

    ctx.strokeStyle = 'rgba(255, 248, 226, 0.34)'
    ctx.lineWidth = 1
    for (let i = 1; i < 8; i += 1) {
      const depth = i / 8
      const left = projectFloorLocal(0.02, depth)
      const right = projectFloorLocal(0.98, depth)

      ctx.beginPath()
      ctx.moveTo(left.x, left.y)
      ctx.lineTo(right.x, right.y)
      ctx.stroke()
    }

    ctx.strokeStyle = 'rgba(127, 87, 41, 0.24)'
    ctx.lineWidth = 1
    for (let i = 1; i < 15; i += 1) {
      const front = projectFloorLocal(i / 15, 0)
      const back = projectFloorLocal(i / 15, 1)

      ctx.beginPath()
      ctx.moveTo(front.x, front.y)
      ctx.lineTo(back.x, back.y)
      ctx.stroke()
    }
    ctx.restore()

    ctx.strokeStyle = '#b12623'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(0, 139)
    ctx.lineTo(COURT_VIEW.frontLeftX, 218)
    ctx.lineTo(COURT_VIEW.frontRightX, 218)
    ctx.lineTo(WORLD.width, 139)
    ctx.stroke()

    ctx.strokeStyle = '#ba2c26'
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(COURT_VIEW.frontLeftX + 3, COURT_VIEW.floorTopY - 144)
    ctx.lineTo(COURT_VIEW.frontRightX - 3, COURT_VIEW.floorTopY - 144)
    ctx.stroke()

    ctx.strokeStyle = '#ba2c26'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(COURT_VIEW.floorFrontLeftX + 5, COURT_VIEW.floorTopY - 70)
    ctx.lineTo(COURT_VIEW.floorFrontRightX - 5, COURT_VIEW.floorTopY - 70)
    ctx.stroke()

    const serviceLeft = projectFloorLocal(0.03, 0.43)
    const serviceRight = projectFloorLocal(0.97, 0.43)
    const centerService = projectFloorLocal(0.5, 0.43)
    const centerBack = projectFloorLocal(0.5, 1)

    ctx.strokeStyle = '#b12623'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(serviceLeft.x, serviceLeft.y)
    ctx.lineTo(serviceRight.x, serviceRight.y)
    ctx.moveTo(centerService.x, centerService.y)
    ctx.lineTo(centerBack.x, centerBack.y)
    ctx.stroke()

    ;[
      [0.15, 0.43, 0.15, 0.92],
      [0.85, 0.43, 0.85, 0.92],
      [0.03, 0.92, 0.5, 0.92],
      [0.5, 0.92, 0.97, 0.92],
    ].forEach((line) => {
      const start = projectFloorLocal(line[0], line[1])
      const end = projectFloorLocal(line[2], line[3])

      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      ctx.lineTo(end.x, end.y)
      ctx.stroke()
    })

    ctx.strokeStyle = 'rgba(86, 103, 96, 0.62)'
    ctx.lineWidth = 2
    drawPolygon(frontWall)
    ctx.stroke()
    drawPolygon(leftWall)
    ctx.stroke()
    drawPolygon(rightWall)
    ctx.stroke()
    drawPolygon(floor)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(127, 149, 151, 0.58)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(COURT_VIEW.floorBackLeftX - 12, COURT_VIEW.floorBackY - 168)
    ctx.lineTo(COURT_VIEW.floorBackLeftX - 12, COURT_VIEW.floorBackY + 32)
    ctx.moveTo(COURT_VIEW.floorBackRightX + 12, COURT_VIEW.floorBackY - 168)
    ctx.lineTo(COURT_VIEW.floorBackRightX + 12, COURT_VIEW.floorBackY + 32)
    ctx.moveTo(COURT_VIEW.floorBackLeftX - 12, COURT_VIEW.floorBackY + 32)
    ctx.lineTo(COURT_VIEW.floorBackRightX + 12, COURT_VIEW.floorBackY + 32)
    ctx.stroke()

    ctx.fillStyle = 'rgba(118, 130, 112, 0.11)'
    ;[
      { x: 242, y: 298, rx: 22, ry: 7 },
      { x: 272, y: 332, rx: 14, ry: 5 },
      { x: 220, y: 363, rx: 18, ry: 6 },
      { x: 310, y: 380, rx: 10, ry: 4 },
    ].forEach((mark) => {
      ctx.beginPath()
      ctx.ellipse(mark.x, mark.y, mark.rx, mark.ry, -0.18, 0, Math.PI * 2)
      ctx.fill()
    })

    const reflection = ctx.createLinearGradient(0, COURT_VIEW.frontTopY, WORLD.width, COURT_VIEW.floorBackY)
    reflection.addColorStop(0, 'rgba(255, 255, 255, 0)')
    reflection.addColorStop(0.42, 'rgba(255, 255, 255, 0.18)')
    reflection.addColorStop(0.5, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = reflection
    drawPolygon([
      { x: 28, y: COURT_VIEW.frontTopY },
      { x: 116, y: COURT_VIEW.frontTopY },
      { x: WORLD.width - 20, y: COURT_VIEW.floorBackY },
      { x: WORLD.width - 96, y: COURT_VIEW.floorBackY },
    ])
    ctx.fill()
  }

  /**
   * 플레이어를 그린다.
   * @param {'host' | 'guest'} playerKey
   */
  function drawPlayer(playerKey) {
    const player = runtime.state.players[playerKey]
    const character = getCharacter(player.character)
    const isActive = runtime.state.active === playerKey
    const projected = projectCourtPoint(player.x, player.y)
    const racketSide = playerKey === 'host' ? 1 : -1
    const shirtColor = character.primary
    const shirtShadow = character.secondary

    ctx.save()
    ctx.translate(projected.x, projected.y)
    ctx.scale(projected.scale, projected.scale)

    ctx.fillStyle = 'rgba(50, 36, 22, 0.28)'
    ctx.beginPath()
    ctx.ellipse(3, 31, 22, 7, 0, 0, Math.PI * 2)
    ctx.fill()

    if (isActive) {
      ctx.strokeStyle = 'rgba(255, 213, 63, 0.72)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.ellipse(0, 12, 26, 34, 0, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (player.swingTimer > 0) {
      ctx.strokeStyle = 'rgba(255, 245, 180, 0.78)'
      ctx.lineWidth = 7
      ctx.beginPath()
      ctx.arc(racketSide * 3, -22, 44, -Math.PI * 0.95, -Math.PI * 0.08)
      ctx.stroke()
    }

    ctx.strokeStyle = '#2c241b'
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(racketSide * 10, -14)
    ctx.lineTo(racketSide * 31, -34)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(248, 245, 232, 0.95)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.ellipse(racketSide * 38, -42, 11, 18, racketSide * 0.35, 0, Math.PI * 2)
    ctx.stroke()

    ctx.strokeStyle = '#2d2b29'
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.moveTo(-8, 5)
    ctx.lineTo(-14, 27)
    ctx.moveTo(8, 5)
    ctx.lineTo(14, 27)
    ctx.stroke()

    ctx.fillStyle = '#f6f2e8'
    ctx.beginPath()
    ctx.ellipse(-15, 31, 10, 5, -0.12, 0, Math.PI * 2)
    ctx.ellipse(16, 31, 10, 5, 0.12, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#2f2d2a'
    ctx.beginPath()
    ctx.ellipse(0, 4, 17, 13, 0, 0, Math.PI * 2)
    ctx.fill()

    const shirtGradient = ctx.createLinearGradient(-16, -26, 16, 12)
    shirtGradient.addColorStop(0, '#ffffff')
    shirtGradient.addColorStop(0.18, shirtColor)
    shirtGradient.addColorStop(1, shirtShadow)
    ctx.fillStyle = shirtGradient
    ctx.beginPath()
    ctx.moveTo(-15, -28)
    ctx.quadraticCurveTo(0, -36, 15, -28)
    ctx.lineTo(18, 3)
    ctx.quadraticCurveTo(0, 14, -18, 3)
    ctx.closePath()
    ctx.fill()

    ctx.strokeStyle = 'rgba(18, 16, 14, 0.55)'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.strokeStyle = '#2c241b'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.moveTo(-12, -18)
    ctx.lineTo(-27, -5)
    ctx.moveTo(12, -18)
    ctx.lineTo(racketSide > 0 ? 23 : 27, racketSide > 0 ? -14 : -5)
    ctx.stroke()

    ctx.fillStyle = '#b98563'
    ctx.beginPath()
    ctx.arc(0, -47, 12, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#2a211c'
    ctx.beginPath()
    ctx.arc(0, -53, 12, Math.PI, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = 'rgba(30, 26, 20, 0.78)'
    ctx.font = '800 15px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(playerKey === 'host' ? 'H' : 'G', 0, 49)

    ctx.restore()
  }

  /**
   * 공을 그린다.
   */
  function drawBall() {
    const ball = runtime.state.ball
    const floor = projectCourtPoint(ball.x, ball.y)
    const heightScale = Math.max(0, Math.min(1, ball.z / WORLD.outHeight))
    const lift = heightScale * 300 * (0.78 + floor.depth * 0.22)
    const visualY = floor.y - lift
    const visualX = floor.x
    const visualRadius = WORLD.ballRadius * floor.scale * (1 + heightScale * 0.48)
    const shadowWidth = WORLD.ballRadius * floor.scale * (2.35 - heightScale * 0.78)
    const shadowHeight = WORLD.ballRadius * floor.scale * (0.72 - heightScale * 0.28)
    const shadowAlpha = 0.34 - heightScale * 0.16
    const isNearFloor = ball.z <= WORLD.ballRadius + 6
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy)
    const trailLength = clamp(speed / 18, 0, 32)
    const trailX = speed ? (ball.vx / speed) * trailLength : 0
    const trailY = speed ? (ball.vy / speed) * trailLength : 0
    const trailStart = projectCourtPoint(ball.x - trailX, ball.y - trailY)

    ctx.strokeStyle = `rgba(55, 68, 50, ${0.16 - heightScale * 0.08})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(floor.x, floor.y)
    ctx.lineTo(visualX, visualY)
    ctx.stroke()

    ctx.fillStyle = `rgba(55, 68, 50, ${shadowAlpha})`
    ctx.beginPath()
    ctx.ellipse(floor.x + 7 * floor.scale, floor.y + 10 * floor.scale, shadowWidth, shadowHeight, 0, 0, Math.PI * 2)
    ctx.fill()

    if (trailLength > 3) {
      const trailLift = heightScale * 300 * (0.78 + trailStart.depth * 0.22)
      const trailGradient = ctx.createLinearGradient(trailStart.x, trailStart.y - trailLift, visualX, visualY)
      trailGradient.addColorStop(0, 'rgba(228, 184, 58, 0)')
      trailGradient.addColorStop(1, 'rgba(228, 184, 58, 0.36)')
      ctx.strokeStyle = trailGradient
      ctx.lineWidth = visualRadius * 1.25
      ctx.beginPath()
      ctx.moveTo(trailStart.x, trailStart.y - trailLift)
      ctx.lineTo(visualX, visualY)
      ctx.stroke()
    }

    if (isNearFloor) {
      ctx.strokeStyle = 'rgba(213, 74, 53, 0.4)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.ellipse(floor.x, floor.y + 9 * floor.scale, WORLD.ballRadius * floor.scale + 12, WORLD.ballRadius * floor.scale * 0.7, 0, 0, Math.PI * 2)
      ctx.stroke()
    }

    const ballGradient = ctx.createRadialGradient(
      visualX - visualRadius * 0.35,
      visualY - visualRadius * 0.45,
      2,
      visualX,
      visualY,
      visualRadius * 1.2
    )
    ballGradient.addColorStop(0, '#ffffff')
    ballGradient.addColorStop(0.45, '#fff8d8')
    ballGradient.addColorStop(1, '#e4b83a')
    ctx.fillStyle = ballGradient
    ctx.beginPath()
    ctx.arc(visualX, visualY, visualRadius, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = 'rgba(188, 91, 64, 0.5)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(visualX, visualY, visualRadius + 5, 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'
    ctx.beginPath()
    ctx.arc(visualX - visualRadius * 0.34, visualY - visualRadius * 0.4, Math.max(2, visualRadius * 0.28), 0, Math.PI * 2)
    ctx.fill()
  }

  /**
   * 드래그 중 선택될 샷을 표시한다.
   */
  function drawShotHint() {
    const player = getLocalPlayer()
    const pointer = runtime.pointerControl

    if (!pointer.active || !player) {
      return
    }

    const projected = projectCourtPoint(player.x, player.y)
    const shot = rules.SHOT_TYPES[pointer.shotType] || rules.SHOT_TYPES.drive
    const label = shot.label
    const color = pointer.shotType === 'drop' ? '#2f9f79' : pointer.shotType === 'boast' ? '#bd6b18' : '#b12623'
    const x = projected.x
    const y = projected.y - 96 * projected.scale

    ctx.save()
    ctx.globalAlpha = 0.94
    ctx.fillStyle = 'rgba(255, 252, 240, 0.92)'
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.roundRect(x - 43, y - 26, 86, 34, 12)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = '#2d261f'
    ctx.font = '800 15px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(label, x, y - 4)

    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.setLineDash([8, 8])
    ctx.beginPath()

    if (pointer.shotType === 'drop') {
      ctx.moveTo(x, y + 22)
      ctx.quadraticCurveTo(x + 12, y - 38, x + 2, y - 78)
      ctx.quadraticCurveTo(x - 6, y - 44, x - 22, y - 18)
    } else if (pointer.shotType === 'boast') {
      const side = pointer.shotSide < 0 ? -1 : 1

      ctx.moveTo(x, y + 22)
      ctx.lineTo(x + side * 58, y - 22)
      ctx.lineTo(x + side * 22, y - 76)
    } else {
      ctx.moveTo(x, y + 22)
      ctx.quadraticCurveTo(x + 8, y - 34, x, y - 92)
    }

    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  /**
   * 게임 화면을 그린다.
   */
  function drawGame() {
    syncCanvasResolution()
    drawCourt()
    ;['host', 'guest']
      .sort((left, right) => runtime.state.players[left].y - runtime.state.players[right].y)
      .forEach((playerKey) => {
        drawPlayer(playerKey)
      })
    drawBall()
    drawShotHint()
  }

  /**
   * 애니메이션 루프를 실행한다.
   * @param {number} time
   */
  function frame(time) {
    const dt = Math.min(0.035, Math.max(0, (time - runtime.lastTime) / 1000 || 0))
    runtime.lastTime = time
    updatePointerInput()

    if (runtime.role === 'host') {
      stepHostGame(dt)

      if (runtime.mode !== 'solo' && time - runtime.lastSentAt > TICK_SEND_MS) {
        runtime.lastSentAt = time
        sendPeerMessage({
          type: 'state',
          state: runtime.state,
        })
      }
    } else if (runtime.role === 'guest') {
      sendPeerMessage({
        type: 'input',
        input: runtime.localInput,
      })
    }

    drawGame()
    requestAnimationFrame(frame)
  }

  /**
   * 입력 방향을 설정한다.
   * @param {string} control
   * @param {boolean} isDown
   */
  function setControl(control, isDown) {
    if (control === 'swing') {
      if (isDown) {
        runtime.localInput.swingId += 1
      }
      return
    }

    if (control in runtime.localInput) {
      runtime.localInput[control] = isDown
    }
  }

  /**
   * 키 입력을 반영한다.
   * @param {KeyboardEvent} event
   * @param {boolean} isDown
   */
  function handleKey(event, isDown) {
    const key = event.key.toLowerCase()
    const keyMap = {
      w: 'up',
      arrowup: 'up',
      s: 'down',
      arrowdown: 'down',
      a: 'left',
      arrowleft: 'left',
      d: 'right',
      arrowright: 'right',
      ' ': 'swing',
      enter: 'swing',
    }
    const control = keyMap[key]

    if (!control) {
      return
    }

    event.preventDefault()
    setControl(control, isDown)
  }

  /**
   * 코트 드래그 조작을 시작한다.
   * @param {PointerEvent} event
   */
  function handleCourtPointerDown(event) {
    if (runtime.screen !== 'game' || !runtime.role) {
      return
    }

    event.preventDefault()
    runtime.pointerControl.active = true
    runtime.pointerControl.pointerId = event.pointerId
    elements.canvas.setPointerCapture(event.pointerId)
    elements.canvas.parentElement.classList.add('is-dragging')
    setPointerTarget(event)
  }

  /**
   * 드래그 목표 위치를 갱신한다.
   * @param {PointerEvent} event
   */
  function handleCourtPointerMove(event) {
    if (!runtime.pointerControl.active || runtime.pointerControl.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    setPointerTarget(event)
  }

  /**
   * 드래그를 끝내고 스윙한다.
   * @param {PointerEvent} event
   */
  function handleCourtPointerEnd(event) {
    if (!runtime.pointerControl.active || runtime.pointerControl.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    stopLocalMove()
    runtime.localInput.shotType = runtime.pointerControl.shotType
    runtime.localInput.shotSide = runtime.pointerControl.shotSide
    runtime.localInput.swingId += 1
    resetPointerControl()
  }

  /**
   * 코트 직접 조작 이벤트를 연결한다.
   */
  function bindCourtControls() {
    elements.canvas.addEventListener('pointerdown', handleCourtPointerDown)
    elements.canvas.addEventListener('pointermove', handleCourtPointerMove)
    elements.canvas.addEventListener('pointerup', handleCourtPointerEnd)
    elements.canvas.addEventListener('pointercancel', handleCourtPointerEnd)
  }

  elements.createRoom.addEventListener('click', () => {
    createRoom().catch((exception) => {
      setBanner(`방 생성 실패: ${exception.message}`)
    })
  })

  elements.soloPlay.addEventListener('click', () => {
    startSoloGame()
  })

  elements.joinRoom.addEventListener('click', () => {
    joinRoom().catch((exception) => {
      setBanner(`참가 실패: ${exception.message}`)
    })
  })

  elements.copyLink.addEventListener('click', () => {
    copyInviteLink().catch((exception) => {
      setBanner(`링크 복사 실패: ${exception.message}`)
    })
  })

  elements.leaveGame.addEventListener('click', () => {
    leaveGame()
  })

  elements.roomCode.addEventListener('input', () => {
    elements.roomCode.value = normalizeRoomCode(elements.roomCode.value)
  })

  elements.characterList.addEventListener('change', () => {
    runtime.localCharacter = getSelectedCharacter()
    syncCharacterOptions()

    if (runtime.role) {
      runtime.state.players[runtime.role].character = runtime.localCharacter
      sendProfile()
    }
  })

  window.addEventListener('keydown', (event) => handleKey(event, true))
  window.addEventListener('keyup', (event) => handleKey(event, false))

  bindCourtControls()
  syncCharacterOptions()

  const initialRoomCode = normalizeRoomCode(window.SQUASHPONG_ROOM_CODE || '')
  if (initialRoomCode) {
    elements.roomCode.value = initialRoomCode
    setBanner(`초대 방 ${initialRoomCode}`)
  }

  setScreen('lobby')
  syncLabels()
  drawGame()
  requestAnimationFrame(frame)
})()
