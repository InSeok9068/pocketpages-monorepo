const { dateutil } = require('@pocketpages/utils')
const GRACE_MS = 24 * 60 * 60 * 1000

/**
 * 완성본 스키마 적용 여부를 확인합니다.
 * @param {types.BooklogApp} app DB 앱
 * @returns {boolean} 적용 여부
 */
function available(app) {
  try {
    app.findCollectionByNameOrId('book_audio_complete')
    return true
  } catch (_error) {
    return false
  }
}

/**
 * 현재 재생에 쓸 완성본을 찾습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB ID
 * @param {string} configHash 낭독 설정
 * @returns {core.Record | null} 완성본
 */
function findReady(app, fileId, configHash) {
  if (!available(app)) return null
  return (
    app.findRecordsByFilter(
      'book_audio_complete',
      "file_id = {:fileId} && config_hash = {:configHash} && status = 'ready' && audio_file != ''",
      '-created,-id',
      1,
      0,
      { fileId, configHash }
    )[0] || null
  )
}

function readManifest(record) {
  return JSON.parse(toString(record.get('manifest')) || 'null')
}

/**
 * 완성본 시간표를 읽습니다.
 * @param {core.Record} record 완성본
 * @returns {types.BookAudioCompleteView} 시간표
 */
function manifest(record) {
  return readManifest(record)
}

/**
 * 권한 확인을 마친 리더에 완성본 주소와 시간표를 제공합니다.
 * @param {core.Record} record 완성본
 * @param {string} bookId 책 ID
 * @returns {types.BookAudioCompleteView} 재생 정보
 */
function view(record, bookId) {
  const result = readManifest(record)
  return Object.assign({}, result, {
    url:
      '/xapi/books/complete-audio?bookId='
      + encodeURIComponent(bookId)
      + '&fileId='
      + encodeURIComponent(String(record.get('file_id')))
      + '&editionId='
      + record.get('id'),
  })
}

function sourcePlan(app, fileId, configHash) {
  const records = app.findRecordsByFilter(
    'book_audio_chunks',
    'file_id = {:fileId} && config_hash = {:configHash}',
    'section_index,chunk_index,split_path',
    0,
    0,
    { fileId, configHash }
  )
  const roots = {}
  records.forEach(function (r) {
    if (!r.get('split_path')) roots[r.get('section_index') + ':' + r.get('chunk_index')] = r.get('id')
  })
  const parts = records
    .filter(function (r) {
      return r.get('status') !== 'split'
    })
    .map(function (r) {
      return {
        id: r.get('id'),
        rootId: roots[r.get('section_index') + ':' + r.get('chunk_index')],
        sectionIndex: Number(r.get('section_index')),
        chunkIndex: Number(r.get('chunk_index')),
        splitPath: String(r.get('split_path')),
        status: String(r.get('status')),
        filename: String(r.get('audio_file')),
        generatedAt: String(r.get('generated_at')),
        regenerate: !!r.get('regenerate_requested'),
        text: String(r.get('input_text')),
        warning: String(r.get('error_message')),
        seconds: Number(r.get('duration_seconds')),
      }
    })
  return {
    records: records.map(function (r) {
      return r.get('id')
    }),
    roots: records
      .filter(function (r) {
        return !r.get('split_path')
      })
      .map(function (r) {
        return {
          id: r.get('id'),
          section: Number(r.get('section_index')),
          chunk: Number(r.get('chunk_index')),
          text: String(r.get('input_text')),
          // 요청이 없으면 직전 버전의 원본 지문을 유지합니다.
          regenerate: r.get('regenerate_requested') ? true : undefined,
        }
      }),
    parts,
  }
}

function validPlan(plan) {
  if (!plan.parts.length || !plan.roots.length) return false
  if (
    plan.parts.some(function (part) {
      return !part.rootId
    })
  )
    return false
  const next = {}
  return plan.roots.every(function (root) {
    if (root.regenerate) return false
    const expected = next[root.section] || 0
    if (root.chunk !== expected) return false
    next[root.section] = expected + 1
    const parts = plan.parts.filter(function (p) {
      return p.rootId === root.id
    })
    if (
      !parts.length
      || parts.some(function (p) {
        return p.status !== 'ready' || !p.filename || !(p.seconds > 0) || p.regenerate || !/^[01]*$/.test(p.splitPath)
      })
    )
      return false
    const weight = parts.reduce(function (sum, p) {
      return sum + Math.pow(2, -p.splitPath.length)
    }, 0)
    if (weight !== 1) return false
    for (let i = 0; i < parts.length; i += 1)
      for (let j = i + 1; j < parts.length; j += 1)
        if (parts[j].splitPath.indexOf(parts[i].splitPath) === 0) return false
    return (
      parts
        .map(function (p) {
          return p.text
        })
        .join('')
        .replace(/\s/g, '') === root.text.replace(/\s/g, '')
    )
  })
}

