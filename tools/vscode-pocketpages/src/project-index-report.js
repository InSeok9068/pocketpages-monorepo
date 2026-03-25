'use strict'

const fs = require('fs')
const path = require('path')
const { buildTemplateVirtualText } = require('./ejs-template')
const { PocketPagesProjectIndex, normalizePath } = require('./project-index')
const {
  collectPathContexts,
  collectResolveRequestPaths,
  collectResolvedModuleMemberContexts,
  collectSchemaContexts,
} = require('./custom-context')

/**
 * 경로를 POSIX 스타일 상대 경로로 정리합니다.
 * @param {string} rootPath 기준 경로입니다.
 * @param {string} filePath 대상 파일 경로입니다.
 * @returns {string} 사람이 읽기 쉬운 상대 경로입니다.
 */
function toRelativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join('/')
}

/**
 * EJS 파일이면 분석용 가상 텍스트로 바꿉니다.
 * @param {string} filePath 코드 파일 경로입니다.
 * @param {string} sourceText 원본 파일 텍스트입니다.
 * @returns {string} 정적 분석용 텍스트입니다.
 */
function toAnalysisText(filePath, sourceText) {
  return path.extname(filePath).toLowerCase() === '.ejs' ? buildTemplateVirtualText(sourceText) : sourceText
}

/**
 * 텍스트의 줄 시작 offset 목록을 만듭니다.
 * @param {string} text 파일 전체 텍스트입니다.
 * @returns {number[]} 줄 시작 offset 목록입니다.
 */
function buildLineStarts(text) {
  const starts = [0]

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1)
    }
  }

  return starts
}

/**
 * offset을 1-based line/column으로 바꿉니다.
 * @param {number[]} lineStarts 줄 시작 offset 목록입니다.
 * @param {number} offset 대상 offset입니다.
 * @returns {{ line: number, column: number }} 출력용 위치입니다.
 */
function getLineAndColumn(lineStarts, offset) {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const lineStart = lineStarts[middle]
    const nextLineStart = middle + 1 < lineStarts.length ? lineStarts[middle + 1] : Number.POSITIVE_INFINITY

    if (offset < lineStart) {
      high = middle - 1
      continue
    }

    if (offset >= nextLineStart) {
      low = middle + 1
      continue
    }

    return {
      line: middle + 1,
      column: offset - lineStart + 1,
    }
  }

  return {
    line: 1,
    column: 1,
  }
}

/**
 * 파일 내 span 정보를 출력용 객체로 만듭니다.
 * @param {string} filePath 대상 파일 경로입니다.
 * @param {string} sourceText 원본 파일 텍스트입니다.
 * @param {number | null | undefined} start 시작 offset입니다.
 * @param {number | null | undefined} end 끝 offset입니다.
 * @returns {{ start: number | null, end: number | null, line: number | null, column: number | null }} 위치 정보입니다.
 */
function toLocation(filePath, sourceText, start, end) {
  if (typeof start !== 'number') {
    return {
      start: null,
      end: typeof end === 'number' ? end : null,
      line: null,
      column: null,
    }
  }

  const lineStarts = buildLineStarts(sourceText)
  const position = getLineAndColumn(lineStarts, start)

  return {
    start,
    end: typeof end === 'number' ? end : start,
    line: position.line,
    column: position.column,
  }
}

/**
 * 라우트 파일의 상위 영역을 추론합니다.
 * @param {string} relativePath pages 기준 상대 경로입니다.
 * @returns {'page' | 'api' | 'xapi' | 'asset' | 'other'} 라우트 영역입니다.
 */
function getRouteArea(relativePath) {
  if (relativePath.startsWith('api/')) {
    return 'api'
  }

  if (relativePath.startsWith('xapi/')) {
    return 'xapi'
  }

  if (relativePath.startsWith('assets/')) {
    return 'asset'
  }

  if (relativePath.startsWith('(site)/') || relativePath.startsWith('(reader)/')) {
    return 'page'
  }

  return 'other'
}

