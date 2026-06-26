'use strict'

const ts = require('typescript')
const { extractTemplateCodeBlocks } = require('./ejs-template')
const { extractServerBlocks } = require('./script-server')

const ROUTE_ATTR_OPEN_RE = /\b(href|action|(?:data-)?hx-(?:get|post|put|delete|patch))\s*=\s*(['"])([^'"]*)$/is
const ROUTE_ATTRIBUTE_NAMES = new Set([
  'href',
  'action',
  'hx-get',
  'hx-post',
  'hx-put',
  'hx-delete',
  'hx-patch',
  'data-hx-get',
  'data-hx-post',
  'data-hx-put',
  'data-hx-delete',
  'data-hx-patch',
])
const DATASTAR_ROUTE_ACTION_RE = /@(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g
const DATASTAR_ROUTE_ACTION_OPEN_RE = /@(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)$/s
const FILTER_COLLECTION_METHOD_NAMES = new Set(['findRecordsByFilter', 'findFirstRecordByFilter'])
const FILTER_FIELD_CANDIDATE_RE = /(^|[(&|]\s*|&&\s*|\|\|\s*)([A-Za-z_][A-Za-z0-9_]*)(?::(?:length|each|lower))?\s*(\?!~|\?!=|\?>=|\?<=|\?~|\?=|\?>|\?<|!~|!=|>=|<=|~|=|>|<)/g
const FILTER_MASKED_CHAR = ' '

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

function isCalleeNamed(expression, name) {
  const target = skipParenthesizedExpression(expression)
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

function readResolveRequestPath(node) {
  const target = skipParenthesizedExpression(node)
  if (!target || !ts.isCallExpression(target)) {
    return null
  }

  if (!isCalleeNamed(target.expression, 'resolve')) {
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

function createRequireMemberScope(parent = null, kind = 'block') {
  return {
    parent,
    kind,
    moduleBindings: new Map(),
    memberBindings: new Map(),
  }
}

function getNearestFunctionRequireMemberScope(scope) {
  let current = scope
  while (current) {
    if (current.kind === 'function') {
      return current
    }
    current = current.parent
  }

  return scope
}

function declareRequireBinding(scope, name, options = {}) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return
  }

  const targetScope = options.functionScoped
    ? getNearestFunctionRequireMemberScope(scope)
    : scope
  targetScope.moduleBindings.set(normalizedName, options.modulePath || null)
  targetScope.memberBindings.set(normalizedName, options.memberInfo || null)
}

function assignRequireModuleBinding(scope, name, requestPath) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return
  }

  let current = scope
  while (current) {
    if (current.moduleBindings.has(normalizedName) || current.memberBindings.has(normalizedName)) {
      current.moduleBindings.set(normalizedName, requestPath || null)
      current.memberBindings.set(normalizedName, null)
      return
    }
    current = current.parent
  }

  const functionScope = getNearestFunctionRequireMemberScope(scope)
  functionScope.moduleBindings.set(normalizedName, requestPath || null)
  functionScope.memberBindings.set(normalizedName, null)
}

function getRequireModuleRequestPath(scope, name) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return null
  }

  let current = scope
  while (current) {
    if (current.moduleBindings.has(normalizedName)) {
      return current.moduleBindings.get(normalizedName) || null
    }
    current = current.parent
  }

  return null
}

function getRequireMemberInfo(scope, name) {
  const normalizedName = String(name || '')
  if (!normalizedName) {
    return null
  }

  let current = scope
  while (current) {
    if (current.memberBindings.has(normalizedName)) {
      return current.memberBindings.get(normalizedName) || null
    }
    current = current.parent
  }

  return null
}

function declareParameterRequireBindings(scope, parameters = []) {
  for (const parameter of parameters) {
    for (const name of collectBindingIdentifierNames(parameter.name)) {
      declareRequireBinding(scope, name)
    }
  }
}

function declareNamedRequireBinding(scope, name) {
  if (!name || !ts.isIdentifier(name)) {
    return
  }

  declareRequireBinding(scope, name.text)
}

function getPropertyNameText(node) {
  if (!node) {
    return null
  }

  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text
  }

  return null
}

function getBindingIdentifier(node) {
  return node && ts.isIdentifier(node) ? node : null
}

function getRequireRequestPathFromExpression(node, scope) {
  const target = skipParenthesizedExpression(node)
  const directRequestPath = readRequireRequestPath(target)
  if (directRequestPath) {
    return directRequestPath
  }

  if (target && ts.isIdentifier(target)) {
    return getRequireModuleRequestPath(scope, target.text)
  }

  return null
}

