/* global Request */
// 리더 E2E의 가짜 서버가 pb_hooks/pages/api/books/*의 응답 모양과 입력 검증을 그대로 따르게 하는 도우미입니다.

export const CONFIG_HASH = '7d'.repeat(32)

export async function readForm(route) {
  const request = route.request()
  return new Request(request.url(), {
    method: 'POST',
    headers: request.headers(),
    body: request.postDataBuffer(),
  }).formData()
}

function text(form, key) {
  return String(form.get(key) || '').trim()
}

function numberText(value) {
  const raw = String(value ?? '').trim()
  return raw && !isNaN(Number(raw)) ? String(Number(raw)) : ''
}

/**
 * 실제 API가 처리 전에 던지는 입력 오류 메시지를 돌려줍니다. 문제가 없으면 빈 문자열입니다.
 * @param {string} path API 경로
 * @param {FormData} form 요청 본문
 * @returns {string} 400 응답 메시지
 */
export function readerApiInputError(path, form) {
  const name = path.split('/').pop()
  if (!text(form, 'bookId')) return '책 정보가 필요합니다.'
  if ((name === 'save-progress' || name === 'save-bookmark') && !text(form, 'locator') && !text(form, 'href')) {
    return name === 'save-progress' ? '저장할 읽기 위치가 없습니다.' : '저장할 위치가 없습니다.'
  }
  if (name === 'delete-bookmark' && !text(form, 'bookmarkId')) return '책갈피 정보가 필요합니다.'
  if (name === 'save-highlight' && !text(form, 'quoteText')) return '문구를 입력해 주세요.'
  if (name === 'save-reading-session') {
    const seconds = Number(text(form, 'durationSeconds'))
    if (!text(form, 'startedAt') || !text(form, 'endedAt')) return '독서 시간이 필요합니다.'
    if (isNaN(seconds) || seconds < 1) return '저장할 독서 시간이 없습니다.'
  }
  return ''
}

export function badRequest(route, message) {
  return route.fulfill({ status: 400, json: { ok: false, message } })
}

/**
 * 서버에 저장된 읽기 위치를 load-progress 응답으로 만듭니다.
 * @param {{ locator?: string, href?: string, chapterLabel?: string, pageNumber?: string, progressPercent?: string } | null} position 저장된 위치
 * @returns {object} 응답 본문
 */
export function loadProgressPayload(position) {
  const locator = String(position?.locator || '')
  const href = String(position?.href || '')
  return {
    ok: true,
    hasSavedPosition: !!(locator || href),
    message: locator || href ? '저장된 읽기 위치를 불러왔습니다.' : '저장된 읽기 위치가 없습니다.',
    locator,
    href,
    chapterLabel: String(position?.chapterLabel || ''),
    pageNumber: numberText(position?.pageNumber),
    progressPercent: numberText(position?.progressPercent),
  }
}

/**
 * save-progress의 충돌 판정을 따라, 충돌이면 409 응답 본문을 돌려줍니다.
 * @param {{ locator?: string, href?: string, chapterLabel?: string } | null} stored 서버에 저장된 위치
 * @param {FormData} form 요청 본문
 * @returns {object | null} 충돌 응답 본문
 */
export function progressConflict(stored, form) {
  const storedPosition = String(stored?.locator || stored?.href || '')
  if (!form.has('baseLocator') || text(form, 'force') === 'true' || !storedPosition) return null
  if (storedPosition === text(form, 'baseLocator')) return null
  return {
    ok: false,
    conflict: true,
    message: '다른 기기에서 저장한 읽기 위치가 있습니다.',
    locator: String(stored.locator || ''),
    href: String(stored.href || ''),
    chapterLabel: String(stored.chapterLabel || ''),
  }
}

export function positionFromForm(form) {
  return {
    locator: text(form, 'locator'),
    href: text(form, 'href'),
    chapterLabel: text(form, 'chapterLabel'),
    pageNumber: numberText(form.get('pageNumber')),
    progressPercent: numberText(form.get('progressPercent')),
  }
}

export function saveProgressPayload() {
  return { ok: true, message: '읽던 위치를 저장했습니다.', id: 'shelf0000000001' }
}

/**
 * save-bookmark가 저장하고 돌려주는 책갈피 항목을 만듭니다.
 * @param {string} id 책갈피 ID
 * @param {FormData} form 요청 본문
 * @returns {object} 책갈피 항목
 */
export function bookmarkFromForm(id, form) {
  const chapterLabel = text(form, 'chapterLabel')
  const progressPercent = numberText(form.get('progressPercent'))
  const parts = [chapterLabel, progressPercent ? progressPercent + '%' : ''].filter(Boolean)
  return {
    id,
    locator: text(form, 'locator'),
    href: text(form, 'href'),
    chapterLabel,
    progressPercent,
    pageNumber: numberText(form.get('pageNumber')),
    label: parts.length ? parts.join(' · ') : '책갈피',
    noteText: '',
    bookmarkedAt: new Date().toISOString(),
  }
}

