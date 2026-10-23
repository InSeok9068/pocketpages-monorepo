const fflate = require('fflate')
const { XMLParser } = require('fast-xml-parser')
const he = require('he')
const { compile: compileHtmlToText } = require(`${__hooks}/pages/_private/vendor/html-to-text.bundle.js`)

const CHARS_PER_PAGE = 430
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributesGroupName: '@attrs',
  attributeNamePrefix: '',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
})
const epubHtmlToText = compileHtmlToText({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
})
// 각주 번호 링크만 빼고, 링크가 없는 위첨자(km², 원어 병기)는 남깁니다.
const NOTE_REFERENCE_TEXT = /^[[(]?\d{1,3}[\])]?$|^[*†‡]$/

function collectNodeText(nodes) {
  return (nodes || [])
    .map(function (node) {
      return node.type === 'text' ? node.data : collectNodeText(node.children)
    })
    .join('')
}

function formatLinkWithoutNoteReference(elem, walk, builder) {
  const href = String(elem.attribs && elem.attribs.href ? elem.attribs.href : '')
  if (href.indexOf('#') >= 0 && NOTE_REFERENCE_TEXT.test(collectNodeText(elem.children).trim())) return
  walk(elem.children, builder)
}

const epubAudioHtmlToText = compileHtmlToText({
  wordwrap: false,
  formatters: { linkWithoutNoteReference: formatLinkWithoutNoteReference },
  selectors: [
    { selector: 'a', format: 'linkWithoutNoteReference' },
    { selector: 'img', format: 'skip' },
    { selector: 'nav', format: 'skip' },
    { selector: '[hidden]', format: 'skip' },
    { selector: '[aria-hidden="true"]', format: 'skip' },
    { selector: 'blockquote', format: 'block' },
    { selector: 'ul', format: 'block' },
    { selector: 'ol', format: 'block' },
    { selector: 'li', format: 'block' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
})
const excludedEntryNames = [
  'cover',
  'coverpage',
  'coverimage',
  'copy',
  'copyright',
  'copyrightpage',
  'colophon',
  'imprint',
  'about',
  'abouttheauthor',
  'author',
  'authorbio',
  'title',
  'titlepage',
  'toc',
  'nav',
  'contents',
  'tableofcontents',
  'index',
  'footnote',
  'footnotes',
]

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value
  }

  if (value === undefined || value === null || value === '') {
    return []
  }

  return [value]
}

function getXmlChild(node, key) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null
  }

  const value = node[key]
  return value && typeof value === 'object' ? value : null
}

function getXmlChildren(node, key) {
  return ensureArray(node && typeof node === 'object' ? node[key] : null)
}

function parseXmlDocument(xmlText) {
  const normalizedXmlText = String(xmlText || '').trim()

  if (!normalizedXmlText) {
    return {}
  }

  try {
    return xmlParser.parse(normalizedXmlText) || {}
  } catch (_exception) {
    return {}
  }
}

function getXmlAttributes(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return {}
  }

  return node['@attrs'] && typeof node['@attrs'] === 'object' ? node['@attrs'] : {}
}

function getXmlAttribute(node, attributeName) {
  const value = getXmlAttributes(node)[attributeName]
  return value === undefined || value === null ? '' : String(value).trim()
}

function dirname(filePath) {
  const lastSlashIndex = String(filePath || '').lastIndexOf('/')
  return lastSlashIndex === -1 ? '' : filePath.slice(0, lastSlashIndex)
}

function joinPath(basePath, relativePath) {
  const rawPath = (basePath ? basePath + '/' : '') + String(relativePath || '')
  const segments = rawPath.split('/')
  const normalizedSegments = []

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]

    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      normalizedSegments.pop()
      continue
    }

    normalizedSegments.push(segment)
  }

  return normalizedSegments.join('/')
}

