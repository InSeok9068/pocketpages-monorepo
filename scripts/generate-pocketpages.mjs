#!/usr/bin/env node
/* global console */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const appsDir = path.join(rootDir, 'apps')

const kinds = [
  {
    id: 'xapi-redirect',
    area: 'xapi',
    label: 'xapi redirect mutation',
    defaultMethod: 'POST',
    defaultAuth: true,
  },
  {
    id: 'api-json',
    area: 'api',
    label: 'api JSON endpoint',
    defaultMethod: 'POST',
    defaultAuth: true,
  },
  {
    id: 'xapi-partial',
    area: 'xapi',
    label: 'xapi partial response',
    defaultMethod: 'GET',
    defaultAuth: false,
  },
  {
    id: 'xapi-datastar',
    area: 'xapi',
    label: 'xapi Datastar mutation',
    defaultMethod: 'POST',
    defaultAuth: true,
  },
]

const kindById = new Map(kinds.map((kind) => [kind.id, kind]))
const methodValues = new Set(['GET', 'POST', 'ANY'])

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/generate-pocketpages.mjs [options]

Options:
  --service <name>              Service under apps/
  --kind <name>                 xapi-redirect | api-json | xapi-partial | xapi-datastar
  --path <route-path>           Route path under api/ or xapi/, e.g. books/delete-note
  --method <GET|POST|ANY>       Request method guard. Defaults by kind
  --auth / --no-auth            Add or skip request.auth guard
  --partial <name.ejs>          Partial name for xapi-partial
  --success-redirect <path>     Success redirect path for xapi-redirect
  --failure-redirect <path>     Failure redirect path for xapi-redirect
  --force                       Overwrite an existing file
  --dry-run                     Print the generated file without writing
  -h, --help                    Show this help

Examples:
  ./task.sh generate --service booklog --kind xapi-redirect --path books/delete-note
  ./task.sh generate --service sample --kind api-json --path boards/search --method GET --no-auth
  ./task.sh generate --service sample --kind xapi-partial --path boards/list --partial board-list.ejs
`)
}

function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`
  }

  return value
}

function normalizeMenuAnswer(input) {
  return String(input || '').trim()
}

function normalizeBooleanAnswer(value, fallback) {
  const answer = normalizeMenuAnswer(value).toLowerCase()
  if (!answer) return fallback
  if (['y', 'yes', 'true', '1'].includes(answer)) return true
  if (['n', 'no', 'false', '0'].includes(answer)) return false
  return fallback
}

