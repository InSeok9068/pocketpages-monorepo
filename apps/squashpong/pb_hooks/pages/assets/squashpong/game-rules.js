;(function (root, factory) {
  const rules = factory()

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = rules
  }

  root.SquashpongRules = rules
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const WORLD = {
    width: 540,
    height: 960,
    leftX: 30,
    rightX: 510,
    frontWallY: 86,
    backWallY: 902,
    playerMinY: 170,
    playerRadius: 24,
    playerSpeed: 360,
    ballRadius: 10,
    ballSpeed: 300,
    maxBallSpeed: 560,
    gravity: 320,
    floorDamping: 0.68,
    tinHeight: 14,
    outHeight: 260,
    frontWallTargetHeight: 132,
    hitRadius: 78,
    swingSeconds: 0.18,
  }
  const SPEED_MODES = {
    normal: {
      id: 'normal',
      label: '기본',
      scale: 1,
    },
    fast: {
      id: 'fast',
      label: '빠름',
      scale: 1.28,
    },
    turbo: {
      id: 'turbo',
      label: '매우 빠름',
      scale: 1.52,
    },
  }
  const CHARACTERS = [
    { id: 'lime', label: '라임', primary: '#b7f25a', secondary: '#315f29' },
    { id: 'sky', label: '스카이', primary: '#62c8ff', secondary: '#164e73' },
    { id: 'coral', label: '코랄', primary: '#ff7d6e', secondary: '#7b2c26' },
    { id: 'violet', label: '바이올렛', primary: '#c7a4ff', secondary: '#49317a' },
  ]
  const CHARACTER_BY_ID = CHARACTERS.reduce(function (acc, character) {
    acc[character.id] = character
    return acc
  }, {})
  const SHOT_TYPES = {
    drive: {
      id: 'drive',
      label: '드라이브',
      speedMultiplier: 1.25,
      targetOffset: 0,
      targetMin: 96,
      targetMax: WORLD.outHeight - 34,
      horizontalScale: 4.4,
      defaultHorizontal: 110,
      returnSpeed: 1,
      returnLift: 0.74,
      returnMinVz: 78,
    },
    drop: {
      id: 'drop',
      label: '드롭',
      speedMultiplier: 1.05,
      targetOffset: -74,
      targetMin: 58,
      targetMax: 126,
      horizontalScale: 2.1,
      defaultHorizontal: 54,
      returnSpeed: 0.34,
      returnLift: 0.18,
      returnMinVz: 20,
    },
    boast: {
      id: 'boast',
      label: '보스트',
      speedMultiplier: 1.1,
      targetOffset: -12,
      targetMin: 84,
      targetMax: WORLD.outHeight - 48,
      horizontalScale: 1.4,
      defaultHorizontal: 360,
      returnSpeed: 0.78,
      returnLift: 0.56,
      returnMinVz: 58,
    },
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

  /**
   * 상대 플레이어 키를 반환한다.
   * @param {'host' | 'guest'} playerKey
   * @returns {'host' | 'guest'}
   */
  function opponentOf(playerKey) {
    return playerKey === 'host' ? 'guest' : 'host'
  }

  /**
   * 캐릭터 id를 안전한 값으로 정규화한다.
   * @param {string} characterId
   * @returns {string}
   */
  function normalizeCharacter(characterId) {
    return CHARACTER_BY_ID[characterId] ? characterId : CHARACTERS[0].id
  }

  /**
   * 샷 종류를 안전한 값으로 정규화한다.
   * @param {string} shotType
   * @returns {'drive' | 'drop' | 'boast'}
   */
  function normalizeShotType(shotType) {
    return SHOT_TYPES[shotType] ? shotType : 'drive'
  }

  /**
   * 샷 방향을 안전한 값으로 정규화한다.
   * @param {number} shotSide
   * @returns {-1 | 1}
   */
  function normalizeShotSide(shotSide) {
    return Number(shotSide) < 0 ? -1 : 1
  }

  /**
   * 공속도 모드를 안전한 값으로 정규화한다.
   * @param {string} speedMode
   * @returns {'normal' | 'fast' | 'turbo'}
   */
  function normalizeSpeedMode(speedMode) {
    return SPEED_MODES[speedMode] ? speedMode : 'normal'
  }

  /**
   * 게임 상태의 공속도 배율을 반환한다.
   * @param {Record<string, any>} state
   * @returns {number}
   */
  function getSpeedScale(state) {
    const speedMode = normalizeSpeedMode(state && state.speedMode)

    return SPEED_MODES[speedMode].scale
  }

  /**
   * 입력 객체를 기본값과 합친다.
   * @param {Record<string, any>} input
   * @returns {{ up: boolean, down: boolean, left: boolean, right: boolean, swingId: number, shotType: 'drive' | 'drop' | 'boast', shotSide: -1 | 1 }}
   */
  function normalizeInput(input) {
    return {
      up: Boolean(input && input.up),
      down: Boolean(input && input.down),
      left: Boolean(input && input.left),
      right: Boolean(input && input.right),
      swingId: Number(input && input.swingId ? input.swingId : 0),
      shotType: normalizeShotType(input && input.shotType),
      shotSide: normalizeShotSide(input && input.shotSide),
    }
  }

  /**
   * 새 게임 상태를 만든다.
   * @param {{ hostCharacter?: string, guestCharacter?: string, speedMode?: string }} options
   * @returns {Record<string, any>}
   */
  function createInitialState(options) {
    const hostCharacter = normalizeCharacter(options && options.hostCharacter)
    const guestCharacter = normalizeCharacter(options && options.guestCharacter ? options.guestCharacter : 'sky')
    const speedMode = normalizeSpeedMode(options && options.speedMode)

    return {
      speedMode: speedMode,
      hostScore: 0,
      guestScore: 0,
      rally: 0,
      active: 'host',
      awaitingServe: true,
      awaitingFrontWall: true,
      lastHitter: 'host',
      lastShotType: 'drive',
      floorBounces: 0,
      lastPoint: '',
      notice: 'Host 차례',
      players: {
        host: {
          x: 235,
          y: 744,
          character: hostCharacter,
          swingTimer: 0,
          lastSwingId: 0,
        },
        guest: {
          x: 325,
          y: 820,
          character: guestCharacter,
          swingTimer: 0,
          lastSwingId: 0,
        },
      },
      ball: {
        x: 235,
        y: 690,
        z: 64,
        vx: 0,
        vy: 0,
        vz: 0,
      },
    }
  }

  /**
   * 서브 전 공 위치를 플레이어 앞에 둔다.
   * @param {Record<string, any>} state
   * @param {'host' | 'guest'} active
   */
  function placeServeBall(state, active) {
    const player = state.players[active]

    state.ball.x = player.x
    state.ball.y = player.y - 54
    state.ball.z = 64
    state.ball.vx = 0
    state.ball.vy = 0
    state.ball.vz = 0
  }

  /**
   * 앞벽 목표 높이에 맞는 수직 속도를 계산한다.
   * @param {number} fromY
   * @param {number} fromZ
   * @param {number} speed
   * @returns {number}
   */
  function getFrontWallLift(fromY, fromZ, speed, shotType) {
    const shot = SHOT_TYPES[normalizeShotType(shotType)]
    const distance = Math.max(120, fromY - WORLD.frontWallY)
    const flightSeconds = distance / speed
    const targetHeight = clamp(WORLD.frontWallTargetHeight + (distance - 520) * 0.12 + shot.targetOffset, shot.targetMin, shot.targetMax)

    return clamp((targetHeight - fromZ + 0.5 * WORLD.gravity * flightSeconds * flightSeconds) / flightSeconds, 120, 330)
  }

  /**
   * 공을 다음 랠리 시작 위치로 되돌린다.
   * @param {Record<string, any>} state
   * @param {'host' | 'guest'} active
   */
  function resetServe(state, active) {
    state.active = active
    state.awaitingServe = true
    state.awaitingFrontWall = true
    state.lastHitter = active
    state.lastShotType = 'drive'
    state.floorBounces = 0
    state.rally = 0
    state.notice = (active === 'host' ? 'Host' : 'Guest') + ' 서브'
    placeServeBall(state, active)
  }

  /**
   * 플레이어를 입력에 맞게 이동한다.
   * @param {Record<string, any>} player
   * @param {{ up: boolean, down: boolean, left: boolean, right: boolean }} input
   * @param {number} dt
   */
  function movePlayer(player, input, dt) {
    let dx = 0
    let dy = 0

    if (input.left) {
      dx -= 1
    }

    if (input.right) {
      dx += 1
    }

    if (input.up) {
      dy -= 1
    }

    if (input.down) {
      dy += 1
    }

    if (dx !== 0 && dy !== 0) {
      dx *= 0.707
      dy *= 0.707
    }

    player.x = clamp(player.x + dx * WORLD.playerSpeed * dt, WORLD.leftX + WORLD.playerRadius, WORLD.rightX - WORLD.playerRadius)
    player.y = clamp(player.y + dy * WORLD.playerSpeed * dt, WORLD.playerMinY, WORLD.backWallY - WORLD.playerRadius)
  }

  /**
   * 스윙이 공에 닿는지 판단한다.
   * @param {Record<string, any>} state
   * @param {'host' | 'guest'} playerKey
   * @param {{ swingId: number, shotType?: string, shotSide?: number }} input
   * @returns {boolean}
   */
  function trySwing(state, playerKey, input) {
    const player = state.players[playerKey]
    const normalizedInput = normalizeInput(input)

    if (!normalizedInput.swingId || normalizedInput.swingId === player.lastSwingId) {
      return false
    }

    player.lastSwingId = normalizedInput.swingId
    player.swingTimer = WORLD.swingSeconds

    if (state.active !== playerKey) {
      return false
    }

    if (state.awaitingServe) {
      const xDirection = playerKey === 'host' ? 1 : -1
      const speedScale = getSpeedScale(state)
      const serveSpeed = WORLD.ballSpeed * speedScale

      state.ball.x = player.x
      state.ball.y = player.y - WORLD.playerRadius - WORLD.ballRadius - 8
      state.ball.z = 70
      state.ball.vx = 70 * xDirection * speedScale
      state.ball.vy = -serveSpeed
      state.ball.vz = getFrontWallLift(state.ball.y, state.ball.z, serveSpeed, 'drive')
      state.awaitingServe = false
      state.awaitingFrontWall = true
      state.lastHitter = playerKey
      state.lastShotType = 'drive'
      state.floorBounces = 0
      state.notice = '앞벽으로 이동'
      return true
    }

    if (state.awaitingFrontWall) {
      return false
    }

    const dx = state.ball.x - player.x
    const dy = state.ball.y - player.y
    const distance = Math.sqrt(dx * dx + dy * dy)

    if (distance > WORLD.hitRadius) {
      return false
    }

    const shot = SHOT_TYPES[normalizedInput.shotType]
    const speedScale = getSpeedScale(state)
    const baseSpeed = WORLD.ballSpeed * speedScale
    const maxSpeed = WORLD.maxBallSpeed * speedScale
    const speed = clamp((baseSpeed + state.rally * 12 * speedScale) * shot.speedMultiplier, baseSpeed * 0.8, maxSpeed)
    const side = normalizedInput.shotSide || (dx < 0 ? -1 : 1)
    const horizontalAim = normalizedInput.shotType === 'boast' ? side * shot.defaultHorizontal * speedScale : clamp(dx * shot.horizontalScale * speedScale, -330 * speedScale, 330 * speedScale)

    state.ball.x = player.x + clamp(dx * 0.25, -10, 10)
    state.ball.y = player.y - WORLD.playerRadius - WORLD.ballRadius - 6
    state.ball.z = Math.max(46, state.ball.z)
    state.ball.vx = horizontalAim || (playerKey === 'host' ? shot.defaultHorizontal : -shot.defaultHorizontal)
    state.ball.vy = -speed
    state.ball.vz = getFrontWallLift(state.ball.y, state.ball.z, speed, normalizedInput.shotType)
    state.awaitingFrontWall = true
    state.awaitingServe = false
    state.lastHitter = playerKey
    state.lastShotType = normalizedInput.shotType
    state.floorBounces = 0
    state.rally += 1
    state.notice = shot.label

    return true
  }

  /**
   * 점수를 주고 다음 서브를 준비한다.
   * @param {Record<string, any>} state
   * @param {'host' | 'guest'} winner
   */
  function awardPoint(state, winner) {
    if (winner === 'host') {
      state.hostScore += 1
    } else {
      state.guestScore += 1
    }

    state.lastPoint = winner
    resetServe(state, winner)
  }

  /**
   * 공이 앞벽을 올바르게 맞았는지 처리한다.
   * @param {Record<string, any>} state
   */
  function handleFrontWall(state) {
    const ball = state.ball

    ball.y = WORLD.frontWallY + WORLD.ballRadius

    if (ball.z < WORLD.tinHeight || ball.z > WORLD.outHeight) {
      awardPoint(state, opponentOf(state.lastHitter))
      return
    }

    const shot = SHOT_TYPES[normalizeShotType(state.lastShotType)]

    ball.vy = Math.abs(ball.vy) * shot.returnSpeed
    ball.vx *= normalizedWallX(shot.id)
    ball.vz = Math.max(ball.vz * shot.returnLift, shot.returnMinVz)
    state.awaitingFrontWall = false
    state.awaitingServe = false
    state.floorBounces = 0
    state.active = opponentOf(state.lastHitter)
    state.notice = (state.active === 'host' ? 'Host' : 'Guest') + ' 차례'
  }

  /**
   * 앞벽 반사 뒤 좌우 속도 보정값을 반환한다.
   * @param {string} shotType
   * @returns {number}
   */
  function normalizedWallX(shotType) {
    if (shotType === 'drop') {
      return 0.38
    }

    if (shotType === 'boast') {
      return 0.72
    }

    return 0.86
  }

  /**
   * 바닥 바운드를 처리한다.
   * @param {Record<string, any>} state
   */
  function handleFloorBounce(state) {
    const ball = state.ball

    ball.z = WORLD.ballRadius
    ball.vz = Math.abs(ball.vz) * WORLD.floorDamping

    if (state.awaitingFrontWall) {
      awardPoint(state, opponentOf(state.lastHitter))
      return
    }

    state.floorBounces += 1

    if (state.floorBounces >= 2) {
      awardPoint(state, opponentOf(state.active))
    }
  }

  /**
   * 한 프레임만큼 게임 상태를 진행한다.
   * @param {Record<string, any>} state
   * @param {{ host?: Record<string, any>, guest?: Record<string, any> }} inputs
   * @param {number} dt
   * @returns {Record<string, any>}
   */
  function stepState(state, inputs, dt) {
    const hostInput = normalizeInput(inputs && inputs.host)
    const guestInput = normalizeInput(inputs && inputs.guest)
    const ball = state.ball

    movePlayer(state.players.host, hostInput, dt)
    movePlayer(state.players.guest, guestInput, dt)
    state.players.host.swingTimer = Math.max(0, state.players.host.swingTimer - dt)
    state.players.guest.swingTimer = Math.max(0, state.players.guest.swingTimer - dt)

    trySwing(state, 'host', hostInput)
    trySwing(state, 'guest', guestInput)

    if (state.awaitingServe) {
      placeServeBall(state, state.active)
      return state
    }

    ball.x += ball.vx * dt
    ball.y += ball.vy * dt
    ball.z += ball.vz * dt
    ball.vz -= WORLD.gravity * dt

    if (ball.y - WORLD.ballRadius <= WORLD.frontWallY) {
      handleFrontWall(state)
      return state
    }

    if (ball.x - WORLD.ballRadius <= WORLD.leftX) {
      ball.x = WORLD.leftX + WORLD.ballRadius
      ball.vx = Math.abs(ball.vx)
    } else if (ball.x + WORLD.ballRadius >= WORLD.rightX) {
      ball.x = WORLD.rightX - WORLD.ballRadius
      ball.vx = -Math.abs(ball.vx)
    }

    if (ball.y + WORLD.ballRadius >= WORLD.backWallY) {
      ball.y = WORLD.backWallY - WORLD.ballRadius
      ball.vy = -Math.abs(ball.vy) * 0.86
    }

    if (ball.z - WORLD.ballRadius <= 0) {
      handleFloorBounce(state)
    }

    return state
  }

  return {
    CHARACTERS: CHARACTERS,
    SHOT_TYPES: SHOT_TYPES,
    SPEED_MODES: SPEED_MODES,
    WORLD: WORLD,
    createInitialState: createInitialState,
    normalizeCharacter: normalizeCharacter,
    normalizeSpeedMode: normalizeSpeedMode,
    normalizeShotType: normalizeShotType,
    normalizeInput: normalizeInput,
    opponentOf: opponentOf,
    resetServe: resetServe,
    stepState: stepState,
    trySwing: trySwing,
  }
})
