'use strict'

const ts = require('typescript')
const { extractTemplateCodeBlocks } = require('./ejs-template')
const { extractServerBlocks } = require('./script-server')

const ROUTE_ATTR_OPEN_RE = /\b(href|action|hx-(?:get|post|put|delete|patch))\s*=\s*(['"])([^'"]*)$/s
const FIELD_RECEIVER_PATTERN = '([A-Za-z_$][\\w$]*(?:(?:\\.[A-Za-z_$][\\w$]*)|\\[(?:\\d+|[A-Za-z_$][\\w$]*)\\])*)'
const FIELD_OPEN_RE = new RegExp(`${FIELD_RECEIVER_PATTERN}\\.(get|set)\\(\\s*(['"])([^'"]*)$`, 's')
const FIELD_CLOSED_RE = new RegExp(`${FIELD_RECEIVER_PATTERN}\\.(get|set)\\(\\s*(['"])([^'"]+)\\3`, 'g')
const COLLECTION_REGEX_CACHE = new Map()
const ROUTE_ATTRIBUTE_NAMES = new Set(['href', 'action', 'hx-get', 'hx-post', 'hx-put', 'hx-delete', 'hx-patch'])

function getLastPathSegment(value) {
  return String(value || '')
    .split('.')
    .filter(Boolean)
    .pop() || ''
}

function skipParenthesizedExpression(node) {
  let current = node
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

function readResolveRequestPath(node) {
  const target = skipParenthesizedExpression(node)
  if (!target || !ts.isCallExpression(target)) {
    return null
  }

  if (!ts.isIdentifier(target.expression) || target.expression.text !== 'resolve') {
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

function createResolveAliasScope(parent = null, kind = 'block') {
  return {
    parent,
    kind,
    bindings: new Map(),
  }
}

function getNearestFunctionResolveAliasScope(scope) {
  let current = scope
  while (current) {
    if (current.kind === 'function') {
      return current
    }
    current = current.parent
  }

  return scope
}

function declareResolveAliasBinding(scope, name, requestPath, options = {}) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return
  }

  const targetScope = options.functionScoped
    ? getNearestFunctionResolveAliasScope(scope)
    : scope
  targetScope.bindings.set(normalizedName, requestPath || null)
}

function assignResolveAliasBinding(scope, name, requestPath) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return
  }

  let current = scope
  while (current) {
    if (current.bindings.has(normalizedName)) {
      current.bindings.set(normalizedName, requestPath || null)
      return
    }
    current = current.parent
  }

  getNearestFunctionResolveAliasScope(scope).bindings.set(normalizedName, requestPath || null)
}

function getResolveAliasRequestPath(scope, name) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return null
  }

  let current = scope
  while (current) {
    if (current.bindings.has(normalizedName)) {
      return current.bindings.get(normalizedName) || null
    }
    current = current.parent
  }

  return null
}

function collectBindingIdentifierNames(node, names = []) {
  if (!node) {
    return names
  }

  if (ts.isIdentifier(node)) {
    names.push(node.text)
    return names
  }

  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (!element) {
        continue
      }

      if (ts.isBindingElement(element)) {
        collectBindingIdentifierNames(element.name, names)
        continue
      }

      if (ts.isOmittedExpression(element)) {
        continue
      }

      collectBindingIdentifierNames(element, names)
    }
  }

  return names
}

function isFunctionScopedVariableDeclaration(node) {
  return !!(
    node &&
    node.parent &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
  )
}

function declareVariableResolveAliasBinding(scope, node) {
  if (!node || !node.name) {
    return
  }

  const requestPath = ts.isIdentifier(node.name) ? readResolveRequestPath(node.initializer) : null
  for (const name of collectBindingIdentifierNames(node.name)) {
    declareResolveAliasBinding(scope, name, requestPath, {
      functionScoped: isFunctionScopedVariableDeclaration(node),
    })
  }
}

function declareParameterResolveAliasBindings(scope, parameters = []) {
  for (const parameter of parameters) {
    for (const name of collectBindingIdentifierNames(parameter.name)) {
      declareResolveAliasBinding(scope, name, null)
    }
  }
}