/**
 * OPF manifest href를 EPUB 압축 안의 실제 파일 경로로 바꿉니다.
 * @param {object} archiveEntries EPUB 압축 엔트리 맵
 * @param {string} packageDocumentPath OPF 경로
 * @param {string} href manifest href
 * @returns {string} 압축 안 파일 경로. 찾지 못하면 href를 그대로 이은 경로
 */
function resolveManifestEntryPath(archiveEntries, packageDocumentPath, href) {
  const rawHref = String(href || '').split('#')[0]
  const rawPath = joinPath(dirname(packageDocumentPath), rawHref)

  if (archiveEntries[rawPath]) {
    return rawPath
  }

  try {
    const decodedPath = joinPath(dirname(packageDocumentPath), decodeURIComponent(rawHref))
    return archiveEntries[decodedPath] ? decodedPath : rawPath
  } catch (_exception) {
    return rawPath
  }
}

/**
 * EPUB 압축에서 꺼낸 UTF-8 바이트를 문자열로 바꿉니다.
 * @param {Uint8Array} bytes 압축을 푼 파일 바이트
 * @returns {string} 파일 내용
 */
function decodeArchiveBytes(bytes) {
  // PocketBase JSVM에는 TextDecoder가 없어 fflate가 글자마다 문자열을 이어 붙이고, 파일 크기의 제곱만큼 느려집니다.
  return typeof $app !== 'undefined' ? toString(bytes) : fflate.strFromU8(bytes)
}

function readArchiveText(archiveEntries, entryPath) {
  if (!entryPath || !archiveEntries[entryPath]) {
    return ''
  }

  return decodeArchiveBytes(archiveEntries[entryPath])
}

