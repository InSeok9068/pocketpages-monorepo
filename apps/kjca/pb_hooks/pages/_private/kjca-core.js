const { compile: compileHtmlToText } = require(`${__hooks}/pages/_private/vendor/html-to-text.bundle.js`)
const LinkifyIt = require('linkify-it')

const KJCA_EMAIL_DOMAIN = 'kjca.local'
const KJCA_HOST = 'http://www.kjca.co.kr'
const KJCA_LOGIN_URL = `${KJCA_HOST}/staff/auth/login_check`
const KJCA_AUTH_URL = `${KJCA_HOST}/staff/auth`
const CACHE_COLLECTION_NAME = 'staff_diary_analysis_cache'
const GEMINI_MODEL_NAME = 'gemini-2.5-flash-lite'
const PROMPT_VERSION = 4
const GEMINI_MAX_ATTEMPTS = 3

const WEEKDAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri']

const weekdayLabelMap = {
  mon: '월',
  tue: '화',
  wed: '수',
  thu: '목',
  fri: '금',
}

const inlineHtmlToText = compileHtmlToText({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
  ],
})

const structuredHtmlToText = compileHtmlToText({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    {
      selector: 'table',
      format: 'dataTable',
      options: {
        uppercaseHeaderCells: false,
        maxColumnWidth: 1000,
        colSpacing: 3,
        rowSpacing: 0,
      },
    },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
})

const kjcaLinkify = new LinkifyIt().set({
  fuzzyLink: false,
  fuzzyEmail: false,
})

/**
 * JSON 문자열을 안전하게 파싱합니다.
 * @param {unknown} text 파싱할 원본 값입니다.
 * @param {unknown} fallback 파싱 실패 시 돌려줄 기본값입니다.
 * @returns {unknown} 파싱 결과 또는 기본값입니다.
 */
function parseJsonSafely(text, fallback) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return fallback
  }
}

/**
 * 응답 텍스트에서 JSON object 구간만 추출합니다.
 * @param {unknown} text 모델 응답이나 원본 텍스트입니다.
 * @returns {string} JSON object 문자열입니다.
 */
function extractJsonObjectText(text) {
  const normalized = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  const objectStart = normalized.indexOf('{')
  const objectEnd = normalized.lastIndexOf('}')
  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return '{}'
  }
  return normalized.slice(objectStart, objectEnd + 1).trim()
}

/**
 * 헤더 객체에서 대소문자 구분 없이 값을 배열로 읽습니다.
 * @param {object | null | undefined} headers 응답 헤더 객체입니다.
 * @param {string} key 찾을 헤더 이름입니다.
 * @returns {string[]} 일치한 헤더 값 목록입니다.
 */
function getHeaderValues(headers, key) {
  if (!headers) return []

  const direct = headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()]
  if (Array.isArray(direct)) return direct.map((item) => String(item))
  if (direct !== undefined && direct !== null) return [String(direct)]

  const matchedKey = Object.keys(headers).find((headerKey) => headerKey.toLowerCase() === key.toLowerCase())
  if (!matchedKey) return []

  const matchedValue = headers[matchedKey]
  if (Array.isArray(matchedValue)) return matchedValue.map((item) => String(item))
  if (matchedValue !== undefined && matchedValue !== null) return [String(matchedValue)]

  return []
}

function normalizeCookieHeader(cookieHeader) {
  if (!cookieHeader) return ''

  const cookieMap = {}
  String(cookieHeader)
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => !!chunk)
    .forEach((cookiePair) => {
      const separatorIndex = cookiePair.indexOf('=')
      if (separatorIndex === -1) return
      const name = cookiePair.slice(0, separatorIndex).trim()
      const value = cookiePair.slice(separatorIndex + 1).trim()
      if (!name) return
      cookieMap[name] = value
    })

  return Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join('; ')
}

function extractCookieHeaderFromSetCookie(setCookieHeaders) {
  const cookieMap = {}

  setCookieHeaders.forEach((header) => {
    const cookiePair = String(header).split(';')[0].trim()
    if (!cookiePair) return

    const separatorIndex = cookiePair.indexOf('=')
    if (separatorIndex === -1) return

    const name = cookiePair.slice(0, separatorIndex).trim()
    const value = cookiePair.slice(separatorIndex + 1).trim()
    if (!name) return

    cookieMap[name] = value
  })

  return Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join('; ')
}

/**
 * 응답의 `Set-Cookie`를 기존 쿠키 헤더와 합칩니다.
 * @param {string | null | undefined} cookieHeader 현재 쿠키 헤더 문자열입니다.
 * @param {object | null | undefined} responseHeaders 응답 헤더 객체입니다.
 * @returns {string} 병합된 쿠키 헤더 문자열입니다.
 */
function mergeSetCookieIntoCookieHeader(cookieHeader, responseHeaders) {
  const setCookieHeaders = getHeaderValues(responseHeaders, 'Set-Cookie')
  if (!setCookieHeaders.length) return cookieHeader

  const nextCookie = normalizeCookieHeader(extractCookieHeaderFromSetCookie(setCookieHeaders))
  if (!nextCookie) return cookieHeader

  const merged = cookieHeader ? `${cookieHeader}; ${nextCookie}` : nextCookie
  return normalizeCookieHeader(merged)
}

/**
 * HTML 본문이 인증 필요 화면인지 확인합니다.
 * @param {unknown} html 응답 HTML 문자열입니다.
 * @returns {boolean} 인증 필요 화면이면 true입니다.
 */