function addRequiredModuleMemberContext(contexts, sourceFile, modulePath, memberName, node, rangeKind, options = {}) {
  if (!modulePath || !memberName || !node) {
    return
  }

  contexts.push({
    kind: 'required-module-member',
    modulePath,
    memberName,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
    rangeKind,
    canRenameModuleMember: options.canRenameModuleMember !== false,
  })
}

function declareObjectBindingRequireMembers(scope, bindingPattern, requestPath, sourceFile, contexts, options = {}) {
  for (const element of bindingPattern.elements) {
    if (!ts.isBindingElement(element)) {
      continue
    }

    const localIdentifier = getBindingIdentifier(element.name)
    if (!localIdentifier) {
      for (const name of collectBindingIdentifierNames(element.name)) {
        declareRequireBinding(scope, name, { functionScoped: options.functionScoped })
      }
      continue
    }

    const memberName = getPropertyNameText(element.propertyName) || localIdentifier.text
    const canRenameLocal = !element.propertyName || localIdentifier.text === memberName
    declareRequireBinding(scope, localIdentifier.text, {
      functionScoped: options.functionScoped,
      memberInfo: {
        modulePath: requestPath,
        memberName,
        canRenameModuleMember: canRenameLocal,
      },
    })

    if (element.propertyName) {
      addRequiredModuleMemberContext(
        contexts,
        sourceFile,
        requestPath,
        memberName,
        element.propertyName,
        'property'
      )
    }

    addRequiredModuleMemberContext(
      contexts,
      sourceFile,
      requestPath,
      memberName,
      localIdentifier,
      'binding',
      { canRenameModuleMember: canRenameLocal }
    )
  }
}

function declareVariableRequireBinding(scope, node, sourceFile, contexts) {
  if (!node || !node.name) {
    return
  }

  const requestPath = readRequireRequestPath(node.initializer)
  const functionScoped = isFunctionScopedVariableDeclaration(node)
  if (requestPath && ts.isIdentifier(node.name)) {
    declareRequireBinding(scope, node.name.text, {
      functionScoped,
      modulePath: requestPath,
    })
    return
  }

  if (requestPath && ts.isObjectBindingPattern(node.name)) {
    declareObjectBindingRequireMembers(scope, node.name, requestPath, sourceFile, contexts, {
      functionScoped,
    })
    return
  }

  for (const name of collectBindingIdentifierNames(node.name)) {
    declareRequireBinding(scope, name, { functionScoped })
  }
}

function isRequiredMemberReferenceIdentifier(node) {
  if (!node || !ts.isIdentifier(node) || !node.parent) {
    return false
  }

  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false
  }

  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false
  }

  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) {
    return false
  }

  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return false
  }

  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node) {
    return false
  }

  if (ts.isParameter(parent) && parent.name === node) {
    return false
  }

  return true
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

function collectHtmlAttributeEntries(sourceText, tag) {
  const attributes = []
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
    attributes.push({
      name: attributeName,
      quote,
      value: sourceText.slice(valueStart, valueEnd),
      valueStart,
      valueEnd,
      closed: valueRange.closed,
      matchText: sourceText.slice(nameStart, valueRange.closed ? valueEnd + 1 : valueEnd),
    })

    cursor = valueRange.closed ? valueEnd + 1 : valueEnd
  }

  return attributes
}

function getRouteSourceForAttribute(tag, attributeName, attributes) {
  const routeAttributeName = normalizeRouteAttributeName(attributeName)
  if (routeAttributeName !== 'action') {
    return routeAttributeName
  }

  if (String(tag.tagName || '').toLowerCase() !== 'form') {
    return null
  }

  const methodAttribute = attributes.find((attribute) => attribute.name === 'method')
  if (!methodAttribute) {
    return 'action-get'
  }

  const methodValue = String(methodAttribute.value || '').trim()
  if (!methodValue) {
    return 'action-get'
  }

  if (isDynamicRoutePathValue(methodValue)) {
    return 'action'
  }

  const method = methodValue.toLowerCase()
  if (method === 'dialog') {
    return null
  }

  return method === 'post' ? 'action-post' : 'action-get'
}

function normalizeRouteAttributeName(attributeName) {
  const normalizedName = String(attributeName || '').toLowerCase()
  return normalizedName.startsWith('data-hx-')
    ? normalizedName.slice('data-'.length)
    : normalizedName
}

