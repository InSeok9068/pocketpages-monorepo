#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { buildProjectIndexReport } = require('../tools/vscode-pocketpages/src/project-index-report')

const ROOT_DIR = path.resolve(__dirname, '..')
const APPS_DIR = path.join(ROOT_DIR, 'apps')
const SECTION_NAMES = new Set(['routes', 'partials', 'resolveGraph', 'routeLinks', 'schemaUsage', 'impactByFile'])

function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`
  }

  return value
}

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort((left, right) =>
    String(left).localeCompare(String(right)),
  )
}

function resolveServiceDir(rawArg) {
  if (!rawArg) {
    throw new Error(
      'Usage: node scripts/index-pocketpages.js <service> [--section <name>] [--file <relative-path>] [--json|--pretty]',
    )
  }

  const asPath = path.resolve(fromMsysPath(rawArg))
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory() && fs.existsSync(path.join(asPath, 'pb_hooks', 'pages'))) {
    return asPath
  }

  const serviceDir = path.join(APPS_DIR, rawArg)
  if (
    fs.existsSync(serviceDir) &&
    fs.statSync(serviceDir).isDirectory() &&
    fs.existsSync(path.join(serviceDir, 'pb_hooks', 'pages'))
  ) {
    return serviceDir
  }

  throw new Error(`Unknown service path: ${rawArg}`)
}

function parseArgs(argv) {
  let serviceArg
  let pretty = true
  let section = null
  let file = null

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (!value) {
      continue
    }

    if (value === '--json') {
      pretty = false
      continue
    }

    if (value === '--pretty') {
      pretty = true
      continue
    }

    if (value === '--section') {
      const nextValue = argv[index + 1]
      if (!nextValue) {
        throw new Error('--section requires a section name.')
      }

      if (!SECTION_NAMES.has(nextValue)) {
        throw new Error(`Unknown section: ${nextValue}`)
      }

      section = nextValue
      index += 1
      continue
    }

    if (value === '--file') {
      const nextValue = argv[index + 1]
      if (!nextValue) {
        throw new Error('--file requires a relative path or file name.')
      }

      file = nextValue
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`)
    }

    if (!serviceArg) {
      serviceArg = value
      continue
    }

    throw new Error(`Unexpected argument: ${value}`)
  }

  return {
    serviceArg,
    pretty,
    section,
    file,
  }
}

function compactLocation(location) {
  if (!location || typeof location.line !== 'number') {
    return null
  }

  return {
    line: location.line,
    column: typeof location.column === 'number' ? location.column : 1,
  }
}

function compactRoute(route) {
  if (!route) {
    return null
  }

  return {
    file: route.relativePath,
    routePath: route.routePath,
    method: route.method,
    area: route.area,
    isStaticRoute: !!route.isStaticRoute,
    params: (Array.isArray(route.params) ? route.params : []).map((entry) => entry.name),
  }
}

function collectKnownRelativePaths(report) {
  const values = []

  for (const route of report.routes || []) {
    values.push(route.relativePath)
  }

  for (const partial of report.partials || []) {
    values.push(partial.relativePath)
    for (const caller of partial.callers || []) {
      values.push(caller.callerRelativePath)
    }
  }

  for (const target of (report.resolveGraph && report.resolveGraph.targets) || []) {
    values.push(target.relativePath)
    for (const caller of target.callers || []) {
      values.push(caller.sourceRelativePath)
    }
  }

  for (const edge of (report.resolveGraph && report.resolveGraph.edges) || []) {
    values.push(edge.sourceRelativePath)
    values.push(edge.targetRelativePath)
  }

  for (const link of report.routeLinks || []) {
    values.push(link.sourceRelativePath)
    values.push(link.targetRelativePath)
  }

  for (const usage of (report.schemaUsage && report.schemaUsage.collections) || []) {
    values.push(usage.sourceRelativePath)
  }

  for (const usage of (report.schemaUsage && report.schemaUsage.fields) || []) {
    values.push(usage.sourceRelativePath)
  }

  for (const item of report.impactByFile || []) {
    values.push(item.relativePath)
    for (const caller of item.directCallers || []) {
      values.push(caller.relativePath)
    }
  }

  return uniqueSorted(values)
}

