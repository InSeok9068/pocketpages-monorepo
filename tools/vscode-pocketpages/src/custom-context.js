'use strict'

const ts = require('typescript')

const PATH_OPEN_RE = /\b(resolve|include)\(\s*(['"])([^'"]*)$/s
const PATH_CLOSED_RE = /\b(resolve|include)\(\s*(['"])([^'"]*)\2/g
const ROUTE_ATTR_OPEN_RE = /\b(href|action|hx-(?:get|post|put|delete|patch))\s*=\s*(['"])(\/[^'"]*)$/s
const ROUTE_ATTR_CLOSED_RE = /\b(href|action|hx-(?:get|post|put|delete|patch))\s*=\s*(['"])(\/[^'"]*)\2/g
const ROUTE_CALL_OPEN_RE = /\b(redirect)\(\s*(['"])(\/[^'"]*)$/s
const ROUTE_CALL_CLOSED_RE = /\b(redirect)\(\s*(['"])(\/[^'"]*)\2(?=\s*[,)\]])/g
const FIELD_OPEN_RE = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.get\(\s*(['"])([^'"]*)$/s
const FIELD_CLOSED_RE = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.get\(\s*(['"])([^'"]+)\2/g
const COLLECTION_REGEX_CACHE = new Map()

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

function collectResolveAliases(sourceFile) {
  const aliases = new Map()

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const requestPath = readResolveRequestPath(node.initializer)
      if (requestPath) {
        aliases.set(node.name.text, requestPath)
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const requestPath = readResolveRequestPath(node.right)
      if (requestPath) {
        aliases.set(node.left.text, requestPath)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return aliases
}

function getResolveRequestPathFromExpression(node, aliases) {
  const target = skipParenthesizedExpression(node)
  if (!target) {
    return null
  }

  if (ts.isIdentifier(target)) {
    return aliases.get(target.text) || null
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
    value,
    start,
    end,
    matchText: fullText,
  }
}

function isDynamicRoutePathValue(value) {
  return /<%[\s\S]*?%>|\$\{[\s\S]*?\}/.test(String(value || ''))
}

function getOpenMatchContext(documentText, offset, regex, mapper) {
  const windowStart = Math.max(0, offset - 400)
  const prefix = documentText.slice(windowStart, offset)
  const match = prefix.match(regex)

  if (!match) {
    return null
  }

  const value = match[3]
  return mapper({
    value,
    start: offset - value.length,
    end: offset,
    match,
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

function getModulePathContextAtOffset(documentText, offset) {
  for (const match of documentText.matchAll(PATH_CLOSED_RE)) {
    const context = toClosedMatchContext(match, `${match[1]}-path`)
    if (offset >= context.start && offset <= context.end) {
      return context
    }
  }

  return getOpenMatchContext(documentText, offset, PATH_OPEN_RE, ({ value, start, end, match }) => ({
    kind: `${match[1]}-path`,
    value,
    start,
    end,
    isOpen: true,
  }))
}

function getRoutePathContextAtOffset(documentText, offset) {
  for (const match of documentText.matchAll(ROUTE_ATTR_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'route-path')
    context.routeSource = match[1]
    context.isDynamic = isDynamicRoutePathValue(context.value)
    if (offset >= context.start && offset <= context.end) {
      return context
    }
  }

  for (const match of documentText.matchAll(ROUTE_CALL_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'route-path')
    context.routeSource = match[1]
    context.isDynamic = isDynamicRoutePathValue(context.value)
    if (offset >= context.start && offset <= context.end) {
      return context
    }
  }

  const openAttributeContext = getOpenMatchContext(documentText, offset, ROUTE_ATTR_OPEN_RE, ({ value, start, end, match }) => ({
    kind: 'route-path',
    routeSource: match[1],
    value,
    start,
    end,
    isOpen: true,
    isDynamic: isDynamicRoutePathValue(value),
  }))
  if (openAttributeContext) {
    return openAttributeContext
  }

  return getOpenMatchContext(documentText, offset, ROUTE_CALL_OPEN_RE, ({ value, start, end, match }) => ({
    kind: 'route-path',
    routeSource: match[1],
    value,
    start,
    end,
    isOpen: true,
    isDynamic: isDynamicRoutePathValue(value),
  }))
}

function getPathContextAtOffset(documentText, offset) {
  const modulePathContext = getModulePathContextAtOffset(documentText, offset)
  if (modulePathContext) {
    return modulePathContext
  }

  return getRoutePathContextAtOffset(documentText, offset)
}

function collectPathContexts(documentText) {
  const contexts = []

  for (const match of documentText.matchAll(PATH_CLOSED_RE)) {
    contexts.push(toClosedMatchContext(match, `${match[1]}-path`))
  }

  for (const match of documentText.matchAll(ROUTE_ATTR_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'route-path')
    context.routeSource = match[1]
    context.isDynamic = isDynamicRoutePathValue(context.value)
    contexts.push(context)
  }

  for (const match of documentText.matchAll(ROUTE_CALL_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'route-path')
    context.routeSource = match[1]
    context.isDynamic = isDynamicRoutePathValue(context.value)
    contexts.push(context)
  }

  return contexts
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
  return getOpenMatchContext(scriptText, offset, FIELD_OPEN_RE, ({ value, start, end, match }) => ({
    kind: 'record-field',
    receiverExpression: match[1],
    receiverName: getLastPathSegment(match[1]),
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
  const aliases = collectResolveAliases(sourceFile)
  const contexts = []

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const requestPath = getResolveRequestPathFromExpression(node.expression, aliases)
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

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
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
    const context = toClosedMatchContext(match, 'record-field')
    context.receiverExpression = match[1]
    context.receiverName = getLastPathSegment(match[1])
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