function fingerprint(plan) {
  return $security.sha256(JSON.stringify(plan))
}

/**
 * 관리자 화면의 완성본 상태를 읽습니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB ID
 * @param {string} configHash 낭독 설정
 * @returns {types.BookAudioCompleteAdminView} 관리 상태
 */
function adminView(app, fileId, configHash) {
  if (!available(app))
    return {
      available: false,
      canMerge: false,
      readyId: '',
      statusLabel: '완성본 스키마 import 필요',
      warningCount: 0,
      warnings: [],
      kbps: 0,
      busy: false,
    }
  const ready = findReady(app, fileId, configHash)
  let pending = app.findRecordsByFilter(
    'book_audio_complete',
    "file_id = {:fileId} && config_hash = {:configHash} && (status = 'queued' || status = 'running' || status = 'failed')",
    '-created,-id',
    1,
    0,
    { fileId, configHash }
  )[0]
  if (
    pending
    && pending.get('status') === 'failed'
    && ready
    && String(ready.get('created')) >= String(pending.get('created'))
  )
    pending = null
  const busy = !!pending && pending.get('status') !== 'failed'
  const plan = sourcePlan(app, fileId, configHash)
  const canMerge = validPlan(plan)
  const warnings = plan.parts
    .filter(function (p) {
      return p.status === 'ready' && !!p.warning
    })
    .map(function (p) {
      return {
        position: p.sectionIndex + ':' + p.chunkIndex + (p.splitPath ? '.' + p.splitPath : ''),
        message: p.warning.slice(0, 180),
        href: '/_/#/collections?collection=book_audio_chunks&filter=' + encodeURIComponent("id = '" + p.id + "'"),
      }
    })
  return {
    available: true,
    canMerge: canMerge && !busy,
    readyId: ready ? ready.get('id') : '',
    warningCount: warnings.length,
    warnings,
    kbps: ready ? Number(ready.get('kbps')) : 0,
    busy,
    statusLabel: busy
      ? pending.get('status') === 'queued'
        ? '완성본 작업 예약됨'
        : '완성본 처리 중'
      : pending && pending.get('status') === 'failed'
        ? '완성본 작업 실패: ' + pending.get('error_message')
        : ready
          ? '완성본 제공 중 · '
            + (ready.get('kbps') || '원본')
            + 'kbps'
            + (ready.get('cleanup_mode') === 'keep'
              ? ' · 조각 보관'
              : ready.get('cleanup_done')
                ? ' · 조각 정리 완료'
                : ' · 24시간 후 조각 정리 예정')
          : '완성본 없음',
  }
}

/**
 * 완성본 통합·압축을 예약합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB ID
 * @param {string} configHash 낭독 설정
 * @param {string} userId 관리자 ID
 * @param {string} operation merge 또는 compress
 * @param {number} kbps 목표 비트레이트, 0은 원본 유지
 * @param {string} cleanup 정리 방식
 * @param {boolean} reviewed 짧은 음성 경고 확인 여부
 * @returns {string} 예약 ID
 */
