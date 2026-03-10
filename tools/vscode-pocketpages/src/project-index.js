'use strict'

const fs = require('fs')
const path = require('path')

const RESOLVE_EXTENSIONS = ['.js', '.ejs', '.json', '.cjs', '.mjs']
const INCLUDE_EXTENSIONS = ['.ejs']
const ROUTE_EXTENSIONS = ['.ejs', '.js', '.cjs', '.mjs']
const ROUTE_METHOD_BY_FILE_BASENAME = {
  '+delete': 'DELETE',
  '+get': 'GET',
  '+patch': 'PATCH',
  '+post': 'POST',
  '+put': 'PUT',
}
const NON_ROUTE_SPECIAL_FILE_BASENAMES = new Set(['+config', '+layout', '+load', '+middleware'])
const COLLECTION_METHOD_RE = /\$app\.(?:findRecordsByFilter|findFirstRecordByFilter|findRecordById)\(\s*['"]([^'"]+)['"]/g

function normalizePath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/')
}

function toRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/')
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch (_error) {
    return false
  }
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch (_error) {
    return false
  }
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value
  }

  return []
}

function stripKnownExtension(filePath, extensions) {
  for (const extension of extensions) {
    if (filePath.endsWith(extension)) {
      return filePath.slice(0, -extension.length)
    }
  }

  return filePath
}

function walkFiles(dirPath, predicate, rootDir = dirPath, results = []) {
  if (!directoryExists(dirPath)) {
    return results
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const absolutePath = normalizePath(path.join(dirPath, entry.name))

    if (entry.isDirectory()) {
      walkFiles(absolutePath, predicate, rootDir, results)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    if (predicate(absolutePath)) {
      results.push({
        filePath: absolutePath,
        relativePath: toRelativePath(path.relative(rootDir, absolutePath)),
      })
    }
  }

  return results
}

function quoteRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toPlural(name) {
  if (!name) {
    return name
  }

  if (name.endsWith('ies')) {
    return name
  }

  if (name.endsWith('y')) {
    return `${name.slice(0, -1)}ies`
  }

  if (name.endsWith('s')) {
    return name
  }

  return `${name}s`
}

function toSingular(name) {
  if (!name) {
    return name
  }

  if (name.endsWith('ies')) {
    return `${name.slice(0, -3)}y`
  }

  if (name.endsWith('s')) {
    return name.slice(0, -1)
  }

  return name
}

function getLastPathSegment(value) {
  return String(value || '')
    .split('.')
    .filter(Boolean)
    .pop() || ''
}

function isRouteGroupSegment(segment) {
  return /^\(.+\)$/.test(String(segment || ''))
}

function isDynamicRouteSegment(segment) {
  return /^\[(\.\.\.)?[^\]]+\]$/.test(String(segment || ''))
}