export function highlightFromForm(id, form) {
  return {
    id,
    locator: text(form, 'locator'),
    href: text(form, 'href'),
    chapterLabel: text(form, 'chapterLabel'),
    pageNumber: numberText(form.get('pageNumber')),
    quoteText: text(form, 'quoteText'),
    noteText: text(form, 'noteText'),
    highlightedAt: new Date().toISOString(),
  }
}

/**
 * list-highlights 응답을 만듭니다. 본문 표시용 요청이면 범위 CFI 위치만 돌려줍니다.
 * @param {object[]} highlights 저장된 문구 항목
 * @param {FormData} form 요청 본문
 * @returns {object} 응답 본문
 */
export function listHighlightsPayload(highlights, form) {
  if (text(form, 'annotationsOnly') === 'true') {
    return {
      ok: true,
      highlights: highlights
        .filter((item) => item.locator.indexOf('epubcfi(') === 0 && item.locator.indexOf(',') >= 0)
        .map((item) => ({ locator: item.locator })),
    }
  }
  return { ok: true, highlights }
}

export function readingSessionPayload(form) {
  const sessionId = text(form, 'sessionId')
  return { ok: true, id: /^[a-z0-9]{15}$/.test(sessionId) ? sessionId : 'session00000001' }
}

/**
 * audio-chunk 응답을 book-audio-data.js chunkView와 같은 모양으로 만듭니다.
 * @param {{ chunkId: string, chunkCount: number, timeline: number[], parts: Array<{ text: string, durationSeconds: number, ready?: boolean, pending?: boolean }>, sectionOrder?: number[], sectionIndex?: number }} chunk 구간 정보
 * @returns {object} 응답 본문
 */
export function audioChunkPayload(chunk) {
  const order = chunk.sectionOrder || [0]
  const position = order.indexOf(chunk.sectionIndex || 0)
  return {
    ok: true,
    chunkId: chunk.chunkId,
    configHash: CONFIG_HASH,
    chunkCount: chunk.chunkCount,
    nextSectionIndex: position >= 0 && position + 1 < order.length ? order[position + 1] : -1,
    previousSectionIndex: position > 0 ? order[position - 1] : -1,
    chapterNumber: position + 1,
    chapterTotal: order.length,
    timeline: chunk.timeline,
    parts: chunk.parts.map((part, index) => {
      const ready = part.ready !== false
      const partId = chunk.chunkId + (chunk.parts.length > 1 ? '-' + index : '')
      return {
        audioUrl: ready ? '/xapi/books/audio-file?bookId=book&fileId=file&chunkId=' + partId + '&v=' + CONFIG_HASH : '',
        fallbackText: ready ? '' : part.text,
        pending: !ready && !!part.pending,
        text: part.text,
        durationSeconds: part.durationSeconds,
      }
    }),
  }
}

/**
 * audio-progress POST가 저장 전에 거절하는 입력이면 메시지를 돌려줍니다.
 * @param {FormData} form 요청 본문
 * @returns {string} 400 응답 메시지
 */
export function audioProgressInputError(form) {
  if (!/^[a-f0-9]{64}$/.test(text(form, 'configHash'))) return '낭독 설정 정보를 확인해 주세요.'
  const seconds = Number(form.get('seconds'))
  if (!text(form, 'chunkId') || !isFinite(seconds) || seconds < 0) return '청취 위치를 확인해 주세요.'
  return ''
}

/**
 * audio-progress GET 응답을 저장된 청취 위치로 만듭니다.
 * @param {{ sectionIndex: number, chunkIndex: number, seconds: number, isCompleted: boolean } | null} saved 저장된 위치
 * @param {number[]} timeline 챕터의 구간별 길이
 * @returns {object} 응답 본문
 */
export function audioProgressPayload(saved, timeline) {
  if (!saved) return { ok: true, configHash: CONFIG_HASH, progress: null }
  const chapterSeconds = timeline.slice(0, saved.chunkIndex).reduce((total, length) => total + length, saved.seconds)
  return {
    ok: true,
    configHash: CONFIG_HASH,
    progress: { ...saved, chapterSeconds, startsNextSection: false },
  }
}

export function audioPositionInputError(url) {
  const section = String(url.searchParams.get('sectionIndex') ?? '').trim()
  const anchor = String(url.searchParams.get('anchor') || '').trim()
  if (
    !url.searchParams.get('bookId')
    || !url.searchParams.get('fileId')
    || !section
    || !Number.isSafeInteger(Number(section))
    || Number(section) < 0
    || !anchor
    || anchor.length > 300
  ) {
    return '읽던 위치 정보를 확인해 주세요.'
  }
  return ''
}
