'use strict'

const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const { buildTemplateVirtualText } = require('../language-core/ejs-template')
const { statFileExists, statDirectoryExists, statSyncCached } = require('./stat-cache')

const RESOLVE_EXTENSIONS = ['.js', '.json', '.cjs', '.mjs']
const REQUIRE_EXTENSIONS = ['.js', '.json', '.cjs', '.mjs']
const INCLUDE_EXTENSIONS = ['.ejs']
const ROUTE_EXTENSIONS = ['.ejs', '.js', '.cjs', '.mjs']
const ROUTE_COMPLETION_EXTENSIONS = ['.ejs']
const PAGES_CODE_EXTENSIONS = ['.ejs', '.js', '.cjs', '.mjs']
const ASSET_SCRIPT_EXTENSIONS = ['.js', '.cjs', '.mjs']
const ROUTE_METHOD_BY_FILE_BASENAME = {
  '+delete': 'DELETE',
  '+get': 'GET',
  '+patch': 'PATCH',
  '+post': 'POST',
  '+put': 'PUT',
}
const NON_ROUTE_SPECIAL_FILE_BASENAMES = new Set(['+config', '+layout', '+load', '+middleware'])
const DEFAULT_COLLECTION_METHOD_NAMES = [
  'countRecords',
  'findAuthRecordByEmail',
  'findCachedCollectionByNameOrId',
  'findCollectionByNameOrId',
  'findFirstRecordByData',
  'findFirstRecordByFilter',
  'findRecordById',
  'findRecordByViewFile',
  'findRecordsByFilter',
  'findRecordsByIds',
  'findAllRecords',
  'isCollectionNameUnique',
  'recordQuery',
]
const HIGH_CONFIDENCE_SINGLE_RECORD_METHOD_NAMES = new Set([
  'findAuthRecordByEmail',
  'findFirstRecordByData',
  'findFirstRecordByFilter',
  'findRecordById',
  'findRecordByViewFile',
])
const HIGH_CONFIDENCE_COLLECTION_MODEL_METHOD_NAMES = new Set([
  'findCachedCollectionByNameOrId',
  'findCollectionByNameOrId',
])
const HIGH_CONFIDENCE_RECORD_ARRAY_METHOD_NAMES = new Set([
  'findRecordsByFilter',
])
const ARRAY_COLLECTION_PASSTHROUGH_METHOD_NAMES = new Set([
  'filter',
  'slice',
])
const DIRECT_CALLBACK_COLLECTION_METHOD_NAMES = new Set([
  'filter',
  'forEach',
  'map',
])
const AMBIGUOUS_INFERENCE_VALUE = Symbol('ambiguous-inference-value')
const ARRAY_ELEMENT_RECEIVER_RE = /^([A-Za-z_$][\w$]*)\[(?:\d+|[A-Za-z_$][\w$]*)\]$/
const POCKETPAGES_GLOBAL_NAMES = new Set([
  'api',
  'asset',
  'auth',
  'body',
  'data',
  'dbg',
  'echo',
  'env',
  'error',
  'formData',
  'include',
  'info',
  'meta',
  'params',
  'redirect',
  'request',
  'resolve',
  'response',
  'signInWithPassword',
  'signOut',
  'slot',
  'slots',
  'store',
  'stringify',
  'url',
  'warn',
])

function normalizePath(filePath) {
  const normalizedPath = path.resolve(filePath).replace(/\\/g, '/')
  return normalizedPath.replace(/^[A-Z]:/, (value) => value.toLowerCase())
}

function isEjsFile(filePath) {
  return path.extname(String(filePath || '')).toLowerCase() === '.ejs'
}

function isValidIdentifierName(value) {
  return ts.isIdentifierText(String(value || ''), ts.ScriptTarget.Latest, ts.LanguageVariant.Standard)
}

function toRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/')
}

function fileExists(filePath) {
  return statFileExists(filePath)
}

function directoryExists(dirPath) {
  return statDirectoryExists(dirPath)
}

function hashText(value) {
  const text = String(value || '')
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function isRecoverableFileSystemReadError(error) {
  const code = error && error.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM'
}

function readDirectoryEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (error) {
    if (isRecoverableFileSystemReadError(error)) {
      return []
    }
    throw error
  }
}