function declareNamedScopeBinding(scope, name) {
  if (!name || !ts.isIdentifier(name)) {
    return
  }

  declareResolveAliasBinding(scope, name.text, null)
}

function getResolveRequestPathFromExpression(node, scope) {
  const target = skipParenthesizedExpression(node)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return getResolveAliasRequestPath(scope, target.text)
  }

  return readResolveRequestPath(target)
}

function toClosedMatchContext(match, kind) {
  const fullText = match[0]
  const quote = match[2]
  const value = match[3]
  const quoteOffset = fullText.indexOf(quote)
  const start = match.index + quoteOffset + 1
  const end = start + value.length

  return {
    kind,
    quote,
    value,
    start,
    end,
    matchText: fullText,
  }
}

function isStaticPathContext(context) {
  return !!context && !(context.quote === '`' && String(context.value || '').includes('${'))
}

function isDynamicRoutePathValue(value) {
  return /<%[\s\S]*?%>|\$\{[\s\S]*?\}/.test(String(value || ''))
}

function isEjsFilePath(filePath) {
  return /\.ejs$/i.test(String(filePath || ''))
}

function isScriptFilePath(filePath) {
  return /\.(?:[cm]?js|ts)$/i.test(String(filePath || ''))
}

function looksLikeEjsOrHtml(text) {
  const sourceText = String(text || '')
  return /<%|^\s*<[A-Za-z][\w:-]*(?:\s|>|\/>)/.test(sourceText)
}

function resolvePathContextMode(documentText, options = {}) {
  if (options.mode) {
    return options.mode
  }

  if (isEjsFilePath(options.filePath)) {
    return 'ejs'
  }

  if (isScriptFilePath(options.filePath)) {
    return 'script'
  }

  return looksLikeEjsOrHtml(documentText) ? 'ejs' : 'script'
}

function isHtmlNameChar(char) {
  return /[A-Za-z0-9:_-]/.test(String(char || ''))
}

function skipEjsTag(text, startIndex) {
  const closeIndex = String(text || '').indexOf('%>', startIndex + 2)
  if (closeIndex === -1) {
    return text.length
  }

  return closeIndex + 2
}

function skipHtmlComment(text, startIndex) {
  const closeIndex = String(text || '').indexOf('-->', startIndex + 4)
  if (closeIndex === -1) {
    return text.length
  }

  return closeIndex + 3
}

function findHtmlStartTagEnd(text, startIndex) {
  let quote = ''
  let cursor = startIndex + 1

  while (cursor < text.length) {
    const currentChar = text.charAt(cursor)

    if (quote) {
      if (text.slice(cursor, cursor + 2) === '<%') {
        cursor = skipEjsTag(text, cursor)
        continue
      }

      if (currentChar === quote) {
        quote = ''
      }
      cursor += 1
      continue
    }

    if (currentChar === '"' || currentChar === "'") {
      quote = currentChar
      cursor += 1
      continue
    }

    if (text.slice(cursor, cursor + 2) === '<%') {
      cursor = skipEjsTag(text, cursor)
      continue
    }

    if (currentChar === '>') {
      return cursor
    }

    cursor += 1
  }

  return -1
}

function findHtmlCloseTag(text, tagName, startIndex) {
  const sourceText = String(text || '')
  const lowerText = sourceText.toLowerCase()
  const normalizedTagName = String(tagName || '').toLowerCase()
  let cursor = startIndex

  while (cursor < sourceText.length) {
    const closeStart = lowerText.indexOf(`</${normalizedTagName}`, cursor)
    if (closeStart === -1) {
      return null
    }

    const nextChar = sourceText.charAt(closeStart + normalizedTagName.length + 2)
    if (nextChar && isHtmlNameChar(nextChar)) {
      cursor = closeStart + normalizedTagName.length + 2
      continue
    }

    const closeTagEnd = sourceText.indexOf('>', closeStart + normalizedTagName.length + 2)
    if (closeTagEnd === -1) {
      return null
    }

    return {
      start: closeStart,
      end: closeTagEnd + 1,
    }
  }

  return null
}

