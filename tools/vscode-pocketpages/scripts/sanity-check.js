'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { PocketPagesLanguageServiceManager } = require('../src/language-service')
const { collectEjsSemanticTokenEntries } = require('../src/ejs-semantic-tokens')
const { getServerTemplateBoundaryLineNumbers } = require('../src/ejs-server-boundary')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf8')
}

function applyEditsToText(text, edits) {
  return edits
    .slice()
    .sort((left, right) => right.start - left.start)
    .reduce((current, edit) => current.slice(0, edit.start) + edit.newText + current.slice(edit.end), text)
}

function normalizeFilePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/')
}

function createFixtureApp(repoRoot) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-pocketpages-fixture-'))
  const appRoot = path.join(fixtureRoot, 'apps', 'fixture-app')

  writeFile(
    path.join(appRoot, 'jsconfig.json'),
    JSON.stringify(
      {
        include: ['pb_data/types.d.ts', 'pocketpages-globals.d.ts', 'types.d.ts', '**/*.ejs', '**/*.js'],
      },
      null,
      2
    )
  )

  writeFile(
    path.join(appRoot, 'pb_data', 'types.d.ts'),
    `declare namespace core {
  interface Record {
    id: string
    get(name: string): any
  }
}

declare namespace pocketbase {
  interface Collection {
    id: string
    name: string
  }

  interface PocketBase {
    findCollectionByNameOrId(nameOrId: string): Collection
    findCachedCollectionByNameOrId(nameOrId: string): Collection
    recordQuery(collectionModelOrIdentifier: any): any
    findRecordById(collectionModelOrIdentifier: any, recordId: string): core.Record
    findRecordsByIds(collectionModelOrIdentifier: any, recordIds: string[]): Array<core.Record>
    findAllRecords(collectionModelOrIdentifier: any): Array<core.Record>
    findFirstRecordByData(collectionModelOrIdentifier: any, key: string, value: any): core.Record
    findRecordsByFilter(collectionModelOrIdentifier: any, filter?: string, sort?: string, limit?: number, offset?: number): Array<core.Record>
    findFirstRecordByFilter(collectionModelOrIdentifier: any, filter: string): core.Record
    countRecords(collectionModelOrIdentifier: any): number
    findAuthRecordByEmail(collectionModelOrIdentifier: any, email: string): core.Record
    findRecordByViewFile(viewCollectionModelOrIdentifier: any, fileKey: string): core.Record
    isCollectionNameUnique(name: string): boolean
  }
}

declare var $app: pocketbase.PocketBase
`
  )

  writeFile(
    path.join(appRoot, 'pocketpages-globals.d.ts'),
    `type PagesRequestContext<TData = any> = {
  asset: any
  auth: any
  body: () => Record<string, any> | string
  data: TData
  echo: any
  formData: () => Record<string, any> | string
  meta: (key: string, value?: string) => string | undefined
  params: Record<string, string | undefined>
  redirect: (path: string, options?: Record<string, any>) => void
  request: {
    method: string
    auth?: core.Record
  }
  resolve: (path: string) => any
  slot: any
  slots: any
}

type PagesResponse = {
  json: (status: number, payload: any) => void
}

type PagesGlobalContext = {
  url: (value: string) => URL
  stringify: (value: any) => string
  env: (name: string) => string
  store: (key: string, value?: any) => any
  dbg: (eventName: string, payload?: Record<string, any>) => void
  info: (eventName: string, payload?: Record<string, any>) => void
  warn: (eventName: string, payload?: Record<string, any>) => void
  error: (eventName: string, payload?: Record<string, any>) => void
}

declare global {
  interface PocketPagesRouteParams {}

  const api: PagesRequestContext<any>
  const asset: PagesRequestContext<any>['asset']
  const auth: PagesRequestContext<any>['auth']
  const body: PagesRequestContext<any>['body']
  const data: PagesRequestContext<any>['data']
  const echo: PagesRequestContext<any>['echo']
  const formData: PagesRequestContext<any>['formData']
  const meta: PagesRequestContext<any>['meta']
  const params: PagesRequestContext<any>['params'] & PocketPagesRouteParams
  const redirect: PagesRequestContext<any>['redirect']
  const request: PagesRequestContext<any>['request']
  const resolve: PagesRequestContext<any>['resolve']
  const response: PagesResponse
  const slot: PagesRequestContext<any>['slot']
  const slots: PagesRequestContext<any>['slots']

  const url: PagesGlobalContext['url']
  const stringify: PagesGlobalContext['stringify']
  const env: PagesGlobalContext['env']
  const store: PagesGlobalContext['store']
  const dbg: PagesGlobalContext['dbg']
  const info: PagesGlobalContext['info']
  const warn: PagesGlobalContext['warn']
  const error: PagesGlobalContext['error']

  const include: (path: string, data?: Record<string, any>) => string
  const signInWithPassword: (email: string, password: string, options?: { collection?: string }) => {
    token: string
    record: core.Record
  }
  const signOut: () => void
}

export {}
`
  )

  writeFile(
    path.join(appRoot, 'types.d.ts'),
    `declare namespace types {
  type FixtureAuthState = {
    ok: boolean
    method: string
    roleNames: string[]
  }

  type FixturePageData = {
    boardName: string
    boardCount: number
    postSlugs: string[]
  }
}
`
  )

  writeFile(
    path.join(appRoot, 'pb_schema.json'),
    JSON.stringify(
      [
        {
          name: 'boards',
          fields: [
            { name: 'name', type: 'text' },
            { name: 'slug', type: 'text' },
            { name: 'description', type: 'text' },
            { name: 'is_active', type: 'bool' },
            { name: 'sort_order', type: 'number' },
            { name: 'meta_json', type: 'json' },
          ],
        },
        {
          name: 'posts',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'board', type: 'relation' },
          ],
        },
      ],
      null,
      2
    )
  )

  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'), `<a href="/boards">Boards</a>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'sign-in.ejs'), `<h1>Sign In</h1>\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs'),
    `<%- include('flash-alert.ejs', { flashMessage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'index.ejs'), `<script server>\nboard.get('name')\n</script>\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'rename-check.ejs'),
    `<script server>\nconst boardService = resolve('board-service')\nconst authState = boardService.readAuthState({ request })\n</script>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'locals-type-check.ejs'),
    `<script server>
const authState = { email: '', isSignedIn: true }
const boardService = resolve('board-service')
</script>
<%- include('typed-panel.ejs', { authState, boardService }) %>
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'override-card-check.ejs'),
    `<%- include('override-card.ejs', { banner: { message: 'Saved' } }) %>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-a.ejs'),
    `<%- include('optional-notice.ejs', { noticeText: 'Saved', tone: 'notice' }) %>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-b.ejs'),
    `<%- include('optional-notice.ejs', { tone: 'error' }) %>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-reference-check.ejs'),
    `<a href="/sign-in">Go</a>
<form action="/sign-in" method="post"></form>
<button hx-get="/sign-in"></button>
<script server>
redirect('/sign-in')
</script>
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'property-locals-check.ejs'),
    `<script server>
const pageData = {
  formValues: {
    title: '',
    slug: '',
    authorName: '',
    content: '',
    status: 'draft',
    isNotice: false,
  },
}
</script>
<%- include('property-panel.ejs', { values: pageData.formValues, boardSlug: params.boardSlug }) %>
`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-in.ejs'), `<script server>\nsignInWithPassword('a', 'b')\nreturn\n</script>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-out.ejs'), `<script server>\nsignOut()\nredirect('/sign-in')\nreturn\n</script>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'jobs', 'collect-weekly.ejs'), `<script server>\nresponse.json(200, { ok: true })\n</script>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'api', '+post.js'), `module.exports = function () {\n  return ''\n}\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', 'api', '+middleware.js'),
    `module.exports = function ({ request, resolve }, next) {\n  const boardService = resolve('board-service')\n  boardService.readAuthState({ request })\n  return next()\n}\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service.js'),
    `/**
 * @param {{ request: { method: string } }} params
 * @returns {types.FixtureAuthState}
 */
function readAuthState(params) {
  return /** @type {any} */ ({
    ok: !!params,
    method: params.request.method,
  })
}

module.exports = {
  readAuthState,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service-consumer.js'),
    `const boardService = require('./board-service')