function readSmallFileIdentity(filePath) {
  const normalizedFilePath = normalizePath(filePath)
  if (!fileExists(normalizedFilePath)) {
    return {
      filePath: normalizedFilePath,
      exists: false,
      mtimeMs: 0,
      size: 0,
      hash: 'missing',
      text: '',
    }
  }

  try {
    const stats = statSyncCached(normalizedFilePath)
    const text = fs.readFileSync(normalizedFilePath, 'utf8')
    return {
      filePath: normalizedFilePath,
      exists: true,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      hash: hashText(text),
      text,
    }
  } catch (error) {
    if (isRecoverableFileSystemReadError(error)) {
      return {
        filePath: normalizedFilePath,
        exists: false,
        mtimeMs: 0,
        size: 0,
        hash: 'missing',
        text: '',
      }
    }
    throw error
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

function getPathCompletionRequestOptions(requestPath, extensions) {
  const normalizedRequestPath = String(requestPath || '').trim()

  return {
    keepExtension: shouldKeepPathCompletionExtension(normalizedRequestPath, extensions),
    prefixKind: normalizedRequestPath.startsWith('/')
      ? 'absolute'
      : normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../')
        ? 'relative'
        : 'implicit',
  }
}

function buildPathCompletionCandidateValue(relativePath, extensions, options = {}) {
  const normalizedRelativePath = toRelativePath(relativePath)
  const keepExtension = !!options.keepExtension
  const prefixKind = String(options.prefixKind || 'implicit')
  const depth = Math.max(0, Number(options.depth) || 0)
  const trimIndex = !!options.trimIndex
  let value = keepExtension ? normalizedRelativePath : stripKnownExtension(normalizedRelativePath, extensions)

  if (trimIndex && value.endsWith('/index')) {
    value = value.slice(0, -'/index'.length)
  }

  if (!value) {
    return ''
  }

  if (prefixKind === 'absolute') {
    return `/${value}`
  }

  if (prefixKind === 'relative') {
    return `${depth > 0 ? '../'.repeat(depth) : './'}${value}`
  }

  return value
}

function hasKnownExtension(filePath, extensions) {
  return extensions.includes(path.extname(String(filePath || '')).toLowerCase())
}

function isJavaScriptModuleFile(filePath) {
  return ['.js', '.cjs', '.mjs'].includes(path.extname(String(filePath || '')).toLowerCase())
}

function shouldKeepPathCompletionExtension(requestPath, extensions) {
  const normalizedRequestPath = String(requestPath || '').trim()
  if (hasKnownExtension(normalizedRequestPath, extensions)) {
    return true
  }

  const lastSegment = normalizedRequestPath.split('/').filter(Boolean).pop() || ''
  const dotIndex = lastSegment.lastIndexOf('.')
  if (dotIndex === -1) {
    return false
  }

  const partialExtension = lastSegment.slice(dotIndex).toLowerCase()
  return !!partialExtension && extensions.some((extension) => extension.startsWith(partialExtension))
}

function getIncludeRequestVariants(requestPath) {
  const normalizedRequestPath = String(requestPath || '').trim()
  const variants = []
  const seen = new Set()

  const addVariant = (value) => {
    const normalizedValue = String(value || '').trim()
    if (!normalizedValue || seen.has(normalizedValue)) {
      return
    }

    seen.add(normalizedValue)
    variants.push(normalizedValue)
  }

  addVariant(normalizedRequestPath)

  if (!hasKnownExtension(normalizedRequestPath, INCLUDE_EXTENSIONS)) {
    for (const extension of INCLUDE_EXTENSIONS) {
      addVariant(`${normalizedRequestPath}${extension}`)
    }
  }

  return variants
}

function getResolveRequestVariants(requestPath) {
  const normalizedRequestPath = String(requestPath || '').trim()
  const variants = []
  const seen = new Set()

  const addVariant = (value) => {
    const normalizedValue = String(value || '').trim()
    if (!normalizedValue || seen.has(normalizedValue)) {
      return
    }

    seen.add(normalizedValue)
    variants.push(normalizedValue)
  }

  addVariant(normalizedRequestPath)

  if (!hasKnownExtension(normalizedRequestPath, RESOLVE_EXTENSIONS)) {
    for (const extension of RESOLVE_EXTENSIONS) {
      addVariant(`${normalizedRequestPath}${extension}`)
    }
  }

  return variants
}

function parsePrivateSearchRequest(requestPath) {
  let remainingPath = String(requestPath || '').trim()
  let skipPrivateRootCount = 0

  while (remainingPath.startsWith('./')) {
    remainingPath = remainingPath.slice(2)
  }

  while (remainingPath.startsWith('../')) {
    skipPrivateRootCount += 1
    remainingPath = remainingPath.slice(3)
  }

  return {
    skipPrivateRootCount,
    searchPath: remainingPath,
  }
}

function walkFiles(dirPath, predicate, rootDir = dirPath, results = []) {
  if (!directoryExists(dirPath)) {
    return results
  }

  for (const entry of readDirectoryEntries(dirPath)) {
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

function walkPagesGraph(pagesRoot) {
  const normalizedPagesRoot = normalizePath(pagesRoot)
  const allFiles = []
  const privateRoots = new Set()
  const pendingDirectories = [normalizedPagesRoot]

  while (pendingDirectories.length) {
    const currentDir = pendingDirectories.pop()
    if (!directoryExists(currentDir)) {
      continue
    }

    for (const entry of readDirectoryEntries(currentDir)) {
      const absolutePath = normalizePath(path.join(currentDir, entry.name))
      if (entry.isDirectory()) {
        if (entry.name === '_private') {
          privateRoots.add(absolutePath)
        }
        pendingDirectories.push(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      allFiles.push({
        filePath: absolutePath,
        relativePath: toRelativePath(path.relative(normalizedPagesRoot, absolutePath)),
      })
    }
  }

  allFiles.sort((left, right) => left.filePath.localeCompare(right.filePath))

  return {
    allFiles,
    privateRoots,
  }
}

function quoteRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeTypeText(value) {
  return String(value || '').replace(/\s+/g, '')
}

function typeCanAcceptCollectionIdentifier(typeText) {
  const normalized = normalizeTypeText(typeText)
  if (!normalized) {
    return false
  }

  if (normalized === 'any' || normalized === 'unknown') {
    return true
  }

  return /(^|\|)string($|\|)/.test(normalized)
}

function isCollectionIdentifierParameter(methodName, parameterName, typeText, isRest) {
  if (isRest || !typeCanAcceptCollectionIdentifier(typeText)) {
    return false
  }

  const safeMethodName = String(methodName || '')
  const safeParameterName = String(parameterName || '')

  if (!safeMethodName || !safeParameterName) {
    return false
  }

  if (/collectionModelOrIdentifier$/i.test(safeParameterName)) {
    return true
  }

  if (/nameOrId$/i.test(safeParameterName) && /Collection/i.test(safeMethodName)) {
    return true
  }

  if (/collectionName$/i.test(safeParameterName)) {
    return true
  }

  if (/^name$/i.test(safeParameterName) && /CollectionName/i.test(safeMethodName)) {
    return true
  }

  return false
}

function findVariableDeclarationByName(sourceFile, variableName) {
  let match = null

  const visit = (node) => {
    if (match) {
      return
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      match = node
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return match
}

function extractCollectionMethodNamesFromAppType(typesPath) {
  const program = ts.createProgram([typesPath], {
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  })
  const sourceFile = program.getSourceFile(typesPath)
  if (!sourceFile) {
    return []
  }

  const checker = program.getTypeChecker()
  const appDeclaration = findVariableDeclarationByName(sourceFile, '$app')
  if (!appDeclaration) {
    return []
  }

  const appType = checker.getTypeAtLocation(appDeclaration.name)
  const methodNames = new Set()

  for (const property of appType.getProperties()) {
    const propertyName = property.getName()
    const declaration = property.valueDeclaration || (property.declarations && property.declarations[0]) || appDeclaration
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration)
    const signatures = propertyType.getCallSignatures()

    if (!signatures.length) {
      continue
    }

    const hasCollectionIdentifierSignature = signatures.some((signature) => {
      const parameters = signature.getParameters()
      if (!parameters.length) {
        return false
      }

      const firstParameter = parameters[0]
      const firstDeclaration = firstParameter.valueDeclaration || (firstParameter.declarations && firstParameter.declarations[0])
      const firstType = firstDeclaration
        ? checker.getTypeOfSymbolAtLocation(firstParameter, firstDeclaration)
        : checker.getTypeAtLocation(appDeclaration.name)

      return isCollectionIdentifierParameter(
        propertyName,
        firstParameter.getName(),
        checker.typeToString(firstType),
        !!(firstDeclaration && firstDeclaration.dotDotDotToken)
      )
    })

    if (hasCollectionIdentifierSignature) {
      methodNames.add(propertyName)
    }
  }

  return [...methodNames].sort()
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

function toSnakeCase(name) {
  return String(name || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function stripReceiverCollectionSuffix(name) {
  const value = String(name || '')
  const suffixes = ['Record', 'Item', 'Entry', 'Row', 'Model']

  for (const suffix of suffixes) {
    const suffixRegex = new RegExp(`${suffix}$`, 'i')
    if (value.length > suffix.length && suffixRegex.test(value)) {
      return value.slice(0, -suffix.length)
    }
  }

  return value
}

function buildCollectionReferenceCandidates(receiverName) {
  const seenNames = new Set()
  const candidates = []

  const addCandidate = (collectionName, confidence, strategy) => {
    const normalizedName = String(collectionName || '').trim()
    if (!normalizedName || seenNames.has(normalizedName)) {
      return
    }

    seenNames.add(normalizedName)
    candidates.push({
      collectionName: normalizedName,
      confidence,
      strategy,
    })
  }

  const strippedReceiverName = stripReceiverCollectionSuffix(receiverName)
  const receiverSnakeName = toSnakeCase(receiverName)
  const strippedReceiverSnakeName = toSnakeCase(strippedReceiverName)

  addCandidate(receiverName, 'high', 'receiver-name')
  addCandidate(toPlural(receiverName), 'high', 'receiver-pluralized')
  addCandidate(toSingular(receiverName), 'medium', 'receiver-singularized')

  if (strippedReceiverName && strippedReceiverName !== receiverName) {
    addCandidate(strippedReceiverName, 'high', 'receiver-suffix-stripped')
    addCandidate(toPlural(strippedReceiverName), 'high', 'receiver-suffix-stripped-pluralized')
    addCandidate(toSingular(strippedReceiverName), 'medium', 'receiver-suffix-stripped-singularized')
  }

  if (receiverSnakeName && receiverSnakeName !== receiverName) {
    addCandidate(receiverSnakeName, 'medium', 'receiver-snake-case')
    addCandidate(toPlural(receiverSnakeName), 'high', 'receiver-snake-pluralized')
    addCandidate(toSingular(receiverSnakeName), 'medium', 'receiver-snake-singularized')
  }

  if (strippedReceiverSnakeName && strippedReceiverSnakeName !== receiverSnakeName) {
    addCandidate(strippedReceiverSnakeName, 'medium', 'receiver-suffix-stripped-snake-case')
    addCandidate(toPlural(strippedReceiverSnakeName), 'high', 'receiver-suffix-stripped-snake-pluralized')
    addCandidate(
      toSingular(strippedReceiverSnakeName),
      'medium',
      'receiver-suffix-stripped-snake-singularized',
    )
  }

  return candidates
}

function isNullishAssignmentValue(node) {
  const target = skipExpressionWrappers(node)
  if (!target) {
    return false
  }

  if (target.kind === ts.SyntaxKind.NullKeyword) {
    return true
  }

  return ts.isIdentifier(target) && target.text === 'undefined'
}

function collectBindingIdentifierNames(bindingName, results = []) {
  if (!bindingName) {
    return results
  }

  if (ts.isIdentifier(bindingName)) {
    results.push(bindingName.text)
    return results
  }

  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (!element) {
        continue
      }

      if (ts.isBindingElement(element)) {
        collectBindingIdentifierNames(element.name, results)
      }
    }
  }

  return results
}

function createExplicitInferenceFrame(initialDeclaredNames = []) {
  const declaredNames = new Set()

  for (const name of ensureArray(initialDeclaredNames)) {
    if (isValidIdentifierName(name)) {
      declaredNames.add(name)
    }
  }

  return {
    declaredNames,
    stringConstants: new Map(),
    collectionModels: new Map(),
    recordVariables: new Map(),
    arrayVariables: new Map(),
    appReceiverNames: new Set(),
  }
}

function createExplicitInferenceState(options = {}) {
  return {
    frames: [createExplicitInferenceFrame()],
    filePath: typeof options.filePath === 'string' ? normalizePath(options.filePath) : '',
    resolveRequireTarget:
      typeof options.resolveRequireTarget === 'function'
        ? options.resolveRequireTarget
        : null,
    getModuleExportedStringConstants:
      typeof options.getModuleExportedStringConstants === 'function'
        ? options.getModuleExportedStringConstants
        : null,
  }
}

function getCurrentExplicitInferenceFrame(state) {
  return state.frames[state.frames.length - 1]
}

function withExplicitInferenceFrame(state, initialDeclaredNames, callback) {
  state.frames.push(createExplicitInferenceFrame(initialDeclaredNames))
  try {
    return callback()
  } finally {
    state.frames.pop()
  }
}

function declareExplicitInferenceName(state, variableName) {
  if (!isValidIdentifierName(variableName)) {
    return
  }

  getCurrentExplicitInferenceFrame(state).declaredNames.add(variableName)
}

function addExplicitInferenceAppReceiverName(state, variableName) {
  if (!isValidIdentifierName(variableName)) {
    return
  }

  getCurrentExplicitInferenceFrame(state).appReceiverNames.add(variableName)
}

function isExplicitInferenceAppReceiverName(state, variableName) {
  if (variableName === '$app') {
    return true
  }

  if (!isValidIdentifierName(variableName)) {
    return false
  }

  for (let index = state.frames.length - 1; index >= 0; index -= 1) {
    const frame = state.frames[index]
    if (frame.appReceiverNames.has(variableName)) {
      return true
    }

    if (frame.declaredNames.has(variableName)) {
      return false
    }
  }

  return false
}

function isExplicitInferenceAppReceiverExpression(node, state) {
  const target = skipExpressionWrappers(node)
  return !!(
    target &&
    ts.isIdentifier(target) &&
    isExplicitInferenceAppReceiverName(state, target.text)
  )
}

function findExplicitInferenceFrameForWrite(state, variableName) {
  for (let index = state.frames.length - 1; index >= 0; index -= 1) {
    const frame = state.frames[index]
    if (frame.declaredNames.has(variableName)) {
      return frame
    }
  }

  return getCurrentExplicitInferenceFrame(state)
}

function readExplicitInferenceValue(state, mapName, variableName) {
  for (let index = state.frames.length - 1; index >= 0; index -= 1) {
    const frame = state.frames[index]
    const trackedMap = frame[mapName]

    if (trackedMap && trackedMap.has(variableName)) {
      const value = trackedMap.get(variableName)
      return value === AMBIGUOUS_INFERENCE_VALUE ? null : value
    }

    if (frame.declaredNames.has(variableName)) {
      return null
    }
  }

  return null
}

function clearExplicitInferenceValues(frame, variableName, preservedMapName = '') {
  if (preservedMapName !== 'stringConstants') {
    frame.stringConstants.delete(variableName)
  }

  if (preservedMapName !== 'collectionModels') {
    frame.collectionModels.delete(variableName)
  }

  if (preservedMapName !== 'recordVariables') {
    frame.recordVariables.delete(variableName)
  }

  if (preservedMapName !== 'arrayVariables') {
    frame.arrayVariables.delete(variableName)
  }
}

function writeExplicitInferenceString(state, variableName, stringValue) {
  const frame = findExplicitInferenceFrameForWrite(state, variableName)
  const currentValue = frame.stringConstants.get(variableName)

  clearExplicitInferenceValues(frame, variableName, 'stringConstants')

  if (currentValue === AMBIGUOUS_INFERENCE_VALUE) {
    frame.stringConstants.set(variableName, AMBIGUOUS_INFERENCE_VALUE)
    return
  }

  if (typeof currentValue === 'string' && currentValue !== stringValue) {
    frame.stringConstants.set(variableName, AMBIGUOUS_INFERENCE_VALUE)
    return
  }

  frame.stringConstants.set(variableName, stringValue)
}

function writeExplicitInferenceReference(state, mapName, variableName, reference) {
  const frame = findExplicitInferenceFrameForWrite(state, variableName)
  const trackedMap = frame[mapName]
  const currentValue = trackedMap.get(variableName)

  clearExplicitInferenceValues(frame, variableName, mapName)

  if (currentValue === AMBIGUOUS_INFERENCE_VALUE) {
    trackedMap.set(variableName, AMBIGUOUS_INFERENCE_VALUE)
    return
  }

  if (currentValue && currentValue.collectionName !== reference.collectionName) {
    trackedMap.set(variableName, AMBIGUOUS_INFERENCE_VALUE)
    return
  }

  trackedMap.set(variableName, reference)
}

function clearExplicitInferenceReference(state, variableName) {
  const frame = findExplicitInferenceFrameForWrite(state, variableName)
  clearExplicitInferenceValues(frame, variableName)
}

function readCollectionNameExpression(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target) {
    return null
  }

  if (ts.isStringLiteralLike(target)) {
    return target.text
  }

  if (ts.isIdentifier(target)) {
    return readExplicitInferenceValue(state, 'stringConstants', target.text)
  }

  return null
}

function getAppPropertyCallDetails(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target || !ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression)) {
    return null
  }

  const owner = skipExpressionWrappers(target.expression.expression)
  if (!isExplicitInferenceAppReceiverExpression(owner, state)) {
    return null
  }

  return {
    callExpression: target,
    methodName: target.expression.name.text,
  }
}

function readCollectionModelReference(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return readExplicitInferenceValue(state, 'collectionModels', target.text)
  }

  const callDetails = getAppPropertyCallDetails(target, state)
  if (!callDetails || !HIGH_CONFIDENCE_COLLECTION_MODEL_METHOD_NAMES.has(callDetails.methodName)) {
    return null
  }

  const collectionName = readCollectionNameExpression(callDetails.callExpression.arguments[0], state)
  if (!collectionName) {
    return null
  }

  return {
    collectionName,
    confidence: 'high',
    strategy: `explicit-collection-model:${callDetails.methodName}`,
  }
}

function readDirectHighConfidenceRecordReference(node, state) {
  const callDetails = getAppPropertyCallDetails(node, state)
  if (!callDetails || !HIGH_CONFIDENCE_SINGLE_RECORD_METHOD_NAMES.has(callDetails.methodName)) {
    return null
  }

  const collectionName = readCollectionNameExpression(callDetails.callExpression.arguments[0], state)
  if (!collectionName) {
    return null
  }

  return {
    collectionName,
    confidence: 'high',
    strategy: `explicit-record-assignment:${callDetails.methodName}`,
  }
}

function readNewRecordReference(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target || !ts.isNewExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== 'Record') {
    return null
  }

  const collectionReference = readCollectionModelReference(target.arguments && target.arguments[0], state)
  if (!collectionReference) {
    return null
  }

  return {
    collectionName: collectionReference.collectionName,
    confidence: 'high',
    strategy: `explicit-record-constructor:${collectionReference.strategy}`,
  }
}

function isSupportedArrayIndexExpression(node) {
  const target = skipExpressionWrappers(node)
  if (!target) {
    return false
  }

  if (ts.isIdentifier(target) || ts.isNumericLiteral(target)) {
    return true
  }

  return (
    ts.isPrefixUnaryExpression(target) &&
    target.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(target.operand)
  )
}

function readIndexedArrayRecordReference(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target || !ts.isElementAccessExpression(target) || !isSupportedArrayIndexExpression(target.argumentExpression)) {
    return null
  }

  const arrayReference = readArrayCollectionReference(target.expression, state)
  if (!arrayReference) {
    return null
  }

  return {
    collectionName: arrayReference.collectionName,
    confidence: 'high',
    strategy: `explicit-array-index:${arrayReference.strategy}`,
  }
}

function readRecordReference(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return readExplicitInferenceValue(state, 'recordVariables', target.text)
  }

  const indexedArrayReference = readIndexedArrayRecordReference(target, state)
  if (indexedArrayReference) {
    return indexedArrayReference
  }

  const directReference = readDirectHighConfidenceRecordReference(target, state)
  if (directReference) {
    return directReference
  }

  const constructedReference = readNewRecordReference(target, state)
  if (constructedReference) {
    return constructedReference
  }

  if (
    ts.isBinaryExpression(target) &&
    (target.operatorToken.kind === ts.SyntaxKind.BarBarToken || target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const rightReference = readRecordReference(target.right, state)
    if (!rightReference) {
      return null
    }

    const left = skipExpressionWrappers(target.left)
    if (isNullishAssignmentValue(left)) {
      return {
        ...rightReference,
        strategy: `explicit-record-fallback:${rightReference.strategy}`,
      }
    }

    if (left && ts.isIdentifier(left)) {
      const leftReference = readExplicitInferenceValue(state, 'recordVariables', left.text)
      if (leftReference && leftReference.collectionName === rightReference.collectionName) {
        return {
          ...rightReference,
          strategy: `explicit-record-fallback:${rightReference.strategy}`,
        }
      }
    }
  }

  return null
}

function readDirectRecordArrayReference(node, state) {
  const callDetails = getAppPropertyCallDetails(node, state)
  if (!callDetails || !HIGH_CONFIDENCE_RECORD_ARRAY_METHOD_NAMES.has(callDetails.methodName)) {
    return null
  }

  const collectionName = readCollectionNameExpression(callDetails.callExpression.arguments[0], state)
  if (!collectionName) {
    return null
  }

  return {
    collectionName,
    confidence: 'high',
    strategy: `explicit-record-array:${callDetails.methodName}`,
  }
}

function readArrayCollectionReference(node, state) {
  const target = skipExpressionWrappers(node)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return readExplicitInferenceValue(state, 'arrayVariables', target.text)
  }

  const directReference = readDirectRecordArrayReference(target, state)
  if (directReference) {
    return directReference
  }

  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    const methodName = target.expression.name.text
    if (ARRAY_COLLECTION_PASSTHROUGH_METHOD_NAMES.has(methodName)) {
      const baseReference = readArrayCollectionReference(target.expression.expression, state)
      if (baseReference) {
        return {
          ...baseReference,
          strategy: `explicit-array-passthrough:${methodName}`,
        }
      }
    }
  }

  return null
}

