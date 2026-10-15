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
const epubAudioHtmlToText = compileHtmlToText({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
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

function readArchiveText(archiveEntries, entryPath) {
  if (!entryPath || !archiveEntries[entryPath]) {
    return ''
  }

  return fflate.strFromU8(archiveEntries[entryPath])
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

function findTocEntryPath(manifestItems, packageDocument, packageDocumentPath) {
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
      return joinPath(dirname(packageDocumentPath), manifestItem.href)
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

    const entryPath = joinPath(dirname(packageDocumentPath), manifestItem.href)
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
  const tocEntryPath = findTocEntryPath(manifestItems, packageDocument, packageDocumentPath)
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

/**
 * EPUB 바이트에서 읽기 분량을 다시 계산합니다.
 * @param {Uint8Array} epubBytes EPUB 압축 바이트
 * @returns {types.EpubReadingMetrics} 계산된 읽기 분량
 */
function buildReadingMetricsFromBytes(epubBytes) {
  const archiveEntries = fflate.unzipSync(epubBytes, {
    filter: function (file) {
      return shouldExtractTextEntry(String(file && file.name ? file.name : ''))
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
    return joinPath(dirname(packagePath), decodeURIComponent(item.href.split('#')[0]))
  })
}

function unzipAudioEntries(epubBytes, entryPaths) {
  return fflate.unzipSync(epubBytes, {
    filter: function (file) {
      return entryPaths.indexOf(file.name) >= 0 && file.originalSize <= 2 * 1024 * 1024
    },
  })
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
    const text = html ? htmlToAudioText(html) : ''
    if (text && !isCopyrightSection(entryPath, html, text)) {
      sections.push({ sectionIndex, chunks: splitAudioText(text) })
    }
  }
  return sections
}

const copyrightEntryNames = ['copy', 'copyright', 'copyrightpage', 'colophon', 'imprint']
const copyrightTerms =
  /\ubc1c\ud589\uc778|\ubc1c\ud589\ucc98|\ud3b4\ub0b8\uc774|\ud3b4\ub0b8\uacf3|\ucd9c\ud310\ub4f1\ub85d|\uc778\uc1c4|\ucd08\ud310|1\ud310 1\uc1c4|copyright|\u00a9|all rights reserved/gi

/**
 * \ub0ad\ub3c5\ud560 \ud544\uc694\uac00 \uc5c6\ub294 \ud310\uad8c \ud398\uc774\uc9c0\uc778\uc9c0 \ud310\ub2e8\ud569\ub2c8\ub2e4.
 * @param {string} entryPath \ucc55\ud130 \ud30c\uc77c \uacbd\ub85c
 * @param {string} html \ucc55\ud130 HTML
 * @param {string} text \ub0ad\ub3c5 \ubcf8\ubb38
 * @returns {boolean} \ud310\uad8c \ud398\uc774\uc9c0 \uc5ec\ubd80
 */
function isCopyrightSection(entryPath, html, text) {
  const entryName = String(entryPath.split('/').pop())
    .replace(/\.(xhtml|html|htm)$/i, '')
    .replace(/[-_.]/g, '')
    .replace(/\d+$/, '')
    .toLowerCase()
  if (copyrightEntryNames.indexOf(entryName) >= 0) return true
  if (/epub:type\s*=\s*["'][^"']*\b(copyright-page|colophon|imprint)\b/i.test(html)) return true
  // \ud310\uad8c \ud45c\uc2dc\uac00 \uc5c6\ub294 \ucc45\ub3c4 \ub9ce\uc544 ISBN\uacfc \ud310\uad8c \uc6a9\uc5b4\uac00 \ud568\uaed8 \uc788\ub294 \uc9e7\uc740 \ucc55\ud130\ub97c \ud310\uad8c \ud398\uc774\uc9c0\ub85c \ubd05\ub2c8\ub2e4.
  const terms = text.match(copyrightTerms) || []
  return text.length <= 2500 && /ISBN/i.test(text) && terms.length >= 2
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

function splitAudioText(text) {
  let remaining = text
  const chunks = []
  while (remaining.length > 1400) {
    const windowText = remaining.slice(0, 1400)
    let boundary = windowText.lastIndexOf('\n\n')
    if (boundary < 700) {
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
    if (boundary < 1) throw new Error('본문을 낭독 구간으로 나누지 못했습니다.')
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
}
