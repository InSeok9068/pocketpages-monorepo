import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { getChatSticker, listChatStickers } = require('../pb_hooks/pages/_private/chat-stickers.js')
const { mapMessage } = require('../pb_hooks/pages/_private/couple-data.js')

function stickerRecord(stickerId) {
  const fields = {
    id: 'sticker-message',
    sender: 'inseok',
    type: 'sticker',
    body: '좋아해',
    systemData: JSON.stringify({ stickerId }),
    created: '2026-08-03 12:00:00.000Z',
    clientCreatedAt: '2026-08-03 12:00:00.000Z',
  }

  return {
    get(name) {
      return fields[name] || ''
    },
  }
}

test('둘콩 채팅은 서로 다른 스티커 12개를 제공한다', () => {
  const stickers = listChatStickers()

  assert.equal(stickers.length, 12)
  assert.equal(new Set(stickers.map((sticker) => sticker.id)).size, stickers.length)
  assert.ok(stickers.every((sticker) => sticker.art && sticker.label && sticker.imagePath))
  assert.ok(
    stickers.every((sticker) =>
      existsSync(fileURLToPath(new URL('../pb_hooks/pages' + sticker.imagePath, import.meta.url)))
    )
  )
})

test('스티커 ID는 저장된 채팅의 표시 정보로 변환된다', () => {
  const message = mapMessage(stickerRecord('sprout_love'), 'inseok')

  assert.equal(message.type, 'sticker')
  assert.deepEqual(message.sticker, getChatSticker('sprout_love'))
  assert.equal(message.sticker.label, '좋아해')
})

test('등록되지 않은 스티커 ID는 표시 정보로 노출하지 않는다', () => {
  const message = mapMessage(stickerRecord('unknown_sticker'), 'inseok')

  assert.equal(message.sticker, null)
})
