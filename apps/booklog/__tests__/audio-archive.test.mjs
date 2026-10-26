import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'
import { startService } from '@pocketpages/test-support/service-harness'
import { readCookieHeader } from '@pocketpages/test-support/auth-cookie'

const require = createRequire(import.meta.url)
const { zipSync, strToU8 } = require('fflate')
const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const bookId = (index) => 'book' + String(index).padStart(11, '0')
const fileId = (index) => 'file' + String(index).padStart(11, '0')
let fixtureDir
let service
let adminCookie
let readerCookie
let firstArchive

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-archive-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:18096' }"
    )
  )
  const binary = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'
  copyFileSync(path.join(serviceDir, binary), path.join(fixtureDir, binary))
  symlinkSync(realpathSync(path.join(serviceDir, 'node_modules')), path.join(fixtureDir, 'node_modules'), 'junction')
  const schema = JSON.parse(readFileSync(path.join(serviceDir, 'pb_schema.json'), 'utf8')).filter(
    (collection) => collection.name !== '_superusers'
  )
  writeFileSync(path.join(fixtureDir, 'pb_hooks/test-schema.json'), JSON.stringify(schema))
  copyFileSync(
    new URL('./fixtures/audio-archive-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  copyFileSync(
    new URL('./fixtures/audio-archive-helpers.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-archive-helpers.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    ['APP_ENV=production', 'GEMINI_API_KEY=', 'GEMINI_APIKEY=', 'GEMINI_AI_KEY=', 'ONESIGNAL_API_KEY=', 'ONESIGNAL_APPID='].join(
      '\n'
    )
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port: 18096, timeoutMs: 30000 })
  adminCookie = await signIn('admin-manager@example.com')
  readerCookie = await signIn('reader@example.com')
})

after(async () => {
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-archive-test-'))
    rmSync(resolved, { recursive: true, force: true })
  }
})

async function signIn(email) {
  const response = await fetch(service.baseUrl + '/xapi/auth/sign-in', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ email, password: 'test-password-1234' }),
  })
  assert.equal(response.status, 303)
  const cookie = readCookieHeader(response.headers)
  assert.ok(cookie, email + ' sign-in must set an auth cookie')
  return cookie
}

const paragraph = (label) =>
  `${label} 장면입니다. 주인공은 오래된 서점의 문을 열고 들어가 먼지 쌓인 책장 사이를 천천히 걸었습니다. `
  + '창가에 놓인 의자에 앉아 책을 펼치자 바깥의 소음이 멀어지고 이야기 속 바람 소리만 들렸습니다. '
  + '한참을 읽다가 고개를 들어 보니 해가 기울어 책장 위로 길고 따뜻한 빛이 내려앉아 있었습니다.'

function epub(texts) {
  const files = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
  }
  const manifest = texts.map((_text, index) => `<item id="c${index}" href="c${index}.xhtml" media-type="application/xhtml+xml"/>`)
  const spine = texts.map((_text, index) => `<itemref idref="c${index}"/>`)
  files['OPS/book.opf'] = strToU8(
    `<package version="3.0"><metadata><title>보관 테스트</title></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`
  )
  texts.forEach((text, index) => {
    files[`OPS/c${index}.xhtml`] = strToU8(`<html><body><h1>${index + 1}장</h1><p>${text}</p></body></html>`)
  })
  return Array.from(zipSync(files))
}

const baseTexts = ['첫째', '둘째', '셋째', '넷째'].map(paragraph)

async function json(pathname, body) {
  const response = await fetch(service.baseUrl + pathname, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

const state = (index) => json('/_test/archive-state?fileId=' + fileId(index))

async function prepare(index, texts = baseTexts, options = {}) {
  const loaded = await json('/_test/archive-epub', { fileId: fileId(index), bytes: epub(texts) })
  assert.equal(loaded.sections, texts.length)
  await json('/_test/archive-seed', { fileId: fileId(index), ...options })
}

async function download(index, cookie = adminCookie) {
  return fetch(
    service.baseUrl + '/xapi/books/audio-archive?bookId=' + bookId(index) + '&fileId=' + fileId(index),
    { headers: { Cookie: cookie } }
  )
}

async function downloadArchive(index) {
  const response = await download(index)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(response.status, 200, bytes.toString('utf8').slice(0, 300))
  assert.equal(response.headers.get('content-type'), 'application/x-tar')
  assert.equal(Number(response.headers.get('content-length')), bytes.length)
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="booklog-audiobook-file\d+\.tar"; filename\*=UTF-8''/)
  assert.ok(decodeURIComponent(response.headers.get('content-disposition').split("''")[1]).startsWith('보관-테스트-책-'))
  return bytes
}

async function deleteAudio(index) {
  const response = await fetch(service.baseUrl + '/admin/books?scope=all', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie },
    body: new URLSearchParams({ action: 'audio-delete', bookId: bookId(index), fileId: fileId(index) }),
  })
  assert.equal(response.status, 303)
  assert.equal((await state(index)).chunks.length, 0)
}

