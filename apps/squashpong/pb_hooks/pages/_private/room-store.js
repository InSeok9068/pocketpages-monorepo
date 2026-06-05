const STORE_KEY = 'squashpong:rooms'
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 6
const ROOM_TTL_MS = 1000 * 60 * 60 * 2
const SPEED_MODES = {
  normal: true,
  fast: true,
  turbo: true,
}

/**
 * 현재 시각 문자열을 반환한다.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString()
}

/**
 * 저장된 방 목록을 가져온다.
 * @param {(name: string, value?: any) => any} storeFn
 * @returns {Record<string, types.SquashpongRoom>}
 */
function getRooms(storeFn) {
  return storeFn(STORE_KEY) || {}
}

/**
 * 방 목록을 저장한다.
 * @param {(name: string, value?: any) => any} storeFn
 * @param {Record<string, types.SquashpongRoom>} rooms
 */
function setRooms(storeFn, rooms) {
  storeFn(STORE_KEY, rooms)
}

/**
 * 만료된 방을 정리한다.
 * @param {Record<string, types.SquashpongRoom>} rooms
 * @param {number} nowMs
 */
function cleanupRooms(rooms, nowMs) {
  Object.keys(rooms).forEach((code) => {
    const roomMs = Date.parse(rooms[code].updatedAt || rooms[code].createdAt || '')

    if (!roomMs || nowMs - roomMs > ROOM_TTL_MS) {
      delete rooms[code]
    }
  })
}

/**
 * 새 방 코드를 만든다.
 * @returns {string}
 */
function createRoomCode() {
  let code = ''

  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }

  return code
}

/**
 * 방 코드를 정규화한다.
 * @param {string} value
 * @returns {string}
 */
function normalizeCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * 공속도 모드를 정규화한다.
 * @param {string} value
 * @returns {'normal' | 'fast' | 'turbo'}
 */
function normalizeSpeedMode(value) {
  return SPEED_MODES[value] ? value : 'normal'
}

/**
 * 새 방을 만든다.
 * @param {(name: string, value?: any) => any} storeFn
 * @param {{ speedMode?: string }} options
 * @returns {types.SquashpongRoom}
 */
function createRoom(storeFn, options) {
  const rooms = getRooms(storeFn)
  const nowMs = Date.now()
  cleanupRooms(rooms, nowMs)

  let code = createRoomCode()
  while (rooms[code]) {
    code = createRoomCode()
  }

  const timestamp = nowIso()
  const room = {
    code: code,
    speedMode: normalizeSpeedMode(options && options.speedMode),
    createdAt: timestamp,
    updatedAt: timestamp,
    offer: null,
    answer: null,
    hostCandidates: [],
    guestCandidates: [],
  }

  rooms[code] = room
  setRooms(storeFn, rooms)

  return room
}

/**
 * 방을 찾는다.
 * @param {(name: string, value?: any) => any} storeFn
 * @param {string} code
 * @returns {types.SquashpongRoom | null}
 */
function findRoom(storeFn, code) {
  const rooms = getRooms(storeFn)
  const room = rooms[normalizeCode(code)] || null

  if (!room) {
    return null
  }

  room.updatedAt = nowIso()
  setRooms(storeFn, rooms)

  return room
}

/**
 * 방을 변경한다.
 * @param {(name: string, value?: any) => any} storeFn
 * @param {string} code
 * @param {(room: types.SquashpongRoom) => void} mutate
 * @returns {types.SquashpongRoom | null}
 */
function updateRoom(storeFn, code, mutate) {
  const rooms = getRooms(storeFn)
  const room = rooms[normalizeCode(code)] || null

  if (!room) {
    return null
  }

  mutate(room)
  room.updatedAt = nowIso()
  setRooms(storeFn, rooms)

  return room
}

/**
 * 클라이언트 역할을 정규화한다.
 * @param {string} value
 * @returns {'host' | 'guest'}
 */
function normalizeRole(value) {
  return value === 'guest' ? 'guest' : 'host'
}

module.exports = {
  createRoom,
  findRoom,
  normalizeCode,
  normalizeRole,
  normalizeSpeedMode,
  updateRoom,
}