function applyExplicitInferenceRequireStringBindings(state, bindingName, initializer) {
  if (!bindingName || !ts.isObjectBindingPattern(bindingName)) {
    return false
  }

  const requestPath = readRequireRequestPath(initializer)
  if (!requestPath || !state.filePath || !state.resolveRequireTarget || !state.getModuleExportedStringConstants) {
    return false
  }

  const moduleFilePath = state.resolveRequireTarget(state.filePath, requestPath)
  if (!moduleFilePath) {
    return false
  }

  const exportedStringConstants = state.getModuleExportedStringConstants(moduleFilePath)
  if (!(exportedStringConstants instanceof Map) || exportedStringConstants.size === 0) {
    return false
  }

  let applied = false
  for (const element of bindingName.elements) {
    if (!element || !ts.isBindingElement(element) || !ts.isIdentifier(element.name)) {
      continue
    }

    const exportName = element.propertyName
      ? getPropertyNameText(element.propertyName)
      : element.name.text
    const stringValue = exportName ? exportedStringConstants.get(exportName) : null
    if (typeof stringValue !== 'string') {
      continue
    }

    writeExplicitInferenceString(state, element.name.text, stringValue)
    applied = true
  }

  return applied
}

function applyExplicitInferenceAssignment(state, variableName, expression, options = {}) {
  if (!variableName) {
    return
  }

  const constStringValue = options.isConst ? readCollectionNameExpression(expression, state) : null
  if (constStringValue) {
    writeExplicitInferenceString(state, variableName, constStringValue)
    return
  }

  const collectionModelReference = readCollectionModelReference(expression, state)
  if (collectionModelReference) {
    writeExplicitInferenceReference(state, 'collectionModels', variableName, collectionModelReference)
    return
  }

  const recordReference = readRecordReference(expression, state)
  if (recordReference) {
    writeExplicitInferenceReference(state, 'recordVariables', variableName, recordReference)
    return
  }

  const arrayReference = readArrayCollectionReference(expression, state)
  if (arrayReference) {
    writeExplicitInferenceReference(state, 'arrayVariables', variableName, arrayReference)
    return
  }

  if (isNullishAssignmentValue(expression)) {
    return
  }

  clearExplicitInferenceReference(state, variableName)
}

function nodeContainsOffset(sourceFile, node, offset) {
  if (!node) {
    return false
  }

  const start = node.getStart(sourceFile)
  return start <= offset && offset < node.getEnd()
}

function isFunctionLikeWithBody(node) {
  return (
    !!node &&
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    !!node.body
  )
}

function getRunInTransactionCallbackAppReceiverName(node, state) {
  if (!isFunctionLikeWithBody(node) || !node.parent || !ts.isCallExpression(node.parent) || node.parent.arguments[0] !== node) {
    return null
  }

  const callTarget = skipExpressionWrappers(node.parent.expression)
  if (
    !callTarget ||
    !ts.isPropertyAccessExpression(callTarget) ||
    callTarget.name.text !== 'runInTransaction' ||
    !isExplicitInferenceAppReceiverExpression(callTarget.expression, state)
  ) {
    return null
  }

  const firstParameter = node.parameters && node.parameters[0]
  return firstParameter && ts.isIdentifier(firstParameter.name) ? firstParameter.name.text : null
}

function processExplicitInferenceRunInTransactionCall(expression, sourceFile, beforeOffset, state) {
  const target = skipExpressionWrappers(expression)
  if (!target || !ts.isCallExpression(target)) {
    return false
  }

  const callback = target.arguments && target.arguments[0]
  if (!isFunctionLikeWithBody(callback) || !nodeContainsOffset(sourceFile, callback.body, beforeOffset)) {
    return false
  }

  if (!getRunInTransactionCallbackAppReceiverName(callback, state)) {
    return false
  }

  processExplicitInferenceFunctionLike(callback, sourceFile, beforeOffset, state)
  return true
}

function walkExplicitInferenceStatements(statements, sourceFile, beforeOffset, state) {
  for (const statement of statements || []) {
    if (!statement) {
      continue
    }

    const statementStart = statement.getStart(sourceFile)
    if (statementStart >= beforeOffset) {
      break
    }

    const nextOffset = statement.getEnd() <= beforeOffset ? Number.POSITIVE_INFINITY : beforeOffset
    processExplicitInferenceStatement(statement, sourceFile, nextOffset, state)

    if (nextOffset !== Number.POSITIVE_INFINITY) {
      break
    }
  }
}

function processExplicitInferenceScopedBlock(block, sourceFile, beforeOffset, state, initialDeclaredNames = [], setupCallback = null) {
  if (!block || block.getStart(sourceFile) >= beforeOffset) {
    return
  }

  const shouldKeepFrame =
    beforeOffset !== Number.POSITIVE_INFINITY && nodeContainsOffset(sourceFile, block, beforeOffset)

  if (shouldKeepFrame) {
    state.frames.push(createExplicitInferenceFrame(initialDeclaredNames))
    if (typeof setupCallback === 'function') {
      setupCallback()
    }
    walkExplicitInferenceStatements(block.statements, sourceFile, beforeOffset, state)
    return
  }

  withExplicitInferenceFrame(state, initialDeclaredNames, () => {
    if (typeof setupCallback === 'function') {
      setupCallback()
    }
    walkExplicitInferenceStatements(block.statements, sourceFile, beforeOffset, state)
  })
}

function processExplicitInferenceFunctionLike(node, sourceFile, beforeOffset, state) {
  if (!isFunctionLikeWithBody(node) || !nodeContainsOffset(sourceFile, node.body, beforeOffset)) {
    return
  }

  const parameterNames = []
  for (const parameter of node.parameters || []) {
    collectBindingIdentifierNames(parameter.name, parameterNames)
  }

  const appReceiverName = getRunInTransactionCallbackAppReceiverName(node, state)
  const setupCallback = () => {
    if (appReceiverName) {
      addExplicitInferenceAppReceiverName(state, appReceiverName)
    }
  }

  if (ts.isBlock(node.body)) {
    processExplicitInferenceScopedBlock(node.body, sourceFile, beforeOffset, state, parameterNames, setupCallback)
  } else {
    state.frames.push(createExplicitInferenceFrame(parameterNames))
    setupCallback()
  }
}

function processExplicitInferenceVariableStatement(statement, sourceFile, beforeOffset, state) {
  const isConst = !!(statement.declarationList.flags & ts.NodeFlags.Const)

  for (const declaration of statement.declarationList.declarations) {
    if (!declaration || declaration.getStart(sourceFile) >= beforeOffset) {
      continue
    }

    const bindingNames = collectBindingIdentifierNames(declaration.name)
    for (const bindingName of bindingNames) {
      declareExplicitInferenceName(state, bindingName)
    }

    if (!ts.isIdentifier(declaration.name)) {
      if (declaration.initializer && declaration.initializer.getStart(sourceFile) < beforeOffset) {
        applyExplicitInferenceRequireStringBindings(state, declaration.name, declaration.initializer)
      }
      continue
    }

    const variableName = declaration.name.text
    const initializer = declaration.initializer
    if (!initializer) {
      clearExplicitInferenceReference(state, variableName)
      continue
    }

    if (nodeContainsOffset(sourceFile, initializer, beforeOffset) && isFunctionLikeWithBody(initializer)) {
      processExplicitInferenceFunctionLike(initializer, sourceFile, beforeOffset, state)
      continue
    }

    if (initializer.getStart(sourceFile) >= beforeOffset) {
      continue
    }

    applyExplicitInferenceAssignment(state, variableName, initializer, { isConst })
  }
}

function processExplicitInferenceExpressionStatement(statement, sourceFile, beforeOffset, state) {
  const expression = skipExpressionWrappers(statement.expression)
  if (processExplicitInferenceRunInTransactionCall(expression, sourceFile, beforeOffset, state)) {
    return
  }

  if (
    !expression ||
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return
  }

  const left = skipParenthesizedExpression(expression.left)
  if (!left || !ts.isIdentifier(left) || expression.right.getStart(sourceFile) >= beforeOffset) {
    return
  }

  applyExplicitInferenceAssignment(state, left.text, expression.right)
}

function processExplicitInferenceIfStatement(statement, sourceFile, beforeOffset, state) {
  if (statement.thenStatement && statement.thenStatement.getStart(sourceFile) < beforeOffset) {
    processExplicitInferenceStatement(statement.thenStatement, sourceFile, beforeOffset, state)
  }

  if (statement.elseStatement && statement.elseStatement.getStart(sourceFile) < beforeOffset) {
    processExplicitInferenceStatement(statement.elseStatement, sourceFile, beforeOffset, state)
  }
}

function processExplicitInferenceTryStatement(statement, sourceFile, beforeOffset, state) {
  if (statement.tryBlock && statement.tryBlock.getStart(sourceFile) < beforeOffset) {
    processExplicitInferenceScopedBlock(statement.tryBlock, sourceFile, beforeOffset, state)
  }

  if (statement.catchClause && statement.catchClause.getStart(sourceFile) < beforeOffset) {
    const catchNames = statement.catchClause.variableDeclaration
      ? collectBindingIdentifierNames(statement.catchClause.variableDeclaration.name)
      : []
    processExplicitInferenceScopedBlock(statement.catchClause.block, sourceFile, beforeOffset, state, catchNames)
  }

  if (statement.finallyBlock && statement.finallyBlock.getStart(sourceFile) < beforeOffset) {
    processExplicitInferenceScopedBlock(statement.finallyBlock, sourceFile, beforeOffset, state)
  }
}

function getForOfLoopBindingName(initializer) {
  const target = skipExpressionWrappers(initializer)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return target.text
  }

  if (!ts.isVariableDeclarationList(target) || target.declarations.length !== 1) {
    return null
  }

  const declaration = target.declarations[0]
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return null
  }

  return declaration.name.text
}

function getForOfLoopDeclaredNames(initializer) {
  const target = skipExpressionWrappers(initializer)
  if (!target) {
    return []
  }

  if (ts.isIdentifier(target)) {
    return [target.text]
  }

  if (!ts.isVariableDeclarationList(target)) {
    return []
  }

  const declaredNames = []
  for (const declaration of target.declarations) {
    collectBindingIdentifierNames(declaration.name, declaredNames)
  }

  return declaredNames
}

function processExplicitInferenceForOfStatement(statement, sourceFile, beforeOffset, state) {
  if (
    !statement ||
    !statement.expression ||
    !statement.statement ||
    statement.expression.getStart(sourceFile) >= beforeOffset ||
    !nodeContainsOffset(sourceFile, statement.statement, beforeOffset)
  ) {
    return
  }

  const loopBindingName = getForOfLoopBindingName(statement.initializer)
  const loopDeclaredNames = getForOfLoopDeclaredNames(statement.initializer)
  const arrayReference = readArrayCollectionReference(statement.expression, state)
  const applyLoopBinding = () => {
    if (!loopBindingName || !arrayReference) {
      return
    }

    writeExplicitInferenceReference(state, 'recordVariables', loopBindingName, {
      collectionName: arrayReference.collectionName,
      confidence: 'high',
      strategy: 'explicit-array-iteration:for-of',
    })
  }

  if (ts.isBlock(statement.statement)) {
    processExplicitInferenceScopedBlock(
      statement.statement,
      sourceFile,
      beforeOffset,
      state,
      loopDeclaredNames,
      applyLoopBinding
    )
    return
  }

  withExplicitInferenceFrame(state, loopDeclaredNames, () => {
    applyLoopBinding()
    processExplicitInferenceStatement(statement.statement, sourceFile, beforeOffset, state)
  })
}

function processExplicitInferenceStatement(statement, sourceFile, beforeOffset, state) {
  if (!statement || statement.getStart(sourceFile) >= beforeOffset) {
    return
  }

  if (ts.isVariableStatement(statement)) {
    processExplicitInferenceVariableStatement(statement, sourceFile, beforeOffset, state)
    return
  }

  if (ts.isExpressionStatement(statement)) {
    processExplicitInferenceExpressionStatement(statement, sourceFile, beforeOffset, state)
    return
  }

  if (ts.isBlock(statement)) {
    processExplicitInferenceScopedBlock(statement, sourceFile, beforeOffset, state)
    return
  }

  if (ts.isIfStatement(statement)) {
    processExplicitInferenceIfStatement(statement, sourceFile, beforeOffset, state)
    return
  }

  if (ts.isTryStatement(statement)) {
    processExplicitInferenceTryStatement(statement, sourceFile, beforeOffset, state)
    return
  }

  if (ts.isForOfStatement(statement)) {
    processExplicitInferenceForOfStatement(statement, sourceFile, beforeOffset, state)
    return
  }

  if (isFunctionLikeWithBody(statement) && nodeContainsOffset(sourceFile, statement, beforeOffset)) {
    processExplicitInferenceFunctionLike(statement, sourceFile, beforeOffset, state)
  }
}

function buildExplicitInferenceState(sourceFile, beforeOffset, options = {}) {
  const state = createExplicitInferenceState(options)
  walkExplicitInferenceStatements(sourceFile.statements, sourceFile, beforeOffset, state)
  return state
}

function inferExplicitVariableCollectionReference(receiverExpression, sourceFile, beforeOffset, options = {}) {
  const receiverName = String(receiverExpression || '').trim()
  if (!receiverName || !isValidIdentifierName(receiverName)) {
    return null
  }

  return readExplicitInferenceValue(
    buildExplicitInferenceState(sourceFile, beforeOffset, options),
    'recordVariables',
    receiverName,
  )
}

function inferExplicitIndexedElementCollectionReference(receiverExpression, sourceFile, beforeOffset, options = {}) {
  const receiverText = String(receiverExpression || '').trim()
  const match = receiverText.match(ARRAY_ELEMENT_RECEIVER_RE)
  if (!match) {
    return null
  }

  const state = buildExplicitInferenceState(sourceFile, beforeOffset, options)
  const arrayReference = readExplicitInferenceValue(state, 'arrayVariables', match[1])
  if (!arrayReference) {
    return null
  }

  return {
    collectionName: arrayReference.collectionName,
    confidence: 'high',
    strategy: `explicit-array-index:${arrayReference.strategy}`,
  }
}