function detectAuthRequiredHtml(html) {
  const text = String(html || '')
  if (text.includes('/staff/auth/login_check') || text.includes('id="mng_id"')) return true

  const redirectRegex = /location\.href\s*=\s*(?:'|")\s*\/staff\/auth\s*(?:'|")/i
  return redirectRegex.test(text)
}

function decodeHtmlEntities(text) {
  const source = String(text || '')
  return source
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeSingleLineText(text) {
  return decodeHtmlEntities(String(text || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeStructuredTextLine(line) {
  const trimmed = String(line || '')
    .replace(/\u00a0/g, ' ')
    .trim()
  if (!trimmed) return ''
  if (/^\*\s+/.test(trimmed)) return `- ${trimmed.replace(/^\*\s+/, '')}`
  if (/ {3,}/.test(trimmed)) return trimmed.replace(/ {3,}/g, ' | ')
  return trimmed
}

function normalizeStructuredText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => normalizeStructuredTextLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripTags(html) {
  return normalizeSingleLineText(inlineHtmlToText(String(html || '')))
}

function normalizeJobStatusMetricKey(label, index) {
  const compact = normalizeSingleLineText(label)
    .replace(/\s+/g, '')
    .replace(/[()]/g, '')
  if (!compact) return `row-${Math.max(0, Math.trunc(Number(index) || 0))}`
  if (/^(?:\d+월)?알선취업목표$/.test(compact) || compact === '월알선취업목표' || compact === '월알선목표') return 'month-target'
  if (compact.includes('금일알선건수')) return 'daily-count'
  if (compact.includes('알선취업예정자수') || compact.includes('알선예정자수')) return 'scheduled-count'
  if (compact.includes('금일알선면접건수') || compact.includes('알선면접건수') || compact.includes('알선자면접건수')) return 'interview-count'
  if (compact.includes('알선취업누적건수') || compact === '알선취업누적') return 'cumulative-count'
  return `row-${Math.max(0, Math.trunc(Number(index) || 0))}`
}

function parseJobStatusValue(cellText) {
  const text = normalizeSingleLineText(cellText)
  if (!text || text === '-' || text === '--') {
    return {
      text: '',
      valueNumber: null,
    }
  }

  const compact = text.replace(/,/g, '').replace(/\s+/g, '')
  const matchedNumber = compact.match(/^-?\d+(?:명|건)?$/)
  return {
    text,
    valueNumber: matchedNumber ? Math.trunc(Number((matchedNumber[0].match(/-?\d+/) || [''])[0])) : null,
  }
}

function buildJobStatusFallbackStaffName(columnIndex) {
  return `미기재 ${Math.max(1, Math.trunc(Number(columnIndex) || 1))}`
}

function parseHtmlTableCellsDetailed(tableHtml) {
  const rows = []
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch = null

  while ((trMatch = trRegex.exec(String(tableHtml || '')))) {
    const row = []
    const trInner = String(trMatch[1] || '')
    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch = null

    while ((cellMatch = cellRegex.exec(trInner))) {
      const cellHtml = String(cellMatch[1] || '')
      row.push({
        html: cellHtml,
        text: stripTags(cellHtml),
      })
    }

    if (row.length > 0) rows.push(row)
  }

  return rows
}

function parseHtmlTableRows(tableHtml) {
  return parseHtmlTableCellsDetailed(tableHtml).map((row) => row.map((cell) => cell.text))
}

function extractTableHtmlBlocks(html) {
  const source = String(html || '')
  const blocks = []
  const tagRegex = /<\/?table\b[^>]*>/gi
  const stack = []
  let tagMatch = null

  while ((tagMatch = tagRegex.exec(source))) {
    const tagText = String(tagMatch[0] || '')
    const isCloseTag = /^<\//.test(tagText)
    if (!isCloseTag) {
      stack.push(tagMatch.index)
      continue
    }

    const startIndex = stack.pop()
    if (!Number.isFinite(startIndex)) continue
    blocks.push({
      startIndex,
      endIndex: tagRegex.lastIndex,
      html: source.slice(startIndex, tagRegex.lastIndex),
    })
  }

  return blocks.sort((a, b) => a.startIndex - b.startIndex)
}

function isCompactSearchChar(char) {
  return /[0-9A-Za-z가-힣]/.test(String(char || ''))
}

function normalizeCompactSearchText(text) {
  return decodeHtmlEntities(String(text || ''))
    .replace(/<[^>]*>/g, ' ')
    .split('')
    .filter((char) => isCompactSearchChar(char))
    .join('')
    .toLowerCase()
}

function buildCompactHtmlTextIndex(html) {
  const source = String(html || '')
  const compactChars = []
  const htmlIndexes = []

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]

    if (current === '<') {
      const closeIndex = source.indexOf('>', index + 1)
      if (closeIndex === -1) break
      index = closeIndex
      continue
    }

    let decoded = current
    let consumedLength = 1
    if (current === '&') {
      const semiIndex = source.indexOf(';', index + 1)
      if (semiIndex !== -1 && semiIndex - index <= 10) {
        decoded = decodeHtmlEntities(source.slice(index, semiIndex + 1))
        consumedLength = semiIndex - index + 1
      }
    }

    String(decoded || '')
      .split('')
      .forEach((char) => {
        if (!isCompactSearchChar(char)) return
        compactChars.push(char.toLowerCase())
        htmlIndexes.push(index)
      })

    index += consumedLength - 1
  }

  return {
    compactText: compactChars.join(''),
    htmlIndexes,
  }
}

function findCompactTextVariant(compactIndex, variants, startOffset = 0) {
  const compactText = String((compactIndex && compactIndex.compactText) || '')
  const safeStartOffset = Math.max(0, Math.trunc(Number(startOffset) || 0))
  let best = null

  ;(Array.isArray(variants) ? variants : []).forEach((variant) => {
    const normalizedVariant = normalizeCompactSearchText(variant)
    if (!normalizedVariant) return

    const foundIndex = compactText.indexOf(normalizedVariant, safeStartOffset)
    if (foundIndex === -1) return

    if (!best || foundIndex < best.index) {
      best = {
        index: foundIndex,
        endIndex: foundIndex + normalizedVariant.length,
        htmlIndex: compactIndex && Array.isArray(compactIndex.htmlIndexes) ? compactIndex.htmlIndexes[foundIndex] : 0,
        variant: normalizedVariant,
      }
    }
  })

  return best
}

function isMeaningfulJobStatusCellText(text) {
  const normalized = normalizeSingleLineText(text)
  if (!normalized) return false
  if (normalized === '-' || normalized === '--') return false
  return true
}

function isRecognizedJobStatusMetricKey(key) {
  return key === 'month-target' || key === 'daily-count' || key === 'scheduled-count' || key === 'interview-count' || key === 'cumulative-count'
}

function isJobStatusTableRows(rows) {
  if (!Array.isArray(rows) || rows.length < 3) return false

  const headerRow = rows[0] || []
  const firstHeader = normalizeSingleLineText(headerRow[0] || '')
  if (firstHeader !== '구분') return false

  const headerNames = headerRow.slice(1).map((cell) => normalizeSingleLineText(cell)).filter(Boolean)
  if (headerNames.length < 1) return false

  const recognizedMetricCount = rows
    .slice(1)
    .map((row, index) => normalizeJobStatusMetricKey(row && row[0], index))
    .filter((key) => isRecognizedJobStatusMetricKey(key)).length

  return recognizedMetricCount >= 3
}

function buildJobStatusTitleFromContext(contextHtml) {
  const text = inlineHtmlToText(String(contextHtml || ''))
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => normalizeSingleLineText(line))
    .filter(Boolean)
  const matched = text.reverse().find((line) => /알선\s*취업|취업지원\s*현황|상담사\s*취업지원/i.test(line))
  if (!matched) return '알선취업자 현황'
  return matched.replace(/^(?:\d+\s*[.)]?\s*|[○●■]\s*)/, '').trim() || '알선취업자 현황'
}

/**
 * 업무일지 HTML에서 `알선취업자 현황` 표를 찾아 화면용 shape로 정리합니다.
 * @param {unknown} diaryHtml 업무일지 본문 HTML입니다.
 * @returns {types.KjcaJobStatusTable | null} 정리된 알선취업자 현황 표 또는 `null`입니다.
 */
function parseJobStatusTableFromDiaryHtml(diaryHtml) {
  const html = String(diaryHtml || '')
  if (!html) return null

  const candidate = extractTableHtmlBlocks(html)
    .map((block) => {
      const rows = parseHtmlTableRows(block.html).filter((row) => row.some((cell) => normalizeSingleLineText(cell)))
      if (!isJobStatusTableRows(rows)) return null
      return {
        title: buildJobStatusTitleFromContext(html.slice(Math.max(0, block.startIndex - 320), block.startIndex)),
        startIndex: block.startIndex,
        rows,
      }
    })
    .filter((item) => !!item)[0]

  if (!candidate) return null

  const title = normalizeSingleLineText(candidate.title || '알선취업자 현황') || '알선취업자 현황'
  const rawRows = candidate.rows
  if (rawRows.length < 2) return null

  const headerRow = rawRows[0] || []
  const metricRows = rawRows.slice(1)
  const columnCount = rawRows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0)
  const activeColumnIndexes = []

  for (let columnIndex = 1; columnIndex < columnCount; columnIndex += 1) {
    const headerName = normalizeSingleLineText(headerRow[columnIndex] || '')
    const hasAnyValue = metricRows.some((row) => isMeaningfulJobStatusCellText(row[columnIndex] || ''))
    if (!headerName && !hasAnyValue) continue
    activeColumnIndexes.push(columnIndex)
  }

  if (activeColumnIndexes.length === 0) return null

  const staffNames = activeColumnIndexes.map((columnIndex, arrayIndex) => {
    const headerName = normalizeSingleLineText(headerRow[columnIndex] || '')
    return headerName || buildJobStatusFallbackStaffName(arrayIndex + 1)
  })

  const rows = metricRows
    .map((row, index) => {
      const label = normalizeSingleLineText(row[0] || '')
      if (!label) return null

      return {
        key: normalizeJobStatusMetricKey(label, index),
        label,
        values: activeColumnIndexes.map((columnIndex) => parseJobStatusValue(row[columnIndex] || '')),
      }
    })
    .filter((row) => !!row)

  if (rows.length === 0) return null

  return {
    title,
    staffNames,
    rows,
  }
}

function normalizeRecruitingCellText(text) {
  const normalized = normalizeSingleLineText(text)
  if (!normalized || normalized === '-' || normalized === '--') return ''
  return normalized
}

function parseStrictRecruitingCount(text) {
  const normalized = normalizeRecruitingCellText(text).replace(/,/g, '')
  if (!normalized) return null

  const matched = normalized.match(/^(\d+)(?:\s*(?:건|명))?$/)
  if (!matched) return null

  return Math.max(0, Math.trunc(Number(matched[1] || 0)))
}

function parseRecruitingMonthTarget(summaryText) {
  const text = normalizeSingleLineText(summaryText)
  if (!text) return null

  const patterns = [/월\s*배정목표\s*[:：]?\s*(\d+)/i, /모집배정목표\s*[:：]?\s*(\d+)/i]
  for (let index = 0; index < patterns.length; index += 1) {
    const matched = text.match(patterns[index])
    if (!matched) continue
    return Math.max(0, Math.trunc(Number(matched[1] || 0)))
  }

  return null
}

function parseRecruitingMonthAssignedCurrent(summaryText) {
  const text = normalizeSingleLineText(summaryText)
  if (!text) return null

  const patterns = [
    /현재\s*(?:목표\s*)?달성[\s\S]{0,24}?배정\s*(\d+)\s*명/i,
    /현재\s*(?:목표\s*)?달성[\s\S]{0,24}?(\d+)\s*명/i,
    /현재\s*(?:목표\s*)?달성[\s\S]{0,32}?모집\s*[:：]?\s*(\d+)\s*건/i,
    /현재\s*(?:목표\s*)?달성[\s\S]{0,32}?(\d+)\s*(?:건|명)/i,
  ]

  for (let index = 0; index < patterns.length; index += 1) {
    const matched = text.match(patterns[index])
    if (!matched) continue
    return Math.max(0, Math.trunc(Number(matched[1] || 0)))
  }

  return null
}

function extractRecruitingSectionHtml(diaryHtml) {
  const source = String(diaryHtml || '')
  if (!source) return ''

  const compactIndex = buildCompactHtmlTextIndex(source)
  const startMatch = findCompactTextVariant(compactIndex, ['모집홍보', '홍보모집'])
  if (!startMatch) return source

  let sectionStart = source.indexOf('<table', startMatch.htmlIndex)
  if (sectionStart === -1 || sectionStart - startMatch.htmlIndex > 1600) {
    const previousTableIndex = source.lastIndexOf('<table', startMatch.htmlIndex)
    sectionStart = previousTableIndex === -1 ? startMatch.htmlIndex : previousTableIndex
  }

  const endMatch = findCompactTextVariant(
    compactIndex,
    ['알선취업현황', '알선취업', '상담사취업지원현황', '취업지원현황', '기타사항', '기타보고', '고용센터전달사항'],
    startMatch.endIndex
  )
  const sectionEnd = endMatch && endMatch.htmlIndex > sectionStart ? endMatch.htmlIndex : source.length

  return source.slice(sectionStart, sectionEnd)
}

function hasRecruitingHeaderLabels(rows) {
  const labels = []
  ;(Array.isArray(rows) ? rows : []).forEach((row) => {
    ;(Array.isArray(row) ? row : []).forEach((cell) => {
      const text = normalizeSingleLineText(cell)
      if (text) labels.push(text)
    })
  })

  const hasWeekdayHeader = labels.includes('요일')
  const hasChannelHeader = labels.some((label) => /모집\s*홍보(?:처|기관)/.test(label))
  const hasContentHeader = labels.some((label) => /모집\s*홍보내용/.test(label))
  const hasRecruitingHint = labels.some((label) => /주간\s*홍보\s*계획|배정목표|모집\s*[/.]?\s*홍보|홍보\s*모집|결과/.test(label))
  return hasWeekdayHeader && hasChannelHeader && hasContentHeader && hasRecruitingHint
}

