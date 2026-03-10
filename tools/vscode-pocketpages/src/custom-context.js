'use strict'

const PATH_OPEN_RE = /\b(resolve|include)\(\s*(['"])([^'"]*)$/s
const PATH_CLOSED_RE = /\b(resolve|include)\(\s*(['"])([^'"]*)\2/g
const ROUTE_ATTR_OPEN_RE = /\b(href|action|hx-(?:get|post|put|delete|patch))\s*=\s*(['"])(\/[^'"]*)$/s
const ROUTE_ATTR_CLOSED_RE = /\b(href|action|hx-(?:get|post|put|delete|patch))\s*=\s*(['"])(\/[^'"]*)\2/g
const ROUTE_CALL_OPEN_RE = /\b(redirect)\(\s*(['"])(\/[^'"]*)$/s
const ROUTE_CALL_CLOSED_RE = /\b(redirect)\(\s*(['"])(\/[^'"]*)\2/g
const COLLECTION_OPEN_RE = /\$app\.(findRecordsByFilter|findFirstRecordByFilter|findRecordById)\(\s*(['"])([^'"]*)$/s
const COLLECTION_CLOSED_RE = /\$app\.(findRecordsByFilter|findFirstRecordByFilter|findRecordById)\(\s*(['"])([^'"]+)\2/g
const FIELD_OPEN_RE = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.get\(\s*(['"])([^'"]*)$/s
const FIELD_CLOSED_RE = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.get\(\s*(['"])([^'"]+)\2/g

function getLastPathSegment(value) {
  return String(value || '')
    .split('.')
    .filter(Boolean)
    .pop() || ''
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
    if (offset >= context.start && offset <= context.end) {
      return context
    }
  }

  for (const match of documentText.matchAll(ROUTE_CALL_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'route-path')
    context.routeSource = match[1]
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
    contexts.push(context)
  }

  for (const match of documentText.matchAll(ROUTE_CALL_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'route-path')
    context.routeSource = match[1]
    contexts.push(context)
  }

  return contexts
}

function getScriptCollectionContext(scriptText, offset) {
  return getOpenMatchContext(scriptText, offset, COLLECTION_OPEN_RE, ({ value, start, end, match }) => ({
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

function collectSchemaContexts(scriptText) {
  const contexts = []

  for (const match of scriptText.matchAll(COLLECTION_CLOSED_RE)) {
    const context = toClosedMatchContext(match, 'collection-name')
    context.methodName = match[1]
    contexts.push(context)
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
  collectSchemaContexts,
  collectPathContexts,
  getPathContextAtOffset,
  getScriptCollectionContext,
  getScriptFieldContext,
}