function request(app, fileId, configHash, userId, operation, kbps, cleanup, reviewed) {
  if (!available(app)) throw new Error('완성본 스키마를 먼저 import해 주세요.')
  if (
    ['merge', 'compress'].indexOf(operation) < 0
    || [0, 96, 64, 48].indexOf(kbps) < 0
    || ['keep', 'files', 'records'].indexOf(cleanup) < 0
  )
    throw new Error('완성본 옵션을 확인해 주세요.')
  let id = ''
  app.runInTransaction(function (txApp) {
    const state = adminView(txApp, fileId, configHash)
    if (state.busy) throw new Error('이미 완성본 작업이 예약되어 있습니다.')
    const ready = findReady(txApp, fileId, configHash)
    if (operation === 'merge' && !state.canMerge)
      throw new Error('모든 조각이 실제 음성 파일로 준비된 뒤 통합할 수 있습니다.')
    if (operation === 'merge' && state.warningCount && !reviewed)
      throw new Error('짧은 음성 경고를 확인한 뒤 통합해 주세요.')
    if (
      operation === 'compress'
      && (!ready || !kbps || (Number(ready.get('kbps')) > 0 && Number(ready.get('kbps')) <= kbps))
    )
      throw new Error('현재 완성본보다 낮은 비트레이트를 선택해 주세요.')
    const plan = sourcePlan(txApp, fileId, configHash)
    const record = new Record(txApp.findCollectionByNameOrId('book_audio_complete'))
    record.set('file_id', fileId)
    record.set('config_hash', configHash)
    record.set('requested_by', userId)
    record.set('operation', operation)
    record.set('kbps', kbps)
    record.set('cleanup_mode', operation === 'compress' ? ready.get('cleanup_mode') : cleanup)
    record.set('source_id', operation === 'compress' ? ready.get('id') : '')
    record.set('source_hash', fingerprint(plan))
    record.set('status', 'queued')
    txApp.save(record)
    id = String(record.get('id'))
  })
  return id
}

function copyTo(app, record, destination) {
  const fsys = app.newFilesystem()
  let root = null
  try {
    root = $os.openRoot($filepath.dir(destination))
    const reader = fsys.getReader(record.baseFilesPath() + '/' + record.get('audio_file'))
    try {
      // O_WRONLY | O_CREATE | O_TRUNC. 전체 MP3를 JS 메모리에 올리지 않습니다.
      const output = root.openFile($filepath.base(destination), 1 | 64 | 512, /** @type {any} */ (0o600))
      try {
        reader.writeTo(output)
      } finally {
        output.close()
      }
    } finally {
      reader.close()
    }
  } finally {
    if (root) root.close()
    fsys.close()
  }
}

function command(binary, args) {
  return toString($os.cmd.apply(null, [binary].concat(args)).combinedOutput())
}
function ffmpeg() {
  return $os.getenv('BOOKLOG_FFMPEG_BIN') || 'ffmpeg'
}
function intactFile(app, record) {
  if (!record || !record.get('audio_file')) return false
  const files = app.newFilesystem()
  try {
    return (
      Number(files.attributes(record.baseFilesPath() + '/' + record.get('audio_file')).size)
        === Number(record.get('file_size')) && Number(record.get('file_size')) > 0
    )
  } catch (_error) {
    return false
  } finally {
    files.close()
  }
}
function probe(path) {
  const result = JSON.parse(
    command($os.getenv('BOOKLOG_FFPROBE_BIN') || 'ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size,bit_rate:stream=bit_rate,sample_rate,channels',
      '-select_streams',
      'a:0',
      '-of',
      'json',
      path,
    ])
  )
  if (!(Number(result.format.duration) > 0)) throw new Error('MP3 길이를 확인하지 못했습니다.')
  const stream = result.streams[0]
  return {
    seconds: Number(result.format.duration),
    size: Number(result.format.size),
    kbps: Math.round(Number(stream.bit_rate || result.format.bit_rate) / 1000),
    format: String(stream.sample_rate) + ':' + stream.channels,
  }
}

/**
 * 예약된 완성본 하나를 만들고 유예된 파일을 정리합니다.
 * @param {types.BooklogApp} app DB 앱
 * @returns {{ id: string, status: string }} 처리 결과
 */