function isRecruitingTableRows(rows) {
  if (!Array.isArray(rows) || rows.length < 4) return false
  if (!hasRecruitingHeaderLabels(rows)) return false

  const weekdayRows = rows.filter((row) => !!normalizeWeekday(row && row[0]))
  return weekdayRows.length >= 2
}

function detectRecruitingSchema(headerRows) {
  const labels = []
  ;(Array.isArray(headerRows) ? headerRows : []).forEach((row) => {
    ;(Array.isArray(row) ? row : []).forEach((cell) => {
      const text = normalizeSingleLineText(cell)
      if (text) labels.push(text)
    })
  })

  const hasTargetHeader = labels.some((label) => /모집\s*목표/.test(label))
  const hasCountHeader = labels.some((label) => /모집\s*건수/.test(label))
  if (hasTargetHeader && hasCountHeader) return 'standard'
  if (hasCountHeader) return 'count-only'
  return 'standard'
}

function buildRecruitingRowNote(resultText, noteText) {
  const result = normalizeRecruitingCellText(resultText)
  const note = normalizeRecruitingCellText(noteText)
  if (result && parseStrictRecruitingCount(result) !== null) return note
  if (!result) return note
  if (!note) return result
  if (note.includes(result)) return note
  return `${result} / ${note}`
}

function mapRecruitingBodyCells(bodyCells, schema) {
  const cells = Array.isArray(bodyCells) ? bodyCells.map((cell) => normalizeRecruitingCellText(cell)) : []

  while (cells.length < 6) {
    cells.push('')
  }

  const extraText = cells.slice(6).filter(Boolean).join(' / ')

  if (schema === 'count-only') {
    const channelName = cells[0] || ''
    const promotionContent = cells[1] || ''
    const targetText = cells[2] || ''
    const resultText = cells[3] || ''
    const ownerName = cells[4] || ''
    const note = buildRecruitingRowNote(resultText, [cells[5] || '', extraText].filter(Boolean).join(' / '))

    return {
      channelName,
      weeklyPlan: '',
      promotionContent,
      targetText,
      resultText,
      recruitCountText: resultText && parseStrictRecruitingCount(resultText) !== null ? resultText : targetText,
      ownerName,
      note,
    }
  }

  const channelName = cells[0] || ''
  const promotionContent = cells[1] || ''
  const targetText = cells[2] || ''
  const recruitCountText = cells[3] || ''
  const ownerName = cells[4] || ''
  const note = [cells[5] || '', extraText].filter(Boolean).join(' / ')

  return {
    channelName,
    weeklyPlan: '',
    promotionContent,
    targetText,
    resultText: '',
    recruitCountText,
    ownerName,
    note,
  }
}

function buildRecruitingWeekTableRows(rows, reportDate) {
  const plainRows = Array.isArray(rows) ? rows : []
  const firstWeekdayRowIndex = plainRows.findIndex((row) => !!normalizeWeekday(row && row[0]))
  if (firstWeekdayRowIndex === -1) {
    return {
      summaryText: '',
      rows: [],
      dailyActualCount: null,
      weekTarget: null,
    }
  }

  const summaryText = plainRows
    .slice(0, firstWeekdayRowIndex)
    .map((row) => row.map((cell) => normalizeSingleLineText(cell)).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ')
    .trim()

  const schema = detectRecruitingSchema(plainRows.slice(0, firstWeekdayRowIndex))
  const weekTableRows = []
  let currentWeekday = ''

  for (let rowIndex = firstWeekdayRowIndex; rowIndex < plainRows.length; rowIndex += 1) {
    const row = Array.isArray(plainRows[rowIndex]) ? plainRows[rowIndex] : []
    if (row.length === 0) continue

    const directWeekday = normalizeWeekday(row[0])
    const offset = directWeekday ? 1 : 0
    if (directWeekday) {
      currentWeekday = directWeekday
    }

    if (!currentWeekday) continue

    const bodyCells = row.slice(offset)
    if (bodyCells.every((cell) => !normalizeRecruitingCellText(cell))) continue

    const mapped = mapRecruitingBodyCells(bodyCells, schema)
    const hasMeaningfulContent =
      !!mapped.channelName || !!mapped.promotionContent || !!mapped.targetText || !!mapped.resultText || !!mapped.recruitCountText || !!mapped.ownerName || !!mapped.note

    if (!hasMeaningfulContent) continue

    weekTableRows.push({
      weekday: currentWeekday,
      ...mapped,
      sortOrder: weekTableRows.length,
    })
  }

  const dailyPlan = weekTableRows.map((row) => ({
    weekday: row.weekday,
    channelName: row.channelName,
    promotionContent: row.promotionContent,
    targetCount: parseStrictRecruitingCount(row.targetText),
    ownerName: row.ownerName,
    note: row.note,
  }))

  const numericTargetRows = dailyPlan.filter((row) => row.targetCount !== null)
  const weekTarget =
    numericTargetRows.length > 0 ? numericTargetRows.reduce((sum, row) => sum + Math.max(0, Math.trunc(Number(row.targetCount || 0))), 0) : null

  const reportWeekday = normalizeWeekday(toWeekdayKey(reportDate))
  const actualValues = weekTableRows
    .filter((row) => row.weekday === reportWeekday)
    .map((row) => parseStrictRecruitingCount(row.recruitCountText))
    .filter((value) => value !== null)

  return {
    summaryText,
    rows: weekTableRows,
    dailyPlan,
    dailyActualCount: actualValues.length > 0 ? actualValues.reduce((sum, value) => sum + Math.max(0, Math.trunc(Number(value || 0))), 0) : null,
    weekTarget,
  }
}

function isRecruitingLeakText(text) {
  const compact = normalizeCompactSearchText(text)
  if (!compact) return false

  return (
    compact.includes('알선취업목표') ||
    compact.includes('월알선목표') ||
    compact.includes('금일알선건수') ||
    compact.includes('알선취업예정자수') ||
    compact.includes('알선예정자수') ||
    compact.includes('알선면접건수') ||
    compact.includes('알선자면접건수') ||
    compact.includes('알선취업누적건수') ||
    compact.includes('알선취업누적') ||
    compact.includes('상담사취업지원현황') ||
    compact.includes('고용센터전달사항') ||
    compact.includes('지점특이사항') ||
    compact.includes('지점사항') ||
    compact.includes('기타건의사항') ||
    compact.includes('기타보고')
  )
}

function scoreRecruitingCandidate(parsedCandidate, blockHtml) {
  const rows = Array.isArray(parsedCandidate && parsedCandidate.rows) ? parsedCandidate.rows : []
  const distinctWeekdays = getDistinctWeekdayCount(rows)
  const nonEmptyFieldCount = rows.reduce((sum, row) => {
    return (
      sum +
      ['channelName', 'promotionContent', 'targetText', 'recruitCountText', 'ownerName', 'note']
        .map((key) => String((row && row[key]) || '').trim())
        .filter(Boolean).length
    )
  }, 0)
  const leakCount = rows.reduce((sum, row) => {
    return (
      sum +
      ['channelName', 'promotionContent', 'targetText', 'recruitCountText', 'ownerName', 'note']
        .map((key) => String((row && row[key]) || '').trim())
        .filter((value) => isRecruitingLeakText(value)).length
    )
  }, 0)
  const longFieldCount = rows.reduce((sum, row) => {
    return (
      sum +
      ['channelName', 'promotionContent', 'targetText', 'recruitCountText', 'ownerName', 'note']
        .map((key) => String((row && row[key]) || '').trim())
        .filter((value) => value.length >= 80).length
    )
  }, 0)

  let score = distinctWeekdays * 40 + rows.length * 12 + Math.min(20, nonEmptyFieldCount)
  if (parsedCandidate && parsedCandidate.summaryText) score += 5
  score -= leakCount * 240
  score -= longFieldCount * 30
  score -= Math.max(0, String(blockHtml || '').length - 12000) / 1000
  return score
}

function findBestRecruitingTableCandidate(html, reportDate) {
  return extractTableHtmlBlocks(html)
    .map((block) => {
      const rows = parseHtmlTableRows(block.html).filter((row) => row.some((cell) => normalizeSingleLineText(cell)))
      if (!isRecruitingTableRows(rows)) return null

      const parsed = buildRecruitingWeekTableRows(rows, reportDate)
      if (!parsed.rows.length) return null

      return {
        summaryText: parsed.summaryText,
        rows: parsed.rows,
        dailyPlan: parsed.dailyPlan,
        dailyActualCount: parsed.dailyActualCount,
        weekTarget: parsed.weekTarget,
        score: scoreRecruitingCandidate(parsed, block.html),
        htmlLength: String(block.html || '').length,
        startIndex: block.startIndex,
      }
    })
    .filter((item) => !!item)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.htmlLength !== b.htmlLength) return a.htmlLength - b.htmlLength
      return a.startIndex - b.startIndex
    })[0]
}

/**
 * 업무일지 HTML에서 `모집/홍보` 주간표를 찾아 화면용 shape로 정리합니다.
 * @param {unknown} diaryHtml 업무일지 본문 HTML입니다.
 * @param {unknown} reportDate 조회 기준 일자입니다.
 * @returns {types.KjcaRecruitingExtract | null} 정리된 모집/홍보 추출값 또는 `null`입니다.
 */
function parseRecruitingExtractFromDiaryHtml(diaryHtml, reportDate) {
  const html = String(diaryHtml || '')
  if (!html) return null

  const sectionHtml = extractRecruitingSectionHtml(html)
  const candidate = findBestRecruitingTableCandidate(sectionHtml, reportDate) || (sectionHtml !== html ? findBestRecruitingTableCandidate(html, reportDate) : null)

  if (!candidate) return null

  const monthTarget = parseRecruitingMonthTarget(candidate.summaryText)
  const monthAssignedCurrent = parseRecruitingMonthAssignedCurrent(candidate.summaryText)

  return normalizeRecruitingExtract({
    monthTarget,
    monthAssignedCurrent,
    weekTarget: candidate.weekTarget,
    dailyPlan: candidate.dailyPlan,
    dailyActualCount: candidate.dailyActualCount,
    weekTableRows: candidate.rows,
  })
}