function findInnermostNodeAtOffset(sourceFile, offset) {
  let match = sourceFile

  const visit = (node) => {
    if (!nodeContainsOffset(sourceFile, node, offset)) {
      return
    }

    match = node
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return match
}

function inferDirectCallbackCollectionReference(receiverExpression, sourceFile, beforeOffset, options = {}) {
  const receiverName = String(receiverExpression || '').trim()
  if (!receiverName || !isValidIdentifierName(receiverName) || beforeOffset <= 0) {
    return null
  }

  let current = findInnermostNodeAtOffset(sourceFile, Math.max(0, beforeOffset - 1))
  while (current) {
    if (
      isFunctionLikeWithBody(current) &&
      current.parameters.length > 0 &&
      ts.isIdentifier(current.parameters[0].name) &&
      current.parameters[0].name.text === receiverName &&
      current.parent &&
      ts.isCallExpression(current.parent) &&
      current.parent.arguments[0] === current &&
      ts.isPropertyAccessExpression(current.parent.expression)
    ) {
      const callbackMethodName = current.parent.expression.name.text
      if (DIRECT_CALLBACK_COLLECTION_METHOD_NAMES.has(callbackMethodName)) {
        const callbackState = buildExplicitInferenceState(sourceFile, current.getStart(sourceFile), options)
        const arrayReference = readArrayCollectionReference(current.parent.expression.expression, callbackState)

        if (arrayReference) {
          return {
            collectionName: arrayReference.collectionName,
            confidence: 'high',
            strategy: `explicit-array-callback:${callbackMethodName}`,
          }
        }
      }
    }

    current = current.parent
  }

  return null
}

function getLastPathSegment(value) {
  return String(value || '')
    .split('.')
    .filter(Boolean)
    .pop() || ''
}

function hasPrivateRolesSegment(filePath) {
  const normalizedPath = normalizePath(filePath)
  const pagesMarker = '/pb_hooks/pages/'
  const markerIndex = normalizedPath.indexOf(pagesMarker)
  if (markerIndex === -1) {
    return false
  }

  const relativeSegments = normalizedPath
    .slice(markerIndex + pagesMarker.length)
    .split('/')
    .filter(Boolean)
  const privateIndex = relativeSegments.indexOf('_private')
  const rolesIndex = relativeSegments.indexOf('roles')

  return privateIndex !== -1 && rolesIndex > privateIndex
}

function isRouteGroupSegment(segment) {
  return /^\(.+\)$/.test(String(segment || ''))
}

function isDynamicRouteSegment(segment) {
  return /^\[(\.\.\.)?[^\]]+\]$/.test(String(segment || ''))
}

function isCatchAllDynamicRouteSegment(segment) {
  return /^\[\.\.\.[^\]]+\]$/.test(String(segment || ''))
}

function isAssetCandidateFile(pagesRoot, filePath) {
  const normalizedFilePath = normalizePath(filePath)
  const relativePath = toRelativePath(path.relative(pagesRoot, normalizedFilePath))
  const extension = path.extname(normalizedFilePath).toLowerCase()
  const relativeSegments = relativePath.split('/').filter(Boolean)
  const baseName = path.basename(normalizedFilePath)

  if (!relativePath || relativePath.startsWith('..') || relativeSegments.includes('_private')) {
    return false
  }

  if (extension === '.ejs') {
    return false
  }

  if (ASSET_SCRIPT_EXTENSIONS.includes(extension)) {
    return relativeSegments.includes('assets')
  }

  if (baseName.startsWith('+')) {
    return false
  }

  return true
}

function isExcludedRouteExposedPagesScript(relativeSegments, filePath) {
  const normalizedSegments = Array.isArray(relativeSegments) ? relativeSegments.filter(Boolean) : []
  if (normalizedSegments.includes('_private')) {
    return false
  }

  const normalizedFilePath = normalizePath(filePath)
  const lowerFilePath = normalizedFilePath.toLowerCase()
  return (
    normalizedSegments.includes('vendor') ||
    lowerFilePath.endsWith('.min.js') ||
    lowerFilePath.endsWith('.min.cjs') ||
    lowerFilePath.endsWith('.min.mjs')
  )
}

function isPagesCodeFile(pagesRoot, filePath) {
  const normalizedFilePath = normalizePath(filePath)
  const relativePath = toRelativePath(path.relative(pagesRoot, normalizedFilePath))
  const extension = path.extname(normalizedFilePath).toLowerCase()
  const relativeSegments = relativePath.split('/').filter(Boolean)

  if (!relativePath || relativePath.startsWith('..')) {
    return false
  }

  if (!PAGES_CODE_EXTENSIONS.includes(extension)) {
    return false
  }

  if (relativeSegments.includes('assets')) {
    return false
  }

  if (ASSET_SCRIPT_EXTENSIONS.includes(extension) && isExcludedRouteExposedPagesScript(relativeSegments, normalizedFilePath)) {
    return false
  }

  return true
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

function splitNormalizedRoutePath(routePath) {
  const normalizedRoutePath = normalizeRoutePath(routePath)
  if (!normalizedRoutePath || normalizedRoutePath === '/') {
    return []
  }

  return normalizedRoutePath.slice(1).split('/').filter(Boolean)
}

function stripPathSuffix(requestPath) {
  const value = String(requestPath || '')
  const markerIndex = value.search(/[?#]/)
  return markerIndex === -1 ? value : value.slice(0, markerIndex)
}

function getRoutePathMatchDetails(routeSegments, requestSegments) {
  const normalizedRouteSegments = Array.isArray(routeSegments) ? routeSegments.filter(Boolean) : []
  const normalizedRequestSegments = Array.isArray(requestSegments) ? requestSegments.filter(Boolean) : []
  let requestIndex = 0
  let dynamicSegmentCount = 0

  for (let routeIndex = 0; routeIndex < normalizedRouteSegments.length; routeIndex += 1) {
    const routeSegment = normalizedRouteSegments[routeIndex]

    if (isCatchAllDynamicRouteSegment(routeSegment)) {
      if (routeIndex !== normalizedRouteSegments.length - 1) {
        return null
      }

      dynamicSegmentCount += 1
      requestIndex = normalizedRequestSegments.length
      return {
        dynamicSegmentCount,
        segmentCount: normalizedRouteSegments.length,
      }
    }

    if (requestIndex >= normalizedRequestSegments.length) {
      return null
    }

    const requestSegment = normalizedRequestSegments[requestIndex]
    if (isDynamicRouteSegment(routeSegment)) {
      dynamicSegmentCount += 1
    } else if (routeSegment !== requestSegment) {
      return null
    }

    requestIndex += 1
  }

  if (requestIndex !== normalizedRequestSegments.length) {
    return null
  }

  return {
    dynamicSegmentCount,
    segmentCount: normalizedRouteSegments.length,
  }
}

function createRouteDescriptor(pagesRoot, filePath, routeExtensions = ROUTE_EXTENSIONS) {
  const normalizedFilePath = normalizePath(filePath)
  const relativePath = toRelativePath(path.relative(pagesRoot, normalizedFilePath))
  if (!relativePath || relativePath.startsWith('..') || relativePath.split('/').includes('_private')) {
    return null
  }

  const relativeSegments = relativePath.split('/').filter(Boolean)
  if (!relativeSegments.length) {
    return null
  }

  if (relativeSegments.includes('assets')) {
    return null
  }

  const fileName = relativeSegments[relativeSegments.length - 1]
  const extension = path.extname(fileName).toLowerCase()
  if (!routeExtensions.includes(extension)) {
    return null
  }

  if (ASSET_SCRIPT_EXTENSIONS.includes(extension) && isExcludedRouteExposedPagesScript(relativeSegments, normalizedFilePath)) {
    return null
  }

  const fileBasename = stripKnownExtension(fileName, routeExtensions)
  const directorySegments = relativeSegments.slice(0, -1)
  const routeSegments = []

  for (const segment of directorySegments) {
    if (!segment || isRouteGroupSegment(segment)) {
      continue
    }

    if (segment.startsWith('+')) {
      return null
    }

    routeSegments.push(segment)
  }

  let method = 'PAGE'
  if (fileBasename === 'index') {
    method = 'PAGE'
  } else if (ROUTE_METHOD_BY_FILE_BASENAME[fileBasename]) {
    if (!ASSET_SCRIPT_EXTENSIONS.includes(extension)) {
      return null
    }
    method = ROUTE_METHOD_BY_FILE_BASENAME[fileBasename]
  } else if (NON_ROUTE_SPECIAL_FILE_BASENAMES.has(fileBasename) || fileBasename.startsWith('+')) {
    return null
  } else {
    routeSegments.push(fileBasename)
  }

  return {
    filePath: normalizedFilePath,
    method,
    routePath: routeSegments.length ? `/${routeSegments.join('/')}` : '/',
    routeSegments: [...routeSegments],
    isStaticRoute: !routeSegments.some((segment) => isDynamicRouteSegment(segment)),
  }
}

function toStaticRouteEntry(descriptor) {
  return {
    filePath: descriptor.filePath,
    method: descriptor.method === 'PAGE' ? null : descriptor.method,
    routePath: descriptor.routePath,
  }
}

function getPreferredRouteMethods(routeSource) {
  switch (String(routeSource || '').toLowerCase()) {
    case 'action-post':
    case 'hx-post':
    case '@post':
      return ['POST', 'GET']
    case 'action-get':
      return ['PAGE']
    case 'action':
      return ['POST', 'GET']
    case 'hx-put':
    case '@put':
      return ['PUT', 'GET']
    case 'hx-delete':
    case '@delete':
      return ['DELETE', 'GET']
    case 'hx-patch':
    case '@patch':
      return ['PATCH', 'GET']
    case 'href':
    case 'redirect':
    case 'hx-get':
    case '@get':
    default:
      return ['PAGE']
  }
}

function isRouteEntryCompatible(entry, preferredMethods) {
  if (!entry || !entry.method || entry.method === 'PAGE') {
    return true
  }

  return ensureArray(preferredMethods).includes(entry.method)
}

function skipParenthesizedExpression(node) {
  let current = node
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

function readRequireRequestPath(node) {
  const target = skipParenthesizedExpression(node)
  if (!target || !ts.isCallExpression(target)) {
    return null
  }

  if (!ts.isIdentifier(target.expression) || target.expression.text !== 'require') {
    return null
  }

  if (!target.arguments.length) {
    return null
  }

  const firstArgument = target.arguments[0]
  if (!ts.isStringLiteralLike(firstArgument)) {
    return null
  }

  return firstArgument.text
}

function skipExpressionWrappers(node) {
  let current = node
  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression
      continue
    }

    if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current)) {
      current = current.expression
      continue
    }

    break
  }

  return current
}

function readStringLiteralText(node) {
  const target = skipExpressionWrappers(node)
  return target && ts.isStringLiteralLike(target) ? target.text : null
}

function mergeTypeTexts(typeTexts) {
  const uniqueTypes = [...new Set((Array.isArray(typeTexts) ? typeTexts : []).filter(Boolean))]
  if (!uniqueTypes.length) {
    return 'any'
  }

  if (uniqueTypes.includes('any')) {
    return 'any'
  }

  return uniqueTypes.sort().join(' | ')
}

const SYSTEM_RECORD_FIELDS = Object.freeze([
  { name: 'id', type: 'text', isSystem: true, required: true },
  { name: 'created', type: 'date', isSystem: true, required: true },
  { name: 'updated', type: 'date', isSystem: true, required: true },
])

function mergeRecordFieldEntries(fieldEntries = []) {
  const merged = []
  const seen = new Set()

  for (const fieldEntry of [...SYSTEM_RECORD_FIELDS, ...ensureArray(fieldEntries)]) {
    if (!fieldEntry || typeof fieldEntry.name !== 'string' || seen.has(fieldEntry.name)) {
      continue
    }

    seen.add(fieldEntry.name)
    const entry = {
      name: fieldEntry.name,
      type: fieldEntry.type || '',
      isSystem: !!fieldEntry.isSystem,
    }
    if (typeof fieldEntry.required === 'boolean') {
      entry.required = fieldEntry.required
    }
    if (Array.isArray(fieldEntry.values)) {
      entry.values = fieldEntry.values.filter((value) => typeof value === 'string')
    }
    if (typeof fieldEntry.maxSelect === 'number') {
      entry.maxSelect = fieldEntry.maxSelect
    }
    if (typeof fieldEntry.collectionId === 'string') {
      entry.collectionId = fieldEntry.collectionId
    }
    if (typeof fieldEntry.relationCollectionName === 'string') {
      entry.relationCollectionName = fieldEntry.relationCollectionName
    }
    merged.push(entry)
  }

  return merged
}

function mapSchemaFieldTypeToTypeText(fieldType) {
  switch (String(fieldType || '').toLowerCase()) {
    case 'text':
    case 'email':
    case 'url':
    case 'editor':
      return 'string'
    case 'bool':
      return 'boolean'
    case 'number':
      return 'number'
    case 'date':
    case 'autodate':
      return 'string'
    case 'json':
      return 'any'
    default:
      return null
  }
}

function applyMaxSelectArity(field, baseTypeText) {
  const isMulti = typeof field.maxSelect === 'number' && field.maxSelect > 1
  return isMulti ? `Array<${baseTypeText}>` : baseTypeText
}

