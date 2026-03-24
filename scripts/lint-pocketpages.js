#!/usr/bin/env node
'use strict'

// PocketPages lint rules:
// 1) resolve('/_private/...') 같이 _private 기준 규칙에 어긋나는 resolve 사용
// 2) include('/_private/...') 같이 _private 절대 경로 include 사용
// 3) EJS/JS에서 record.fieldName 형태의 직접 필드 접근
// 4) +middleware.js 에서 인자로 받은 resolve 대신 전역 resolve() 직접 사용
// 5) api/xapi 아래에 +layout.ejs 를 두는 잘못된 레이아웃 구성
// 6) xapi 엔드포인트에서 <!DOCTYPE>, <html>, <body> 같은 전체 문서 응답 반환
// 7) _private 내부에 +layout, +load, +middleware 같은 특수 PocketPages 파일 배치
// 8) xapi 엔드포인트에서 response.json(...) 사용
// 9) api 엔드포인트에서 redirect(...) 사용
// 10) redirect flash를 쓰면서 __flash 쿼리스트링을 수동 조립하는 패턴
// 11) 중첩 +config.js 사용
// 12) PocketPages가 알지 못하는 +special 파일명 사용
// 13) next 인자를 받는 middleware가 next()나 response.* 호출 없이 끝나는 패턴
// 14) 상위/하위 경로에 중첩 +load.js 배치
// 15) 허용 범위를 벗어난 raw EJS 출력(<%- ... %>)
// 16) auth helper 사용 시 pocketpages-plugin-auth 누락
// 17) pocketpages-plugin-auth 사용 시 pocketpages-plugin-js-sdk 누락 또는 순서 역전
// 18) _private 내부 .js/.ejs 파일에서 resolve() 사용
// 19) roles/*.js 내부에서 부작용/DB 조회/요청 문맥 접근 사용
// 20) 엔트리에서 resolve('roles/...') 조립이 과도하게 많음
// 21) JS helper/로컬 바인딩에서 params 이름 사용
// 22) JSVM 비허용 문법(async/await/import/export) 사용
// 23) _private/*.js 에서 plain module 대신 factory/function export 사용
// 24) include()에 full context(api/request/response/resolve/params/data) 전달
// 25) 로컬 @typedef 사용
// 26) module.exports.foo = ... 형태의 분산 export 사용
// 27) _private/*.ejs 에서 <script server> 사용
// 28) pages 내부 코드에서 process.env 사용
// 29) pages 밖 pb_hooks 코드에서 PocketPages 전역(env/dbg/info/warn/error) 사용
// 30) _private/*.ejs 에서 $app 기반 DB 접근 사용
// 31) module.exports = { ... } 에서 축약 가능한 foo: foo 사용

const fs = require('fs')
const path = require('path')

const ROOT_DIR = path.resolve(__dirname, '..')
const APPS_DIR = path.join(ROOT_DIR, 'apps')

const ALLOWED_SPECIAL_FILES = new Set([
  '+config.js',
  '+layout.ejs',
  '+load.js',
  '+middleware.js',
  '+get.js',
  '+post.js',
  '+put.js',
  '+patch.js',
  '+delete.js',
])

