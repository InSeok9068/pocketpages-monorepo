#!/usr/bin/env node
/* global console */
import { checkbox, confirm, input, select } from '@inquirer/prompts'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const appsDir = path.join(rootDir, 'apps')
const downloadDir = path.join(rootDir, '.download')
const vendorDir = path.join(scriptDir, 'vendor')

const featureIds = ['htmx', 'alpine', 'unocss', 'datastar', 'realtime']
const defaultFeatures = ['htmx', 'alpine', 'unocss']
const vendorByFeature = {
  htmx: ['htmx-2.0.10.min.js'],
  alpine: ['alpine-3.15.11-cdn.min.js'],
  datastar: ['datastar.min.js'],
  unocss: ['preset-wind3-66.5.12.global.js', 'preset-icons-66.5.12.global.js', 'iconify-lucide-1.2.107.icons.json', 'unocss-core-66.5.12.global.js'],
}
const vendorByFeaturePair = {
  'htmx+realtime': ['pocketbase-htmx-ext-sse-0.0.3.js'],
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/new-pocketpages-service.mjs [service] [options]

Options:
  --service <name>              Service name under apps/
  --auth / --no-auth            Include or skip password auth scaffold
  --features <list>             Comma list: htmx,alpine,unocss,datastar,realtime,none
  --install / --skip-install    Run or skip npm install in the new service
  --copy-binaries               Copy pbw/pocketbase binaries from an existing service when found
  --skip-binaries               Skip binary copy
  --dry-run                     Print the creation plan without writing files
  -h, --help                    Show this help

Examples:
  ./task.sh new
  ./task.sh new my-service --auth --features htmx,alpine,unocss
  ./task.sh new my-service --no-auth --features htmx --skip-install
`)
}

function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`
  }

  return value
}

function parseArgs(argv) {
  const options = {
    service: '',
    auth: null,
    features: null,
    install: null,
    copyBinaries: null,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (value === '-h' || value === '--help') {
      options.help = true
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

    if (value === '--install') {
      options.install = true
      continue
    }

    if (value === '--skip-install' || value === '--no-install') {
      options.install = false
      continue
    }

    if (value === '--copy-binaries') {
      options.copyBinaries = true
      continue
    }

    if (value === '--skip-binaries' || value === '--no-binaries') {
      options.copyBinaries = false
      continue
    }

    const nextValue = argv[index + 1]
    if (value === '--service') {
      options.service = requiredOptionValue(value, nextValue)
      index += 1
      continue
    }

    if (value === '--features') {
      options.features = parseFeatureList(requiredOptionValue(value, nextValue))
      index += 1
      continue
    }

    if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`)
    }

    if (!options.service) {
      options.service = value
      continue
    }

    throw new Error(`Unexpected argument: ${value}`)
  }

  return options
}

function requiredOptionValue(optionName, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`)
  }

  return value
}

function parseFeatureList(value) {
  const rawItems = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

  if (!rawItems.length || rawItems.includes('none')) return []

  const unknown = rawItems.filter((item) => !featureIds.includes(item))
  if (unknown.length) {
    throw new Error(`Unknown feature: ${unknown.join(', ')}`)
  }

  return Array.from(new Set(rawItems))
}

function isInteractivePromptAvailable() {
  return !!process.stdin.isTTY && !!process.stdout.isTTY
}

