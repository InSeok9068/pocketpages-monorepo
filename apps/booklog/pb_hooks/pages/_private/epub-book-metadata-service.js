const fflate = require('fflate')
const { XMLParser } = require('fast-xml-parser')
const he = require('he')
const { compile: compileHtmlToText } = require(`${__hooks}/pages/_private/vendor/html-to-text.bundle.js`)
const { createTextEntrySizeGuard, decodeArchiveBytes } = require(`${__hooks}/pages/_private/epub-reading-metrics.js`)

/**
 * EPUB 업로드와 재분석에서 같은 도서 메타데이터 탐색을 제공합니다.
 * @param {{ data4libraryService: any, toBytes: Function, dbg: Function, info: Function, warn: Function, apiKey: string, logPrefix?: string }} dependencies 검색과 EPUB 읽기 의존성
 * @returns {any} EPUB 파싱, ISBN 탐색, 도서 검색 함수
 */
function createEpubBookMetadataService(dependencies) {
  const data4libraryService = dependencies.data4libraryService
  const toBytes = dependencies.toBytes
  const dbg = dependencies.dbg
  const info = dependencies.info
  const warn = dependencies.warn
  const apiKey = dependencies.apiKey
  const logPrefix = String(dependencies.logPrefix || 'xapi/epub/upload')
  const MAX_EPUB_BYTES = 1024 * 1024 * 100
  const MIN_BOOK_SEARCH_SCORE = 80
  const MAX_METADATA_PAGE_FALLBACKS = 12
  const MAX_BOOK_SEARCH_DOCS = 100
  const BOOK_SEARCH_PAGE_SIZE = 25
  // 실제 EPUB 44권은 후보가 많아야 2개(전자책·종이책 ISBN)였습니다. 판권에 ISBN이 많이 적힌 책에 대비한 상한입니다.
  const MAX_ISBN_DETAIL_LOOKUPS = 5
  // 도서 API가 한 번 응답하지 않으면 남은 조회도 같은 시간만큼 기다리므로, 이 서비스(요청 한 건)에서는 더 부르지 않습니다.
  let lookupUnavailable = false
  const METADATA_ENTRY_PATH_PATTERN =
    /(rights|copyright|colophon|author|about|credit|imprint|title|cover|bookinfo|book_info|book-info)/i
  const ISBN_SCAN_ENTRY_PATTERN = /\.(opf|xml|ncx|xhtml|html|htm|txt)$/i
  const SET_ISBN_CONTEXT_PATTERN = /(?:세트|set|전집|합본)/i
  const ZIP_EOCD_SIGNATURE = 0x06054b50
  const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
  const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
  const ZIP_MAX_EOCD_SEARCH_BYTES = 22 + 65535
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
  function normalizePreview(input, maxLength) {
    return String(input || '')
      .replace(/[^\x20-\x7E\u00A0-\uFFFF\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, maxLength)
  }

  function dirname(filePath) {
    const lastSlashIndex = String(filePath || '').lastIndexOf('/')
    if (lastSlashIndex === -1) {
      return ''
    }

    return filePath.slice(0, lastSlashIndex)
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

    return decodeArchiveBytes(archiveEntries[entryPath])
  }

  function shouldExtractEpubTextEntry(entryPath) {
    const normalizedEntryPath = String(entryPath || '')

    return (
      normalizedEntryPath === 'mimetype'
      || normalizedEntryPath === 'META-INF/container.xml'
      || /\.(opf|xml|ncx|xhtml|html|htm|txt)$/i.test(normalizedEntryPath)
    )
  }

  function readUInt16LE(bytes, offset) {
    return Number(bytes[offset] || 0) | (Number(bytes[offset + 1] || 0) << 8)
  }

  function readUInt32LE(bytes, offset) {
    return (
      (Number(bytes[offset] || 0)
        | (Number(bytes[offset + 1] || 0) << 8)
        | (Number(bytes[offset + 2] || 0) << 16)
        | (Number(bytes[offset + 3] || 0) << 24))
      >>> 0
    )
  }

  function readReaderRange(reader, offset, length) {
    const byteLength = Math.max(0, Number(length || 0))

    if (byteLength <= 0) {
      return new Uint8Array(0)
    }

    reader.seek(Number(offset || 0), 0)
    return new Uint8Array(toBytes(reader, byteLength))
  }

  function sortEntryInfos(entryInfos) {
    return entryInfos.sort(function (left, right) {
      return String(left.name || '').localeCompare(String(right.name || ''))
    })
  }

  function findZipEndOfCentralDirectory(tailBytes) {
    for (let offset = tailBytes.length - 22; offset >= 0; offset -= 1) {
      if (readUInt32LE(tailBytes, offset) === ZIP_EOCD_SIGNATURE) {
        return offset
      }
    }

    return -1
  }

  function parseZipCentralDirectory(reader, fileSize) {
    const tailLength = Math.min(Number(fileSize || 0), ZIP_MAX_EOCD_SEARCH_BYTES)
    const tailOffset = Math.max(0, Number(fileSize || 0) - tailLength)
    const tailBytes = readReaderRange(reader, tailOffset, tailLength)
    const eocdOffset = findZipEndOfCentralDirectory(tailBytes)

    if (eocdOffset < 0) {
      throw new Error('EPUB ZIP 중앙 디렉터리를 찾지 못했습니다.')
    }

    const diskNumber = readUInt16LE(tailBytes, eocdOffset + 4)
    const centralDirectoryDiskNumber = readUInt16LE(tailBytes, eocdOffset + 6)
    const centralDirectorySize = readUInt32LE(tailBytes, eocdOffset + 12)
    const centralDirectoryOffset = readUInt32LE(tailBytes, eocdOffset + 16)

    if (diskNumber !== 0 || centralDirectoryDiskNumber !== 0) {
      throw new Error('분할 ZIP EPUB는 지원하지 않습니다.')
    }

    if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
      throw new Error('ZIP64 EPUB는 전체 unzip fallback이 필요합니다.')
    }

    const centralDirectoryBytes = readReaderRange(reader, centralDirectoryOffset, centralDirectorySize)
    const entries = []
    let offset = 0

    while (offset + 46 <= centralDirectoryBytes.length) {
      if (readUInt32LE(centralDirectoryBytes, offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error('EPUB ZIP 중앙 디렉터리 엔트리 형식이 올바르지 않습니다.')
      }

      const compression = readUInt16LE(centralDirectoryBytes, offset + 10)
      const compressedSize = readUInt32LE(centralDirectoryBytes, offset + 20)
      const originalSize = readUInt32LE(centralDirectoryBytes, offset + 24)
      const fileNameLength = readUInt16LE(centralDirectoryBytes, offset + 28)
      const extraLength = readUInt16LE(centralDirectoryBytes, offset + 30)
      const commentLength = readUInt16LE(centralDirectoryBytes, offset + 32)
      const localHeaderOffset = readUInt32LE(centralDirectoryBytes, offset + 42)
      const nameStart = offset + 46
      const nameEnd = nameStart + fileNameLength
      const entryName = fflate.strFromU8(centralDirectoryBytes.slice(nameStart, nameEnd))

      if (compressedSize === 0xffffffff || originalSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error('ZIP64 EPUB 엔트리는 전체 unzip fallback이 필요합니다.')
      }

      entries.push({
        name: entryName,
        size: compressedSize,
        originalSize: originalSize,
        compression: compression,
        localHeaderOffset: localHeaderOffset,
      })

      offset = nameEnd + extraLength + commentLength
    }

    return entries
  }

  function readZipEntryData(reader, entryInfo) {
    const localHeaderBytes = readReaderRange(reader, entryInfo.localHeaderOffset, 30)

    if (localHeaderBytes.length < 30 || readUInt32LE(localHeaderBytes, 0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error('EPUB ZIP 로컬 헤더 형식이 올바르지 않습니다.')
    }

    const fileNameLength = readUInt16LE(localHeaderBytes, 26)
    const extraLength = readUInt16LE(localHeaderBytes, 28)
    const dataOffset = entryInfo.localHeaderOffset + 30 + fileNameLength + extraLength
    const compressedBytes = readReaderRange(reader, dataOffset, entryInfo.size)

    if (entryInfo.compression === 0) {
      return compressedBytes
    }

    if (entryInfo.compression === 8) {
      return fflate.inflateSync(compressedBytes, { out: new Uint8Array(entryInfo.originalSize) })
    }

    return null
  }

  function readZipTextArchiveEntries(reader, fileSize) {
    const entryInfos = parseZipCentralDirectory(reader, fileSize)
    const entryNames = []
    const archiveEntries = {}
    const checkTextEntrySize = createTextEntrySizeGuard()

    for (let index = 0; index < entryInfos.length; index += 1) {
      const entryInfo = entryInfos[index]

      if (!entryInfo.name) {
        continue
      }

      entryNames.push(entryInfo.name)

      if (!shouldExtractEpubTextEntry(entryInfo.name)) {
        continue
      }

      checkTextEntrySize(entryInfo.name, entryInfo.originalSize)
      const entryData = readZipEntryData(reader, entryInfo)

      if (entryData) {
        archiveEntries[entryInfo.name] = entryData
      }
    }

    entryNames.sort()

    return {
      archiveEntries: archiveEntries,
      entryInfos: sortEntryInfos(
        entryInfos.map(function (entryInfo) {
          return {
            name: entryInfo.name,
            size: entryInfo.size,
            originalSize: entryInfo.originalSize,
            compression: entryInfo.compression,
          }
        })
      ),
      entryNames: entryNames,
      readMode: 'zip-range',
    }
  }

  function unzipTextArchiveEntries(archiveBytes) {
    const seenEntryNames = {}
    const entryNames = []
    const entryInfos = []
    const checkTextEntrySize = createTextEntrySizeGuard()
    const archiveEntries = fflate.unzipSync(archiveBytes, {
      filter: function (file) {
        const entryName = String(file && file.name ? file.name : '')

        if (entryName && !seenEntryNames[entryName]) {
          seenEntryNames[entryName] = true
          entryNames.push(entryName)
          entryInfos.push({
            name: entryName,
            size: Number(file.size || 0),
            originalSize: Number(file.originalSize || 0),
            compression: Number(file.compression || 0),
          })
        }

        if (!shouldExtractEpubTextEntry(entryName)) {
          return false
        }

        checkTextEntrySize(entryName, file.originalSize)
        return true
      },
    })

    entryNames.sort()

    return {
      archiveEntries: archiveEntries,
      entryInfos: sortEntryInfos(entryInfos),
      entryNames: entryNames.length > 0 ? entryNames : Object.keys(archiveEntries).sort(),
      readMode: 'full-unzip-filter',
    }
  }

  function readUploadedFileBytes(uploadedFile, fileSize) {
    const reader = uploadedFile.reader.open()
    const maxReadableBytes = Number(fileSize || 0) || MAX_EPUB_BYTES

    try {
      return new Uint8Array(toBytes(reader, maxReadableBytes))
    } finally {
      reader.close()
    }
  }

  function readUploadedEpubArchiveSnapshot(uploadedFile, fileSize) {
    const reader = uploadedFile.reader.open()

    try {
      return readZipTextArchiveEntries(reader, fileSize)
    } catch (exception) {
      if (exception && exception.userMessage) {
        throw exception
      }

      warn(logPrefix + ':zip-range-fallback', {
        originalName: uploadedFile.originalName || uploadedFile.name,
        error: String(exception.message || exception),
      })
    } finally {
      reader.close()
    }

    return unzipTextArchiveEntries(readUploadedFileBytes(uploadedFile, fileSize))
  }

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
    const targetNode = getXmlChild(node, key)
    return ensureArray(targetNode)
  }

  function getXmlValues(node, key) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return []
    }

    return ensureArray(node[key])
  }

  function parseXmlDocument(xmlText) {
    const normalizedXmlText = String(xmlText || '').trim()

    if (!normalizedXmlText) {
      return {}
    }

    try {
      return xmlParser.parse(normalizedXmlText) || {}
    } catch (exception) {
      warn(logPrefix + ':xml-parse:failed', {
        error: String(exception.message || exception),
      })
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
    const attributes = getXmlAttributes(node)
    const value = attributes[attributeName]
    return value === undefined || value === null ? '' : String(value).trim()
  }

  function stringifyXmlAttributes(node) {
    const attributes = getXmlAttributes(node)
    return Object.keys(attributes)
      .filter(function (key) {
        return attributes[key] !== undefined && attributes[key] !== null && attributes[key] !== ''
      })
      .map(function (key) {
        return key + '="' + String(attributes[key]) + '"'
      })
      .join(' ')
  }

  function decodeXmlText(input) {
    return (
      String(input || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&(?!(?:[a-z0-9]+|#\d+|#x[a-f0-9]+);)/gi, '&amp;')
        .replace(/\u00A0/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#160;/gi, ' ')
        .replace(/&#xA0;/gi, ' ')
        // Remove control characters from untrusted XML text before parsing entities.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
        .replace(/^[\s\S]*$/g, function (value) {
          try {
            return he.decode(value, { isAttributeValue: false })
          } catch (_exception) {
            return value
          }
        })
        .replace(/\s+/g, ' ')
        .trim()
    )
  }

  function getXmlNodeText(node) {
    if (node === undefined || node === null) {
      return ''
    }

    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      return decodeXmlText(node)
    }

    if (Array.isArray(node)) {
      const parts = []

      for (let index = 0; index < node.length; index += 1) {
        const value = getXmlNodeText(node[index])

        if (value) {
          parts.push(value)
        }
      }

      return decodeXmlText(parts.join(' '))
    }

    if (typeof node === 'object') {
      return decodeXmlText(String(node['#text'] || node['#cdata'] || ''))
    }

    return ''
  }

  function parseContainerRootfilePath(containerDocument) {
    const containerNode = getXmlChild(containerDocument, 'container')
    const rootfilesNode = getXmlChild(containerNode, 'rootfiles')
    const rootfileNode = getXmlChildren(rootfilesNode, 'rootfile')[0] || null

    return rootfileNode ? getXmlAttribute(rootfileNode, 'full-path') : ''
  }

  function extractDigits(input) {
    const digits = String(input || '').replace(/\D+/g, '')
    return digits || ''
  }

  function pushUniqueValue(list, value) {
    const normalizedValue = String(value || '').trim()

    if (!normalizedValue) {
      return
    }

    for (let index = 0; index < list.length; index += 1) {
      if (list[index] === normalizedValue) {
        return
      }
    }

    list.push(normalizedValue)
  }

  function addIsbnCandidate(candidates, candidate) {
    if (!candidate || !candidate.isbn13) {
      return
    }

    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index].isbn13 === candidate.isbn13) {
        return
      }
    }

    candidates.push(candidate)
  }

  function normalizeIsbnScanText(input) {
    return String(input || '')
      .replace(/[–—−]/g, '-')
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
  }

  function isValidIsbn13(isbn13) {
    if (!/^\d{13}$/.test(isbn13)) {
      return false
    }

    let sum = 0

    for (let index = 0; index < 12; index += 1) {
      sum += Number(isbn13[index]) * (index % 2 === 0 ? 1 : 3)
    }

    return (10 - (sum % 10)) % 10 === Number(isbn13[12])
  }

  function extractIsbn13Matches(input) {
    const normalizedInput = normalizeIsbnScanText(input)
    const pattern = /97[89](?:[\s-]*\d){10}/g
    const matches = []
    let match = null

    while ((match = pattern.exec(normalizedInput))) {
      const isbn13 = extractDigits(match[0]).slice(0, 13)

      if (isValidIsbn13(isbn13)) {
        pushUniqueValue(matches, isbn13)
      }
    }

    return matches
  }

  function isLikelyUuidIdentifier(value, attributesText) {
    const normalizedValue = String(value || '').toLowerCase()
    const normalizedAttributesText = String(attributesText || '').toLowerCase()

    if (normalizedValue.indexOf('urn:uuid:') !== -1) {
      return true
    }

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(normalizedValue)) {
      return true
    }

    return normalizedAttributesText.indexOf('uuid') !== -1 && normalizedValue.indexOf('urn:isbn:') === -1
  }

  function isExplicitIsbnIdentifier(attributesText) {
    return /(?:opf:)?scheme\s*=\s*['"]isbn['"]/i.test(String(attributesText || ''))
  }

  function extractIdentifierIsbnCandidates(identifierNodes) {
    const explicitCandidates = []
    const fallbackCandidates = []
    const nodes = Array.isArray(identifierNodes) ? identifierNodes : []

    for (let index = 0; index < nodes.length; index += 1) {
      const identifierNode = nodes[index]
      const identifierValue = identifierNode && identifierNode.value ? identifierNode.value : ''
      const attributesText = identifierNode && identifierNode.attributesText ? identifierNode.attributesText : ''

      if (!identifierValue || isLikelyUuidIdentifier(identifierValue, attributesText)) {
        continue
      }

      const matches = extractIsbn13Matches(identifierValue)

      for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
        const isbn13 = matches[matchIndex]
        const targetList = isExplicitIsbnIdentifier(attributesText) ? explicitCandidates : fallbackCandidates

        addIsbnCandidate(targetList, {
          isbn13: isbn13,
          source: isExplicitIsbnIdentifier(attributesText) ? 'opf-identifier-isbn' : 'opf-identifier-value',
          entryPath: '',
          context: normalizePreview(identifierValue, 160),
          score: isExplicitIsbnIdentifier(attributesText) ? 60 : 40,
          isSet: false,
        })
      }
    }

    return explicitCandidates.concat(fallbackCandidates)
  }

  function htmlToPlainText(input) {
    return decodeXmlText(epubHtmlToText(String(input || '')))
  }

  function isMetadataEntryPath(entryPath) {
    return METADATA_ENTRY_PATH_PATTERN.test(String(entryPath || ''))
  }

  function isIsbnScanEntryPath(entryPath) {
    return ISBN_SCAN_ENTRY_PATTERN.test(String(entryPath || ''))
  }

  function buildMetadataEntryPaths(manifestItems, packageDocumentPath, entryNames) {
    const orderedPaths = []
    const keywordPaths = []
    const leadingTextPaths = []
    const manifestList = Array.isArray(manifestItems) ? manifestItems : []
    const normalizedEntryNames = Array.isArray(entryNames) ? entryNames : []

    for (let index = 0; index < manifestList.length; index += 1) {
      const manifestItem = manifestList[index]

      if (!manifestItem || !manifestItem.href) {
        continue
      }

      if (!(manifestItem.mediaType === 'application/xhtml+xml' || /\.(xhtml|html|htm)$/i.test(manifestItem.href))) {
        continue
      }

      const entryPath = joinPath(dirname(packageDocumentPath), manifestItem.href)

      if (isMetadataEntryPath(entryPath)) {
        pushUniqueValue(keywordPaths, entryPath)
      } else if (leadingTextPaths.length < MAX_METADATA_PAGE_FALLBACKS) {
        pushUniqueValue(leadingTextPaths, entryPath)
      }
    }

    for (let index = 0; index < normalizedEntryNames.length; index += 1) {
      const entryName = normalizedEntryNames[index]

      if (!/\.(xhtml|html|htm)$/i.test(entryName) || !isMetadataEntryPath(entryName)) {
        continue
      }

      pushUniqueValue(keywordPaths, entryName)
    }

    for (let index = 0; index < keywordPaths.length; index += 1) {
      pushUniqueValue(orderedPaths, keywordPaths[index])
    }

    for (let index = 0; index < leadingTextPaths.length; index += 1) {
      pushUniqueValue(orderedPaths, leadingTextPaths[index])
    }

    return orderedPaths
  }

  function buildIsbnScanEntryPaths(manifestItems, packageDocumentPath, entryNames) {
    const orderedPaths = []
    const manifestList = Array.isArray(manifestItems) ? manifestItems : []
    const normalizedEntryNames = Array.isArray(entryNames) ? entryNames : []
    const metadataEntryPaths = buildMetadataEntryPaths(manifestItems, packageDocumentPath, entryNames)

    if (packageDocumentPath && isIsbnScanEntryPath(packageDocumentPath)) {
      pushUniqueValue(orderedPaths, packageDocumentPath)
    }

    for (let index = 0; index < metadataEntryPaths.length; index += 1) {
      pushUniqueValue(orderedPaths, metadataEntryPaths[index])
    }

    for (let index = 0; index < manifestList.length; index += 1) {
      const manifestItem = manifestList[index]

      if (!manifestItem || !manifestItem.href) {
        continue
      }

      const entryPath = joinPath(dirname(packageDocumentPath), manifestItem.href)

      if (!isIsbnScanEntryPath(entryPath)) {
        continue
      }

      pushUniqueValue(orderedPaths, entryPath)
    }

    for (let index = 0; index < normalizedEntryNames.length; index += 1) {
      const entryName = normalizedEntryNames[index]

      if (!isIsbnScanEntryPath(entryName)) {
        continue
      }

      pushUniqueValue(orderedPaths, entryName)
    }

    return orderedPaths
  }

  function readIsbnScanText(archiveEntries, entryPath) {
    const archiveText = readArchiveText(archiveEntries, entryPath)

    if (!archiveText) {
      return ''
    }

    if (/\.(xhtml|html|htm)$/i.test(String(entryPath || ''))) {
      return htmlToPlainText(archiveText)
    }

    return archiveText
  }

  function scoreIsbnCandidateContext(context) {
    const normalizedContext = String(context || '')
    let score = 0

    if (/isbn/i.test(normalizedContext)) {
      score += 10
    }

    if (/전자책|ebook|e-book/i.test(normalizedContext)) {
      score += 20
    }

    if (/지은이|저자|옮긴이|옮김|역자|발행|펴낸/i.test(normalizedContext)) {
      score += 5
    }

    if (/종이책|paper/i.test(normalizedContext)) {
      score -= 5
    }

    return score
  }

  function getIsbnCandidateSourcePriority(candidate) {
    const source = String(candidate && candidate.source ? candidate.source : '')

    if (source === 'opf-identifier-isbn') {
      return 50
    }

    if (source === 'opf-identifier-value') {
      return 45
    }

    if (source === 'metadata-page') {
      return 30
    }

    if (source === 'archive-entry') {
      return 20
    }

    return 10
  }

  function compareIsbnCandidates(left, right) {
    const leftIsSetCandidate = !!(left && left.isSet)
    const rightIsSetCandidate = !!(right && right.isSet)
    const leftScore = left && typeof left.score === 'number' ? left.score : 0
    const rightScore = right && typeof right.score === 'number' ? right.score : 0
    const scoreDiff = rightScore - leftScore
    const sourcePriorityDiff = getIsbnCandidateSourcePriority(right) - getIsbnCandidateSourcePriority(left)

    if (leftIsSetCandidate !== rightIsSetCandidate) {
      return leftIsSetCandidate ? 1 : -1
    }

    if (scoreDiff !== 0) {
      return scoreDiff
    }

    if (sourcePriorityDiff !== 0) {
      return sourcePriorityDiff
    }

    return 0
  }

  function isDirectSetIsbnContext(text, matchStart, matchEnd) {
    const normalizedText = String(text || '')
    const prefix = normalizedText.slice(Math.max(0, matchStart - 12), matchStart)
    const suffix = normalizedText.slice(matchEnd, Math.min(normalizedText.length, matchEnd + 12))

    return SET_ISBN_CONTEXT_PATTERN.test(prefix) || SET_ISBN_CONTEXT_PATTERN.test(suffix)
  }

  function extractPageIsbnCandidates(plainText, entryPath, source) {
    const normalizedText = normalizeIsbnScanText(plainText)
    const pattern = /97[89](?:[\s-]*\d){10}/g
    const matches = []
    let match = null

    while ((match = pattern.exec(normalizedText))) {
      const isbn13 = extractDigits(match[0]).slice(0, 13)

      if (!isValidIsbn13(isbn13)) {
        continue
      }

      const contextStart = Math.max(0, match.index - 48)
      const contextEnd = Math.min(normalizedText.length, pattern.lastIndex + 48)
      const context = normalizedText.slice(contextStart, contextEnd)
      const isSetCandidate = isDirectSetIsbnContext(normalizedText, match.index, pattern.lastIndex)

      matches.push({
        isbn13: isbn13,
        source: source || 'metadata-page',
        entryPath: entryPath,
        context: normalizePreview(context, 160),
        score: scoreIsbnCandidateContext(context) + (isSetCandidate ? -80 : 0),
        isSet: isSetCandidate,
      })
    }

    matches.sort(function (left, right) {
      return compareIsbnCandidates(left, right)
    })

    return matches
  }

  function collectEpubIsbnCandidates(epubMetadata, archiveEntries, manifestItems, packageDocumentPath, entryNames) {
    const candidates = []
    const pendingCandidates = []
    const identifierCandidates = extractIdentifierIsbnCandidates(epubMetadata.identifierNodes)
    const isbnScanEntryPaths = buildIsbnScanEntryPaths(manifestItems, packageDocumentPath, entryNames)

    for (let index = 0; index < identifierCandidates.length; index += 1) {
      pendingCandidates.push(identifierCandidates[index])
    }

    for (let index = 0; index < isbnScanEntryPaths.length; index += 1) {
      const entryPath = isbnScanEntryPaths[index]
      const plainText = readIsbnScanText(archiveEntries, entryPath)
      const pageCandidates = extractPageIsbnCandidates(
        plainText,
        entryPath,
        isMetadataEntryPath(entryPath) ? 'metadata-page' : 'archive-entry'
      )

      for (let candidateIndex = 0; candidateIndex < pageCandidates.length; candidateIndex += 1) {
        pendingCandidates.push(pageCandidates[candidateIndex])
      }
    }

    pendingCandidates.sort(compareIsbnCandidates)

    for (let index = 0; index < pendingCandidates.length; index += 1) {
      addIsbnCandidate(candidates, pendingCandidates[index])
    }

    return candidates
  }

  function extractPrimaryAuthorName(authorText) {
    let normalizedAuthor = String(authorText || '').trim()

    if (!normalizedAuthor) {
      return ''
    }

    const segments = normalizedAuthor.replace(/[|│/]/g, '|').split('|')

    for (let index = 0; index < segments.length; index += 1) {
      let segment = segments[index]
      const translatorRoleMatch = segment.match(/옮긴이|옮김|역자|그림|감수/i)

      if (translatorRoleMatch) {
        segment = segment.slice(0, translatorRoleMatch.index)
      }

      segment = segment
        .replace(/\([^)]*\)/g, ' ')
        .replace(/(?:지은이|지음|글쓴이|글|저자)\s*[·:|-]?\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s저$/, '')

      if (segment) {
        return segment
      }
    }

    return ''
  }

  function normalizeContributorName(input) {
    let normalizedName = String(input || '').trim()

    if (!normalizedName) {
      return ''
    }

    normalizedName = normalizedName
      .replace(/[|│/]/g, '|')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/(?:지은이|지음|글쓴이|글|저자|옮긴이|옮김|역자|그림|감수)\s*[·:|-]?\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (normalizedName.indexOf('|') !== -1) {
      normalizedName = normalizedName.split('|')[0].trim()
    }

    return normalizedName
  }

  function normalizePublisherName(input) {
    return String(input || '')
      .replace(/^(?:㈜|\(주\)|주식회사)\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function extractMetadataPageTranslator(plainText) {
    const normalizedText = String(plainText || '')
      .replace(/\s+/g, ' ')
      .trim()
    const translatorMatch = normalizedText.match(
      /(?:옮긴이|옮김|역자)\s*[:：]?\s*([\s\S]{1,60}?)(?=\s+(?:발행인|발행처|출판사|출판|편집|라이츠담당|디지털|디자인|등록|주소|판매|마케팅|전화|지은이|저자|작가|원작|그림|감수)|$)/i
    )

    if (!translatorMatch) {
      return ''
    }

    return normalizeContributorName(translatorMatch[1])
  }

  function extractMetadataPagePublisher(plainText) {
    const normalizedText = String(plainText || '')
      .replace(/\s+/g, ' ')
      .trim()
    const publisherMatch = normalizedText.match(
      /(?:발행처|출판사|발행사|publisher)\s*[:：]?\s*([\s\S]{1,80}?)(?=\s+(?:인쇄|제작|등록|주소|판매|마케팅|전화|발행인|편집|라이츠담당|디지털|디자인|지은이|저자|원작|옮긴이|옮김|역자)|$)/i
    )

    if (!publisherMatch) {
      return ''
    }

    return normalizePublisherName(publisherMatch[1])
  }

  function stripFileExtension(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '')
  }

  function parseFilenameMetadata(fileName) {
    let normalizedName = stripFileExtension(fileName).trim()
    const sourceSuffixPattern = /\s*\((?:[^)]*(?:z-library|z-lib|1lib)[^)]*)\)\s*$/i

    while (sourceSuffixPattern.test(normalizedName)) {
      normalizedName = normalizedName.replace(sourceSuffixPattern, '').trim()
    }

    const authorMatch = normalizedName.match(/^(.*)\s+\(([^()]+)\)$/)

    if (!authorMatch) {
      return {
        title: normalizedName,
        author: '',
      }
    }

    return {
      title: String(authorMatch[1] || '').trim(),
      author: String(authorMatch[2] || '').trim(),
    }
  }

  function normalizeMatchText(input) {
    return String(input || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\uFFFF]+/g, '')
  }

  function bytesToBinaryString(bytes) {
    const list = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
    const chunkSize = 8192
    const chunks = []

    for (let index = 0; index < list.length; index += chunkSize) {
      const chunk = list.slice(index, index + chunkSize)
      chunks.push(String.fromCharCode.apply(null, chunk))
    }

    return chunks.join('')
  }

  function buildEpubTextFileHash(archiveSnapshot, fileSize) {
    const archiveEntries = archiveSnapshot && archiveSnapshot.archiveEntries ? archiveSnapshot.archiveEntries : {}
    const entryInfos = archiveSnapshot && Array.isArray(archiveSnapshot.entryInfos) ? archiveSnapshot.entryInfos : []
    const entryNames =
      archiveSnapshot && Array.isArray(archiveSnapshot.entryNames)
        ? archiveSnapshot.entryNames
        : Object.keys(archiveEntries).sort()
    const fingerprintParts = ['epub-text-v1', String(fileSize || 0)]

    for (let index = 0; index < entryInfos.length; index += 1) {
      const entryInfo = entryInfos[index]

      fingerprintParts.push([entryInfo.name, entryInfo.size, entryInfo.originalSize, entryInfo.compression].join(':'))
    }

    for (let index = 0; index < entryNames.length; index += 1) {
      const entryName = entryNames[index]

      if (archiveEntries[entryName]) {
        fingerprintParts.push(entryName)
        fingerprintParts.push(readArchiveText(archiveEntries, entryName))
      }
    }

    return $security.sha256(fingerprintParts.join('\n'))
  }

  function buildLegacyBinaryFileHash(epubByteArray) {
    return $security.sha256(bytesToBinaryString(epubByteArray))
  }

  function parsePublicationDate(input) {
    const digits = extractDigits(input)

    if (digits.length === 8) {
      return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8)
    }

    return ''
  }

  function parseManifestItems(packageDocument) {
    const packageNode = getXmlChild(packageDocument, 'package')
    const manifestNode = getXmlChild(packageNode, 'manifest')
    const manifestItems = getXmlChildren(manifestNode, 'item')
    const normalizedItems = []

    for (let index = 0; index < manifestItems.length; index += 1) {
      const manifestItem = manifestItems[index]
      const href = getXmlAttribute(manifestItem, 'href')

      normalizedItems.push({
        id: getXmlAttribute(manifestItem, 'id'),
        href: href,
        mediaType: getXmlAttribute(manifestItem, 'media-type'),
        properties: getXmlAttribute(manifestItem, 'properties'),
      })
    }

    return normalizedItems
  }

  function parseEpubMetadata(packageDocument) {
    const packageNode = getXmlChild(packageDocument, 'package')
    const metadataNode = getXmlChild(packageNode, 'metadata')
    const identifierNodes = getXmlValues(metadataNode, 'identifier').map(function (node) {
      return {
        attributesText: stringifyXmlAttributes(node),
        value: getXmlNodeText(node),
      }
    })
    const identifiers = []
    const title = getXmlNodeText(getXmlValues(metadataNode, 'title')[0]).trim()
    const authorNode = getXmlValues(metadataNode, 'creator').filter(function (node) {
      return getXmlAttribute(node, 'role').toLowerCase() !== 'trl' && getXmlNodeText(node).trim()
    })[0]
    const author = authorNode ? getXmlNodeText(authorNode).trim() : ''
    const languageCode = getXmlNodeText(getXmlValues(metadataNode, 'language')[0]).trim()
    const publisher = getXmlNodeText(getXmlValues(metadataNode, 'publisher')[0]).trim()
    const source = getXmlNodeText(getXmlValues(metadataNode, 'source')[0]).trim()
    const identifierCandidates = extractIdentifierIsbnCandidates(identifierNodes)

    for (let index = 0; index < identifierNodes.length; index += 1) {
      if (identifierNodes[index].value) {
        identifiers.push(identifierNodes[index].value)
      }
    }

    const identifierValue = identifiers.length > 0 ? identifiers[0] : ''

    return {
      title: title,
      author: author,
      publisher: publisher,
      source: source,
      languageCode: languageCode,
      identifierValue: identifierValue,
      identifiers: identifiers,
      identifierNodes: identifierNodes,
      isbn13: identifierCandidates.length > 0 ? identifierCandidates[0].isbn13 : '',
      epubVersion: getXmlAttribute(packageNode, 'version'),
    }
  }

  function buildSearchKeyword(title, author) {
    const segments = []
    const normalizedTitle = String(title || '').trim()
    const normalizedAuthor = String(author || '').trim()

    if (normalizedTitle) {
      segments.push(normalizedTitle)
    }

    if (normalizedAuthor) {
      segments.push(normalizedAuthor)
    }

    return segments.join(' ')
  }

  function addSearchProfile(profiles, title, author, source, matchMetadata) {
    const normalizedTitle = String(title || '').trim()
    const normalizedAuthor = String(author || '').trim()
    const combinedKeyword = buildSearchKeyword(normalizedTitle, normalizedAuthor)
    const normalizedTranslator = normalizeContributorName(
      matchMetadata && matchMetadata.translator ? matchMetadata.translator : ''
    )
    const normalizedPublisher = normalizePublisherName(
      matchMetadata && matchMetadata.publisher ? matchMetadata.publisher : ''
    )

    if (normalizedTitle && normalizedAuthor) {
      pushUniqueSearchProfile(profiles, {
        query: {
          title: normalizedTitle,
          author: normalizedAuthor,
        },
        keyword: combinedKeyword,
        title: normalizedTitle,
        author: normalizedAuthor,
        translator: normalizedTranslator,
        publisher: normalizedPublisher,
        source: source + ':title-author-fields',
      })
    }

    if (combinedKeyword) {
      pushUniqueSearchProfile(profiles, {
        query: {
          keyword: combinedKeyword,
        },
        keyword: combinedKeyword,
        title: normalizedTitle,
        author: normalizedAuthor,
        translator: normalizedTranslator,
        publisher: normalizedPublisher,
        source: source + ':combined',
      })
    }

    if (normalizedTitle) {
      pushUniqueSearchProfile(profiles, {
        query: {
          title: normalizedTitle,
        },
        keyword: normalizedTitle,
        title: normalizedTitle,
        author: normalizedAuthor,
        translator: normalizedTranslator,
        publisher: normalizedPublisher,
        source: source + ':title-field',
      })
    }

    if (normalizedTitle) {
      pushUniqueSearchProfile(profiles, {
        query: {
          keyword: normalizedTitle,
        },
        keyword: normalizedTitle,
        title: normalizedTitle,
        author: normalizedAuthor,
        translator: normalizedTranslator,
        publisher: normalizedPublisher,
        source: source + ':title',
      })
    }

    if (normalizedAuthor) {
      pushUniqueSearchProfile(profiles, {
        query: {
          keyword: normalizedAuthor,
        },
        keyword: normalizedAuthor,
        title: normalizedTitle,
        author: normalizedAuthor,
        translator: normalizedTranslator,
        publisher: normalizedPublisher,
        source: source + ':author',
      })
    }
  }

  function pushUniqueSearchProfile(profiles, profile) {
    const query = profile && profile.query ? profile.query : {}
    const hasQuery = !!(query.keyword || query.title || query.author || query.publisher)

    if (!hasQuery) {
      return
    }

    for (let index = 0; index < profiles.length; index += 1) {
      const existingQuery = profiles[index].query || {}

      if (
        (existingQuery.keyword || '') === (query.keyword || '')
        && (existingQuery.title || '') === (query.title || '')
        && (existingQuery.author || '') === (query.author || '')
        && (existingQuery.publisher || '') === (query.publisher || '')
      ) {
        return
      }
    }

    profiles.push(profile)
  }

  function collectSupplementalSearchMetadata(
    epubMetadata,
    archiveEntries,
    manifestItems,
    packageDocumentPath,
    entryNames
  ) {
    const metadataEntryPaths = buildMetadataEntryPaths(manifestItems, packageDocumentPath, entryNames)
    let translator = ''
    let publisher = normalizePublisherName(
      epubMetadata && (epubMetadata.publisher || epubMetadata.source)
        ? epubMetadata.publisher || epubMetadata.source
        : ''
    )

    for (let index = 0; index < metadataEntryPaths.length; index += 1) {
      const entryPath = metadataEntryPaths[index]
      const plainText = htmlToPlainText(readArchiveText(archiveEntries, entryPath))

      if (!translator) {
        translator = extractMetadataPageTranslator(plainText)
      }

      if (!publisher) {
        publisher = extractMetadataPagePublisher(plainText)
      }

      if (translator && publisher) {
        break
      }
    }

    return {
      translator: translator,
      publisher: publisher,
    }
  }

  function collectSearchProfiles(epubMetadata, supplementalMetadata, originalName) {
    const profiles = []
    const filenameMetadata = parseFilenameMetadata(originalName)
    const primaryAuthor = extractPrimaryAuthorName(epubMetadata.author)
    const filePrimaryAuthor = extractPrimaryAuthorName(filenameMetadata.author)
    const normalizedTitle = String(epubMetadata.title || filenameMetadata.title || '').trim()
    const translator = normalizeContributorName(
      supplementalMetadata && supplementalMetadata.translator ? supplementalMetadata.translator : ''
    )
    const publisher = normalizePublisherName(
      supplementalMetadata && supplementalMetadata.publisher ? supplementalMetadata.publisher : epubMetadata.publisher
    )

    addSearchProfile(profiles, epubMetadata.title, primaryAuthor || epubMetadata.author, 'epub', supplementalMetadata)

    if (epubMetadata.author && primaryAuthor && epubMetadata.author !== primaryAuthor) {
      addSearchProfile(profiles, epubMetadata.title, epubMetadata.author, 'epub-raw-author', supplementalMetadata)
    }

    if (
      filenameMetadata.title
      && (filenameMetadata.title !== String(epubMetadata.title || '').trim()
        || filePrimaryAuthor !== (primaryAuthor || String(epubMetadata.author || '').trim()))
    ) {
      addSearchProfile(
        profiles,
        filenameMetadata.title,
        filePrimaryAuthor || filenameMetadata.author,
        'filename',
        supplementalMetadata
      )
    }

    if (translator && translator !== primaryAuthor && translator !== filePrimaryAuthor) {
      pushUniqueSearchProfile(profiles, {
        query: {
          keyword: translator,
        },
        keyword: translator,
        title: normalizedTitle,
        author: primaryAuthor || epubMetadata.author,
        translator: translator,
        publisher: publisher,
        source: 'metadata-page:translator',
      })
    }

    if (publisher) {
      pushUniqueSearchProfile(profiles, {
        query: {
          keyword: publisher,
        },
        keyword: publisher,
        title: normalizedTitle,
        author: primaryAuthor || epubMetadata.author,
        translator: translator,
        publisher: publisher,
        source: 'epub:publisher',
      })
    }

    return profiles
  }

  function buildComparableTitleList(input) {
    const normalizedTitle = String(input || '').trim()
    const titleList = []
    const variants = [
      normalizedTitle,
      normalizedTitle.replace(/\s+/g, ''),
      normalizedTitle.replace(/\s*[:：].*$/, '').trim(),
      normalizedTitle.replace(/\s*[-:|].*$/, '').trim(),
      normalizedTitle
        .replace(/[〈《「『\(\[].*?[》〉」』\)\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ]

    for (let index = 0; index < variants.length; index += 1) {
      const normalizedVariant = normalizeMatchText(variants[index])

      if (!normalizedVariant) {
        continue
      }

      if (titleList.indexOf(normalizedVariant) === -1) {
        titleList.push(normalizedVariant)
      }
    }

    return titleList
  }

  function containsAnyComparableText(targetText, candidates) {
    const normalizedTargetText = normalizeMatchText(targetText)
    const list = Array.isArray(candidates) ? candidates : []

    if (!normalizedTargetText) {
      return false
    }

    for (let index = 0; index < list.length; index += 1) {
      const candidate = list[index]

      if (!candidate) {
        continue
      }

      if (
        normalizedTargetText === candidate
        || normalizedTargetText.indexOf(candidate) !== -1
        || candidate.indexOf(normalizedTargetText) !== -1
      ) {
        return true
      }
    }

    return false
  }

  /**
   * 검색 후보 점수와 근거를 계산합니다.
   * @param {any} doc API 후보 도서
   * @param {{ title?: string, author?: string, translator?: string, publisher?: string, isbn13?: string }} matchInput 비교 기준
   * @returns {types.BookSearchScoreDetails} 점수 상세
   */
  function scoreSearchDocWithDetails(doc, matchInput) {
    const titleTexts = buildComparableTitleList(matchInput && matchInput.title ? matchInput.title : '')
    const authorText = normalizeMatchText(matchInput && matchInput.author ? matchInput.author : '')
    const translatorText = normalizeMatchText(matchInput && matchInput.translator ? matchInput.translator : '')
    const publisherText = normalizeMatchText(matchInput && matchInput.publisher ? matchInput.publisher : '')
    const epubIsbn13 = extractDigits(matchInput && matchInput.isbn13 ? matchInput.isbn13 : '')
    const docTitle = normalizeMatchText(doc && doc.bookname)
    const docAuthor = normalizeMatchText(doc && doc.authors)
    const docPublisher = normalizeMatchText(doc && doc.publisher)
    const docIsbn13 = extractDigits(doc && doc.isbn13)
    let score = 0
    /** @type {types.BookSearchScoreDetails} */
    const details = {
      titleExact: false,
      titlePartial: false,
      authorExact: false,
      authorPartial: false,
      translatorExact: false,
      translatorPartial: false,
      publisherExact: false,
      publisherPartial: false,
      isbnExact: false,
      hasIsbn13: false,
      titleScore: 0,
      authorScore: 0,
      translatorScore: 0,
      publisherScore: 0,
      isbnScore: 0,
      bonusScore: 0,
      score: 0,
    }

    if (titleTexts.length > 0 && docTitle) {
      if (containsAnyComparableText(docTitle, titleTexts) && titleTexts.indexOf(docTitle) !== -1) {
        score += 120
        details.titleExact = true
        details.titleScore = 120
      } else if (containsAnyComparableText(docTitle, titleTexts)) {
        score += 80
        details.titlePartial = true
        details.titleScore = 80
      }
    }

    if (authorText && docAuthor) {
      if (docAuthor === authorText) {
        score += 70
        details.authorExact = true
        details.authorScore = 70
      } else if (docAuthor.indexOf(authorText) !== -1 || authorText.indexOf(docAuthor) !== -1) {
        score += 45
        details.authorPartial = true
        details.authorScore = 45
      }
    }

    if (translatorText && docAuthor) {
      if (docAuthor === translatorText) {
        score += 35
        details.translatorExact = true
        details.translatorScore = 35
      } else if (docAuthor.indexOf(translatorText) !== -1 || translatorText.indexOf(docAuthor) !== -1) {
        score += 25
        details.translatorPartial = true
        details.translatorScore = 25
      }
    }

    if (publisherText && docPublisher) {
      if (docPublisher === publisherText) {
        score += 20
        details.publisherExact = true
        details.publisherScore = 20
      } else if (docPublisher.indexOf(publisherText) !== -1 || publisherText.indexOf(docPublisher) !== -1) {
        score += 12
        details.publisherPartial = true
        details.publisherScore = 12
      }
    }

    if (epubIsbn13 && docIsbn13 && epubIsbn13 === docIsbn13) {
      score += 300
      details.isbnExact = true
      details.isbnScore = 300
    }

    if (docIsbn13) {
      score += 5
      details.hasIsbn13 = true
      details.bonusScore = 5
    }

    details.score = score

    return details
  }

  function pushUniqueSearchDoc(docs, doc) {
    const normalizedDoc = doc || {}
    const docIsbn13 = extractDigits(normalizedDoc.isbn13)
    const docTitle = normalizeMatchText(normalizedDoc.bookname)
    const docAuthor = normalizeMatchText(normalizedDoc.authors)

    for (let index = 0; index < docs.length; index += 1) {
      const existingDoc = docs[index]
      const existingIsbn13 = extractDigits(existingDoc && existingDoc.isbn13)
      const existingTitle = normalizeMatchText(existingDoc && existingDoc.bookname)
      const existingAuthor = normalizeMatchText(existingDoc && existingDoc.authors)

      if (docIsbn13 && existingIsbn13 && docIsbn13 === existingIsbn13) {
        return
      }

      if (!docIsbn13 && docTitle && docTitle === existingTitle && docAuthor === existingAuthor) {
        return
      }
    }

    docs.push(normalizedDoc)
  }

  function loadSearchDocsByQuery(query) {
    const docs = []
    const searchQuery = query || {}
    let pageNo = 1
    let numFound = 0
    let request = {}
    let raw = null

    if (lookupUnavailable) {
      throw new Error('도서 API가 응답하지 않아 검색을 건너뜁니다.')
    }

    while (docs.length < MAX_BOOK_SEARCH_DOCS) {
      let searchResult = null

      try {
        searchResult = data4libraryService.searchBooks(
          { apiKey: apiKey },
          Object.assign({}, searchQuery, {
            pageNo: pageNo,
            pageSize: BOOK_SEARCH_PAGE_SIZE,
          })
        )
      } catch (exception) {
        lookupUnavailable = true
        throw exception
      }

      if (!numFound) {
        numFound = searchResult.numFound
      }

      request = searchResult.request || request
      raw = searchResult.raw || raw

      const pageDocs = Array.isArray(searchResult.docs) ? searchResult.docs : []

      dbg(logPrefix + ':search-page', {
        query: searchQuery,
        pageNo: pageNo,
        pageDocsCount: pageDocs.length,
        aggregatedDocsCount: docs.length,
        numFound: searchResult.numFound,
      })

      for (let index = 0; index < pageDocs.length; index += 1) {
        pushUniqueSearchDoc(docs, pageDocs[index])

        if (docs.length >= MAX_BOOK_SEARCH_DOCS) {
          break
        }
      }

      if (
        pageDocs.length < BOOK_SEARCH_PAGE_SIZE
        || docs.length >= MAX_BOOK_SEARCH_DOCS
        || pageNo * BOOK_SEARCH_PAGE_SIZE >= Number(searchResult.numFound || 0)
      ) {
        break
      }

      pageNo += 1
    }

    return {
      request: request,
      numFound: numFound,
      docs: docs,
      raw: raw,
    }
  }

  function chooseBestSearchDoc(docs, epubMetadata) {
    const list = Array.isArray(docs) ? docs : []
    let bestDoc = null
    let bestScore = -1
    let bestScoreDetails = null

    for (let index = 0; index < list.length; index += 1) {
      const doc = list[index]
      const scoreDetails = scoreSearchDocWithDetails(doc, epubMetadata)
      const score = scoreDetails.score

      if (score > bestScore) {
        bestDoc = doc
        bestScore = score
        bestScoreDetails = scoreDetails
      }
    }

    return {
      bestDoc: bestDoc,
      bestScore: bestScore,
      bestScoreDetails: bestScoreDetails,
    }
  }

  function hasMeaningfulBookField(input, minLength) {
    return String(input || '').trim().length >= (minLength || 1)
  }

  function summarizeBookMetadataRichness(book) {
    const publisher = hasMeaningfulBookField(book && book.publisher, 1)
    const publicationDate = hasMeaningfulBookField(book && book.publication_date, 1)
    const publicationYear = hasMeaningfulBookField(book && book.publication_year, 1)
    const description = hasMeaningfulBookField(book && book.description, 30)
    const bookImageUrl = hasMeaningfulBookField(book && book.bookImageURL, 1)
    let score = 0

    if (publisher) {
      score += 2
    }

    if (publicationDate) {
      score += 2
    }

    if (publicationYear) {
      score += 1
    }

    if (description) {
      score += 3
    }

    if (bookImageUrl) {
      score += 2
    }

    return {
      score: score,
      publisher: publisher,
      publicationDate: publicationDate,
      publicationYear: publicationYear,
      description: description,
      bookImageUrl: bookImageUrl,
    }
  }

  function isSparseDetailBook(book) {
    const richness = summarizeBookMetadataRichness(book)

    return richness.score <= 3
  }

  function canUseEnrichmentBook(detailBook, enrichedBook) {
    const detailTitleVariants = buildComparableTitleList(detailBook && detailBook.bookname ? detailBook.bookname : '')
    const enrichedTitle = normalizeMatchText(enrichedBook && enrichedBook.bookname ? enrichedBook.bookname : '')
    const detailAuthor = normalizeMatchText(detailBook && detailBook.authors ? detailBook.authors : '')
    const enrichedAuthor = normalizeMatchText(enrichedBook && enrichedBook.authors ? enrichedBook.authors : '')

    if (
      detailTitleVariants.length > 0
      && enrichedTitle
      && !containsAnyComparableText(enrichedTitle, detailTitleVariants)
    ) {
      return false
    }

    if (
      detailAuthor
      && enrichedAuthor
      && enrichedAuthor.indexOf(detailAuthor) === -1
      && detailAuthor.indexOf(enrichedAuthor) === -1
    ) {
      return false
    }

    return true
  }

  function preferBookField(primaryValue, fallbackValue, minLength) {
    if (hasMeaningfulBookField(primaryValue, minLength)) {
      return primaryValue
    }

    if (hasMeaningfulBookField(fallbackValue, minLength)) {
      return fallbackValue
    }

    return primaryValue || fallbackValue || ''
  }

  function buildEnrichedDetailResult(detailResult, enrichedDoc, enrichmentLookup) {
    const detailBook = detailResult && detailResult.book ? detailResult.book : {}
    const mergedBook = Object.assign({}, detailBook)

    mergedBook.bookname = preferBookField(detailBook.bookname, enrichedDoc && enrichedDoc.bookname, 1)
    mergedBook.authors = preferBookField(detailBook.authors, enrichedDoc && enrichedDoc.authors, 1)
    mergedBook.publisher = preferBookField(detailBook.publisher, enrichedDoc && enrichedDoc.publisher, 1)
    mergedBook.publication_date = preferBookField(
      detailBook.publication_date,
      enrichedDoc && enrichedDoc.publication_date,
      1
    )
    mergedBook.publication_year = preferBookField(
      detailBook.publication_year,
      enrichedDoc && enrichedDoc.publication_year,
      1
    )
    mergedBook.description = preferBookField(detailBook.description, enrichedDoc && enrichedDoc.description, 30)
    mergedBook.bookImageURL = preferBookField(detailBook.bookImageURL, enrichedDoc && enrichedDoc.bookImageURL, 1)
    mergedBook.class_no = preferBookField(detailBook.class_no, enrichedDoc && enrichedDoc.class_no, 1)
    mergedBook.class_nm = preferBookField(detailBook.class_nm, enrichedDoc && enrichedDoc.class_nm, 1)
    mergedBook.isbn = preferBookField(detailBook.isbn, enrichedDoc && enrichedDoc.isbn, 1)
    mergedBook.isbn13 = preferBookField(detailBook.isbn13, enrichedDoc && enrichedDoc.isbn13, 1)

    return {
      request: detailResult.request || {},
      book: mergedBook,
      detail: Array.isArray(detailResult.detail) ? detailResult.detail : [],
      loanInfo: Array.isArray(detailResult.loanInfo) ? detailResult.loanInfo : [],
      raw: Object.assign({}, detailResult.raw || {}, {
        enrichment: {
          searchKeyword: enrichmentLookup && enrichmentLookup.searchKeyword ? enrichmentLookup.searchKeyword : '',
          matchedSource: enrichmentLookup && enrichmentLookup.matchedSource ? enrichmentLookup.matchedSource : '',
          matchedScore:
            enrichmentLookup && typeof enrichmentLookup.matchedScore === 'number' ? enrichmentLookup.matchedScore : -1,
          matchedIsbn13: enrichedDoc && enrichedDoc.isbn13 ? String(enrichedDoc.isbn13) : '',
        },
      }),
    }
  }

  function loadBookDetailByIsbn13(isbn13) {
    const normalizedIsbn13 = extractDigits(isbn13).slice(0, 13)

    if (normalizedIsbn13.length !== 13) {
      return null
    }

    if (lookupUnavailable) {
      dbg(logPrefix + ':detail-by-isbn13:skipped', { isbn13: normalizedIsbn13 })
      return null
    }

    dbg(logPrefix + ':detail-by-isbn13:start', {
      isbn13: normalizedIsbn13,
    })

    try {
      const detailResult = data4libraryService.getBookDetail({ apiKey: apiKey }, { isbn13: normalizedIsbn13 })

      dbg(logPrefix + ':detail-by-isbn13:done', {
        isbn13: normalizedIsbn13,
        found: !!(detailResult && detailResult.book),
        bookname: detailResult && detailResult.book ? String(detailResult.book.bookname || '') : '',
      })

      if (!detailResult || !detailResult.book) {
        return null
      }

      return detailResult
    } catch (exception) {
      lookupUnavailable = true
      warn(logPrefix + ':detail-by-isbn13:failed', {
        isbn13: normalizedIsbn13,
        error: String(exception && exception.message ? exception.message : exception),
      })
      return null
    }
  }

  function loadBookDetailByIsbnCandidates(isbnCandidates) {
    const candidates = Array.isArray(isbnCandidates) ? isbnCandidates : []

    for (
      let index = 0;
      index < candidates.length && index < MAX_ISBN_DETAIL_LOOKUPS && !lookupUnavailable;
      index += 1
    ) {
      const candidate = candidates[index]
      const detailResult = loadBookDetailByIsbn13(candidate.isbn13)

      dbg(logPrefix + ':isbn-candidate-result', {
        isbn13: candidate.isbn13,
        source: candidate.source,
        entryPath: candidate.entryPath || '',
        found: !!(detailResult && detailResult.book),
      })

      if (detailResult && detailResult.book) {
        return {
          detailResult: detailResult,
          matchedCandidate: candidate,
        }
      }
    }

    return {
      detailResult: null,
      matchedCandidate: null,
    }
  }

  function findBestBookSearchResult(epubMetadata, supplementalMetadata, originalName) {
    const profiles = collectSearchProfiles(epubMetadata, supplementalMetadata, originalName)
    let selectedDoc = null
    let selectedSearchKeyword = ''
    let selectedSearchResult = null
    let selectedSearchScore = -1
    let matchedSource = ''
    let matchedBy = ''

    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index]
      const keyword = profile.keyword
      dbg(logPrefix + ':search-attempt', {
        query: profile.query,
        keyword: keyword,
        source: profile.source,
      })
      let searchResult = null

      try {
        searchResult = loadSearchDocsByQuery(profile.query)
      } catch (exception) {
        // 검색 API가 응답하지 않으면 남은 검색도 같은 시간만큼 기다리게 되므로, EPUB 정보만으로 진행합니다.
        warn(logPrefix + ':search-failed', {
          source: profile.source,
          error: String(exception && exception.message ? exception.message : exception),
        })
        break
      }

      const bestMatch = chooseBestSearchDoc(searchResult.docs, {
        title: profile.title,
        author: profile.author,
        translator: profile.translator,
        publisher: profile.publisher,
        isbn13: '',
      })

      dbg(logPrefix + ':search-result', {
        query: profile.query,
        keyword: keyword,
        source: profile.source,
        numFound: searchResult.numFound,
        docsCount: Array.isArray(searchResult.docs) ? searchResult.docs.length : 0,
        bestScore: bestMatch.bestScore,
        matchedIsbn13: bestMatch.bestDoc && bestMatch.bestDoc.isbn13 ? String(bestMatch.bestDoc.isbn13) : '',
        matchedBookname: bestMatch.bestDoc && bestMatch.bestDoc.bookname ? String(bestMatch.bestDoc.bookname) : '',
      })

      if (bestMatch.bestDoc && bestMatch.bestScore >= MIN_BOOK_SEARCH_SCORE) {
        info(logPrefix + ':search-selected', {
          keyword: keyword,
          source: profile.source,
          score: bestMatch.bestScore,
          title: profile.title,
          author: profile.author,
          translator: profile.translator || '',
          publisher: profile.publisher || '',
          matchedBookname: bestMatch.bestDoc && bestMatch.bestDoc.bookname ? String(bestMatch.bestDoc.bookname) : '',
          matchedAuthors: bestMatch.bestDoc && bestMatch.bestDoc.authors ? String(bestMatch.bestDoc.authors) : '',
          matchedPublisher: bestMatch.bestDoc && bestMatch.bestDoc.publisher ? String(bestMatch.bestDoc.publisher) : '',
          matchedIsbn13: bestMatch.bestDoc && bestMatch.bestDoc.isbn13 ? String(bestMatch.bestDoc.isbn13) : '',
          scoreDetails: bestMatch.bestScoreDetails || {},
        })
        selectedDoc = bestMatch.bestDoc
        selectedSearchKeyword = keyword
        selectedSearchResult = searchResult
        selectedSearchScore = bestMatch.bestScore
        matchedSource = profile.source
        matchedBy = profile.query.keyword ? 'keyword' : 'structured-fields'
        break
      }
    }

    return {
      searchKeyword: selectedSearchKeyword,
      searchResult: selectedSearchResult,
      selectedDoc: selectedDoc,
      detailResult: null,
      matchedSource: matchedSource,
      matchedScore: selectedSearchScore,
      matchedBy: matchedBy,
    }
  }

  function resolveBookLookup(
    epubMetadata,
    archiveEntries,
    manifestItems,
    packageDocumentPath,
    entryNames,
    originalName
  ) {
    const isbnCandidates = collectEpubIsbnCandidates(
      epubMetadata,
      archiveEntries,
      manifestItems,
      packageDocumentPath,
      entryNames
    )
    const supplementalMetadata = collectSupplementalSearchMetadata(
      epubMetadata,
      archiveEntries,
      manifestItems,
      packageDocumentPath,
      entryNames
    )

    dbg(logPrefix + ':isbn-candidates', {
      count: isbnCandidates.length,
      items: isbnCandidates.map(function (candidate) {
        return {
          isbn13: candidate.isbn13,
          source: candidate.source,
          entryPath: candidate.entryPath || '',
          context: candidate.context || '',
        }
      }),
    })

    dbg(logPrefix + ':search-metadata', {
      translator: supplementalMetadata.translator || '',
      publisher: supplementalMetadata.publisher || '',
    })

    const detailLookup = loadBookDetailByIsbnCandidates(isbnCandidates)

    if (detailLookup.detailResult && detailLookup.detailResult.book) {
      const detailBook = detailLookup.detailResult.book
      const detailRichness = summarizeBookMetadataRichness(detailBook)

      info(logPrefix + ':detail-selected', {
        isbn13: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.isbn13 : '',
        source: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.source : '',
        bookname: detailBook.bookname ? String(detailBook.bookname) : '',
        authors: detailBook.authors ? String(detailBook.authors) : '',
        richness: detailRichness,
      })

      if (isSparseDetailBook(detailBook)) {
        const enrichmentLookup = findBestBookSearchResult(epubMetadata, supplementalMetadata, originalName)

        if (enrichmentLookup.selectedDoc && canUseEnrichmentBook(detailBook, enrichmentLookup.selectedDoc)) {
          const enrichedDetailResult = buildEnrichedDetailResult(
            detailLookup.detailResult,
            enrichmentLookup.selectedDoc,
            enrichmentLookup
          )

          info(logPrefix + ':detail-enriched', {
            isbn13: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.isbn13 : '',
            searchKeyword: enrichmentLookup.searchKeyword,
            matchedSource: enrichmentLookup.matchedSource || '',
            matchedScore: enrichmentLookup.matchedScore,
            enrichedIsbn13:
              enrichmentLookup.selectedDoc && enrichmentLookup.selectedDoc.isbn13
                ? String(enrichmentLookup.selectedDoc.isbn13)
                : '',
            beforeRichness: detailRichness,
            afterRichness: summarizeBookMetadataRichness(enrichedDetailResult.book),
          })

          return {
            searchKeyword: enrichmentLookup.searchKeyword,
            searchResult: enrichmentLookup.searchResult,
            selectedDoc: enrichmentLookup.selectedDoc,
            detailResult: enrichedDetailResult,
            matchedBy: 'isbn13+enriched',
            matchedSource:
              (detailLookup.matchedCandidate ? detailLookup.matchedCandidate.source : '')
              + '+'
              + (enrichmentLookup.matchedSource || ''),
            matchedScore: enrichmentLookup.matchedScore,
            matchedIsbn13: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.isbn13 : '',
          }
        }

        info(logPrefix + ':detail-sparse-no-enrichment', {
          isbn13: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.isbn13 : '',
          richness: detailRichness,
        })
      }

      return {
        searchKeyword: '',
        searchResult: null,
        selectedDoc: detailLookup.detailResult.book,
        detailResult: detailLookup.detailResult,
        matchedBy: 'isbn13',
        matchedSource: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.source : '',
        matchedScore: 0,
        matchedIsbn13: detailLookup.matchedCandidate ? detailLookup.matchedCandidate.isbn13 : '',
      }
    }

    const searchLookup = findBestBookSearchResult(epubMetadata, supplementalMetadata, originalName)

    return {
      searchKeyword: searchLookup.searchKeyword,
      searchResult: searchLookup.searchResult,
      selectedDoc: searchLookup.selectedDoc,
      detailResult: searchLookup.detailResult,
      matchedBy: searchLookup.matchedBy,
      matchedSource: searchLookup.matchedSource || '',
      matchedScore: searchLookup.matchedScore,
      matchedIsbn13:
        searchLookup.selectedDoc && searchLookup.selectedDoc.isbn13 ? String(searchLookup.selectedDoc.isbn13) : '',
    }
  }

  return {
    MAX_EPUB_BYTES: MAX_EPUB_BYTES,
    normalizePreview: normalizePreview,
    dirname: dirname,
    joinPath: joinPath,
    readArchiveText: readArchiveText,
    readUploadedFileBytes: readUploadedFileBytes,
    readUploadedEpubArchiveSnapshot: readUploadedEpubArchiveSnapshot,
    parseXmlDocument: parseXmlDocument,
    parseContainerRootfilePath: parseContainerRootfilePath,
    extractPrimaryAuthorName: extractPrimaryAuthorName,
    parseFilenameMetadata: parseFilenameMetadata,
    stripFileExtension: stripFileExtension,
    parsePublicationDate: parsePublicationDate,
    parseManifestItems: parseManifestItems,
    parseEpubMetadata: parseEpubMetadata,
    htmlToPlainText: htmlToPlainText,
    buildEpubTextFileHash: buildEpubTextFileHash,
    buildLegacyBinaryFileHash: buildLegacyBinaryFileHash,
    resolveBookLookup: resolveBookLookup,
    loadBookDetailByIsbn13: loadBookDetailByIsbn13,
  }
}

module.exports = {
  create: createEpubBookMetadataService,
}
