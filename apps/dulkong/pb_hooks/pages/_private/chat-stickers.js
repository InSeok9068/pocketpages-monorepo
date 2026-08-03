const ChatStickers = [
  { id: 'bean_hello', art: '🫘👋', label: '안녕!', imagePath: '/assets/stickers/bean_hello.webp' },
  { id: 'sprout_love', art: '🌱💚', label: '좋아해', imagePath: '/assets/stickers/sprout_love.webp' },
  { id: 'dulkong_love', art: '🫘💚🌱', label: '사랑해', imagePath: '/assets/stickers/dulkong_love.webp' },
  { id: 'dulkong_hug', art: '🫘🫂🌱', label: '꼬옥', imagePath: '/assets/stickers/dulkong_hug.webp' },
  { id: 'miss_you', art: '🥺🌱', label: '보고 싶어', imagePath: '/assets/stickers/miss_you.webp' },
  { id: 'dulkong_laugh', art: '🫘🤣🌱', label: 'ㅋㅋㅋ', imagePath: '/assets/stickers/dulkong_laugh.webp' },
  { id: 'dulkong_cheer', art: '🌿💪', label: '파이팅!', imagePath: '/assets/stickers/dulkong_cheer.webp' },
  { id: 'thank_you', art: '🌼💚', label: '고마워', imagePath: '/assets/stickers/thank_you.webp' },
  { id: 'dulkong_sorry', art: '🥺💦', label: '미안해', imagePath: '/assets/stickers/dulkong_sorry.webp' },
  { id: 'good_night', art: '🌙💤', label: '잘 자', imagePath: '/assets/stickers/good_night.webp' },
  { id: 'dulkong_kiss', art: '💋💚', label: '쪽!', imagePath: '/assets/stickers/dulkong_kiss.webp' },
  { id: 'dulkong_best', art: '👍✨', label: '최고야', imagePath: '/assets/stickers/dulkong_best.webp' },
]

/**
 * 채팅에서 사용할 둘콩 스티커 목록을 반환합니다.
 * @returns {types.ChatSticker[]} 스티커 목록
 */
function listChatStickers() {
  return ChatStickers
}

/**
 * 스티커 ID에 해당하는 둘콩 스티커를 반환합니다.
 * @param {string} stickerId 스티커 ID
 * @returns {types.ChatSticker | null} 스티커
 */
function getChatSticker(stickerId) {
  const normalizedStickerId = String(stickerId || '')

  for (let index = 0; index < ChatStickers.length; index += 1) {
    if (ChatStickers[index].id === normalizedStickerId) return ChatStickers[index]
  }

  return null
}

module.exports = { getChatSticker, listChatStickers }