module.exports = {
  boardService,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'flash-alert.ejs'),
    `<% const flashTone = isErrorFlash ? 'error' : 'notice' %>\n<div><%= flashMessage %> / <%= flashTone %> / <%= flashMeta.count %></div>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'typed-panel.ejs'),
    `<div><%= authState.email %> / <%= boardService.readAuthState({ request }).method %></div>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'property-panel.ejs'),
    `<div><%= values.title %> / <%= boardSlug %></div>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'override-card.ejs'),
    `<div><%= banner.message %></div>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'optional-notice.ejs'),
    `<% if (noticeText) { %><div><%= noticeText %> / <%= tone %></div><% } %>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'error-panel.ejs'),
    `<% const safeError = typeof error === 'undefined' ? '' : String(error || '') %>\n<% if (safeError) { %><div><%= safeError %></div><% } %>\n`
  )

  return {
    fixtureRoot,
    appRoot,
    siteIndexFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'),
    boardsFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs'),
    boardShowFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'index.ejs'),
    localsTypeCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'locals-type-check.ejs'),
    overrideCardCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'override-card-check.ejs'),
    optionalNoticeAFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-a.ejs'),
    optionalNoticeBFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-b.ejs'),
    routeReferenceCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-reference-check.ejs'),
    propertyLocalsCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'property-locals-check.ejs'),
    renameCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'rename-check.ejs'),
    middlewareFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'api', '+middleware.js'),
    boardServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service.js'),
    boardServiceConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service-consumer.js'),
    flashAlertFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'flash-alert.ejs'),
    typedPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'typed-panel.ejs'),
    propertyPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'property-panel.ejs'),
    overrideCardFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'override-card.ejs'),
    optionalNoticeFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'optional-notice.ejs'),
    errorPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'error-panel.ejs'),
    signOutFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-out.ejs'),
    signInFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-in.ejs'),
    siteSignInFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'sign-in.ejs'),
  }
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const extensionSource = fs.readFileSync(path.join(repoRoot, 'tools', 'vscode-pocketpages', 'src', 'extension.js'), 'utf8')
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'vscode-pocketpages', 'package.json'), 'utf8'))
  if (!/const updateDiagnostics = \(document\) => \{\s*if \(!isPocketPagesCodeDocument\(document\)\) \{\s*return\s*\}/.test(extensionSource)) {
    throw new Error('Expected updateDiagnostics() to cover PocketPages code documents, including JS page files.')
  }
  if (!/registerInlayHintsProvider\(CODE_DOCUMENT_SELECTOR,\s*new PocketPagesInlayHintsProvider\(manager\)\)/.test(extensionSource)) {
    throw new Error('Expected PocketPages inlay hints provider registration for code documents.')
  }
  if (!/registerCommand\('pocketpagesServerScript\.reloadCaches'/.test(extensionSource)) {
    throw new Error('Expected PocketPages reloadCaches command registration in extension.js.')
  }
  const contributedCommands = Array.isArray(packageJson.contributes && packageJson.contributes.commands)
    ? packageJson.contributes.commands.map((entry) => entry.command)
    : []
  if (!contributedCommands.includes('pocketpagesServerScript.reloadCaches')) {
    throw new Error('Expected PocketPages reloadCaches command contribution in package.json.')
  }

  const fixture = createFixtureApp(repoRoot)

  try {
    const manager = new PocketPagesLanguageServiceManager()
    const service = manager.getServiceForFile(fixture.boardsFilePath)
    const indexService = manager.getServiceForFile(fixture.siteIndexFilePath)
    const authService = manager.getServiceForFile(fixture.signOutFilePath)

    if (!service) {
      throw new Error(`PocketPages app root not found for ${fixture.boardsFilePath}`)
    }
    if (!indexService) {
      throw new Error(`PocketPages app root not found for ${fixture.siteIndexFilePath}`)
    }
    if (!authService) {
      throw new Error(`PocketPages app root not found for ${fixture.signOutFilePath}`)
    }

    const completionText = `<script server>\nmet\n</script>\n`
    const completionOffset = completionText.indexOf('met') + 'met'.length
    const completionData = service.getCompletionData(fixture.boardsFilePath, completionText, completionOffset)
    if (!completionData) {
      throw new Error('No completion data returned for <script server> block.')
    }

    const completionNames = completionData.entries.map((entry) => entry.name)
    if (!completionNames.includes('meta')) {
      throw new Error(`Expected "meta" completion. Got: ${completionNames.slice(0, 20).join(', ')}`)
    }

    const semanticTokens = collectEjsSemanticTokenEntries(`<% if (!safeDashboardState.teamLeadRows || safeDashboardState.teamLeadRows.length === 0) { %>
<%= authState.email || '<b>Kim</b>' %>
`)
    const semanticTypes = semanticTokens.map((entry) => entry.tokenType)
    if (!semanticTypes.includes('keyword') || !semanticTypes.includes('string') || !semanticTypes.includes('operator')) {
      throw new Error(`Expected semantic token extraction for EJS template JS. Got: ${semanticTypes.join(', ')}`)
    }

    const templateCompletionText = `<script server>
const authState = { email: '', isSignedIn: true }
</script>
<p><%= authState. %></p>
`
    const templateCompletionOffset = templateCompletionText.indexOf('authState.') + 'authState.'.length
    const templateCompletion = service.getCompletionData(fixture.boardsFilePath, templateCompletionText, templateCompletionOffset)
    const templateCompletionNames = templateCompletion ? templateCompletion.entries.map((entry) => entry.name) : []
    if (!templateCompletionNames.includes('email') || !templateCompletionNames.includes('isSignedIn')) {
      throw new Error(`Expected EJS template completion for authState fields. Got: ${templateCompletionNames.slice(0, 20).join(', ')}`)
    }

    const hoverText = `<script server>\nmeta\n</script>\n`
    const hoverOffset = hoverText.indexOf('meta') + 1
    const quickInfo = service.getQuickInfo(fixture.boardsFilePath, hoverText, hoverOffset)
    if (!quickInfo || !quickInfo.displayText.includes('meta')) {
      throw new Error(`Expected hover info for "meta". Got: ${JSON.stringify(quickInfo)}`)
    }

    const templateHoverText = `<script server>
const authState = { email: '', isSignedIn: true }
</script>
<p><%= authState.email %></p>
`
    const templateHoverOffset = templateHoverText.indexOf('authState') + 1
    const templateQuickInfo = service.getQuickInfo(fixture.boardsFilePath, templateHoverText, templateHoverOffset)
    if (!templateQuickInfo || !templateQuickInfo.displayText.includes('const authState')) {
      throw new Error(`Expected hover info inside EJS template. Got: ${JSON.stringify(templateQuickInfo)}`)
    }

    const typedTemplateCompletionText = `<script server>
/** @type {types.FixturePageData} */
const pageData = { boardName: 'Boards', boardCount: 1, postSlugs: ['welcome'] }
</script>
<p><%= pageData. %></p>
`
    const typedTemplateCompletionOffset =
      typedTemplateCompletionText.indexOf('pageData.') + 'pageData.'.length
    const typedTemplateCompletion = service.getCompletionData(
      fixture.boardsFilePath,
      typedTemplateCompletionText,
      typedTemplateCompletionOffset
    )
    const typedTemplateCompletionNames = typedTemplateCompletion
      ? typedTemplateCompletion.entries.map((entry) => entry.name)
      : []
    if (
      !typedTemplateCompletionNames.includes('boardName') ||
      !typedTemplateCompletionNames.includes('boardCount') ||
      !typedTemplateCompletionNames.includes('postSlugs')
    ) {
      throw new Error(
        `Expected JSDoc-backed EJS template completion for pageData fields. Got: ${typedTemplateCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const typedTemplateHoverText = `<script server>
/** @type {types.FixturePageData} */
const pageData = { boardName: 'Boards', boardCount: 1, postSlugs: ['welcome'] }
</script>
<p><%= pageData.boardName %></p>
`
    const typedTemplateHoverOffset = typedTemplateHoverText.indexOf('pageData') + 1
    const typedTemplateQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedTemplateHoverText,
      typedTemplateHoverOffset
    )
    if (
      !typedTemplateQuickInfo ||
      !typedTemplateQuickInfo.displayText.includes('const pageData: {') ||
      !typedTemplateQuickInfo.displayText.includes('boardName: string;') ||
      !typedTemplateQuickInfo.displayText.includes('postSlugs: string[];')
    ) {
      throw new Error(`Expected JSDoc-backed hover info inside EJS template. Got: ${JSON.stringify(typedTemplateQuickInfo)}`)
    }

    const typedResolveCompletionText = `<script server>
const boardService = resolve('board-service')
boardService.
</script>
`
    const typedResolveCompletionOffset = typedResolveCompletionText.indexOf('boardService.') + 'boardService.'.length
    const typedResolveCompletion = service.getCompletionData(
      fixture.boardsFilePath,
      typedResolveCompletionText,
      typedResolveCompletionOffset
    )
    const typedResolveCompletionNames = typedResolveCompletion ? typedResolveCompletion.entries.map((entry) => entry.name) : []
    if (!typedResolveCompletionNames.includes('readAuthState')) {
      throw new Error(
        `Expected typed resolve() completion for "readAuthState". Got: ${typedResolveCompletionNames.slice(0, 20).join(', ')}`
      )
    }

    const typedResolveCompletionEntry = typedResolveCompletion
      ? typedResolveCompletion.entries.find((entry) => entry.name === 'readAuthState')
      : null
    const typedResolveCompletionDetails =
      typedResolveCompletion && typedResolveCompletionEntry
        ? service.getCompletionDetails(
            typedResolveCompletion.virtualFileName,
            typedResolveCompletion.virtualOffset,
            typedResolveCompletionEntry.name,
            typedResolveCompletionEntry.source
          )
        : null
    const typedResolveCompletionDetailText = typedResolveCompletionDetails
      ? (typedResolveCompletionDetails.displayParts || []).map((part) => part.text).join('')
      : ''
    if (!typedResolveCompletionDetailText.includes('readAuthState(params: {') || !typedResolveCompletionDetailText.includes('method: string')) {
      throw new Error(`Expected typed resolve() completion details. Got: ${typedResolveCompletionDetailText}`)
    }

    const typedResolveHoverText = `<script server>
const boardService = resolve('board-service')
boardService.readAuthState({ request })
</script>
`
    const typedResolveHoverOffset = typedResolveHoverText.indexOf('readAuthState') + 2
    const typedResolveQuickInfo = service.getQuickInfo(fixture.boardsFilePath, typedResolveHoverText, typedResolveHoverOffset)
    if (
      !typedResolveQuickInfo ||
      !typedResolveQuickInfo.displayText.includes('readAuthState(params: {') ||
      !typedResolveQuickInfo.displayText.includes('method: string')
    ) {
      throw new Error(`Expected typed resolve() hover info. Got: ${JSON.stringify(typedResolveQuickInfo)}`)
    }

    const typedResolveReturnCompletionText = `<script server>
const boardService = resolve('board-service')
const authState = boardService.readAuthState({ request })
authState.
</script>
`
    const typedResolveReturnCompletionOffset =
      typedResolveReturnCompletionText.indexOf('authState.') + 'authState.'.length
    const typedResolveReturnCompletion = service.getCompletionData(
      fixture.boardsFilePath,
      typedResolveReturnCompletionText,
      typedResolveReturnCompletionOffset
    )
    const typedResolveReturnCompletionNames = typedResolveReturnCompletion
      ? typedResolveReturnCompletion.entries.map((entry) => entry.name)
      : []
    if (!typedResolveReturnCompletionNames.includes('roleNames')) {
      throw new Error(
        `Expected resolve()-derived return type completion from app types.d.ts. Got: ${typedResolveReturnCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const typedResolveSignatureText = `<script server>
const boardService = resolve('board-service')
boardService.readAuthState(
</script>
`
    const typedResolveSignatureOffset = typedResolveSignatureText.indexOf('readAuthState(') + 'readAuthState('.length
    const typedResolveSignatureHelp = service.getSignatureHelp(
      fixture.boardsFilePath,
      typedResolveSignatureText,
      typedResolveSignatureOffset,
      { triggerCharacter: '(' }
    )
    const typedResolveSignatureLabel =
      typedResolveSignatureHelp && typedResolveSignatureHelp.items.length
        ? [
            typedResolveSignatureHelp.items[0].prefixDisplayParts,
            ...typedResolveSignatureHelp.items[0].parameters.flatMap((parameter, index) => [
              ...(index > 0 ? typedResolveSignatureHelp.items[0].separatorDisplayParts : []),
              ...parameter.displayParts,
            ]),
            typedResolveSignatureHelp.items[0].suffixDisplayParts,
          ]
            .flat()
            .map((part) => part.text)
            .join('')
        : ''
    if (!typedResolveSignatureLabel.includes('readAuthState(') || !typedResolveSignatureLabel.includes('method: string')) {
      throw new Error(`Expected typed resolve() signature help. Got: ${JSON.stringify(typedResolveSignatureHelp)}`)
    }

    const paramsText = `<script server>\nparams.\n</script>\n`
    const paramsOffset = paramsText.indexOf('params.') + 'params.'.length
    const paramsCompletion = service.getCompletionData(fixture.boardShowFilePath, paramsText, paramsOffset)
    const paramsNames = paramsCompletion ? paramsCompletion.entries.map((entry) => entry.name) : []
    if (!paramsNames.includes('boardSlug')) {
      throw new Error(`Expected route param completion for "boardSlug". Got: ${paramsNames.slice(0, 20).join(', ')}`)
    }

    const resolveText = `<script server>\nresolve('bo')\n</script>\n`
    const resolveOffset = resolveText.indexOf('bo') + 'bo'.length
    const resolveCompletion = service.getCustomCompletionData(fixture.boardsFilePath, resolveText, resolveOffset)
    const resolveNames = resolveCompletion ? resolveCompletion.items.map((entry) => entry.label) : []
    if (!resolveNames.includes('board-service')) {
      throw new Error(`Expected resolve() completion for "board-service". Got: ${resolveNames.slice(0, 20).join(', ')}`)
    }

    const includeText = `<%- include('fl') %>\n`
    const includeOffset = includeText.indexOf('fl') + 'fl'.length
    const includeCompletion = service.getCustomCompletionData(fixture.boardsFilePath, includeText, includeOffset)
    const includeNames = includeCompletion ? includeCompletion.items.map((entry) => entry.label) : []
    if (!includeNames.includes('flash-alert.ejs')) {
      throw new Error(`Expected include() completion for "flash-alert.ejs". Got: ${includeNames.slice(0, 20).join(', ')}`)
    }

    const includeLocalCompletionText = `<%- include('flash-alert.ejs', { msg }) %>\n`
    const includeLocalCompletionOffset = includeLocalCompletionText.indexOf('msg') + 'msg'.length
    const includeLocalCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      includeLocalCompletionText,
      includeLocalCompletionOffset
    )
    const includeLocalNames = includeLocalCompletion ? includeLocalCompletion.items.map((entry) => entry.label) : []
    if (!includeLocalNames.includes('flashMessage') || !includeLocalNames.includes('flashMeta')) {
      throw new Error(`Expected include() local key completion. Got: ${includeLocalNames.join(', ')}`)
    }
    const flashMessageCompletionItem = includeLocalCompletion
      ? includeLocalCompletion.items.find((entry) => entry.label === 'flashMessage')
      : null
    if (!flashMessageCompletionItem || flashMessageCompletionItem.insertText !== 'flashMessage') {
      throw new Error(`Expected include() local completion to replace the current key. Got: ${JSON.stringify(flashMessageCompletionItem)}`)
    }

    const includeSignatureText = `<%- include('flash-alert.ejs', { flashMessage: 'Saved' }) %>\n`
    const includeSignatureOffset = includeSignatureText.indexOf('{ flashMessage') + 1
    const includeSignatureHelp = service.getSignatureHelp(
      fixture.boardsFilePath,
      includeSignatureText,
      includeSignatureOffset,
      { triggerCharacter: ',' }
    )
    const includeSignatureLabel =
      includeSignatureHelp && includeSignatureHelp.items.length
        ? [
            includeSignatureHelp.items[0].prefixDisplayParts,
            ...includeSignatureHelp.items[0].parameters.flatMap((parameter, index) => [
              ...(index > 0 ? includeSignatureHelp.items[0].separatorDisplayParts : []),
              ...parameter.displayParts,
            ]),
            includeSignatureHelp.items[0].suffixDisplayParts,
          ]
            .flat()
            .map((part) => part.text)
            .join('')
        : ''
    if (
      !includeSignatureLabel.includes('include(') ||
      !includeSignatureLabel.includes('flashMessage:') ||
      !includeSignatureLabel.includes('isErrorFlash?:') ||
      !includeSignatureLabel.includes('flashMeta:')
    ) {
      throw new Error(`Expected include() contract signature help. Got: ${JSON.stringify(includeSignatureHelp)}`)
    }

    if (!service.includeContractCache || service.includeContractCache.size === 0) {
      throw new Error('Expected include() contract analysis to populate the includeContractCache.')
    }
    if (!service.includeCallEntriesCache || service.includeCallEntriesCache.size === 0) {
      throw new Error('Expected include() completion/signature analysis to populate the includeCallEntriesCache.')
    }
    service.resetCaches()
    if (service.includeContractCache.size !== 0 || service.includeCallEntriesCache.size !== 0) {
      throw new Error('Expected resetCaches() to clear PocketPages include caches.')
    }
    if (service.projectIndex.includeLocalsCache !== null || service.projectIndex.schemaCache !== null || service.projectIndex.collectionMethodCache !== null) {
      throw new Error('Expected resetCaches() to clear PocketPages project index caches.')
    }
    const includeLocalCompletionAfterReset = service.getCustomCompletionData(
      fixture.boardsFilePath,
      includeLocalCompletionText,
      includeLocalCompletionOffset
    )
    const includeLocalNamesAfterReset = includeLocalCompletionAfterReset
      ? includeLocalCompletionAfterReset.items.map((entry) => entry.label)
      : []
    if (!includeLocalNamesAfterReset.includes('flashMessage') || !includeLocalNamesAfterReset.includes('flashMeta')) {
      throw new Error(`Expected include() local completion to recover after resetCaches(). Got: ${includeLocalNamesAfterReset.join(', ')}`)
    }

    const routeCompletionText = `<a href="/si"></a>\n`
    const routeCompletionOffset = routeCompletionText.indexOf('/si') + '/si'.length
    const routeCompletion = service.getCustomCompletionData(fixture.siteIndexFilePath, routeCompletionText, routeCompletionOffset)
    const routeNames = routeCompletion ? routeCompletion.items.map((entry) => entry.label) : []
    if (!routeNames.includes('/sign-in')) {
      throw new Error(`Expected route path completion for "/sign-in". Got: ${routeNames.slice(0, 20).join(', ')}`)
    }
    if (routeNames.includes('/api')) {
      throw new Error(`Expected route path completion to exclude JS route handlers. Got: ${routeNames.slice(0, 20).join(', ')}`)
    }

    const collectionText = `<script server>\n$app.findRecordsByFilter('bo')\n</script>\n`
    const collectionOffset = collectionText.indexOf('bo') + 'bo'.length
    const collectionCompletion = service.getCustomCompletionData(fixture.boardsFilePath, collectionText, collectionOffset)
    const collectionNames = collectionCompletion ? collectionCompletion.items.map((entry) => entry.label) : []
    if (!collectionNames.includes('boards') || !collectionNames.includes('posts')) {
      throw new Error(`Expected collection completions for "boards" and "posts". Got: ${collectionNames.slice(0, 20).join(', ')}`)
    }

    const jsCompletionText = `const boardService = resolve('board-service')\nboardService.\n`
    const jsCompletionOffset = jsCompletionText.indexOf('boardService.') + 'boardService.'.length
    const jsCompletion = service.getCompletionData(fixture.middlewareFilePath, jsCompletionText, jsCompletionOffset)
    const jsCompletionNames = jsCompletion ? jsCompletion.entries.map((entry) => entry.name) : []
    if (!jsCompletionNames.includes('readAuthState')) {
      throw new Error(`Expected JS module member completion for "readAuthState". Got: ${jsCompletionNames.slice(0, 20).join(', ')}`)
    }

    const jsCollectionText = `$app.findRecordsByFilter('bo')\n`
    const jsCollectionOffset = jsCollectionText.indexOf('bo') + 'bo'.length
    const jsCollectionCompletion = service.getCustomCompletionData(fixture.boardServiceFilePath, jsCollectionText, jsCollectionOffset)
    const jsCollectionNames = jsCollectionCompletion ? jsCollectionCompletion.items.map((entry) => entry.label) : []
    if (!jsCollectionNames.includes('boards') || !jsCollectionNames.includes('posts')) {
      throw new Error(`Expected JS collection completions for "boards" and "posts". Got: ${jsCollectionNames.slice(0, 20).join(', ')}`)
    }

    const jsCollectionByNameText = `$app.findCollectionByNameOrId('bo')\n`
    const jsCollectionByNameOffset = jsCollectionByNameText.indexOf('bo') + 'bo'.length
    const jsCollectionByNameCompletion = service.getCustomCompletionData(
      fixture.boardServiceFilePath,
      jsCollectionByNameText,
      jsCollectionByNameOffset
    )
    const jsCollectionByNameNames = jsCollectionByNameCompletion ? jsCollectionByNameCompletion.items.map((entry) => entry.label) : []
    if (!jsCollectionByNameNames.includes('boards') || !jsCollectionByNameNames.includes('posts')) {
      throw new Error(
        `Expected JS findCollectionByNameOrId() completions for "boards" and "posts". Got: ${jsCollectionByNameNames.slice(0, 20).join(', ')}`
      )
    }

    const jsRecordQueryText = `$app.recordQuery('bo')\n`
    const jsRecordQueryOffset = jsRecordQueryText.indexOf('bo') + 'bo'.length
    const jsRecordQueryCompletion = service.getCustomCompletionData(fixture.boardServiceFilePath, jsRecordQueryText, jsRecordQueryOffset)
    const jsRecordQueryNames = jsRecordQueryCompletion ? jsRecordQueryCompletion.items.map((entry) => entry.label) : []
    if (!jsRecordQueryNames.includes('boards') || !jsRecordQueryNames.includes('posts')) {
      throw new Error(`Expected JS recordQuery() completions for "boards" and "posts". Got: ${jsRecordQueryNames.slice(0, 20).join(', ')}`)
    }

    const jsCollectionNameText = `$app.isCollectionNameUnique('bo')\n`
    const jsCollectionNameOffset = jsCollectionNameText.indexOf('bo') + 'bo'.length
    const jsCollectionNameCompletion = service.getCustomCompletionData(
      fixture.boardServiceFilePath,
      jsCollectionNameText,
      jsCollectionNameOffset
    )
    const jsCollectionNameNames = jsCollectionNameCompletion ? jsCollectionNameCompletion.items.map((entry) => entry.label) : []
    if (!jsCollectionNameNames.includes('boards') || !jsCollectionNameNames.includes('posts')) {
      throw new Error(
        `Expected JS isCollectionNameUnique() completions for "boards" and "posts". Got: ${jsCollectionNameNames.slice(0, 20).join(', ')}`
      )
    }

    const fieldText = `<script server>\nboard.get('na')\n</script>\n`
    const fieldOffset = fieldText.indexOf('na') + 'na'.length
    const fieldCompletion = service.getCustomCompletionData(fixture.boardShowFilePath, fieldText, fieldOffset)
    const fieldNames = fieldCompletion ? fieldCompletion.items.map((entry) => entry.label) : []
    if (!fieldNames.includes('name') || !fieldNames.includes('slug')) {
      throw new Error(`Expected board field completions. Got: ${fieldNames.slice(0, 20).join(', ')}`)
    }

    const jsFieldText = `const board = $app.findFirstRecordByFilter('boards', 'id != \"\"')\nboard.get('na')\n`
    const jsFieldOffset = jsFieldText.lastIndexOf('na') + 'na'.length
    const jsFieldCompletion = service.getCustomCompletionData(fixture.boardServiceFilePath, jsFieldText, jsFieldOffset)
    const jsFieldNames = jsFieldCompletion ? jsFieldCompletion.items.map((entry) => entry.label) : []
    if (!jsFieldNames.includes('name') || !jsFieldNames.includes('slug')) {
      throw new Error(`Expected JS board field completions. Got: ${jsFieldNames.slice(0, 20).join(', ')}`)
    }

    const jsAuthFieldText = `const record = $app.findAuthRecordByEmail('boards', 'test@example.com')\nrecord.get('na')\n`
    const jsAuthFieldOffset = jsAuthFieldText.lastIndexOf('na') + 'na'.length
    const jsAuthFieldCompletion = service.getCustomCompletionData(fixture.boardServiceFilePath, jsAuthFieldText, jsAuthFieldOffset)
    const jsAuthFieldNames = jsAuthFieldCompletion ? jsAuthFieldCompletion.items.map((entry) => entry.label) : []
    if (!jsAuthFieldNames.includes('name') || !jsAuthFieldNames.includes('slug')) {
      throw new Error(`Expected JS auth record field completions. Got: ${jsAuthFieldNames.slice(0, 20).join(', ')}`)
    }

    const templateFieldText = `<% const board = pageData.board %>\n<p><%= board.get('na') %></p>\n`
    const templateFieldOffset = templateFieldText.indexOf('na') + 'na'.length
    const templateFieldCompletion = service.getCustomCompletionData(fixture.boardShowFilePath, templateFieldText, templateFieldOffset)
    const templateFieldNames = templateFieldCompletion ? templateFieldCompletion.items.map((entry) => entry.label) : []
    if (!templateFieldNames.includes('name') || !templateFieldNames.includes('description')) {
      throw new Error(`Expected EJS template field completions. Got: ${templateFieldNames.slice(0, 20).join(', ')}`)
    }

    const resolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-service')\n</script>\n`,
      `<script server>\nresolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!resolveDefinition || !resolveDefinition.endsWith('/pb_hooks/pages/_private/board-service.js')) {
      throw new Error(`Expected resolve() definition target. Got: ${resolveDefinition}`)
    }

    const resolvePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-service')\n</script>\n`,
      `<script server>\nresolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!resolvePathTargetInfo || normalizeFilePath(resolvePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected resolve() path target info. Got: ${JSON.stringify(resolvePathTargetInfo)}`)
    }

    const includeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs') %>\n`,
      `<%- include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!includeDefinition || !includeDefinition.endsWith('/pb_hooks/pages/_private/flash-alert.ejs')) {
      throw new Error(`Expected include() definition target. Got: ${includeDefinition}`)
    }

    const includePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs') %>\n`,
      `<%- include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!includePathTargetInfo || normalizeFilePath(includePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected include() path target info. Got: ${JSON.stringify(includePathTargetInfo)}`)
    }

    const hrefPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<a href="/boards"></a>\n`,
      `<a href="/boards"></a>\n`.indexOf('/boards') + 2
    )
    if (!hrefPathTargetInfo || normalizeFilePath(hrefPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.boardsFilePath)) {
      throw new Error(`Expected href path target info. Got: ${JSON.stringify(hrefPathTargetInfo)}`)
    }

    const partialReferenceText = `<div><%= flashMessage %></div>\n`
    const partialReferenceOffset = partialReferenceText.indexOf('flashMessage') + 2
    const partialReferences = service.getReferenceTargets(
      fixture.flashAlertFilePath,
      partialReferenceText,
      partialReferenceOffset,
      { includeDeclaration: false }
    )
    if (!partialReferences || partialReferences.length !== 1) {
      throw new Error(`Expected _private partial include references. Got: ${JSON.stringify(partialReferences)}`)
    }
    if (
      !partialReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
      )
    ) {
      throw new Error(`Expected _private partial reference to point at boards index include call. Got: ${JSON.stringify(partialReferences)}`)
    }

    const partialReferenceQuery = service.getFileReferenceQuery(fixture.flashAlertFilePath)
    if (!partialReferenceQuery || partialReferenceQuery.kind !== 'private-partial') {
      throw new Error(`Expected _private partial file reference query. Got: ${JSON.stringify(partialReferenceQuery)}`)
    }

    const partialFileReferences = service.getFileReferenceTargets(fixture.flashAlertFilePath, fs.readFileSync(fixture.flashAlertFilePath, 'utf8'))
    if (!partialFileReferences || partialFileReferences.length !== 1) {
      throw new Error(`Expected file-based partial references. Got: ${JSON.stringify(partialFileReferences)}`)
    }

    const privateTemplateCompletionText = `<div><%= flashMeta. %></div>\n`
    const privateTemplateCompletionOffset =
      privateTemplateCompletionText.indexOf('flashMeta.') + 'flashMeta.'.length
    const privateTemplateCompletion = service.getCompletionData(
      fixture.flashAlertFilePath,
      privateTemplateCompletionText,
      privateTemplateCompletionOffset
    )
    const privateTemplateCompletionNames = privateTemplateCompletion
      ? privateTemplateCompletion.entries.map((entry) => entry.name)
      : []
    if (!privateTemplateCompletionNames.includes('count')) {
      throw new Error(
        `Expected include() locals completion in _private partial. Got: ${privateTemplateCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const privateTemplateHoverText = `<div><%= flashMessage %></div>\n`
    const privateTemplateHoverOffset = privateTemplateHoverText.indexOf('flashMessage') + 2
    const privateTemplateQuickInfo = service.getQuickInfo(
      fixture.flashAlertFilePath,
      privateTemplateHoverText,
      privateTemplateHoverOffset
    )
    if (!privateTemplateQuickInfo || !privateTemplateQuickInfo.displayText.includes('const flashMessage: string')) {
      throw new Error(`Expected include() locals hover in _private partial. Got: ${JSON.stringify(privateTemplateQuickInfo)}`)
    }

    const typedPanelCompletionText = `<div><%= authState. %></div>\n`
    const typedPanelCompletionOffset = typedPanelCompletionText.indexOf('authState.') + 'authState.'.length
    const typedPanelCompletion = service.getCompletionData(
      fixture.typedPanelFilePath,
      typedPanelCompletionText,
      typedPanelCompletionOffset
    )
    const typedPanelCompletionNames = typedPanelCompletion ? typedPanelCompletion.entries.map((entry) => entry.name) : []
    if (!typedPanelCompletionNames.includes('email') || !typedPanelCompletionNames.includes('isSignedIn')) {
      throw new Error(
        `Expected shorthand include() locals completion in _private partial. Got: ${typedPanelCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const typedPanelHoverText = `<div><%= authState.email %></div>\n`
    const typedPanelHoverOffset = typedPanelHoverText.indexOf('authState') + 2
    const typedPanelQuickInfo = service.getQuickInfo(
      fixture.typedPanelFilePath,
      typedPanelHoverText,
      typedPanelHoverOffset
    )
    if (
      !typedPanelQuickInfo ||
      !typedPanelQuickInfo.displayText.includes('const authState: {') ||
      !typedPanelQuickInfo.displayText.includes('email: string;')
    ) {
      throw new Error(`Expected shorthand include() locals hover in _private partial. Got: ${JSON.stringify(typedPanelQuickInfo)}`)
    }

    const typedPanelServiceCompletionText = `<div><%= boardService. %></div>\n`
    const typedPanelServiceCompletionOffset =
      typedPanelServiceCompletionText.indexOf('boardService.') + 'boardService.'.length
    const typedPanelServiceCompletion = service.getCompletionData(
      fixture.typedPanelFilePath,
      typedPanelServiceCompletionText,
      typedPanelServiceCompletionOffset
    )
    const typedPanelServiceCompletionNames = typedPanelServiceCompletion
      ? typedPanelServiceCompletion.entries.map((entry) => entry.name)
      : []
    if (!typedPanelServiceCompletionNames.includes('readAuthState')) {
      throw new Error(
        `Expected resolve()-derived shorthand include() locals completion. Got: ${typedPanelServiceCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const propertyPanelCompletionText = `<div><%= values. %></div>\n`
    const propertyPanelCompletionOffset = propertyPanelCompletionText.indexOf('values.') + 'values.'.length
    const propertyPanelCompletion = service.getCompletionData(
      fixture.propertyPanelFilePath,
      propertyPanelCompletionText,
      propertyPanelCompletionOffset
    )
    const propertyPanelCompletionNames = propertyPanelCompletion
      ? propertyPanelCompletion.entries.map((entry) => entry.name)
      : []
    if (
      !propertyPanelCompletionNames.includes('title') ||
      !propertyPanelCompletionNames.includes('status') ||
      !propertyPanelCompletionNames.includes('isNotice')
    ) {
      throw new Error(
        `Expected property-access include() locals completion in _private partial. Got: ${propertyPanelCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const propertyPanelHoverText = `<div><%= boardSlug %></div>\n`
    const propertyPanelHoverOffset = propertyPanelHoverText.indexOf('boardSlug') + 2
    const propertyPanelQuickInfo = service.getQuickInfo(
      fixture.propertyPanelFilePath,
      propertyPanelHoverText,
      propertyPanelHoverOffset
    )
    if (
      !propertyPanelQuickInfo ||
      !propertyPanelQuickInfo.displayText.includes('const boardSlug: string')
    ) {
      throw new Error(`Expected property-access include() hover in _private partial. Got: ${JSON.stringify(propertyPanelQuickInfo)}`)
    }

    const propertyPanelDiagnostics = service.getDiagnostics(
      fixture.propertyPanelFilePath,
      `<div><%= values.title %> / <%= boardSlug %></div>\n`
    )
    if (propertyPanelDiagnostics.some((entry) => entry.code === 2339)) {
      throw new Error(
        `Expected property-access include() locals diagnostics to resolve. Got: ${propertyPanelDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const optionalNoticeText = fs.readFileSync(fixture.optionalNoticeFilePath, 'utf8')
    const optionalNoticeBindings = service.projectIndex.getIncludeLocalBindings(fixture.optionalNoticeFilePath)
    const optionalNoticeBinding = optionalNoticeBindings.find((entry) => entry.name === 'noticeText')
    if (!optionalNoticeBinding || !optionalNoticeBinding.optional || !optionalNoticeBinding.typeText.includes('undefined')) {
      throw new Error(`Expected optional include() local binding to include undefined. Got: ${JSON.stringify(optionalNoticeBindings)}`)
    }

    const optionalNoticeDiagnostics = service.getDiagnostics(fixture.optionalNoticeFilePath, optionalNoticeText)
    if (optionalNoticeDiagnostics.some((entry) => entry.code === 18048 || entry.code === 2339)) {
      throw new Error(
        `Expected guarded optional include() locals to avoid TS diagnostics. Got: ${optionalNoticeDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const overrideCardCompletionText = `<div><%= banner. %></div>\n`
    const overrideCardCompletionOffset = overrideCardCompletionText.indexOf('banner.') + 'banner.'.length
    const overrideCardBaselineCompletion = service.getCompletionData(
      fixture.overrideCardFilePath,
      overrideCardCompletionText,
      overrideCardCompletionOffset
    )
    const overrideCardBaselineNames = overrideCardBaselineCompletion
      ? overrideCardBaselineCompletion.entries.map((entry) => entry.name)
      : []
    if (!overrideCardBaselineNames.includes('message') || overrideCardBaselineNames.includes('title')) {
      throw new Error(`Expected baseline include() locals completion for override-card. Got: ${overrideCardBaselineNames.join(', ')}`)
    }

    service.setDocumentOverride(
      fixture.overrideCardCheckFilePath,
      `<%- include('override-card.ejs', { banner: { title: 'Saved', count: 1 } }) %>\n`
    )
    const overrideCardOverrideCompletion = service.getCompletionData(
      fixture.overrideCardFilePath,
      overrideCardCompletionText,
      overrideCardCompletionOffset
    )
    const overrideCardOverrideNames = overrideCardOverrideCompletion
      ? overrideCardOverrideCompletion.entries.map((entry) => entry.name)
      : []
    if (
      !overrideCardOverrideNames.includes('title') ||
      !overrideCardOverrideNames.includes('count') ||
      overrideCardOverrideNames.includes('message')
    ) {
      throw new Error(`Expected include() locals override completion to invalidate cache. Got: ${overrideCardOverrideNames.join(', ')}`)
    }

    service.clearDocumentOverride(fixture.overrideCardCheckFilePath)
    const overrideCardClearedCompletion = service.getCompletionData(
      fixture.overrideCardFilePath,
      overrideCardCompletionText,
      overrideCardCompletionOffset
    )
    const overrideCardClearedNames = overrideCardClearedCompletion
      ? overrideCardClearedCompletion.entries.map((entry) => entry.name)
      : []
    if (!overrideCardClearedNames.includes('message') || overrideCardClearedNames.includes('title')) {
      throw new Error(`Expected include() locals completion to restore after clearing override. Got: ${overrideCardClearedNames.join(', ')}`)
    }

    const resolvedMemberDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nconst boardService = resolve('board-service')\nconst authState = boardService.readAuthState({ request })\n</script>\n`,
      `<script server>\nconst boardService = resolve('board-service')\nconst authState = boardService.readAuthState({ request })\n</script>\n`.indexOf('readAuthState') + 2
    )
    if (!resolvedMemberDefinition || typeof resolvedMemberDefinition === 'string') {
      throw new Error(`Expected resolve()-derived member definition target. Got: ${JSON.stringify(resolvedMemberDefinition)}`)
    }
    if (!resolvedMemberDefinition.filePath.endsWith('/pb_hooks/pages/_private/board-service.js')) {
      throw new Error(`Expected resolve()-derived member definition file. Got: ${JSON.stringify(resolvedMemberDefinition)}`)
    }
    if (resolvedMemberDefinition.line < 0) {
      throw new Error(`Expected resolve()-derived member definition line. Got: ${JSON.stringify(resolvedMemberDefinition)}`)
    }

    const sameFileDefinitionText = `<script server>
const pageData = { boardName: 'Boards', boardCount: 1 }
</script>
<h1><%= pageData.boardName %></h1>
`
    const sameFileDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      sameFileDefinitionText,
      sameFileDefinitionText.lastIndexOf('pageData') + 2
    )
    if (!sameFileDefinition || typeof sameFileDefinition === 'string') {
      throw new Error(`Expected same-file EJS definition target. Got: ${JSON.stringify(sameFileDefinition)}`)
    }
    if (normalizeFilePath(sameFileDefinition.filePath) !== normalizeFilePath(fixture.boardsFilePath)) {
      throw new Error(`Expected same-file EJS definition target path. Got: ${JSON.stringify(sameFileDefinition)}`)
    }
    if (sameFileDefinition.line !== 1) {
      throw new Error(`Expected same-file EJS definition to point at script server declaration. Got: ${JSON.stringify(sameFileDefinition)}`)
    }

    const renameText = `<script server>\nconst boardService = resolve('board-service')\nconst authState = boardService.readAuthState({ request })\n</script>\n`
    const renameOffset = renameText.indexOf('readAuthState') + 2
    const renameInfo = service.getRenameInfo(fixture.renameCheckFilePath, renameText, renameOffset)
    if (!renameInfo || !renameInfo.canRename || renameInfo.placeholder !== 'readAuthState') {
      throw new Error(`Expected rename info for resolve()-derived member. Got: ${JSON.stringify(renameInfo)}`)
    }

    const renameEdits = service.getRenameEdits(fixture.renameCheckFilePath, renameText, renameOffset, 'readSessionState')
    if (!renameEdits || !renameEdits.canRename) {
      throw new Error(`Expected rename edits for resolve()-derived member. Got: ${JSON.stringify(renameEdits)}`)
    }

    const boardServiceEdits = renameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceFilePath)
    )
    const renameCheckEdits = renameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
    )
    const middlewareEdits = renameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.middlewareFilePath)
    )

    if (boardServiceEdits.length < 2) {
      throw new Error(`Expected board-service.js rename edits for declaration + export. Got: ${JSON.stringify(boardServiceEdits)}`)
    }
    if (renameCheckEdits.length !== 1) {
      throw new Error(`Expected current EJS rename edit. Got: ${JSON.stringify(renameCheckEdits)}`)
    }
    if (middlewareEdits.length !== 1) {
      throw new Error(`Expected middleware JS rename edit. Got: ${JSON.stringify(middlewareEdits)}`)
    }

    const renamedBoardServiceText = applyEditsToText(fs.readFileSync(fixture.boardServiceFilePath, 'utf8'), boardServiceEdits)
    if (!renamedBoardServiceText.includes('function readSessionState(params)')) {
      throw new Error(`Expected renamed board-service declaration. Got: ${renamedBoardServiceText}`)
    }
    if (!renamedBoardServiceText.includes('module.exports = {\n  readSessionState,')) {
      throw new Error(`Expected renamed board-service export. Got: ${renamedBoardServiceText}`)
    }

    const renamedRenameCheckText = applyEditsToText(renameText, renameCheckEdits)
    if (!renamedRenameCheckText.includes('boardService.readSessionState({ request })')) {
      throw new Error(`Expected renamed current EJS usage. Got: ${renamedRenameCheckText}`)
    }

    const renamedMiddlewareText = applyEditsToText(fs.readFileSync(fixture.middlewareFilePath, 'utf8'), middlewareEdits)
    if (!renamedMiddlewareText.includes('boardService.readSessionState({ request })')) {
      throw new Error(`Expected renamed middleware usage. Got: ${renamedMiddlewareText}`)
    }

    const moduleRenameText = fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
    const moduleRenameOffset = moduleRenameText.indexOf('readAuthState') + 2
    const moduleRenameInfo = service.getRenameInfo(fixture.boardServiceFilePath, moduleRenameText, moduleRenameOffset)
    if (!moduleRenameInfo || !moduleRenameInfo.canRename || moduleRenameInfo.placeholder !== 'readAuthState') {
      throw new Error(`Expected module export rename info. Got: ${JSON.stringify(moduleRenameInfo)}`)
    }

    const moduleRenameEdits = service.getRenameEdits(
      fixture.boardServiceFilePath,
      moduleRenameText,
      moduleRenameOffset,
      'readSessionState'
    )
    if (!moduleRenameEdits || !moduleRenameEdits.canRename) {
      throw new Error(`Expected module export rename edits. Got: ${JSON.stringify(moduleRenameEdits)}`)
    }

    const moduleInitiatedBoardServiceEdits = moduleRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceFilePath)
    )
    const moduleInitiatedRenameCheckEdits = moduleRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
    )
    const moduleInitiatedMiddlewareEdits = moduleRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.middlewareFilePath)
    )

    if (moduleInitiatedBoardServiceEdits.length !== 0) {
      throw new Error(`Expected JS-initiated custom rename edits to skip module file edits. Got: ${JSON.stringify(moduleInitiatedBoardServiceEdits)}`)
    }
    if (moduleInitiatedRenameCheckEdits.length !== 1) {
      throw new Error(`Expected JS-initiated rename to update EJS usage. Got: ${JSON.stringify(moduleInitiatedRenameCheckEdits)}`)
    }
    if (moduleInitiatedMiddlewareEdits.length !== 1) {
      throw new Error(`Expected JS-initiated rename to update JS resolve() usage. Got: ${JSON.stringify(moduleInitiatedMiddlewareEdits)}`)
    }

    const jsResolveRenameText = fs.readFileSync(fixture.middlewareFilePath, 'utf8')
    const jsResolveRenameOffset = jsResolveRenameText.indexOf('readAuthState') + 2
    const jsResolveRenameInfo = service.getRenameInfo(fixture.middlewareFilePath, jsResolveRenameText, jsResolveRenameOffset)
    if (!jsResolveRenameInfo || !jsResolveRenameInfo.canRename || jsResolveRenameInfo.placeholder !== 'readAuthState') {
      throw new Error(`Expected JS resolve() rename info. Got: ${JSON.stringify(jsResolveRenameInfo)}`)
    }

    const jsResolveRenameEdits = service.getRenameEdits(
      fixture.middlewareFilePath,
      jsResolveRenameText,
      jsResolveRenameOffset,
      'readSessionState'
    )
    if (!jsResolveRenameEdits || !jsResolveRenameEdits.canRename) {
      throw new Error(`Expected JS resolve() rename edits. Got: ${JSON.stringify(jsResolveRenameEdits)}`)
    }

    const jsResolveBoardServiceEdits = jsResolveRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceFilePath)
    )
    const jsResolveRenameCheckEdits = jsResolveRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
    )
    const jsResolveMiddlewareEdits = jsResolveRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.middlewareFilePath)
    )

    if (jsResolveBoardServiceEdits.length < 2) {
      throw new Error(`Expected JS resolve() rename to update module declaration + export. Got: ${JSON.stringify(jsResolveBoardServiceEdits)}`)
    }
    if (jsResolveRenameCheckEdits.length !== 1) {
      throw new Error(`Expected JS resolve() rename to update EJS usage. Got: ${JSON.stringify(jsResolveRenameCheckEdits)}`)
    }
    if (jsResolveMiddlewareEdits.length !== 1) {
      throw new Error(`Expected JS resolve() rename to update current JS usage. Got: ${JSON.stringify(jsResolveMiddlewareEdits)}`)
    }

    const resolvePathReferenceOffset = renameText.indexOf('board-service') + 2
    const resolvePathReferences = service.getReferenceTargets(
      fixture.renameCheckFilePath,
      renameText,
      resolvePathReferenceOffset,
      { includeDeclaration: false }
    )
    if (!resolvePathReferences || resolvePathReferences.length !== 3) {
      throw new Error(`Expected resolve() path references in three files. Got: ${JSON.stringify(resolvePathReferences)}`)
    }
    if (
      !resolvePathReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
      ) ||
      !resolvePathReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.localsTypeCheckFilePath)
      ) ||
      !resolvePathReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.middlewareFilePath)
      )
    ) {
      throw new Error(`Expected resolve() path references for rename-check, locals-type-check, and middleware. Got: ${JSON.stringify(resolvePathReferences)}`)
    }

    const resolvedMemberReferences = service.getReferenceTargets(
      fixture.renameCheckFilePath,
      renameText,
      renameOffset,
      { includeDeclaration: true }
    )
    if (!resolvedMemberReferences || resolvedMemberReferences.length !== 4) {
      throw new Error(`Expected resolved member references for declaration, export, and usages. Got: ${JSON.stringify(resolvedMemberReferences)}`)
    }

    const moduleExportReferences = service.getReferenceTargets(
      fixture.boardServiceFilePath,
      moduleRenameText,
      moduleRenameOffset,
      { includeDeclaration: true }
    )
    if (!moduleExportReferences || moduleExportReferences.length !== 4) {
      throw new Error(`Expected module export references to include JS and EJS usages. Got: ${JSON.stringify(moduleExportReferences)}`)
    }

    const overriddenBoardServiceText = `/**
 * @param {{ request: { method: string } }} params
 * @returns {types.FixtureAuthState}
 */
function readSessionState(params) {
  return /** @type {any} */ ({
    ok: !!params,
    method: params.request.method,
  })
}

module.exports = {
  readSessionState,
}
`
    const overriddenResolveCallerText = `<script server>
const boardService = resolve('board-service')
boardService.readSessionState({ request })
</script>
`
    service.setDocumentOverride(fixture.boardServiceFilePath, overriddenBoardServiceText)
    const overriddenDefinition = service.getDefinitionTarget(
      fixture.renameCheckFilePath,
      overriddenResolveCallerText,
      overriddenResolveCallerText.indexOf('readSessionState') + 2
    )
    if (
      !overriddenDefinition ||
      typeof overriddenDefinition === 'string' ||
      normalizeFilePath(overriddenDefinition.filePath) !== normalizeFilePath(fixture.boardServiceFilePath)
    ) {
      throw new Error(`Expected resolved member definition to follow module override text. Got: ${JSON.stringify(overriddenDefinition)}`)
    }

    const overriddenRenameInfo = service.getRenameInfo(
      fixture.renameCheckFilePath,
      overriddenResolveCallerText,
      overriddenResolveCallerText.indexOf('readSessionState') + 2
    )
    if (!overriddenRenameInfo || !overriddenRenameInfo.canRename || overriddenRenameInfo.placeholder !== 'readSessionState') {
      throw new Error(`Expected resolved member rename info to follow module override text. Got: ${JSON.stringify(overriddenRenameInfo)}`)
    }
    service.clearDocumentOverride(fixture.boardServiceFilePath)

    const partialLocalReferenceText = fs.readFileSync(fixture.flashAlertFilePath, 'utf8')
    const partialLocalReferenceOffset = partialLocalReferenceText.lastIndexOf('flashTone') + 2
    const partialSymbolReferences = service.getReferenceTargets(
      fixture.flashAlertFilePath,
      partialLocalReferenceText,
      partialLocalReferenceOffset,
      { includeDeclaration: true }
    )
    if (!partialSymbolReferences || partialSymbolReferences.length !== 2) {
      throw new Error(`Expected _private partial symbol references to stay inside the partial file. Got: ${JSON.stringify(partialSymbolReferences)}`)
    }
    if (
      partialSymbolReferences.some(
        (entry) => normalizeFilePath(entry.filePath) !== normalizeFilePath(fixture.flashAlertFilePath)
      )
    ) {
      throw new Error(`Expected _private partial symbol references to avoid include() caller fallback. Got: ${JSON.stringify(partialSymbolReferences)}`)
    }

    const moduleReferenceQuery = service.getFileReferenceQuery(fixture.boardServiceFilePath)
    if (!moduleReferenceQuery || moduleReferenceQuery.kind !== 'private-module') {
      throw new Error(`Expected _private module file reference query. Got: ${JSON.stringify(moduleReferenceQuery)}`)
    }

    const moduleFileReferences = service.getFileReferenceTargets(fixture.boardServiceFilePath, fs.readFileSync(fixture.boardServiceFilePath, 'utf8'))
    if (!moduleFileReferences || moduleFileReferences.length !== 4) {
      throw new Error(`Expected file-based resolve()/require() references in four files. Got: ${JSON.stringify(moduleFileReferences)}`)
    }
    if (!moduleFileReferences.some((entry) => normalizeFilePath(entry.filePath).endsWith('/pb_hooks/pages/_private/board-service-consumer.js'))) {
      throw new Error(`Expected file-based module references to include static require() usage. Got: ${JSON.stringify(moduleFileReferences)}`)
    }

    service.setDocumentOverride(
      fixture.boardServiceConsumerFilePath,
      `const firstBoardService = require('./board-service')
const secondBoardService = require('./board-service')

module.exports = {
  firstBoardService,
  secondBoardService,
}
`
    )
    const overriddenModuleFileReferences = service.getFileReferenceTargets(
      fixture.boardServiceFilePath,
      fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
    )
    const overriddenConsumerReferences = (overriddenModuleFileReferences || []).filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceConsumerFilePath)
    )
    if (overriddenConsumerReferences.length !== 2) {
      throw new Error(`Expected file-based module references to follow open document overrides. Got: ${JSON.stringify(overriddenConsumerReferences)}`)
    }
    service.clearDocumentOverride(fixture.boardServiceConsumerFilePath)

    const partialRenameEdits = service.getFileRenameEdits(
      fixture.flashAlertFilePath,
      path.resolve(path.dirname(fixture.flashAlertFilePath), 'notice-alert.ejs')
    )
    if (!partialRenameEdits || partialRenameEdits.length !== 1) {
      throw new Error(`Expected file rename edits for flash-alert partial. Got: ${JSON.stringify(partialRenameEdits)}`)
    }
    if (normalizeFilePath(partialRenameEdits[0].filePath) !== normalizeFilePath(fixture.boardsFilePath)) {
      throw new Error(`Expected partial rename edit in boards index. Got: ${JSON.stringify(partialRenameEdits)}`)
    }

    const renamedPartialIncludeText = applyEditsToText(
      fs.readFileSync(fixture.boardsFilePath, 'utf8'),
      partialRenameEdits.filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath))
    )
    if (!renamedPartialIncludeText.includes(`include('notice-alert.ejs'`)) {
      throw new Error(`Expected include() request path to update after partial file rename. Got: ${renamedPartialIncludeText}`)
    }

    const moduleFileRenameEdits = service.getFileRenameEdits(
      fixture.boardServiceFilePath,
      path.resolve(path.dirname(fixture.boardServiceFilePath), 'session-service.js')
    )
    if (!moduleFileRenameEdits || moduleFileRenameEdits.length !== 4) {
      throw new Error(`Expected file rename edits for _private module. Got: ${JSON.stringify(moduleFileRenameEdits)}`)
    }

    const renamedResolveCheckText = applyEditsToText(
      fs.readFileSync(fixture.renameCheckFilePath, 'utf8'),
      moduleFileRenameEdits.filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath))
    )
    if (!renamedResolveCheckText.includes(`resolve('session-service')`)) {
      throw new Error(`Expected rename-check resolve() path to update after module file rename. Got: ${renamedResolveCheckText}`)
    }

    const renamedLocalsTypeCheckText = applyEditsToText(
      fs.readFileSync(fixture.localsTypeCheckFilePath, 'utf8'),
      moduleFileRenameEdits.filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.localsTypeCheckFilePath))
    )
    if (!renamedLocalsTypeCheckText.includes(`resolve('session-service')`)) {
      throw new Error(`Expected locals-type-check resolve() path to update after module file rename. Got: ${renamedLocalsTypeCheckText}`)
    }

    const renamedMiddlewareResolveText = applyEditsToText(
      fs.readFileSync(fixture.middlewareFilePath, 'utf8'),
      moduleFileRenameEdits.filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.middlewareFilePath))
    )
    if (!renamedMiddlewareResolveText.includes(`resolve('session-service')`)) {
      throw new Error(`Expected middleware resolve() path to update after module file rename. Got: ${renamedMiddlewareResolveText}`)
    }

    const renamedRequireConsumerText = applyEditsToText(
      fs.readFileSync(fixture.boardServiceConsumerFilePath, 'utf8'),
      moduleFileRenameEdits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceConsumerFilePath)
      )
    )
    if (!renamedRequireConsumerText.includes(`require('./session-service')`)) {
      throw new Error(`Expected static require() path to update after module file rename. Got: ${renamedRequireConsumerText}`)
    }

    const duplicatePartialCallerText = `<%- include('flash-alert.ejs', { flashMessage: 'Saved' }) %>\n<%- include('flash-alert.ejs', { flashMessage: 'Again' }) %>\n`
    service.setDocumentOverride(fixture.boardsFilePath, duplicatePartialCallerText)
    const duplicatePartialRenameEdits = service.getFileRenameEdits(
      fixture.flashAlertFilePath,
      path.resolve(path.dirname(fixture.flashAlertFilePath), 'notice-alert.ejs')
    )
    const duplicateBoardsEdits = duplicatePartialRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    if (duplicateBoardsEdits.length !== 2) {
      throw new Error(`Expected two include() edits in the same caller file. Got: ${JSON.stringify(duplicateBoardsEdits)}`)
    }
    const duplicatePartialRenamedText = applyEditsToText(duplicatePartialCallerText, duplicateBoardsEdits)
    if ((duplicatePartialRenamedText.match(/notice-alert\.ejs/g) || []).length !== 2) {
      throw new Error(`Expected both include() paths to rename in the same caller file. Got: ${duplicatePartialRenamedText}`)
    }
    service.clearDocumentOverride(fixture.boardsFilePath)

    const duplicateResolveCallerText = `<script server>
const firstBoardService = resolve('board-service')
const secondBoardService = resolve('board-service')
firstBoardService.readAuthState({ request })
secondBoardService.readAuthState({ request })
</script>
`
    const duplicateRequireCallerText = `const firstBoardService = require('./board-service')
const secondBoardService = require('./board-service')

module.exports = {
  firstBoardService,
  secondBoardService,
}
`
    service.setDocumentOverride(fixture.renameCheckFilePath, duplicateResolveCallerText)
    service.setDocumentOverride(fixture.boardServiceConsumerFilePath, duplicateRequireCallerText)
    const duplicateModuleRenameEdits = service.getFileRenameEdits(
      fixture.boardServiceFilePath,
      path.resolve(path.dirname(fixture.boardServiceFilePath), 'session-service.js')
    )
    const duplicateResolveEdits = duplicateModuleRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
    )
    const duplicateRequireEdits = duplicateModuleRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceConsumerFilePath)
    )
    if (duplicateResolveEdits.length !== 2) {
      throw new Error(`Expected two resolve() edits in the same caller file. Got: ${JSON.stringify(duplicateResolveEdits)}`)
    }
    if (duplicateRequireEdits.length !== 2) {
      throw new Error(`Expected two require() edits in the same caller file. Got: ${JSON.stringify(duplicateRequireEdits)}`)
    }
    const duplicateResolveRenamedText = applyEditsToText(duplicateResolveCallerText, duplicateResolveEdits)
    if ((duplicateResolveRenamedText.match(/resolve\('session-service'\)/g) || []).length !== 2) {
      throw new Error(`Expected both resolve() paths to rename in the same caller file. Got: ${duplicateResolveRenamedText}`)
    }
    const duplicateRequireRenamedText = applyEditsToText(duplicateRequireCallerText, duplicateRequireEdits)
    if ((duplicateRequireRenamedText.match(/require\('\.\/session-service'\)/g) || []).length !== 2) {
      throw new Error(`Expected both require() paths to rename in the same caller file. Got: ${duplicateRequireRenamedText}`)
    }
    service.clearDocumentOverride(fixture.renameCheckFilePath)
    service.clearDocumentOverride(fixture.boardServiceConsumerFilePath)

    const routeReferenceQuery = service.getFileReferenceQuery(fixture.boardsFilePath)
    if (!routeReferenceQuery || routeReferenceQuery.kind !== 'route-file' || routeReferenceQuery.routePath !== '/boards') {
      throw new Error(`Expected static route file reference query for /boards. Got: ${JSON.stringify(routeReferenceQuery)}`)
    }

    const routeFileReferences = service.getFileReferenceTargets(fixture.boardsFilePath, fs.readFileSync(fixture.boardsFilePath, 'utf8'))
    if (!routeFileReferences || routeFileReferences.length !== 1) {
      throw new Error(`Expected file-based route references for /boards. Got: ${JSON.stringify(routeFileReferences)}`)
    }
    if (!routeFileReferences.some((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.siteIndexFilePath))) {
      throw new Error(`Expected /boards route reference to point at site index href. Got: ${JSON.stringify(routeFileReferences)}`)
    }

    const partialCodeLensEntries = service.getCodeLensEntries(
      fixture.flashAlertFilePath,
      fs.readFileSync(fixture.flashAlertFilePath, 'utf8')
    )
    if (!partialCodeLensEntries.some((entry) => entry.title.startsWith('Partial callers: '))) {
      throw new Error(`Expected partial caller CodeLens entry. Got: ${JSON.stringify(partialCodeLensEntries)}`)
    }
    if (!partialCodeLensEntries.some((entry) => entry.title.startsWith('All File References ('))) {
      throw new Error(`Expected partial all-file-references CodeLens entry. Got: ${JSON.stringify(partialCodeLensEntries)}`)
    }

    const boardsCodeLensEntries = service.getCodeLensEntries(
      fixture.boardsFilePath,
      fs.readFileSync(fixture.boardsFilePath, 'utf8')
    )
    const includePathCodeLens = boardsCodeLensEntries.find((entry) => entry.title === '-> pb_hooks/pages/_private/flash-alert.ejs')
    if (
      !includePathCodeLens ||
      typeof includePathCodeLens.start !== 'number' ||
      includePathCodeLens.start <= 0 ||
      normalizeFilePath(includePathCodeLens.targetFilePath) !== normalizeFilePath(fixture.flashAlertFilePath)
    ) {
      throw new Error(`Expected include() path CodeLens entry above the include call. Got: ${JSON.stringify(boardsCodeLensEntries)}`)
    }

    const routeCodeLensEntries = service.getCodeLensEntries(
      fixture.boardShowFilePath,
      fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    )
    if (!routeCodeLensEntries.some((entry) => entry.title === 'Route: /boards/[boardSlug]')) {
      throw new Error(`Expected dynamic route CodeLens entry. Got: ${JSON.stringify(routeCodeLensEntries)}`)
    }

    const siteSignInReferenceQuery = service.getFileReferenceQuery(fixture.siteSignInFilePath)
    if (!siteSignInReferenceQuery || siteSignInReferenceQuery.kind !== 'route-file' || siteSignInReferenceQuery.routePath !== '/sign-in') {
      throw new Error(`Expected static route file reference query for /sign-in. Got: ${JSON.stringify(siteSignInReferenceQuery)}`)
    }

    const siteSignInFileReferences = service.getFileReferenceTargets(
      fixture.siteSignInFilePath,
      fs.readFileSync(fixture.siteSignInFilePath, 'utf8')
    )
    if (!siteSignInFileReferences || siteSignInFileReferences.length !== 5) {
      throw new Error(`Expected file-based route references for /sign-in across multiple source kinds. Got: ${JSON.stringify(siteSignInFileReferences)}`)
    }
    const routeReferenceCheckMatches = siteSignInFileReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (routeReferenceCheckMatches.length !== 4) {
      throw new Error(`Expected href/action/hx/redirect route references in route-reference-check.ejs. Got: ${JSON.stringify(routeReferenceCheckMatches)}`)
    }

    const hrefDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<a href="/boards"></a>\n`,
      `<a href="/boards"></a>\n`.indexOf('/boards') + 2
    )
    if (!hrefDefinition || !hrefDefinition.endsWith('/pb_hooks/pages/(site)/boards/index.ejs')) {
      throw new Error(`Expected href route definition target. Got: ${hrefDefinition}`)
    }

    const actionDefinition = authService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<form action="/xapi/auth/sign-out" method="post"></form>\n`,
      `<form action="/xapi/auth/sign-out" method="post"></form>\n`.indexOf('/xapi/auth/sign-out') + 2
    )
    if (!actionDefinition || !actionDefinition.endsWith('/pb_hooks/pages/xapi/auth/sign-out.ejs')) {
      throw new Error(`Expected action route definition target. Got: ${actionDefinition}`)
    }

    const htmxDefinition = authService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-post="/xapi/jobs/collect-weekly"></button>\n`,
      `<button hx-post="/xapi/jobs/collect-weekly"></button>\n`.indexOf('/xapi/jobs/collect-weekly') + 2
    )
    if (!htmxDefinition || !htmxDefinition.endsWith('/pb_hooks/pages/xapi/jobs/collect-weekly.ejs')) {
      throw new Error(`Expected hx-post route definition target. Got: ${htmxDefinition}`)
    }

    const redirectDefinition = authService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<script server>\nredirect('/sign-in', { status: 303 })\n</script>\n`,
      `<script server>\nredirect('/sign-in', { status: 303 })\n</script>\n`.indexOf('/sign-in') + 2
    )
    if (!redirectDefinition || !redirectDefinition.endsWith('/pb_hooks/pages/(site)/sign-in.ejs')) {
      throw new Error(`Expected redirect() route definition target. Got: ${redirectDefinition}`)
    }

    const diagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\n$app.findRecordsByFilter('missing_collection')\nboard.get('missing_field')\n</script>\n`
    )
    const diagnosticMessages = diagnostics.map((entry) => String(entry.message))
    if (!diagnosticMessages.some((message) => message.includes('Unknown PocketBase collection "missing_collection"'))) {
      throw new Error(`Expected unknown collection diagnostic. Got: ${diagnosticMessages.join(' | ')}`)
    }
    if (!diagnosticMessages.some((message) => message.includes('Unknown field "missing_field" for collection "boards"'))) {
      throw new Error(`Expected unknown field diagnostic. Got: ${diagnosticMessages.join(' | ')}`)
    }

    const typedRecordGetText = `<script server>