function normalizeMiscSectionKey(label, index) {
  const compact = normalizeSingleLineText(label)
    .replace(/\s+/g, '')
    .replace(/[()]/g, '')
    .replace(/[.:]/g, '')
  if (!compact) return `item-${Math.max(0, Math.trunc(Number(index) || 0))}`
  if (compact.includes('고용센터전달사항')) return 'employment-center'
  if (compact.includes('지점특이사항') || compact.includes('지점사항')) return 'branch-notes'
  if (compact.includes('기타건의사항') || compact.includes('기타보고건의사항') || compact === '기타보고') return 'suggestions'
  return `item-${Math.max(0, Math.trunc(Number(index) || 0))}`
}

function buildMiscItemLabel(key, fallbackLabel) {
  const fallback = normalizeSingleLineText(fallbackLabel || '')
  if (key === 'employment-center') return '고용센터 전달사항'
  if (key === 'branch-notes') return '지점 특이사항'
  if (key === 'suggestions') return '기타 건의사항'
  return fallback
}

function normalizeMiscSectionTitleText(title) {
  const text = normalizeSingleLineText(title || '')
  if (!text) return '기타 사항'
  if (/기타\s*사항|기타보고|건의사항/i.test(text)) return '기타 사항'
  return '기타 사항'
}

