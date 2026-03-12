'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { PocketPagesLanguageServiceManager } = require('../src/language-service')
const { collectEjsSemanticTokenEntries } = require('../src/ejs-semantic-tokens')

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

  return {
    fixtureRoot,
    appRoot,
    siteIndexFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'),
    boardsFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs'),
    boardShowFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'index.ejs'),
    localsTypeCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'locals-type-check.ejs'),
    propertyLocalsCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'property-locals-check.ejs'),
    renameCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'rename-check.ejs'),
    middlewareFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'api', '+middleware.js'),
    boardServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service.js'),
    flashAlertFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'flash-alert.ejs'),
    typedPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'typed-panel.ejs'),
    propertyPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'property-panel.ejs'),
    signOutFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-out.ejs'),
    signInFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-in.ejs'),
  }
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
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

    const routeCompletionText = `<a href="/si"></a>\n`
    const routeCompletionOffset = routeCompletionText.indexOf('/si') + '/si'.length
    const routeCompletion = service.getCustomCompletionData(fixture.siteIndexFilePath, routeCompletionText, routeCompletionOffset)
    const routeNames = routeCompletion ? routeCompletion.items.map((entry) => entry.label) : []
    if (!routeNames.includes('/sign-in')) {
      throw new Error(`Expected route path completion for "/sign-in". Got: ${routeNames.slice(0, 20).join(', ')}`)
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