function run(app) {
  if (!available(app)) return { id: '', status: 'schema-missing' }
  cleanup(app)
  let claimed = null
  app.runInTransaction(function (txApp) {
    const running = txApp.findRecordsByFilter('book_audio_complete', "status = 'running'", '', 0, 0)
    running.forEach(function (r) {
      if ((Date.parse(String(r.get('started_at')).replace(' ', 'T')) || 0) < Date.now() - 2 * 60 * 60 * 1000) {
        r.set('status', 'failed')
        r.set('error_message', '작업 시간이 만료됐습니다. 다시 예약해 주세요.')
        txApp.save(r)
      }
    })
    if (
      running.some(function (r) {
        return r.get('status') === 'running'
      })
    )
      return
    const record = txApp.findRecordsByFilter('book_audio_complete', "status = 'queued'", 'created,id', 1, 0)[0]
    if (!record) return
    record.set('status', 'running')
    record.set('started_at', new Date().toISOString())
    txApp.save(record)
    claimed = record
  })
  if (!claimed) return { id: '', status: 'idle' }
  const id = String(claimed.get('id'))
  const paths = []
  const prefix = $filepath.join($os.tempDir(), 'booklog-complete-' + id + '-' + $security.randomString(8))
  try {
    const fileId = String(claimed.get('file_id')),
      configHash = String(claimed.get('config_hash'))
    const plan = sourcePlan(app, fileId, configHash)
    if (fingerprint(plan) !== claimed.get('source_hash'))
      throw new Error('예약 후 조각이 변경됐습니다. 다시 예약해 주세요.')
    if (claimed.get('operation') === 'merge' && !validPlan(plan))
      throw new Error('통합할 조각이 모두 준비되지 않았습니다.')
    let parts = [],
      sourceId = String(claimed.get('source_id'))
    const listPath = prefix + '-list.txt',
      output = prefix + '-output.mp3'
    paths.push(listPath, output)
    const inputs = [],
      formats = []
    if (sourceId) {
      const source = app.findRecordById('book_audio_complete', sourceId)
      if (source.get('status') !== 'ready' || !source.get('audio_file'))
        throw new Error('압축할 완성본이 변경됐습니다.')
      const input = prefix + '-source.mp3'
      paths.push(input)
      copyTo(app, source, input)
      inputs.push(input)
      parts = readManifest(source).parts.map(function (p) {
        return Object.assign({}, p)
      })
    } else {
      plan.parts.forEach(function (p, index) {
        const input = prefix + '-' + index + '.mp3'
        paths.push(input)
        copyTo(app, app.findRecordById('book_audio_chunks', p.id), input)
        inputs.push(input)
        const inputInfo = probe(input)
        formats.push(inputInfo.format)
        const duration = inputInfo.seconds
        parts.push({
          sectionIndex: p.sectionIndex,
          chunkIndex: p.chunkIndex,
          chunkId: p.rootId,
          text: p.text,
          startSeconds: 0,
          endSeconds: duration,
        })
      })
    }
    $os.writeFile(
      listPath,
      inputs
        .map(function (path) {
          return "file '" + path.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"
        })
        .join('\n'),
      /** @type {any} */ (0o600)
    )
    const kbps = Number(claimed.get('kbps'))
    if (
      !kbps
      && formats.some(function (format) {
        return format !== formats[0]
      })
    )
      throw new Error('조각의 샘플레이트·채널이 다릅니다. 비트레이트를 선택해 통합해 주세요.')
    const args = [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-map',
      '0:a:0',
      '-map_metadata',
      '-1',
    ]
    if (kbps) args.push('-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-ac', '1', '-ar', '24000')
    else args.push('-c:a', 'copy')
    args.push('-write_xing', '1', output)
    command(ffmpeg(), args)
    command(ffmpeg(), ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'])
    const metadata = probe(output)
    const sourceSeconds = parts.reduce(function (sum, p) {
      return sum + p.endSeconds - p.startSeconds
    }, 0)
    if (Math.abs(metadata.seconds - sourceSeconds) > Math.max(1, parts.length * 0.1))
      throw new Error('통합본 길이가 원본과 다릅니다.')
    let cursor = 0
    parts.forEach(function (p) {
      const duration = ((p.endSeconds - p.startSeconds) * metadata.seconds) / sourceSeconds
      p.startSeconds = cursor
      cursor += duration
      p.endSeconds = cursor
    })
    parts[parts.length - 1].endSeconds = metadata.seconds
    const payload = { configHash, url: '', parts }
    const audioFile = $filesystem.fileFromPath(output)
    app.runInTransaction(function (txApp) {
      const current = txApp.findRecordById('book_audio_complete', id)
      if (
        current.get('status') !== 'running'
        || String(current.get('started_at')) !== String(claimed.get('started_at'))
        || fingerprint(sourcePlan(txApp, fileId, configHash)) !== claimed.get('source_hash')
      )
        throw new Error('처리 중 원본이 변경됐습니다. 다시 예약해 주세요.')
      if (sourceId) {
        const source = findReady(txApp, fileId, configHash)
        if (!source || source.get('id') !== sourceId) throw new Error('기존 완성본이 변경됐습니다.')
      }
      const ready = findReady(txApp, fileId, configHash)
      if (ready) {
        ready.set('status', 'retired')
        ready.set('cleanup_at', new Date(Date.now() + GRACE_MS).toISOString())
        txApp.save(ready)
      }
      current.set('audio_file', audioFile)
      current.set('manifest', payload)
      current.set('duration_seconds', metadata.seconds)
      current.set('file_size', metadata.size)
      current.set('kbps', kbps || metadata.kbps)
      current.set('status', 'ready')
      current.set('cleanup_at', new Date(Date.now() + GRACE_MS).toISOString())
      current.set('error_message', '')
      txApp.save(current)
      const job = txApp.findRecordsByFilter(
        'book_audio_jobs',
        'file_id = {:fileId} && config_hash = {:configHash}',
        '',
        1,
        0,
        { fileId, configHash }
      )[0]
      if (job) {
        job.set('compress_kbps', 0)
        txApp.save(job)
      }
    })
    return { id, status: 'ready' }
  } catch (exception) {
    try {
      const r = app.findRecordById('book_audio_complete', id)
      if (r.get('status') === 'running') {
        r.set('status', 'failed')
        r.set('error_message', String(exception.message || exception).slice(0, 2000))
        app.save(r)
      }
    } catch (_error) {
      /* 삭제된 작업입니다. */
    }
    app.logger().error('audio-complete:failed', 'id', id, 'error', String(exception.message || exception))
    return { id, status: 'failed' }
  } finally {
    paths.forEach(function (path) {
      try {
        $os.remove(path)
      } catch (_error) {
        /* 임시 파일이 없습니다. */
      }
    })
  }
}

/**
 * 유예 시간이 지난 조각과 구버전을 정리합니다.
 * @param {types.BooklogApp} app DB 앱
 * @returns {void}
 */
function cleanup(app) {
  const rows = app.findRecordsByFilter(
    'book_audio_complete',
    "cleanup_at != '' && cleanup_at <= {:now} && (status = 'retired' || (status = 'ready' && cleanup_done = false))",
    'cleanup_at',
    10,
    0,
    { now: dateutil.toDbDateTime(Date.now()) }
  )
  rows.forEach(function (row) {
    const target =
      row.get('status') === 'retired' ? findReady(app, String(row.get('file_id')), String(row.get('config_hash'))) : row
    if (!intactFile(app, target)) {
      app
        .logger()
        .warn('audio-complete:cleanup-skipped', 'id', String(row.get('id')), 'reason', '완성본 파일 검증 실패')
      return
    }
    const payload = readManifest(target)
    if (!payload || !payload.parts || !payload.parts.length) return
    app.runInTransaction(function (txApp) {
      const r = txApp.findRecordById('book_audio_complete', row.get('id'))
      if (r.get('status') === 'retired') {
        const active = findReady(txApp, String(r.get('file_id')), String(r.get('config_hash')))
        if (active) txApp.delete(r)
        return
      }
      if (r.get('status') !== 'ready' || r.get('cleanup_done')) return
      const mode = String(r.get('cleanup_mode'))
      if (mode !== 'keep') {
        if (
          txApp.findRecordsByFilter(
            'book_audio_complete',
            "file_id = {:fileId} && (status = 'queued' || status = 'running')",
            '',
            1,
            0,
            { fileId: r.get('file_id') }
          ).length
        )
          return
        const plan = sourcePlan(txApp, String(r.get('file_id')), String(r.get('config_hash')))
        if (fingerprint(plan) !== r.get('source_hash')) return
        plan.records.forEach(function (id) {
          const chunk = txApp.findRecordById('book_audio_chunks', id)
          if (mode === 'records') txApp.delete(chunk)
          else {
            chunk.set('audio_file', '')
            txApp.save(chunk)
          }
        })
      }
      r.set('cleanup_done', true)
      txApp.save(r)
    })
  })
}

/**
 * 재생성 전에 완성본을 구버전으로 전환합니다.
 * @param {types.BooklogApp} app DB 앱
 * @param {string} fileId EPUB ID
 * @param {string} configHash 낭독 설정
 * @returns {void}
 */
function invalidate(app, fileId, configHash) {
  if (!available(app)) return
  app
    .findRecordsByFilter(
      'book_audio_complete',
      "file_id = {:fileId} && config_hash = {:configHash} && (status = 'ready' || status = 'queued' || status = 'running')",
      '',
      0,
      0,
      { fileId, configHash }
    )
    .forEach(function (r) {
      r.set('status', r.get('audio_file') ? 'retired' : 'failed')
      r.set('error_message', '구간 재생성으로 완성본을 다시 만들어야 합니다.')
      r.set('cleanup_at', new Date(Date.now() + GRACE_MS).toISOString())
      app.save(r)
    })
}

module.exports = { available, findReady, manifest, view, adminView, request, run, cleanup, invalidate }