/**
 * resolve 대상 파일 종류를 추론합니다.
 * @param {string} targetFilePath 대상 파일 경로입니다.
 * @returns {'module' | 'partial' | 'json' | 'unknown'} 파일 종류입니다.
 */
function getResolveTargetKind(targetFilePath) {
  const extension = path.extname(String(targetFilePath || '')).toLowerCase()
  if (extension === '.ejs') {
    return 'partial'
  }

  if (extension === '.json') {
    return 'json'
  }

  if (['.js', '.cjs', '.mjs'].includes(extension)) {
    return 'module'
  }

  return 'unknown'
}

/**
 * 보고서에 포함할 코드 파일 목록을 정리합니다.
 * @param {PocketPagesProjectIndex} projectIndex PocketPages 인덱스입니다.
 * @returns {Array<{ filePath: string, relativePath: string, sourceText: string, analysisText: string }>} 코드 파일 목록입니다.
 */
function collectRelevantCodeFiles(projectIndex) {
  return projectIndex
    .getPagesCodeFiles()
    .map((entry) => {
      const filePath = normalizePath(entry.filePath)
      const relativePath = toRelativePath(projectIndex.pagesRoot, filePath)
      return {
        filePath,
        relativePath,
        sourceText: fs.readFileSync(filePath, 'utf8'),
      }
    })
    .filter((entry) => !entry.relativePath.startsWith('assets/'))
    .map((entry) => ({
      filePath: entry.filePath,
      relativePath: entry.relativePath,
      sourceText: entry.sourceText,
      analysisText: toAnalysisText(entry.filePath, entry.sourceText),
    }))
}

/**
 * 라우트 보고서 섹션을 만듭니다.
 * @param {PocketPagesProjectIndex} projectIndex PocketPages 인덱스입니다.
 * @param {Array<{ filePath: string, relativePath: string }>} codeFiles 코드 파일 목록입니다.
 * @returns {Array<object>} 라우트 목록입니다.
 */
function buildRoutes(projectIndex, codeFiles) {
  return codeFiles
    .map((entry) => {
      const descriptor = projectIndex.getRouteDescriptorByFilePath(entry.filePath)
      if (!descriptor) {
        return null
      }

      return {
        filePath: entry.filePath,
        relativePath: entry.relativePath,
        routePath: descriptor.routePath,
        method: descriptor.method,
        isStaticRoute: descriptor.isStaticRoute,
        area: getRouteArea(entry.relativePath),
        params: projectIndex.getRouteParamEntries(entry.filePath),
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.routePath !== right.routePath) {
        return left.routePath.localeCompare(right.routePath)
      }

      if (left.method !== right.method) {
        return left.method.localeCompare(right.method)
      }

      return left.filePath.localeCompare(right.filePath)
    })
}

/**
 * partial 보고서 섹션을 만듭니다.
 * @param {PocketPagesProjectIndex} projectIndex PocketPages 인덱스입니다.
 * @param {Array<{ filePath: string, relativePath: string }>} codeFiles 코드 파일 목록입니다.
 * @returns {Array<object>} partial 목록입니다.
 */
