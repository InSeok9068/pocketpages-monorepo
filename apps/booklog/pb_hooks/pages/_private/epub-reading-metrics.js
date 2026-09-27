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
  return ensureArray(getXmlChild(node, key))
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

module.exports = {
  buildReadingMetrics,
  buildReadingMetricsFromBytes,
}