const board = $app.findRecordById('boards', 'board-1')
const boardName = board.get('name')
const isActive = board.get('is_active')
const sortOrder = board.get('sort_order')
const metaPayload = board.get('meta_json')

boardName.trim()
isActive.trim()
sortOrder.trim()
metaPayload.trim()
</script>\n`
    const boardNameQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardName =') + 2
    )
    if (!boardNameQuickInfo || !boardNameQuickInfo.displayText.includes('const boardName: string')) {
      throw new Error(`Expected record.get('name') quick info to resolve to string. Got: ${JSON.stringify(boardNameQuickInfo)}`)
    }

    const isActiveQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('isActive =') + 2
    )
    if (!isActiveQuickInfo || !isActiveQuickInfo.displayText.includes('const isActive: boolean')) {
      throw new Error(`Expected record.get('is_active') quick info to resolve to boolean. Got: ${JSON.stringify(isActiveQuickInfo)}`)
    }

    const sortOrderQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('sortOrder =') + 2
    )
    if (!sortOrderQuickInfo || !sortOrderQuickInfo.displayText.includes('const sortOrder: number')) {
      throw new Error(`Expected record.get('sort_order') quick info to resolve to number. Got: ${JSON.stringify(sortOrderQuickInfo)}`)
    }

    const metaPayloadQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('metaPayload =') + 2
    )
    if (!metaPayloadQuickInfo || !metaPayloadQuickInfo.displayText.includes('const metaPayload: any')) {
      throw new Error(`Expected record.get('meta_json') quick info to resolve to any. Got: ${JSON.stringify(metaPayloadQuickInfo)}`)
    }

    const typedRecordGetDiagnostics = service.getDiagnostics(fixture.boardsFilePath, typedRecordGetText)
    const typedRecordGetMessages = typedRecordGetDiagnostics.map((entry) => String(entry.message))
    if (!typedRecordGetMessages.some((message) => message.includes("Property 'trim' does not exist on type 'boolean'"))) {
      throw new Error(`Expected boolean record.get() diagnostics. Got: ${typedRecordGetMessages.join(' | ')}`)
    }
    if (!typedRecordGetMessages.some((message) => message.includes("Property 'trim' does not exist on type 'number'"))) {
      throw new Error(`Expected number record.get() diagnostics. Got: ${typedRecordGetMessages.join(' | ')}`)
    }
    if (typedRecordGetMessages.some((message) => message.includes("Property 'trim' does not exist on type 'string'"))) {
      throw new Error(`Expected string record.get() typing to avoid trim() diagnostics. Got: ${typedRecordGetMessages.join(' | ')}`)
    }
    if (typedRecordGetMessages.some((message) => message.includes("Property 'trim' does not exist on type 'any'"))) {
      throw new Error(`Expected json record.get() typing to stay permissive. Got: ${typedRecordGetMessages.join(' | ')}`)
    }

    const typedRecordGetInlayHints = service.getInlayHintEntries(fixture.boardsFilePath, typedRecordGetText)
    if (!typedRecordGetInlayHints.some((entry) => entry.label === ': string')) {
      throw new Error(`Expected record.get() string inlay hint. Got: ${JSON.stringify(typedRecordGetInlayHints)}`)
    }
    if (!typedRecordGetInlayHints.some((entry) => entry.label === ': boolean')) {
      throw new Error(`Expected record.get() boolean inlay hint. Got: ${JSON.stringify(typedRecordGetInlayHints)}`)
    }

    const resolveInlayHintText = `<script server>\nconst boardService = resolve('board-service')\n</script>\n`
    const resolveInlayHints = service.getInlayHintEntries(fixture.boardsFilePath, resolveInlayHintText)
    if (!resolveInlayHints.some((entry) => String(entry.label).includes('pb_hooks/pages/_private/board-service.js'))) {
      throw new Error(`Expected resolve() target inlay hint. Got: ${JSON.stringify(resolveInlayHints)}`)
    }
    const includePathInlayHints = service.getInlayHintEntries(
      fixture.boardsFilePath,
      fs.readFileSync(fixture.boardsFilePath, 'utf8')
    )
    if (includePathInlayHints.some((entry) => String(entry.label).includes('flash-alert.ejs'))) {
      throw new Error(`Expected include() path hints to move from inline inlay hints to CodeLens. Got: ${JSON.stringify(includePathInlayHints)}`)
    }

    const templateDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst authState = { email: '' }\n</script>\n<p><%= authState.email %></p>\n<p><%= missingAuthState.email %></p>\n`
    )
    if (!templateDiagnostics.some((entry) => entry.code === 2304 && String(entry.message).includes('missingAuthState'))) {
      throw new Error(
        `Expected EJS template semantic diagnostic for missingAuthState. Got: ${templateDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const sameLineTemplateDiagnostics = service.getDiagnostics(
      fixture.boardShowFilePath,
      `<a href="/boards/<%= params.boardSlug %>" class="link"><%= pageData.boardName %></a>\n`
    )
    if (sameLineTemplateDiagnostics.some((entry) => entry.code === 1005)) {
      throw new Error(
        `Expected same-line EJS expressions to avoid parser false positives. Got: ${sameLineTemplateDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const templateLiteralContinuationDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst item = { ok: true }\n</script>\n<div class="<%= item.ok ? 'on' : 'off' %>">\n  <span class="<%= \`badge \${item.ok ? 'yes' : 'no'}\` %>"></span>\n</div>\n`
    )
    if (templateLiteralContinuationDiagnostics.some((entry) => entry.code === 2349)) {
      throw new Error(
        `Expected multiline EJS expressions before template literals to avoid callable false positives. Got: ${templateLiteralContinuationDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const templateSchemaDiagnostics = service.getDiagnostics(
      fixture.boardShowFilePath,
      `<% const board = pageData.board %>\n<p><%= board.get('missing_field') %></p>\n`
    )
    if (
      !templateSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "boards"')
      )
    ) {
      throw new Error(
        `Expected EJS template schema diagnostic. Got: ${templateSchemaDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const paramsQueryDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nparams.sort\n</script>\n`
    )
    if (!paramsQueryDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected params query-string diagnostic. Got: ${paramsQueryDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const paramsQueryCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<script server>\nparams.sort\n</script>\n`,
      {
        start: `<script server>\nparams.sort\n</script>\n`.indexOf('params'),
        end: `<script server>\nparams.sort\n</script>\n`.indexOf('sort') + 'sort'.length,
      }
    )
    if (
      !paramsQueryCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === 'request.url.query')
      )
    ) {
      throw new Error(`Expected params query quick fix. Got: ${JSON.stringify(paramsQueryCodeActions)}`)
    }

    const routeParamDiagnostics = service.getDiagnostics(
      fixture.boardShowFilePath,
      `<script server>\nparams.boardSlug\n</script>\n`
    )
    if (routeParamDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected route params access to skip AGENTS query diagnostic. Got: ${routeParamDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const resolvePrivatePrefixDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nresolve('/_private/board-service')\n</script>\n`
    )
    if (!resolvePrivatePrefixDiagnostics.some((entry) => entry.code === 'pp-resolve-private-prefix')) {
      throw new Error(
        `Expected resolve('/_private/...') diagnostic. Got: ${resolvePrivatePrefixDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const resolvePrivatePrefixCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<script server>\nresolve('/_private/board-service')\n</script>\n`,
      {
        start: `<script server>\nresolve('/_private/board-service')\n</script>\n`.indexOf('/_private/board-service'),
        end:
          `<script server>\nresolve('/_private/board-service')\n</script>\n`.indexOf('/_private/board-service') +
          '/_private/board-service'.length,
      }
    )
    if (
      !resolvePrivatePrefixCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === 'board-service')
      )
    ) {
      throw new Error(`Expected resolve('/_private/...') quick fix. Got: ${JSON.stringify(resolvePrivatePrefixCodeActions)}`)
    }

    const unresolvedResolveDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-servce')\n</script>\n`
    )
    const unresolvedResolveDiagnostic = unresolvedResolveDiagnostics.find((entry) => entry.code === 'pp-unresolved-resolve-path')
    if (!unresolvedResolveDiagnostic || !String(unresolvedResolveDiagnostic.message).includes('board-service')) {
      throw new Error(`Expected unresolved resolve() path diagnostic with suggestion. Got: ${JSON.stringify(unresolvedResolveDiagnostics)}`)
    }

    const unresolvedResolveCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-servce')\n</script>\n`,
      {
        start: `<script server>\nresolve('board-servce')\n</script>\n`.indexOf('board-servce'),
        end: `<script server>\nresolve('board-servce')\n</script>\n`.indexOf('board-servce') + 'board-servce'.length,
      }
    )
    if (
      !unresolvedResolveCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === 'board-service')
      )
    ) {
      throw new Error(`Expected unresolved resolve() path quick fix. Got: ${JSON.stringify(unresolvedResolveCodeActions)}`)
    }
    if (unresolvedResolveCodeActions.some((entry) => Array.isArray(entry.creates) && entry.creates.length)) {
      throw new Error(`Expected unresolved resolve() typo fix to prefer suggestions over create-file actions. Got: ${JSON.stringify(unresolvedResolveCodeActions)}`)
    }

    const missingResolveDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nresolve('new-dashboard-service')\n</script>\n`
    )
    if (!missingResolveDiagnostics.some((entry) => entry.code === 'pp-unresolved-resolve-path')) {
      throw new Error(`Expected unresolved resolve() path diagnostic for missing module. Got: ${JSON.stringify(missingResolveDiagnostics)}`)
    }

    const unresolvedIncludeDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('flash-alret.ejs') %>\n`
    )
    const unresolvedIncludeDiagnostic = unresolvedIncludeDiagnostics.find((entry) => entry.code === 'pp-unresolved-include-path')
    if (!unresolvedIncludeDiagnostic || !String(unresolvedIncludeDiagnostic.message).includes('flash-alert.ejs')) {
      throw new Error(`Expected unresolved include() path diagnostic with suggestion. Got: ${JSON.stringify(unresolvedIncludeDiagnostics)}`)
    }

    const unresolvedIncludeCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<%- include('flash-alret.ejs') %>\n`,
      {
        start: `<%- include('flash-alret.ejs') %>\n`.indexOf('flash-alret.ejs'),
        end: `<%- include('flash-alret.ejs') %>\n`.indexOf('flash-alret.ejs') + 'flash-alret.ejs'.length,
      }
    )
    if (
      !unresolvedIncludeCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === 'flash-alert.ejs')
      )
    ) {
      throw new Error(`Expected unresolved include() path quick fix. Got: ${JSON.stringify(unresolvedIncludeCodeActions)}`)
    }

    const includeUnknownLocalDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs', { flashMesage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`
    )
    const includeUnknownLocalDiagnostic = includeUnknownLocalDiagnostics.find((entry) => entry.code === 'pp-include-unknown-local')
    if (!includeUnknownLocalDiagnostic || !String(includeUnknownLocalDiagnostic.message).includes('flashMessage')) {
      throw new Error(`Expected include() unknown local diagnostic with rename suggestion. Got: ${JSON.stringify(includeUnknownLocalDiagnostics)}`)
    }
    if (
      includeUnknownLocalDiagnostics.some(
        (entry) => entry.code === 'pp-include-missing-local' && String(entry.message).includes('flashMessage')
      )
    ) {
      throw new Error(`Expected include() typo local diagnostic to suppress duplicate missing-local warning. Got: ${JSON.stringify(includeUnknownLocalDiagnostics)}`)
    }

    const includeUnknownLocalCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs', { flashMesage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`,
      {
        start:
          `<%- include('flash-alert.ejs', { flashMesage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`.indexOf('flashMesage'),
        end:
          `<%- include('flash-alert.ejs', { flashMesage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`.indexOf('flashMesage') +
          'flashMesage'.length,
      }
    )
    if (
      !includeUnknownLocalCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === 'flashMessage')
      )
    ) {
      throw new Error(`Expected include() unknown local rename quick fix. Got: ${JSON.stringify(includeUnknownLocalCodeActions)}`)
    }

    const includeMissingLocalDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs', { isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`
    )
    if (
      !includeMissingLocalDiagnostics.some(
        (entry) => entry.code === 'pp-include-missing-local' && String(entry.message).includes('flashMessage')
      )
    ) {
      throw new Error(`Expected include() missing local diagnostic for flashMessage. Got: ${JSON.stringify(includeMissingLocalDiagnostics)}`)
    }

    const includeMissingLocalCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs', { isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`,
      {
        start: `<%- include('flash-alert.ejs', { isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`.indexOf('flash-alert.ejs'),
        end:
          `<%- include('flash-alert.ejs', { isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`.indexOf('flash-alert.ejs') +
          'flash-alert.ejs'.length,
      }
    )
    const addMissingLocalAction = includeMissingLocalCodeActions.find((entry) => entry.title.includes('flashMessage'))
    if (!addMissingLocalAction) {
      throw new Error(`Expected include() missing-local stub quick fix. Got: ${JSON.stringify(includeMissingLocalCodeActions)}`)
    }
    const includeMissingLocalPatchedText = applyEditsToText(
      `<%- include('flash-alert.ejs', { isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`,
      addMissingLocalAction.edits
    )
    if (!includeMissingLocalPatchedText.includes('flashMessage: undefined')) {
      throw new Error(`Expected include() missing-local quick fix to add a stub local. Got: ${includeMissingLocalPatchedText}`)
    }

    const requiredFlashCallerFilePath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      '(site)',
      'boards',
      'flash-alert-required-check.ejs'
    )
    writeFile(
      requiredFlashCallerFilePath,
      `<%- include('flash-alert.ejs', { isErrorFlash: true, flashMeta: { count: 2 } }) %>\n`
    )
    const requiredFlashCallerDiagnostics = service.getDiagnostics(
      requiredFlashCallerFilePath,
      `<%- include('flash-alert.ejs', { isErrorFlash: true, flashMeta: { count: 2 } }) %>\n`
    )
    if (
      !requiredFlashCallerDiagnostics.some(
        (entry) => entry.code === 'pp-include-missing-local' && String(entry.message).includes('flashMessage')
      )
    ) {
      throw new Error(`Expected include() required local diagnostic to remain active across multiple call sites. Got: ${JSON.stringify(requiredFlashCallerDiagnostics)}`)
    }

    const validFlashCallerDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs', { flashMessage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`
    )
    if (validFlashCallerDiagnostics.some((entry) => entry.code === 'pp-include-missing-local')) {
      throw new Error(`Expected valid include() call site to avoid missing-local diagnostics after adding another caller. Got: ${JSON.stringify(validFlashCallerDiagnostics)}`)
    }

    const includeOptionalLocalDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('optional-notice.ejs', { tone: 'notice' }) %>\n`
    )
    if (includeOptionalLocalDiagnostics.some((entry) => entry.code === 'pp-include-missing-local')) {
      throw new Error(`Expected include() optional locals to avoid missing-local diagnostics. Got: ${JSON.stringify(includeOptionalLocalDiagnostics)}`)
    }

    const includeDynamicLocalDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst flashLocals = { isErrorFlash: false, flashMeta: { count: 1 } }\n</script>\n<%- include('flash-alert.ejs', flashLocals) %>\n`
    )
    if (includeDynamicLocalDiagnostics.some((entry) => entry.code === 'pp-include-missing-local')) {
      throw new Error(`Expected dynamic include() locals to skip missing-local diagnostics. Got: ${JSON.stringify(includeDynamicLocalDiagnostics)}`)
    }

    const includeGlobalNamedLocalDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst errorMessage = 'Failed'\n</script>\n<%- include('error-panel.ejs', { error: errorMessage }) %>\n`
    )
    if (includeGlobalNamedLocalDiagnostics.some((entry) => entry.code === 'pp-include-unknown-local')) {
      throw new Error(`Expected include() locals that shadow PocketPages globals to avoid unknown-local diagnostics. Got: ${JSON.stringify(includeGlobalNamedLocalDiagnostics)}`)
    }

    const missingIncludeDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('new-status-card.ejs') %>\n`
    )
    if (!missingIncludeDiagnostics.some((entry) => entry.code === 'pp-unresolved-include-path')) {
      throw new Error(`Expected unresolved include() path diagnostic for missing partial. Got: ${JSON.stringify(missingIncludeDiagnostics)}`)
    }

    const unresolvedRouteDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<a href="/signn-in?next=/boards"></a>\n`
    )
    const unresolvedRouteDiagnostic = unresolvedRouteDiagnostics.find((entry) => entry.code === 'pp-unresolved-route-path')
    if (!unresolvedRouteDiagnostic || !String(unresolvedRouteDiagnostic.message).includes('/sign-in')) {
      throw new Error(`Expected unresolved route path diagnostic with suggestion. Got: ${JSON.stringify(unresolvedRouteDiagnostics)}`)
    }

    const unresolvedRouteCodeActions = service.getCodeActions(
      fixture.siteIndexFilePath,
      `<a href="/signn-in?next=/boards"></a>\n`,
      {
        start: `<a href="/signn-in?next=/boards"></a>\n`.indexOf('/signn-in?next=/boards'),
        end:
          `<a href="/signn-in?next=/boards"></a>\n`.indexOf('/signn-in?next=/boards') +
          '/signn-in?next=/boards'.length,
      }
    )
    if (
      !unresolvedRouteCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === '/sign-in?next=/boards')
      )
    ) {
      throw new Error(`Expected unresolved route path quick fix to preserve query suffix. Got: ${JSON.stringify(unresolvedRouteCodeActions)}`)
    }

    const dynamicRouteDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<a href="/boards/<%= params.boardSlug %>/posts/new"></a>\n`
    )
    if (dynamicRouteDiagnostics.some((entry) => entry.code === 'pp-unresolved-route-path')) {
      throw new Error(`Expected dynamic EJS route paths to skip unresolved-route diagnostics. Got: ${JSON.stringify(dynamicRouteDiagnostics)}`)
    }

    const partialContextDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs', { params, request }) %>\n`
    )
    if (!partialContextDiagnostics.some((entry) => entry.code === 'pp-partial-full-context')) {
      throw new Error(
        `Expected include() full context diagnostic. Got: ${partialContextDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const validClientScriptDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<script>
const oneSignalAppId = '<%= String(env("ONESIGNAL_APPID") || "") %>'
const oneSignalExternalId = '<%= request.auth ? String(request.auth.get("id") || "") : "" %>'
</script>
`
    )
    if (validClientScriptDiagnostics.length > 0) {
      throw new Error(
        `Expected safe client <script> sample to avoid extra diagnostics. Got: ${JSON.stringify(validClientScriptDiagnostics)}`
      )
    }

    const externalClientScriptDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>
`
    )
    if (externalClientScriptDiagnostics.length > 0) {
      throw new Error(
        `Expected external client <script src="<%= asset(...) %>"> to avoid diagnostics. Got: ${JSON.stringify(externalClientScriptDiagnostics)}`
      )
    }

    const multilineExternalClientScriptDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<script
  src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
  data-fallback-src="<%= asset('/assets/vendor/jszip-3.10.1.min.js') %>"
  onerror="window.__assetFallback(this)"></script>
`
    )
    if (multilineExternalClientScriptDiagnostics.length > 0) {
      throw new Error(
        `Expected multiline external client <script> with EJS attributes to avoid diagnostics. Got: ${JSON.stringify(multilineExternalClientScriptDiagnostics)}`
      )
    }

    const clientScriptSyntaxDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<script>