function normalizeMiscContentText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => normalizeSingleLineText(line))
    .filter((line, index, array) => !!line || (index > 0 && index < array.length - 1))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildMiscSectionTitleFromContext(contextHtml) {
  const text = inlineHtmlToText(String(contextHtml || ''))
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => normalizeSingleLineText(line))
    .filter(Boolean)
  const matched = text.reverse().find((line) => /기타\s*사항|기타보고|건의사항/i.test(line))
  if (!matched) return '기타 사항'
  return normalizeMiscSectionTitleText(matched.replace(/^(?:['"]+|(?:\d+\s*[.)]?\s*|[○●■]\s*))+/, '').trim())
}

function isRecognizedMiscKey(key) {
  return key === 'employment-center' || key === 'branch-notes' || key === 'suggestions'
}

function isMiscRowTable(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false
  const firstRow = rows[0] || []
  const headerLabel = normalizeSingleLineText(firstRow[0] || '')
  const recognizedCount = rows
    .slice(1)
    .map((row, index) => normalizeMiscSectionKey(row && row[0], index))
    .filter((key) => isRecognizedMiscKey(key)).length

  if (headerLabel === '구분' && recognizedCount >= 2) return true
  return recognizedCount >= 2
}

function parseMiscItemsFromRowTable(detailedRows) {
  return detailedRows
    .slice(1)
    .map((row, index) => {
      const label = normalizeSingleLineText(row && row[0] ? row[0].text : '')
      const key = normalizeMiscSectionKey(label, index)
      if (!isRecognizedMiscKey(key)) return null

      const contentHtml = row && row[1] ? row[1].html : ''
      const content = normalizeMiscContentText(htmlToText(contentHtml))
      return {
        key,
        label: buildMiscItemLabel(key, label),
        content,
      }
    })
    .filter((item) => !!item && !!item.content)
}

function parseMiscItemsFromBulletText(text) {
  const lines = String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => normalizeSingleLineText(line))

  const items = []
  let current = null

  const pushCurrent = () => {
    if (!current || !isRecognizedMiscKey(current.key)) return
    const content = normalizeMiscContentText(current.lines.join('\n'))
    if (!content) return
    items.push({
      key: current.key,
      label: buildMiscItemLabel(current.key, current.label),
      content,
    })
  }

  lines.forEach((line, index) => {
    if (!line) {
      if (current) current.lines.push('')
      return
    }

    const bulletMatch = line.match(/^[○●■]\s*(.+)$/)
    if (bulletMatch) {
      pushCurrent()
      const rawHeading = normalizeSingleLineText(bulletMatch[1] || '')
      const headingParts = rawHeading.split(/\s*:\s*/, 2)
      const label = headingParts[0] || rawHeading
      current = {
        key: normalizeMiscSectionKey(label, index),
        label,
        lines: headingParts[1] ? [headingParts[1]] : [],
      }
      return
    }

    if (!current) return
    current.lines.push(line)
  })

  pushCurrent()

  return items.filter((item) => isRecognizedMiscKey(item.key))
}

/**
 * 업무일지 HTML에서 마지막 기타 사항/기타보고 영역을 찾아 화면용 shape로 정리합니다.
 * @param {unknown} diaryHtml 업무일지 본문 HTML입니다.
 * @returns {types.KjcaMiscSection | null} 정리된 기타 사항 섹션 또는 `null`입니다.
 */
function parseMiscSectionFromDiaryHtml(diaryHtml) {
  const html = String(diaryHtml || '')
  if (!html) return null

  const tableBlocks = extractTableHtmlBlocks(html)

  for (let index = 0; index < tableBlocks.length; index += 1) {
    const block = tableBlocks[index]
    const detailedRows = parseHtmlTableCellsDetailed(block.html).filter((row) => row.some((cell) => normalizeSingleLineText(cell && cell.text)))
    const plainRows = detailedRows.map((row) => row.map((cell) => cell.text))
    if (!isMiscRowTable(plainRows)) continue

    const items = parseMiscItemsFromRowTable(detailedRows)
    if (items.length === 0) continue

    return {
      title: buildMiscSectionTitleFromContext(html.slice(Math.max(0, block.startIndex - 320), block.startIndex)),
      items,
    }
  }

  for (let index = 0; index < tableBlocks.length; index += 1) {
    const block = tableBlocks[index]
    const blockText = htmlToText(block.html)
    if (!/고용센터\s*전달사항|지점\s*(?:특이사항|사항)|기타\s*(?:건의사항|보고)/i.test(blockText)) continue

    const items = parseMiscItemsFromBulletText(blockText)
    if (items.length === 0) continue

    return {
      title: buildMiscSectionTitleFromContext(html.slice(Math.max(0, block.startIndex - 320), block.startIndex)) || '기타 사항',
      items,
    }
  }

  return null
}

/**
 * KJCA 상대 경로를 절대 URL로 바꿉니다.
 * @param {string} host KJCA 호스트입니다.
 * @param {unknown} maybeRelativeUrl 상대 또는 절대 URL 값입니다.
 * @returns {string} 절대 URL 문자열입니다.
 */
function toAbsoluteKjcaUrl(host, maybeRelativeUrl) {
  const url = String(maybeRelativeUrl || '').trim()
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('?')) return `${host}/diary/${url}`
  if (url.startsWith('/?') && url.includes('bd_idx=')) return `${host}/diary${url}`
  if (url.startsWith('/')) return `${host}${url}`
  return `${host}/${url}`
}

/**
 * 허용된 KJCA 호스트 URL인지 확인합니다.
 * @param {string} host KJCA 호스트입니다.
 * @param {unknown} url 검사할 URL 값입니다.
 * @returns {boolean} 허용된 URL이면 true입니다.
 */
function isAllowedKjcaUrl(host, url) {
  const normalized = String(url || '').trim()
  return normalized.startsWith(`${host}/`) || normalized.startsWith('http://www.kjca.co.kr/') || normalized.startsWith('https://www.kjca.co.kr/')
}

function absolutizeQuotedKjcaUrl(host, rawUrl) {
  const candidate = String(rawUrl || '').trim()
  if (!candidate) return ''
  if (candidate === '#') return ''
  if (/^javascript:/i.test(candidate)) return ''
  if (/^void\(0\)/i.test(candidate)) return ''
  if (/^https?:\/\//i.test(candidate)) return candidate
  if (candidate.startsWith('?')) return toAbsoluteKjcaUrl(host, candidate)
  if (candidate.startsWith('/?')) return toAbsoluteKjcaUrl(host, candidate)
  if (candidate.startsWith('/diary/')) return toAbsoluteKjcaUrl(host, candidate)
  if (candidate.startsWith('/') && candidate.includes('bd_idx=')) return toAbsoluteKjcaUrl(host, candidate)
  return ''
}

function buildLinkifySourceFromCell(host, cellHtml) {
  const source = decodeHtmlEntities(String(cellHtml || ''))
  if (!source) return ''

  return source.replace(/(['"])((?:https?:\/\/|\/|\?)[^'"<>\s]+)\1/gi, (full, quote, rawUrl) => {
    const absoluteUrl = absolutizeQuotedKjcaUrl(host, rawUrl)
    if (!absoluteUrl) return full
    return `${quote}${absoluteUrl}${quote}`
  })
}

function extractPrintUrlFromCell(host, cellHtml) {
  const source = buildLinkifySourceFromCell(host, cellHtml)
  if (!source) return ''

  const matches = kjcaLinkify.pretest(source) ? kjcaLinkify.match(source) || [] : []
  const seen = {}
  const normalized = matches
    .map((match) => toAbsoluteKjcaUrl(host, match && match.url))
    .filter((candidate) => !!candidate)
    .filter((candidate) => isAllowedKjcaUrl(host, candidate))
    .filter((candidate) => candidate.includes('bd_idx=') || candidate.includes('/diary/'))
    .filter((candidate) => {
      if (seen[candidate]) return false
      seen[candidate] = true
      return true
    })

  if (!normalized.length) return ''

  const preferred = normalized.find((candidate) => candidate.includes('bd_idx=')) || normalized.find((candidate) => candidate.includes('/diary/') || candidate.startsWith('?site=')) || normalized[0]

  return toAbsoluteKjcaUrl(host, preferred)
}

/**
 * 업무일지 목록 HTML에서 팀장 행과 인쇄 URL을 추출합니다.
 * @param {unknown} diaryHtml 업무일지 목록 HTML입니다.
 * @param {string} host KJCA 호스트입니다.
 * @returns {{ rows: types.KjcaTeamLeadRow[] }} 추출된 팀장 행 목록입니다.
 */
function parseTeamLeadRowsFromDiaryHtml(diaryHtml, host) {
  const html = String(diaryHtml || '')
  const rows = []
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch = null

  while ((trMatch = trRegex.exec(html))) {
    const trInner = trMatch[1] || ''
    if (!trInner.includes('data-label')) continue

    const cellHtmlByLabel = {}
    const tdRegex = /<td\b[^>]*data-label\s*=\s*(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/td>/gi
    let tdMatch = null
    while ((tdMatch = tdRegex.exec(trInner))) {
      const label = stripTags(tdMatch[2])
      const cellInner = tdMatch[3] || ''
      if (!label) continue
      cellHtmlByLabel[label] = cellInner
    }

    const position = stripTags(cellHtmlByLabel['직책'] || '')
    if (position !== '팀장') continue

    const dept = stripTags(cellHtmlByLabel['부서'] || '')
    const staffName = stripTags(cellHtmlByLabel['성명'] || '')
    const printCell = String(cellHtmlByLabel['인쇄'] || '')
    const printUrl = extractPrintUrlFromCell(host, printCell)

    rows.push({
      dept,
      position,
      staffName,
      printUrl,
    })
  }

  const seen = {}
  const uniqueRows = []
  rows.forEach((row) => {
    const key = row.dept || ''
    if (!key || seen[key]) return
    seen[key] = true
    uniqueRows.push(row)
  })

  return { rows: uniqueRows }
}

/**
 * KJCA 요청에 맞는 브라우저형 헤더를 만듭니다.
 * @param {string} host KJCA 호스트입니다.
 * @param {string | null | undefined} cookieHeader 현재 쿠키 헤더입니다.
 * @param {string | null | undefined} referer 참조 URL입니다.
 * @returns {object} 요청에 사용할 헤더 객체입니다.
 */
function buildBrowserLikeHeaders(host, cookieHeader, referer) {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    Host: host.replace(/^https?:\/\//i, ''),
  }

  if (cookieHeader) headers.Cookie = cookieHeader
  if (referer) headers.Referer = referer
  return headers
}

function buildTodayDateText() {
  const now = new Date()
  const year = now.getFullYear()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 날짜 입력값을 `YYYY-MM-DD` 형식으로 정규화합니다.
 * @param {string | string[] | null | undefined} value 폼이나 params에서 받은 날짜 값입니다.
 * @returns {string} 정규화된 날짜 문자열입니다.
 */
function normalizeReportDate(value) {
  const text = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return buildTodayDateText()
}

/**
 * 화면에서 쓰는 기본 폼 상태를 원본 입력값에서 정규화합니다.
 * @param {types.KjcaFormStateInput | null | undefined} value 페이지나 폼에서 받은 원본 입력값입니다.
 * @returns {types.KjcaFormState} 화면에서 바로 쓸 수 있는 폼 상태입니다.
 */
function buildFormState(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    reportDate: normalizeReportDate(source.reportDate),
    testOneOnly: normalizeBool(source.testOneOnly),
  }
}

/**
 * PocketBase filter 문자열에서 쓸 값을 이스케이프합니다.
 * @param {unknown} value filter에 넣을 원본 값입니다.
 * @returns {string} 이스케이프된 문자열입니다.
 */
function escapeFilterValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
}

/**
 * 텍스트를 짧은 캐시 키 문자열로 해시합니다.
 * @param {unknown} text 해시할 원본 텍스트입니다.
 * @returns {string} 길이를 포함한 해시 문자열입니다.
 */
function hashText(text) {
  const source = String(text || '')
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
    hash >>>= 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${source.length}`
}

/**
 * class 조합으로 특정 div의 내부 HTML을 추출합니다.
 * @param {unknown} html 원본 HTML 문자열입니다.
 * @param {string[]} requiredClasses 찾아야 할 class 목록입니다.
 * @returns {string} 찾은 div의 내부 HTML입니다.
 */
function extractDivInnerHtmlByClasses(html, requiredClasses) {
  const source = String(html || '')
  if (!source) return ''

  const divStartRegex = /<div\b[^>]*class\s*=\s*(['"])([^'"]*)\1[^>]*>/gi
  let match = null
  while ((match = divStartRegex.exec(source))) {
    const classValue = String(match[2] || '')
    const ok = requiredClasses.every((cls) => new RegExp(`\\b${cls}\\b`).test(classValue))
    if (!ok) continue

    const openTagEndIndex = match.index + match[0].length
    const tokenRegex = /<\/?div\b/gi
    tokenRegex.lastIndex = openTagEndIndex
    let depth = 1

    let tokenMatch = null
    while ((tokenMatch = tokenRegex.exec(source))) {
      const token = String(tokenMatch[0] || '').toLowerCase()
      if (token === '<div') {
        depth += 1
        continue
      }

      if (token === '</div') {
        depth -= 1
        if (depth === 0) {
          const closeTagStartIndex = tokenMatch.index
          return source.slice(openTagEndIndex, closeTagStartIndex)
        }
      }
    }

    return ''
  }

  return ''
}

/**
 * HTML을 읽기 쉬운 텍스트로 정리합니다.
 * @param {unknown} html 원본 HTML 문자열입니다.
 * @returns {string} 정리된 텍스트입니다.
 */
function htmlToText(html) {
  return normalizeStructuredText(structuredHtmlToText(String(html || '')))
}

/**
 * 문자열 배열 입력을 빈 값 없는 문자열 배열로 정리합니다.
 * @param {unknown} value 원본 배열 값입니다.
 * @returns {string[]} 정리된 문자열 배열입니다.
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter((item) => !!item)
}

function isNumericByteArray(value) {
  if (!Array.isArray(value)) return false
  if (!value.length) return false
  return value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
}

/**
 * JSON 배열 필드를 문자열 배열로 정리합니다.
 * @param {unknown} value 문자열, 배열, 바이트 배열 등 원본 값입니다.
 * @returns {string[]} 정리된 문자열 배열입니다.
 */
function normalizeJsonArrayField(value) {
  if (Array.isArray(value)) {
    if (isNumericByteArray(value)) {
      const text = String(toString(value) || '').trim()
      if (!text) return []
      const parsedFromBytes = parseJsonSafely(text, null)
      if (Array.isArray(parsedFromBytes)) return normalizeStringArray(parsedFromBytes)
      return []
    }
    return normalizeStringArray(value)
  }

  if (value === null || value === undefined) return []

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    const parsed = parseJsonSafely(trimmed, null)
    if (Array.isArray(parsed)) return normalizeStringArray(parsed)
    return normalizeStringArray([trimmed])
  }

  return []
}

/**
 * Gemini 429 응답의 원인을 추정합니다.
 * @param {unknown} message 오류 메시지 값입니다.
 * @param {unknown} detailsText 세부 오류 텍스트입니다.
 * @returns {string} 추정된 원인 키입니다.
 */
function inferGemini429Cause(message, detailsText) {
  const source = `${String(message || '')} ${String(detailsText || '')}`.toLowerCase()
  if (!source.trim()) return 'unknown'

  const hasQuotaSignal = source.includes('quota') || source.includes('billing') || source.includes('free tier') || source.includes('resource_exhausted')
  if (hasQuotaSignal) return 'quota-or-billing-limit'

  const hasRateSignal = source.includes('rate') || source.includes('too many requests') || source.includes('per minute') || source.includes('retry')
  if (hasRateSignal) return 'request-rate-limit'

  return 'unknown'
}

/**
 * Gemini 오류 detail 배열을 로그용 문자열로 합칩니다.
 * @param {unknown} details 오류 detail 배열 값입니다.
 * @returns {string} 직렬화된 detail 문자열입니다.
 */
function stringifyGeminiErrorDetails(details) {
  if (!Array.isArray(details)) return ''
  return details
    .map((detail) => {
      if (detail === null || detail === undefined) return ''
      const text = `${detail}`
      return text === '[object Object]' ? JSON.stringify(detail) : text
    })
    .join(' | ')
}

function parseDateText(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date()
  const [year, month, day] = text.split('-').map((unit) => Number(unit))
  return new Date(year, month - 1, day)
}

function formatDateText(date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 주어진 날짜가 속한 주의 월요일 날짜를 계산합니다.
 * @param {unknown} dateText 기준이 되는 날짜 값입니다.
 * @returns {string} 해당 주 월요일의 날짜 문자열입니다.
 */
function buildWeekStartDate(dateText) {
  const date = parseDateText(dateText)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(date)
  monday.setDate(date.getDate() + diff)
  return formatDateText(monday)
}

/**
 * 날짜를 기준으로 업무일지 집계용 요일 키를 계산합니다.
 * @param {unknown} dateText 기준이 되는 날짜 값입니다.
 * @returns {types.KjcaWeekday} `mon`부터 `fri` 중 하나의 요일 키입니다.
 */
function toWeekdayKey(dateText) {
  const day = parseDateText(dateText).getDay()
  if (day === 1) return 'mon'
  if (day === 2) return 'tue'
  if (day === 3) return 'wed'
  if (day === 4) return 'thu'
  return 'fri'
}

/**
 * 다양한 요일 표현을 내부 요일 키로 정규화합니다.
 * @param {unknown} value 문자열 또는 외부 입력으로 받은 요일 값입니다.
 * @returns {types.KjcaWeekday | ""} 인식 가능한 경우 내부 요일 키, 아니면 빈 문자열입니다.
 */
function normalizeWeekday(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
  if (text === 'mon' || text === 'monday' || text === '월') return 'mon'
  if (text === 'tue' || text === 'tuesday' || text === '화') return 'tue'
  if (text === 'wed' || text === 'wednesday' || text === '수') return 'wed'
  if (text === 'thu' || text === 'thursday' || text === '목') return 'thu'
  if (text === 'fri' || text === 'friday' || text === '금') return 'fri'
  return ''
}

/**
 * 날짜 exact/like filter 파라미터를 만듭니다.
 * @param {unknown} dateText 기준 날짜 값입니다.
 * @returns {{ exact: string, like: string }} exact와 like용 날짜 문자열입니다.
 */
function buildDateMatchParams(dateText) {
  const normalized = formatDateText(parseDateText(dateText))
  return {
    exact: normalized,
    like: `${normalized}%`,
  }
}

/**
 * 정수를 읽되 비어 있거나 잘못된 값은 null로 돌립니다.
 * @param {unknown} value 원본 숫자 값입니다.
 * @returns {number | null} 정수 값 또는 null입니다.
 */
function normalizeNullableInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.trunc(parsed))
}

/**
 * 필수 정수를 읽고 없으면 기본값을 사용합니다.
 * @param {unknown} value 원본 숫자 값입니다.
 * @param {number} fallback 대체 기본값입니다.
 * @returns {number} 정수 값입니다.
 */
function normalizeRequiredInt(value, fallback) {
  const parsed = normalizeNullableInt(value)
  if (parsed === null) return fallback
  return parsed
}

/**
 * 다양한 불리언 표현을 실제 boolean 값으로 정규화합니다.
 * @param {boolean | string | string[] | null | undefined} value 폼이나 params에서 받은 원본 값입니다.
 * @returns {boolean} 정규화된 불리언 값입니다.
 */
function normalizeBool(value) {
  if (value === true || value === false) return value
  const text = String(value || '')
    .trim()
    .toLowerCase()
  if (text === 'true' || text === '1' || text === 'y' || text === 'yes' || text === 'on') return true
  return false
}

function normalizeJobStatusMetricValues(values, expectedLength) {
  const source = Array.isArray(values) ? values : []
  const normalized = source.slice(0, expectedLength).map((item) => {
    const value = item && typeof item === 'object' ? item : {}
    return {
      text: String(value.text || '').trim(),
      valueNumber: Number.isFinite(Number(value.valueNumber)) ? Math.trunc(Number(value.valueNumber)) : null,
    }
  })

  while (normalized.length < expectedLength) {
    normalized.push({
      text: '',
      valueNumber: null,
    })
  }

  return normalized
}

/**
 * 기타 사항 섹션을 서비스 shape로 정리합니다.
 * @param {unknown} value 원본 섹션 값입니다.
 * @returns {types.KjcaMiscSection | null} 정리된 기타 사항 섹션입니다.
 */
function normalizeMiscSection(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source) return null

  const items = Array.isArray(source.items)
    ? source.items
        .map((item, index) => {
          const row = item && typeof item === 'object' ? item : {}
          const key = String(row.key || normalizeMiscSectionKey(row.label, index)).trim()
          if (!isRecognizedMiscKey(key)) return null

          const content = normalizeMiscContentText(row.content || '')
          if (!content) return null

          return {
            key,
            label: buildMiscItemLabel(key, row.label),
            content,
          }
        })
        .filter((item) => !!item)
    : []

  if (items.length === 0) return null

  return {
    title: normalizeMiscSectionTitleText(source.title || '기타 사항'),
    items,
  }
}

/**
 * 알선취업자 현황 표를 서비스 shape로 정리합니다.
 * @param {unknown} value 원본 표 값입니다.
 * @returns {types.KjcaJobStatusTable | null} 정리된 표 값입니다.
 */
function normalizeJobStatusTable(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source) return null

  const staffNames = Array.isArray(source.staffNames)
    ? source.staffNames.map((item, index) => normalizeSingleLineText(item) || buildJobStatusFallbackStaffName(index + 1)).filter(Boolean)
    : []

  if (staffNames.length === 0) return null

  const rows = Array.isArray(source.rows)
    ? source.rows
        .map((item, index) => {
          const row = item && typeof item === 'object' ? item : {}
          const label = normalizeSingleLineText(row.label || '')
          if (!label) return null

          return {
            key: String(row.key || normalizeJobStatusMetricKey(label, index)).trim(),
            label,
            values: normalizeJobStatusMetricValues(row.values, staffNames.length),
          }
        })
        .filter((row) => !!row)
    : []

  if (rows.length === 0) return null

  return {
    title: normalizeSingleLineText(source.title || '알선취업자 현황') || '알선취업자 현황',
    staffNames,
    rows,
  }
}

/**
 * AI 분석 결과의 recruiting 필드를 서비스 shape로 정리합니다.
 * @param {unknown} value recruiting 원본 값입니다.
 * @returns {types.KjcaRecruitingExtract} 정리된 recruiting 값입니다.
 */
function normalizeRecruitingExtract(value) {
  const source = value && typeof value === 'object' ? value : {}
  const dailyPlanRaw = Array.isArray(source.dailyPlan) ? source.dailyPlan : []
  const dailyPlan = dailyPlanRaw
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {}
      const weekday = normalizeWeekday(row.weekday)
      if (!weekday) return null

      return {
        weekday,
        channelName: String(row.channelName || '').trim(),
        promotionContent: String(row.promotionContent || '').trim(),
        targetCount: normalizeNullableInt(row.targetCount),
        ownerName: String(row.ownerName || '').trim(),
        note: String(row.note || '').trim(),
      }
    })
    .filter((item) => !!item)

  const weekTableRowsRaw = Array.isArray(source.weekTableRows) ? source.weekTableRows : []
  const weekTableRowsNormalized = weekTableRowsRaw
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {}
      const weekday = normalizeWeekday(row.weekday)
      if (!weekday) return null

      return {
        weekday,
        channelName: String(row.channelName || row.promotionChannel || '').trim(),
        weeklyPlan: String(row.weeklyPlan || row.plan || '').trim(),
        promotionContent: String(row.promotionContent || '').trim(),
        targetText: String(row.targetText || row.target || '').trim(),
        resultText: String(row.resultText || row.result || '').trim(),
        recruitCountText: String(row.recruitCountText || row.countText || '').trim(),
        ownerName: String(row.ownerName || '').trim(),
        note: String(row.note || '').trim(),
        sortOrder: Math.max(0, Math.trunc(Number(row.sortOrder || 0))),
      }
    })
    .filter((item) => !!item)

  const weekTableRowsFallback = dailyPlan
    .map((row, index) => ({
      weekday: row.weekday,
      channelName: row.channelName,
      weeklyPlan: '',
      promotionContent: row.promotionContent,
      targetText: row.targetCount === null ? '' : String(row.targetCount),
      resultText: '',
      recruitCountText: '',
      ownerName: row.ownerName,
      note: row.note,
      sortOrder: index,
    }))
    .filter((row) => !!row.channelName || !!row.weeklyPlan || !!row.promotionContent || !!row.targetText || !!row.resultText || !!row.recruitCountText || !!row.ownerName || !!row.note)

  return {
    monthTarget: normalizeNullableInt(source.monthTarget),
    monthAssignedCurrent: normalizeNullableInt(source.monthAssignedCurrent),
    weekTarget: normalizeNullableInt(source.weekTarget),
    jobStatusTable: normalizeJobStatusTable(source.jobStatusTable),
    dailyPlan,
    dailyActualCount: normalizeNullableInt(source.dailyActualCount),
    weekTableRows: weekTableRowsNormalized.length > 0 ? weekTableRowsNormalized : weekTableRowsFallback,
  }
}

/**
 * 캐시에 저장된 recruiting 필드를 서비스 shape로 복원합니다.
 * @param {unknown} value 캐시에서 읽은 원본 값입니다.
 * @returns {types.KjcaRecruitingExtract} 정리된 recruiting 값입니다.
 */
function normalizeCachedRecruitingField(value) {
  if (value === null || value === undefined) return normalizeRecruitingExtract({})
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return normalizeRecruitingExtract({})
    return normalizeRecruitingExtract(parseJsonSafely(text, {}))
  }
  if (Array.isArray(value)) {
    const isByteArray = value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
    if (!isByteArray) return normalizeRecruitingExtract({})
    const text = String(toString(value) || '').trim()
    if (!text) return normalizeRecruitingExtract({})
    return normalizeRecruitingExtract(parseJsonSafely(text, {}))
  }
  return normalizeRecruitingExtract(value)
}

/**
 * 팀장 목록 응답을 화면에서 쓰는 행 배열로 정리합니다.
 * @param {unknown} value 외부 응답이나 저장값에서 받은 팀장 목록 값입니다.
 * @returns {types.KjcaTeamLeadRow[]} 정규화된 팀장 행 목록입니다.
 */
function normalizeTeamLeadRows(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((row) => {
      const item = row && typeof row === 'object' ? row : {}
      return {
        dept: String(item.dept || '').trim(),
        position: String(item.position || '').trim(),
        staffName: String(item.staffName || '').trim(),
        printUrl: String(item.printUrl || '').trim(),
      }
    })
    .filter((row) => !!row.dept && !!row.printUrl)
}

/**
 * 분석 결과 목록을 화면과 후속 저장에 맞는 shape로 정리합니다.
 * @param {unknown} value 분석 API나 캐시에서 받은 결과 목록 값입니다.
 * @returns {types.KjcaAnalyzeResult[]} 정규화된 분석 결과 목록입니다.
 */
function normalizeAnalyzeResults(value) {
  const rows = Array.isArray(value) ? value : []
  return rows.map((item) => ({
    dept: String((item && item.dept) || '').trim(),
    position: String((item && item.position) || '').trim(),
    staffName: String((item && item.staffName) || '').trim(),
    ok: !(item && item.ok === false),
    error: String((item && item.error) || '').trim(),
    promotion: Array.isArray(item && item.promotion) ? item.promotion.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    vacation: Array.isArray(item && item.vacation) ? item.vacation.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    special: Array.isArray(item && item.special) ? item.special.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    miscSection: normalizeMiscSection(item && item.miscSection),
    recruiting: normalizeRecruitingExtract(item && item.recruiting),
    printUrl: String((item && item.printUrl) || '').trim(),
  }))
}

/**
 * 주간 텍스트 행 목록을 내부 shape로 정리합니다.
 * @param {unknown} rows 원본 행 목록 값입니다.
 * @returns {types.KjcaWeekTextRow[]} 정리된 주간 텍스트 행 목록입니다.
 */
function normalizeWeekTextRows(rows) {
  if (!Array.isArray(rows)) return []

  return rows
    .map((item, index) => {
      const row = item && typeof item === 'object' ? item : {}
      const weekday = normalizeWeekday(row.weekday)
      if (!weekday) return null

      return {
        weekday,
        channelName: String(row.channelName || '').trim(),
        weeklyPlan: String(row.weeklyPlan || '').trim(),
        promotionContent: String(row.promotionContent || '').trim(),
        targetText: String(row.targetText || '').trim(),
        resultText: String(row.resultText || '').trim(),
        recruitCountText: String(row.recruitCountText || '').trim(),
        ownerName: String(row.ownerName || '').trim(),
        note: String(row.note || '').trim(),
        sortOrder: Number.isFinite(Number(row.sortOrder)) ? Math.trunc(Number(row.sortOrder)) : index,
      }
    })
    .filter((row) => !!row)
}

/**
 * 주간 텍스트 행을 월-금 기준으로 빈 행까지 채워 정렬합니다.
 * @param {unknown} rows 원본 행 목록 값입니다.
 * @returns {types.KjcaWeekTextRow[]} 월-금 기준으로 채워진 행 목록입니다.
 */
function ensureWeekdayRows(rows) {
  const normalized = normalizeWeekTextRows(rows)
  const byWeekday = new Map()
  normalized.forEach((row) => {
    const key = row.weekday
    if (!byWeekday.has(key)) byWeekday.set(key, [])
    byWeekday.get(key).push(row)
  })

  const result = []
  WEEKDAY_ORDER.forEach((weekday) => {
    const items = byWeekday.get(weekday) || []
    if (items.length === 0) {
      result.push({
        weekday,
        channelName: '',
        weeklyPlan: '',
        promotionContent: '',
        targetText: '',
        resultText: '',
        recruitCountText: '',
        ownerName: '',
        note: '',
        sortOrder: 0,
      })
      return
    }

    items.sort((a, b) => a.sortOrder - b.sortOrder).forEach((item, index) => result.push({ ...item, sortOrder: index }))
  })

  return result
}

/**
 * 주간 텍스트 행에 실제 내용이 있는지 확인합니다.
 * @param {types.KjcaWeekTextRow[]} rows 검사할 행 목록입니다.
 * @returns {boolean} 내용이 있으면 true입니다.
 */
function hasWeekTextContent(rows) {
  return rows.some(
    (row) =>
      !!String(row.channelName || '').trim() ||
      !!String(row.weeklyPlan || '').trim() ||
      !!String(row.promotionContent || '').trim() ||
      !!String(row.targetText || '').trim() ||
      !!String(row.resultText || '').trim() ||
      !!String(row.recruitCountText || '').trim() ||
      !!String(row.ownerName || '').trim() ||
      !!String(row.note || '').trim()
  )
}

/**
 * 행 목록에 포함된 서로 다른 요일 수를 셉니다.
 * @param {Array<{ weekday?: unknown }>} rows 검사할 행 목록입니다.
 * @returns {number} 서로 다른 요일 수입니다.
 */
function getDistinctWeekdayCount(rows) {
  const weekdaySet = new Set()
  rows.forEach((row) => {
    const weekday = normalizeWeekday(row.weekday)
    if (weekday) weekdaySet.add(weekday)
  })
  return weekdaySet.size
}

/**
 * 부서 기준으로 중복 없는 타깃 목록을 만듭니다.
 * @param {types.KjcaAnalyzeResult[]} rows 분석 결과 목록입니다.
 * @returns {types.KjcaTeamLeadRow[]} 부서별 대표 타깃 목록입니다.
 */
function buildUniqueTargets(rows) {
  const map = new Map()
  rows.forEach((row) => {
    if (map.has(row.dept)) return
    map.set(row.dept, {
      dept: row.dept,
      position: row.position,
      staffName: row.staffName,
      printUrl: row.printUrl,
    })
  })
  return Array.from(map.values())
}

/**
 * 주간 계획 데이터가 실제로 들어 있는지 확인합니다.
 * @param {types.KjcaRecruitingExtract} recruiting 검사할 recruiting 값입니다.
 * @returns {boolean} 계획 데이터가 있으면 true입니다.
 */
function hasWeekPlanData(recruiting) {
  return (
    recruiting.monthTarget !== null ||
    recruiting.weekTarget !== null ||
    (Array.isArray(recruiting.weekTableRows) &&
      recruiting.weekTableRows.some(
        (row) =>
          !!String(row.channelName || '').trim() ||
          !!String(row.weeklyPlan || '').trim() ||
          !!String(row.promotionContent || '').trim() ||
          !!String(row.targetText || '').trim() ||
          !!String(row.resultText || '').trim() ||
          !!String(row.recruitCountText || '').trim() ||
          !!String(row.ownerName || '').trim() ||
          !!String(row.note || '').trim()
      )) ||
    recruiting.dailyPlan.some((item) => item.targetCount !== null || !!item.channelName || !!item.promotionContent || !!item.ownerName || !!item.note)
  )
}

/**
 * 주간 목표/실적 스냅샷 행을 계산합니다.
 * @param {Array<{ weekday?: unknown, targetCount?: unknown }>} planItems 계획 행 목록입니다.
 * @param {Array<{ weekday?: unknown, actualCount?: unknown }>} weekResults 실적 행 목록입니다.
 * @returns {types.KjcaSnapshotRow[]} 요일별 스냅샷 행 목록입니다.
 */
function buildSnapshotRows(planItems, weekResults) {
  const targetMap = {
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
  }

  const actualMap = {
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
  }

  planItems.forEach((item) => {
    const weekday = normalizeWeekday(item.weekday)
    if (!weekday) return
    targetMap[weekday] += Math.max(0, Math.trunc(Number(item.targetCount || 0)))
  })

  weekResults.forEach((item) => {
    const weekday = normalizeWeekday(item.weekday)
    if (!weekday) return
    actualMap[weekday] += Math.max(0, Math.trunc(Number(item.actualCount || 0)))
  })

  return WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    target: targetMap[weekday],
    actual: actualMap[weekday],
    gap: actualMap[weekday] - targetMap[weekday],
  }))
}

/**
 * 부서별 주간 텍스트 테이블 목록을 화면용 shape로 정리합니다.
 * @param {unknown} value 수집 결과나 저장값에서 받은 테이블 목록 값입니다.
 * @returns {types.KjcaDeptWeekTable[]} 정규화된 부서별 주간 테이블 목록입니다.
 */
function normalizeDeptWeekTables(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {}
      return {
        dept: String(source.dept || '').trim(),
        todayWeekday: normalizeWeekday(source.todayWeekday) || 'fri',
        rows: ensureWeekdayRows(source.rows),
      }
    })
    .filter((item) => !!item.dept)
    .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'))
}

/**
 * 부서별 주간 스냅샷 목록을 화면용 shape로 정리합니다.
 * @param {unknown} value 수집 결과나 저장값에서 받은 스냅샷 목록 값입니다.
 * @returns {types.KjcaDeptSnapshot[]} 정규화된 부서별 스냅샷 목록입니다.
 */
function normalizeDeptSnapshots(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {}
      return {
        dept: String(source.dept || '').trim(),
        monthTarget: normalizeNullableInt(source.monthTarget),
        weekTarget: normalizeNullableInt(source.weekTarget),
        rows: Array.isArray(source.rows)
          ? source.rows
              .map((row) => ({
                weekday: normalizeWeekday(row && row.weekday) || 'mon',
                target: normalizeRequiredInt(row && row.target, 0),
                actual: normalizeRequiredInt(row && row.actual, 0),
                gap: Number.isFinite(Number(row && row.gap)) ? Math.trunc(Number(row.gap)) : 0,
              }))
              .filter((row) => !!row.weekday)
          : [],
        today:
          source.today && typeof source.today === 'object'
            ? {
                weekday: normalizeWeekday(source.today.weekday) || 'fri',
                target: normalizeRequiredInt(source.today.target, 0),
                actual: normalizeRequiredInt(source.today.actual, 0),
                gap: Number.isFinite(Number(source.today.gap)) ? Math.trunc(Number(source.today.gap)) : 0,
              }
            : {
                weekday: 'fri',
                target: 0,
                actual: 0,
                gap: 0,
              },
        cumulative:
          source.cumulative && typeof source.cumulative === 'object'
            ? {
                target: normalizeRequiredInt(source.cumulative.target, 0),
                actual: normalizeRequiredInt(source.cumulative.actual, 0),
                gap: Number.isFinite(Number(source.cumulative.gap)) ? Math.trunc(Number(source.cumulative.gap)) : 0,
              }
            : {
                target: 0,
                actual: 0,
                gap: 0,
              },
      }
    })
    .filter((item) => !!item.dept)
    .sort((a, b) => a.dept.localeCompare(b.dept, 'ko'))
}

/**
 * 대시보드 렌더링에 필요한 전체 상태를 정규화합니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} input 페이지나 상호작용 응답에서 만든 원본 상태입니다.
 * @returns {types.KjcaDashboardState} 화면에서 바로 쓸 수 있는 대시보드 상태입니다.
 */
function buildDashboardState(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    reportDate: normalizeReportDate(source.reportDate),
    testOneOnly: normalizeBool(source.testOneOnly),
    noticeMessage: String(source.noticeMessage || '').trim(),
    errorMessage: String(source.errorMessage || '').trim(),
    warnings: Array.isArray(source.warnings) ? source.warnings.map((item) => String(item || '').trim()).filter(Boolean) : [],
    stoppedReason: String(source.stoppedReason || '').trim(),
    isDiaryAccessible: source.isDiaryAccessible === true ? true : source.isDiaryAccessible === false ? false : null,
    teamLeadRows: normalizeTeamLeadRows(source.teamLeadRows),
    analysisResults: normalizeAnalyzeResults(source.analysisResults),
    deptWeekTables: normalizeDeptWeekTables(source.deptWeekTables),
    deptSnapshots: normalizeDeptSnapshots(source.deptSnapshots),
  }
}

/**
 * 대시보드 상태를 hidden field 전송용 문자열로 직렬화합니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} state 직렬화할 대시보드 상태입니다.
 * @returns {string} URL 인코딩된 대시보드 상태 문자열입니다.
 */
function serializeDashboardState(state) {
  const normalized = buildDashboardState(state)
  return encodeURIComponent(JSON.stringify(normalized))
}

/**
 * 직렬화된 대시보드 상태를 다시 화면용 상태로 복원합니다.
 * @param {unknown} value hidden field나 요청값으로 받은 직렬화 문자열입니다.
 * @param {Partial<types.KjcaDashboardState> | null | undefined} fallback 복원 실패 시 기본값으로 쓸 상태입니다.
 * @returns {types.KjcaDashboardState} 복원된 대시보드 상태입니다.
 */
function parseDashboardState(value, fallback) {
  const fallbackState = buildDashboardState(fallback)
  const text = String(value || '').trim()
  if (!text) return fallbackState

  try {
    const decoded = decodeURIComponent(text)
    return buildDashboardState({
      ...fallbackState,
      ...parseJsonSafely(decoded, {}),
    })
  } catch (error) {
    return fallbackState
  }
}

/**
 * 같은 요일의 여러 텍스트 행을 한 줄 요약용 값으로 합칩니다.
 * @param {types.KjcaWeekTextRow[] | null | undefined} rows 병합할 주간 텍스트 행 목록입니다.
 * @param {types.KjcaWeekday | string} weekday 선택할 요일 키입니다.
 * @returns {types.KjcaMergedWeekdayRow} 화면 표시용 병합 행입니다.
 */
function getWeekdayMergedRow(rows, weekday) {
  const items = (Array.isArray(rows) ? rows : []).filter((row) => row.weekday === weekday).sort((a, b) => a.sortOrder - b.sortOrder)

  const joinValues = (extractor) =>
    items
      .map((row) => String(extractor(row) || '').trim())
      .filter(Boolean)
      .join(' / ')

  return {
    channelName: joinValues((row) => row.channelName),
    weeklyPlan: joinValues((row) => row.weeklyPlan),
    promotionContent: joinValues((row) => row.promotionContent),
    targetText: joinValues((row) => row.targetText),
    resultText: joinValues((row) => row.resultText),
    recruitCountText: joinValues((row) => row.recruitCountText),
    ownerName: joinValues((row) => row.ownerName),
    note: joinValues((row) => row.note),
  }
}

/**
 * 현재 표시 중인 요일이 오늘 강조 대상인지 확인합니다.
 * @param {types.KjcaWeekday | string} weekday 비교할 행의 요일 키입니다.
 * @param {types.KjcaWeekday | string} todayWeekday 오늘 기준 요일 키입니다.
 * @returns {boolean} 오늘 강조 대상이면 `true`입니다.
 */
function isFocusWeekday(weekday, todayWeekday) {
  return weekday === todayWeekday
}

function buildMonthLabel(dateText) {
  const text = String(dateText || '').trim()
  const matched = text.match(/^\d{4}-(\d{2})-\d{2}$/)
  if (!matched) return '금월'
  const month = Number(matched[1])
  if (!Number.isFinite(month) || month < 1 || month > 12) return '금월'
  return `${month}월`
}

/**
 * 부서 카드 상단에 표시할 요약 문구를 만듭니다.
 * @param {types.KjcaDeptSummaryInput | null | undefined} summaryInput 요약에 필요한 부서명, 날짜, 분석 결과입니다.
 * @returns {string} 화면에 표시할 요약 문구입니다.
 */
function buildDeptSummaryText(summaryInput) {
  const dept = String((summaryInput && summaryInput.dept) || '').trim()
  const reportDate = String((summaryInput && summaryInput.reportDate) || '').trim()
  const analysisResults = Array.isArray(summaryInput && summaryInput.analysisResults) ? summaryInput.analysisResults : []
  const item = analysisResults.find((row) => row.dept === dept && row.ok)
  const monthTarget = item && item.recruiting ? item.recruiting.monthTarget : null
  const monthAssignedCurrent = item && item.recruiting ? item.recruiting.monthAssignedCurrent : null
  const monthTargetText = monthTarget === null ? '-' : `${monthTarget}건`
  const monthAssignedText = monthAssignedCurrent === null ? '-' : `${monthAssignedCurrent}명`
  const monthLabel = buildMonthLabel(reportDate)
  return `월 배정목표 : ${monthTargetText} / ${monthLabel} 현재 달성 : 배정 ${monthAssignedText}`
}

/**
 * AI 상세의 Promotion 표시용 목록을 만듭니다.
 * @param {Partial<types.KjcaAnalyzeResult> | null | undefined} analyzeResult 분석 결과 1건입니다.
 * @returns {string[]} 화면에 표시할 모집/홍보 문구 목록입니다.
 */
function buildPromotionDisplayItems(analyzeResult) {
  const item = analyzeResult && typeof analyzeResult === 'object' ? analyzeResult : {}
  const recruiting = normalizeRecruitingExtract(item.recruiting)
  const weekRows = normalizeWeekTextRows(recruiting.weekTableRows)

  const structuredItems = weekRows
    .map((row) => {
      const parts = []
      if (row.channelName) parts.push(row.channelName)
      if (row.promotionContent && row.promotionContent !== row.channelName) parts.push(row.promotionContent)
      else if (!parts.length && row.weeklyPlan) parts.push(row.weeklyPlan)
      if (parts.length === 0) return ''

      const weekdayLabel = weekdayLabelMap[row.weekday] || row.weekday
      return `(${weekdayLabel}) ${parts.join(' / ')}`
    })
    .filter(Boolean)

  if (structuredItems.length > 0) {
    return Array.from(new Set(structuredItems))
  }

  const aiItems = Array.isArray(item.promotion) ? item.promotion : []
  return Array.from(
    new Set(
      aiItems
        .map((entry) => normalizeSingleLineText(entry))
        .filter(Boolean)
    )
  )
}

/**
 * 수집 결과를 화면용 대시보드 상태로 변환합니다.
 * @param {Partial<types.KjcaCollectResult> | null | undefined} result 수집 API가 돌려준 결과입니다.
 * @param {types.KjcaFormStateInput | null | undefined} formState 현재 화면의 폼 상태 입력값입니다.
 * @returns {types.KjcaDashboardState} 렌더링에 바로 쓸 수 있는 대시보드 상태입니다.
 */
function buildDashboardStateFromCollectResult(result, formState) {
  const safeFormState = buildFormState(formState)
  const deptWeekTables = normalizeDeptWeekTables(result && result.deptWeekTables)
  const alertMessage = String((result && result.alertMessage) || '').trim()
  const noticeMessage = alertMessage || `자동 취합 완료 (${deptWeekTables.length}개 부서)`

  return buildDashboardState({
    reportDate: safeFormState.reportDate,
    testOneOnly: safeFormState.testOneOnly,
    noticeMessage,
    warnings: result && result.warnings,
    isDiaryAccessible: result && result.isDiaryAccessible,
    teamLeadRows: result && result.teamLeadRows,
    analysisResults: result && result.analysisResults,
    deptWeekTables,
    deptSnapshots: result && result.deptSnapshots,
    stoppedReason: result && result.stoppedReason,
  })
}

module.exports = {
  KJCA_EMAIL_DOMAIN,
  KJCA_HOST,
  KJCA_LOGIN_URL,
  KJCA_AUTH_URL,
  CACHE_COLLECTION_NAME,
  GEMINI_MODEL_NAME,
  PROMPT_VERSION,
  GEMINI_MAX_ATTEMPTS,
  WEEKDAY_ORDER,
  weekdayLabelMap,
  parseJsonSafely,
  extractJsonObjectText,
  getHeaderValues,
  mergeSetCookieIntoCookieHeader,
  detectAuthRequiredHtml,
  toAbsoluteKjcaUrl,
  isAllowedKjcaUrl,
  parseTeamLeadRowsFromDiaryHtml,
  parseRecruitingExtractFromDiaryHtml,
  parseJobStatusTableFromDiaryHtml,
  parseMiscSectionFromDiaryHtml,
  buildBrowserLikeHeaders,
  buildFormState,
  normalizeReportDate,
  escapeFilterValue,
  hashText,
  extractDivInnerHtmlByClasses,
  htmlToText,
  normalizeStringArray,
  normalizeJsonArrayField,
  inferGemini429Cause,
  stringifyGeminiErrorDetails,
  parseDateText,
  formatDateText,
  buildWeekStartDate,
  toWeekdayKey,
  normalizeWeekday,
  buildDateMatchParams,
  normalizeNullableInt,
  normalizeRequiredInt,
  normalizeBool,
  normalizeMiscSection,
  normalizeJobStatusTable,
  normalizeRecruitingExtract,
  normalizeCachedRecruitingField,
  normalizeTeamLeadRows,
  normalizeAnalyzeResults,
  normalizeWeekTextRows,
  ensureWeekdayRows,
  hasWeekTextContent,
  getDistinctWeekdayCount,
  buildUniqueTargets,
  hasWeekPlanData,
  buildSnapshotRows,
  normalizeDeptWeekTables,
  normalizeDeptSnapshots,
  buildDashboardState,
  buildDashboardStateFromCollectResult,
  parseDashboardState,
  serializeDashboardState,
  isFocusWeekday,
  getWeekdayMergedRow,
  buildDeptSummaryText,
  buildPromotionDisplayItems,
}
