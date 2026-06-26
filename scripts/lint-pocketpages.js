#!/usr/bin/env node
'use strict'

// PocketPages lint rules:
// 1) resolve('/_private/...') 같이 _private 기준 규칙에 어긋나는 resolve 사용
// 2) include('/_private/...') 같이 _private 절대 경로 include 사용
// 3) EJS/JS에서 PocketBase Record field 직접 접근
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
// 22) _private/*.js 에서 plain module 대신 factory/function export 사용
// 23) include()에 full context(api/request/response/resolve/params/data) 전달
// 24) 로컬 @typedef 사용
// 25) module.exports.foo = ... 형태의 분산 export 사용
// 26) _private/*.ejs 에서 <script server> 사용
// 27) pages 내부 코드에서 process.env 사용
// 28) pages 밖 pb_hooks 코드에서 PocketPages 전역(env/dbg/info/warn/error) 사용
// 29) _private/*.ejs 에서 $app 기반 DB 접근 사용
// 30) module.exports = { ... } 에서 축약 가능한 foo: foo 사용
// 31) pb_hooks/pages 아래에 *.pb.js 파일 배치
// 32) pages 일반 .js(static js) 안에 서버 코드 사용
// 33) runInTransaction 콜백 안에서 바깥 $app 사용
// 34) pb_hooks/pages 안에서 PocketBase hook 등록 API 사용
// 35) api 엔드포인트에서 HTML 응답 반환
// 36) resolve/include/asset/route 경로가 실제로 없는 정적 경로
// 37) 존재하지 않는 PocketBase collection 문자열 사용
// 38) 존재하지 않는 PocketBase Record field 문자열 사용
// 39) params를 query처럼 읽는 패턴
// 40) redirect() 뒤 return 누락
// 41) +config.js plugin이 package.json 직접 의존성에 없는 경우
// 42) 서버 코드에서 async/await/Promise/.then() 사용
// 43) redirect option에서 flash 사용
// 44) Datastar attribute key에 camelCase 사용
// 45) pages 밖 pb_hooks 코드에서 PocketPages Datastar request helper 사용
// 46) pages 안에서 PocketBase backend Datastar realtime utility 사용
// 47) pages 밖 pb_hooks 코드에서 PocketPages route helper 사용
// 48) 서버 코드에서 JSVM locale API(Intl/toLocale*) 사용
// 49) 서버 코드에서 브라우저/Web API 전역 사용

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { buildTemplateVirtualText } = require('../tools/vscode-pocketpages/packages/language-core/ejs-template')
const { collectPathContexts, collectSchemaContexts } = require('../tools/vscode-pocketpages/packages/language-core/custom-context')
const { extractServerBlocks } = require('../tools/vscode-pocketpages/packages/language-core/script-server')
const { collectParamsFlowDiagnostics } = require('../tools/vscode-pocketpages/packages/language-service/flow-analysis')
const { PocketPagesProjectIndex } = require('../tools/vscode-pocketpages/packages/language-service/project-index')
const { collectRedirectReturnDiagnostics, ts } = require('../tools/vscode-pocketpages/packages/language-service/language-service')

const ROOT_DIR = path.resolve(__dirname, '..')
const APPS_DIR = path.join(ROOT_DIR, 'apps')
const LINT_CACHE_VERSION = 1
const LINT_CACHE_DIR = path.join(ROOT_DIR, '.cache', 'pocketpages-lint')
const LINT_DEPENDENCY_FILES = [
  __filename,
  require.resolve('../tools/vscode-pocketpages/packages/language-core/ejs-template'),
  require.resolve('../tools/vscode-pocketpages/packages/language-core/custom-context'),
  require.resolve('../tools/vscode-pocketpages/packages/language-core/script-server'),
  require.resolve('../tools/vscode-pocketpages/packages/language-service/flow-analysis'),
  require.resolve('../tools/vscode-pocketpages/packages/language-service/project-index'),
  require.resolve('../tools/vscode-pocketpages/packages/language-service/language-service'),
]

const ALLOWED_SPECIAL_FILES = new Set(['+config.js', '+layout.ejs', '+load.js', '+middleware.js', '+get.js', '+post.js', '+put.js', '+patch.js', '+delete.js'])

const JSVM_BROWSER_GLOBALS = new Set([
  'AbortController',
  'Blob',
  'EventSource',
  'File',
  'FormData',
  'TextDecoder',
  'TextEncoder',
  'WebSocket',
  'XMLHttpRequest',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'document',
  'fetch',
  'localStorage',
  'navigator',
  'queueMicrotask',
  'requestAnimationFrame',
  'sessionStorage',
  'setInterval',
  'setTimeout',
  'window',
])