const state = {
  open: true
</script>
`
    )
    if (!clientScriptSyntaxDiagnostics.some((entry) => Number(entry.code) === 1005)) {
      throw new Error(
        `Expected client <script> syntax diagnostics to include TS1005. Got: ${JSON.stringify(clientScriptSyntaxDiagnostics)}`
      )
    }

    const manualFlashDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nredirect('/boards?__flash=saved')\n</script>\n`
    )
    if (!manualFlashDiagnostics.some((entry) => entry.code === 'pp-manual-flash-query')) {
      throw new Error(
        `Expected manual __flash query diagnostic. Got: ${manualFlashDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const privateTemplateDiagnostics = service.getDiagnostics(
      fixture.flashAlertFilePath,
      `<% const flashTone = isErrorFlash ? 'error' : 'notice' %>\n<div><%= flashMessage %> / <%= flashTone %> / <%= flashMeta.count %></div>\n`
    )
    if (privateTemplateDiagnostics.some((entry) => entry.code === 2304)) {
      throw new Error(
        `Expected _private EJS template diagnostics to understand include locals. Got: ${privateTemplateDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst pageData = { boards: [], error: '' }\n</script>\n`
    )
    const isolatedDiagnostics = service.getDiagnostics(
      fixture.boardShowFilePath,
      `<script server>\nconst pageData = { post: null, error: '' }\n</script>\n`
    )
    if (isolatedDiagnostics.some((entry) => String(entry.message).includes('Cannot redeclare block-scoped variable'))) {
      throw new Error(
        `Expected per-file module isolation for server scripts. Got: ${isolatedDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const relaxedBodyAliasDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst form = body()\nform.reportDate\n</script>\n`
    )
    if (relaxedBodyAliasDiagnostics.some((entry) => entry.code === 2339)) {
      throw new Error(
        `Expected body()-derived alias property access to skip TS2339. Got: ${relaxedBodyAliasDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const relaxedBodyDestructureDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst { message } = body()\nmessage\n</script>\n`
    )
    if (relaxedBodyDestructureDiagnostics.some((entry) => entry.code === 2339)) {
      throw new Error(
        `Expected body() destructuring to skip TS2339. Got: ${relaxedBodyDestructureDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const returnDiagnostics = authService.getDiagnostics(
      fixture.signOutFilePath,
      `<script server>\nredirect('/')\nreturn\n</script>\n`
    )
    if (returnDiagnostics.some((entry) => entry.code === 1108)) {
      throw new Error(
        `Expected top-level return to skip TS1108 in <script server>. Got: ${returnDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const authGlobalDiagnostics = authService.getDiagnostics(
      fixture.signInFilePath,
      `<script server>\nsignInWithPassword('a', 'b')\nsignOut()\n</script>\n`
    )
    if (authGlobalDiagnostics.some((entry) => entry.code === 2304)) {
      throw new Error(
        `Expected auth globals to be declared in app globals. Got: ${authGlobalDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const documentLinks = service.getDocumentLinks(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-service')\n</script>\n<%- include('flash-alert.ejs') %>\n`
    )
    const documentLinkTargets = documentLinks.map((entry) => entry.targetFilePath)
    if (!documentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/_private/board-service.js'))) {
      throw new Error(`Expected resolve() document link target. Got: ${documentLinkTargets.join(', ')}`)
    }
    if (!documentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/_private/flash-alert.ejs'))) {
      throw new Error(`Expected include() document link target. Got: ${documentLinkTargets.join(', ')}`)
    }

    const routeDocumentLinks = authService.getDocumentLinks(
      fixture.siteIndexFilePath,
      `<a href="/sign-in">Login</a>\n<form action="/xapi/auth/sign-out" method="post"></form>\n<script server>\nredirect('/')\n</script>\n`
    )
    const routeDocumentLinkTargets = routeDocumentLinks.map((entry) => entry.targetFilePath)
    if (!routeDocumentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/(site)/sign-in.ejs'))) {
      throw new Error(`Expected href route document link target. Got: ${routeDocumentLinkTargets.join(', ')}`)
    }
    if (!routeDocumentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/xapi/auth/sign-out.ejs'))) {
      throw new Error(`Expected action route document link target. Got: ${routeDocumentLinkTargets.join(', ')}`)
    }

    const serverTemplateBoundaryLines = getServerTemplateBoundaryLineNumbers(
      `<script server>
const boardService = resolve('board-service')
</script>

<section>
  <div>Boards</div>
</section>
`
    )
    if (serverTemplateBoundaryLines.length !== 1 || serverTemplateBoundaryLines[0] !== 4) {
      throw new Error(
        `Expected one server/template boundary at the first template line. Got: ${JSON.stringify(serverTemplateBoundaryLines)}`
      )
    }

    const consecutiveServerBoundaryLines = getServerTemplateBoundaryLineNumbers(
      `<script server>
const authState = resolve('auth-service')
</script>

<script server>
const boardService = resolve('board-service')
</script>

<section>
  <div>Boards</div>
</section>
`
    )
    if (consecutiveServerBoundaryLines.length !== 1 || consecutiveServerBoundaryLines[0] !== 8) {
      throw new Error(
        `Expected consecutive server blocks to skip intermediate separators. Got: ${JSON.stringify(consecutiveServerBoundaryLines)}`
      )
    }

    const privatePartialBoundaryLines = getServerTemplateBoundaryLineNumbers(
      `<%
const safeState = pageState || { ok: true }
const reportDate = String(safeState.reportDate || '').trim()
%>

<section>
  <div>Dashboard</div>
</section>
`,
      { includeTopLevelPartialSetup: true }
    )
    if (privatePartialBoundaryLines.length !== 1 || privatePartialBoundaryLines[0] !== 5) {
      throw new Error(
        `Expected _private partial setup block boundary at the first template line. Got: ${JSON.stringify(privatePartialBoundaryLines)}`
      )
    }

    const rawOutputBoundaryLines = getServerTemplateBoundaryLineNumbers(
      `<%- include('flash-alert.ejs') %>
<section>
  <div>Dashboard</div>
</section>
`,
      { includeTopLevelPartialSetup: true }
    )
    if (rawOutputBoundaryLines.length !== 0) {
      throw new Error(
        `Expected raw output blocks to avoid partial setup boundaries. Got: ${JSON.stringify(rawOutputBoundaryLines)}`
      )
    }

    const extensionSourceText = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8')
    if (!extensionSourceText.includes("command: 'vscode.open'") || !extensionSourceText.includes("command: 'pocketpagesServerScript.noopCodeLens'")) {
      throw new Error('Expected CodeLens provider to map target paths to vscode.open and fall back to an internal no-op command.')
    }
    if (
      !extensionSourceText.includes('createTextEditorDecorationType') ||
      !extensionSourceText.includes('getServerTemplateBoundaryLineNumbers') ||
      !extensionSourceText.includes('onDidChangeVisibleTextEditors') ||
      !extensionSourceText.includes('includeTopLevelPartialSetup') ||
      !extensionSourceText.includes("title: 'Template'") ||
      !extensionSourceText.includes("kind: 'template-boundary'")
    ) {
      throw new Error('Expected extension to register server/template boundary decorations for visible EJS editors.')
    }
    if (extensionSourceText.includes("contentText: 'Template'")) {
      throw new Error('Expected Template label to move out of inline decoration content and into CodeLens.')
    }
    if (!routeDocumentLinkTargets.some((target) => target.endsWith('/pb_hooks/pages/(site)/index.ejs'))) {
      throw new Error(`Expected redirect route document link target. Got: ${routeDocumentLinkTargets.join(', ')}`)
    }

    console.log('Sanity check passed.')
    console.log(`Fixture app: ${fixture.appRoot}`)
    console.log(`Completion sample: ${completionNames.slice(0, 10).join(', ')}`)
    console.log(`Route params: ${paramsNames.filter((name) => name === 'boardSlug').join(', ')}`)
    console.log(`Resolve candidates: ${resolveNames.slice(0, 5).join(', ')}`)
    console.log(`Include candidates: ${includeNames.slice(0, 5).join(', ')}`)
    console.log(`Collections: ${collectionNames.slice(0, 5).join(', ')}`)
    console.log(`Fields: ${fieldNames.slice(0, 5).join(', ')}`)
    console.log(`Document links: ${documentLinks.length}`)
    console.log(`Hover: ${quickInfo.displayText}`)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
}

run()