function readHtmlStartTag(text, startIndex) {
  if (text.charAt(startIndex) !== '<') {
    return null
  }

  if (
    text.slice(startIndex, startIndex + 2) === '<%' ||
    text.slice(startIndex, startIndex + 4) === '<!--'
  ) {
    return null
  }

  const nextChar = text.charAt(startIndex + 1)
  if (!nextChar || nextChar === '/' || nextChar === '!' || nextChar === '?') {
    return null
  }

  let cursor = startIndex + 1
  if (!/[A-Za-z]/.test(text.charAt(cursor))) {
    return null
  }

  const tagNameStart = cursor
  while (cursor < text.length && isHtmlNameChar(text.charAt(cursor))) {
    cursor += 1
  }

  const tagName = text.slice(tagNameStart, cursor)
  const tagEnd = findHtmlStartTagEnd(text, startIndex)
  const attributesEnd = tagEnd === -1 ? text.length : tagEnd

  return {
    tagName,
    start: startIndex,
    end: tagEnd === -1 ? text.length : tagEnd + 1,
    attributesStart: cursor,
    attributesEnd,
  }
}

function forEachHtmlStartTag(text, callback) {
  const sourceText = String(text || '')
  let cursor = 0

  while (cursor < sourceText.length) {
    const tagStart = sourceText.indexOf('<', cursor)
    if (tagStart === -1) {
      return
    }

    if (sourceText.slice(tagStart, tagStart + 2) === '<%') {
      cursor = skipEjsTag(sourceText, tagStart)
      continue
    }

    if (sourceText.slice(tagStart, tagStart + 4) === '<!--') {
      cursor = skipHtmlComment(sourceText, tagStart)
      continue
    }

    const tag = readHtmlStartTag(sourceText, tagStart)
    if (!tag) {
      cursor = tagStart + 1
      continue
    }

    if (callback(tag) === false) {
      return
    }

    const normalizedTagName = String(tag.tagName || '').toLowerCase()
    if (normalizedTagName === 'script' || normalizedTagName === 'style') {
      const closeTag = findHtmlCloseTag(sourceText, tag.tagName, tag.end)
      if (closeTag) {
        cursor = closeTag.end
        continue
      }

      cursor = sourceText.length
      continue
    }

    cursor = tag.end
  }
}

function findQuotedAttributeValueEnd(text, quoteStart, upperBound) {
  const quote = text.charAt(quoteStart)
  let cursor = quoteStart + 1

  while (cursor < upperBound) {
    if (text.slice(cursor, cursor + 2) === '<%') {
      cursor = skipEjsTag(text, cursor)
      continue
    }

    if (text.charAt(cursor) === quote) {
      return {
        end: cursor,
        closed: true,
      }
    }

    cursor += 1
  }

  return {
    end: upperBound,
    closed: false,
  }
}

function skipUnquotedAttributeValue(text, startIndex, upperBound) {
  let cursor = startIndex

  while (cursor < upperBound) {
    if (text.slice(cursor, cursor + 2) === '<%') {
      cursor = skipEjsTag(text, cursor)
      continue
    }

    const currentChar = text.charAt(cursor)
    if (/\s/.test(currentChar) || currentChar === '>' || currentChar === '/') {
      return cursor
    }

    cursor += 1
  }

  return cursor
}