function getDatastarRouteSource(actionName) {
  return `@${String(actionName || '').toLowerCase()}`
}

function isDatastarExpressionAttribute(attribute) {
  return !!attribute &&
    String(attribute.name || '').startsWith('data-') &&
    String(attribute.value || '').includes('@')
}

function collectDatastarActionRouteContexts(attribute) {
  if (!isDatastarExpressionAttribute(attribute)) {
    return []
  }

  const contexts = []
  const value = String(attribute.value || '')
  let match
  DATASTAR_ROUTE_ACTION_RE.lastIndex = 0

  while ((match = DATASTAR_ROUTE_ACTION_RE.exec(value))) {
    const pathValue = match[3]
    if (!pathValue.startsWith('/')) {
      continue
    }

    const localStart = match.index + match[0].lastIndexOf(pathValue)
    contexts.push({
      kind: 'route-path',
      quote: match[2],
      routeSource: getDatastarRouteSource(match[1]),
      value: pathValue,
      start: attribute.valueStart + localStart,
      end: attribute.valueStart + localStart + pathValue.length,
      isDynamic: isDynamicRoutePathValue(pathValue),
      matchText: match[0],
    })
  }

  return contexts
}

function getOpenDatastarActionRouteContext(attribute, offset) {
  if (!isDatastarExpressionAttribute(attribute)) {
    return null
  }

  const localOffset = offset - attribute.valueStart
  if (localOffset < 0 || localOffset > String(attribute.value || '').length) {
    return null
  }

  return getOpenMatchContext(
    attribute.value,
    localOffset,
    DATASTAR_ROUTE_ACTION_OPEN_RE,
    ({ value, start, end, match }) => ({
      kind: 'route-path',
      routeSource: getDatastarRouteSource(match[1]),
      quote: match[2],
      value,
      start: attribute.valueStart + start,
      end: attribute.valueStart + end,
      isOpen: true,
      isDynamic: isDynamicRoutePathValue(value),
    })
  )
}

