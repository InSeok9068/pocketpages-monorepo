'use strict'

const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const { buildTemplateVirtualText } = require('./ejs-template')

const RESOLVE_EXTENSIONS = ['.js', '.ejs', '.json', '.cjs', '.mjs']
const REQUIRE_EXTENSIONS = ['.js', '.json', '.cjs', '.mjs']
const INCLUDE_EXTENSIONS = ['.ejs']
const ROUTE_EXTENSIONS = ['.ejs', '.js', '.cjs', '.mjs']
const PAGES_CODE_EXTENSIONS = ['.ejs', '.js', '.cjs', '.mjs']
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
  return path.resolve(filePath).replace(/\\/g, '/')
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

function skipParenthesizedExpression(node) {
  let current = node
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
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

function collectIncludeCallEntries(filePath, scriptText) {
  const sourceFile = ts.createSourceFile(filePath, scriptText, ts.ScriptTarget.Latest, true)
  const entries = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'include' &&
      node.arguments.length
    ) {
      const requestPath = readStringLiteralText(node.arguments[0])
      if (requestPath) {
        const locals = []
        const localsArgument = skipExpressionWrappers(node.arguments[1])

        if (localsArgument && ts.isObjectLiteralExpression(localsArgument)) {
          for (const property of localsArgument.properties) {
            if (ts.isSpreadAssignment(property)) {
              continue
            }

            if (ts.isShorthandPropertyAssignment(property)) {
              locals.push({
                name: property.name.text,
                typeStrategy: 'ts-expression',
                typeText: 'any',
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
              continue
            }

            const initializer = skipExpressionWrappers(property.initializer)
            const useTypeScriptInference =
              !!initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer))

            locals.push({
              name: propertyName,
              typeStrategy: useTypeScriptInference ? 'ts-expression' : 'static',
              typeText: useTypeScriptInference ? 'any' : inferIncludeLocalTypeText(property.initializer),
              expressionStart: useTypeScriptInference ? initializer.getStart(sourceFile) : null,
              expressionEnd: useTypeScriptInference ? initializer.getEnd() : null,
            })
          }
        }

        entries.push({
          requestPath,
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

function toDefinitionTarget(filePath, sourceFile, node) {
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

function findExportedMemberDefinitionNode(sourceFile, exportName) {
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
    this.includeLocalsCache = null
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

  getCollectionMethodState() {
    const typesPath = normalizePath(path.join(this.appRoot, 'pb_data', 'types.d.ts'))
    if (!fileExists(typesPath)) {
      this.collectionMethodCache = {
        typesPath,
        mtimeMs: 0,
        methodNames: [...DEFAULT_COLLECTION_METHOD_NAMES],
      }
      return this.collectionMethodCache
    }

    const stats = fs.statSync(typesPath)
    if (this.collectionMethodCache && this.collectionMethodCache.mtimeMs === stats.mtimeMs) {
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
      mtimeMs: stats.mtimeMs,
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

  getPagesCodeFiles() {
    return walkFiles(
      this.pagesRoot,
      (candidatePath) => PAGES_CODE_EXTENSIONS.includes(path.extname(candidatePath).toLowerCase()),
      this.pagesRoot
    )
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

  getIncludeLocalsState() {
    const codeFiles = this.getPagesCodeFiles()
    const snapshotKey = codeFiles
      .filter((entry) => fileExists(entry.filePath))
      .map((entry) => {
        const stats = fs.statSync(entry.filePath)
        return `${normalizePath(entry.filePath)}:${stats.mtimeMs}:${stats.size}`
      })
      .join('|')

    if (this.includeLocalsCache && this.includeLocalsCache.snapshotKey === snapshotKey) {
      return this.includeLocalsCache
    }

    const byTargetFile = new Map()

    for (const entry of codeFiles) {
      if (!fileExists(entry.filePath)) {
        continue
      }

      const sourceText = fs.readFileSync(entry.filePath, 'utf8')
      const analysisText = isEjsFile(entry.filePath) ? buildTemplateVirtualText(sourceText) : sourceText
      const includeCalls = collectIncludeCallEntries(entry.filePath, analysisText)

      for (const includeCall of includeCalls) {
        const targetFilePath = this.resolveIncludeTarget(entry.filePath, includeCall.requestPath)
        if (!targetFilePath) {
          continue
        }

        const normalizedTargetFilePath = normalizePath(targetFilePath)
        let targetState = byTargetFile.get(normalizedTargetFilePath)
        if (!targetState) {
          targetState = {
            callSites: [],
          }
          byTargetFile.set(normalizedTargetFilePath, targetState)
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

        targetState.callSites.push({
          callerFilePath: normalizePath(entry.filePath),
          locals,
        })
      }
    }

    this.includeLocalsCache = {
      snapshotKey,
      byTargetFile,
    }

    return this.includeLocalsCache
  }

  getIncludeLocalBindings(targetFilePath) {
    const targetState = this.getIncludeLocalsState().byTargetFile.get(normalizePath(targetFilePath))
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
        optional: localState.presenceCount < targetState.callSiteCount,
      })
    }

    return bindings.sort((left, right) => left.name.localeCompare(right.name))
  }

  buildIncludeLocalsPrelude(targetFilePath) {
    const bindings = this.getIncludeLocalBindings(targetFilePath)
    if (!bindings.length) {
      return ''
    }

    return bindings.map((binding) => `declare const ${binding.name}: ${binding.typeText};`).join('\n')
  }

  getIncludeTargetCallSites(targetFilePath) {
    const targetState = this.getIncludeLocalsState().byTargetFile.get(normalizePath(targetFilePath))
    return targetState ? [...targetState.callSites] : []
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

  resolveRequireTarget(filePath, requestPath) {
    const normalizedRequestPath = String(requestPath || '').trim()
    if (!normalizedRequestPath) {
      return null
    }

    if (!(normalizedRequestPath.startsWith('./') || normalizedRequestPath.startsWith('../') || normalizedRequestPath.startsWith('/'))) {
      return null
    }

    const currentDir = normalizePath(path.dirname(filePath))
    const basePath = normalizedRequestPath.startsWith('/')
      ? normalizePath(path.join(this.appRoot, normalizedRequestPath))
      : normalizePath(path.join(currentDir, normalizedRequestPath))

    const candidatePaths = [
      basePath,
      ...REQUIRE_EXTENSIONS.map((extension) => normalizePath(`${basePath}${extension}`)),
      ...REQUIRE_EXTENSIONS.map((extension) => normalizePath(path.join(basePath, `index${extension}`))),
    ]

    for (const candidatePath of candidatePaths) {
      if (fileExists(candidatePath)) {
        return candidatePath
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

  getResolvedModuleMemberDefinitionInfo(filePath, requestPath, memberName) {
    const moduleFilePath = this.resolveResolveTarget(filePath, requestPath)
    if (!moduleFilePath || !memberName) {
      return null
    }

    return this.getModuleExportedMembers(moduleFilePath).find((entry) => entry.memberName === String(memberName)) || null
  }

  resolveResolvedModuleMemberTarget(filePath, requestPath, memberName) {
    const definitionInfo = this.getResolvedModuleMemberDefinitionInfo(filePath, requestPath, memberName)
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

    for (const entry of this.getStaticRouteEntries()) {
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

  getStaticRouteEntryByFilePath(filePath) {
    const normalizedFilePath = normalizePath(filePath)
    return this.getStaticRouteEntries().find((entry) => normalizePath(entry.filePath) === normalizedFilePath) || null
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
    const collectionCallRegex = this.getCollectionCallRegex()
    const collectionMatches = collectionCallRegex
      ? Array.from(scriptPrefix.matchAll(collectionCallRegex))
          .map((match) => match[1])
          .filter((name) => this.hasCollection(name))
      : []

    if (collectionMatches.length) {
      const lastCollection = collectionMatches[collectionMatches.length - 1]
      if (lastCollection) {
        return lastCollection
      }
    }

    if (genericNames.has(receiverName)) {
      const allMatches = collectionCallRegex
        ? Array.from(scriptText.matchAll(collectionCallRegex))
            .map((match) => match[1])
            .filter((name) => this.hasCollection(name))
        : []
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