function collectRouteAttributeContexts(documentText) {
  const sourceText = String(documentText || '')
  const contexts = []

  forEachHtmlStartTag(sourceText, (tag) => {
    let cursor = tag.attributesStart

    while (cursor < tag.attributesEnd) {
      while (cursor < tag.attributesEnd && /\s/.test(sourceText.charAt(cursor))) {
        cursor += 1
      }

      if (cursor >= tag.attributesEnd) {
        break
      }

      if (sourceText.slice(cursor, cursor + 2) === '<%') {
        cursor = skipEjsTag(sourceText, cursor)
        continue
      }

      if (sourceText.charAt(cursor) === '/') {
        cursor += 1
        continue
      }

      const nameStart = cursor
      while (cursor < tag.attributesEnd) {
        if (sourceText.slice(cursor, cursor + 2) === '<%') {
          break
        }

        const currentChar = sourceText.charAt(cursor)
        if (/\s/.test(currentChar) || currentChar === '=' || currentChar === '>' || currentChar === '/') {
          break
        }

        cursor += 1
      }

      const attributeName = sourceText.slice(nameStart, cursor).trim().toLowerCase()
      if (!attributeName) {
        cursor += 1
        continue
      }

      while (cursor < tag.attributesEnd && /\s/.test(sourceText.charAt(cursor))) {
        cursor += 1
      }

      if (sourceText.charAt(cursor) !== '=') {
        continue
      }

      cursor += 1
      while (cursor < tag.attributesEnd && /\s/.test(sourceText.charAt(cursor))) {
        cursor += 1
      }

      const quote = sourceText.charAt(cursor)
      if (quote !== '"' && quote !== "'") {
        cursor = skipUnquotedAttributeValue(sourceText, cursor, tag.attributesEnd)
        continue
      }

      const valueStart = cursor + 1
      const valueRange = findQuotedAttributeValueEnd(sourceText, cursor, tag.attributesEnd)
      const valueEnd = valueRange.end
      const value = sourceText.slice(valueStart, valueEnd)

      if (valueRange.closed && ROUTE_ATTRIBUTE_NAMES.has(attributeName) && value.startsWith('/')) {
        contexts.push({
          kind: 'route-path',
          quote,
          routeSource: attributeName,
          value,
          start: valueStart,
          end: valueEnd,
          isDynamic: isDynamicRoutePathValue(value),
          matchText: sourceText.slice(nameStart, valueRange.closed ? valueEnd + 1 : valueEnd),
        })
      }

      cursor = valueRange.closed ? valueEnd + 1 : valueEnd
    }
  })

  return contexts
}

function getHtmlStartTagAtOffset(documentText, offset) {
  const sourceText = String(documentText || '')
  let foundTag = null

  forEachHtmlStartTag(sourceText, (tag) => {
    if (offset >= tag.start && offset <= tag.end) {
      foundTag = tag
      return false
    }

    return undefined
  })

  return foundTag
}

function getRouteAttributeContextAtOffset(documentText, offset) {
  const sourceText = String(documentText || '')

  for (const context of collectRouteAttributeContexts(sourceText)) {
    if (offset >= context.start && offset <= context.end) {
      return context
    }
  }

  const tag = getHtmlStartTagAtOffset(sourceText, offset)
  if (!tag || offset < tag.attributesStart || offset > tag.end) {
    return null
  }

  return getOpenMatchContext(
    sourceText.slice(tag.attributesStart, offset),
    offset - tag.attributesStart,
    ROUTE_ATTR_OPEN_RE,
    ({ value, start, end, match }) => ({
      kind: 'route-path',
      routeSource: match[1],
      quote: match[2],
      value,
      start: tag.attributesStart + start,
      end: tag.attributesStart + end,
      isOpen: true,
      isDynamic: isDynamicRoutePathValue(value),
    })
  )
}

function getOpenMatchContext(documentText, offset, regex, mapper) {
  const windowStart = Math.max(0, offset - 400)
  const prefix = documentText.slice(windowStart, offset)
  const match = prefix.match(regex)

  if (!match) {
    return null
  }

  const value = match[match.length - 1]
  const matchStart = windowStart + (typeof match.index === 'number' ? match.index : prefix.length - String(match[0] || '').length)
  return mapper({
    value,
    start: offset - value.length,
    end: offset,
    match,
    matchStart,
  })
}

function getCollectionRegexState(collectionMethodNames = []) {
  const methodNames = [...new Set((Array.isArray(collectionMethodNames) ? collectionMethodNames : []).filter(Boolean))].sort()
  const cacheKey = methodNames.join('\u0000')
  const cached = COLLECTION_REGEX_CACHE.get(cacheKey)
  if (cached) {
    return cached
  }

  if (!methodNames.length) {
    const emptyState = {
      openRe: null,
      closedRe: null,
    }
    COLLECTION_REGEX_CACHE.set(cacheKey, emptyState)
    return emptyState
  }

  const pattern = methodNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const state = {
    openRe: new RegExp(`\\$app\\.(${pattern})\\(\\s*(['"])([^'"]*)$`, 's'),
    closedRe: new RegExp(`\\$app\\.(${pattern})\\(\\s*(['"])([^'"]+)\\2`, 'g'),
  }
  COLLECTION_REGEX_CACHE.set(cacheKey, state)
  return state
}

