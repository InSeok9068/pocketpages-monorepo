/* global $app, $filesystem, $security, toBytes, module */
// 보관·복원 테스트 경로가 함께 쓰는 함수입니다. JSVM 경로 핸들러는 파일 위쪽 함수를 볼 수 없어 모듈로 둡니다.
function silentMp3(frames) {
  const bytes = new Array(417 * frames).fill(0)
  for (let index = 0; index < frames; index += 1) {
    bytes[index * 417] = 255
    bytes[index * 417 + 1] = 251
    bytes[index * 417 + 2] = 144
    bytes[index * 417 + 3] = 100
    bytes[index * 417 + 4] = frames % 256
  }
  return bytes
}

function chunksOf(fileId) {
  return $app.findRecordsByFilter('book_audio_chunks', 'file_id = {:fileId}', 'section_index,chunk_index,split_path', 0, 0, {
    fileId,
  })
}

function keyOf(chunk) {
  return [chunk.get('section_index'), chunk.get('chunk_index'), chunk.get('split_path') || ''].join(':')
}

function setReady(chunk, frames, kbps) {
  chunk.set('status', 'ready')
  chunk.set('audio_file', $filesystem.fileFromBytes(silentMp3(frames), 'seed.mp3'))
  chunk.set('duration_seconds', (frames * 1152) / 44100)
  chunk.set('audio_kbps', kbps)
  chunk.set('generated_at', new Date().toISOString())
  $app.save(chunk)
}

function audioDigest(fsys, chunk) {
  const name = String(chunk.get('audio_file') || '')
  if (!name) return ''
  const reader = fsys.getReader(chunk.baseFilesPath() + '/' + name)
  try {
    const bytes = new Uint8Array(toBytes(reader))
    let hex = ''
    for (let index = 0; index < bytes.length; index += 1) hex += ('0' + bytes[index].toString(16)).slice(-2)
    return bytes.length + ':' + $security.sha256(hex)
  } finally {
    reader.close()
  }
}

module.exports = { silentMp3, chunksOf, keyOf, setReady, audioDigest }