const RE = {
  resolvePrivate: /resolve\(\s*["']\/?_private\//,
  includePrivate: /include\(\s*["']\/?_private\//,
  recordField: /\brecord\.[A-Za-z_][A-Za-z0-9_]*/,
  recordFieldAllowed:
    /record\.(get|set|email|verified|isSuperuser|collection|publicExport|original|fresh)\s*\(/,
  middlewareUsesResolve: /\bresolve\s*\(/,
  middlewareHasResolveArg:
    /module\.exports\s*=\s*function\s*\(\s*\{[\s\S]*?\bresolve\b[\s\S]*?\}\s*(?:,|\))/,
  fullHtml: /<!DOCTYPE|<html\b|<body\b/,
  responseJson: /\bresponse\.json\s*\(/,
  redirect: /\bredirect\s*\(/,
  manualFlash: /__flash=/,
  middlewareDeclaresNext: /module\.exports\s*=\s*function\s*\([^)]*,\s*next\s*\)/,
  middlewareCallsNext: /(^|[^A-Za-z0-9_])next\s*\(/,
  middlewareUsesResponse: /(^|[^A-Za-z0-9_])response\.[A-Za-z_][A-Za-z0-9_]*\s*\(/,
  rawEjsOutput: /<%-/,
  rawEjsAllowed: /<%-\s*(include\s*\(|slots?\b|content\b|resolve\s*\()/,
  authHelper:
    /\b(signInWithPassword|signOut|requestOAuth2Login|requestOAuth2Link|registerWithPassword|signInWithOtp|signInWithOAuth2|signInAnonymously|signInWithToken)\s*\(/,
  resolveCall: /\bresolve\s*\(/,
  roleSideEffect:
    /\bredirect\s*\(|\bresponse\.[A-Za-z_][A-Za-z0-9_]*\s*\(|\bbody\s*\(|\$app\.(save|saveNoValidate|delete|deleteRecord|deleteRecords|dao)\b/,
  roleDbQuery:
    /\$app\.(findAllRecords|findAuthRecordByToken|findCollectionByNameOrId|findCollectionsByFilter|findFirstRecordByData|findFirstRecordByFilter|findRecordById|findRecordsByExpr|findRecordsByFilter)\b/,
  roleRequestContext: /(^|[^A-Za-z0-9_])(request|params|query)\b|\bresolve\s*\(/,
  roleResolvePath: /resolve\(\s*["']roles\//g,
  asyncKeyword: /\basync\b/,
  awaitKeyword: /\bawait\b/,
  importStatement: /^\s*import\s+/,
  exportStatement: /^\s*export\s+/,
  privateModuleFunctionExport: /module\.exports\s*=\s*function\b/,
  privateModuleFactoryExport: /module\.exports\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/,
  localTypedef: /@typedef\b/,
  distributedModuleExport: /module\.exports\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/,
  scriptServerTag: /<script\b(?=[^>]*\bserver\b)/,
  processEnv: /\bprocess\.env\b/,
  pocketpagesOnlyGlobalCall: /(^|[^.A-Za-z0-9_$])(env|dbg|info|warn|error)\s*\(/,
  privateEjsDbAccess:
    /\$app\.(findAllRecords|findAuthRecordByToken|findCollectionByNameOrId|findCollectionsByFilter|findFirstRecordByData|findFirstRecordByFilter|findRecordById|findRecordsByExpr|findRecordsByFilter|save|saveNoValidate|delete|deleteRecord|deleteRecords|dao|recordQuery|collectionQuery|runInTransaction|auxRunInTransaction)\b/,
}

let errors = 0
let warnings = 0

function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`
  }

  return value
}

function toDisplayPath(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/')

  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(resolved)) {
    return `/${resolved[0].toLowerCase()}${resolved.slice(2)}`
  }

  return resolved
}

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join('/')
}

function isWithin(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return []
  }

  const results = []
  const queue = [rootDir]

  while (queue.length > 0) {
    const currentDir = queue.pop()
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }

      if (entry.isFile()) {
        results.push(fullPath)
      }
    }
  }

  return results.sort((left, right) => left.localeCompare(right))
}

function collectServiceDirs(serviceArg) {
  if (serviceArg) {
    return [path.resolve(fromMsysPath(serviceArg))]
  }

  if (!fs.existsSync(APPS_DIR)) {
    return []
  }

  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(APPS_DIR, entry.name))
    .filter((serviceDir) => fs.existsSync(path.join(serviceDir, 'pb_hooks')))
    .sort((left, right) => left.localeCompare(right))
}

function buildFileInfo(filePath, hooksRoot, pagesRoot) {
  const isCode = /\.(js|ejs)$/.test(filePath)
  const inPages = isWithin(filePath, pagesRoot)
  const info = {
    absPath: filePath,
    displayPath: toDisplayPath(filePath),
    basename: path.basename(filePath),
    isCode,
    isEjs: filePath.endsWith('.ejs'),
    relFromHooks: relativePosix(hooksRoot, filePath),
    inPages,
    relFromPages: inPages ? relativePosix(pagesRoot, filePath) : '',
    content: '',
    lines: [],
  }

  if (isCode) {
    info.content = fs.readFileSync(filePath, 'utf8')
    info.lines = info.content.split(/\r?\n/)
  }

  return info
}

function buildServiceContext(serviceDir) {
  const hooksRoot = path.join(serviceDir, 'pb_hooks')
  const pagesRoot = path.join(hooksRoot, 'pages')
  const configFile = path.join(pagesRoot, '+config.js')
  const files = walkFiles(hooksRoot).map((filePath) => buildFileInfo(filePath, hooksRoot, pagesRoot))

  const hooksCodeFiles = files.filter((file) => file.isCode)
  const pagesFiles = files.filter((file) => file.inPages)
  const pagesCodeFiles = pagesFiles.filter((file) => file.isCode)
  const pagesEjsFiles = pagesFiles.filter((file) => file.isEjs)

  return {
    serviceDir,
    serviceName: path.basename(serviceDir),
    hooksRoot,
    pagesRoot,
    configFile,
    configFileInfo: pagesCodeFiles.find((file) => file.absPath === configFile) || null,
    hooksCodeFiles,
    nonPagesHooksCodeFiles: hooksCodeFiles.filter((file) => !file.inPages),
    pagesFiles,
    pagesCodeFiles,
    lintCodeFiles: pagesCodeFiles.filter((file) => !file.relFromPages.startsWith('assets/')),
    pagesEjsFiles: pagesEjsFiles.filter((file) => !file.relFromPages.startsWith('assets/')),
    privateCodeFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('_private/')),
    roleFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('_private/roles/') && file.basename.endsWith('.js')),
    entryCodeFiles: pagesCodeFiles.filter(
      (file) => !file.relFromPages.startsWith('_private/') && !file.relFromPages.startsWith('assets/'),
    ),
    apiFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('api/')),
    xapiFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('xapi/')),
    middlewareFiles: pagesCodeFiles.filter((file) => file.basename === '+middleware.js'),
    loadFiles: pagesCodeFiles.filter((file) => file.basename === '+load.js'),
    configFiles: pagesCodeFiles.filter((file) => file.basename === '+config.js'),
    specialPlusFiles: pagesCodeFiles.filter((file) => file.basename.startsWith('+')),
  }
}

function printMatches(serviceName, title, matches) {
  if (matches.length === 0) {
    return
  }

  errors += matches.length
  console.log()
  console.log(`[FAIL][${serviceName}] ${title}`)
  for (const match of matches) {
    console.log(`  ${match}`)
  }
}

function printWarnings(serviceName, title, matches) {
  if (matches.length === 0) {
    return
  }

  warnings += matches.length
  console.log()
  console.log(`[WARN][${serviceName}] ${title}`)
  for (const match of matches) {
    console.log(`  ${match}`)
  }
}

function collectLineMatches(files, regex) {
  const matches = []

  for (const file of files) {
    for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex += 1) {
      const line = file.lines[lineIndex]
      regex.lastIndex = 0
      if (regex.test(line)) {
        matches.push(`${file.displayPath}:${lineIndex + 1}:${line}`)
      }
    }
  }

  return matches
}

function filterLinesExcluding(lines, regex) {
  return lines.filter((line) => {
    regex.lastIndex = 0
    return !regex.test(line)
  })
}

function unique(items) {
  return [...new Set(items)]
}

function pluralizeWord(word) {
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`
  }

  if (/(s|x|z|ch|sh)$/i.test(word)) {
    return `${word}es`
  }

  if (/fe$/i.test(word)) {
    return `${word.slice(0, -2)}ves`
  }

  if (/f$/i.test(word)) {
    return `${word.slice(0, -1)}ves`
  }

  return `${word}s`
}

function inferDtCollectionName(file, schemaCollections) {
  const stem = file.basename.replace(/-dt\.js$/, '')
  const snake = stem.replace(/-/g, '_')
  const candidates = unique([snake, pluralizeWord(snake)])

  for (const candidate of candidates) {
    if (schemaCollections.has(candidate)) {
      return candidate
    }
  }

  return ''
}

function findMatchingBrace(content, openBraceIndex) {
  let depth = 0
  let inString = ''
  let inBlockComment = false
  let escaped = false

  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === inString) {
        inString = ''
      }
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function extractNamedFunctionBody(content, functionName) {
  const pattern = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`)
  const match = pattern.exec(content)
  if (!match) {
    return null
  }

  const functionIndex = match.index
  const openBraceIndex = content.indexOf('{', functionIndex)
  if (openBraceIndex === -1) {
    return null
  }

  const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
  if (closeBraceIndex === -1) {
    return null
  }

  return {
    body: content.slice(openBraceIndex + 1, closeBraceIndex),
    bodyStartIndex: openBraceIndex + 1,
  }
}

function extractExportedFunctionBody(content) {
  const namedToDT = extractNamedFunctionBody(content, 'toDT')
  if (namedToDT) {
    return namedToDT
  }

  const exportIndex = content.indexOf('module.exports')
  if (exportIndex === -1) {
    return null
  }

  const functionIndex = content.indexOf('function', exportIndex)
  if (functionIndex === -1) {
    return null
  }

  const openBraceIndex = content.indexOf('{', functionIndex)
  if (openBraceIndex === -1) {
    return null
  }

  const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
  if (closeBraceIndex === -1) {
    return null
  }

  return {
    body: content.slice(openBraceIndex + 1, closeBraceIndex),
    bodyStartIndex: openBraceIndex + 1,
  }
}

function buildLineDepthInfo(content) {
  const lines = content.split(/\r?\n/)
  const depthBefore = []
  let depth = 0
  let inString = ''
  let inBlockComment = false
  let escaped = false

  for (const line of lines) {
    depthBefore.push(depth)

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      const next = line[index + 1]

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false
          index += 1
        }
        continue
      }

      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }

        if (char === '\\') {
          escaped = true
          continue
        }

        if (char === inString) {
          inString = ''
        }
        continue
      }

      if (char === '/' && next === '*') {
        inBlockComment = true
        index += 1
        continue
      }

      if (char === '/' && next === '/') {
        break
      }

      if (char === '"' || char === "'" || char === '`') {
        inString = char
        continue
      }

      if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
      }
    }
  }

  return { lines, depthBefore }
}

function collectTopLevelConstNames(functionBody) {
  const { lines, depthBefore } = buildLineDepthInfo(functionBody)
  const names = []

  for (let index = 0; index < lines.length; index += 1) {
    if (depthBefore[index] !== 0) {
      continue
    }

    const match = lines[index].match(/^\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/)
    if (match) {
      names.push(match[1])
    }
  }

  return names
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function extractTopLevelReturnObject(functionBody, bodyStartLine) {
  let depth = 0
  let inString = ''
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < functionBody.length; index += 1) {
    const char = functionBody[index]
    const next = functionBody[index + 1]

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === inString) {
        inString = ''
      }
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < functionBody.length && functionBody[index] !== '\n') {
        index += 1
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      continue
    }

    if (
      depth === 0 &&
      functionBody.startsWith('return', index) &&
      !/[A-Za-z0-9_$]/.test(functionBody[index - 1] || '') &&
      !/[A-Za-z0-9_$]/.test(functionBody[index + 6] || '')
    ) {
      let cursor = index + 6
      while (/\s/.test(functionBody[cursor] || '')) {
        cursor += 1
      }

      if (functionBody[cursor] !== '{') {
        continue
      }

      const closeBraceIndex = findMatchingBrace(functionBody, cursor)
      if (closeBraceIndex === -1) {
        return null
      }

      return {
        body: functionBody.slice(cursor + 1, closeBraceIndex),
        startLine: bodyStartLine + lineNumberAt(functionBody, cursor + 1) - 1,
      }
    }
  }

  return null
}

function extractModuleExportsObjects(content) {
  const matches = []
  const pattern = /module\.exports\s*=\s*\{/g

  let match = pattern.exec(content)
  while (match) {
    const openBraceIndex = content.indexOf('{', match.index)
    if (openBraceIndex === -1) {
      break
    }

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) {
      break
    }

    matches.push({
      body: content.slice(openBraceIndex + 1, closeBraceIndex),
      startLine: lineNumberAt(content, openBraceIndex + 1),
    })

    pattern.lastIndex = closeBraceIndex + 1
    match = pattern.exec(content)
  }

  return matches
}

function collectPathMatches(files, predicate) {
  return files.filter(predicate).map((file) => file.displayPath)
}

function collectReservedParamsBindingMatches(files) {
  const matches = []
  const patterns = [
    /\bfunction(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(\s*params\s*(?:[,)=])/g,
    /\(\s*params\s*\)\s*=>/g,
    /\bparams\s*=>/g,
    /\b(?:const|let|var)\s+params\s*=/g,
  ]

  for (const file of files) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0

      let match = pattern.exec(file.content)
      while (match) {
        const lineNumber = lineNumberAt(file.content, match.index)
        const lineText = file.lines[lineNumber - 1] || ''
        matches.push(`${file.displayPath}:${lineNumber}:${lineText}`)
        match = pattern.exec(file.content)
      }
    }
  }

  return unique(matches)
}

function collectIncludeFullContextMatches(files) {
  const matches = []
  const forbiddenNames = ['api', 'request', 'response', 'resolve', 'params', 'data']

  for (const file of files) {
    const lines = file.lines
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.includes('include(')) {
        continue
      }

      if (forbiddenNames.some((name) => new RegExp(`\\b${name}\\b`).test(line))) {
        matches.push(`${file.displayPath}:${index + 1}:${line}`)
      }
    }
  }

  return unique(matches)
}

function collectModuleExportsShorthandMatches(files) {
  const matches = []
  const shorthandPattern =
    /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\1\s*,?\s*(?:\/\/.*)?$/

  for (const file of files) {
    const exportObjects = extractModuleExportsObjects(file.content)

    for (const exportObject of exportObjects) {
      const lineInfo = buildLineDepthInfo(exportObject.body)

      for (let index = 0; index < lineInfo.lines.length; index += 1) {
        if (lineInfo.depthBefore[index] !== 0) {
          continue
        }

        const line = lineInfo.lines[index]
        if (!shorthandPattern.test(line)) {
          continue
        }

        matches.push(`${file.displayPath}:${exportObject.startLine + index}:${line}`)
      }
    }
  }

  return unique(matches)
}

function lintService(context) {
  console.log(`Checking service: ${context.serviceName}`)

  const resolvePrivateMatches = collectLineMatches(context.lintCodeFiles, RE.resolvePrivate)
  printMatches(
    context.serviceName,
    "Invalid resolve() path. Use names relative to _private, for example resolve('board-service').",
    resolvePrivateMatches,
  )

  const includePrivateMatches = collectLineMatches(context.pagesCodeFiles, RE.includePrivate)
  printMatches(
    context.serviceName,
    'Invalid include() path. Keep include paths relative to the current PocketPages include rules.',
    includePrivateMatches,
  )

  const rawRecordFieldMatches = collectLineMatches(context.lintCodeFiles, RE.recordField)
  const recordFieldMatches = filterLinesExcluding(rawRecordFieldMatches, RE.recordFieldAllowed)
  printMatches(
    context.serviceName,
    "Invalid direct Record field access. Read PocketBase fields with record.get('fieldName').",
    recordFieldMatches,
  )

  const middlewareResolveMatches = context.middlewareFiles
    .filter((file) => {
      RE.middlewareUsesResolve.lastIndex = 0
      RE.middlewareHasResolveArg.lastIndex = 0
      return RE.middlewareUsesResolve.test(file.content) && !RE.middlewareHasResolveArg.test(file.content)
    })
    .map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    'Invalid middleware resolve() usage. Read resolve from middleware function arguments.',
    middlewareResolveMatches,
  )

  const apiLayoutMatches = collectPathMatches(
    context.pagesFiles,
    (file) => /^(api|xapi)(\/.*)?\/\+layout\.ejs$/.test(file.relFromPages),
  )
  printMatches(
    context.serviceName,
    'Invalid layout placement. Keep +layout.ejs in routable page sections, not under api/ or xapi/.',
    apiLayoutMatches,
  )

  const xapiFullHtmlMatches = collectLineMatches(context.xapiFiles, RE.fullHtml)
  printMatches(
    context.serviceName,
    'Invalid xapi response shape. Return fragments or raw responses from xapi/, not full HTML documents.',
    xapiFullHtmlMatches,
  )

  const privateSpecialFileMatches = collectPathMatches(
    context.pagesFiles,
    (file) =>
      /_private\/.*\/\+(layout|config|load|middleware|get|post|put|patch|delete)\.(ejs|js)$/.test(
        file.relFromPages,
      ),
  )
  printMatches(
    context.serviceName,
    'Invalid _private file placement. Keep PocketPages special route/config files outside _private.',
    privateSpecialFileMatches,
  )

  const privateResolveMatches = collectLineMatches(context.privateCodeFiles, RE.resolveCall)
  printMatches(
    context.serviceName,
    'Invalid _private resolve() usage. Resolve dependencies only from request entry files such as EJS, <script server>, loaders, and middleware.',
    privateResolveMatches,
  )

  const reservedParamsBindingMatches = collectReservedParamsBindingMatches(context.lintCodeFiles)
  printMatches(
    context.serviceName,
    'Invalid JS params binding. Reserve "params" for route context only and rename helper inputs or locals to payload, input, summaryInput, or another contextual name.',
    reservedParamsBindingMatches,
  )

  const asyncMatches = unique([
    ...collectLineMatches(context.lintCodeFiles, RE.asyncKeyword),
    ...collectLineMatches(context.lintCodeFiles, RE.awaitKeyword),
  ])
  printMatches(
    context.serviceName,
    'Invalid JSVM async syntax. Keep PocketBase JSVM code synchronous and do not use async/await.',
    asyncMatches,
  )

  const esmMatches = unique([
    ...collectLineMatches(context.lintCodeFiles, RE.importStatement),
    ...collectLineMatches(context.lintCodeFiles, RE.exportStatement),
  ])
  printMatches(
    context.serviceName,
    'Invalid JSVM module syntax. Use CommonJS require()/module.exports instead of import/export.',
    esmMatches,
  )

  const privateModulePatternWarnings = unique([
    ...collectLineMatches(context.privateCodeFiles.filter((file) => file.basename.endsWith('.js')), RE.privateModuleFunctionExport),
    ...collectLineMatches(context.privateCodeFiles.filter((file) => file.basename.endsWith('.js')), RE.privateModuleFactoryExport),
  ])
  printWarnings(
    context.serviceName,
    'Prefer plain _private modules. Default to module.exports = { ... } and avoid function/factory exports unless there is a clear structural reason.',
    privateModulePatternWarnings,
  )

  const distributedModuleExportWarnings = collectLineMatches(
    context.privateCodeFiles.filter((file) => file.basename.endsWith('.js')),
    RE.distributedModuleExport,
  )
  printWarnings(
    context.serviceName,
    'Prefer plain module exports. Group public members in one module.exports = { ... } object instead of scattered module.exports.foo assignments.',
    distributedModuleExportWarnings,
  )

  const moduleExportsShorthandMatches = collectModuleExportsShorthandMatches(
    context.hooksCodeFiles.filter((file) => file.basename.endsWith('.js')),
  )
  printMatches(
    context.serviceName,
    'Invalid module.exports object style. Use shorthand members such as { sentCount } instead of repeating sentCount: sentCount in exported objects.',
    moduleExportsShorthandMatches,
  )

  const privateScriptServerMatches = collectLineMatches(
    context.pagesEjsFiles.filter((file) => file.relFromPages.startsWith('_private/')),
    RE.scriptServerTag,
  )
  printMatches(
    context.serviceName,
    'Invalid _private <script server> usage. Keep _private partial setup in top-level <% ... %> blocks and reserve <script server> for entry EJS files.',
    privateScriptServerMatches,
  )

  const privateEjsDbAccessMatches = collectLineMatches(
    context.pagesEjsFiles.filter((file) => file.relFromPages.startsWith('_private/')),
    RE.privateEjsDbAccess,
  )
  printMatches(
    context.serviceName,
    'Invalid _private EJS DB access. Keep _private partials render-only and move PocketBase queries or writes to the entry EJS <script server> block or a nearby _private/*.js module.',
    privateEjsDbAccessMatches,
  )

  const pagesProcessEnvMatches = collectLineMatches(context.lintCodeFiles, RE.processEnv)
  printMatches(
    context.serviceName,
    'Invalid process.env usage in PocketPages pages code. Use env(...) inside pb_hooks/pages files.',
    pagesProcessEnvMatches,
  )

  const nonPagesPocketPagesGlobalMatches = collectLineMatches(
    context.nonPagesHooksCodeFiles,
    RE.pocketpagesOnlyGlobalCall,
  )
  printMatches(
    context.serviceName,
    'Invalid PocketPages global usage outside pb_hooks/pages. Do not use env(...), dbg(...), info(...), warn(...), or error(...) in non-pages pb_hooks code.',
    nonPagesPocketPagesGlobalMatches,
  )

  const includeFullContextMatches = collectIncludeFullContextMatches(context.pagesEjsFiles)
  printMatches(
    context.serviceName,
    'Invalid include() locals. Pass only the values the partial needs instead of api/request/response/resolve/params/data.',
    includeFullContextMatches,
  )

  const localTypedefMatches = collectLineMatches(context.lintCodeFiles, RE.localTypedef)
  printMatches(
    context.serviceName,
    'Invalid local @typedef usage. Move named shapes to apps/<service>/types.d.ts and reference them as types.*.',
    localTypedefMatches,
  )

  const roleSideEffectMatches = collectLineMatches(context.roleFiles, RE.roleSideEffect)
  printMatches(
    context.serviceName,
    'Invalid role side effect. Keep roles/*.js pure and move redirect/response/body/save/delete work to entry or service code.',
    roleSideEffectMatches,
  )

  const roleDbQueryMatches = collectLineMatches(context.roleFiles, RE.roleDbQuery)
  printMatches(
    context.serviceName,
    'Invalid role DB lookup. Fetch records in entry or service code and pass them into the role.',
    roleDbQueryMatches,
  )

  const roleRequestContextMatches = collectLineMatches(context.roleFiles, RE.roleRequestContext)
  printMatches(
    context.serviceName,
    'Invalid role request-context access. Do not use request, params, query, or resolve() inside roles/*.js.',
    roleRequestContextMatches,
  )

  const xapiJsonMatches = collectLineMatches(context.xapiFiles, RE.responseJson)
  printMatches(
    context.serviceName,
    'Invalid xapi JSON response. Move JSON endpoints under api/ and keep xapi/ for fragments or raw responses.',
    xapiJsonMatches,
  )

  const apiRedirectMatches = collectLineMatches(context.apiFiles, RE.redirect)
  printMatches(
    context.serviceName,
    'Invalid api redirect. Keep api/ for programmatic responses and move redirect flows to page or xapi code.',
    apiRedirectMatches,
  )

  const manualFlashMatches = collectLineMatches(context.pagesCodeFiles, RE.manualFlash)
  printMatches(
    context.serviceName,
    'Invalid flash handling. Use redirect(path, { message }) instead of manually building ?__flash=....',
    manualFlashMatches,
  )

  const nestedConfigMatches = context.configFiles
    .filter((file) => file.absPath !== context.configFile)
    .map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    'Invalid +config.js placement. Keep a single +config.js at pb_hooks/pages/+config.js.',
    nestedConfigMatches,
  )

  const invalidSpecialPlusFiles = context.specialPlusFiles
    .filter((file) => !ALLOWED_SPECIAL_FILES.has(file.basename))
    .map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    'Invalid +special file name. Only +config.js, +layout.ejs, +load.js, +middleware.js, +get.js, +post.js, +put.js, +patch.js, and +delete.js are allowed.',
    invalidSpecialPlusFiles,
  )

  const middlewareFlowMatches = context.middlewareFiles
    .filter((file) => {
      RE.middlewareDeclaresNext.lastIndex = 0
      RE.middlewareCallsNext.lastIndex = 0
      RE.middlewareUsesResponse.lastIndex = 0
      return (
        RE.middlewareDeclaresNext.test(file.content) &&
        !RE.middlewareCallsNext.test(file.content) &&
        !RE.middlewareUsesResponse.test(file.content)
      )
    })
    .map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    'Invalid middleware control flow. Middleware that declares next must call next() or send a response before returning.',
    middlewareFlowMatches,
  )

  const loadPathSet = new Set(context.loadFiles.map((file) => file.absPath))
  const nestedLoadMatches = []
  for (const file of context.loadFiles) {
    let searchDir = path.dirname(path.dirname(file.absPath))

    while (isWithin(searchDir, context.pagesRoot)) {
      const ancestorLoad = path.join(searchDir, '+load.js')
      if (loadPathSet.has(ancestorLoad)) {
        nestedLoadMatches.push(`${file.displayPath} (ancestor: ${toDisplayPath(ancestorLoad)})`)
        break
      }

      if (path.resolve(searchDir) === path.resolve(context.pagesRoot)) {
        break
      }

      const nextDir = path.dirname(searchDir)
      if (nextDir === searchDir) {
        break
      }
      searchDir = nextDir
    }
  }
  printMatches(
    context.serviceName,
    'Invalid nested +load.js layout. PocketPages executes only the leaf +load.js, so shared loading belongs in middleware.',
    nestedLoadMatches,
  )

  const rawEjsOutputMatches = collectLineMatches(context.pagesEjsFiles, RE.rawEjsOutput)
  const disallowedRawEjsMatches = filterLinesExcluding(rawEjsOutputMatches, RE.rawEjsAllowed)
  printMatches(
    context.serviceName,
    'Invalid raw EJS output. Limit <%- ... %> to include(), slot/slots, content, or resolve()-provided safe assets.',
    disallowedRawEjsMatches,
  )

  const compactConfig = context.configFileInfo ? context.configFileInfo.content.replace(/\s+/g, '') : ''
  const authHelperMatches = collectLineMatches(context.pagesCodeFiles, RE.authHelper)
  if (authHelperMatches.length > 0 && !compactConfig.includes('pocketpages-plugin-auth')) {
    printMatches(
      context.serviceName,
      'Invalid auth helper setup. Add pocketpages-plugin-auth to pb_hooks/pages/+config.js before using auth helpers.',
      authHelperMatches,
    )
  }

  const authPluginConfigMatches = []
  if (compactConfig.includes('pocketpages-plugin-auth')) {
    if (!compactConfig.includes('pocketpages-plugin-js-sdk')) {
      authPluginConfigMatches.push(toDisplayPath(context.configFile))
    } else {
      const authIndex = compactConfig.indexOf('pocketpages-plugin-auth')
      const sdkIndex = compactConfig.indexOf('pocketpages-plugin-js-sdk')
      if (sdkIndex > authIndex) {
        authPluginConfigMatches.push(toDisplayPath(context.configFile))
      }
    }
  }
  printMatches(
    context.serviceName,
    'Invalid auth plugin order. List pocketpages-plugin-js-sdk before pocketpages-plugin-auth in +config.js.',
    authPluginConfigMatches,
  )

  const excessiveRoleResolveMatches = context.entryCodeFiles
    .map((file) => {
      const matches = file.content.match(RE.roleResolvePath)
      const count = matches ? matches.length : 0
      if (count <= 10) {
        return ''
      }

      return `${file.displayPath}: found ${count} role resolve() calls; keep direct resolve by default, and move only repeated shared wiring into a nearby plain _private module`
    })
    .filter(Boolean)
  printWarnings(
    context.serviceName,
    "Heavy role composition in one entry. Keep direct resolve by default, and move only repeated shared wiring into a nearby plain _private module when it is reused.",
    excessiveRoleResolveMatches,
  )
}

function main() {
  console.log('Running PocketPages self-validation checks...')

  const serviceArg = process.argv[2]
  const serviceDirs = collectServiceDirs(serviceArg)

  if (serviceDirs.length === 0) {
    console.log('No services found.')
    process.exit(0)
  }

  for (const serviceDir of serviceDirs) {
    lintService(buildServiceContext(serviceDir))
  }

  if (errors > 0) {
    console.log()
    console.log(`PocketPages lint failed with ${errors} issue(s).`)
    process.exit(1)
  }

  if (warnings > 0) {
    console.log()
    console.log(`PocketPages lint passed with ${warnings} warning(s).`)
    process.exit(0)
  }

  console.log('PocketPages lint passed.')
}

main()