// Field types whose TS type depends on the field object (values/maxSelect),
// not just the type string. Returns null when the metadata is insufficient so
// the caller can fall back to mapSchemaFieldTypeToTypeText.
function mapFieldObjectToTypeText(field) {
  if (!field) {
    return null
  }

  switch (String(field.type || '').toLowerCase()) {
    case 'select': {
      const values = Array.isArray(field.values)
        ? field.values.filter((value) => typeof value === 'string')
        : []
      if (!values.length) {
        return null
      }
      const union = [...new Set(values)].map((value) => JSON.stringify(value)).join(' | ')
      return applyMaxSelectArity(field, union)
    }
    // file resolves to stored file name(s); relation resolves to record id(s).
    // Both are strings at the record level (relation is NOT expanded here).
    case 'file':
    case 'relation':
      return applyMaxSelectArity(field, 'string')
    default:
      return null
  }
}

function inferIncludeLocalTypeText(node, depth = 0) {
  const target = skipExpressionWrappers(node)
  if (!target || depth > 4) {
    return 'any'
  }

  if (ts.isStringLiteralLike(target) || ts.isNoSubstitutionTemplateLiteral(target) || ts.isTemplateExpression(target)) {
    return 'string'
  }

  if (ts.isNumericLiteral(target)) {
    return 'number'
  }

  if (target.kind === ts.SyntaxKind.TrueKeyword || target.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean'
  }

  if (target.kind === ts.SyntaxKind.NullKeyword) {
    return 'null'
  }

  if (ts.isArrayLiteralExpression(target)) {
    const elementTypes = target.elements.map((element) => inferIncludeLocalTypeText(element, depth + 1))
    const mergedElementType = mergeTypeTexts(elementTypes)
    return mergedElementType === 'any' ? 'any[]' : `Array<${mergedElementType}>`
  }

  if (ts.isObjectLiteralExpression(target)) {
    const propertyLines = []

    for (const property of target.properties) {
      if (ts.isSpreadAssignment(property)) {
        continue
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        propertyLines.push(`${property.name.text}: any;`)
        continue
      }

      if (ts.isMethodDeclaration(property)) {
        const propertyName = getPropertyNameText(property.name)
        if (!propertyName) {
          continue
        }

        const label = isValidIdentifierName(propertyName) ? propertyName : JSON.stringify(propertyName)
        propertyLines.push(`${label}: (...args: any[]) => any;`)
        continue
      }

      if (!ts.isPropertyAssignment(property)) {
        continue
      }

      const propertyName = getPropertyNameText(property.name)
      if (!propertyName) {
        continue
      }

      const label = isValidIdentifierName(propertyName) ? propertyName : JSON.stringify(propertyName)
      propertyLines.push(`${label}: ${inferIncludeLocalTypeText(property.initializer, depth + 1)};`)
    }

    if (!propertyLines.length) {
      return 'Record<string, any>'
    }

    return `{ ${propertyLines.join(' ')} }`
  }

  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return '(...args: any[]) => any'
  }

  if (ts.isConditionalExpression(target)) {
    return mergeTypeTexts([
      inferIncludeLocalTypeText(target.whenTrue, depth + 1),
      inferIncludeLocalTypeText(target.whenFalse, depth + 1),
    ])
  }

  return 'any'
}

function isPocketPagesCalleeNamed(expression, name) {
  const target = skipExpressionWrappers(expression)
  if (target && ts.isIdentifier(target) && target.text === name) {
    return true
  }

  return !!(
    target &&
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'api' &&
    target.name.text === name
  )
}

function collectIncludeCallEntries(filePath, scriptText) {
  const sourceFile = ts.createSourceFile(filePath, scriptText, ts.ScriptTarget.Latest, true)
  const entries = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      isPocketPagesCalleeNamed(node.expression, 'include') &&
      node.arguments.length
    ) {
      const requestPath = readStringLiteralText(node.arguments[0])
      if (requestPath) {
        const locals = []
        const localsArgument = skipExpressionWrappers(node.arguments[1])
        let localsMode = 'none'
        let hasDynamicLocals = false

        if (localsArgument && ts.isObjectLiteralExpression(localsArgument)) {
          localsMode = 'object'

          for (const property of localsArgument.properties) {
            if (ts.isSpreadAssignment(property)) {
              hasDynamicLocals = true
              continue
            }

            if (ts.isShorthandPropertyAssignment(property)) {
              locals.push({
                name: property.name.text,
                typeStrategy: 'ts-expression',
                typeText: 'any',
                propertyStart: property.getStart(sourceFile),
                propertyEnd: property.getEnd(),
                nameStart: property.name.getStart(sourceFile),
                nameEnd: property.name.getEnd(),
                initializerStart: property.name.getStart(sourceFile),
                initializerEnd: property.name.getEnd(),
                expressionStart: property.name.getStart(sourceFile),
                expressionEnd: property.name.getEnd(),
              })
              continue
            }

            if (!ts.isPropertyAssignment(property)) {
              continue
            }

            const propertyName = getPropertyNameText(property.name)
            if (!propertyName) {
              hasDynamicLocals = true
              continue
            }

            const initializer = skipExpressionWrappers(property.initializer)
            const useTypeScriptInference =
              !!initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer))

            locals.push({
              name: propertyName,
              typeStrategy: useTypeScriptInference ? 'ts-expression' : 'static',
              typeText: useTypeScriptInference ? 'any' : inferIncludeLocalTypeText(property.initializer),
              propertyStart: property.getStart(sourceFile),
              propertyEnd: property.getEnd(),
              nameStart: property.name.getStart(sourceFile),
              nameEnd: property.name.getEnd(),
              initializerStart: property.initializer.getStart(sourceFile),
              initializerEnd: property.initializer.getEnd(),
              expressionStart: useTypeScriptInference ? initializer.getStart(sourceFile) : null,
              expressionEnd: useTypeScriptInference ? initializer.getEnd() : null,
            })
          }
        } else if (localsArgument) {
          localsMode = 'dynamic'
        }

        entries.push({
          requestPath,
          callStart: node.getStart(sourceFile),
          callEnd: node.getEnd(),
          requestStart: node.arguments[0].getStart(sourceFile) + 1,
          requestEnd: node.arguments[0].getEnd() - 1,
          localsStart: localsArgument ? localsArgument.getStart(sourceFile) : null,
          localsEnd: localsArgument ? localsArgument.getEnd() : null,
          localsObjectStart:
            localsArgument && ts.isObjectLiteralExpression(localsArgument)
              ? localsArgument.getStart(sourceFile) + 1
              : null,
          localsObjectEnd:
            localsArgument && ts.isObjectLiteralExpression(localsArgument)
              ? localsArgument.getEnd() - 1
              : null,
          localsMode,
          hasDynamicLocals,
          locals,
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return entries
}

function getPropertyNameText(node) {
  if (!node) {
    return null
  }

  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return String(node.text)
  }

  return null
}

function isModuleExportsExpression(node) {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  )
}

function getCommonJsExportName(node) {
  if (!node || !ts.isPropertyAccessExpression(node)) {
    return null
  }

  if (ts.isIdentifier(node.expression) && node.expression.text === 'exports') {
    return node.name.text
  }

  if (isModuleExportsExpression(node.expression)) {
    return node.name.text
  }

  return null
}

function _toDefinitionTarget(filePath, sourceFile, node) {
  const targetNode = node && typeof node.getStart === 'function' ? node : sourceFile
  const position = sourceFile.getLineAndCharacterOfPosition(targetNode.getStart(sourceFile))

  return {
    filePath,
    line: position.line,
    character: position.character,
  }
}

function getRenamableDefinitionNode(node) {
  if (!node) {
    return null
  }

  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    return node.name
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isPropertyAccessExpression(node)
  ) {
    return node.name
  }

  return node
}

function collectExportedMemberDefinitionInfos(sourceFile) {
  const declarations = collectNamedDeclarations(sourceFile)
  const definitions = new Map()

  const remember = (exportName, node) => {
    if (!exportName || definitions.has(exportName)) {
      return
    }

    const targetNode = getRenamableDefinitionNode(node) || node
    if (!targetNode || typeof targetNode.getStart !== 'function') {
      return
    }

    const position = sourceFile.getLineAndCharacterOfPosition(targetNode.getStart(sourceFile))
    definitions.set(exportName, {
      filePath: sourceFile.fileName,
      memberName: String(exportName),
      start: targetNode.getStart(sourceFile),
      end: targetNode.getEnd(),
      line: position.line,
      character: position.character,
    })
  }

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = skipParenthesizedExpression(node.left)
      const right = skipParenthesizedExpression(node.right)

      if (isModuleExportsExpression(left) && right && ts.isObjectLiteralExpression(right)) {
        for (const property of right.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            remember(property.name.text, declarations.get(property.name.text) || property.name)
            continue
          }

          if (ts.isPropertyAssignment(property)) {
            const exportName = getPropertyNameText(property.name)
            remember(exportName, resolveInitializerDefinitionNode(property.initializer, declarations) || property.name)
            continue
          }

          if (ts.isMethodDeclaration(property)) {
            remember(getPropertyNameText(property.name), property)
          }
        }
      }

      const assignedExportName = getCommonJsExportName(left)
      if (assignedExportName) {
        remember(assignedExportName, resolveInitializerDefinitionNode(right, declarations) || left)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return [...definitions.values()]
}

function collectNamedDeclarations(sourceFile) {
  const declarations = new Map()

  const remember = (name, node) => {
    if (!name || declarations.has(name)) {
      return
    }

    declarations.set(name, node)
  }

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      remember(node.name.text, node)
    } else if (ts.isClassDeclaration(node) && node.name) {
      remember(node.name.text, node)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      remember(node.name.text, node)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return declarations
}

function resolveInitializerDefinitionNode(initializer, declarations) {
  const target = skipParenthesizedExpression(initializer)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return declarations.get(target.text) || null
  }

  if (
    ts.isFunctionExpression(target) ||
    ts.isArrowFunction(target) ||
    ts.isClassExpression(target) ||
    ts.isObjectLiteralExpression(target)
  ) {
    return target
  }

  return null
}

function readStaticStringExpressionValue(node, declarations, visitedNames = new Set()) {
  const target = skipParenthesizedExpression(node)
  if (!target) {
    return null
  }

  if (ts.isVariableDeclaration(target)) {
    return target.initializer
      ? readStaticStringExpressionValue(target.initializer, declarations, visitedNames)
      : null
  }

  if (ts.isStringLiteralLike(target)) {
    return target.text
  }

  if (!ts.isIdentifier(target)) {
    return null
  }

  if (visitedNames.has(target.text)) {
    return null
  }

  visitedNames.add(target.text)
  const declaration = declarations.get(target.text)
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return null
  }

  return readStaticStringExpressionValue(declaration.initializer, declarations, visitedNames)
}

function collectExportedStringConstantValues(sourceFile) {
  const declarations = collectNamedDeclarations(sourceFile)
  const definitions = new Map()

  const remember = (exportName, value) => {
    if (!exportName || typeof value !== 'string' || definitions.has(exportName)) {
      return
    }

    definitions.set(exportName, value)
  }

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = skipParenthesizedExpression(node.left)
      const right = skipParenthesizedExpression(node.right)

      if (isModuleExportsExpression(left) && right && ts.isObjectLiteralExpression(right)) {
        for (const property of right.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            remember(
              property.name.text,
              readStaticStringExpressionValue(declarations.get(property.name.text), declarations)
            )
            continue
          }

          if (ts.isPropertyAssignment(property)) {
            remember(
              getPropertyNameText(property.name),
              readStaticStringExpressionValue(property.initializer, declarations)
            )
          }
        }
      }

      const assignedExportName = getCommonJsExportName(left)
      if (assignedExportName) {
        remember(assignedExportName, readStaticStringExpressionValue(right, declarations))
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return definitions
}