function collectRouteAttributeContexts(documentText) {
  const sourceText = String(documentText || '')
  const contexts = []

  forEachHtmlStartTag(sourceText, (tag) => {
    const attributes = collectHtmlAttributeEntries(sourceText, tag)
    for (const attribute of attributes) {
      if (
        !attribute.closed ||
        !ROUTE_ATTRIBUTE_NAMES.has(attribute.name) ||
        !attribute.value.startsWith('/')
      ) {
        contexts.push(...collectDatastarActionRouteContexts(attribute))
        continue
      }

      const routeSource = getRouteSourceForAttribute(tag, attribute.name, attributes)
      if (!routeSource) {
        continue
      }

      contexts.push({
        kind: 'route-path',
        quote: attribute.quote,
        routeSource,
        value: attribute.value,
        start: attribute.valueStart,
        end: attribute.valueEnd,
        isDynamic: isDynamicRoutePathValue(attribute.value),
        matchText: attribute.matchText,
      })
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

  const attributes = collectHtmlAttributeEntries(sourceText, tag)
  for (const attribute of attributes) {
    if (offset >= attribute.valueStart && offset <= attribute.valueEnd) {
      const datastarContext = getOpenDatastarActionRouteContext(attribute, offset)
      if (datastarContext) {
        return datastarContext
      }
    }
  }

  return getOpenMatchContext(
    sourceText.slice(tag.attributesStart, offset),
    offset - tag.attributesStart,
    ROUTE_ATTR_OPEN_RE,
    ({ value, start, end, match }) => {
      const routeSource = getRouteSourceForAttribute(tag, match[1], attributes)
      if (!routeSource) {
        return null
      }

      return {
        kind: 'route-path',
        routeSource,
        quote: match[2],
        value,
        start: tag.attributesStart + start,
        end: tag.attributesStart + end,
        isOpen: true,
        isDynamic: isDynamicRoutePathValue(value),
      }
    }
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

  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    const receiverName = target.expression.text
    const memberName = target.name.text

    if (receiverName === 'response' && memberName === 'redirect') {
      return {
        kind: 'route-path',
        routeSource: 'redirect',
      }
    }

    if (receiverName === 'datastar' && (memberName === 'redirect' || memberName === 'replaceURL')) {
      return {
        kind: 'route-path',
        routeSource: memberName === 'redirect' ? 'redirect' : 'replace-url',
      }
    }

    if (receiverName !== 'api') {
      return null
    }

    if (memberName === 'resolve' || memberName === 'include') {
      return {
        kind: `${memberName}-path`,
      }
    }

    if (memberName === 'asset') {
      return {
        kind: 'asset-path',
      }
    }

    if (memberName === 'redirect') {
      return {
        kind: 'route-path',
        routeSource: 'redirect',
      }
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

function createSchemaSourceFile(scriptText, options = {}) {
  return options.sourceFile || ts.createSourceFile(
    'pocketpages-schema-contexts.js',
    String(scriptText || ''),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
}

function getCollectionMethodName(expression, collectionMethodNames = []) {
  const methodNames = new Set((Array.isArray(collectionMethodNames) ? collectionMethodNames : []).filter(Boolean))
  if (!methodNames.size) {
    return null
  }

  const target = skipParenthesizedExpression(expression)
  if (
    !target ||
    !ts.isPropertyAccessExpression(target) ||
    !ts.isIdentifier(target.expression) ||
    target.expression.text !== '$app'
  ) {
    return null
  }

  return methodNames.has(target.name.text) ? target.name.text : null
}

function getRecordFieldCallDescriptor(expression, sourceFile, scriptText) {
  const target = skipParenthesizedExpression(expression)
  if (!target || !ts.isPropertyAccessExpression(target)) {
    return null
  }

  if (target.name.text !== 'get' && target.name.text !== 'set') {
    return null
  }

  const receiverStart = target.expression.getStart(sourceFile)
  const receiverEnd = target.expression.getEnd()
  const receiverExpression = String(scriptText || '').slice(receiverStart, receiverEnd)

  return {
    accessMethod: target.name.text,
    receiverExpression,
    receiverName: getLastPathSegment(receiverExpression),
    receiverStart,
    receiverEnd,
  }
}

function getBoundedStringLiteralRange(pathRange, offset, offsetBase, scriptText) {
  if (!pathRange || pathRange.isClosed) {
    return pathRange
  }

  return {
    ...pathRange,
    value: String(scriptText || '').slice(pathRange.start - offsetBase, offset - offsetBase),
    end: offset,
  }
}

function createCollectionSchemaContext(node, methodName, pathRange, sourceFile, scriptText, offsetBase = 0) {
  return {
    kind: 'collection-name',
    methodName,
    quote: pathRange.quote,
    value: pathRange.value,
    start: pathRange.start,
    end: pathRange.end,
    callStart: offsetBase + node.getStart(sourceFile),
    callEnd: offsetBase + node.getEnd(),
    matchText: String(scriptText || '').slice(node.getStart(sourceFile), node.getEnd()),
  }
}

function createRecordFieldSchemaContext(node, descriptor, pathRange, sourceFile, scriptText, offsetBase = 0) {
  return {
    kind: 'record-field',
    quote: pathRange.quote,
    value: pathRange.value,
    start: pathRange.start,
    end: pathRange.end,
    callStart: offsetBase + node.getStart(sourceFile),
    callEnd: offsetBase + node.getEnd(),
    matchText: String(scriptText || '').slice(node.getStart(sourceFile), node.getEnd()),
    receiverExpression: descriptor.receiverExpression,
    receiverName: descriptor.receiverName,
    receiverStart: offsetBase + descriptor.receiverStart,
    receiverEnd: offsetBase + descriptor.receiverEnd,
    accessMethod: descriptor.accessMethod,
  }
}

function getExpressionText(node, sourceFile, scriptText) {
  if (!node) {
    return ''
  }

  return String(scriptText || '').slice(node.getStart(sourceFile), node.getEnd())
}

function collectFilterFieldCandidates(filterText) {
  const candidates = []
  const sourceText = maskFilterIgnoredRanges(filterText)
  const seenBySpan = new Set()

  FILTER_FIELD_CANDIDATE_RE.lastIndex = 0
  let match = FILTER_FIELD_CANDIDATE_RE.exec(sourceText)
  while (match) {
    const fieldName = match[2]
    const fieldStart = match.index + match[1].length
    const fieldEnd = fieldStart + fieldName.length
    const key = `${fieldStart}:${fieldEnd}`
    if (!seenBySpan.has(key)) {
      seenBySpan.add(key)
      candidates.push({
        fieldName,
        start: fieldStart,
        end: fieldEnd,
      })
    }

    match = FILTER_FIELD_CANDIDATE_RE.exec(sourceText)
  }

  return candidates
}

function maskFilterIgnoredRanges(filterText) {
  const sourceText = String(filterText || '')
  const chars = sourceText.split('')
  let index = 0

  while (index < chars.length) {
    const current = chars[index]
    const next = chars[index + 1]

    if (current === '"' || current === "'") {
      const quote = current
      chars[index] = FILTER_MASKED_CHAR
      index += 1

      while (index < chars.length) {
        const char = chars[index]
        chars[index] = FILTER_MASKED_CHAR
        index += 1

        if (char === '\\') {
          if (index < chars.length) {
            chars[index] = FILTER_MASKED_CHAR
            index += 1
          }
          continue
        }

        if (char === quote) {
          break
        }
      }
      continue
    }

    if (current === '/' && next === '/') {
      chars[index] = FILTER_MASKED_CHAR
      chars[index + 1] = FILTER_MASKED_CHAR
      index += 2

      while (index < chars.length && chars[index] !== '\n' && chars[index] !== '\r') {
        chars[index] = FILTER_MASKED_CHAR
        index += 1
      }
      continue
    }

    index += 1
  }

  return chars.join('')
}

function createFilterFieldSchemaContexts(node, methodName, sourceFile, scriptText, offsetBase = 0) {
  if (!FILTER_COLLECTION_METHOD_NAMES.has(methodName) || node.arguments.length < 2) {
    return []
  }

  const collectionArgument = node.arguments[0]
  const filterArgument = node.arguments[1]
  const filterRange = getStringLiteralPathRange(filterArgument, sourceFile, scriptText, offsetBase)
  if (!filterRange) {
    return []
  }

  const collectionRange = getStringLiteralPathRange(collectionArgument, sourceFile, scriptText, offsetBase)
  const collectionStart = offsetBase + collectionArgument.getStart(sourceFile)
  const collectionEnd = offsetBase + collectionArgument.getEnd()
  const collectionExpression = getExpressionText(collectionArgument, sourceFile, scriptText)
  const matchText = String(scriptText || '').slice(node.getStart(sourceFile), node.getEnd())

  return collectFilterFieldCandidates(filterRange.value).map((candidate) => ({
    kind: 'filter-field',
    methodName,
    value: candidate.fieldName,
    start: filterRange.start + candidate.start,
    end: filterRange.start + candidate.end,
    filterStart: filterRange.start,
    filterEnd: filterRange.end,
    collectionName: collectionRange ? collectionRange.value : null,
    collectionExpression,
    collectionStart,
    collectionEnd,
    callStart: offsetBase + node.getStart(sourceFile),
    callEnd: offsetBase + node.getEnd(),
    matchText,
  }))
}

function getSchemaContextAtOffset(scriptText, offset, options = {}, contextKind = null) {
  const sourceText = String(scriptText || '')
  const offsetBase = Number(options.offsetBase) || 0
  const localOffset = offset - offsetBase
  if (localOffset < 0 || localOffset > sourceText.length) {
    return null
  }

  const sourceFile = createSchemaSourceFile(sourceText, options)
  let foundContext = null
  const includeCollectionContext = !contextKind || contextKind === 'collection-name'
  const includeFieldContext = !contextKind || contextKind === 'record-field'

  const visit = (node) => {
    if (foundContext) {
      return
    }

    if (ts.isCallExpression(node) && node.arguments.length) {
      if (includeCollectionContext) {
        const methodName = getCollectionMethodName(node.expression, options.collectionMethodNames)
        if (methodName) {
          const pathRange = getStringLiteralPathRange(
            node.arguments[0],
            sourceFile,
            sourceText,
            offsetBase,
            { requireClosed: false }
          )
          if (pathRange && offset >= pathRange.start && offset <= pathRange.end) {
            foundContext = createCollectionSchemaContext(
              node,
              methodName,
              getBoundedStringLiteralRange(pathRange, offset, offsetBase, sourceText),
              sourceFile,
              sourceText,
              offsetBase
            )
            return
          }
        }
      }

      if (includeFieldContext) {
        const descriptor = getRecordFieldCallDescriptor(node.expression, sourceFile, sourceText)
        if (descriptor) {
          const pathRange = getStringLiteralPathRange(
            node.arguments[0],
            sourceFile,
            sourceText,
            offsetBase,
            { requireClosed: false }
          )
          if (pathRange && offset >= pathRange.start && offset <= pathRange.end) {
            foundContext = createRecordFieldSchemaContext(
              node,
              descriptor,
              getBoundedStringLiteralRange(pathRange, offset, offsetBase, sourceText),
              sourceFile,
              sourceText,
              offsetBase
            )
            return
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return foundContext
}

function getScriptCollectionContext(scriptText, offset, options = {}) {
  return getSchemaContextAtOffset(scriptText, offset, options, 'collection-name')
}

function getScriptFieldContext(scriptText, offset, options = {}) {
  return getSchemaContextAtOffset(scriptText, offset, options, 'record-field')
}

function getScriptSchemaContextAtOffset(scriptText, offset, options = {}) {
  return getSchemaContextAtOffset(scriptText, offset, options)
}

function getResolvedModuleMemberContext(scriptText, offset) {
  return collectResolvedModuleMemberContexts(scriptText).find((context) => offset >= context.start && offset <= context.end) || null
}

function getRequiredModuleMemberContext(scriptText, offset) {
  return collectRequiredModuleMemberContexts(scriptText).find((context) => offset >= context.start && offset <= context.end) || null
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

function collectRequiredModuleMemberContexts(scriptText) {
  const sourceFile = ts.createSourceFile('pocketpages-require-member.ts', scriptText, ts.ScriptTarget.Latest, true)
  const contexts = []
  const rootScope = createRequireMemberScope(null, 'function')

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
      const functionScope = createRequireMemberScope(scope, 'function')
      declareParameterRequireBindings(functionScope, node.parameters)
      declareNamedRequireBinding(functionScope, node.name)
      if (node.body) {
        visit(node.body, functionScope)
      }
      return
    }

    if (
      node !== sourceFile &&
      (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node))
    ) {
      const blockScope = createRequireMemberScope(scope, 'block')
      ts.forEachChild(node, (child) => visit(child, blockScope))
      return
    }

    if (ts.isVariableDeclaration(node)) {
      declareVariableRequireBinding(scope, node, sourceFile, contexts)
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
      assignRequireModuleBinding(scope, node.left.text, readRequireRequestPath(node.right))
      return
    }

    if (ts.isPropertyAccessExpression(node)) {
      const requestPath = getRequireRequestPathFromExpression(node.expression, scope)
      if (requestPath) {
        addRequiredModuleMemberContext(
          contexts,
          sourceFile,
          requestPath,
          node.name.text,
          node.name,
          'property'
        )
        return
      }
    }

    if (isRequiredMemberReferenceIdentifier(node)) {
      const memberInfo = getRequireMemberInfo(scope, node.text)
      if (memberInfo) {
        addRequiredModuleMemberContext(
          contexts,
          sourceFile,
          memberInfo.modulePath,
          memberInfo.memberName,
          node,
          'local',
          { canRenameModuleMember: memberInfo.canRenameModuleMember !== false }
        )
        return
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope))
  }

  visit(sourceFile, rootScope)
  return contexts
}

function collectSchemaContexts(scriptText, options = {}) {
  const sourceText = String(scriptText || '')
  const offsetBase = Number(options.offsetBase) || 0
  const sourceFile = createSchemaSourceFile(sourceText, options)
  const contexts = []

  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length) {
      const collectionMethodName = getCollectionMethodName(node.expression, options.collectionMethodNames)
      if (collectionMethodName) {
        const pathRange = getStringLiteralPathRange(node.arguments[0], sourceFile, sourceText)
        if (pathRange) {
          contexts.push(createCollectionSchemaContext(
            node,
            collectionMethodName,
            pathRange,
            sourceFile,
            sourceText,
            offsetBase
          ))
        }

        contexts.push(...createFilterFieldSchemaContexts(
          node,
          collectionMethodName,
          sourceFile,
          sourceText,
          offsetBase
        ))
      }

      const fieldDescriptor = getRecordFieldCallDescriptor(node.expression, sourceFile, sourceText)
      if (fieldDescriptor) {
        const pathRange = getStringLiteralPathRange(node.arguments[0], sourceFile, sourceText)
        if (pathRange) {
          contexts.push(createRecordFieldSchemaContext(
            node,
            fieldDescriptor,
            pathRange,
            sourceFile,
            sourceText,
            offsetBase
          ))
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return contexts.sort((left, right) => left.start - right.start || left.end - right.end)
}

module.exports = {
  collectResolveRequestPaths,
  collectRequiredModuleMemberContexts,
  collectResolvedModuleMemberContexts,
  collectSchemaContexts,
  collectPathContexts,
  getPathContextAtOffset,
  getRequiredModuleMemberContext,
  getResolvedModuleMemberContext,
  getScriptCollectionContext,
  getScriptFieldContext,
  getScriptSchemaContextAtOffset,
}
