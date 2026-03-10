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
}

let errors = 0

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
    pagesFiles,
    pagesCodeFiles,
    pagesEjsFiles,
    privateCodeFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('_private/')),
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

function collectPathMatches(files, predicate) {
  return files.filter(predicate).map((file) => file.displayPath)
}

function lintService(context) {
  console.log(`Checking service: ${context.serviceName}`)

  const resolvePrivateMatches = collectLineMatches(context.hooksCodeFiles, RE.resolvePrivate)
  printMatches(
    context.serviceName,
    "Do not call resolve() with /_private paths. Use names relative to _private, e.g. resolve('board-service').",
    resolvePrivateMatches,
  )

  const includePrivateMatches = collectLineMatches(context.pagesCodeFiles, RE.includePrivate)
  printMatches(
    context.serviceName,
    'Do not call include() with /_private paths. Keep include paths relative to the current PocketPages include rules.',
    includePrivateMatches,
  )

  const rawRecordFieldMatches = collectLineMatches(context.hooksCodeFiles, RE.recordField)
  const recordFieldMatches = filterLinesExcluding(rawRecordFieldMatches, RE.recordFieldAllowed)
  printMatches(
    context.serviceName,
    "Avoid record.fieldName direct access in EJS. Prefer record.get('fieldName').",
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
    'Middleware must use resolve from function arguments, not a global resolve() call.',
    middlewareResolveMatches,
  )

  const apiLayoutMatches = collectPathMatches(
    context.pagesFiles,
    (file) => /^(api|xapi)(\/.*)?\/\+layout\.ejs$/.test(file.relFromPages),
  )
  printMatches(context.serviceName, 'api/xapi routes must not define +layout.ejs files.', apiLayoutMatches)

  const xapiFullHtmlMatches = collectLineMatches(context.xapiFiles, RE.fullHtml)
  printMatches(
    context.serviceName,
    'xapi endpoints should return fragments or raw responses, not full HTML documents.',
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
    '_private must not contain PocketPages special route/config files.',
    privateSpecialFileMatches,
  )

  const privateResolveMatches = collectLineMatches(context.privateCodeFiles, RE.resolveCall)
  printMatches(
    context.serviceName,
    '_private .js/.ejs files must not call resolve(). Resolve dependencies only from request entry files such as EJS, <script server>, loaders, and middleware.',
    privateResolveMatches,
  )

  const xapiJsonMatches = collectLineMatches(context.xapiFiles, RE.responseJson)
  printMatches(
    context.serviceName,
    'xapi endpoints should return fragments/raw responses, not response.json(...). Move JSON endpoints under api/.',
    xapiJsonMatches,
  )

  const apiRedirectMatches = collectLineMatches(context.apiFiles, RE.redirect)
  printMatches(
    context.serviceName,
    'api endpoints should return programmatic responses, not redirect(...).',
    apiRedirectMatches,
  )

  const manualFlashMatches = collectLineMatches(context.pagesCodeFiles, RE.manualFlash)
  printMatches(
    context.serviceName,
    'Do not manually build ?__flash=... query strings. Use redirect(path, { message }).',
    manualFlashMatches,
  )

  const nestedConfigMatches = context.configFiles
    .filter((file) => file.absPath !== context.configFile)
    .map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    '+config.js must live only at pb_hooks/pages/+config.js, not nested route directories.',
    nestedConfigMatches,
  )

  const invalidSpecialPlusFiles = context.specialPlusFiles
    .filter((file) => !ALLOWED_SPECIAL_FILES.has(file.basename))
    .map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    'Unknown +special file name detected. Only +config.js, +layout.ejs, +load.js, +middleware.js, +get.js, +post.js, +put.js, +patch.js, +delete.js are allowed.',
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
    'Middleware that declares next must either call next() or send a response via response.* before returning.',
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
    'Avoid stacking parent/child +load.js files. PocketPages executes only the leaf +load.js; shared loading belongs in middleware.',
    nestedLoadMatches,
  )

  const rawEjsOutputMatches = collectLineMatches(context.pagesEjsFiles, RE.rawEjsOutput)
  const disallowedRawEjsMatches = filterLinesExcluding(rawEjsOutputMatches, RE.rawEjsAllowed)
  printMatches(
    context.serviceName,
    'Raw EJS output (<%- ... %>) should be limited to include(), slot/slots, content, or resolve()-provided safe assets.',
    disallowedRawEjsMatches,
  )

  const compactConfig = context.configFileInfo ? context.configFileInfo.content.replace(/\s+/g, '') : ''
  const authHelperMatches = collectLineMatches(context.pagesCodeFiles, RE.authHelper)
  if (authHelperMatches.length > 0 && !compactConfig.includes('pocketpages-plugin-auth')) {
    printMatches(
      context.serviceName,
      'Auth helpers require pocketpages-plugin-auth in pb_hooks/pages/+config.js.',
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
    'pocketpages-plugin-auth requires pocketpages-plugin-js-sdk to be explicitly listed before it in +config.js.',
    authPluginConfigMatches,
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

  console.log('PocketPages lint passed.')
}

main()