function decodeXmlText(input) {
  return String(input || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?!(?:[a-z0-9]+|#\d+|#x[a-f0-9]+);)/gi, '&amp;')
    .replace(/\u00A0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&#xA0;/gi, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ') // eslint-disable-line no-control-regex
    .replace(/^[\s\S]*$/, function (value) {
      try {
        return he.decode(value, { isAttributeValue: false })
      } catch (_exception) {
        return value
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToPlainText(input) {
  return decodeXmlText(epubHtmlToText(String(input || '')))
}

function parseContainerRootfilePath(containerDocument) {
  const containerNode = getXmlChild(containerDocument, 'container')
  const rootfilesNode = getXmlChild(containerNode, 'rootfiles')
  const rootfileNode = getXmlChildren(rootfilesNode, 'rootfile')[0] || null

  return rootfileNode ? getXmlAttribute(rootfileNode, 'full-path') : ''
}

function parseManifestItems(packageDocument) {
  const packageNode = getXmlChild(packageDocument, 'package')
  const manifestNode = getXmlChild(packageNode, 'manifest')
  const manifestNodes = getXmlChildren(manifestNode, 'item')
  const manifestItems = []

  for (let index = 0; index < manifestNodes.length; index += 1) {
    const manifestNodeItem = manifestNodes[index]

    manifestItems.push({
      id: getXmlAttribute(manifestNodeItem, 'id'),
      href: getXmlAttribute(manifestNodeItem, 'href'),
      mediaType: getXmlAttribute(manifestNodeItem, 'media-type'),
      properties: getXmlAttribute(manifestNodeItem, 'properties'),
    })
  }

  return manifestItems
}

function parseSpineIdrefs(packageDocument) {
  const packageNode = getXmlChild(packageDocument, 'package')
  const spineNode = getXmlChild(packageNode, 'spine')
  const itemrefNodes = getXmlChildren(spineNode, 'itemref')
  const idrefs = []

  for (let index = 0; index < itemrefNodes.length; index += 1) {
    const idref = getXmlAttribute(itemrefNodes[index], 'idref')

    if (idref) {
      idrefs.push(idref)
    }
  }

  return idrefs
}

function findTocEntryPath(archiveEntries, manifestItems, packageDocument, packageDocumentPath) {
  const packageNode = getXmlChild(packageDocument, 'package')
  const spineNode = getXmlChild(packageNode, 'spine')
  const tocId = getXmlAttribute(spineNode, 'toc')
  const manifestList = Array.isArray(manifestItems) ? manifestItems : []

  for (let index = 0; index < manifestList.length; index += 1) {
    const manifestItem = manifestList[index]

    if (!manifestItem || !manifestItem.href) {
      continue
    }

    if ((tocId && manifestItem.id === tocId) || manifestItem.mediaType === 'application/x-dtbncx+xml') {
      return resolveManifestEntryPath(archiveEntries, packageDocumentPath, manifestItem.href)
    }
  }

  return ''
}

function countTocNavPoints(node) {
  if (!node || typeof node !== 'object') {
    return 0
  }

  const navPoints = getXmlChildren(node, 'navPoint')
  let count = navPoints.length

  for (let index = 0; index < navPoints.length; index += 1) {
    count += countTocNavPoints(navPoints[index])
  }

  return count
}

function countReadableCharacters(input) {
  const normalizedText = String(input || '').replace(/\s+/g, '')
  return normalizedText ? normalizedText.length : 0
}

/**
 * EPUB 본문을 기준으로 읽기 분량을 계산합니다.
 * @param {object} archiveEntries EPUB 압축 엔트리 맵
 * @param {Array<{id:string,href:string,mediaType:string,properties:string}>} manifestItems OPF manifest 항목
 * @param {string} packageDocumentPath OPF 경로
 * @param {object} packageDocument 파싱된 OPF 문서
 * @returns {types.EpubReadingMetrics} 계산된 읽기 분량
 */
function buildReadingMetrics(archiveEntries, manifestItems, packageDocumentPath, packageDocument) {
  const manifestList = Array.isArray(manifestItems) ? manifestItems : []
  const manifestById = {}
  const spineIdrefs = parseSpineIdrefs(packageDocument)
  let combinedText = ''

  for (let index = 0; index < manifestList.length; index += 1) {
    const manifestItem = manifestList[index]

    if (manifestItem && manifestItem.id) {
      manifestById[manifestItem.id] = manifestItem
    }
  }

  for (let index = 0; index < spineIdrefs.length; index += 1) {
    const manifestItem = manifestById[spineIdrefs[index]]

    if (!manifestItem || !manifestItem.href) {
      continue
    }

    if (!(manifestItem.mediaType === 'application/xhtml+xml' || /\.(xhtml|html|htm)$/i.test(manifestItem.href))) {
      continue
    }

    const entryPath = resolveManifestEntryPath(archiveEntries, packageDocumentPath, manifestItem.href)
    const entryName = String(manifestItem.href || '')
      .split('/')
      .pop()
      .replace(/\.(xhtml|html|htm)$/i, '')
      .replace(/[-_.]/g, '')
      .replace(/\d+$/, '')
      .toLowerCase()
    const entryProperties = String(manifestItem.properties || '').split(/\s+/)

    if (excludedEntryNames.indexOf(entryName) !== -1 || entryProperties.indexOf('nav') !== -1) {
      continue
    }

    combinedText += ' ' + htmlToPlainText(readArchiveText(archiveEntries, entryPath))
  }

  const textCharCount = countReadableCharacters(combinedText)
  const tocEntryPath = findTocEntryPath(archiveEntries, manifestItems, packageDocument, packageDocumentPath)
  const chapterCount = countTocNavPoints(parseXmlDocument(readArchiveText(archiveEntries, tocEntryPath)))
  const pageDivisor = CHARS_PER_PAGE

  return {
    textCharCount: textCharCount,
    chapterCount: chapterCount,
    estimatedPageCount: textCharCount > 0 ? Math.ceil(textCharCount / pageDivisor) : 0,
    pageDivisor: pageDivisor,
    pageRule: 'fixed',
  }
}

function shouldExtractTextEntry(entryPath) {
  return (
    entryPath === 'mimetype'
    || entryPath === 'META-INF/container.xml'
    || /\.(opf|xml|ncx|xhtml|html|htm|txt)$/i.test(String(entryPath || ''))
  )
}

const MAX_TEXT_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_TEXT_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * 한 EPUB에서 풀어 읽을 텍스트 파일의 압축 해제 크기 검사기를 만듭니다.
 * @returns {(entryName: string, originalSize: number) => void} 파일 하나 또는 합계가 한도를 넘으면 오류를 던지는 검사 함수
 */
function createTextEntrySizeGuard() {
  let totalBytes = 0

  return function (entryName, originalSize) {
    totalBytes += Number(originalSize || 0)

    if (originalSize <= MAX_TEXT_ENTRY_BYTES && totalBytes <= MAX_TEXT_TOTAL_BYTES) {
      return
    }

    const message = '압축을 푼 본문 크기가 너무 커서 처리할 수 없는 EPUB입니다.'
    throw Object.assign(
      new Error('oversized epub text: ' + entryName + ' ' + originalSize + ' bytes, total ' + totalBytes + ' bytes'),
      { userMessage: message }
    )
  }
}

/**
 * EPUB 바이트에서 읽기 분량을 다시 계산합니다.
 * @param {Uint8Array} epubBytes EPUB 압축 바이트
 * @returns {types.EpubReadingMetrics} 계산된 읽기 분량
 */
function buildReadingMetricsFromBytes(epubBytes) {
  const checkTextEntrySize = createTextEntrySizeGuard()
  const archiveEntries = fflate.unzipSync(epubBytes, {
    filter: function (file) {
      const entryName = String(file && file.name ? file.name : '')

      if (!shouldExtractTextEntry(entryName)) {
        return false
      }

      checkTextEntrySize(entryName, file.originalSize)
      return true
    },
  })
  const containerDocument = parseXmlDocument(readArchiveText(archiveEntries, 'META-INF/container.xml'))
  const packageDocumentPath = parseContainerRootfilePath(containerDocument)
  const packageDocument = parseXmlDocument(readArchiveText(archiveEntries, packageDocumentPath))
  const manifestItems = parseManifestItems(packageDocument)

  return buildReadingMetrics(archiveEntries, manifestItems, packageDocumentPath, packageDocument)
}

function readAudioSpinePaths(epubBytes) {
  const metadata = fflate.unzipSync(epubBytes, {
    filter: function (file) {
      return (file.name === 'META-INF/container.xml' || /\.opf$/i.test(file.name)) && file.originalSize <= 1024 * 1024
    },
  })
  const packagePath = parseContainerRootfilePath(parseXmlDocument(readArchiveText(metadata, 'META-INF/container.xml')))
  const packageDocument = parseXmlDocument(readArchiveText(metadata, packagePath))
  const items = parseManifestItems(packageDocument)
  return parseSpineIdrefs(packageDocument).map(function (idref) {
    const item = items.filter(function (entry) {
      return entry.id === idref
    })[0]
    if (!item || !/^(application\/xhtml\+xml|text\/html)$/.test(item.mediaType)) return ''
    const href = item.href.split('#')[0]
    try {
      return joinPath(dirname(packagePath), decodeURIComponent(href))
    } catch (_exception) {
      // 잘못 인코딩된 경로(%가 그대로 들어간 파일 이름 등)는 원래 문자열로 찾습니다.
      return joinPath(dirname(packagePath), href)
    }
  })
}

function unzipAudioEntries(epubBytes, entryPaths) {
  const oversized = []
  const checkTextEntrySize = createTextEntrySizeGuard()
  const archive = fflate.unzipSync(epubBytes, {
    filter: function (file) {
      if (entryPaths.indexOf(file.name) < 0) return false
      if (file.originalSize > MAX_TEXT_ENTRY_BYTES) {
        oversized.push(file.name)
        return false
      }
      checkTextEntrySize(file.name, file.originalSize)
      return true
    },
  })
  // 큰 파일을 건너뛰면 챕터가 빠진 채 생성이 완료될 수 있어, 아예 실패로 알립니다.
  if (oversized.length) {
    const error = /** @type {Error & { userMessage?: string }} */ (
      new Error('oversized audio entries: ' + oversized.join(', '))
    )
    error.userMessage =
      '본문 파일 ' + oversized.length + '개가 16MB를 넘어 낭독할 수 없습니다. 챕터가 빠지지 않도록 생성을 멈췄습니다.'
    throw error
  }
  return archive
}

/**
 * EPUB 전체에서 본문이 있는 챕터의 낭독 구간을 만듭니다.
 * @param {Uint8Array} epubBytes EPUB 압축 바이트
 * @returns {types.BookAudioSection[]} spine 순서의 챕터별 낭독 구간
 */
function buildAudioBookFromBytes(epubBytes) {
  const entryPaths = readAudioSpinePaths(epubBytes)
  const archive = unzipAudioEntries(
    epubBytes,
    entryPaths.filter(function (entryPath) {
      return !!entryPath
    })
  )
  const sections = []
  for (let sectionIndex = 0; sectionIndex < entryPaths.length; sectionIndex += 1) {
    const entryPath = entryPaths[sectionIndex]
    const html = entryPath && archive[entryPath] ? readArchiveText(archive, entryPath) : ''
    // 미주는 첫 주석 문단부터 빼고, 그 앞의 본문(부록 논문의 요약 등)은 남깁니다. 제목만 남으면 페이지째 뺍니다.
    const noteStart = html ? findNoteStart(entryPath, html) : -1
    const text = html
      ? withoutTrailingNoteHeading(htmlToAudioText(noteStart >= 0 ? html.slice(0, noteStart) : html), noteStart)
      : ''
    const narratable = noteStart < 0 || text.replace(/\s+/g, '').length >= 100
    if (text && narratable && !isNonNarrativeSection(entryPath, html, text)) {
      sections.push({ sectionIndex, chunks: splitAudioText(text) })
    }
  }
  return sections
}

const skippedEntryNames = [
  'copy',
  'encopy',
  'copyright',
  'copyrightpage',
  'rights',
  'colophon',
  'imprint',
  'footnote',
  'footnotes',
  'endnote',
  'endnotes',
]
const copyrightTerms =
  /\ubc1c\ud589\uc778|\ubc1c\ud589\ucc98|\ud3b4\ub0b8\uc774|\ud3b4\ub0b8\uacf3|\ucd9c\ud310\ub4f1\ub85d|\uc778\uc1c4|\ucd08\ud310|1\ud310 1\uc1c4|copyright|\u00a9|\u24d2|all rights reserved/gi
const linkOnlyTexts = ['\ucc98\uc74c\uc73c\ub85c', '\ucc45\uc758\uc2dc\uc791', '\ucc45\uc758\ub05d', '\ud45c\uc9c0']
// \uccab \uc904\uc774 \uc774 \uc81c\ubaa9\uacfc \uc815\ud655\ud788 \uac19\uc744 \ub54c\ub9cc \uc81c\uc678\ud574, \uac19\uc740 \ub2e8\uc5b4\ub85c \uc2dc\uc791\ud558\ub294 \ubcf8\ubb38 \ubb38\uc7a5\uc740 \uadf8\ub300\ub85c \ub461\ub2c8\ub2e4.
// 「/ 참고문헌 /」·「│감사의 말│」처럼 제목을 꾸민 기호와 공백은 지우고 비교합니다.
const headingDecorations = /[\s/|│┃·・\-–—()[\]<>《》〈〉「」『』.,:]+/g
const backMatterHeadings =
  /^(\ucc28\ub840|\ubaa9\ucc28|contents|table of contents|\uc8fc\uc11d|\ubbf8\uc8fc|\uac01\uc8fc|\uc8fc|notes|endnotes|footnotes|\ucc38\uace0\ubb38\ud5cc|\ucc38\uace0\ub3c4\uc11c|\ucc38\uace0\uc790\ub8cc|bibliography|references|\ucc3e\uc544\ubcf4\uae30|\uc0c9\uc778|index|\uc0ac\uc9c4\ucd9c\ucc98|\ub3c4\ud310\ucd9c\ucc98|\uc774\ubbf8\uc9c0\ucd9c\ucc98|\uadf8\ub9bc\ucd9c\ucc98|pictureacknowledgements)$/i

/**
 * \ud310\uad8c\u00b7\ucc28\ub840\u00b7\uc8fc\uc11d\u00b7\ucc38\uace0\ubb38\ud5cc\u00b7\ud45c\uc9c0 \ub9c1\ud06c\ucc98\ub7fc \ub0ad\ub3c5\ud560 \ud544\uc694\uac00 \uc5c6\ub294 \ud398\uc774\uc9c0\uc778\uc9c0 \ud310\ub2e8\ud569\ub2c8\ub2e4.
 * @param {string} entryPath \ucc55\ud130 \ud30c\uc77c \uacbd\ub85c
 * @param {string} html \ucc55\ud130 HTML
 * @param {string} text \ub0ad\ub3c5 \ubcf8\ubb38
 * @returns {boolean} \uc81c\uc678 \uc5ec\ubd80
 */
function isNonNarrativeSection(entryPath, html, text) {
  const entryName = String(entryPath.split('/').pop())
    .replace(/\.(xhtml|html|htm)$/i, '')
    .replace(/[-_.]/g, '')
    .replace(/\d+$/, '')
    .toLowerCase()
  if (skippedEntryNames.indexOf(entryName) >= 0) return true
  if (/epub:type\s*=\s*["'][^"']*\b(copyright-page|colophon|imprint)\b/i.test(html)) return true
  if (/<body[^>]*epub:type\s*=\s*["'][^"']*\b(footnotes|endnotes|rearnotes|bibliography|index|toc)\b/i.test(html)) {
    return true
  }
  const compact = text.replace(/\s+/g, '')
  if (linkOnlyTexts.indexOf(compact) >= 0) return true
  // \u300c\ucc28<br>\ub840\u300d\ucc98\ub7fc \uc81c\ubaa9 \uae00\uc790\ub97c \uc904\uc744 \ub098\ub220 \uc4f4 \ucc45\uc774 \uc788\uc5b4, \uccab \uc904 \ub300\uc2e0 \uccab \ubb38\ub2e8\uc744 \uc81c\ubaa9\uc73c\ub85c \ubd05\ub2c8\ub2e4.
  const heading = text.split(/\n\s*\n/)[0].replace(headingDecorations, '')
  if (backMatterHeadings.test(heading) && text.length <= 80000) return true
  if (text.length <= 1000 && /저작권법/.test(text) && /보호를 받|허락 없이|무단/.test(text)) return true
  if (text.length > 3000) return false
  if (/all rights? reserved/i.test(text) || heading === '\ud310\uad8c') return true
  if (/copyright|\u00a9|\u24d2/i.test(text) && /published by|by arrangement with|translation rights/i.test(text))
    return true
  // \ud310\uad8c \ud45c\uc2dc\uac00 \uc5c6\ub294 \ucc45\ub3c4 \ub9ce\uc544 ISBN\uacfc \ud310\uad8c \uc6a9\uc5b4\uac00 \ud568\uaed8 \uc788\ub294 \uc9e7\uc740 \ud398\uc774\uc9c0\ub97c \ud310\uad8c\uc73c\ub85c \ubd05\ub2c8\ub2e4.
  const terms = text.match(copyrightTerms) || []
  return /ISBN/i.test(text) && terms.length >= 2
}

// 제목이 이미지라 글자로 찾을 수 없는 미주도, 문단 대부분이 본문으로 돌아가는 번호 링크로 시작하면 주석 페이지로 봅니다.
// 본문 챕터의 주석 번호는 문장 중간에 있어 문단 첫머리 조건에 걸리지 않습니다.
function findNoteStart(entryPath, html) {
  const ownName = String(entryPath.split('/').pop())
  const paragraphPattern = /<p\b[^>]*>[\s\S]*?<\/p>/gi
  let total = 0
  let backlinked = 0
  let firstNote = -1
  let match = paragraphPattern.exec(html)
  while (match) {
    const paragraph = match[0]
    if (paragraph.replace(/<[^>]+>/g, '').trim()) {
      total += 1
      const inner = paragraph.replace(/^<p\b[^>]*>/i, '').replace(/^(\s|<(span|sup|b|strong|em|i)\b[^>]*>)*/i, '')
      const link = inner.match(/^<a\b[^>]*href\s*=\s*["']([^"'#]*)#[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      const target = link ? String(link[1].split('/').pop()) : ''
      if (target && target !== ownName && /^[[(]?\d{1,3}[\]).．]?$/.test(link[2].replace(/<[^>]+>/g, '').trim())) {
        backlinked += 1
        if (firstNote < 0) firstNote = match.index
      }
    }
    match = paragraphPattern.exec(html)
  }
  return backlinked >= 5 && backlinked >= total / 2 ? firstNote : -1
}

function withoutTrailingNoteHeading(text, noteStart) {
  if (noteStart < 0) return text
  const blocks = text.split(/\n\s*\n/)
  const last = blocks[blocks.length - 1].replace(headingDecorations, '')
  return backMatterHeadings.test(last) ? blocks.slice(0, -1).join('\n\n').trim() : text
}

function htmlToAudioText(html) {
  return (
    epubAudioHtmlToText(html)
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u00ad/g, '')
      // \ub514\uc790\uc778\uc6a9\uc73c\ub85c \uae00\uc790 \uc0ac\uc774\uc5d0 \uac00\uc6b4\ub383\uc810\uc744 \ub123\uc740 \uc601\ubb38(P\u318dr\u318do\u318dl\u318do\u318dg\u318du\u318de)\uc740 \ud55c \ub2e8\uc5b4\ub85c \ubd99\uc785\ub2c8\ub2e4.
      .replace(/[A-Za-z](?:[\u318d\u00b7\u2022][A-Za-z])+/g, function (word) {
        return word.replace(/[\u318d\u00b7\u2022]/g, '')
      })
      .replace(
        /^[ \t]*[\u25a1\u25a0\u25c7\u25c6\u25cb\u25cf\u25b6\u25b7\u25ba\u25aa\u25ab\u2610\u2611\u2713\u2714]+[ \t]*/gm,
        ''
      )
      .trim()
  )
}

// TTS 출력 한도(16,384토큰, 초당 25토큰 ≈ 10분 55초) 안에서 하루 요청 수를 줄이도록 약 7분 분량으로 나눕니다.
const AUDIO_CHUNK_MAX_CHARS = 3000

function splitAudioText(text) {
  let remaining = text
  const chunks = []
  while (remaining.length > AUDIO_CHUNK_MAX_CHARS) {
    const windowText = remaining.slice(0, AUDIO_CHUNK_MAX_CHARS)
    let boundary = windowText.lastIndexOf('\n\n')
    if (boundary < AUDIO_CHUNK_MAX_CHARS / 2) {
      const sentences = /[.!?。！？][”’"']?\s+/g
      let match = sentences.exec(windowText)
      boundary = -1
      while (match) {
        boundary = match.index + match[0].length
        match = sentences.exec(windowText)
      }
    }
    // 짧은 문장도 중간에서 끊지 않습니다. 긴 한 문장일 때만 공백을 사용합니다.
    if (boundary < 1) boundary = windowText.lastIndexOf(' ')
    // 띄어쓰기 없는 긴 글(일본어·중국어 등)은 구간 최대 길이에서 자릅니다.
    if (boundary < 1) boundary = AUDIO_CHUNK_MAX_CHARS
    chunks.push(remaining.slice(0, boundary).trim())
    remaining = remaining.slice(boundary).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

module.exports = {
  buildAudioBookFromBytes,
  buildReadingMetrics,
  buildReadingMetricsFromBytes,
  createTextEntrySizeGuard,
  decodeArchiveBytes,
  resolveManifestEntryPath,
}