function buildPartials(projectIndex, codeFiles) {
  return codeFiles
    .filter((entry) => entry.relativePath.startsWith('_private/') && path.extname(entry.filePath).toLowerCase() === '.ejs')
    .map((entry) => {
      const callers = projectIndex
        .getIncludeTargetCallSites(entry.filePath)
        .map((callSite) => {
          const routeDescriptor = projectIndex.getRouteDescriptorByFilePath(callSite.callerFilePath)
          return {
            callerFilePath: callSite.callerFilePath,
            callerRelativePath: toRelativePath(projectIndex.pagesRoot, callSite.callerFilePath),
            callerRoutePath: routeDescriptor ? routeDescriptor.routePath : null,
            callerRouteMethod: routeDescriptor ? routeDescriptor.method : null,
            locals: callSite.locals
              .map((local) => ({
                name: local.name,
                typeStrategy: local.typeStrategy,
                typeText: local.typeText,
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          }
        })
        .sort((left, right) => left.callerFilePath.localeCompare(right.callerFilePath))

      return {
        filePath: entry.filePath,
        relativePath: entry.relativePath,
        localsShape: projectIndex.getIncludeLocalBindings(entry.filePath),
        callers,
      }
    })
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
}

/**
 * resolve graph 보고서 섹션을 만듭니다.
 * @param {PocketPagesProjectIndex} projectIndex PocketPages 인덱스입니다.
 * @param {Array<{ filePath: string, relativePath: string, sourceText: string, analysisText: string }>} codeFiles 코드 파일 목록입니다.
 * @returns {{ edges: Array<object>, targets: Array<object> }} resolve graph 결과입니다.
 */
function buildResolveGraph(projectIndex, codeFiles) {
  const edges = []
  const targets = new Map()

  for (const entry of codeFiles) {
    const requestPaths = collectResolveRequestPaths(entry.analysisText)
    const memberContexts = collectResolvedModuleMemberContexts(entry.analysisText)
    const membersByRequestPath = new Map()

    for (const memberContext of memberContexts) {
      let memberState = membersByRequestPath.get(memberContext.modulePath)
      if (!memberState) {
        memberState = []
        membersByRequestPath.set(memberContext.modulePath, memberState)
      }

      memberState.push({
        memberName: memberContext.memberName,
        location: toLocation(entry.filePath, entry.sourceText, memberContext.start, memberContext.end),
      })
    }

    for (const requestPath of requestPaths) {
      const targetFilePath = projectIndex.resolveResolveTarget(entry.filePath, requestPath)
      const normalizedTargetFilePath = targetFilePath ? normalizePath(targetFilePath) : null
      const referencedMembers = (membersByRequestPath.get(requestPath) || [])
        .slice()
        .sort((left, right) => {
          if (left.memberName !== right.memberName) {
            return left.memberName.localeCompare(right.memberName)
          }

          return (left.location.start || 0) - (right.location.start || 0)
        })

      edges.push({
        sourceFilePath: entry.filePath,
        sourceRelativePath: entry.relativePath,
        requestPath,
        targetFilePath: normalizedTargetFilePath,
        targetRelativePath: normalizedTargetFilePath ? toRelativePath(projectIndex.pagesRoot, normalizedTargetFilePath) : null,
        targetKind: normalizedTargetFilePath ? getResolveTargetKind(normalizedTargetFilePath) : null,
        referencedMembers,
        unresolved: !normalizedTargetFilePath,
      })

      if (!normalizedTargetFilePath) {
        continue
      }

      let targetState = targets.get(normalizedTargetFilePath)
      if (!targetState) {
        targetState = {
          filePath: normalizedTargetFilePath,
          relativePath: toRelativePath(projectIndex.pagesRoot, normalizedTargetFilePath),
          targetKind: getResolveTargetKind(normalizedTargetFilePath),
          callers: [],
          referencedMemberNames: new Set(),
        }
        targets.set(normalizedTargetFilePath, targetState)
      }

      targetState.callers.push({
        sourceFilePath: entry.filePath,
        sourceRelativePath: entry.relativePath,
        requestPath,
      })

      for (const referencedMember of referencedMembers) {
        targetState.referencedMemberNames.add(referencedMember.memberName)
      }
    }
  }

  return {
    edges: edges.sort((left, right) => {
      if (left.sourceFilePath !== right.sourceFilePath) {
        return left.sourceFilePath.localeCompare(right.sourceFilePath)
      }

      return left.requestPath.localeCompare(right.requestPath)
    }),
    targets: [...targets.values()]
      .map((targetState) => ({
        filePath: targetState.filePath,
        relativePath: targetState.relativePath,
        targetKind: targetState.targetKind,
        callers: targetState.callers.sort((left, right) => left.sourceFilePath.localeCompare(right.sourceFilePath)),
        referencedMemberNames: [...targetState.referencedMemberNames].sort(),
      }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath)),
  }
}

/**
 * route link 보고서 섹션을 만듭니다.
 * @param {PocketPagesProjectIndex} projectIndex PocketPages 인덱스입니다.
 * @param {Array<{ filePath: string, relativePath: string, sourceText: string }>} codeFiles 코드 파일 목록입니다.
 * @returns {Array<object>} 라우트 링크 목록입니다.
 */
function buildRouteLinks(projectIndex, codeFiles) {
  const links = []

  for (const entry of codeFiles) {
    const contexts = collectPathContexts(entry.sourceText).filter((context) => context.kind === 'route-path')

    for (const context of contexts) {
      const isDynamic = !!context.isDynamic
      const targetFilePath = isDynamic
        ? null
        : projectIndex.resolveRouteTarget(entry.filePath, context.value, {
            routeSource: context.routeSource,
          })
      const normalizedTargetFilePath = targetFilePath ? normalizePath(targetFilePath) : null
      const targetDescriptor = normalizedTargetFilePath
        ? projectIndex.getRouteDescriptorByFilePath(normalizedTargetFilePath)
        : null

      links.push({
        sourceFilePath: entry.filePath,
        sourceRelativePath: entry.relativePath,
        sourceKind: context.routeSource,
        requestPath: context.value,
        location: toLocation(entry.filePath, entry.sourceText, context.start, context.end),
        targetFilePath: normalizedTargetFilePath,
        targetRelativePath: normalizedTargetFilePath ? toRelativePath(projectIndex.pagesRoot, normalizedTargetFilePath) : null,
        targetRoutePath: targetDescriptor ? targetDescriptor.routePath : null,
        targetMethod: targetDescriptor ? targetDescriptor.method : null,
        isDynamic,
        unresolved: !normalizedTargetFilePath,
      })
    }
  }

  return links.sort((left, right) => {
    if (left.sourceFilePath !== right.sourceFilePath) {
      return left.sourceFilePath.localeCompare(right.sourceFilePath)
    }

    if (left.requestPath !== right.requestPath) {
      return left.requestPath.localeCompare(right.requestPath)
    }

    return (left.location.start || 0) - (right.location.start || 0)
  })
}

/**
 * schema 사용 보고서 섹션을 만듭니다.
 * @param {PocketPagesProjectIndex} projectIndex PocketPages 인덱스입니다.
 * @param {Array<{ filePath: string, relativePath: string, sourceText: string, analysisText: string }>} codeFiles 코드 파일 목록입니다.
 * @returns {{ collections: Array<object>, fields: Array<object> }} 스키마 사용 결과입니다.
 */
function buildSchemaUsage(projectIndex, codeFiles) {
  const collections = []
  const fields = []
  const collectionMethodNames = projectIndex.getCollectionMethodNames()

  for (const entry of codeFiles) {
    const contexts = collectSchemaContexts(entry.analysisText, {
      collectionMethodNames,
    })

    for (const context of contexts) {
      const location = toLocation(entry.filePath, entry.sourceText, context.start, context.end)

      if (context.kind === 'collection-name') {
        collections.push({
          sourceFilePath: entry.filePath,
          sourceRelativePath: entry.relativePath,
          collectionName: context.value,
          methodName: context.methodName || null,
          existsInSchema: projectIndex.hasCollection(context.value),
          location,
        })
        continue
      }

      if (context.kind !== 'record-field') {
        continue
      }

      const inferredCollection = projectIndex.inferCollectionReference(
        context.receiverExpression,
        entry.analysisText,
        typeof context.start === 'number' ? context.start : 0
      )

      fields.push({
        sourceFilePath: entry.filePath,
        sourceRelativePath: entry.relativePath,
        fieldName: context.value,
        receiverExpression: context.receiverExpression,
        inferredCollectionName: inferredCollection ? inferredCollection.collectionName : null,
        inferenceConfidence: inferredCollection ? inferredCollection.confidence : null,
        inferenceStrategy: inferredCollection ? inferredCollection.strategy : null,
        existsInSchema:
          inferredCollection
            ? projectIndex.hasField(inferredCollection.collectionName, context.value)
            : null,
        location,
      })
    }
  }

  return {
    collections: collections.sort((left, right) => {
      if (left.sourceFilePath !== right.sourceFilePath) {
        return left.sourceFilePath.localeCompare(right.sourceFilePath)
      }

      if (left.collectionName !== right.collectionName) {
        return left.collectionName.localeCompare(right.collectionName)
      }

      return (left.location.start || 0) - (right.location.start || 0)
    }),
    fields: fields.sort((left, right) => {
      if (left.sourceFilePath !== right.sourceFilePath) {
        return left.sourceFilePath.localeCompare(right.sourceFilePath)
      }

      if (left.fieldName !== right.fieldName) {
        return left.fieldName.localeCompare(right.fieldName)
      }

      return (left.location.start || 0) - (right.location.start || 0)
    }),
  }
}

/**
 * route path 기준 라우트 항목 맵을 만듭니다.
 * @param {Array<object>} routes 라우트 목록입니다.
 * @returns {Map<string, Array<object>>} routePath 기준 맵입니다.
 */
function buildRoutesByPath(routes) {
  const byPath = new Map()

  for (const route of routes) {
    let state = byPath.get(route.routePath)
    if (!state) {
      state = []
      byPath.set(route.routePath, state)
    }

    state.push(route)
  }

  return byPath
}

/**
 * 파일 기준 영향 요약 섹션을 만듭니다.
 * @param {{ routes: Array<object>, partials: Array<object>, resolveGraph: { edges: Array<object>, targets: Array<object> }, routeLinks: Array<object>, schemaUsage: { collections: Array<object>, fields: Array<object> } }} sections 기존 보고서 섹션입니다.
 * @returns {Array<object>} 파일 기준 영향 요약입니다.
 */
function buildImpactByFile(sections) {
  const impacts = new Map()
  const routesByPath = buildRoutesByPath(sections.routes)

  function ensureImpact(filePath, fileKind) {
    let state = impacts.get(filePath)
    if (!state) {
      state = {
        filePath,
        relativePath: null,
        fileKind,
        routeInfo: null,
        directCallers: new Map(),
        affectedRoutes: new Map(),
        inboundRouteLinks: new Map(),
        resolveTargetsUsed: new Map(),
        schemaCollections: new Map(),
        schemaFields: new Map(),
      }
      impacts.set(filePath, state)
    }

    if (fileKind && state.fileKind === 'other') {
      state.fileKind = fileKind
    }

    return state
  }

  function addAffectedRoute(state, route) {
    state.affectedRoutes.set(`${route.routePath}::${route.method}`, {
      routePath: route.routePath,
      method: route.method,
      filePath: route.filePath,
      relativePath: route.relativePath,
      area: route.area,
    })
  }

  function getDescendantRoutesForLoaderLike(sourceFilePath) {
    const normalizedSourceFilePath = normalizePath(sourceFilePath)
    const sourceDir = path.dirname(normalizedSourceFilePath)

    return sections.routes.filter((route) => {
      const normalizedRouteFilePath = normalizePath(route.filePath)
      return normalizedRouteFilePath === normalizedSourceFilePath || normalizedRouteFilePath.startsWith(`${sourceDir}/`)
    })
  }

  for (const route of sections.routes) {
    const state = ensureImpact(route.filePath, 'route')
    state.relativePath = route.relativePath
    state.routeInfo = {
      routePath: route.routePath,
      method: route.method,
      area: route.area,
      isStaticRoute: route.isStaticRoute,
      params: route.params,
    }
    addAffectedRoute(state, route)
  }

  for (const partial of sections.partials) {
    const state = ensureImpact(partial.filePath, 'partial')
    state.relativePath = partial.relativePath

    for (const caller of partial.callers) {
      state.directCallers.set(`${caller.callerFilePath}::include`, {
        sourceType: 'include',
        filePath: caller.callerFilePath,
        relativePath: caller.callerRelativePath,
        routePath: caller.callerRoutePath,
        routeMethod: caller.callerRouteMethod,
      })

      if (caller.callerRoutePath) {
        addAffectedRoute(state, {
          routePath: caller.callerRoutePath,
          method: caller.callerRouteMethod || 'PAGE',
          filePath: caller.callerFilePath,
          relativePath: caller.callerRelativePath,
          area: null,
        })
      }
    }
  }

  for (const edge of sections.resolveGraph.edges) {
    const sourceState = ensureImpact(edge.sourceFilePath, 'other')
    if (!sourceState.relativePath) {
      sourceState.relativePath = edge.sourceRelativePath
    }

    sourceState.resolveTargetsUsed.set(`${edge.requestPath}::${edge.targetFilePath || 'unresolved'}`, {
      requestPath: edge.requestPath,
      targetFilePath: edge.targetFilePath,
      targetRelativePath: edge.targetRelativePath,
      targetKind: edge.targetKind,
      unresolved: edge.unresolved,
      referencedMemberNames: [...new Set(edge.referencedMembers.map((entry) => entry.memberName))].sort(),
    })

    if (!edge.targetFilePath) {
      continue
    }

    const targetState = ensureImpact(edge.targetFilePath, edge.targetKind === 'module' ? 'private-module' : edge.targetKind || 'other')
    if (!targetState.relativePath) {
      targetState.relativePath = edge.targetRelativePath
    }

    targetState.directCallers.set(`${edge.sourceFilePath}::resolve::${edge.requestPath}`, {
      sourceType: 'resolve',
      filePath: edge.sourceFilePath,
      relativePath: edge.sourceRelativePath,
      requestPath: edge.requestPath,
      referencedMemberNames: [...new Set(edge.referencedMembers.map((entry) => entry.memberName))].sort(),
    })

    const isLoaderLikeCaller = /\/\+(?:middleware|load)\.(?:js|cjs|mjs)$/.test(edge.sourceFilePath)
    const callerRoutes = isLoaderLikeCaller
      ? getDescendantRoutesForLoaderLike(edge.sourceFilePath)
      : sections.routes.filter((route) => route.filePath === edge.sourceFilePath)
    for (const callerRoute of callerRoutes) {
      addAffectedRoute(targetState, callerRoute)
    }
  }

  for (const link of sections.routeLinks) {
    const sourceState = ensureImpact(link.sourceFilePath, 'other')
    if (!sourceState.relativePath) {
      sourceState.relativePath = link.sourceRelativePath
    }

    if (link.targetFilePath) {
      const targetState = ensureImpact(link.targetFilePath, 'route')
      if (!targetState.relativePath) {
        targetState.relativePath = link.targetRelativePath
      }

      targetState.inboundRouteLinks.set(`${link.sourceFilePath}::${link.location.start || 0}::${link.sourceKind}`, {
        sourceFilePath: link.sourceFilePath,
        sourceRelativePath: link.sourceRelativePath,
        sourceKind: link.sourceKind,
        requestPath: link.requestPath,
        location: link.location,
      })
    }
  }

  for (const collectionUsage of sections.schemaUsage.collections) {
    const state = ensureImpact(collectionUsage.sourceFilePath, 'other')
    if (!state.relativePath) {
      state.relativePath = collectionUsage.sourceRelativePath
    }

    state.schemaCollections.set(`${collectionUsage.collectionName}::${collectionUsage.location.start || 0}`, {
      collectionName: collectionUsage.collectionName,
      methodName: collectionUsage.methodName,
      existsInSchema: collectionUsage.existsInSchema,
      location: collectionUsage.location,
    })
  }

  for (const fieldUsage of sections.schemaUsage.fields) {
    const state = ensureImpact(fieldUsage.sourceFilePath, 'other')
    if (!state.relativePath) {
      state.relativePath = fieldUsage.sourceRelativePath
    }

      state.schemaFields.set(`${fieldUsage.fieldName}::${fieldUsage.location.start || 0}`, {
        fieldName: fieldUsage.fieldName,
        receiverExpression: fieldUsage.receiverExpression,
        inferredCollectionName: fieldUsage.inferredCollectionName,
        inferenceConfidence: fieldUsage.inferenceConfidence,
        inferenceStrategy: fieldUsage.inferenceStrategy,
        existsInSchema: fieldUsage.existsInSchema,
        location: fieldUsage.location,
      })
  }

  for (const state of impacts.values()) {
    if (state.routeInfo && routesByPath.has(state.routeInfo.routePath)) {
      for (const route of routesByPath.get(state.routeInfo.routePath)) {
        addAffectedRoute(state, route)
      }
    }
  }

  return [...impacts.values()]
    .map((state) => ({
      filePath: state.filePath,
      relativePath: state.relativePath,
      fileKind: state.fileKind,
      routeInfo: state.routeInfo,
      directCallers: [...state.directCallers.values()].sort((left, right) => {
        if (left.filePath !== right.filePath) {
          return left.filePath.localeCompare(right.filePath)
        }

        return String(left.sourceType || '').localeCompare(String(right.sourceType || ''))
      }),
      affectedRoutes: [...state.affectedRoutes.values()].sort((left, right) => {
        if (left.routePath !== right.routePath) {
          return left.routePath.localeCompare(right.routePath)
        }

        return String(left.method || '').localeCompare(String(right.method || ''))
      }),
      inboundRouteLinks: [...state.inboundRouteLinks.values()].sort((left, right) => {
        if (left.sourceFilePath !== right.sourceFilePath) {
          return left.sourceFilePath.localeCompare(right.sourceFilePath)
        }

        return (left.location.start || 0) - (right.location.start || 0)
      }),
      resolveTargetsUsed: [...state.resolveTargetsUsed.values()].sort((left, right) => left.requestPath.localeCompare(right.requestPath)),
      schemaCollections: [...state.schemaCollections.values()].sort((left, right) => {
        if (left.collectionName !== right.collectionName) {
          return left.collectionName.localeCompare(right.collectionName)
        }

        return (left.location.start || 0) - (right.location.start || 0)
      }),
      schemaFields: [...state.schemaFields.values()].sort((left, right) => {
        if (left.fieldName !== right.fieldName) {
          return left.fieldName.localeCompare(right.fieldName)
        }

        return (left.location.start || 0) - (right.location.start || 0)
      }),
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
}

/**
 * PocketPages 서비스의 머신리더블 인덱스 보고서를 만듭니다.
 * @param {{ appRoot: string }} options 서비스 루트 옵션입니다.
 * @returns {{ service: string, appRoot: string, pagesRoot: string, generatedAt: string, routes: Array<object>, partials: Array<object>, resolveGraph: { edges: Array<object>, targets: Array<object> }, routeLinks: Array<object>, schemaUsage: { collections: Array<object>, fields: Array<object> }, impactByFile: Array<object> }} 인덱스 보고서입니다.
 */
function buildProjectIndexReport(options) {
  const appRoot = normalizePath(options.appRoot)
  const projectIndex = new PocketPagesProjectIndex(appRoot)
  const codeFiles = collectRelevantCodeFiles(projectIndex)
  const routes = buildRoutes(projectIndex, codeFiles)
  const partials = buildPartials(projectIndex, codeFiles)
  const resolveGraph = buildResolveGraph(projectIndex, codeFiles)
  const routeLinks = buildRouteLinks(projectIndex, codeFiles)
  const schemaUsage = buildSchemaUsage(projectIndex, codeFiles)

  return {
    service: path.basename(appRoot),
    appRoot,
    pagesRoot: normalizePath(projectIndex.pagesRoot),
    generatedAt: new Date().toISOString(),
    routes,
    partials,
    resolveGraph,
    routeLinks,
    schemaUsage,
    impactByFile: buildImpactByFile({
      routes,
      partials,
      resolveGraph,
      routeLinks,
      schemaUsage,
    }),
  }
}

module.exports = {
  buildProjectIndexReport,
}
