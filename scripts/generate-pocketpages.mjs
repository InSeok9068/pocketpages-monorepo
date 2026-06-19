#!/usr/bin/env node
/* global console */
import { confirm, input, search, select } from '@inquirer/prompts'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
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
  --partial <name.ejs>          Optional partial name for xapi-partial
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

async function collectEjsFiles(targetDir, baseDir = targetDir) {
  const entries = await readDirSafe(targetDir)
  const files = []

  for (const entry of entries) {
    if (entry.name === 'vendor') continue

    const entryPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectEjsFiles(entryPath, baseDir)))
      continue
    }

    if (!entry.isFile() || !entry.name.endsWith('.ejs')) continue

    files.push(path.relative(baseDir, entryPath).replace(/\\/g, '/'))
  }

  return files.sort((left, right) => left.localeCompare(right))
}

async function exists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function readTextSafe(targetPath) {
  try {
    return await readFile(targetPath, 'utf8')
  } catch {
    return ''
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

async function serviceUsesDatastar(service) {
  const configPath = path.join(service.pagesDir, '+config.js')
  const config = await readTextSafe(configPath)

  return config.includes('pocketpages-plugin-datastar-v1') || config.includes('pocketpages-plugin-datastar')
}

function isInteractivePromptAvailable() {
  return !!process.stdin.isTTY && !!process.stdout.isTTY
}

function requireInteractivePrompt(message) {
  if (!isInteractivePromptAvailable()) {
    throw new Error(message)
  }
}

async function promptSelection(title, items, formatItem, getValue) {
  if (!items.length) {
    throw new Error(`${title} 항목이 없습니다.`)
  }

  const choices = items.map((item) => {
    const name = formatItem(item)
    const value = getValue ? getValue(item) : item

    return {
      name,
      value,
    }
  })

  return search({
    message: title,
    source(term) {
      const normalizedTerm = normalizeMenuAnswer(term).toLowerCase()
      if (!normalizedTerm) return choices

      return choices.filter((choice) => choice.name.toLowerCase().includes(normalizedTerm))
    },
  })
}

async function promptOptionalPartial(service) {
  const privateDir = path.join(service.pagesDir, '_private')
  const partialNames = await collectEjsFiles(privateDir)
  const noneValue = { type: 'none' }
  const choices = [
    {
      name: 'include 안 함 - TODO 자리만 생성',
      value: noneValue,
    },
    ...partialNames.map((partialName) => ({
      name: partialName,
      value: {
        type: 'partial',
        partialName,
      },
    })),
  ]

  const selected = await search({
    message: 'include할 partial을 선택하세요.',
    source(term) {
      const normalizedTerm = normalizeMenuAnswer(term).toLowerCase()
      if (!normalizedTerm) return choices

      return choices.filter((choice) => choice.name.toLowerCase().includes(normalizedTerm))
    },
  })

  if (selected.type === 'none') return ''
  return selected.partialName
}

async function completeOptions(options) {
  const services = await listServices()
  if (!services.length) {
    throw new Error('pb_hooks/pages가 있는 서비스가 없습니다.')
  }

  let service
  if (options.service) {
    const serviceName = path.basename(fromMsysPath(options.service))
    service = services.find((item) => item.name === serviceName)
    if (!service) {
      throw new Error(`Unknown service: ${options.service}`)
    }
  } else {
    requireInteractivePrompt('--service is required when running non-interactively.')
    service = await promptSelection('어떤 서비스를 대상으로 생성할까요?', services, (item) => item.name)
  }

  let kind
  if (options.kind) {
    kind = kindById.get(options.kind)
    if (!kind) {
      throw new Error(`Unknown generate kind: ${options.kind}`)
    }
  } else {
    requireInteractivePrompt('--kind is required when running non-interactively.')
    kind = await promptSelection('어떤 라우트 골격을 만들까요?', kinds, (item) => `${item.id} - ${item.label}`)
  }

  let routePath = options.routePath
  if (!routePath) {
    requireInteractivePrompt('--path is required when running non-interactively.')
    routePath = await input({
      message: `생성할 ${kind.area} 경로를 입력하세요.`,
      validate(value) {
        return normalizeMenuAnswer(value) ? true : '경로를 입력해주세요.'
      },
    })
  }

  const shouldPromptDefaults = isInteractivePromptAvailable() && (!options.service || !options.kind || !options.routePath)
  let method = options.method || kind.defaultMethod
  if (!options.method && shouldPromptDefaults) {
    method = await select({
      message: '메서드 guard를 선택하세요.',
      default: method,
      choices: [
        { name: 'POST', value: 'POST' },
        { name: 'GET', value: 'GET' },
        { name: 'ANY', value: 'ANY' },
      ],
    })
  }

  let auth = options.auth
  if (auth === null) {
    if (shouldPromptDefaults) {
      auth = await confirm({
        message: 'request.auth guard를 추가할까요?',
        default: kind.defaultAuth,
      })
    } else {
      auth = kind.defaultAuth
    }
  }

  let partial = options.partial
  if (kind.id === 'xapi-partial' && !partial && isInteractivePromptAvailable()) {
    partial = await promptOptionalPartial(service)
  }

  const usesDatastar = await serviceUsesDatastar(service)

  return {
    ...options,
    service,
    kind,
    routePath,
    method,
    auth,
    partial: toSafePartialName(partial),
    usesDatastar,
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

  if (options.partial) {
    const partialPath = options.partial.replace(/\\/g, '/')
    if (path.posix.isAbsolute(partialPath) || partialPath.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('--partial must be a safe _private-relative partial path.')
    }
  }

  if (options.kind.id === 'xapi-datastar' && !options.usesDatastar) {
    throw new Error(`${options.service.name} does not use pocketpages-plugin-datastar-v1. Add Datastar to pb_hooks/pages/+config.js before generating xapi-datastar routes.`)
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

function datastarMethodGuardCode(logName, method, invalidMethodMessage) {
  if (method === 'ANY') return ''

  return `  if (request.method !== '${method}') {
    if (datastar.isRequest(request)) {
      patchMessage('${invalidMethodMessage}')
      return
    }

    dbg('${logName}:redirect', {
      status: 303,
      redirectTo: '/',
      flash: '${invalidMethodMessage}',
    })
    redirect('/', {
      status: 303,
      message: '${invalidMethodMessage}',
    })
    return
  }

`
}

function datastarAuthGuardCode(logName, enabled, signInPath, authMessage) {
  if (!enabled) return ''

  return `  if (!request.auth) {
    if (datastar.isRequest(request)) {
      dbg('${logName}:datastar-redirect', {
        redirectTo: '${signInPath}',
        flash: '${authMessage}',
      })
      datastar.redirect('${signInPath}')
      return
    }

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
  const formSource = options.method === 'GET' ? 'request.url.query' : 'body()'

  return `<script server>
${methodGuardCode(logName, options.method, 'redirect', fallbackRedirect, '잘못된 요청입니다.')}${authGuardCode(logName, options.auth, 'redirect', '/sign-in', '로그인이 필요합니다.')}  const form = ${formSource}
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
  const responseMarkup = partial
    ? `<%- include('${partial}', {
  error: errorMessage,
  // TODO: items, viewState처럼 partial이 실제로 필요한 props만 넘기세요.
}) %>`
    : `<%# TODO: partial HTML을 반환하거나 include('partial.ejs', { error: errorMessage, items })처럼 필요한 props만 넘기세요. %>`

  return `<script server>
${methodGuardCode(logName, options.method, 'redirect', '/', '잘못된 요청입니다.')}${authGuardCode(logName, options.auth, 'redirect', '/sign-in', '로그인이 필요합니다.')}  const form = ${options.method === 'POST' ? 'body()' : 'request.url.query'}
  const userId = request.auth ? String(request.auth.get('id') || '') : ''
  let errorMessage = ''

  dbg('${logName}:start', {
    userId,
    hasForm: !!form,
  })

  try {
    // TODO: partial에 넘길 값을 명시적으로 준비하세요.
    // 예: const items = []
    // 예: const viewState = { message: errorMessage }
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
${responseMarkup}
`
}

function xapiDatastarTemplate(options) {
  const relativeRoutePath = normalizeRoutePath(options.kind, options.routePath)
  const logName = toLogName(relativeRoutePath)
  const formSource = options.method === 'GET' ? 'request.url.query' : 'body()'

  return `<script server>
  function patchMessage(message) {
    datastar.patchSignals({
      message,
    })
  }

${datastarMethodGuardCode(logName, options.method, '잘못된 요청입니다.')}${datastarAuthGuardCode(logName, options.auth, '/sign-in', '로그인이 필요합니다.')}  const form = datastar.isRequest(request) ? datastar.requestSignals({}) : ${formSource}
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

    dbg('${logName}:redirect', {
      status: 303,
      redirectTo: '/',
    })
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

  dbg('${logName}:redirect', {
    status: 303,
    redirectTo: '/',
    flash: errorMessage || '처리에 실패했습니다.',
  })
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
    console.log('생성 완료')
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