function resolveRelativePath(report, fileSpecifier) {
  if (!fileSpecifier) {
    return null
  }

  const knownPaths = collectKnownRelativePaths(report)
  const normalizedInput = toPortablePath(fileSpecifier).replace(/^\.\/+/, '').replace(/^\/+/, '')
  const pagesRootPrefix = toPortablePath(report.pagesRoot) + '/'
  const appRootPrefix = toPortablePath(report.appRoot) + '/'
  const portableInput = normalizedInput.startsWith(pagesRootPrefix)
    ? normalizedInput.slice(pagesRootPrefix.length)
    : normalizedInput.startsWith(appRootPrefix)
      ? normalizedInput.slice(appRootPrefix.length).replace(/^pb_hooks\/pages\//, '')
      : normalizedInput

  if (knownPaths.includes(portableInput)) {
    return portableInput
  }

  const suffixMatches = knownPaths.filter((candidate) => candidate.endsWith(`/${portableInput}`) || candidate === portableInput)
  if (suffixMatches.length === 1) {
    return suffixMatches[0]
  }

  if (suffixMatches.length > 1) {
    throw new Error(
      `Ambiguous --file "${fileSpecifier}". Matches: ${suffixMatches.slice(0, 10).join(', ')}${suffixMatches.length > 10 ? ', ...' : ''}`,
    )
  }

  const basenameMatches = knownPaths.filter((candidate) => path.posix.basename(candidate) === portableInput)
  if (basenameMatches.length === 1) {
    return basenameMatches[0]
  }

  if (basenameMatches.length > 1) {
    throw new Error(
      `Ambiguous --file "${fileSpecifier}". Matches: ${basenameMatches.slice(0, 10).join(', ')}${basenameMatches.length > 10 ? ', ...' : ''}`,
    )
  }

  throw new Error(`Unknown file for index query: ${fileSpecifier}`)
}

function buildSummary(report) {
  const routeDynamicCount = (report.routes || []).filter((route) => !route.isStaticRoute).length
  const unresolvedRouteLinks = (report.routeLinks || []).filter((link) => link.unresolved).length
  const dynamicRouteLinks = (report.routeLinks || []).filter((link) => link.isDynamic).length
  const unresolvedResolveTargets = ((report.resolveGraph && report.resolveGraph.edges) || []).filter((edge) => edge.unresolved).length
  const highConfidenceFieldCount = ((report.schemaUsage && report.schemaUsage.fields) || []).filter(
    (field) => field.inferenceConfidence === 'high',
  ).length
  const lowConfidenceFieldCount = ((report.schemaUsage && report.schemaUsage.fields) || []).filter(
    (field) => field.inferenceConfidence === 'low',
  ).length
  const impactKinds = {}

  for (const item of report.impactByFile || []) {
    impactKinds[item.fileKind] = (impactKinds[item.fileKind] || 0) + 1
  }

  return {
    service: report.service,
    mode: 'summary',
    sections: {
      routes: {
        count: (report.routes || []).length,
        dynamicCount: routeDynamicCount,
      },
      partials: {
        count: (report.partials || []).length,
      },
      resolveGraph: {
        edgeCount: ((report.resolveGraph && report.resolveGraph.edges) || []).length,
        targetCount: ((report.resolveGraph && report.resolveGraph.targets) || []).length,
        unresolvedCount: unresolvedResolveTargets,
      },
      routeLinks: {
        count: (report.routeLinks || []).length,
        unresolvedCount: unresolvedRouteLinks,
        dynamicCount: dynamicRouteLinks,
      },
      schemaUsage: {
        collectionCount: ((report.schemaUsage && report.schemaUsage.collections) || []).length,
        fieldCount: ((report.schemaUsage && report.schemaUsage.fields) || []).length,
        highConfidenceFieldCount,
        lowConfidenceFieldCount,
      },
      impactByFile: {
        count: (report.impactByFile || []).length,
        byKind: impactKinds,
      },
    },
  }
}

function buildRoutesView(report, relativePath) {
  const routes = (report.routes || [])
    .filter((route) => !relativePath || route.relativePath === relativePath)
    .map((route) => compactRoute(route))

  return relativePath ? (routes[0] || null) : routes
}

function buildPartialsView(report, relativePath) {
  const partials = (report.partials || []).filter((partial) => !relativePath || partial.relativePath === relativePath)

  if (!relativePath) {
    return partials.map((partial) => ({
      file: partial.relativePath,
      localCount: (partial.localsShape || []).length,
      callerCount: (partial.callers || []).length,
    }))
  }

  const partial = partials[0]
  if (!partial) {
    return null
  }

  return {
    file: partial.relativePath,
    localsShape: (partial.localsShape || []).map((entry) => ({
      name: entry.name,
      optional: !!entry.optional,
      type: entry.typeText || null,
    })),
    callers: (partial.callers || []).map((caller) => ({
      file: caller.callerRelativePath,
      routePath: caller.callerRoutePath,
      method: caller.callerRouteMethod,
      locals: (caller.locals || []).map((local) => ({
        name: local.name,
        type: local.typeText || null,
      })),
    })),
  }
}

function compactResolveEdge(edge) {
  return {
    sourceFile: edge.sourceRelativePath,
    requestPath: edge.requestPath,
    targetFile: edge.targetRelativePath,
    targetKind: edge.targetKind,
    unresolved: !!edge.unresolved,
    referencedMemberNames: uniqueSorted((edge.referencedMembers || []).map((entry) => entry.memberName)),
  }
}

function buildResolveGraphView(report, relativePath) {
  const targets = (report.resolveGraph && report.resolveGraph.targets) || []
  const edges = (report.resolveGraph && report.resolveGraph.edges) || []

  if (!relativePath) {
    return targets.map((target) => ({
      file: target.relativePath,
      targetKind: target.targetKind,
      callerCount: (target.callers || []).length,
      referencedMemberCount: (target.referencedMemberNames || []).length,
    }))
  }

  const target = targets.find((entry) => entry.relativePath === relativePath) || null
  const outgoing = edges.filter((edge) => edge.sourceRelativePath === relativePath).map((edge) => compactResolveEdge(edge))

  if (!target && outgoing.length === 0) {
    return null
  }

  return {
    file: relativePath,
    asTarget: target
      ? {
          targetKind: target.targetKind,
          callerFiles: uniqueSorted((target.callers || []).map((caller) => caller.sourceRelativePath)),
          callerCount: (target.callers || []).length,
          referencedMemberNames: target.referencedMemberNames || [],
        }
      : null,
    outgoing,
  }
}

function compactRouteLink(link) {
  return {
    sourceFile: link.sourceRelativePath,
    kind: link.sourceKind,
    requestPath: link.requestPath,
    targetFile: link.targetRelativePath,
    targetRoutePath: link.targetRoutePath,
    unresolved: !!link.unresolved,
    isDynamic: !!link.isDynamic,
    location: compactLocation(link.location),
  }
}

function buildRouteLinksView(report, relativePath) {
  const links = report.routeLinks || []

  if (!relativePath) {
    const grouped = new Map()

    for (const link of links) {
      let state = grouped.get(link.sourceRelativePath)
      if (!state) {
        state = {
          file: link.sourceRelativePath,
          linkCount: 0,
          unresolvedCount: 0,
          dynamicCount: 0,
          targetRouteCount: 0,
          sourceKinds: new Set(),
          targetRoutes: new Set(),
        }
        grouped.set(link.sourceRelativePath, state)
      }

      state.linkCount += 1
      if (link.unresolved) {
        state.unresolvedCount += 1
      }
      if (link.isDynamic) {
        state.dynamicCount += 1
      }
      state.sourceKinds.add(link.sourceKind)
      if (link.targetRoutePath) {
        state.targetRoutes.add(link.targetRoutePath)
      }
    }

    return [...grouped.values()]
      .map((entry) => ({
        file: entry.file,
        linkCount: entry.linkCount,
        unresolvedCount: entry.unresolvedCount,
        dynamicCount: entry.dynamicCount,
        targetRouteCount: entry.targetRoutes.size,
        sourceKinds: [...entry.sourceKinds].sort(),
      }))
      .sort((left, right) => left.file.localeCompare(right.file))
  }

  const outbound = links
    .filter((link) => link.sourceRelativePath === relativePath)
    .map((link) => compactRouteLink(link))
  const inbound = links
    .filter((link) => link.targetRelativePath === relativePath)
    .map((link) => compactRouteLink(link))

  if (outbound.length === 0 && inbound.length === 0) {
    return null
  }

  return {
    file: relativePath,
    outbound,
    inbound,
  }
}

function buildSchemaUsageGroupedByFile(report) {
  const grouped = new Map()

  function ensureFile(relativePath) {
    let state = grouped.get(relativePath)
    if (!state) {
      state = {
        file: relativePath,
        collections: [],
        fields: [],
      }
      grouped.set(relativePath, state)
    }
    return state
  }

  for (const collection of (report.schemaUsage && report.schemaUsage.collections) || []) {
    ensureFile(collection.sourceRelativePath).collections.push(collection)
  }

  for (const field of (report.schemaUsage && report.schemaUsage.fields) || []) {
    ensureFile(field.sourceRelativePath).fields.push(field)
  }

  return [...grouped.values()].sort((left, right) => left.file.localeCompare(right.file))
}

function buildSchemaUsageView(report, relativePath) {
  const grouped = buildSchemaUsageGroupedByFile(report)

  if (!relativePath) {
    return grouped.map((entry) => ({
      file: entry.file,
      collectionCount: entry.collections.length,
      fieldCount: entry.fields.length,
      lowConfidenceFieldCount: entry.fields.filter((field) => field.inferenceConfidence === 'low').length,
      possibleMissingFieldCount: entry.fields.filter(
        (field) => field.existsInSchema === false && field.inferenceConfidence && field.inferenceConfidence !== 'low',
      ).length,
      collections: uniqueSorted(entry.collections.map((collection) => collection.collectionName)),
    }))
  }

  const entry = grouped.find((item) => item.file === relativePath)
  if (!entry) {
    return null
  }

  return {
    file: entry.file,
    collections: entry.collections.map((collection) => ({
      collectionName: collection.collectionName,
      methodName: collection.methodName,
      existsInSchema: collection.existsInSchema,
      location: compactLocation(collection.location),
    })),
    fields: entry.fields.map((field) => ({
      fieldName: field.fieldName,
      receiverExpression: field.receiverExpression,
      inferredCollectionName: field.inferredCollectionName,
      inferenceConfidence: field.inferenceConfidence,
      inferenceStrategy: field.inferenceStrategy,
      existsInSchema: field.existsInSchema,
      location: compactLocation(field.location),
    })),
  }
}

function buildImpactByFileView(report, relativePath) {
  const items = (report.impactByFile || []).filter((item) => !relativePath || item.relativePath === relativePath)

  if (!relativePath) {
    return items.map((item) => ({
      file: item.relativePath,
      fileKind: item.fileKind,
      routePath: item.routeInfo ? item.routeInfo.routePath : null,
      directCallerCount: uniqueSorted((item.directCallers || []).map((caller) => caller.relativePath)).length,
      affectedRouteCount: uniqueSorted((item.affectedRoutes || []).map((route) => route.routePath)).length,
      inboundLinkCount: (item.inboundRouteLinks || []).length,
      resolveTargetRequestCount: uniqueSorted((item.resolveTargetsUsed || []).map((entry) => entry.requestPath)).length,
      schemaCollectionCount: uniqueSorted((item.schemaCollections || []).map((entry) => entry.collectionName)).length,
      schemaFieldCount: uniqueSorted((item.schemaFields || []).map((entry) => entry.fieldName)).length,
    }))
  }

  const item = items[0]
  if (!item) {
    return null
  }

  return {
    file: item.relativePath,
    fileKind: item.fileKind,
    routeInfo: item.routeInfo
      ? {
          routePath: item.routeInfo.routePath,
          method: item.routeInfo.method,
          area: item.routeInfo.area,
          isStaticRoute: !!item.routeInfo.isStaticRoute,
          params: (item.routeInfo.params || []).map((entry) => entry.name),
        }
      : null,
    directCallers: (item.directCallers || []).map((caller) => ({
      sourceType: caller.sourceType,
      file: caller.relativePath,
      routePath: caller.routePath || null,
      requestPath: caller.requestPath || null,
      referencedMemberNames: caller.referencedMemberNames || [],
    })),
    affectedRoutePaths: uniqueSorted((item.affectedRoutes || []).map((route) => route.routePath)),
    inboundRouteLinks: (item.inboundRouteLinks || []).map((link) => ({
      sourceFile: link.sourceRelativePath,
      kind: link.sourceKind,
      requestPath: link.requestPath,
      location: compactLocation(link.location),
    })),
    resolveTargetsUsed: (item.resolveTargetsUsed || []).map((entry) => ({
      requestPath: entry.requestPath,
      targetFile: entry.targetRelativePath,
      targetKind: entry.targetKind,
      unresolved: !!entry.unresolved,
      referencedMemberNames: entry.referencedMemberNames || [],
    })),
    schemaCollections: (item.schemaCollections || []).map((entry) => ({
      collectionName: entry.collectionName,
      methodName: entry.methodName,
      existsInSchema: entry.existsInSchema,
      location: compactLocation(entry.location),
    })),
    schemaFields: (item.schemaFields || []).map((entry) => ({
      fieldName: entry.fieldName,
      receiverExpression: entry.receiverExpression,
      inferredCollectionName: entry.inferredCollectionName,
      inferenceConfidence: entry.inferenceConfidence,
      inferenceStrategy: entry.inferenceStrategy,
      existsInSchema: entry.existsInSchema,
      location: compactLocation(entry.location),
    })),
  }
}

function buildSectionView(report, section, relativePath) {
  if (section === 'routes') {
    return buildRoutesView(report, relativePath)
  }

  if (section === 'partials') {
    return buildPartialsView(report, relativePath)
  }

  if (section === 'resolveGraph') {
    return buildResolveGraphView(report, relativePath)
  }

  if (section === 'routeLinks') {
    return buildRouteLinksView(report, relativePath)
  }

  if (section === 'schemaUsage') {
    return buildSchemaUsageView(report, relativePath)
  }

  if (section === 'impactByFile') {
    return buildImpactByFileView(report, relativePath)
  }

  return null
}

function buildFileView(report, relativePath) {
  const payload = {
    service: report.service,
    mode: 'file',
    file: relativePath,
  }

  for (const section of SECTION_NAMES) {
    const sectionView = buildSectionView(report, section, relativePath)
    if (sectionView) {
      payload[section] = sectionView
    }
  }

  return payload
}

function buildCompactPayload(report, section, relativePath) {
  if (!section && !relativePath) {
    return buildSummary(report)
  }

  if (!section && relativePath) {
    return buildFileView(report, relativePath)
  }

  return {
    service: report.service,
    mode: relativePath ? 'section-file' : 'section',
    section,
    file: relativePath || null,
    [section]: buildSectionView(report, section, relativePath),
  }
}

function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
  }

  let serviceDir
  try {
    serviceDir = resolveServiceDir(parsed.serviceArg)
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
  }

  const report = buildProjectIndexReport({
    appRoot: serviceDir,
  })

  let relativePath = null
  try {
    relativePath = resolveRelativePath(report, parsed.file)
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
  }

  const payload = buildCompactPayload(report, parsed.section, relativePath)
  const spacing = parsed.pretty ? 2 : 0

  process.stdout.write(`${JSON.stringify(payload, null, spacing)}\n`)
}

main()