function _findExportedMemberDefinitionNode(sourceFile, exportName) {
  const declarations = collectNamedDeclarations(sourceFile)
  let definitionNode = null

  const visit = (node) => {
    if (definitionNode) {
      return
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = skipParenthesizedExpression(node.left)
      const right = skipParenthesizedExpression(node.right)

      if (isModuleExportsExpression(left) && right && ts.isObjectLiteralExpression(right)) {
        for (const property of right.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            if (property.name.text !== exportName) {
              continue
            }

            definitionNode = declarations.get(property.name.text) || property.name
            return
          }

          if (ts.isPropertyAssignment(property)) {
            if (getPropertyNameText(property.name) !== exportName) {
              continue
            }

            definitionNode = resolveInitializerDefinitionNode(property.initializer, declarations) || property.name
            return
          }

          if (ts.isMethodDeclaration(property)) {
            if (getPropertyNameText(property.name) !== exportName) {
              continue
            }

            definitionNode = property
            return
          }
        }
      }

      const assignedExportName = getCommonJsExportName(left)
      if (assignedExportName === exportName) {
        definitionNode = resolveInitializerDefinitionNode(right, declarations) || left
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return definitionNode
}

class PocketPagesProjectIndex {
  constructor(appRoot) {
    this.appRoot = normalizePath(appRoot)
    this.pagesRoot = normalizePath(path.join(this.appRoot, 'pb_hooks', 'pages'))
    this.schemaCache = null
    this.collectionMethodCache = null
    this.moduleExportedStringConstantsCache = new Map()
    this.includeLocalsCache = null
    this.includeLocalCallSitesByFileCache = new Map()
    this.pagesGraphCache = null
    this.searchRootFileCache = new Map()
    this.routeStateCache = null
    this.pagesStructureVersion = 0
    this.pagesContentVersion = 0
    this.pagesAssetVersion = 0
  }

  resetCaches() {
    this.schemaCache = null
    this.collectionMethodCache = null
    this.moduleExportedStringConstantsCache.clear()
    this.includeLocalsCache = null
    this.includeLocalCallSitesByFileCache.clear()
    this.pagesGraphCache = null
    this.searchRootFileCache.clear()
    this.routeStateCache = null
    this.pagesStructureVersion += 1
    this.pagesContentVersion += 1
    this.pagesAssetVersion += 1
  }

  invalidateStructureCaches() {
    this.moduleExportedStringConstantsCache.clear()
    this.pagesGraphCache = null
    this.searchRootFileCache.clear()
    this.routeStateCache = null
    this.includeLocalsCache = null
    this.includeLocalCallSitesByFileCache.clear()
    this.pagesStructureVersion += 1
    this.pagesContentVersion += 1
    this.pagesAssetVersion += 1
  }

  invalidateContentForFile(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    const schemaPath = normalizePath(path.join(this.appRoot, 'pb_schema.json'))
    const typesPath = normalizePath(path.join(this.appRoot, 'pb_data', 'types.d.ts'))

    if (normalizedFilePath === schemaPath) {
      this.schemaCache = null
      return
    }

    if (normalizedFilePath === typesPath) {
      this.collectionMethodCache = null
      return
    }

    if (isPagesCodeFile(this.pagesRoot, normalizedFilePath)) {
      if (isJavaScriptModuleFile(normalizedFilePath)) {
        this.moduleExportedStringConstantsCache.delete(normalizedFilePath)
      }
      this.includeLocalsCache = null
      this.includeLocalCallSitesByFileCache.delete(normalizedFilePath)
      this.pagesContentVersion += 1
    }
  }

  invalidateAssetForFile(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    if (!isAssetCandidateFile(this.pagesRoot, normalizedFilePath)) {
      return false
    }

    this.pagesGraphCache = null
    this.searchRootFileCache.clear()
    this.pagesAssetVersion += 1
    return true
  }

  invalidateStructureForFile(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    const schemaPath = normalizePath(path.join(this.appRoot, 'pb_schema.json'))
    const typesPath = normalizePath(path.join(this.appRoot, 'pb_data', 'types.d.ts'))

    if (normalizedFilePath === schemaPath) {
      this.schemaCache = null
      return
    }

    if (normalizedFilePath === typesPath) {
      this.collectionMethodCache = null
      return
    }

    if (normalizedFilePath.startsWith(`${this.pagesRoot}/`) || normalizedFilePath === this.pagesRoot) {
      this.invalidateStructureCaches()
    }
  }

  isPagesCodeFile(filePath) {
    return isPagesCodeFile(this.pagesRoot, normalizePath(filePath))
  }

  isExcludedRouteExposedPagesScriptFile(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    const relativePath = toRelativePath(path.relative(this.pagesRoot, normalizedFilePath))
    if (!relativePath || relativePath.startsWith('..')) {
      return false
    }

    const relativeSegments = relativePath.split('/').filter(Boolean)
    const extension = path.extname(normalizedFilePath).toLowerCase()
    return ASSET_SCRIPT_EXTENSIONS.includes(extension) && isExcludedRouteExposedPagesScript(relativeSegments, normalizedFilePath)
  }

  isAssetCandidateFile(filePath) {
    return isAssetCandidateFile(this.pagesRoot, normalizePath(filePath))
  }

  getSchemaState() {
    const schemaPath = normalizePath(path.join(this.appRoot, 'pb_schema.json'))
    const identity = readSmallFileIdentity(schemaPath)
    if (!identity.exists) {
      this.schemaCache = {
        schemaPath,
        mtimeMs: 0,
        size: 0,
        hash: identity.hash,
        collections: [],
        collectionsByName: new Map(),
      }
      return this.schemaCache
    }

    if (
      this.schemaCache &&
      this.schemaCache.mtimeMs === identity.mtimeMs &&
      this.schemaCache.size === identity.size &&
      this.schemaCache.hash === identity.hash
    ) {
      return this.schemaCache
    }

    let collections = []
    try {
      const raw = JSON.parse(identity.text)
      collections = ensureArray(raw)
    } catch (_error) {
      collections = this.schemaCache && this.schemaCache.schemaPath === schemaPath ? ensureArray(this.schemaCache.collections) : []
    }

    const collectionNameById = new Map()

    for (const collection of collections) {
      if (!collection || typeof collection.name !== 'string') {
        continue
      }
      if (typeof collection.id === 'string' && collection.id) {
        collectionNameById.set(collection.id, collection.name)
      }
    }

    const collectionsByName = new Map()

    for (const collection of collections) {
      if (!collection || typeof collection.name !== 'string') {
        continue
      }

      const fields = ensureArray(collection.fields)
        .filter((field) => field && typeof field.name === 'string')
        .map((field) => {
          const entry = {
            name: field.name,
            type: field.type || '',
          }
          if (typeof field.required === 'boolean') {
            entry.required = field.required
          }
          if (Array.isArray(field.values)) {
            entry.values = field.values.filter((value) => typeof value === 'string')
          }
          if (typeof field.maxSelect === 'number') {
            entry.maxSelect = field.maxSelect
          }
          if (typeof field.collectionId === 'string' && field.collectionId) {
            entry.collectionId = field.collectionId
            entry.relationCollectionName = collectionNameById.get(field.collectionId) || field.collectionId
          }
          return entry
        })

      collectionsByName.set(collection.name, {
        name: collection.name,
        fields,
      })
    }

    this.schemaCache = {
      schemaPath,
      mtimeMs: identity.mtimeMs,
      size: identity.size,
      hash: identity.hash,
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

    return mergeRecordFieldEntries(collection.fields)
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

  getFieldTypeText(collectionName, fieldName) {
    const field = this.getFields(collectionName).find((entry) => entry.name === fieldName)
    if (!field) {
      return null
    }

    const fieldObjectType = mapFieldObjectToTypeText(field)
    if (fieldObjectType) {
      return fieldObjectType
    }

    return mapSchemaFieldTypeToTypeText(field.type)
  }

  getRecordFieldTypeText(fieldName) {
    const typeTexts = []

    for (const collectionName of this.getCollectionNames()) {
      const typeText = this.getFieldTypeText(collectionName, fieldName)
      if (typeText) {
        typeTexts.push(typeText)
      }
    }

    if (!typeTexts.length) {
      return null
    }

    return mergeTypeTexts(typeTexts)
  }

  getCollectionMethodState() {
    const typesPath = normalizePath(path.join(this.appRoot, 'pb_data', 'types.d.ts'))
    const identity = readSmallFileIdentity(typesPath)
    if (!identity.exists) {
      this.collectionMethodCache = {
        typesPath,
        mtimeMs: 0,
        size: 0,
        hash: identity.hash,
        methodNames: [...DEFAULT_COLLECTION_METHOD_NAMES],
      }
      return this.collectionMethodCache
    }

    if (
      this.collectionMethodCache &&
      this.collectionMethodCache.mtimeMs === identity.mtimeMs &&
      this.collectionMethodCache.size === identity.size &&
      this.collectionMethodCache.hash === identity.hash
    ) {
      return this.collectionMethodCache
    }

    let methodNames = []
    try {
      methodNames = extractCollectionMethodNamesFromAppType(typesPath)
    } catch (_error) {
      methodNames = []
    }

    if (!methodNames.length) {
      methodNames = [...DEFAULT_COLLECTION_METHOD_NAMES]
    }

    this.collectionMethodCache = {
      typesPath,
      mtimeMs: identity.mtimeMs,
      size: identity.size,
      hash: identity.hash,
      methodNames,
    }

    return this.collectionMethodCache
  }

  getCollectionMethodNames() {
    return [...this.getCollectionMethodState().methodNames]
  }

  getCollectionCallRegex() {
    const methodNames = this.getCollectionMethodNames()
    if (!methodNames.length) {
      return null
    }

    return new RegExp(`\\$app\\.(?:${methodNames.map((name) => quoteRegex(name)).join('|')})\\(\\s*['"]([^'"]+)['"]`, 'g')
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

  getPrivateSearchRootsForDir(startDir) {
    const roots = []
    let currentDir = normalizePath(startDir)
    const privateRoots = this.getPagesGraphState().privateRoots

    while (currentDir.startsWith(this.pagesRoot)) {
      const privateDir = normalizePath(path.join(currentDir, '_private'))
      if (privateRoots.has(privateDir)) {
        roots.push(privateDir)
      }

      if (currentDir === this.pagesRoot) {
        break
      }

      currentDir = normalizePath(path.dirname(currentDir))
    }

    return roots
  }

  getPrivateSearchRoots(filePath) {
    return this.getPrivateSearchRootsForDir(path.dirname(filePath))
  }

  getPagesGraphState() {
    if (this.pagesGraphCache) {
      return this.pagesGraphCache
    }

    const graphState = walkPagesGraph(this.pagesRoot)
    const pagesCodeFiles = []
    const assetFiles = []

    for (const entry of graphState.allFiles) {
      if (isPagesCodeFile(this.pagesRoot, entry.filePath)) {
        pagesCodeFiles.push(entry)
      }

      if (isAssetCandidateFile(this.pagesRoot, entry.filePath)) {
        assetFiles.push(entry)
      }
    }

    this.pagesGraphCache = {
      ...graphState,
      pagesCodeFiles,
      pagesCodeFilePathSet: new Set(pagesCodeFiles.map((entry) => entry.filePath)),
      assetFiles,
      assetFilePathSet: new Set(assetFiles.map((entry) => entry.filePath)),
    }

    return this.pagesGraphCache
  }

  getAssetEntries() {
    return this.getPagesGraphState().assetFiles
  }

  getAssetDescriptorByFilePath(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    const existingEntry = this.getPagesGraphState().assetFiles.find((entry) => entry.filePath === normalizedFilePath)
    if (existingEntry) {
      return {
        filePath: existingEntry.filePath,
        relativePath: existingEntry.relativePath,
      }
    }

    if (!isAssetCandidateFile(this.pagesRoot, normalizedFilePath)) {
      return null
    }

    return {
      filePath: normalizedFilePath,
      relativePath: toRelativePath(path.relative(this.pagesRoot, normalizedFilePath)),
    }
  }

  getSearchRootFileState(rootPath, extensions) {
    const normalizedRootPath = normalizePath(rootPath)
    const extensionKey = [...extensions].sort().join('|')
    const cacheKey = `${normalizedRootPath}::${extensionKey}`
    if (this.searchRootFileCache.has(cacheKey)) {
      return this.searchRootFileCache.get(cacheKey)
    }

    const rootPrefix = `${normalizedRootPath}/`
    const entries = this.getPagesGraphState().allFiles
      .filter((entry) =>
        entry.filePath.startsWith(rootPrefix) &&
        extensions.includes(path.extname(entry.filePath).toLowerCase())
      )
      .map((entry) => ({
        filePath: entry.filePath,
        relativePath: toRelativePath(path.relative(normalizedRootPath, entry.filePath)),
      }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath))

    const state = {
      entries,
      filePathSet: new Set(entries.map((entry) => entry.filePath)),
    }

    this.searchRootFileCache.set(cacheKey, state)
    return state
  }

  getRouteState() {
    if (this.routeStateCache) {
      return this.routeStateCache
    }

    const descriptors = []
    const descriptorByFilePath = new Map()
    const completionDescriptors = []

    for (const entry of this.getPagesGraphState().allFiles) {
      const descriptor = createRouteDescriptor(this.pagesRoot, entry.filePath, ROUTE_EXTENSIONS)
      if (descriptor) {
        descriptors.push(descriptor)
        descriptorByFilePath.set(descriptor.filePath, descriptor)
      }

      const completionDescriptor = createRouteDescriptor(this.pagesRoot, entry.filePath, ROUTE_COMPLETION_EXTENSIONS)
      if (completionDescriptor) {
        completionDescriptors.push(completionDescriptor)
      }
    }

    const staticEntries = descriptors
      .filter((descriptor) => descriptor.isStaticRoute)
      .map(toStaticRouteEntry)
    const staticEntriesByFilePath = new Map(
      staticEntries.map((entry) => [entry.filePath, entry])
    )
    const completionStaticEntries = completionDescriptors
      .filter((descriptor) => descriptor.isStaticRoute)
      .map(toStaticRouteEntry)

    this.routeStateCache = {
      descriptors,
      descriptorByFilePath,
      staticEntries,
      staticEntriesByFilePath,
      completionStaticEntries,
    }

    return this.routeStateCache
  }

  getResolveCandidates(filePath, requestPath = '') {
    const items = []
    const seen = new Set()
    const requestOptions = getPathCompletionRequestOptions(requestPath, RESOLVE_EXTENSIONS)

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

    for (const [depth, privateRoot] of this.getPrivateSearchRoots(filePath).entries()) {
      const files = this.getSearchRootFileState(privateRoot, RESOLVE_EXTENSIONS).entries

      for (const entry of files) {
        addCandidate(
          buildPathCompletionCandidateValue(entry.relativePath, RESOLVE_EXTENSIONS, {
            keepExtension: requestOptions.keepExtension,
            prefixKind: requestOptions.prefixKind,
            depth,
            trimIndex: !requestOptions.keepExtension,
          }),
          entry.filePath
        )
      }
    }

    return items
  }

  getResolveSearchRoots(filePath, requestPath) {
    const normalizedRequestPath = String(requestPath || '').trim()
    if (!normalizedRequestPath) {
      return []
    }

    if (normalizedRequestPath.startsWith('/')) {
      return [this.pagesRoot]
    }

    if (normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../')) {
      const relativeSearch = parsePrivateSearchRequest(normalizedRequestPath)
      if (!relativeSearch.searchPath) {
        return []
      }

      let searchStartDir = normalizePath(path.dirname(filePath))
      for (let index = 0; index < relativeSearch.skipPrivateRootCount && searchStartDir !== this.pagesRoot; index += 1) {
        searchStartDir = normalizePath(path.dirname(searchStartDir))
      }

      return this.getPrivateSearchRootsForDir(searchStartDir)
    }

    return this.getPrivateSearchRoots(filePath)
  }

  getResolveRequestPathForSearch(requestPath) {
    const normalizedRequestPath = String(requestPath || '').trim()
    if (!normalizedRequestPath) {
      return ''
    }

    if (normalizedRequestPath.startsWith('/')) {
      return normalizedRequestPath.replace(/^\/+/, '')
    }

    if (normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../')) {
      return parsePrivateSearchRequest(normalizedRequestPath).searchPath
    }

    return normalizedRequestPath
  }

  getResolveCandidatePaths(filePath, requestPath) {
    const searchPath = this.getResolveRequestPathForSearch(requestPath)
    if (!searchPath) {
      return []
    }

    const candidatePaths = []
    const seen = new Set()

    for (const privateRoot of this.getResolveSearchRoots(filePath, requestPath)) {
      const directCandidates = getResolveRequestVariants(searchPath).map((requestVariant) => normalizePath(path.join(privateRoot, requestVariant)))
      const indexCandidates = hasKnownExtension(searchPath, RESOLVE_EXTENSIONS)
        ? []
        : RESOLVE_EXTENSIONS.map((extension) => normalizePath(path.join(privateRoot, searchPath, `index${extension}`)))

      for (const candidatePath of [...directCandidates, ...indexCandidates]) {
        if (seen.has(candidatePath)) {
          continue
        }

        seen.add(candidatePath)
        candidatePaths.push(candidatePath)
      }
    }

    return candidatePaths
  }

  getResolveMatchingRoot(filePath, requestPath, targetFilePath) {
    const normalizedTargetFilePath = normalizePath(targetFilePath)
    const searchPath = this.getResolveRequestPathForSearch(requestPath)
    if (!searchPath) {
      return null
    }

    for (const privateRoot of this.getResolveSearchRoots(filePath, requestPath)) {
      const candidatePaths = [
        normalizePath(path.join(privateRoot, searchPath)),
        ...RESOLVE_EXTENSIONS.map((extension) => normalizePath(path.join(privateRoot, `${searchPath}${extension}`))),
        ...RESOLVE_EXTENSIONS.map((extension) => normalizePath(path.join(privateRoot, searchPath, `index${extension}`))),
      ]

      if (candidatePaths.includes(normalizedTargetFilePath)) {
        return privateRoot
      }
    }

    return null
  }

  getPagesCodeFiles() {
    return this.getPagesGraphState().pagesCodeFiles
  }

  getModuleExportedMembers(moduleFilePath, sourceText = null) {
    const normalizedFilePath = normalizePath(moduleFilePath)
    const extension = path.extname(normalizedFilePath).toLowerCase()
    if (!['.js', '.cjs', '.mjs'].includes(extension)) {
      return []
    }

    const effectiveSourceText =
      typeof sourceText === 'string'
        ? sourceText
        : fileExists(normalizedFilePath)
          ? fs.readFileSync(normalizedFilePath, 'utf8')
          : null
    if (effectiveSourceText === null) {
      return []
    }

    const sourceFile = ts.createSourceFile(normalizedFilePath, effectiveSourceText, ts.ScriptTarget.Latest, true)
    return collectExportedMemberDefinitionInfos(sourceFile)
  }

  getModuleExportedStringConstants(moduleFilePath, sourceText = null) {
    const normalizedFilePath = normalizePath(moduleFilePath)
    const extension = path.extname(normalizedFilePath).toLowerCase()
    if (!['.js', '.cjs', '.mjs'].includes(extension)) {
      return new Map()
    }

    if (typeof sourceText === 'string') {
      const sourceFile = ts.createSourceFile(normalizedFilePath, sourceText, ts.ScriptTarget.Latest, true)
      return collectExportedStringConstantValues(sourceFile)
    }

    const cachedValue = this.moduleExportedStringConstantsCache.get(normalizedFilePath)
    if (cachedValue) {
      return cachedValue
    }

    const effectiveSourceText = fileExists(normalizedFilePath)
      ? fs.readFileSync(normalizedFilePath, 'utf8')
      : null
    if (effectiveSourceText === null) {
      return new Map()
    }

    const sourceFile = ts.createSourceFile(normalizedFilePath, effectiveSourceText, ts.ScriptTarget.Latest, true)
    const exportedStringConstants = collectExportedStringConstantValues(sourceFile)
    this.moduleExportedStringConstantsCache.set(normalizedFilePath, exportedStringConstants)
    return exportedStringConstants
  }

  getIncludeLocalsState(options = {}) {
    const readText =
      typeof options.readFileText === 'function'
        ? options.readFileText
        : (filePath) => fs.readFileSync(filePath, 'utf8')
    const codeFiles = this.getPagesCodeFiles()
    const overrideSnapshotKey = Object.entries(options.overrides || {})
      .filter(([, text]) => typeof text === 'string')
      .map(([filePath, text]) => {
        const normalizedFilePath = normalizePath(filePath)
        return `${normalizedFilePath}:override:${text.length}:${hashText(text)}`
      })
      .sort()
      .join('|')
    const snapshotKey = [
      `structure:${this.pagesStructureVersion}`,
      `content:${this.pagesContentVersion}`,
      overrideSnapshotKey,
    ].filter(Boolean).join('|')

    if (this.includeLocalsCache && this.includeLocalsCache.snapshotKey === snapshotKey) {
      return this.includeLocalsCache
    }

    const overrides = new Map()
    for (const [filePath, text] of Object.entries(options.overrides || {})) {
      if (typeof text === 'string') {
        overrides.set(normalizePath(filePath), text)
      }
    }
    const byTargetFile = new Map()

    const addCallSite = (targetFilePath, callSite) => {
      const normalizedTargetFilePath = normalizePath(targetFilePath)
      let targetState = byTargetFile.get(normalizedTargetFilePath)
      if (!targetState) {
        targetState = {
          callSites: [],
        }
        byTargetFile.set(normalizedTargetFilePath, targetState)
      }

      targetState.callSites.push(callSite)
    }

    for (const entry of codeFiles) {
      if (!fileExists(entry.filePath)) {
        continue
      }

      const normalizedEntryFilePath = normalizePath(entry.filePath)
      const overrideText = overrides.get(normalizedEntryFilePath)
      const sourceState = typeof overrideText === 'string'
        ? {
            sourceText: overrideText,
            identity: `override:${overrideText.length}:${hashText(overrideText)}`,
          }
        : (() => {
            const stats = statSyncCached(normalizedEntryFilePath)
            return {
              sourceText: null,
              identity: `disk:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`,
            }
          })()
      const fileCacheKey = `${sourceState.identity}|structure:${this.pagesStructureVersion}`
      const cachedCallSites = this.includeLocalCallSitesByFileCache.get(normalizedEntryFilePath)
      if (cachedCallSites && cachedCallSites.cacheKey === fileCacheKey) {
        for (const callSite of cachedCallSites.callSites) {
          addCallSite(callSite.targetFilePath, {
            callerFilePath: callSite.callerFilePath,
            locals: callSite.locals,
          })
        }
        continue
      }

      const sourceText = sourceState.sourceText === null ? readText(normalizedEntryFilePath) : sourceState.sourceText
      const analysisText = isEjsFile(entry.filePath) ? buildTemplateVirtualText(sourceText) : sourceText
      const includeCalls = collectIncludeCallEntries(entry.filePath, analysisText)
      const fileCallSites = []

      for (const includeCall of includeCalls) {
        const targetFilePath = this.resolveIncludeTarget(entry.filePath, includeCall.requestPath)
        if (!targetFilePath) {
          continue
        }

        const seenNames = new Set()
        const locals = []
        for (const local of includeCall.locals) {
          if (!local || !isValidIdentifierName(local.name) || POCKETPAGES_GLOBAL_NAMES.has(local.name) || seenNames.has(local.name)) {
            continue
          }

          seenNames.add(local.name)
          locals.push({
            name: local.name,
            typeStrategy: local.typeStrategy || 'static',
            typeText: local.typeText || 'any',
            expressionStart: typeof local.expressionStart === 'number' ? local.expressionStart : null,
            expressionEnd: typeof local.expressionEnd === 'number' ? local.expressionEnd : null,
          })
        }

        const callSite = {
          targetFilePath: normalizePath(targetFilePath),
          callerFilePath: normalizedEntryFilePath,
          locals,
        }
        fileCallSites.push(callSite)
        addCallSite(callSite.targetFilePath, {
          callerFilePath: callSite.callerFilePath,
          locals: callSite.locals,
        })
      }

      this.includeLocalCallSitesByFileCache.set(normalizedEntryFilePath, {
        cacheKey: fileCacheKey,
        callSites: fileCallSites,
      })
    }

    this.includeLocalsCache = {
      snapshotKey,
      byTargetFile,
    }

    return this.includeLocalsCache
  }

  getIncludeLocalBindings(targetFilePath, options = {}) {
    const targetState = this.getIncludeLocalsState(options).byTargetFile.get(normalizePath(targetFilePath))
    if (!targetState) {
      return []
    }

    const localsByName = new Map()
    const callSiteCount = targetState.callSites.length

    for (const callSite of targetState.callSites) {
      for (const local of callSite.locals) {
        let localState = localsByName.get(local.name)
        if (!localState) {
          localState = {
            presenceCount: 0,
            typeTexts: new Set(),
          }
          localsByName.set(local.name, localState)
        }

        localState.presenceCount += 1
        localState.typeTexts.add(local.typeText || 'any')
      }
    }

    const bindings = []
    for (const [name, localState] of localsByName.entries()) {
      let typeText = mergeTypeTexts([...localState.typeTexts])
      if (localState.presenceCount < callSiteCount) {
        typeText = mergeTypeTexts([typeText, 'undefined'])
      }

      bindings.push({
        name,
        typeText,
        optional: localState.presenceCount < callSiteCount,
      })
    }

    return bindings.sort((left, right) => left.name.localeCompare(right.name))
  }

  getIncludeTargetCallSites(targetFilePath, options = {}) {
    const targetState = this.getIncludeLocalsState(options).byTargetFile.get(normalizePath(targetFilePath))
    return targetState ? [...targetState.callSites] : []
  }

  resolveResolveTarget(filePath, requestPath) {
    const searchRoots = this.getResolveSearchRoots(filePath, requestPath)
    for (const candidatePath of this.getResolveCandidatePaths(filePath, requestPath)) {
      if (searchRoots.some((searchRoot) => this.getSearchRootFileState(searchRoot, RESOLVE_EXTENSIONS).filePathSet.has(candidatePath))) {
        return candidatePath
      }
    }

    return null
  }

  getRequireCandidatePaths(filePath, requestPath, options = {}) {
    const normalizedRequestPath = String(requestPath || '').trim()
    if (!normalizedRequestPath) {
      return []
    }

    const rootKind = String(options.rootKind || '')
    if (
      rootKind !== '__hooks' &&
      !(normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../') || normalizedRequestPath.startsWith('/'))
    ) {
      return []
    }

    const currentDir = normalizePath(path.dirname(filePath))
    const basePath = rootKind === '__hooks'
      ? normalizePath(path.join(this.appRoot, 'pb_hooks', normalizedRequestPath.replace(/^\/+/, '')))
      : normalizedRequestPath.startsWith('/')
        ? normalizePath(path.join(this.appRoot, normalizedRequestPath))
        : normalizePath(path.join(currentDir, normalizedRequestPath))

    return [
      basePath,
      ...REQUIRE_EXTENSIONS.map((extension) => normalizePath(`${basePath}${extension}`)),
      ...REQUIRE_EXTENSIONS.map((extension) => normalizePath(path.join(basePath, `index${extension}`))),
    ]
  }

  resolveRequireTarget(filePath, requestPath, options = {}) {
    for (const candidatePath of this.getRequireCandidatePaths(filePath, requestPath, options)) {
      if (fileExists(candidatePath)) {
        return candidatePath
      }
    }

    return null
  }

  getIncludeCandidates(filePath, requestPath = '') {
    const items = []
    const seen = new Set()
    const requestOptions = getPathCompletionRequestOptions(requestPath, INCLUDE_EXTENSIONS)

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

    const privateRoots = this.getPrivateSearchRoots(filePath)
    for (const [depth, privateRoot] of privateRoots.entries()) {
      const files = this.getSearchRootFileState(privateRoot, INCLUDE_EXTENSIONS).entries
      for (const entry of files) {
        addCandidate(
          buildPathCompletionCandidateValue(entry.relativePath, INCLUDE_EXTENSIONS, {
            keepExtension: true,
            prefixKind: requestOptions.prefixKind,
            depth,
          }),
          entry.filePath
        )
      }
    }

    return items
  }

  getAssetCandidates(filePath) {
    const currentDir = normalizePath(path.dirname(filePath))
    const items = []
    const seen = new Set()
    const assetFiles = this.getPagesGraphState().assetFiles

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

    for (const entry of assetFiles) {
      const absolutePath = normalizePath(entry.filePath)
      const relativeFromCurrent = toRelativePath(path.relative(currentDir, absolutePath))
      if (!relativeFromCurrent.startsWith('..')) {
        addCandidate(relativeFromCurrent, absolutePath)
      }
    }

    for (const entry of assetFiles) {
      const absolutePath = normalizePath(entry.filePath)
      addCandidate(`/${entry.relativePath}`, absolutePath)
    }

    return items
  }

  getIncludeRequestVariants(requestPath) {
    return getIncludeRequestVariants(requestPath)
  }

  getIncludeCandidatePaths(filePath, requestPath) {
    const normalizedRequestPath = String(requestPath || '').trim()
    if (!normalizedRequestPath) {
      return []
    }

    const candidatePaths = []
    const currentDir = normalizePath(path.dirname(filePath))
    const seen = new Set()

    const addCandidatePath = (candidatePath) => {
      const normalizedCandidatePath = normalizePath(candidatePath)
      if (seen.has(normalizedCandidatePath)) {
        return
      }

      seen.add(normalizedCandidatePath)
      candidatePaths.push(normalizedCandidatePath)
    }

    const addIncludeTargetCandidates = (basePath, originalRequestPath) => {
      for (const requestVariant of getIncludeRequestVariants(originalRequestPath)) {
        addCandidatePath(path.join(basePath, requestVariant))
      }
    }

    if (normalizedRequestPath.startsWith('/')) {
      addIncludeTargetCandidates(this.pagesRoot, normalizedRequestPath.replace(/^\/+/, ''))
    } else if (normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../')) {
      const relativeSearch = parsePrivateSearchRequest(normalizedRequestPath)
      if (relativeSearch.searchPath) {
        let searchStartDir = currentDir
        for (let index = 0; index < relativeSearch.skipPrivateRootCount && searchStartDir !== this.pagesRoot; index += 1) {
          searchStartDir = normalizePath(path.dirname(searchStartDir))
        }

        const privateRoots = this.getPrivateSearchRootsForDir(searchStartDir)
        for (const privateRoot of privateRoots) {
          addIncludeTargetCandidates(privateRoot, relativeSearch.searchPath)
        }
      }

      addIncludeTargetCandidates(currentDir, normalizedRequestPath)
    } else {
      for (const privateRoot of this.getPrivateSearchRoots(filePath)) {
        addIncludeTargetCandidates(privateRoot, normalizedRequestPath)
      }
    }

    return candidatePaths
  }

  resolveIncludeTarget(filePath, requestPath) {
    const candidatePaths = this.getIncludeCandidatePaths(filePath, requestPath)
    if (!candidatePaths.length) {
      return null
    }

    const currentDir = normalizePath(path.dirname(filePath))
    const privateRoots = this.getPrivateSearchRoots(filePath)
    const rootCandidates = new Map()
    const getRootCandidates = (rootPath) => {
      const normalizedRootPath = normalizePath(rootPath)
      if (!rootCandidates.has(normalizedRootPath)) {
        rootCandidates.set(
          normalizedRootPath,
          this.getSearchRootFileState(normalizedRootPath, INCLUDE_EXTENSIONS).filePathSet
        )
      }

      return rootCandidates.get(normalizedRootPath)
    }

    for (const candidatePath of candidatePaths) {
      if (getRootCandidates(currentDir).has(candidatePath)) {
        return candidatePath
      }

      for (const privateRoot of privateRoots) {
        if (candidatePath.startsWith(`${privateRoot}/`) && getRootCandidates(privateRoot).has(candidatePath)) {
          return candidatePath
        }
      }

      if (candidatePath.startsWith(`${this.pagesRoot}/`) && getRootCandidates(this.pagesRoot).has(candidatePath)) {
        return candidatePath
      }
    }

    return null
  }

  resolveAssetTarget(filePath, requestPath) {
    const normalizedRequestPath = stripPathSuffix(String(requestPath || '').trim())
    if (!normalizedRequestPath) {
      return null
    }

    const currentDir = normalizePath(path.dirname(filePath))
    const candidatePath = normalizedRequestPath.startsWith('/')
      ? normalizePath(path.join(this.pagesRoot, normalizedRequestPath))
      : normalizePath(path.join(currentDir, normalizedRequestPath))

    if (!this.getPagesGraphState().assetFilePathSet.has(candidatePath)) {
      return null
    }

    return candidatePath
  }

  getResolvedModuleMemberDefinitionInfo(filePath, requestPath, memberName, sourceText = null) {
    const moduleFilePath = this.resolveResolveTarget(filePath, requestPath)
    if (!moduleFilePath || !memberName) {
      return null
    }

    return this.getModuleExportedMembers(moduleFilePath, sourceText).find((entry) => entry.memberName === String(memberName)) || null
  }

  resolveResolvedModuleMemberTarget(filePath, requestPath, memberName, sourceText = null) {
    const definitionInfo = this.getResolvedModuleMemberDefinitionInfo(filePath, requestPath, memberName, sourceText)
    if (!definitionInfo) {
      return null
    }

    return {
      filePath: definitionInfo.filePath,
      line: definitionInfo.line,
      character: definitionInfo.character,
    }
  }

  getRouteCandidates(options = {}) {
    const preferredMethods = getPreferredRouteMethods(options.routeSource)
    const bestEntries = new Map()

    for (const entry of this.getStaticRouteEntries({ completionOnly: true })) {
      const rank = this.getRouteEntryRank(entry, preferredMethods)
      const current = bestEntries.get(entry.routePath)

      if (!current || rank < current.rank || (rank === current.rank && entry.filePath.localeCompare(current.entry.filePath) < 0)) {
        bestEntries.set(entry.routePath, { entry, rank })
      }
    }

    return [...bestEntries.values()]
      .sort((left, right) => {
        if (left.rank !== right.rank) {
          return left.rank - right.rank
        }

        return left.entry.routePath.localeCompare(right.entry.routePath)
      })
      .map(({ entry }) => ({
        value: entry.routePath,
        filePath: entry.filePath,
        detail: `${entry.method || 'PAGE'} ${toRelativePath(path.relative(this.pagesRoot, entry.filePath))}`,
      }))
  }

  getStaticRouteEntries(options = {}) {
    const routeState = this.getRouteState()
    return options && options.completionOnly
      ? routeState.completionStaticEntries
      : routeState.staticEntries
  }

  getStaticRouteEntryByFilePath(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    return this.getRouteState().staticEntriesByFilePath.get(normalizedFilePath) || null
  }

  getRouteDescriptorByFilePath(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    return this.getRouteState().descriptorByFilePath.get(normalizedFilePath) || null
  }

  describeRouteFilePath(filePath, options = {}) {
    const normalizedFilePath = normalizePath(filePath)
    const extensions = options.completionOnly ? ROUTE_COMPLETION_EXTENSIONS : ROUTE_EXTENSIONS
    return createRouteDescriptor(this.pagesRoot, normalizedFilePath, extensions)
  }

  resolveRouteTarget(_filePath, requestPath, options = {}) {
    const normalizedRequestPath = normalizeRoutePath(requestPath)
    if (!normalizedRequestPath) {
      return null
    }

    const preferredMethods = getPreferredRouteMethods(options.routeSource)
    const requestSegments = splitNormalizedRoutePath(normalizedRequestPath)
    const matchingEntries = []

    for (const descriptor of this.getRouteState().descriptors) {
      const matchDetails = getRoutePathMatchDetails(descriptor.routeSegments, requestSegments)
      if (!matchDetails) {
        continue
      }

      matchingEntries.push({
        ...descriptor,
        ...matchDetails,
      })
    }

    if (!matchingEntries.length) {
      return null
    }

    matchingEntries.sort((left, right) => {
      const leftRank = this.getRouteEntryRank(left, preferredMethods)
      const rightRank = this.getRouteEntryRank(right, preferredMethods)
      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }

      if (left.dynamicSegmentCount !== right.dynamicSegmentCount) {
        return left.dynamicSegmentCount - right.dynamicSegmentCount
      }

      if (left.segmentCount !== right.segmentCount) {
        return right.segmentCount - left.segmentCount
      }

      return left.filePath.localeCompare(right.filePath)
    })

    const bestEntry = matchingEntries[0]
    return Number.isFinite(this.getRouteEntryRank(bestEntry, preferredMethods)) ? bestEntry.filePath : null
  }

  getRouteEntryRank(entry, preferredMethods) {
    if (!isRouteEntryCompatible(entry, preferredMethods)) {
      return Number.POSITIVE_INFINITY
    }

    const normalizedMethod = !entry.method || entry.method === 'PAGE' ? 'PAGE' : entry.method
    const preferredIndex = preferredMethods.indexOf(normalizedMethod)
    if (preferredIndex !== -1) {
      return preferredIndex === 0 ? 0 : 2 + preferredIndex
    }

    if (normalizedMethod === 'PAGE') {
      return 1
    }

    return 10
  }

  inferCollectionArgumentReference(collectionExpression, scriptText, beforeOffset, options = {}) {
    const expressionText = String(collectionExpression || '').trim()
    if (!expressionText) {
      return null
    }

    const sourceText = String(scriptText || '')
    const providedSourceFile =
      options.sourceFile &&
      typeof options.sourceFile.text === 'string' &&
      options.sourceFile.text === sourceText
        ? options.sourceFile
        : null
    const inferenceSourceFile = providedSourceFile || ts.createSourceFile(
      'pocketpages-explicit-collection-reference.ts',
      sourceText,
      ts.ScriptTarget.Latest,
      true
    )
    const state = buildExplicitInferenceState(inferenceSourceFile, beforeOffset, {
      filePath: options.filePath,
      resolveRequireTarget: this.resolveRequireTarget.bind(this),
      getModuleExportedStringConstants: this.getModuleExportedStringConstants.bind(this),
    })

    const expressionSourceFile = ts.createSourceFile(
      'pocketpages-collection-argument.ts',
      `(${expressionText})`,
      ts.ScriptTarget.Latest,
      true
    )
    const statement = expressionSourceFile.statements[0]
    const expressionNode =
      statement &&
      ts.isExpressionStatement(statement) &&
      ts.isParenthesizedExpression(statement.expression)
        ? statement.expression.expression
        : null

    if (!expressionNode) {
      return null
    }

    const collectionModelReference = readCollectionModelReference(expressionNode, state)
    if (collectionModelReference && this.hasCollection(collectionModelReference.collectionName)) {
      return collectionModelReference
    }

    const collectionName = readCollectionNameExpression(expressionNode, state)
    if (collectionName && this.hasCollection(collectionName)) {
      return {
        collectionName,
        confidence: 'high',
        strategy: 'explicit-collection-argument',
      }
    }

    return null
  }

  inferCollectionReference(receiverExpression, scriptText, beforeOffset, options = {}) {
    const receiverName = getLastPathSegment(receiverExpression)
    const collectionNames = this.getCollectionNames()
    const sourceText = String(scriptText || '')
    const providedSourceFile =
      options.sourceFile &&
      typeof options.sourceFile.text === 'string' &&
      options.sourceFile.text === sourceText
        ? options.sourceFile
        : null
    const inferenceSourceFile = providedSourceFile || ts.createSourceFile(
      'pocketpages-explicit-record-reference.ts',
      sourceText,
      ts.ScriptTarget.Latest,
      true
    )
    const explicitReference = inferExplicitVariableCollectionReference(receiverName, inferenceSourceFile, beforeOffset, {
      filePath: options.filePath,
      resolveRequireTarget: this.resolveRequireTarget.bind(this),
      getModuleExportedStringConstants: this.getModuleExportedStringConstants.bind(this),
    })
    if (explicitReference && collectionNames.includes(explicitReference.collectionName)) {
      return explicitReference
    }
    const indexedReference = inferExplicitIndexedElementCollectionReference(receiverExpression, inferenceSourceFile, beforeOffset, {
      filePath: options.filePath,
      resolveRequireTarget: this.resolveRequireTarget.bind(this),
      getModuleExportedStringConstants: this.getModuleExportedStringConstants.bind(this),
    })
    if (indexedReference && collectionNames.includes(indexedReference.collectionName)) {
      return indexedReference
    }
    const callbackReference = inferDirectCallbackCollectionReference(receiverName, inferenceSourceFile, beforeOffset, {
      filePath: options.filePath,
      resolveRequireTarget: this.resolveRequireTarget.bind(this),
      getModuleExportedStringConstants: this.getModuleExportedStringConstants.bind(this),
    })
    if (callbackReference && collectionNames.includes(callbackReference.collectionName)) {
      return callbackReference
    }
    const directCandidates = buildCollectionReferenceCandidates(receiverName)

    for (const candidate of directCandidates) {
      if (collectionNames.includes(candidate.collectionName)) {
        return candidate
      }
    }

    const genericNames = new Set(['record', 'item', 'entry', 'row'])
    const contextFilePath =
      options && typeof options.filePath === 'string' && options.filePath
        ? normalizePath(options.filePath)
        : ''
    if (contextFilePath && genericNames.has(receiverName) && hasPrivateRolesSegment(contextFilePath)) {
      const roleBaseName = path.basename(contextFilePath, path.extname(contextFilePath))
      const roleCandidates = buildCollectionReferenceCandidates(roleBaseName)
      for (const candidate of roleCandidates) {
        if (collectionNames.includes(candidate.collectionName)) {
          return {
            ...candidate,
            confidence: candidate.confidence === 'high' ? 'medium' : candidate.confidence,
            strategy: `role-file:${candidate.strategy}`,
          }
        }
      }
    }

    const singularReceiver = toSingular(receiverName)
    for (const collectionName of collectionNames) {
      if (toSingular(collectionName) === singularReceiver) {
        return {
          collectionName: collectionName,
          confidence: 'medium',
          strategy: 'receiver-singular-match',
        }
      }
    }

    return null
  }

  inferCollectionName(receiverExpression, scriptText, beforeOffset, options = {}) {
    const reference = this.inferCollectionReference(receiverExpression, scriptText, beforeOffset, options)
    return reference ? reference.collectionName : null
  }
}

module.exports = {
  PocketPagesProjectIndex,
  POCKETPAGES_GLOBAL_NAMES,
  collectIncludeCallEntries,
  normalizePath,
  fileExists,
  quoteRegex,
}