const RE = {
  resolvePrivate: /resolve\(\s*["']\/?_private\//,
  includePrivate: /include\(\s*["']\/?_private\//,
  recordParamTag: /@param\s+\{([^}]*(?:core\.Record|types\.[A-Za-z_$][A-Za-z0-9_$]*Record)[^}]*)\}\s+([A-Za-z_$][A-Za-z0-9_$]*|\[[A-Za-z_$][A-Za-z0-9_$]*(?:=[^\]]*)?\])/g,
  recordFindDeclaration:
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:\$app|[A-Za-z_$][A-Za-z0-9_$]*Service)\.find(?!Records\b|Records[A-Za-z0-9_$])(?:[A-Za-z0-9_$]*Record[A-Za-z0-9_$]*|[A-Za-z0-9_$]*By[A-Za-z0-9_$]*)\s*\(/g,
  recordFindAssignment:
    /(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:\$app|[A-Za-z_$][A-Za-z0-9_$]*Service)\.find(?!Records\b|Records[A-Za-z0-9_$])(?:[A-Za-z0-9_$]*Record[A-Za-z0-9_$]*|[A-Za-z0-9_$]*By[A-Za-z0-9_$]*)\s*\(/g,
  middlewareUsesResolve: /\bresolve\s*\(/,
  middlewareHasResolveArg: /module\.exports\s*=\s*function\s*\(\s*\{[\s\S]*?\bresolve\b[\s\S]*?\}\s*(?:,|\))/,
  fullHtml: /<!DOCTYPE|<html\b|<head\b|<body\b/,
  responseJson: /\bresponse\.json\s*\(/,
  responseHtml: /\bresponse\.html\s*\(/,
  redirect: /\bredirect\s*\(/,
  manualFlash: /__flash=/,
  middlewareDeclaresNext: /module\.exports\s*=\s*function\s*\([^)]*,\s*next\s*\)/,
  middlewareCallsNext: /(^|[^A-Za-z0-9_])next\s*\(/,
  middlewareUsesResponse: /(^|[^A-Za-z0-9_])response\.[A-Za-z_][A-Za-z0-9_]*\s*\(/,
  rawEjsOutput: /<%-/,
  rawEjsAllowed: /<%-\s*(include\s*\(|slots?\b|content\b|resolve\s*\(|datastar\.scripts\s*\()/,
  datastarCamelCaseAttribute: /\bdata-(?:bind|class|computed|on|ref|signals|style):[A-Za-z0-9_-]*[A-Z][A-Za-z0-9_-]*(?=[\s=>])/,
  authHelper: /\b(signInWithPassword|signOut|requestOAuth2Login|requestOAuth2Link|registerWithPassword|signInWithOtp|signInWithOAuth2|signInAnonymously|signInWithToken)\s*\(/,
  resolveCall: /\bresolve\s*\(/,
  roleSideEffect: /\bredirect\s*\(|\bresponse\.[A-Za-z_][A-Za-z0-9_]*\s*\(|\bbody\s*\(|\$app\.(save|saveNoValidate|delete|deleteRecord|deleteRecords|dao)\b/,
  roleDbQuery:
    /\$app\.(findAllRecords|findAuthRecordByToken|findCollectionByNameOrId|findCollectionsByFilter|findFirstRecordByData|findFirstRecordByFilter|findRecordById|findRecordsByExpr|findRecordsByFilter)\b/,
  roleRequestContext: /(^|[^A-Za-z0-9_])(request|params|query)\b|\bresolve\s*\(/,
  roleResolvePath: /resolve\(\s*["']roles\//g,
  privateModuleFunctionExport: /module\.exports\s*=\s*function\b/,
  privateModuleFactoryExport: /module\.exports\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/,
  localTypedef: /@typedef\b/,
  distributedModuleExport: /module\.exports\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/,
  scriptServerTag: /<script\b(?=[^>]*\bserver\b)/,
  processEnv: /\bprocess\.env\b/,
  pocketpagesOnlyGlobalCall: /(^|[^.A-Za-z0-9_$])(env|dbg|info|warn|error)\s*\(/,
  nonPagesDatastarRequestHelper: /(^|[^.A-Za-z0-9_$])datastar\s*\.|(^|[^.A-Za-z0-9_$])api\s*\.\s*datastar\s*\./,
  nonPagesPocketPagesRouteHelper: /(^|[^.A-Za-z0-9_$])(?:redirect|resolve)\s*\(/,
  datastarBackendRealtimeUtility: /\b(createRealtimeSender|buildPatchElementsPayload|buildRemoveElementsPayload|buildPatchSignalsPayload|buildRemoveSignalsPayload)\s*\(/,
  privateEjsDbAccess:
    /\$app\.(findAllRecords|findAuthRecordByToken|findCollectionByNameOrId|findCollectionsByFilter|findFirstRecordByData|findFirstRecordByFilter|findRecordById|findRecordsByExpr|findRecordsByFilter|save|saveNoValidate|delete|deleteRecord|deleteRecords|dao|recordQuery|collectionQuery|runInTransaction|auxRunInTransaction)\b/,
  staticJsServerCode: /\bmodule\.exports\b|\brequire\s*\(|\$app\.|(^|[^A-Za-z0-9_$])(response\.[A-Za-z_][A-Za-z0-9_]*\s*\(|redirect\s*\(|resolve\s*\(|env\s*\()/,
  hookRegistration:
    /(^|[^A-Za-z0-9_$])(routerAdd|routerUse|cronAdd|onBootstrap|onServe|onTerminate|onRecord[A-Za-z0-9_]*|onSettings[A-Za-z0-9_]*|onMailer[A-Za-z0-9_]*|onRealtime[A-Za-z0-9_]*|onBackup[A-Za-z0-9_]*)\s*\(/,
  outerAppInsideTransaction: /\$app\./,
  asyncFlow: /\basync\b|\bawait\b|\bPromise\b|\.then\s*\(/g,
  localeApi: /\bIntl\b|\.\s*toLocale(?:String|DateString|TimeString)\s*\(/g,
  redirectCall: /\bredirect\s*\(/g,
  redirectFlashOption: /[,{]\s*flash\s*:/,
}

const TRANSACTION_CALLBACK_PATTERNS = [
  /\$app\.(?:runInTransaction|auxRunInTransaction)\s*\(\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*=>\s*\{/g,
  /\$app\.(?:runInTransaction|auxRunInTransaction)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{/g,
  /\$app\.(?:runInTransaction|auxRunInTransaction)\s*\(\s*function\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{/g,
]

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
    const entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))

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
  const relFromPages = inPages ? relativePosix(pagesRoot, filePath) : ''
  const info = {
    absPath: filePath,
    displayPath: toDisplayPath(filePath),
    basename: path.basename(filePath),
    isCode,
    isEjs: filePath.endsWith('.ejs'),
    relFromHooks: relativePosix(hooksRoot, filePath),
    inPages,
    relFromPages,
    inVendor: inPages && relFromPages.split('/').includes('vendor'),
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
  const packageFile = path.join(serviceDir, 'package.json')
  const projectIndex = new PocketPagesProjectIndex(serviceDir)
  const files = walkFiles(hooksRoot).map((filePath) => buildFileInfo(filePath, hooksRoot, pagesRoot))

  const hooksCodeFiles = files.filter((file) => file.isCode && !file.inVendor)
  const pagesFiles = files.filter((file) => file.inPages && !file.inVendor)
  const pagesCodeFiles = pagesFiles.filter((file) => file.isCode)
  const pagesEjsFiles = pagesFiles.filter((file) => file.isEjs)

  return {
    serviceDir,
    serviceName: path.basename(serviceDir),
    hooksRoot,
    pagesRoot,
    packageFile,
    projectIndex,
    collectionMethodNames: projectIndex.getCollectionMethodNames(),
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
    entryCodeFiles: pagesCodeFiles.filter((file) => !file.relFromPages.startsWith('_private/') && !file.relFromPages.startsWith('assets/')),
    apiFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('api/')),
    xapiFiles: pagesCodeFiles.filter((file) => file.relFromPages.startsWith('xapi/')),
    middlewareFiles: pagesCodeFiles.filter((file) => file.basename === '+middleware.js'),
    loadFiles: pagesCodeFiles.filter((file) => file.basename === '+load.js'),
    configFiles: pagesCodeFiles.filter((file) => file.basename === '+config.js'),
    specialPlusFiles: pagesCodeFiles.filter((file) => file.basename.startsWith('+')),
  }
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_error) {
    return null
  }
}

function getLintCacheFile(serviceDir) {
  const serviceName = path.basename(serviceDir).replace(/[^A-Za-z0-9_.-]/g, '_')
  return path.join(LINT_CACHE_DIR, `${serviceName}.json`)
}

function collectLintCacheFiles(serviceDir) {
  const hooksRoot = path.join(serviceDir, 'pb_hooks')
  const candidates = [...walkFiles(hooksRoot), path.join(serviceDir, 'pb_schema.json'), path.join(serviceDir, 'package.json'), ...LINT_DEPENDENCY_FILES]

  return unique(candidates.map((filePath) => path.resolve(filePath))).filter((filePath) => {
    try {
      return fs.statSync(filePath).isFile()
    } catch (_error) {
      return false
    }
  })
}

function createLintFingerprint(serviceDir) {
  const hash = crypto.createHash('sha256')
  hash.update(`pocketpages-lint:${LINT_CACHE_VERSION}\n`)

  const files = collectLintCacheFiles(serviceDir).sort((left, right) => left.localeCompare(right))

  for (const filePath of files) {
    const stat = fs.statSync(filePath)
    const relativePath = relativePosix(ROOT_DIR, filePath)
    hash.update(`${relativePath}\0${stat.size}\0${stat.mtimeMs}\n`)
  }

  return hash.digest('hex')
}

function readLintCache(serviceDir) {
  const cacheFile = getLintCacheFile(serviceDir)

  if (!fs.existsSync(cacheFile)) {
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch (_error) {
    return null
  }
}

function writeLintCache(serviceDir, fingerprint, warningCount) {
  fs.mkdirSync(LINT_CACHE_DIR, { recursive: true })
  fs.writeFileSync(
    getLintCacheFile(serviceDir),
    JSON.stringify(
      {
        version: LINT_CACHE_VERSION,
        fingerprint,
        status: 'passed',
        warnings: warningCount,
      },
      null,
      2
    )
  )
}

function getValidLintCache(serviceDir, fingerprint) {
  const cache = readLintCache(serviceDir)

  if (!cache || cache.version !== LINT_CACHE_VERSION || cache.status !== 'passed' || cache.fingerprint !== fingerprint) {
    return null
  }

  return cache
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

const RECORD_ACCESS_ALLOWED_METHODS = new Set(['get', 'set', 'collection', 'publicExport', 'original', 'fresh', 'isSuperuser', 'baseFilesPath'])

const RECORD_FIELD_ACCESS_RE = /(^|[^.$A-Za-z0-9_])([A-Za-z_$][A-Za-z0-9_$]*)(\?\.|\.)([A-Za-z_$][A-Za-z0-9_$]*)/g

function isRecordLikeName(name) {
  return name === 'record' || /Record$/.test(name)
}

function normalizeJSDocParamName(rawName) {
  return String(rawName || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('=')[0]
    .split('.')[0]
    .trim()
}

function collectRecordVariableNames(content) {
  const names = new Set(['record'])
  RE.recordParamTag.lastIndex = 0
  let match = RE.recordParamTag.exec(content)

  while (match) {
    const typeText = String(match[1] || '')
    const name = normalizeJSDocParamName(match[2])

    if (name && !/\[\]|\bArray\s*</.test(typeText)) {
      names.add(name)
    }

    match = RE.recordParamTag.exec(content)
  }

  RE.recordFindDeclaration.lastIndex = 0
  match = RE.recordFindDeclaration.exec(content)
  while (match) {
    names.add(match[1])
    match = RE.recordFindDeclaration.exec(content)
  }

  RE.recordFindAssignment.lastIndex = 0
  match = RE.recordFindAssignment.exec(content)
  while (match) {
    names.add(match[2])
    match = RE.recordFindAssignment.exec(content)
  }

  return names
}

function collectDirectRecordFieldMatches(files) {
  const matches = []

  for (const file of files) {
    const recordVariableNames = collectRecordVariableNames(file.content)

    for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex += 1) {
      const line = file.lines[lineIndex]
      let match = RECORD_FIELD_ACCESS_RE.exec(line)

      while (match) {
        const receiverName = match[2]
        const propertyName = match[4]
        const prefix = match[1]

        if (!/['"`]$/.test(prefix) && (recordVariableNames.has(receiverName) || isRecordLikeName(receiverName)) && !RECORD_ACCESS_ALLOWED_METHODS.has(propertyName)) {
          matches.push(`${file.displayPath}:${lineIndex + 1}:${line}`)
          break
        }

        match = RECORD_FIELD_ACCESS_RE.exec(line)
      }

      RECORD_FIELD_ACCESS_RE.lastIndex = 0
    }
  }

  return unique(matches)
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

function findMatchingParen(content, openParenIndex) {
  let depth = 0
  let inString = ''
  let inBlockComment = false
  let escaped = false

  for (let index = openParenIndex; index < content.length; index += 1) {
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

    if (char === '(') {
      depth += 1
      continue
    }

    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
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

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length
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
  const patterns = [/\bfunction(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(\s*params\s*(?:[,)=])/g, /\(\s*params\s*\)\s*=>/g, /\bparams\s*=>/g, /\b(?:const|let|var)\s+params\s*=/g]

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
  const forbiddenNamePattern = forbiddenNames.join('|')
  const directArgumentPattern = new RegExp(`,\\s*(?:${forbiddenNamePattern})\\s*(?:,|\\))`)
  const shorthandPropertyPattern = new RegExp(`[{,]\\s*(?:${forbiddenNamePattern})\\s*(?:,|})`)
  const fullContextValuePattern = new RegExp(`[{,]\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*:\\s*(?:${forbiddenNamePattern})\\s*(?:,|})`)

  for (const file of files) {
    const includeCallPattern = /\binclude\s*\(/g
    let match = includeCallPattern.exec(file.content)

    while (match) {
      const openParenIndex = file.content.indexOf('(', match.index)
      const closeParenIndex = findMatchingParen(file.content, openParenIndex)
      if (closeParenIndex === -1) {
        break
      }

      const callText = maskStringsAndComments(file.content.slice(match.index, closeParenIndex + 1))
      if (directArgumentPattern.test(callText) || shorthandPropertyPattern.test(callText) || fullContextValuePattern.test(callText)) {
        matches.push(formatLintLineMatch(file, lineNumberAt(file.content, match.index)))
      }

      includeCallPattern.lastIndex = closeParenIndex + 1
      match = includeCallPattern.exec(file.content)
    }
  }

  return unique(matches)
}

function maskStringsAndComments(content) {
  let result = ''
  let inString = ''
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        result += '  '
        inBlockComment = false
        index += 1
      } else {
        result += char === '\n' ? '\n' : ' '
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
        result += char === '\n' ? '\n' : ' '
        continue
      }

      if (char === '\\') {
        escaped = true
        result += ' '
        continue
      }

      if (char === inString) {
        inString = ''
      }

      result += char === '\n' ? '\n' : ' '
      continue
    }

    if (char === '/' && next === '*') {
      result += '  '
      inBlockComment = true
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        result += ' '
        index += 1
      }
      if (index < content.length) {
        result += '\n'
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char
      result += ' '
      continue
    }

    result += char
  }

  return result
}

function collectDatastarCamelCaseAttributeMatches(files) {
  const matches = []

  for (const file of files) {
    for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex += 1) {
      const line = file.lines[lineIndex]
      RE.datastarCamelCaseAttribute.lastIndex = 0
      if (RE.datastarCamelCaseAttribute.test(line)) {
        matches.push(`${file.displayPath}:${lineIndex + 1}:${line}`)
      }
    }
  }

  return unique(matches)
}

function collectModuleExportsShorthandMatches(files) {
  const matches = []
  const shorthandPattern = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\1\s*,?\s*(?:\/\/.*)?$/

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

function isServerRuntimeFile(file) {
  if (!file.inPages) {
    return file.basename.endsWith('.js')
  }

  if (file.relFromPages.startsWith('assets/')) {
    return false
  }

  return file.isEjs || file.basename.startsWith('+') || file.relFromPages.startsWith('_private/')
}

function collectAsyncFlowMatches(context) {
  const matches = []
  const files = context.hooksCodeFiles.filter(isServerRuntimeFile)

  for (const file of files) {
    const analysisText = getLintAnalysisText(file)

    RE.asyncFlow.lastIndex = 0
    let match = RE.asyncFlow.exec(analysisText)

    while (match) {
      const lineNumber = lineNumberAt(analysisText, match.index)
      matches.push(formatLintLineMatch(file, lineNumber))
      match = RE.asyncFlow.exec(analysisText)
    }
  }

  return unique(matches)
}

function isDeclarationNameIdentifier(node) {
  const parent = node.parent

  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node)
  )
}

function isPropertyNameIdentifier(node) {
  const parent = node.parent

  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  )
}

function collectBindingNames(nameNode, names) {
  if (!nameNode) {
    return
  }

  if (ts.isIdentifier(nameNode)) {
    names.add(nameNode.text)
    return
  }

  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names)
      }
    }
  }
}

function collectDeclaredNames(sourceFile) {
  const names = new Set()

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names)
    } else if (ts.isParameter(node)) {
      collectBindingNames(node.name, names)
    } else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      names.add(node.name.text)
    } else if (ts.isImportClause(node) && node.name) {
      names.add(node.name.text)
    } else if (ts.isImportSpecifier(node)) {
      names.add(node.name.text)
    } else if (ts.isNamespaceImport(node)) {
      names.add(node.name.text)
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return names
}

function collectBrowserApiMatchesInText(file, sourceText, contentStart) {
  const matches = []
  const sourceFile = ts.createSourceFile(`${file.absPath}.__jsvm-browser-globals__.js`, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declaredNames = collectDeclaredNames(sourceFile)

  function visit(node) {
    if (ts.isIdentifier(node) && JSVM_BROWSER_GLOBALS.has(node.text) && !declaredNames.has(node.text) && !isDeclarationNameIdentifier(node) && !isPropertyNameIdentifier(node)) {
      const lineNumber = lineNumberAt(file.content, contentStart + node.getStart(sourceFile))
      matches.push(formatLintLineMatch(file, lineNumber))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return matches
}

function collectBrowserApiMatches(context) {
  const matches = []
  const files = context.hooksCodeFiles.filter(isServerRuntimeFile)

  for (const file of files) {
    if (file.isEjs) {
      const blocks = extractServerBlocks(file.content)

      for (const block of blocks) {
        matches.push(...collectBrowserApiMatchesInText(file, block.content, block.contentStart))
      }

      continue
    }

    matches.push(...collectBrowserApiMatchesInText(file, file.content, 0))
  }

  return unique(matches)
}

function collectLocaleApiMatches(context) {
  const matches = []
  const files = context.hooksCodeFiles.filter(isServerRuntimeFile)

  for (const file of files) {
    if (file.isEjs) {
      const blocks = extractServerBlocks(file.content)

      for (const block of blocks) {
        RE.localeApi.lastIndex = 0
        let match = RE.localeApi.exec(block.content)

        while (match) {
          const lineNumber = lineNumberAt(file.content, block.contentStart + match.index)
          matches.push(formatLintLineMatch(file, lineNumber))
          match = RE.localeApi.exec(block.content)
        }
      }

      continue
    }

    RE.localeApi.lastIndex = 0
    let match = RE.localeApi.exec(file.content)

    while (match) {
      const lineNumber = lineNumberAt(file.content, match.index)
      matches.push(formatLintLineMatch(file, lineNumber))
      match = RE.localeApi.exec(file.content)
    }
  }

  return unique(matches)
}

function collectTransactionCallbackRanges(sourceText) {
  const ranges = []

  for (const pattern of TRANSACTION_CALLBACK_PATTERNS) {
    pattern.lastIndex = 0

    let match = pattern.exec(sourceText)
    while (match) {
      const openBraceIndex = match.index + match[0].length - 1
      const closeBraceIndex = findMatchingBrace(sourceText, openBraceIndex)

      if (closeBraceIndex === -1) {
        break
      }

      ranges.push({
        paramName: match[1],
        bodyStart: openBraceIndex + 1,
        bodyEnd: closeBraceIndex,
      })

      pattern.lastIndex = closeBraceIndex + 1
      match = pattern.exec(sourceText)
    }
  }

  return ranges
}

function collectTransactionOuterAppMatches(files) {
  const matches = []

  for (const file of files) {
    for (const transaction of collectTransactionCallbackRanges(file.content)) {
      const body = file.content.slice(transaction.bodyStart, transaction.bodyEnd)
      const bodyStartLine = lineNumberAt(file.content, transaction.bodyStart)
      const bodyLines = body.split(/\r?\n/)

      for (let index = 0; index < bodyLines.length; index += 1) {
        const line = bodyLines[index]
        RE.outerAppInsideTransaction.lastIndex = 0

        if (!RE.outerAppInsideTransaction.test(line)) {
          continue
        }

        matches.push(`${file.displayPath}:${bodyStartLine + index}:${line}`)
      }
    }
  }

  return unique(matches)
}

function getLintAnalysisText(file) {
  return file.isEjs ? buildTemplateVirtualText(file.content) : file.content
}

function formatLintLineMatch(file, lineNumber) {
  const safeLineNumber = Math.max(1, lineNumber)
  const lineText = file.lines[safeLineNumber - 1] || ''
  return `${file.displayPath}:${safeLineNumber}:${lineText}`
}

function formatElapsedSeconds(elapsedMs) {
  return `${Number((elapsedMs / 1000).toFixed(3))}s`
}

function resolveLintPathContextTarget(projectIndex, filePath, pathContext) {
  if (pathContext.kind === 'resolve-path') {
    return projectIndex.resolveResolveTarget(filePath, pathContext.value)
  }

  if (pathContext.kind === 'include-path') {
    return projectIndex.resolveIncludeTarget(filePath, pathContext.value)
  }

  if (pathContext.kind === 'asset-path') {
    return projectIndex.resolveAssetTarget(filePath, pathContext.value)
  }

  if (pathContext.kind === 'route-path') {
    return projectIndex.resolveRouteTarget(filePath, pathContext.value, {
      routeSource: pathContext.routeSource,
    })
  }

  return null
}

function collectUnresolvedPathMatches(context) {
  const matchesByKind = {
    resolve: [],
    include: [],
    asset: [],
    route: [],
  }

  for (const file of context.lintCodeFiles) {
    const pathContexts = collectPathContexts(file.content)

    for (const pathContext of pathContexts) {
      if (pathContext.kind === 'resolve-path' && /^\/?_private\//.test(pathContext.value)) {
        continue
      }

      if (pathContext.kind === 'route-path' && pathContext.isDynamic) {
        continue
      }

      if (resolveLintPathContextTarget(context.projectIndex, file.absPath, pathContext)) {
        continue
      }

      const lineNumber = lineNumberAt(file.content, pathContext.start)
      const match = formatLintLineMatch(file, lineNumber)

      if (pathContext.kind === 'resolve-path') {
        matchesByKind.resolve.push(match)
        continue
      }

      if (pathContext.kind === 'include-path') {
        matchesByKind.include.push(match)
        continue
      }

      if (pathContext.kind === 'asset-path') {
        matchesByKind.asset.push(match)
        continue
      }

      if (pathContext.kind === 'route-path') {
        matchesByKind.route.push(match)
      }
    }
  }

  return {
    resolve: unique(matchesByKind.resolve),
    include: unique(matchesByKind.include),
    asset: unique(matchesByKind.asset),
    route: unique(matchesByKind.route),
  }
}

function isSchemaLintAppReceiver(schemaContext, transactionRanges) {
  const receiverExpression = String(schemaContext && schemaContext.receiverExpression ? schemaContext.receiverExpression : '').trim()
  if ((schemaContext && schemaContext.receiverIsDollarApp === true) || receiverExpression === '$app') {
    return true
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(receiverExpression)) {
    return false
  }

  const receiverStart = Number(schemaContext.receiverStart)
  const receiverEnd = Number(schemaContext.receiverEnd)
  if (!Number.isFinite(receiverStart) || !Number.isFinite(receiverEnd) || receiverEnd <= receiverStart) {
    return false
  }

  return transactionRanges.some((transaction) =>
    transaction.paramName === receiverExpression &&
    receiverStart >= transaction.bodyStart &&
    receiverEnd <= transaction.bodyEnd
  )
}

function resolveSchemaLintCollectionReference(context, file, analysisText, schemaContext) {
  if (schemaContext.collectionName && context.projectIndex.hasCollection(schemaContext.collectionName)) {
    return {
      collectionName: schemaContext.collectionName,
      confidence: 'high',
    }
  }

  if (!schemaContext.collectionExpression) {
    return null
  }

  return context.projectIndex.inferCollectionReference(
    schemaContext.collectionExpression,
    analysisText,
    schemaContext.collectionStart,
    { filePath: file.absPath }
  )
}

function collectSchemaMatches(context) {
  const matches = {
    collections: [],
    fields: [],
    filterFields: [],
    sortFields: [],
  }

  for (const file of context.lintCodeFiles) {
    const analysisText = getLintAnalysisText(file)
    const transactionRanges = collectTransactionCallbackRanges(analysisText)
    const schemaContexts = collectSchemaContexts(analysisText, {
      collectionMethodNames: context.collectionMethodNames,
    })

    for (const schemaContext of schemaContexts) {
      if (schemaContext.kind === 'collection-name') {
        if (!isSchemaLintAppReceiver(schemaContext, transactionRanges)) {
          continue
        }

        if (context.projectIndex.hasCollection(schemaContext.value)) {
          continue
        }

        const lineNumber = lineNumberAt(analysisText, schemaContext.start)
        matches.collections.push(formatLintLineMatch(file, lineNumber))
        continue
      }

      if (schemaContext.kind !== 'record-field') {
        if (schemaContext.kind !== 'filter-field' && schemaContext.kind !== 'sort-field') {
          continue
        }

        if (!isSchemaLintAppReceiver(schemaContext, transactionRanges)) {
          continue
        }

        const reference = resolveSchemaLintCollectionReference(context, file, analysisText, schemaContext)
        if (!reference || reference.confidence !== 'high' || context.projectIndex.hasField(reference.collectionName, schemaContext.value)) {
          continue
        }

        const lineNumber = lineNumberAt(analysisText, schemaContext.start)
        const targetMatches = schemaContext.kind === 'filter-field' ? matches.filterFields : matches.sortFields
        targetMatches.push(formatLintLineMatch(file, lineNumber))
        continue
      }

      const reference = context.projectIndex.inferCollectionReference(schemaContext.receiverExpression, analysisText, schemaContext.start, { filePath: file.absPath })
      if (!reference || reference.confidence !== 'high' || context.projectIndex.hasField(reference.collectionName, schemaContext.value)) {
        continue
      }

      const lineNumber = lineNumberAt(analysisText, schemaContext.start)
      matches.fields.push(formatLintLineMatch(file, lineNumber))
    }
  }

  return {
    collections: unique(matches.collections),
    fields: unique(matches.fields),
    filterFields: unique(matches.filterFields),
    sortFields: unique(matches.sortFields),
  }
}

function collectQueryViaParamsMatches(context) {
  const matches = []

  for (const file of context.lintCodeFiles) {
    const analysisText = getLintAnalysisText(file)
    const routeParamNames = context.projectIndex.getRouteParamEntries(file.absPath).map((entry) => entry.name)
    const diagnostics = collectParamsFlowDiagnostics(analysisText, routeParamNames)

    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== 'pp-query-via-params' || typeof diagnostic.start !== 'number') {
        continue
      }

      const lineNumber = lineNumberAt(analysisText, diagnostic.start)
      matches.push(formatLintLineMatch(file, lineNumber))
    }
  }

  return unique(matches)
}

function collectRedirectMissingReturnMatches(context) {
  const matches = []

  for (const file of context.lintCodeFiles) {
    if (file.isEjs) {
      const blocks = extractServerBlocks(file.content)

      for (const block of blocks) {
        const diagnostics = collectRedirectReturnDiagnostics(file.absPath, block.content, {
          sourceFile: ts.createSourceFile(`${file.absPath}.__redirect__.ts`, block.content, ts.ScriptTarget.Latest, true),
          useTopLevelStatements: true,
        })

        for (const diagnostic of diagnostics) {
          if (diagnostic.code !== 'pp-redirect-missing-return' || typeof diagnostic.start !== 'number') {
            continue
          }

          const lineNumber = lineNumberAt(file.content, block.contentStart + diagnostic.start)
          matches.push(formatLintLineMatch(file, lineNumber))
        }
      }

      continue
    }

    const diagnostics = collectRedirectReturnDiagnostics(file.absPath, file.content, {
      sourceFile: ts.createSourceFile(file.absPath, file.content, ts.ScriptTarget.Latest, true),
    })

    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== 'pp-redirect-missing-return' || typeof diagnostic.start !== 'number') {
        continue
      }

      const lineNumber = lineNumberAt(file.content, diagnostic.start)
      matches.push(formatLintLineMatch(file, lineNumber))
    }
  }

  return unique(matches)
}

function collectRedirectFlashOptionMatches(context) {
  const matches = []

  for (const file of context.lintCodeFiles) {
    const analysisText = getLintAnalysisText(file)

    RE.redirectCall.lastIndex = 0
    let match = RE.redirectCall.exec(analysisText)

    while (match) {
      const openParenIndex = analysisText.indexOf('(', match.index)
      const closeParenIndex = findMatchingParen(analysisText, openParenIndex)
      if (closeParenIndex === -1) {
        break
      }

      const callText = analysisText.slice(match.index, closeParenIndex + 1)
      RE.redirectFlashOption.lastIndex = 0
      if (RE.redirectFlashOption.test(callText)) {
        const lineNumber = lineNumberAt(analysisText, match.index)
        matches.push(formatLintLineMatch(file, lineNumber))
      }

      RE.redirectCall.lastIndex = closeParenIndex + 1
      match = RE.redirectCall.exec(analysisText)
    }
  }

  return unique(matches)
}

function collectConfigPluginDependencyMatches(context) {
  if (!context.configFileInfo) {
    return []
  }

  const packageJson = readJsonFile(context.packageFile)
  if (!packageJson) {
    return []
  }

  const dependencies = Object.assign({}, packageJson.dependencies || {}, packageJson.devDependencies || {})
  const pluginNames = unique(Array.from(context.configFileInfo.content.matchAll(/["'](pocketpages-plugin-[^"']+)["']/g)).map((match) => match[1]))

  return pluginNames
    .filter((pluginName) => !dependencies[pluginName])
    .map((pluginName) => `${toDisplayPath(context.configFile)} uses ${pluginName}, but ${toDisplayPath(context.packageFile)} does not list it`)
}

function lintService(context) {
  console.log(`Checking service: ${context.serviceName}`)

  const resolvePrivateMatches = collectLineMatches(context.lintCodeFiles, RE.resolvePrivate)
  printMatches(context.serviceName, "Invalid resolve() path. Use names relative to _private, for example resolve('board-service').", resolvePrivateMatches)

  const includePrivateMatches = collectLineMatches(context.pagesCodeFiles, RE.includePrivate)
  printMatches(context.serviceName, 'Invalid include() path. Keep include paths relative to the current PocketPages include rules.', includePrivateMatches)

  const recordFieldMatches = collectDirectRecordFieldMatches(context.lintCodeFiles)
  printMatches(context.serviceName, "Invalid direct Record field access. Read PocketBase fields with record.get('fieldName').", recordFieldMatches)

  const middlewareResolveMatches = context.middlewareFiles
    .filter((file) => {
      RE.middlewareUsesResolve.lastIndex = 0
      RE.middlewareHasResolveArg.lastIndex = 0
      return RE.middlewareUsesResolve.test(file.content) && !RE.middlewareHasResolveArg.test(file.content)
    })
    .map((file) => file.displayPath)
  printMatches(context.serviceName, 'Invalid middleware resolve() usage. Read resolve from middleware function arguments.', middlewareResolveMatches)

  const apiLayoutMatches = collectPathMatches(context.pagesFiles, (file) => /^(api|xapi)(\/.*)?\/\+layout\.ejs$/.test(file.relFromPages))
  printMatches(context.serviceName, 'Invalid layout placement. Keep +layout.ejs in routable page sections, not under api/ or xapi/.', apiLayoutMatches)

  const xapiFullHtmlMatches = collectLineMatches(context.xapiFiles, RE.fullHtml)
  printMatches(context.serviceName, 'Invalid xapi response shape. Return fragments or raw responses from xapi/, not full HTML documents.', xapiFullHtmlMatches)

  const apiHtmlResponseMatches = unique([...collectLineMatches(context.apiFiles, RE.fullHtml), ...collectLineMatches(context.apiFiles, RE.responseHtml)])
  printMatches(context.serviceName, 'Invalid api response shape. Keep api/ for programmatic responses such as JSON and do not return HTML documents or response.html(...).', apiHtmlResponseMatches)

  const privateSpecialFileMatches = collectPathMatches(context.pagesFiles, (file) => /_private\/.*\/\+(layout|config|load|middleware|get|post|put|patch|delete)\.(ejs|js)$/.test(file.relFromPages))
  printMatches(context.serviceName, 'Invalid _private file placement. Keep PocketPages special route/config files outside _private.', privateSpecialFileMatches)

  const pagesPbJsMatches = collectPathMatches(context.pagesFiles, (file) => file.basename.endsWith('.pb.js'))
  printMatches(
    context.serviceName,
    'Invalid pages file name. Files under pb_hooks/pages are routed by PocketPages. Move *.pb.js hooks to pb_hooks/ root or another PocketBase hook location.',
    pagesPbJsMatches
  )

  const staticPagesJsFiles = context.pagesCodeFiles.filter(
    (file) =>
      file.basename.endsWith('.js') && !file.basename.startsWith('+') && !file.basename.endsWith('.pb.js') && !file.relFromPages.startsWith('_private/') && !file.relFromPages.startsWith('assets/')
  )
  const staticJsServerCodeMatches = collectLineMatches(staticPagesJsFiles, RE.staticJsServerCode)
  printMatches(
    context.serviceName,
    'Invalid pages static .js usage. Regular .js files under pb_hooks/pages are served as static assets, so move server code to +*.js, *.ejs, or _private/*.js.',
    staticJsServerCodeMatches
  )

  const transactionOuterAppMatches = collectTransactionOuterAppMatches(context.hooksCodeFiles)
  printMatches(
    context.serviceName,
    'Invalid runInTransaction usage. Inside $app.runInTransaction(...) always use the callback txApp argument instead of the outer $app instance.',
    transactionOuterAppMatches
  )

  const asyncFlowMatches = collectAsyncFlowMatches(context)
  printMatches(context.serviceName, 'Invalid JSVM async flow. Keep PocketBase/PocketPages server code sync; do not use async, await, Promise, or .then(...).', asyncFlowMatches)

  const localeApiMatches = collectLocaleApiMatches(context)
  printMatches(
    context.serviceName,
    'Invalid JSVM locale API usage. Avoid Intl and toLocale* in PocketBase/PocketPages server code; use explicit project utilities or small deterministic formatters.',
    localeApiMatches
  )

  const browserApiMatches = collectBrowserApiMatches(context)
  printMatches(
    context.serviceName,
    'Invalid JSVM browser API usage. Do not use browser/Web APIs in PocketBase/PocketPages server code; use PocketBase globals such as $http, sleep, $app.store(), or explicit project utilities.',
    browserApiMatches
  )

  const pagesHookRegistrationMatches = collectLineMatches(context.pagesCodeFiles, RE.hookRegistration)
  printMatches(
    context.serviceName,
    'Invalid PocketBase hook registration in pages code. Move routerAdd/routerUse/cronAdd/onRecord*/onSettings* registrations to pb_hooks/*.pb.js or another non-pages hook file.',
    pagesHookRegistrationMatches
  )

  const privateResolveMatches = collectLineMatches(context.privateCodeFiles, RE.resolveCall)
  printMatches(
    context.serviceName,
    'Invalid _private resolve() usage. Resolve dependencies only from request entry files such as EJS, <script server>, loaders, and middleware.',
    privateResolveMatches
  )

  const reservedParamsBindingMatches = collectReservedParamsBindingMatches(context.lintCodeFiles)
  printWarnings(
    context.serviceName,
    'Discouraged JS params binding. Reserve "params" for route context only and rename helper inputs or locals to payload, input, summaryInput, or another contextual name.',
    reservedParamsBindingMatches
  )

  const privateModulePatternMatches = unique([
    ...collectLineMatches(
      context.privateCodeFiles.filter((file) => file.basename.endsWith('.js')),
      RE.privateModuleFunctionExport
    ),
    ...collectLineMatches(
      context.privateCodeFiles.filter((file) => file.basename.endsWith('.js')),
      RE.privateModuleFactoryExport
    ),
  ])
  printWarnings(context.serviceName, 'Discouraged _private module export style. Prefer module.exports = { ... } and avoid function/factory exports in _private/*.js.', privateModulePatternMatches)

  const distributedModuleExportMatches = collectLineMatches(
    context.privateCodeFiles.filter((file) => file.basename.endsWith('.js')),
    RE.distributedModuleExport
  )
  printWarnings(
    context.serviceName,
    'Discouraged _private module export style. Prefer grouping public members in one module.exports = { ... } object instead of scattered module.exports.foo assignments.',
    distributedModuleExportMatches
  )

  const moduleExportsShorthandMatches = collectModuleExportsShorthandMatches(context.hooksCodeFiles.filter((file) => file.basename.endsWith('.js')))
  printWarnings(
    context.serviceName,
    'Discouraged module.exports object style. Prefer shorthand members such as { sentCount } instead of repeating sentCount: sentCount in exported objects.',
    moduleExportsShorthandMatches
  )

  const privateScriptServerMatches = collectLineMatches(
    context.pagesEjsFiles.filter((file) => file.relFromPages.startsWith('_private/')),
    RE.scriptServerTag
  )
  printMatches(
    context.serviceName,
    'Invalid _private <script server> usage. Keep _private partial setup in top-level <% ... %> blocks and reserve <script server> for entry EJS files.',
    privateScriptServerMatches
  )

  const privateEjsDbAccessMatches = collectLineMatches(
    context.pagesEjsFiles.filter((file) => file.relFromPages.startsWith('_private/')),
    RE.privateEjsDbAccess
  )
  printMatches(
    context.serviceName,
    'Invalid _private EJS DB access. Keep _private partials render-only and move PocketBase queries or writes to the entry EJS <script server> block or a nearby _private/*.js module.',
    privateEjsDbAccessMatches
  )

  const pagesProcessEnvMatches = collectLineMatches(context.lintCodeFiles, RE.processEnv)
  printMatches(context.serviceName, 'Invalid process.env usage in PocketPages pages code. Use env(...) inside pb_hooks/pages files.', pagesProcessEnvMatches)

  const nonPagesPocketPagesGlobalMatches = collectLineMatches(context.nonPagesHooksCodeFiles, RE.pocketpagesOnlyGlobalCall)
  printMatches(
    context.serviceName,
    'Invalid PocketPages global usage outside pb_hooks/pages. Do not use env(...), dbg(...), info(...), warn(...), or error(...) in non-pages pb_hooks code.',
    nonPagesPocketPagesGlobalMatches
  )

  const nonPagesPocketPagesRouteHelperMatches = collectLineMatches(context.nonPagesHooksCodeFiles, RE.nonPagesPocketPagesRouteHelper)
  printMatches(
    context.serviceName,
    'Invalid PocketPages route helper usage outside pb_hooks/pages. Do not use redirect(...) or resolve(...) in non-pages pb_hooks code.',
    nonPagesPocketPagesRouteHelperMatches
  )

  const nonPagesDatastarRequestHelperMatches = collectLineMatches(context.nonPagesHooksCodeFiles, RE.nonPagesDatastarRequestHelper)
  printMatches(
    context.serviceName,
    'Invalid Datastar request helper usage outside pb_hooks/pages. datastar.* and api.datastar.* exist only in PocketPages route context; use createRealtimeSender(...) or $app.subscriptionsBroker() in backend hooks/jobs.',
    nonPagesDatastarRequestHelperMatches
  )

  const pagesDatastarBackendRealtimeUtilityMatches = collectLineMatches(context.lintCodeFiles, RE.datastarBackendRealtimeUtility)
  printWarnings(
    context.serviceName,
    'Discouraged Datastar backend realtime utility in PocketPages pages. Use datastar.realtime.* in route context; reserve createRealtimeSender(...) and payload builders for pb_hooks jobs/hooks.',
    pagesDatastarBackendRealtimeUtilityMatches
  )

  const includeFullContextMatches = collectIncludeFullContextMatches(context.pagesEjsFiles)
  printMatches(context.serviceName, 'Invalid include() locals. Pass only the values the partial needs instead of api/request/response/resolve/params/data.', includeFullContextMatches)

  const localTypedefMatches = collectLineMatches(context.lintCodeFiles, RE.localTypedef)
  printWarnings(context.serviceName, 'Discouraged local @typedef usage. Prefer moving named shapes to apps/<service>/types.d.ts and reference them as types.*.', localTypedefMatches)

  const roleSideEffectMatches = collectLineMatches(context.roleFiles, RE.roleSideEffect)
  printMatches(context.serviceName, 'Invalid role side effect. Keep roles/*.js pure and move redirect/response/body/save/delete work to entry or service code.', roleSideEffectMatches)

  const roleDbQueryMatches = collectLineMatches(context.roleFiles, RE.roleDbQuery)
  printMatches(context.serviceName, 'Invalid role DB lookup. Fetch records in entry or service code and pass them into the role.', roleDbQueryMatches)

  const roleRequestContextMatches = collectLineMatches(context.roleFiles, RE.roleRequestContext)
  printMatches(context.serviceName, 'Invalid role request-context access. Do not use request, params, query, or resolve() inside roles/*.js.', roleRequestContextMatches)

  const xapiJsonMatches = collectLineMatches(context.xapiFiles, RE.responseJson)
  printMatches(context.serviceName, 'Invalid xapi JSON response. Move JSON endpoints under api/ and keep xapi/ for fragments or raw responses.', xapiJsonMatches)

  const apiRedirectMatches = collectLineMatches(context.apiFiles, RE.redirect)
  printMatches(context.serviceName, 'Invalid api redirect. Keep api/ for programmatic responses and move redirect flows to page or xapi code.', apiRedirectMatches)

  const manualFlashMatches = collectLineMatches(context.pagesCodeFiles, RE.manualFlash)
  printMatches(context.serviceName, 'Invalid flash handling. Use redirect(path, { message }) instead of manually building ?__flash=....', manualFlashMatches)
  const redirectFlashOptionMatches = collectRedirectFlashOptionMatches(context)
  printMatches(context.serviceName, 'Invalid redirect flash option. Use redirect(path, { message }) instead of redirect(path, { flash }).', redirectFlashOptionMatches)
  const redirectMissingReturnMatches = collectRedirectMissingReturnMatches(context)
  printMatches(context.serviceName, 'Invalid redirect() control flow. Return after redirect() so PocketPages execution stops explicitly.', redirectMissingReturnMatches)

  const unresolvedPathMatches = collectUnresolvedPathMatches(context)
  printMatches(context.serviceName, 'Invalid resolve() target. resolve(...) must point to an existing _private module or partial.', unresolvedPathMatches.resolve)
  printMatches(context.serviceName, 'Invalid include() target. include(...) must point to an existing partial file.', unresolvedPathMatches.include)
  printMatches(context.serviceName, 'Invalid asset() target. asset(...) must point to an existing asset file.', unresolvedPathMatches.asset)
  printMatches(context.serviceName, 'Invalid route path. Static href/action/hx-*/redirect paths must point to an existing route.', unresolvedPathMatches.route)

  const schemaMatches = collectSchemaMatches(context)
  printMatches(context.serviceName, 'Invalid PocketBase collection name. Use a collection that exists in pb_schema.json.', schemaMatches.collections)
  printMatches(
    context.serviceName,
    "Invalid PocketBase record field name. Use a field that exists in pb_schema.json when calling record.get('field') or record.set('field', value).",
    schemaMatches.fields
  )
  printMatches(
    context.serviceName,
    'Invalid PocketBase filter field name. Use fields that exist in pb_schema.json inside findRecordsByFilter()/findFirstRecordByFilter() filters.',
    schemaMatches.filterFields
  )
  printMatches(
    context.serviceName,
    'Invalid PocketBase sort field name. Use fields that exist in pb_schema.json inside findRecordsByFilter() sort strings.',
    schemaMatches.sortFields
  )

  const queryViaParamsMatches = collectQueryViaParamsMatches(context)
  printWarnings(context.serviceName, 'Discouraged params query access. Use request.url.query for query strings and reserve params for route params or __flash.', queryViaParamsMatches)

  const nestedConfigMatches = context.configFiles.filter((file) => file.absPath !== context.configFile).map((file) => file.displayPath)
  printMatches(context.serviceName, 'Invalid +config.js placement. Keep a single +config.js at pb_hooks/pages/+config.js.', nestedConfigMatches)

  const invalidSpecialPlusFiles = context.specialPlusFiles.filter((file) => !ALLOWED_SPECIAL_FILES.has(file.basename)).map((file) => file.displayPath)
  printMatches(
    context.serviceName,
    'Invalid +special file name. Only +config.js, +layout.ejs, +load.js, +middleware.js, +get.js, +post.js, +put.js, +patch.js, and +delete.js are allowed.',
    invalidSpecialPlusFiles
  )

  const middlewareFlowMatches = context.middlewareFiles
    .filter((file) => {
      RE.middlewareDeclaresNext.lastIndex = 0
      RE.middlewareCallsNext.lastIndex = 0
      RE.middlewareUsesResponse.lastIndex = 0
      return RE.middlewareDeclaresNext.test(file.content) && !RE.middlewareCallsNext.test(file.content) && !RE.middlewareUsesResponse.test(file.content)
    })
    .map((file) => file.displayPath)
  printMatches(context.serviceName, 'Invalid middleware control flow. Middleware that declares next must call next() or send a response before returning.', middlewareFlowMatches)

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
  printMatches(context.serviceName, 'Invalid nested +load.js layout. PocketPages executes only the leaf +load.js, so shared loading belongs in middleware.', nestedLoadMatches)

  const rawEjsOutputMatches = collectLineMatches(context.pagesEjsFiles, RE.rawEjsOutput)
  const disallowedRawEjsMatches = filterLinesExcluding(rawEjsOutputMatches, RE.rawEjsAllowed)
  printMatches(context.serviceName, 'Invalid raw EJS output. Limit <%- ... %> to include(), slot/slots, content, or resolve()-provided safe assets.', disallowedRawEjsMatches)

  const datastarCamelCaseAttributeMatches = collectDatastarCamelCaseAttributeMatches(context.pagesEjsFiles)
  printMatches(
    context.serviceName,
    'Invalid Datastar attribute key. Use kebab-case in data-* attributes, for example data-bind:item-text instead of data-bind:itemText.',
    datastarCamelCaseAttributeMatches
  )

  const compactConfig = context.configFileInfo ? context.configFileInfo.content.replace(/\s+/g, '') : ''
  const missingConfigPluginDependencyMatches = collectConfigPluginDependencyMatches(context)
  printMatches(context.serviceName, 'Invalid plugin dependency setup. Every pocketpages-plugin-* listed in +config.js must be listed directly in package.json.', missingConfigPluginDependencyMatches)

  const authHelperMatches = collectLineMatches(context.pagesCodeFiles, RE.authHelper)
  if (authHelperMatches.length > 0 && !compactConfig.includes('pocketpages-plugin-auth')) {
    printMatches(context.serviceName, 'Invalid auth helper setup. Add pocketpages-plugin-auth to pb_hooks/pages/+config.js before using auth helpers.', authHelperMatches)
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
  printMatches(context.serviceName, 'Invalid auth plugin order. List pocketpages-plugin-js-sdk before pocketpages-plugin-auth in +config.js.', authPluginConfigMatches)

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
    'Heavy role composition in one entry. Keep direct resolve by default, and move only repeated shared wiring into a nearby plain _private module when it is reused.',
    excessiveRoleResolveMatches
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
    const serviceStart = process.hrtime.bigint()
    const serviceName = path.basename(serviceDir)
    const fingerprint = createLintFingerprint(serviceDir)
    const cached = getValidLintCache(serviceDir, fingerprint)

    if (cached) {
      const warningCount = Number.isFinite(cached.warnings) ? cached.warnings : 0
      warnings += warningCount

      console.log(`Checking service: ${serviceName}`)
      console.log(`PocketPages lint cache hit [${serviceName}]${warningCount > 0 ? ` (${warningCount} warning(s))` : ''}.`)
      const serviceElapsedMs = Number(process.hrtime.bigint() - serviceStart) / 1e6
      console.log(`Service lint time [${serviceName}]: ${formatElapsedSeconds(serviceElapsedMs)}`)
      continue
    }

    const previousErrors = errors
    const previousWarnings = warnings
    const context = buildServiceContext(serviceDir)
    lintService(context)

    if (errors === previousErrors) {
      writeLintCache(serviceDir, fingerprint, warnings - previousWarnings)
    }

    const serviceElapsedMs = Number(process.hrtime.bigint() - serviceStart) / 1e6
    console.log(`Service lint time [${context.serviceName}]: ${formatElapsedSeconds(serviceElapsedMs)}`)
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