function toRouteId(routePath) {
  return String(routePath || '')
    .replace(/\\/g, '/')
    .replace(/\.ejs$/, '')
    .replace(/^\//, '')
}

function toLogName(relativeRoutePath) {
  return toRouteId(relativeRoutePath)
}

function toSafePartialName(value) {
  const name = String(value || '').trim()
  if (!name) return ''
  return name.endsWith('.ejs') ? name : `${name}.ejs`
}

function parseArgs(argv) {
  const options = {
    service: '',
    kind: '',
    routePath: '',
    method: '',
    auth: null,
    partial: '',
    successRedirect: '/',
    failureRedirect: '',
    force: false,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (value === '-h' || value === '--help') {
      options.help = true
      continue
    }

    if (value === '--force') {
      options.force = true
      continue
    }

    if (value === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (value === '--auth') {
      options.auth = true
      continue
    }

    if (value === '--no-auth') {
      options.auth = false
      continue
    }

    const nextValue = argv[index + 1]
    if (value === '--service') {
      options.service = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    if (value === '--kind') {
      options.kind = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    if (value === '--path') {
      options.routePath = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    if (value === '--method') {
      options.method = requiredOptionValue(value, nextValue).toUpperCase()
      index += 1
      continue
    }

    if (value === '--partial') {
      options.partial = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    if (value === '--success-redirect') {
      options.successRedirect = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    if (value === '--failure-redirect') {
      options.failureRedirect = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    throw new Error(`Unknown option: ${value}`)
  }

  return options
}

function requiredOptionValue(optionName, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`)
  }

  return value
}

async function readDirSafe(targetDir) {
  try {
    return await readdir(targetDir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function listServices() {
  const entries = await readDirSafe(appsDir)
  const services = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const serviceDir = path.join(appsDir, entry.name)
    const pagesDir = path.join(serviceDir, 'pb_hooks', 'pages')
    if (!(await exists(pagesDir))) continue

    services.push({
      name: entry.name,
      serviceDir,
      pagesDir,
    })
  }

  return services.sort((left, right) => left.name.localeCompare(right.name))
}

async function createPrompter() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return {
      async question(prompt) {
        return rl.question(prompt)
      },
      close() {
        rl.close()
      },
    }
  }

  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
  }

  const answers = text.split(/\r?\n/)
  let index = 0

  return {
    async question(prompt) {
      process.stdout.write(prompt)
      const answer = answers[index] === undefined ? '' : answers[index]
      index += 1
      if (answer) process.stdout.write(`${answer}\n`)
      return answer
    },
    close() {},
  }
}

async function promptSelection(rl, title, items, formatItem) {
  if (!items.length) {
    throw new Error(`${title} 항목이 없습니다.`)
  }

  console.log(title)
  items.forEach((item, index) => {
    console.log(`  ${index + 1}. ${formatItem(item)}`)
  })

  while (true) {
    const answer = normalizeMenuAnswer(await rl.question('번호 또는 이름을 입력하세요: '))
    if (!answer) continue

    const selectedIndex = Number(answer)
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= items.length) {
      return items[selectedIndex - 1]
    }

    const matched = items.find((item) => {
      const itemName = typeof item === 'string' ? item : item.id || item.name
      return itemName === answer
    })
    if (matched) return matched

    console.log('다시 입력해주세요.')
  }
}

async function completeOptions(options) {
  const services = await listServices()
  if (!services.length) {
    throw new Error('pb_hooks/pages가 있는 서비스가 없습니다.')
  }

  const rl = await createPrompter()

  try {
    let service = null
    if (options.service) {
      const serviceName = path.basename(fromMsysPath(options.service))
      service = services.find((item) => item.name === serviceName)
      if (!service) {
        throw new Error(`Unknown service: ${options.service}`)
      }
    } else {
      service = await promptSelection(rl, '1. 어떤 서비스를 대상으로 생성할까요?', services, (item) => item.name)
    }

    let kind = null
    if (options.kind) {
      kind = kindById.get(options.kind)
      if (!kind) {
        throw new Error(`Unknown generate kind: ${options.kind}`)
      }
    } else {
      kind = await promptSelection(rl, '2. 어떤 라우트 골격을 만들까요?', kinds, (item) => `${item.id} - ${item.label}`)
    }

    let routePath = options.routePath
    while (!routePath) {
      routePath = normalizeMenuAnswer(await rl.question(`3. 생성할 ${kind.area} 경로를 입력하세요: `))
    }

    const shouldPromptDefaults = process.stdin.isTTY && (!options.service || !options.kind || !options.routePath)
    let method = options.method || kind.defaultMethod
    if (!options.method && shouldPromptDefaults) {
      const answer = normalizeMenuAnswer(await rl.question(`4. 메서드 guard [${method}]: `)).toUpperCase()
      if (answer) method = answer
    }

    let auth = options.auth
    if (auth === null) {
      if (shouldPromptDefaults) {
        const answer = await rl.question(`5. request.auth guard 추가? [${kind.defaultAuth ? 'Y/n' : 'y/N'}]: `)
        auth = normalizeBooleanAnswer(answer, kind.defaultAuth)
      } else {
        auth = kind.defaultAuth
      }
    }

    let partial = options.partial
    if (kind.id === 'xapi-partial') {
      if (!partial && !process.stdin.isTTY) {
        throw new Error('--partial is required for xapi-partial when running non-interactively.')
      }

      while (!partial) {
        partial = normalizeMenuAnswer(await rl.question('6. include할 partial 파일명: '))
      }
    }

    return {
      ...options,
      service,
      kind,
      routePath,
      method,
      auth,
      partial: toSafePartialName(partial),
    }
  } finally {
    rl.close()
  }
}

function normalizeRoutePath(kind, rawRoutePath) {
  const raw = String(rawRoutePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\.ejs$/, '')

  if (!raw) {
    throw new Error('Route path is required.')
  }

  if (raw.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Route path cannot contain . or .. segments.')
  }

  const parts = raw.split('/').filter(Boolean)
  if (parts[0] === 'api' || parts[0] === 'xapi') {
    if (parts[0] !== kind.area) {
      throw new Error(`${kind.id} routes must live under ${kind.area}/.`)
    }
    return parts.join('/')
  }

  return [kind.area, ...parts].join('/')
}

function validateOptions(options) {
  if (!methodValues.has(options.method)) {
    throw new Error('--method must be GET, POST, or ANY.')
  }

  if (options.partial && (options.partial.includes('/') || options.partial.includes('\\'))) {
    throw new Error('--partial must be a _private partial file name, not a path.')
  }
}

function authValidationCode(enabled) {
  if (!enabled) return ''

  return `    if (!userId) throw new Error('로그인이 필요합니다.')

`
}

function methodGuardCode(logName, method, responseKind, fallbackRedirect, invalidMethodMessage) {
  if (method === 'ANY') return ''

  if (responseKind === 'json') {
    return `  if (request.method !== '${method}') {
    response.json(405, {
      ok: false,
      message: '${invalidMethodMessage}',
    })
    return
  }

`
  }

  return `  if (request.method !== '${method}') {
    dbg('${logName}:redirect', {
      status: 303,
      redirectTo: '${fallbackRedirect}',
      flash: '${invalidMethodMessage}',
    })
    redirect('${fallbackRedirect}', {
      status: 303,
      message: '${invalidMethodMessage}',
    })
    return
  }

`
}

function authGuardCode(logName, enabled, responseKind, signInPath, authMessage) {
  if (!enabled) return ''

  if (responseKind === 'json') {
    return `  if (!request.auth) {
    response.json(401, {
      ok: false,
      message: '${authMessage}',
    })
    return
  }

`
  }

  return `  if (!request.auth) {
    dbg('${logName}:redirect', {
      status: 303,
      redirectTo: '${signInPath}',
      flash: '${authMessage}',
    })
    redirect('${signInPath}', {
      status: 303,
      message: '${authMessage}',
    })
    return
  }

`
}

function xapiRedirectTemplate(options) {
  const relativeRoutePath = normalizeRoutePath(options.kind, options.routePath)
  const logName = toLogName(relativeRoutePath)
  const fallbackRedirect = options.failureRedirect || options.successRedirect || '/'
  const successRedirect = options.successRedirect || '/'

  return `<script server>
${methodGuardCode(logName, options.method, 'redirect', fallbackRedirect, '잘못된 요청입니다.')}${authGuardCode(logName, options.auth, 'redirect', '/sign-in', '로그인이 필요합니다.')}  const form = body()
  const userId = request.auth ? String(request.auth.get('id') || '') : ''
  let errorMessage = ''

  dbg('${logName}:start', {
    userId,
    hasForm: !!form,
  })

  try {
${authValidationCode(options.auth)}\
    // TODO: form 값을 검증하고 필요한 Record 변경을 수행하세요.

    info('${logName}:success', {
      userId,
    })
    dbg('${logName}:redirect', {
      status: 303,
      redirectTo: '${successRedirect}',
      flash: '처리했습니다.',
    })
    redirect('${successRedirect}', {
      status: 303,
      message: '처리했습니다.',
    })
    return
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    error('${logName}:failed', {
      userId,
      error: errorMessage,
    })
  }

  dbg('${logName}:redirect', {
    status: 303,
    redirectTo: '${fallbackRedirect}',
    error: errorMessage || '처리에 실패했습니다.',
  })
  redirect('${fallbackRedirect}', {
    status: 303,
    message: errorMessage || '처리에 실패했습니다.',
  })
  return
</script>
`
}

function apiJsonTemplate(options) {
  const relativeRoutePath = normalizeRoutePath(options.kind, options.routePath)
  const logName = toLogName(relativeRoutePath)

  return `<script server>
${methodGuardCode(logName, options.method, 'json', '/', '잘못된 요청입니다.')}${authGuardCode(logName, options.auth, 'json', '/sign-in', '로그인이 필요합니다.')}  const form = ${options.method === 'GET' ? 'request.url.query' : 'body()'}
  const userId = request.auth ? String(request.auth.get('id') || '') : ''

  dbg('${logName}:start', {
    userId,
    hasForm: !!form,
  })

  try {
${authValidationCode(options.auth)}\
    // TODO: 요청 값을 검증하고 응답 payload를 구성하세요.
    const payload = {
      ok: true,
      message: '처리했습니다.',
    }

    dbg('${logName}:response', {
      status: 200,
      ok: true,
    })
    response.header('Cache-Control', 'no-store')
    response.json(200, payload)
    return
  } catch (exception) {
    const errorMessage = String(exception.message || exception)

    error('${logName}:failed', {
      userId,
      error: errorMessage,
    })
    response.json(400, {
      ok: false,
      message: errorMessage || '처리에 실패했습니다.',
    })
    return
  }
</script>
`
}

function xapiPartialTemplate(options) {
  const relativeRoutePath = normalizeRoutePath(options.kind, options.routePath)
  const logName = toLogName(relativeRoutePath)
  const partial = options.partial

  return `<script server>
${methodGuardCode(logName, options.method, 'redirect', '/', '잘못된 요청입니다.')}${authGuardCode(logName, options.auth, 'redirect', '/sign-in', '로그인이 필요합니다.')}  const form = ${options.method === 'POST' ? 'body()' : 'request.url.query'}
  const userId = request.auth ? String(request.auth.get('id') || '') : ''
  let errorMessage = ''

  dbg('${logName}:start', {
    userId,
    hasForm: !!form,
  })

  try {
    // TODO: partial에 필요한 props를 조회하세요.
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    warn('${logName}:load-failed', {
      userId,
      error: errorMessage,
    })
  }

  dbg('${logName}:response', {
    userId,
    error: errorMessage || '',
  })
</script>
<%- include('${partial}', { error: errorMessage }) %>
`
}

function xapiDatastarTemplate(options) {
  const relativeRoutePath = normalizeRoutePath(options.kind, options.routePath)
  const logName = toLogName(relativeRoutePath)

  return `<script server>
  function patchMessage(message) {
    datastar.patchSignals({
      message,
    })
  }

${methodGuardCode(logName, options.method, 'redirect', '/', '잘못된 요청입니다.')}${authGuardCode(logName, options.auth, 'redirect', '/sign-in', '로그인이 필요합니다.')}  const form = datastar.isRequest(request) ? datastar.requestSignals({}) : body()
  const userId = request.auth ? String(request.auth.get('id') || '') : ''
  let errorMessage = ''

  dbg('${logName}:start', {
    userId,
    hasForm: !!form,
  })

  try {
${authValidationCode(options.auth)}\
    // TODO: signal/form 값을 검증하고 Datastar patch 응답을 구성하세요.

    info('${logName}:success', {
      userId,
    })
    if (datastar.isRequest(request)) {
      patchMessage('')
      return
    }

    redirect('/', {
      status: 303,
    })
    return
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    error('${logName}:failed', {
      userId,
      error: errorMessage,
    })
  }

  if (datastar.isRequest(request)) {
    patchMessage(errorMessage || '처리에 실패했습니다.')
    return
  }

  redirect('/', {
    status: 303,
    message: errorMessage || '처리에 실패했습니다.',
  })
  return
</script>
`
}

function buildTemplate(options) {
  if (options.kind.id === 'xapi-redirect') return xapiRedirectTemplate(options)
  if (options.kind.id === 'api-json') return apiJsonTemplate(options)
  if (options.kind.id === 'xapi-partial') return xapiPartialTemplate(options)
  if (options.kind.id === 'xapi-datastar') return xapiDatastarTemplate(options)

  throw new Error(`Unsupported generate kind: ${options.kind.id}`)
}

async function writeRouteFile(options) {
  validateOptions(options)

  const relativeRoutePath = normalizeRoutePath(options.kind, options.routePath)
  const outputPath = path.join(options.service.pagesDir, `${relativeRoutePath}.ejs`)
  const outputDir = path.dirname(outputPath)
  const content = buildTemplate(options)

  if (options.dryRun) {
    console.log(`File: ${outputPath}`)
    console.log('')
    process.stdout.write(content)
    return {
      outputPath,
      wrote: false,
    }
  }

  if (!options.force && (await exists(outputPath))) {
    throw new Error(`File already exists: ${outputPath}\nUse --force to overwrite it.`)
  }

  await mkdir(outputDir, { recursive: true })
  await writeFile(outputPath, content, 'utf8')

  return {
    outputPath,
    wrote: true,
  }
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(1)
    return
  }

  if (parsed.help) {
    printHelp()
    return
  }

  const options = await completeOptions(parsed)
  const result = await writeRouteFile(options)

  if (result.wrote) {
    console.log('스캐폴딩 생성 완료')
    console.log(`- 서비스: ${options.service.name}`)
    console.log(`- 종류: ${options.kind.id}`)
    console.log(`- 출력: ${result.outputPath}`)
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