function normalizeRoutePath(routePath) {
  let value = String(routePath || '').trim()
  if (!value || !value.startsWith('/')) {
    return null
  }

  if (value.startsWith('//')) {
    return null
  }

  const markerIndex = value.search(/[?#]/)
  if (markerIndex !== -1) {
    value = value.slice(0, markerIndex)
  }

  value = value.replace(/\/+/g, '/')
  if (value.length > 1) {
    value = value.replace(/\/+$/, '')
  }

  return value || '/'
}

function getPreferredRouteMethods(routeSource) {
  switch (String(routeSource || '').toLowerCase()) {
    case 'action':
    case 'hx-post':
      return ['POST', 'GET']
    case 'hx-put':
      return ['PUT', 'GET']
    case 'hx-delete':
      return ['DELETE', 'GET']
    case 'hx-patch':
      return ['PATCH', 'GET']
    case 'href':
    case 'redirect':
    case 'hx-get':
    default:
      return ['GET']
  }
}

class PocketPagesProjectIndex {
  constructor(appRoot) {
    this.appRoot = normalizePath(appRoot)
    this.pagesRoot = normalizePath(path.join(this.appRoot, 'pb_hooks', 'pages'))
    this.schemaCache = null
  }

  getSchemaState() {
    const schemaPath = normalizePath(path.join(this.appRoot, 'pb_schema.json'))
    if (!fileExists(schemaPath)) {
      this.schemaCache = {
        schemaPath,
        mtimeMs: 0,
        collections: [],
        collectionsByName: new Map(),
      }
      return this.schemaCache
    }

    const stats = fs.statSync(schemaPath)
    if (this.schemaCache && this.schemaCache.mtimeMs === stats.mtimeMs) {
      return this.schemaCache
    }

    const raw = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
    const collections = ensureArray(raw)
    const collectionsByName = new Map()

    for (const collection of collections) {
      if (!collection || typeof collection.name !== 'string') {
        continue
      }

      const fields = ensureArray(collection.fields)
        .filter((field) => field && typeof field.name === 'string')
        .map((field) => ({
          name: field.name,
          type: field.type || '',
        }))

      collectionsByName.set(collection.name, {
        name: collection.name,
        fields,
      })
    }

    this.schemaCache = {
      schemaPath,
      mtimeMs: stats.mtimeMs,
      collections,
      collectionsByName,
    }

    return this.schemaCache
  }

  getCollectionNames() {
    return Array.from(this.getSchemaState().collectionsByName.keys()).sort((left, right) => {
      const leftIsSystem = left.startsWith('_')
      const rightIsSystem = right.startsWith('_')

      if (leftIsSystem !== rightIsSystem) {
        return leftIsSystem ? 1 : -1
      }

      return left.localeCompare(right)
    })
  }

  getFields(collectionName) {
    const collection = this.getSchemaState().collectionsByName.get(collectionName)
    if (!collection) {
      return []
    }

    return [...collection.fields]
  }

  hasCollection(collectionName) {
    return this.getSchemaState().collectionsByName.has(collectionName)
  }

  getFieldNames(collectionName) {
    return this.getFields(collectionName)
      .map((field) => field.name)
      .sort()
  }

  hasField(collectionName, fieldName) {
    return this.getFieldNames(collectionName).includes(fieldName)
  }

  getRouteParamEntries(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    const relativePath = toRelativePath(path.relative(this.pagesRoot, normalizedFilePath))
    const segments = relativePath.split('/').filter(Boolean)
    const entries = []
    const seen = new Set()

    for (let index = 0; index < segments.length; index += 1) {
      const rawSegment = segments[index]
      const isLeaf = index === segments.length - 1
      const segment = isLeaf ? rawSegment.replace(/\.[^.]+$/, '') : rawSegment

      if (!segment || segment.startsWith('+') || /^\(.+\)$/.test(segment) || segment === 'index') {
        continue
      }

      const match = segment.match(/^\[(\.\.\.)?([^\]]+)\]$/)
      if (!match) {
        continue
      }

      const isSpread = !!match[1]
      const paramName = match[2]
      if (seen.has(paramName)) {
        continue
      }

      seen.add(paramName)
      entries.push({
        name: paramName,
        type: isSpread ? 'string[] | undefined' : 'string | undefined',
      })
    }

    return entries
  }

  getPrivateSearchRoots(filePath) {
    const roots = []
    let currentDir = normalizePath(path.dirname(filePath))

    while (currentDir.startsWith(this.pagesRoot)) {
      const privateDir = normalizePath(path.join(currentDir, '_private'))
      if (directoryExists(privateDir)) {
        roots.push(privateDir)
      }

      if (currentDir === this.pagesRoot) {
        break
      }

      currentDir = normalizePath(path.dirname(currentDir))
    }

    return roots
  }

  getResolveCandidates(filePath) {
    const items = []
    const seen = new Set()

    for (const privateRoot of this.getPrivateSearchRoots(filePath)) {
      const files = walkFiles(privateRoot, (candidatePath) => RESOLVE_EXTENSIONS.includes(path.extname(candidatePath)))

      for (const entry of files) {
        let value = stripKnownExtension(entry.relativePath, RESOLVE_EXTENSIONS)
        if (value.endsWith('/index')) {
          value = value.slice(0, -'/index'.length)
        }

        if (!value || seen.has(value)) {
          continue
        }

        seen.add(value)
        items.push({
          value,
          filePath: entry.filePath,
          detail: toRelativePath(path.relative(this.pagesRoot, entry.filePath)),
        })
      }
    }

    return items
  }

  resolveResolveTarget(filePath, requestPath) {
    const normalizedRequestPath = String(requestPath || '').trim().replace(/^\/+/, '')
    if (!normalizedRequestPath) {
      return null
    }

    for (const privateRoot of this.getPrivateSearchRoots(filePath)) {
      const candidatePaths = [
        normalizePath(path.join(privateRoot, normalizedRequestPath)),
        ...RESOLVE_EXTENSIONS.map((extension) => normalizePath(path.join(privateRoot, `${normalizedRequestPath}${extension}`))),
        ...RESOLVE_EXTENSIONS.map((extension) => normalizePath(path.join(privateRoot, normalizedRequestPath, `index${extension}`))),
      ]

      for (const candidatePath of candidatePaths) {
        if (fileExists(candidatePath)) {
          return candidatePath
        }
      }
    }

    return null
  }

  getIncludeCandidates(filePath) {
    const currentDir = normalizePath(path.dirname(filePath))
    const items = []
    const seen = new Set()

    const addCandidate = (value, absolutePath) => {
      if (!value || seen.has(value)) {
        return
      }

      seen.add(value)
      items.push({
        value,
        filePath: absolutePath,
        detail: toRelativePath(path.relative(this.pagesRoot, absolutePath)),
      })
    }

    const localFiles = walkFiles(
      currentDir,
      (candidatePath) => INCLUDE_EXTENSIONS.includes(path.extname(candidatePath)) && normalizePath(candidatePath) !== normalizePath(filePath),
      currentDir
    )

    for (const entry of localFiles) {
      const baseName = path.basename(entry.relativePath)
      if (entry.relativePath.includes('/') || baseName === 'index.ejs' || baseName.startsWith('+')) {
        continue
      }

      addCandidate(entry.relativePath, entry.filePath)
    }

    for (const privateRoot of this.getPrivateSearchRoots(filePath)) {
      const files = walkFiles(privateRoot, (candidatePath) => INCLUDE_EXTENSIONS.includes(path.extname(candidatePath)))
      for (const entry of files) {
        addCandidate(entry.relativePath, entry.filePath)
      }
    }

    return items
  }

  resolveIncludeTarget(filePath, requestPath) {
    const normalizedRequestPath = String(requestPath || '').trim()
    if (!normalizedRequestPath) {
      return null
    }

    const candidatePaths = []
    const currentDir = normalizePath(path.dirname(filePath))

    if (normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../')) {
      candidatePaths.push(normalizePath(path.join(currentDir, normalizedRequestPath)))
    } else {
      candidatePaths.push(normalizePath(path.join(currentDir, normalizedRequestPath)))
      candidatePaths.push(normalizePath(path.join(this.pagesRoot, normalizedRequestPath)))

      for (const privateRoot of this.getPrivateSearchRoots(filePath)) {
        candidatePaths.push(normalizePath(path.join(privateRoot, normalizedRequestPath)))
      }
    }

    for (const candidatePath of candidatePaths) {
      if (fileExists(candidatePath)) {
        return candidatePath
      }
    }

    return null
  }

  getStaticRouteEntries() {
    const files = walkFiles(
      this.pagesRoot,
      (candidatePath) => {
        if (!ROUTE_EXTENSIONS.includes(path.extname(candidatePath))) {
          return false
        }

        const relativePath = toRelativePath(path.relative(this.pagesRoot, candidatePath))
        return !relativePath.split('/').includes('_private')
      },
      this.pagesRoot
    )

    const entries = []

    for (const entry of files) {
      const relativeSegments = entry.relativePath.split('/').filter(Boolean)
      if (!relativeSegments.length) {
        continue
      }

      const fileName = relativeSegments[relativeSegments.length - 1]
      const fileBasename = stripKnownExtension(fileName, ROUTE_EXTENSIONS)
      const directorySegments = relativeSegments.slice(0, -1)
      const routeSegments = []
      let isStaticRoute = true

      for (const segment of directorySegments) {
        if (!segment || isRouteGroupSegment(segment)) {
          continue
        }

        if (segment.startsWith('+') || isDynamicRouteSegment(segment)) {
          isStaticRoute = false
          break
        }

        routeSegments.push(segment)
      }

      if (!isStaticRoute) {
        continue
      }

      let method = null
      if (fileBasename === 'index') {
        method = null
      } else if (ROUTE_METHOD_BY_FILE_BASENAME[fileBasename]) {
        method = ROUTE_METHOD_BY_FILE_BASENAME[fileBasename]
      } else if (NON_ROUTE_SPECIAL_FILE_BASENAMES.has(fileBasename) || fileBasename.startsWith('+')) {
        continue
      } else if (isDynamicRouteSegment(fileBasename)) {
        continue
      } else {
        routeSegments.push(fileBasename)
      }

      entries.push({
        filePath: entry.filePath,
        method,
        routePath: routeSegments.length ? `/${routeSegments.join('/')}` : '/',
      })
    }

    return entries
  }

  resolveRouteTarget(_filePath, requestPath, options = {}) {
    const normalizedRequestPath = normalizeRoutePath(requestPath)
    if (!normalizedRequestPath) {
      return null
    }

    const preferredMethods = getPreferredRouteMethods(options.routeSource)
    const matchingEntries = this.getStaticRouteEntries().filter((entry) => entry.routePath === normalizedRequestPath)
    if (!matchingEntries.length) {
      return null
    }

    matchingEntries.sort((left, right) => {
      const leftRank = this.getRouteEntryRank(left, preferredMethods)
      const rightRank = this.getRouteEntryRank(right, preferredMethods)
      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }

      return left.filePath.localeCompare(right.filePath)
    })

    return matchingEntries[0].filePath
  }

  getRouteEntryRank(entry, preferredMethods) {
    if (!entry.method) {
      return 1
    }

    const preferredIndex = preferredMethods.indexOf(entry.method)
    if (preferredIndex !== -1) {
      return preferredIndex === 0 ? 0 : 2 + preferredIndex
    }

    return 10
  }

  inferCollectionName(receiverExpression, scriptText, beforeOffset) {
    const receiverName = getLastPathSegment(receiverExpression)
    const collectionNames = this.getCollectionNames()

    for (const candidate of [receiverName, toPlural(receiverName), toSingular(receiverName)]) {
      if (collectionNames.includes(candidate)) {
        return candidate
      }
    }

    const genericNames = new Set(['record', 'item', 'entry', 'row'])
    const scriptPrefix = scriptText.slice(0, beforeOffset)
    const collectionMatches = Array.from(scriptPrefix.matchAll(COLLECTION_METHOD_RE))
      .map((match) => match[1])
      .filter((name) => this.hasCollection(name))

    if (collectionMatches.length) {
      const lastCollection = collectionMatches[collectionMatches.length - 1]
      if (lastCollection) {
        return lastCollection
      }
    }

    if (genericNames.has(receiverName)) {
      const allMatches = Array.from(scriptText.matchAll(COLLECTION_METHOD_RE))
        .map((match) => match[1])
        .filter((name) => this.hasCollection(name))
      const uniqueCollections = [...new Set(allMatches)]
      if (uniqueCollections.length === 1) {
        return uniqueCollections[0]
      }
    }

    const singularReceiver = toSingular(receiverName)
    for (const collectionName of collectionNames) {
      if (toSingular(collectionName) === singularReceiver) {
        return collectionName
      }
    }

    return null
  }
}

module.exports = {
  PocketPagesProjectIndex,
  normalizePath,
  fileExists,
  quoteRegex,
}