function getPathCallDescriptor(expression) {
  const target = skipParenthesizedExpression(expression)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    if (target.text === 'resolve' || target.text === 'include') {
      return {
        kind: `${target.text}-path`,
      }
    }

    if (target.text === 'asset') {
      return {
        kind: 'asset-path',
      }
    }

    if (target.text === 'redirect') {
      return {
        kind: 'route-path',
        routeSource: 'redirect',
      }
    }
  }

  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'api' &&
    target.name.text === 'asset'
  ) {
    return {
      kind: 'asset-path',
    }
  }

  return null
}

function getStringLiteralPathRange(argument, sourceFile, scriptText, offsetBase = 0, options = {}) {
  const target = skipParenthesizedExpression(argument)
  if (!target || !ts.isStringLiteralLike(target)) {
    return null
  }

  const quoteStart = target.getStart(sourceFile)
  const quoteEnd = target.getEnd()
  const quote = scriptText.charAt(quoteStart)
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return null
  }

  const hasClosingQuote = quoteEnd > quoteStart && scriptText.charAt(quoteEnd - 1) === quote
  if (options.requireClosed !== false && !hasClosingQuote) {
    return null
  }

  const valueStart = quoteStart + 1
  const valueEnd = Math.max(valueStart, hasClosingQuote ? quoteEnd - 1 : quoteEnd)
  const value = scriptText.slice(valueStart, valueEnd)
  if (quote === '`' && String(value || '').includes('${')) {
    return null
  }

  return {
    quote,
    value,
    start: offsetBase + valueStart,
    end: offsetBase + valueEnd,
    isClosed: hasClosingQuote,
  }
}

function createScriptPathContextFromCall(node, descriptor, pathRange, sourceFile, sourceText) {
  const context = {
    quote: pathRange.quote,
    value: pathRange.value,
    start: pathRange.start,
    end: pathRange.end,
    kind: descriptor.kind,
    matchText: sourceText.slice(node.getStart(sourceFile), node.getEnd()),
  }

  if (!pathRange.isClosed) {
    context.isOpen = true
  }

  if (descriptor.kind === 'route-path') {
    context.routeSource = descriptor.routeSource
    context.isDynamic = isDynamicRoutePathValue(context.value)
  }

  return context
}