async function restore(index, archive, { name = 'audiobook.tar', cookie = adminCookie } = {}) {
  const form = new FormData()
  form.set('bookId', bookId(index))
  form.set('fileId', fileId(index))
  form.set('from', '/admin/books?scope=all')
  form.set('archive', new Blob([archive], { type: 'application/x-tar' }), name)
  const response = await fetch(service.baseUrl + '/xapi/books/audio-archive', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
    body: form,
  })
  assert.equal(response.status, 303, await response.text())
  return decodeURIComponent(response.headers.get('location') || '')
}

function readTar(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const prefix = field(345, 155)
    const name = (prefix ? prefix + '/' : '') + field(0, 100)
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    if (type === '0') entries.set(name.replace(/^\.\//, ''), buffer.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function writeTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '')
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136)
    header.write('        ', 148)
    header.write(entry.type || '0', 156)
    if (entry.link) header.write(entry.link, 157, 100, 'utf8')
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function rebuild(archive, change) {
  const entries = readTar(archive)
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
  const extra = change(manifest, entries) || []
  return writeTar([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    ...[...entries].filter(([name]) => name.startsWith('audio/')).map(([name, data]) => ({ name, data })),
    ...extra,
  ])
}

function withoutIds(chunks) {
  return chunks.map((chunk) => {
    const copy = { ...chunk }
    delete copy.id
    return copy
  })
}

test('An archive keeps every chunk state, the original MP3 bytes and listening positions', async () => {
  await prepare(1)
  const seeded = await state(1)
  assert.deepEqual(
    seeded.chunks.map((chunk) => chunk.status),
    ['ready', 'split', 'ready', 'failed', 'generating', 'ready']
  )
  const archive = await downloadArchive(1)
  firstArchive = archive
  const entries = readTar(archive)
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
  assert.equal(manifest.format, 'booklog-audio-archive')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.file.id, fileId(1))
  assert.equal(manifest.job.compressKbps, 64)
  assert.equal(manifest.job.configHash, seeded.job.configHash)
  assert.deepEqual(
    manifest.chunks.map((chunk) => chunk.status),
    ['ready', 'split', 'ready', 'failed', 'queued', 'ready'],
    'a chunk that was being generated is archived as queued'
  )
  for (const chunk of manifest.chunks) {
    assert.equal(chunk.textHash, createHash('sha256').update(chunk.inputText).digest('hex'))
    if (chunk.status !== 'ready') {
      assert.equal(chunk.audio, '')
      continue
    }
    const bytes = entries.get(chunk.audio)
    assert.ok(bytes, chunk.audio)
    const original = seeded.chunks.find((item) => item.key === [chunk.sectionIndex, chunk.chunkIndex, chunk.splitPath].join(':'))
    const hex = bytes.toString('hex')
    assert.equal(original.audio, bytes.length + ':' + createHash('sha256').update(hex).digest('hex'))
    assert.equal(Math.round(chunk.durationSeconds * 1000) / 1000, original.duration)
  }
  assert.equal(manifest.chunks[0].audioKbps, 64)
  const blocked = manifest.chunks.find((chunk) => chunk.status === 'failed')
  assert.match(blocked.errorMessage, /400 Request blocked/)
  assert.ok(blocked.attemptCount > 0)
  assert.deepEqual(
    manifest.progress.map((entry) => [entry.userId, entry.chunkKey, entry.positionSeconds, entry.isCompleted]),
    seeded.progress.map((entry) => [entry.userId, entry.chunkKey, entry.seconds, entry.completed])
  )
  assert.doesNotMatch(entries.get('manifest.json').toString('utf8'), /audio_file|storage|pb_data/)
  assert.equal((await state(1)).workspaces, 0, 'the export workspace is removed after streaming')
  assert.deepEqual(withoutIds((await state(1)).chunks), withoutIds(seeded.chunks), 'exporting changes nothing')
})

test('Deleting and restoring brings back identical audio, settings and positions without generating', async () => {
  const before = await state(1)
  await deleteAudio(1)
  const message = await restore(1, firstArchive)
  assert.match(message, /AI 오디오북을 복원했습니다\. 음성 3구간, 다시 만들 구간 1개/)
  assert.match(message, /청취 위치 3개/)
  const restored = await state(1)
  assert.deepEqual(
    withoutIds(restored.chunks).map((chunk) => ({ ...chunk, attempts: chunk.status === 'queued' ? 0 : chunk.attempts })),
    withoutIds(before.chunks).map((chunk) =>
      chunk.status === 'generating' ? { ...chunk, status: 'queued', attempts: 0 } : chunk
    )
  )
  assert.equal(restored.job.status, 'paused', 'the remaining chunk waits for an explicit restart')
  assert.equal(restored.job.compressKbps, 64)
  assert.equal(restored.job.configHash, before.job.configHash)
  assert.equal(restored.job.model, before.job.model)
  assert.equal(restored.job.totalChunks, before.job.totalChunks)
  assert.equal(restored.job.readyChunks, 3)
  assert.deepEqual(restored.progress, before.progress)
  assert.equal(restored.workspaces, 0)
  for (const [sectionIndex, expectedParts] of [[0, 1], [1, 2]]) {
    const query = new URLSearchParams({ bookId: bookId(1), fileId: fileId(1), sectionIndex: String(sectionIndex), chunkIndex: '0' })
    const chunk = await (await fetch(service.baseUrl + '/api/books/audio-chunk?' + query, { headers: { Cookie: adminCookie } })).json()
    assert.equal(chunk.ok, true, JSON.stringify(chunk))
    assert.equal(chunk.configHash, before.job.configHash)
    assert.equal(chunk.parts.length, expectedParts)
    const playable = chunk.parts.find((part) => part.audioUrl)
    const audio = await fetch(service.baseUrl + playable.audioUrl, { headers: { Cookie: adminCookie } })
    assert.equal(audio.status, 200)
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg')
    const bytes = Buffer.from(await audio.arrayBuffer())
    const key = sectionIndex + ':0:' + (expectedParts > 1 ? '0' : '')
    assert.equal(
      bytes.length + ':' + createHash('sha256').update(bytes.toString('hex')).digest('hex'),
      before.chunks.find((item) => item.key === key).audio,
      'the restored file plays the original MP3 bytes'
    )
    if (expectedParts > 1) assert.ok(chunk.parts[1].fallbackText, 'the blocked part is still read by the device voice')
  }
  const $ = load(await (await fetch(service.baseUrl + '/admin/books?scope=all', { headers: { Cookie: adminCookie } })).text())
  assert.ok($(`a[href="/xapi/books/audio-archive?bookId=${bookId(1)}&fileId=${fileId(1)}"]`).length)
  assert.equal($(`form[action="/xapi/books/audio-archive"] input[name=fileId][value="${fileId(1)}"]`).length, 0)
  assert.equal($(`form[action="/xapi/books/audio-archive"][enctype="multipart/form-data"] input[name=fileId][value="${fileId(8)}"]`).length, 1)
})

test('A fully generated archive restores as a completed audiobook', async () => {
  await prepare(2, baseTexts, { allReady: true })
  const before = await state(2)
  assert.equal(before.job.status, 'completed')
  const archive = await downloadArchive(2)
  await deleteAudio(2)
  const message = await restore(2, archive)
  assert.doesNotMatch(message, /다시 만들 구간/)
  const restored = await state(2)
  assert.equal(restored.job.status, 'completed')
  assert.deepEqual(withoutIds(restored.chunks), withoutIds(before.chunks))
})

test('After the EPUB text changes only matching chunks keep their audio and stale positions are dropped', async () => {
  await prepare(3, baseTexts, { allReady: true })
  const before = await state(3)
  const archive = await downloadArchive(3)
  await deleteAudio(3)
  const changed = [...baseTexts.slice(0, 3), paragraph('바뀐 넷째'), paragraph('새 다섯째')]
  await json('/_test/archive-epub', { fileId: fileId(3), bytes: epub(changed) })
  const message = await restore(3, archive)
  assert.match(message, /음성 3구간, 다시 만들 구간 2개/)
  assert.match(message, /본문이 달라 쓰지 않은 음성 1개/)
  assert.match(message, /청취 위치 1개/)
  const restored = await state(3)
  assert.equal(restored.job.status, 'paused')
  assert.deepEqual(
    restored.chunks.map((chunk) => [chunk.key, chunk.status]),
    [['0:0:', 'ready'], ['1:0:', 'ready'], ['2:0:', 'ready'], ['3:0:', 'queued'], ['4:0:', 'queued']]
  )
  for (const chunk of restored.chunks.slice(0, 3)) {
    assert.equal(chunk.audio, before.chunks.find((item) => item.key === chunk.key).audio)
  }
  assert.deepEqual(restored.progress.map((entry) => entry.chunkKey), ['0:0:'])
})

test('Restoring over an existing audiobook is refused without touching it', async () => {
  await prepare(4)
  const before = await state(4)
  const archive = await downloadArchive(4)
  const message = await restore(4, archive)
  assert.match(message, /이미 AI 오디오북이 있습니다/)
  assert.deepEqual(await state(4), before)
})

test('Unsafe or damaged archives are rejected before anything is written', async () => {
  await json('/_test/archive-epub', { fileId: fileId(5), bytes: epub(baseTexts) })
  const audioName = [...readTar(firstArchive).keys()].find((name) => name.startsWith('audio/'))
  const cases = [
    ['a non-tar file name', firstArchive, /\.tar 보관 파일만/, 'audiobook.zip'],
    ['an empty archive', Buffer.alloc(1024), /형식을 확인/],
    ['an unexpected file', rebuild(firstArchive, () => [{ name: 'notes.txt', data: 'x' }]), /허용하지 않는 항목/],
    ['a path traversal', rebuild(firstArchive, () => [{ name: '../escape.mp3', data: 'x' }]), /허용하지 않는 항목/],
    ['an absolute path', rebuild(firstArchive, () => [{ name: '/tmp/escape.mp3', data: 'x' }]), /허용하지 않는 항목/],
    ['a symbolic link', rebuild(firstArchive, () => [{ name: 'audio/link.mp3', type: '2', link: '/etc/passwd' }]), /허용하지 않는 항목/],
    ['a hard link', rebuild(firstArchive, () => [{ name: 'audio/hard.mp3', type: '1', link: audioName }]), /허용하지 않는 항목/],
    ['a repeated entry', rebuild(firstArchive, () => [{ name: audioName, data: 'replaced' }]), /같은 이름의 항목/],
    ['another format', rebuild(firstArchive, (manifest) => void (manifest.format = 'other')), /보관 파일이 아니거나/],
    ['a newer version', rebuild(firstArchive, (manifest) => void (manifest.version = 2)), /지원하지 않는 버전/],
    ['changed text', rebuild(firstArchive, (manifest) => void (manifest.chunks[0].inputText += '!')), /손상되었습니다/],
    ['missing audio', rebuild(firstArchive, (manifest, entries) => void entries.delete(manifest.chunks[0].audio)), /음성 파일이 빠져/],
    ['duplicate chunks', rebuild(firstArchive, (manifest) => void manifest.chunks.push(manifest.chunks[0])), /구간 정보를 확인/],
    ['an unknown status', rebuild(firstArchive, (manifest) => void (manifest.chunks[1].status = 'generating')), /구간 정보를 확인/],
    ['missing settings', rebuild(firstArchive, (manifest) => void delete manifest.job.voice), /낭독 설정/],
    ['invalid JSON', writeTar([{ name: 'manifest.json', data: '{' }]), /목록을 읽지 못했습니다/],
  ]
  for (const [label, archive, expected, name] of cases) {
    const message = await restore(5, archive, { name })
    assert.match(message, expected, label)
    const current = await state(5)
    assert.equal(current.job, null, label)
    assert.equal(current.chunks.length, 0, label)
    assert.equal(current.workspaces, 0, label + ' cleans its workspace')
  }
  const message = await restore(5, firstArchive)
  assert.match(message, /AI 오디오북을 복원했습니다/, 'an archive restores onto another file with the same text')
  assert.equal((await state(5)).chunks.filter((chunk) => chunk.status === 'ready').length, 3)
})

test('Only managers can download or restore archives', async () => {
  assert.equal((await download(1, readerCookie)).status, 403)
  assert.equal((await download(6)).status, 404, 'a file without an audiobook has nothing to export')
  await json('/_test/archive-epub', { fileId: fileId(6), bytes: epub(baseTexts) })
  const location = await restore(6, firstArchive, { cookie: readerCookie })
  assert.match(location, /관리자 권한이 필요합니다/)
  assert.equal((await state(6)).job, null)
  const anonymous = await fetch(service.baseUrl + '/xapi/books/audio-archive?bookId=' + bookId(1) + '&fileId=' + fileId(1), {
    redirect: 'manual',
  })
  assert.equal(anonymous.status, 303)
  assert.equal(new URL(anonymous.headers.get('location'), service.baseUrl).pathname, '/auth')
})

test('Only the restore route accepts uploads above the general body limit', async () => {
  await json('/_test/archive-epub', { fileId: fileId(7), bytes: epub(baseTexts) })
  const large = Buffer.alloc(130 * 1024 * 1024)
  const message = await restore(7, large)
  assert.match(message, /형식을 확인/, 'a 130MB upload reaches the handler instead of the 128MB limit')
  const other = await fetch(service.baseUrl + '/xapi/books/audio-job', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/octet-stream' },
    body: large,
  })
  assert.equal(other.status, 413)
  assert.equal((await state(7)).workspaces, 0)
})