function requireInteractivePrompt(message) {
  if (!isInteractivePromptAvailable()) {
    throw new Error(message)
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

function normalizeServiceName(value) {
  return path.basename(fromMsysPath(String(value || '').trim()))
}

function validateServiceName(service) {
  if (!service) {
    throw new Error('Service name is required.')
  }

  if (!/^[a-z][a-z0-9-]*$/.test(service)) {
    throw new Error('Service name must match ^[a-z][a-z0-9-]*$.')
  }
}

async function completeOptions(options) {
  let service = normalizeServiceName(options.service)
  if (!service) {
    requireInteractivePrompt('--service or positional service is required when running non-interactively.')
    service = await input({
      message: '서비스명을 입력하세요.',
      validate(value) {
        try {
          validateServiceName(normalizeServiceName(value))
          return true
        } catch (error) {
          return error.message
        }
      },
    })
    service = normalizeServiceName(service)
  }

  validateServiceName(service)

  let auth = options.auth
  if (auth === null) {
    if (isInteractivePromptAvailable()) {
      auth = await confirm({
        message: '인증 scaffold를 추가할까요?',
        default: false,
      })
    } else {
      auth = false
    }
  }

  let features = options.features
  if (features === null) {
    if (isInteractivePromptAvailable()) {
      features = await checkbox({
        message: '사용할 프론트 기능을 선택하세요.',
        required: false,
        choices: [
          { name: 'HTMX', value: 'htmx', checked: true },
          { name: 'Alpine.js', value: 'alpine', checked: true },
          { name: 'UnoCSS', value: 'unocss', checked: true },
          { name: 'Datastar', value: 'datastar', checked: false },
          { name: 'Realtime', value: 'realtime', checked: false },
        ],
      })
    } else {
      features = defaultFeatures
    }
  }

  const normalizedFeatures = Array.from(new Set(features)).filter((feature) => featureIds.includes(feature))

  let copyBinaries = options.copyBinaries
  if (copyBinaries === null) {
    copyBinaries = true
  }

  let install = options.install
  if (install === null) {
    install = isInteractivePromptAvailable()
      ? await confirm({
          message: '생성 후 서비스 npm install을 실행할까요?',
          default: true,
        })
      : false
  }

  return {
    ...options,
    service,
    auth,
    features: normalizedFeatures,
    install,
    copyBinaries,
  }
}

function hasFeature(options, feature) {
  return options.features.includes(feature)
}

function buildPackageJson(options) {
  const dependencies = {
    '@pocketpages/utils': 'file:../../packages/utils',
    pocketpages: '^0.22.3',
    'pocketpages-plugin-ejs': '^0.1.2',
  }

  if (options.auth) {
    dependencies['@pocketpages/auth-cookie'] = 'file:../../packages/auth-cookie'
    dependencies['pocketpages-plugin-auth'] = '^0.2.2'
    dependencies['pocketpages-plugin-js-sdk'] = '^0.2.0'
  }

  if (hasFeature(options, 'datastar')) {
    dependencies['pocketpages-plugin-datastar-v1'] = 'file:../../packages/pocketpages-plugin-datastar-v1'
  }
  if (hasFeature(options, 'realtime')) {
    dependencies['pocketpages-plugin-realtime'] = '^0.2.0'
  }

  return `${JSON.stringify(
    {
      name: options.service,
      private: true,
      scripts: {
        postinstall:
          "node -e \"try{const r=require('child_process').spawnSync(process.execPath,['../../scripts/run-patch-package.js'],{encoding:'utf8'});if(r.status===0){if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr)}else{console.log('patch script not available, skip')}}catch(e){console.log('patch script not available, skip')}\"",
      },
      dependencies,
      devDependencies: {
        'patch-package': '^8.0.1',
      },
    },
    null,
    2
  )}\n`
}

function buildConfigJs(options) {
  const plugins = ['pocketpages-plugin-ejs']
  if (hasFeature(options, 'datastar')) plugins.push('pocketpages-plugin-datastar-v1')
  if (hasFeature(options, 'realtime')) plugins.push('pocketpages-plugin-realtime')
  if (options.auth) {
    plugins.push('pocketpages-plugin-js-sdk')
    plugins.push('pocketpages-plugin-auth')
  }
  const pluginList = `[${plugins.map((plugin) => `'${plugin}'`).join(', ')}]`

  return `module.exports = function (api) {
  const appEnv = String(api.env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'

  return {
    plugins: ${pluginList},
    debug: isDevelopment,
  }
}
`
}

function buildMiddlewareJs(options) {
  return `/**
 * API 경로 여부를 판단합니다.
 * @param {string} pathname 확인할 경로
 * @returns {boolean}
 */
function isApiPath(pathname) {
  return pathname.startsWith('/api/')
}

/**
 * xapi 경로 여부를 판단합니다.
 * @param {string} pathname 확인할 경로
 * @returns {boolean}
 */
function isXapiPath(pathname) {
  return pathname.startsWith('/xapi/')
}

/**
 * HTMX 요청 여부를 판단합니다.
 * @param {import('pocketpages').PagesRequest} request 요청 객체
 * @returns {boolean}
 */
function isHtmxRequest(request) {
  return String(request.header('HX-Request') || '').toLowerCase() === 'true'
}

/**
 * HTML 표시 문자열을 이스케이프합니다.
 * @param {string} value 표시할 문자열
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 오류 페이지 HTML을 반환합니다.
 * @param {string} title 제목
 * @param {string} message 안내 문구
 * @param {string} detail 상세 문구
 * @returns {string}
 */
function renderErrorPage(title, message, detail) {
  const detailHtml = detail ? '<pre style="margin-top:16px;white-space:pre-wrap;border-radius:8px;background:#fff7ed;padding:16px;color:#7c2d12;">' + escapeHtml(detail) + '</pre>' : ''

  return (
    '<!doctype html>' +
    '<html lang="ko">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' +
    escapeHtml(title) +
    '</title>' +
    '</head>' +
    '<body style="margin:0;min-height:100vh;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
    '<main style="box-sizing:border-box;width:min(720px,100%);margin:0 auto;padding:48px 20px;">' +
    '<p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.12em;color:#64748b;text-transform:uppercase;">${options.service}</p>' +
    '<h1 style="margin:0;font-size:28px;line-height:1.25;">' +
    escapeHtml(title) +
    '</h1>' +
    '<p style="margin:14px 0 0;font-size:16px;line-height:1.7;color:#475569;">' +
    escapeHtml(message) +
    '</p>' +
    '<p style="margin:24px 0 0;"><a href="/" style="color:#0f172a;font-weight:700;text-decoration:none;">홈으로 이동</a></p>' +
    detailHtml +
    '</main>' +
    '</body>' +
    '</html>'
  )
}

/**
 * HTMX 오류 조각을 반환합니다.
 * @param {string} message 안내 문구
 * @returns {string}
 */
function renderHtmxErrorAlert(message) {
  return '<div><strong>오류</strong><span>' + escapeHtml(message) + '</span></div>'
}

/** @type {PocketPagesNextMiddlewareFunc} */
module.exports = function (api, next) {
  const { dbg, env, error, request, redirect, response } = api
  const pathname = String(request.url.pathname || '')
  const appEnv = String(env('APP_ENV') || 'development').trim()
  const isDevelopment = appEnv === 'development'
  const fallbackMessage = '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.'

  try {
    next()
  } catch (exception) {
    const errorMessage = String(exception && exception.message ? exception.message : exception)

    error('${options.service}/global-error-boundary:caught', {
      pathname: pathname,
      method: String(request.method || ''),
      error: errorMessage,
    })

    if (isApiPath(pathname)) {
      return response.json(500, {
        ok: false,
        message: isDevelopment ? errorMessage : fallbackMessage,
      })
    }

    if (isXapiPath(pathname)) {
      if (isHtmxRequest(request)) {
        return response.html(200, renderHtmxErrorAlert(fallbackMessage))
      }

      dbg('${options.service}/global-error-boundary:redirect', {
        status: 303,
        redirectTo: '/',
        flash: fallbackMessage,
      })
      return redirect('/', {
        status: 303,
        message: fallbackMessage,
      })
    }

    return response.html(500, renderErrorPage('페이지를 불러오지 못했습니다.', fallbackMessage, isDevelopment ? errorMessage : ''))
  }
}
`
}

function buildLayoutEjs(options) {
  const isUno = hasFeature(options, 'unocss')
  const isDatastar = hasFeature(options, 'datastar')
  const scripts = []
  if (hasFeature(options, 'htmx')) scripts.push('<script src="<%= asset(\'/assets/vendor/htmx-2.0.10.min.js\') %>"></script>')
  if (hasFeature(options, 'htmx') && hasFeature(options, 'realtime')) {
    scripts.push('<script src="<%= asset(\'/assets/vendor/pocketbase-htmx-ext-sse-0.0.3.js\') %>"></script>')
  }
  if (hasFeature(options, 'alpine')) scripts.push('<script defer src="<%= asset(\'/assets/vendor/alpine-3.15.11-cdn.min.js\') %>"></script>')

  const unoHead = isUno ? "    <%- include('unocss-head.ejs', { isProduction }) %>\n" : ''
  const datastarHead = isDatastar ? `    <%- datastar.scripts(${hasFeature(options, 'realtime') ? '{ realtime: true }' : ''}) %>\n` : ''
  const bodyAttrs = isUno ? '\n    un-cloak' : ''

  return `<% const isProduction = String(env('APP_ENV') || 'development').trim() === 'production' %>
<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
    <title><%= meta('title') %></title>
    <meta
      name="description"
      content="<%= meta('description') %>" />
    <link
      rel="stylesheet"
      href="<%= asset('/assets/style.css') %>" />
${unoHead}${datastarHead}${scripts.map((script) => `    ${script}`).join('\n')}${scripts.length ? '\n' : ''}    <%- slots.head %>
  </head>

  <body${bodyAttrs}>
    <main><%- slots.body || slot %></main>
  </body>
</html>
`
}

function buildIndexEjs(options) {
  return `<script server>
  meta('title', '${options.service}')
  meta('description', '${options.service} 서비스 홈')
</script>

<header>
  <p>${options.service}</p>
  <h1>${options.service}</h1>
  <p>새 PocketPages 서비스를 시작하는 기본 화면입니다.</p>
</header>

<%- include('flash-alert.ejs', { flashMessage: params.__flash }) %>

<section>
  <article>
    <h2>SSR route</h2>
    <p>페이지 전용 로직은 page 파일에 두고, 공유 처리는 middleware와 _private 모듈로 옮깁니다.</p>
  </article>

  <article>
    <h2>Next step</h2>
    <p>도메인 컬렉션과 route를 추가하면서 서비스를 확장하세요.</p>
  </article>
</section>
`
}

function buildStyleCss() {
  return `@view-transition {
  navigation: auto;
}
`
}

function buildUnoHeadEjs() {
  return `<% if (isProduction) { %>
<link
  rel="stylesheet"
  href="<%= asset('/assets/uno.min.css') %>" />
<% } else { %>
<style>
  [un-cloak] {
    display: none !important;
  }
</style>
<script src="<%= asset('/assets/vendor/preset-wind3-66.5.12.global.js') %>"></script>
<script src="<%= asset('/assets/vendor/preset-icons-66.5.12.global.js') %>"></script>
<script>
  let lucideIcons

  window.__unocss = {
    presets: [
      () => window.__unocss_runtime.presets.presetWind3(),
      () =>
        window.__unocss_runtime.presets.presetIcons({
          collections: {
            lucide: () => {
              lucideIcons = lucideIcons || fetch('<%= asset('/assets/vendor/iconify-lucide-1.2.107.icons.json') %>').then((response) => response.json())

              return lucideIcons
            },
          },
        }),
    ],
    ready: () => {
      document.body.removeAttribute('un-cloak')
    },
  }
</script>
<script src="<%= asset('/assets/vendor/unocss-core-66.5.12.global.js') %>"></script>
<% } %>
`
}

function buildFlashAlertEjs() {
  return `<%
  const displayMessage = typeof flashMessage === 'undefined' || flashMessage === null ? '' : String(flashMessage).trim()
%>
<% if (displayMessage) { %>
<div><%= displayMessage %></div>
<% } %>
`
}

function buildJsConfig() {
  return `{
  "include": ["pb_data/types.d.ts", "pocketpages-globals.d.ts", "types.d.ts", "pb_hooks/**/*.ejs", "pb_hooks/**/*.js"],
  "exclude": ["node_modules/**", "pb_hooks/pages/assets/**", "pb_hooks/pages/**/vendor/**"],
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "target": "es6",
    "module": "commonjs",
    "allowSyntheticDefaultImports": true,
    "maxNodeModuleJsDepth": 0,
    "skipLibCheck": true
  }
}
`
}

function buildPocketPagesGlobals(options) {
  const datastarImport = hasFeature(options, 'datastar') ? "import type DatastarPlugin = require('pocketpages-plugin-datastar-v1')\n" : ''
  const realtimeImport = hasFeature(options, 'realtime') ? "import type { Client, ClientId, RealtimeFilter, RealtimeOptions } from 'pocketpages-plugin-realtime'\n" : ''
  const datastarTypes = hasFeature(options, 'datastar')
    ? `
type PocketPagesDatastarApi = DatastarPlugin.DatastarApi
type PocketPagesEditorApi<TData = any> = PagesRequestContext<TData> & {
  datastar: PocketPagesDatastarApi
}
`
    : `
type PocketPagesEditorApi<TData = any> = PagesRequestContext<TData>
`
  const authTypes = options.auth
    ? `
type PocketPagesAuthOptions = {
  collection?: string
}
type PocketPagesAuthVerificationOptions = {
  collection?: string
  sendVerificationEmail?: boolean
}
type PocketPagesOAuth2RequestOptions = {
  collection?: string
  cookieName?: string
  redirectPath?: string
  autoRedirect?: boolean
}
type PocketPagesOAuth2ConfirmOptions = {
  collection?: string
  cookieName?: string
}
type PocketPagesAuthData = {
  token: string
  record: core.Record
}
type PocketPagesRegisterAuthData = {
  token: string
  user: core.Record
  record?: core.Record
}
type PocketPagesAnonymousUserData = {
  email: string
  password: string
  user: core.Record
}
type PocketPagesPasswordlessUserData = {
  password: string
  user: core.Record
}
type PocketPagesOtpRequestData = {
  otpId: string
}
type PocketPagesPocketBasePasswordAuthResult = {
  token: string
  record: any
}
type PocketPagesPocketBaseClient = {
  collection: (name: string) => {
    authWithPassword: (email: string, password: string) => PocketPagesPocketBasePasswordAuthResult
  }
}
type PocketPagesPocketBaseCtor = new (baseUrl?: string, authStore?: any, lang?: string) => PocketPagesPocketBaseClient
`
    : ''
  const realtimeTypes = hasFeature(options, 'realtime')
    ? `
type PocketPagesRealtimeApi = {
  getClientById: (clientId: ClientId) => Client | undefined
  send: (topic: string, message: string, options?: RealtimeOptions) => void
}
type PocketPagesRealtimeClient = Client
type PocketPagesRealtimeClientId = ClientId
type PocketPagesRealtimeFilter = RealtimeFilter
type PocketPagesRealtimeOptions = RealtimeOptions
`
    : ''
  const authGlobals = options.auth
    ? `
  // \`pocketpages-plugin-auth\` auth helpers
  const createUser: (email: string, password: string, options?: PocketPagesAuthVerificationOptions) => core.Record
  const createAnonymousUser: (options?: PocketPagesAuthOptions) => PocketPagesAnonymousUserData
  const createPasswordlessUser: (email: string, options?: PocketPagesAuthVerificationOptions) => PocketPagesPasswordlessUserData
  const signInWithPassword: (email: string, password: string, options?: PocketPagesAuthOptions) => PocketPagesAuthData
  const registerWithPassword: (email: string, password: string, options?: PocketPagesAuthVerificationOptions) => PocketPagesRegisterAuthData
  const signInAnonymously: (options?: PocketPagesAuthOptions) => PocketPagesAuthData
  const requestOTP: (email: string, options?: PocketPagesAuthOptions) => PocketPagesOtpRequestData
  const signInWithOTP: (otpId: string, password: string, options?: PocketPagesAuthOptions) => PocketPagesAuthData
  const signInWithToken: (token: string) => void
  const requestOAuth2Login: (providerName: string, options?: PocketPagesOAuth2RequestOptions) => string
  const signInWithOAuth2: (state: string, code: string, options?: PocketPagesOAuth2ConfirmOptions) => PocketPagesAuthData
  const signOut: () => void
  const requestVerification: (email: string, options?: PocketPagesAuthOptions) => void
  const confirmVerification: (token: string, options?: PocketPagesAuthOptions) => void
`
    : ''
  const datastarGlobal = hasFeature(options, 'datastar')
    ? `
  // \`pocketpages-plugin-datastar-v1\` runtime helper
  const datastar: PocketPagesDatastarApi
`
    : ''
  const realtimeGlobal = hasFeature(options, 'realtime')
    ? `
  // \`pocketpages-plugin-realtime\` runtime helper
  const realtime: PocketPagesRealtimeApi
`
    : ''

  return `import type { MiddlewareNextFunc, PagesGlobalContext, PagesRequestContext, PagesResponse } from 'pocketpages'
${datastarImport}${realtimeImport}
// Editor-only mirror for globals injected by PocketPages core and plugins in
// \`pb_hooks/pages/+config.js\`.
${datastarTypes}${authTypes}${realtimeTypes}
type PocketPagesEditorResponse = PagesResponse & {
  // Repo code uses response.status(...) inside <script server>.
  status: (status: number) => void
}

declare module 'pocketpages' {
  export const globalApi: PagesGlobalContext
}
${options.auth ? "\ndeclare module 'pocketbase-js-sdk-jsvm' {\n  const PocketBase: PocketPagesPocketBaseCtor\n  export = PocketBase\n}\n" : ''}

declare global {
  const process: {
    env: Record<string, string | undefined>
  }
  interface PocketPagesRouteParams {}
  type PocketPagesNextMiddlewareFunc<TData = any> = (api: PagesRequestContext<TData>, next: MiddlewareNextFunc) => void

  // \`pocketpages\` core request/context globals
  const api: PocketPagesEditorApi<any>
  const asset: PocketPagesEditorApi<any>['asset']
  const auth: PocketPagesEditorApi<any>['auth']
  const data: PocketPagesEditorApi<any>['data']
  const echo: PocketPagesEditorApi<any>['echo']
  const formData: () => any
  const body: () => any
  const meta: PocketPagesEditorApi<any>['meta']
  const params: PocketPagesEditorApi<any>['params'] & PocketPagesRouteParams
  const redirect: PocketPagesEditorApi<any>['redirect']
  const request: PocketPagesEditorApi<any>['request']
  const resolve: PocketPagesEditorApi<any>['resolve']
  const response: PocketPagesEditorResponse
  const slot: PocketPagesEditorApi<any>['slot']
  const slots: PocketPagesEditorApi<any>['slots']
${authGlobals}
  // \`pocketpages\` core global helpers
  const url: PagesGlobalContext['url']
  const stringify: PagesGlobalContext['stringify']
  const env: PagesGlobalContext['env']
  const store: PagesGlobalContext['store']
  const dbg: PagesGlobalContext['dbg']
  const info: PagesGlobalContext['info']
  const warn: PagesGlobalContext['warn']
  const error: PagesGlobalContext['error']

  // \`pocketpages-plugin-ejs\` template helper
  const include: (path: string, data?: Record<string, any>) => string
${datastarGlobal}${realtimeGlobal}}

export {}
`
}

function buildDockerfile(options) {
  const service = options.service
  const cssStage = hasFeature(options, 'unocss')
    ? `
FROM node:24-bookworm-slim AS css

WORKDIR /app
COPY package*.json ./
COPY task.sh ./
COPY unocss.config.js ./
COPY packages /app/packages
COPY apps/${service}/pb_hooks ./apps/${service}/pb_hooks
RUN npm ci
RUN bash ./task.sh css ${service}
`
    : ''
  const cssCopy = hasFeature(options, 'unocss') ? `COPY --from=css /app/apps/${service}/pb_hooks/pages/assets/uno.min.css ./pb_hooks/pages/assets/uno.min.css\n` : ''

  return `FROM node:24-bookworm-slim AS deps

WORKDIR /app/apps/${service}
COPY apps/${service}/package*.json ./
COPY packages /app/packages
RUN cd /app/packages/utils && npm ci --omit=dev
RUN npm ci --omit=dev
${cssStage}
FROM alpine:3.22 AS pocketbase

ARG TARGETARCH

RUN apk add --no-cache ca-certificates curl unzip
RUN set -eu; \\
  case "\${TARGETARCH}" in \\
    amd64|arm64) PB_ARCH="\${TARGETARCH}" ;; \\
    *) echo "Unsupported TARGETARCH: \${TARGETARCH}"; exit 1 ;; \\
  esac \\
  && CURL_RETRY="--retry 5 --retry-delay 5 --retry-max-time 120 --retry-all-errors --retry-connrefused" \\
  && PB_VERSION="$(curl -fsSL \${CURL_RETRY} https://api.github.com/repos/pocketbase/pocketbase/releases/latest | tr -d '\\n' | sed -n 's/.*\\"tag_name\\"[[:space:]]*:[[:space:]]*\\"v\\([^\\"]*\\)\\".*/\\1/p')" \\
  && if [ -z "\${PB_VERSION}" ]; then echo "Failed to resolve PocketBase version"; exit 1; fi \\
  && curl -fsSL \${CURL_RETRY} -o /tmp/pocketbase.zip \\
    "https://github.com/pocketbase/pocketbase/releases/download/v\${PB_VERSION}/pocketbase_\${PB_VERSION}_linux_\${PB_ARCH}.zip" \\
  && unzip /tmp/pocketbase.zip -d /out \\
  && chmod +x /out/pocketbase

FROM alpine:3.22

ENV CODE_ROOT=/app/apps/${service}
ENV APP_ROOT=/app/apps/${service}

WORKDIR /app/apps/${service}

RUN apk add --no-cache ca-certificates

COPY apps/${service}/. .
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/apps/${service}/node_modules ./node_modules
${cssCopy}COPY --from=pocketbase /out/pocketbase /usr/local/bin/pocketbase
RUN mkdir -p /opt/defaults/pb_hooks \\
  && if [ -d "\${CODE_ROOT}/pb_hooks" ]; then cp -R "\${CODE_ROOT}/pb_hooks/." /opt/defaults/pb_hooks/; fi

RUN cat <<'EOF' > /usr/local/bin/start.sh
#!/bin/sh
set -eu

PB_DATA="\${APP_ROOT}/pb_data"
PB_HOOKS="\${APP_ROOT}/pb_hooks"
PB_PUBLIC="\${APP_ROOT}/pb_public"
PB_MIGRATIONS="\${APP_ROOT}/pb_migrations"
INIT_MARKER="\${PB_DATA}/.superuser_initialized"

mkdir -p "\${PB_DATA}"
mkdir -p "\${PB_HOOKS}"

if [ -z "$(ls -A "\${PB_HOOKS}" 2>/dev/null)" ] && [ -d /opt/defaults/pb_hooks ]; then
  cp -R /opt/defaults/pb_hooks/. "\${PB_HOOKS}/"
fi

if [ -n "\${PB_ADMIN_EMAIL:-}" ] && [ -n "\${PB_ADMIN_PASSWORD:-}" ] && [ ! -f "\${INIT_MARKER}" ]; then
  echo "Initializing PocketBase superuser..."
  pocketbase --dir="\${PB_DATA}" superuser create "\${PB_ADMIN_EMAIL}" "\${PB_ADMIN_PASSWORD}" || true
  touch "\${INIT_MARKER}"
fi

exec pocketbase serve \\
  --dir="\${PB_DATA}" \\
  --hooksDir="\${PB_HOOKS}" \\
  --publicDir="\${PB_PUBLIC}" \\
  --migrationsDir="\${PB_MIGRATIONS}" \\
  --http=0.0.0.0:8090
EOF

RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8090

CMD ["/usr/local/bin/start.sh"]
`
}

function buildRootTest(options) {
  return `import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { load } from 'cheerio'

import { startService } from '@pocketpages/test-support/service-harness'

let service

before(async () => {
  service = await startService({
    serviceName: '${options.service}',
  })
})

after(async () => {
  if (service) {
    await service.stop()
  }
})

test('GET / returns the ${options.service} home page', async () => {
  const response = await fetch(\`\${service.baseUrl}/\`)
  const body = await response.text()
  const $ = load(body)

  assert.equal(response.status, 200)
  assert.equal($('h1').first().text().trim(), '${options.service}')
})
`
}

function buildSignInPage(options) {
  return `<script server>
  meta('title', '${options.service} 로그인')
  meta('description', '${options.service} 로그인')

  if (request.auth) {
    dbg('${options.service}/sign-in:redirect', {
      status: 303,
      redirectTo: '/',
    })
    redirect('/', {
      status: 303,
    })
    return
  }
</script>

<section>
  <h1>로그인</h1>

  <%- include('flash-alert.ejs', { flashMessage: params.__flash }) %>

  <form
    method="post"
    action="/xapi/auth/sign-in">
    <label>
      이메일
      <input
        type="email"
        name="email"
        required
        placeholder="me@example.com" />
    </label>

    <label>
      비밀번호
      <input
        type="password"
        name="password"
        required
        placeholder="비밀번호" />
    </label>

    <button type="submit">로그인</button>
  </form>

  <a href="/sign-up">회원가입</a>
</section>
`
}

function buildSignUpPage(options) {
  return `<script server>
  meta('title', '${options.service} 회원가입')
  meta('description', '${options.service} 회원가입')

  if (request.auth) {
    dbg('${options.service}/sign-up:redirect', {
      status: 303,
      redirectTo: '/',
    })
    redirect('/', {
      status: 303,
    })
    return
  }
</script>

<section>
  <h1>회원가입</h1>

  <%- include('flash-alert.ejs', { flashMessage: params.__flash }) %>

  <form
    method="post"
    action="/xapi/auth/sign-up">
    <label>
      이메일
      <input
        type="email"
        name="email"
        required
        placeholder="me@example.com" />
    </label>

    <label>
      비밀번호
      <input
        type="password"
        name="password"
        required
        minlength="8"
        placeholder="8자 이상" />
    </label>

    <label>
      비밀번호 확인
      <input
        type="password"
        name="passwordConfirm"
        required
        minlength="8"
        placeholder="비밀번호 확인" />
    </label>

    <button type="submit">가입</button>
  </form>

  <a href="/sign-in">로그인</a>
</section>
`
}

function buildSignInAction(options) {
  return `<script server>
  const { createAuthCookie } = require('@pocketpages/auth-cookie')
  const authCookie = createAuthCookie()

  if (request.method !== 'POST') {
    dbg('${options.service}/xapi/auth/sign-in:redirect', {
      status: 303,
      redirectTo: '/sign-in',
      flash: '잘못된 요청입니다.',
    })
    redirect('/sign-in', {
      status: 303,
      message: '잘못된 요청입니다.',
    })
    return
  }

  const form = body()
  const email = String(form.email || '').trim()
  const password = form.password === undefined || form.password === null ? '' : String(form.password)
  let errorMessage = ''

  dbg('${options.service}/xapi/auth/sign-in:start', {
    email,
  })

  try {
    if (!email) throw new Error('이메일이 필요합니다.')
    if (!password) throw new Error('비밀번호가 필요합니다.')

    const authData = signInWithPassword(email, password)
    authCookie.writeAuthCookie(response, authData)

    dbg('${options.service}/xapi/auth/sign-in:response', {
      status: 303,
      redirectTo: '/',
      authId: String((authData.record && authData.record.id) || ''),
    })
    redirect('/', {
      status: 303,
    })
    return
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    error('${options.service}/xapi/auth/sign-in:failed', {
      email,
      error: errorMessage,
    })
  }

  dbg('${options.service}/xapi/auth/sign-in:response', {
    status: 303,
    redirectTo: '/sign-in',
    flash: errorMessage || '로그인에 실패했습니다.',
  })
  redirect('/sign-in', {
    status: 303,
    message: errorMessage || '로그인에 실패했습니다.',
  })
  return
</script>
`
}

function buildSignUpAction(options) {
  return `<script server>
  const { createAuthCookie } = require('@pocketpages/auth-cookie')
  const authCookie = createAuthCookie()

  if (request.method !== 'POST') {
    dbg('${options.service}/xapi/auth/sign-up:redirect', {
      status: 303,
      redirectTo: '/sign-up',
      flash: '잘못된 요청입니다.',
    })
    redirect('/sign-up', {
      status: 303,
      message: '잘못된 요청입니다.',
    })
    return
  }

  const form = body()
  const email = String(form.email || '')
    .trim()
    .toLowerCase()
  const password = form.password === undefined || form.password === null ? '' : String(form.password)
  const passwordConfirm = form.passwordConfirm === undefined || form.passwordConfirm === null ? '' : String(form.passwordConfirm)
  let errorMessage = ''

  dbg('${options.service}/xapi/auth/sign-up:start', {
    email,
  })

  try {
    if (!email) throw new Error('이메일이 필요합니다.')
    if (!password) throw new Error('비밀번호가 필요합니다.')
    if (password.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.')
    if (password !== passwordConfirm) throw new Error('비밀번호 확인이 일치하지 않습니다.')

    createUser(email, password, {
      collection: 'users',
      sendVerificationEmail: false,
    })

    const authData = signInWithPassword(email, password)
    authCookie.writeAuthCookie(response, authData)

    dbg('${options.service}/xapi/auth/sign-up:response', {
      status: 303,
      redirectTo: '/',
      authId: String((authData.record && authData.record.id) || ''),
    })
    redirect('/', {
      status: 303,
    })
    return
  } catch (exception) {
    errorMessage = String(exception.message || exception)
    error('${options.service}/xapi/auth/sign-up:failed', {
      email,
      error: errorMessage,
    })
  }

  dbg('${options.service}/xapi/auth/sign-up:response', {
    status: 303,
    redirectTo: '/sign-up',
    flash: errorMessage || '회원가입에 실패했습니다.',
  })
  redirect('/sign-up', {
    status: 303,
    message: errorMessage || '회원가입에 실패했습니다.',
  })
  return
</script>
`
}

function buildSignOutAction(options) {
  return `<script server>
  const { createAuthCookie } = require('@pocketpages/auth-cookie')
  const authCookie = createAuthCookie()

  if (request.method !== 'POST') {
    dbg('${options.service}/xapi/auth/sign-out:redirect', {
      status: 303,
      redirectTo: '/',
      flash: '잘못된 요청입니다.',
    })
    redirect('/', {
      status: 303,
      message: '잘못된 요청입니다.',
    })
    return
  }

  dbg('${options.service}/xapi/auth/sign-out:start', {
    isSignedIn: !!request.auth,
  })

  authCookie.signOut(response)

  dbg('${options.service}/xapi/auth/sign-out:response', {
    status: 303,
    redirectTo: '/sign-in',
    flash: '로그아웃 완료',
  })
  redirect('/sign-in', {
    status: 303,
    message: '로그아웃 완료',
  })
  return
</script>
`
}

function buildPlan(options) {
  const serviceDir = path.join(appsDir, options.service)
  const files = [
    ['.env', 'APP_ENV=development\n'],
    ['package.json', buildPackageJson(options)],
    ['Dockerfile', buildDockerfile(options)],
    ['jsconfig.json', buildJsConfig()],
    ['types.d.ts', 'declare namespace types {}\n'],
    ['pocketpages-globals.d.ts', buildPocketPagesGlobals(options)],
    ['pb_schema.json', '[]\n'],
    ['pb_hooks/pocketpages.pb.js', "require('pocketpages')\n"],
    ['pb_hooks/pages/+config.js', buildConfigJs(options)],
    ['pb_hooks/pages/+middleware.js', buildMiddlewareJs(options)],
    ['pb_hooks/pages/(site)/+layout.ejs', buildLayoutEjs(options)],
    ['pb_hooks/pages/(site)/index.ejs', buildIndexEjs(options)],
    ['pb_hooks/pages/assets/style.css', buildStyleCss()],
    ['pb_hooks/pages/_private/flash-alert.ejs', buildFlashAlertEjs()],
    ['__tests__/root-route.test.mjs', buildRootTest(options)],
  ]

  if (hasFeature(options, 'unocss')) {
    files.push(['pb_hooks/pages/_private/unocss-head.ejs', buildUnoHeadEjs()])
  }

  if (options.auth) {
    files.push(['pb_hooks/pages/(site)/sign-in.ejs', buildSignInPage(options)])
    files.push(['pb_hooks/pages/(site)/sign-up.ejs', buildSignUpPage(options)])
    files.push(['pb_hooks/pages/xapi/auth/sign-in.ejs', buildSignInAction(options)])
    files.push(['pb_hooks/pages/xapi/auth/sign-up.ejs', buildSignUpAction(options)])
    files.push(['pb_hooks/pages/xapi/auth/sign-out.ejs', buildSignOutAction(options)])
  }

  const copies = []
  const vendorNames = Array.from(new Set(options.features.flatMap((feature) => vendorByFeature[feature] || [])))
  if (hasFeature(options, 'htmx') && hasFeature(options, 'realtime')) {
    vendorNames.push(...vendorByFeaturePair['htmx+realtime'])
  }
  for (const vendorName of vendorNames) {
    copies.push({
      from: path.join(vendorDir, vendorName),
      to: path.join(serviceDir, 'pb_hooks', 'pages', 'assets', 'vendor', vendorName),
    })
  }

  if (options.copyBinaries) {
    const binaryCopies = buildBinaryCopies(serviceDir)
    copies.push(...binaryCopies)
  }

  return {
    service: options.service,
    serviceDir,
    files: files.map(([relativePath, content]) => ({
      relativePath,
      path: path.join(serviceDir, ...relativePath.split('/')),
      content,
    })),
    copies,
    postSteps: buildPostSteps(options, serviceDir),
  }
}

function buildBinaryCopies(serviceDir) {
  const candidates = [
    ['pbw.exe', 'pocketbase.exe'],
    ['pbw', 'pocketbase'],
  ]

  for (const names of candidates) {
    const sources = names.map((name) => path.join(downloadDir, name))
    if (sources.every((source) => existsSync(source))) {
      return names.map((name) => ({
        from: path.join(downloadDir, name),
        to: path.join(serviceDir, name),
      }))
    }
  }

  return []
}

function buildPostSteps(options, serviceDir) {
  const steps = []
  if (options.install) {
    steps.push({
      label: 'npm install',
      command: process.platform === 'win32' ? 'cmd.exe' : 'npm',
      args: process.platform === 'win32' ? ['/d', '/c', 'npm', 'install'] : ['install'],
      cwd: serviceDir,
    })
  }

  return steps
}

function printPlan(plan, options) {
  console.log('')
  console.log(options.dryRun ? '생성 계획 (--dry-run)' : '생성 계획')
  console.log(`- 서비스: ${plan.service}`)
  console.log(`- 경로: ${plan.serviceDir}`)
  console.log(`- 인증: ${options.auth ? 'yes' : 'no'}`)
  console.log(`- 기능: ${options.features.length ? options.features.join(', ') : 'none'}`)
  console.log(`- 파일: ${plan.files.length}개`)
  for (const file of plan.files) {
    console.log(`  + ${file.relativePath}`)
  }
  console.log(`- 복사: ${plan.copies.length}개`)
  for (const item of plan.copies) {
    console.log(`  + ${path.relative(rootDir, item.to).replace(/\\/g, '/')}`)
  }
  console.log(`- 후속 작업: ${plan.postSteps.length ? plan.postSteps.map((step) => step.label).join(', ') : 'none'}`)
}

async function confirmPlanIfNeeded(options) {
  if (options.dryRun) return false
  if (!isInteractivePromptAvailable()) return true

  return select({
    message: '위 계획대로 서비스를 생성할까요?',
    default: true,
    choices: [
      { name: '생성', value: true },
      { name: '취소', value: false },
    ],
  })
}

async function writePlan(plan) {
  if (await exists(plan.serviceDir)) {
    throw new Error(`Service already exists: ${plan.service}`)
  }

  for (const file of plan.files) {
    await mkdir(path.dirname(file.path), { recursive: true })
    await writeFile(file.path, file.content, 'utf8')
  }

  for (const item of plan.copies) {
    if (!(await exists(item.from))) {
      console.warn(`Missing copy source, skipped: ${item.from}`)
      continue
    }
    await mkdir(path.dirname(item.to), { recursive: true })
    await copyFile(item.from, item.to)
  }
}

function runPostSteps(plan) {
  for (const step of plan.postSteps) {
    console.log('')
    console.log(`Running: ${step.label}`)
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      stdio: 'inherit',
      shell: false,
    })

    if (result.error) {
      throw new Error(`${step.label} failed: ${result.error.message}`)
    }

    if (result.status !== 0) {
      throw new Error(`${step.label} failed.`)
    }
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    printHelp()
    return
  }

  const options = await completeOptions(parsed)
  const plan = buildPlan(options)
  printPlan(plan, options)

  const shouldWrite = await confirmPlanIfNeeded(options)
  if (!shouldWrite) {
    if (!options.dryRun) console.log('취소했습니다.')
    return
  }

  await writePlan(plan)
  runPostSteps(plan)

  console.log('')
  console.log('서비스 생성 완료')
  console.log(`- 시작: ./task.sh start ${options.service}`)
  console.log(`- 검증: ./task.sh verify ${options.service}`)
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