function collectScriptPathContexts(scriptText, options = {}) {
  const sourceText = String(scriptText || '')
  const offsetBase = Number(options.offsetBase) || 0
  const sourceFile = options.sourceFile || ts.createSourceFile(
    'pocketpages-path-contexts.js',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const contexts = []

  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length) {
      const descriptor = getPathCallDescriptor(node.expression)
      if (descriptor) {
        const pathRange = getStringLiteralPathRange(node.arguments[0], sourceFile, sourceText, offsetBase)
        if (pathRange) {
          contexts.push(createScriptPathContextFromCall(node, descriptor, pathRange, sourceFile, sourceText))
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return contexts.sort((left, right) => left.start - right.start || left.end - right.end)
}

function getOpenScriptPathContextAtOffset(scriptText, offset, options = {}) {
  const sourceText = String(scriptText || '')
  const offsetBase = Number(options.offsetBase) || 0
  const sourceFile = options.sourceFile || ts.createSourceFile(
    'pocketpages-open-path-context.js',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  let openContext = null

  const visit = (node) => {
    if (openContext) {
      return
    }

    if (ts.isCallExpression(node) && node.arguments.length) {
      const descriptor = getPathCallDescriptor(node.expression)
      if (descriptor) {
        const pathRange = getStringLiteralPathRange(
          node.arguments[0],
          sourceFile,
          sourceText,
          offsetBase,
          { requireClosed: false }
        )
        if (pathRange && offset >= pathRange.start && offset <= pathRange.end) {
          const boundedPathRange = pathRange.isClosed
            ? pathRange
            : {
                ...pathRange,
                value: sourceText.slice(pathRange.start - offsetBase, offset - offsetBase),
                end: offset,
              }
          openContext = createScriptPathContextFromCall(node, descriptor, boundedPathRange, sourceFile, sourceText)
          return
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return openContext
}

function getScriptPathContextAtOffset(scriptText, offset, options = {}) {
  const sourceText = String(scriptText || '')
  const offsetBase = Number(options.offsetBase) || 0
  const localOffset = offset - offsetBase
  if (localOffset < 0 || localOffset > sourceText.length) {
    return null
  }

  for (const context of collectScriptPathContexts(sourceText, options)) {
    if (offset >= context.start && offset <= context.end) {
      return context
    }
  }

  return getOpenScriptPathContextAtOffset(sourceText, offset, options)
}

function isTemplateBlockInsideServerBlock(block, serverBlocks) {
  return serverBlocks.some((serverBlock) =>
    block.fullStart >= serverBlock.fullStart &&
    block.fullEnd <= serverBlock.fullEnd
  )
}

function getEjsExecutablePathSegments(documentText) {
  const sourceText = String(documentText || '')
  const serverBlocks = extractServerBlocks(sourceText)
  const templateBlocks = extractTemplateCodeBlocks(sourceText)
    .filter((block) => !isTemplateBlockInsideServerBlock(block, serverBlocks))

  return [
    ...serverBlocks.map((block) => ({
      kind: 'server-script',
      text: block.content,
      offsetBase: block.contentStart,
      start: block.contentStart,
      end: block.contentEnd,
    })),
    ...templateBlocks.map((block) => ({
      kind: 'template-code',
      text: block.content,
      offsetBase: block.contentStart,
      start: block.contentStart,
      end: block.contentEnd,
    })),
  ].sort((left, right) => left.start - right.start || left.end - right.end)
}

function getEjsExecutableSegmentAtOffset(documentText, offset) {
  return getEjsExecutablePathSegments(documentText)
    .find((segment) => offset >= segment.start && offset <= segment.end) || null
}

function collectEjsPathContexts(documentText) {
  const contexts = []
  const seen = new Set()

  function addContext(context) {
    if (!context) {
      return
    }

    const key = `${context.kind}:${context.start}:${context.end}:${context.value}:${context.routeSource || ''}`
    if (seen.has(key)) {
      return
    }

    seen.add(key)
    contexts.push(context)
  }

  for (const segment of getEjsExecutablePathSegments(documentText)) {
    for (const context of collectScriptPathContexts(segment.text, { offsetBase: segment.offsetBase })) {
      addContext(context)
    }
  }

  for (const context of collectRouteAttributeContexts(documentText)) {
    addContext(context)
  }

  return contexts.sort((left, right) => left.start - right.start || left.end - right.end)
}

function getEjsPathContextAtOffset(documentText, offset) {
  const segment = getEjsExecutableSegmentAtOffset(documentText, offset)
  if (segment) {
    const scriptContext = getScriptPathContextAtOffset(segment.text, offset, {
      offsetBase: segment.offsetBase,
    })
    if (scriptContext) {
      return scriptContext
    }
  }

  return getRouteAttributeContextAtOffset(documentText, offset)
}

function getPathContextAtOffset(documentText, offset, options = {}) {
  const mode = resolvePathContextMode(documentText, options)
  if (mode === 'ejs' || mode === 'html') {
    return getEjsPathContextAtOffset(documentText, offset)
  }

  if (mode === 'script') {
    return getScriptPathContextAtOffset(documentText, offset)
  }

  return null
}

function collectPathContexts(documentText, options = {}) {
  const mode = resolvePathContextMode(documentText, options)
  if (mode === 'ejs' || mode === 'html') {
    return collectEjsPathContexts(documentText)
  }

  if (mode === 'script') {
    return collectScriptPathContexts(documentText)
  }

  return []
}

function getScriptCollectionContext(scriptText, offset, options = {}) {
  const collectionRegexState = getCollectionRegexState(options.collectionMethodNames)
  if (!collectionRegexState.openRe) {
    return null
  }

  return getOpenMatchContext(scriptText, offset, collectionRegexState.openRe, ({ value, start, end, match }) => ({
    kind: 'collection-name',
    methodName: match[1],
    value,
    start,
    end,
  }))
}

function getScriptFieldContext(scriptText, offset) {
  return getOpenMatchContext(scriptText, offset, FIELD_OPEN_RE, ({ value, start, end, match, matchStart }) => ({
    kind: 'record-field',
    receiverExpression: match[1],
    receiverName: getLastPathSegment(match[1]),
    receiverStart: matchStart,
    receiverEnd: matchStart + String(match[1] || '').length,
    accessMethod: match[2],
    value,
    start,
    end,
  }))
}

function getResolvedModuleMemberContext(scriptText, offset) {
  return collectResolvedModuleMemberContexts(scriptText).find((context) => offset >= context.start && offset <= context.end) || null
}

function collectResolveRequestPaths(scriptText) {
  const sourceFile = ts.createSourceFile('pocketpages-resolve-paths.ts', scriptText, ts.ScriptTarget.Latest, true)
  const requestPaths = []
  const seen = new Set()

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const requestPath = readResolveRequestPath(node)
      if (requestPath && !seen.has(requestPath)) {
        seen.add(requestPath)
        requestPaths.push(requestPath)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return requestPaths
}

function collectResolvedModuleMemberContexts(scriptText) {
  const sourceFile = ts.createSourceFile('pocketpages-resolve-member.ts', scriptText, ts.ScriptTarget.Latest, true)
  const contexts = []
  const rootScope = createResolveAliasScope(null, 'function')

  const visit = (node, scope) => {
    if (
      node !== sourceFile &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node))
    ) {
      const functionScope = createResolveAliasScope(scope, 'function')
      declareParameterResolveAliasBindings(functionScope, node.parameters)
      declareNamedScopeBinding(functionScope, node.name)
      if (node.body) {
        visit(node.body, functionScope)
      }
      return
    }

    if (
      node !== sourceFile &&
      (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node))
    ) {
      const blockScope = createResolveAliasScope(scope, 'block')
      ts.forEachChild(node, (child) => visit(child, blockScope))
      return
    }

    if (ts.isVariableDeclaration(node)) {
      declareVariableResolveAliasBinding(scope, node)
      if (node.initializer) {
        visit(node.initializer, scope)
      }
      return
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      visit(node.right, scope)
      assignResolveAliasBinding(scope, node.left.text, readResolveRequestPath(node.right))
      return
    }

    if (ts.isPropertyAccessExpression(node)) {
      const requestPath = getResolveRequestPathFromExpression(node.expression, scope)
      if (requestPath) {
        contexts.push({
          kind: 'resolved-module-member',
          modulePath: requestPath,
          memberName: node.name.text,
          start: node.name.getStart(sourceFile),
          end: node.name.getEnd(),
        })
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope))
  }

  visit(sourceFile, rootScope)
  return contexts
}

function collectSchemaContexts(scriptText, options = {}) {
  const contexts = []

  const collectionRegexState = getCollectionRegexState(options.collectionMethodNames)
  if (collectionRegexState.closedRe) {
    for (const match of scriptText.matchAll(collectionRegexState.closedRe)) {
      const context = toClosedMatchContext(match, 'collection-name')
      context.methodName = match[1]
      contexts.push(context)
    }
  }

  for (const match of scriptText.matchAll(FIELD_CLOSED_RE)) {
    const fullText = match[0]
    const quote = match[3]
    const value = match[4]
    const quoteOffset = fullText.indexOf(quote)
    const context = {
      kind: 'record-field',
      value,
      start: match.index + quoteOffset + 1,
      end: match.index + quoteOffset + 1 + value.length,
      matchText: fullText,
    }
    context.receiverExpression = match[1]
    context.receiverName = getLastPathSegment(match[1])
    context.receiverStart = match.index
    context.receiverEnd = match.index + String(match[1] || '').length
    context.accessMethod = match[2]
    contexts.push(context)
  }

  return contexts
}

module.exports = {
  collectResolveRequestPaths,
  collectResolvedModuleMemberContexts,
  collectSchemaContexts,
  collectPathContexts,
  getPathContextAtOffset,
  getResolvedModuleMemberContext,
  getScriptCollectionContext,
  getScriptFieldContext,
}
