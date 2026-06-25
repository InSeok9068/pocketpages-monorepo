'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { URI } = require('vscode-uri')
const { PocketPagesLanguageServiceManager, ts } = require('../packages/language-service/language-service')
const { DocumentSnapshotManager, createVersionedTextState } = require('../packages/language-service/document-snapshot-manager')
const statCache = require('../packages/language-service/stat-cache')
const { PocketPagesLanguageCore } = require('../packages/language-core/language-core')
const { createPocketPagesLanguagePlugin } = require('../packages/language-core/language-plugin')
const { createScriptSnapshot } = require('../packages/language-core/snapshot')
const { extractServerBlocks } = require('../packages/language-core/script-server')
const { createVirtualCode, updateVirtualCode } = require('../packages/language-core/virtual-code')
const { collectEjsSemanticTokenEntries } = require('../packages/language-server/ejs-semantic-tokens')
const { getServerTemplateBoundaryLineNumbers } = require('../packages/language-core/ejs-server-boundary')
const { createTypeScriptFeatureService } = require('../packages/language-server/services/ts-features')
const { createCustomFeatureService } = require('../packages/language-server/services/custom-features')
const { createDiagnosticsFeatureService } = require('../packages/language-server/services/diagnostics-features')
const { createLifecycleFeatureService } = require('../packages/language-server/services/lifecycle-features')
const { createMaintenanceFeatureService } = require('../packages/language-server/services/maintenance-features')
const { createStructureFeatureService } = require('../packages/language-server/services/structure-features')
const { createDocumentRuntimeStateRegistry } = require('../packages/language-server/document-runtime-state')
const { createRequestCoordinator } = require('../packages/language-server/request-coordinator')
const {
  createStableCompletionTextEdit,
  isTypeScriptCompletionTriggerAllowed,
  shouldReuseLastCompletion,
} = require('../packages/language-server/services/completion-helpers')
const { buildTemplateVirtualText } = require('../packages/language-core/ejs-template')
const { collectSchemaContexts, getPathContextAtOffset, collectPathContexts } = require('../packages/language-core/custom-context')
const initTypeScriptPlugin = require('../packages/typescript-plugin')
const {
  buildScriptServerMirrorText,
  collectExternalPocketPagesEjsFiles,
  isPocketPagesAssetFile,
  isPocketPagesEjsFile,
} = require('../packages/typescript-plugin/shared')
const { getTokenTypeIndex } = require('../packages/language-server/ejs-semantic-tokens')
const { runExtensionHostSanityCheck } = require('./extension-host-sanity')
const { collectPagesCodeFiles } = require('../../../scripts/diag-pocketpages-core')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf8')
}

function withWriteFileSyncCount(callback) {
  const originalWriteFileSync = fs.writeFileSync
  let writeCount = 0

  fs.writeFileSync = function patchedWriteFileSync(...args) {
    writeCount += 1
    return originalWriteFileSync.apply(this, args)
  }

  try {
    const result = callback()
    return { writeCount, result }
  } finally {
    fs.writeFileSync = originalWriteFileSync
  }
}

function withPatchedStatSync(filePath, stats, callback) {
  const originalStatSync = fs.statSync
  const normalizedFilePath = normalizeFilePath(filePath)

  fs.statSync = function patchedStatSync(candidatePath, ...args) {
    if (normalizeFilePath(candidatePath) === normalizedFilePath) {
      return stats
    }
    return originalStatSync.call(this, candidatePath, ...args)
  }

  try {
    return callback()
  } finally {
    fs.statSync = originalStatSync
  }
}

function applyEditsToText(text, edits) {
  return edits
    .slice()
    .sort((left, right) => right.start - left.start)
    .reduce((current, edit) => current.slice(0, edit.start) + edit.newText + current.slice(edit.end), text)
}

function normalizeFilePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^[A-Z]:/, (value) => value.toLowerCase())
}

function offsetToPosition(text, offset) {
  const clampedOffset = Math.max(0, Math.min(String(text || '').length, Number(offset) || 0))
  let line = 0
  let character = 0

  for (let index = 0; index < clampedOffset; index += 1) {
    if (text[index] === '\n') {
      line += 1
      character = 0
      continue
    }
    character += 1
  }

  return { line, character }
}

function positionToOffset(text, position) {
  const targetLine = Math.max(0, Number(position && position.line) || 0)
  const targetCharacter = Math.max(0, Number(position && position.character) || 0)
  let line = 0
  let character = 0

  for (let index = 0; index < String(text || '').length; index += 1) {
    if (line === targetLine && character === targetCharacter) {
      return index
    }

    if (text[index] === '\n') {
      line += 1
      character = 0
      if (line > targetLine) {
        return index + 1
      }
      continue
    }

    character += 1
  }

  return String(text || '').length
}

function createTestDocument(filePath, languageId, version, text) {
  const documentText = String(text || '')
  const uri = URI.file(filePath).toString()

  return {
    uri,
    languageId,
    version,
    getText() {
      return documentText
    },
    offsetAt(position) {
      return positionToOffset(documentText, position)
    },
    positionAt(offset) {
      return offsetToPosition(documentText, offset)
    },
  }
}

function serializeDiagnostics(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : [])
    .map((entry) => ({
      code: entry.code,
      category: entry.category,
      message: String(entry.message || ''),
      start: typeof entry.start === 'number' ? entry.start : -1,
      end: typeof entry.end === 'number' ? entry.end : -1,
    }))
    .sort((left, right) => {
      if (left.start !== right.start) {
        return left.start - right.start
      }

      if (left.end !== right.end) {
        return left.end - right.end
      }

      if (String(left.code) !== String(right.code)) {
        return String(left.code).localeCompare(String(right.code))
      }

      if (left.category !== right.category) {
        return left.category - right.category
      }

      return left.message.localeCompare(right.message)
    })
}

function assertMatches(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message)
  }
}

function assertIncludes(collection, value, message) {
  if (!collection.includes(value)) {
    throw new Error(message)
  }
}

function createCorpusBooklogSchema(extraBookFields = []) {
  return [
    {
      name: 'authors',
      fields: [
        { name: 'display_name', type: 'text' },
        { name: 'slug', type: 'text' },
        { name: 'bio', type: 'text' },
        { name: 'is_active', type: 'bool' },
      ],
    },
    {
      name: 'books',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'slug', type: 'text' },
        { name: 'summary', type: 'text' },
        { name: 'status', type: 'text' },
        { name: 'is_featured', type: 'bool' },
        { name: 'author', type: 'relation' },
        { name: 'published_at', type: 'date' },
        { name: 'rating', type: 'number' },
        { name: 'cover_url', type: 'text' },
        ...extraBookFields,
      ],
    },
    {
      name: 'book_notes',
      fields: [
        { name: 'book', type: 'relation' },
        { name: 'note', type: 'text' },
        { name: 'visibility', type: 'text' },
      ],
    },
    {
      name: 'reading_lists',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'slug', type: 'text' },
        { name: 'owner', type: 'relation' },
        { name: 'is_public', type: 'bool' },
      ],
    },
  ]
}

function writeCorpusBooklogSchema(schemaFilePath, extraBookFields = []) {
  writeFile(schemaFilePath, JSON.stringify(createCorpusBooklogSchema(extraBookFields), null, 2))
}

function createCorpusBooklogApp(fixtureRoot, referenceAppRoot) {
  const corpusAppRoot = path.join(fixtureRoot, 'apps', 'corpus-app')
  const corpusSchemaFilePath = path.join(corpusAppRoot, 'pb_schema.json')
  const corpusLibraryIndexFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', 'index.ejs')
  const corpusLibraryShowFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', '[bookSlug]', 'index.ejs')
  const corpusLibraryEditFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', '[bookSlug]', 'edit.ejs')
  const corpusLargeShelfFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', 'stress.ejs')
  const corpusLibraryMiddlewareFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', '+middleware.js')
  const corpusLibraryServiceFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', '_private', 'library-service.js')
  const corpusBookCardFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', '(site)', 'library', '_private', 'book-card.ejs')
  const corpusFavoriteFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', 'xapi', 'library', '[bookSlug]', 'favorite.ejs')
  const corpusSaveFilePath = path.join(corpusAppRoot, 'pb_hooks', 'pages', 'xapi', 'library', '[bookSlug]', 'save.ejs')

  writeFile(path.join(corpusAppRoot, 'jsconfig.json'), fs.readFileSync(path.join(referenceAppRoot, 'jsconfig.json'), 'utf8'))
  writeFile(
    path.join(corpusAppRoot, 'pb_data', 'types.d.ts'),
    fs.readFileSync(path.join(referenceAppRoot, 'pb_data', 'types.d.ts'), 'utf8')
  )
  writeFile(
    path.join(corpusAppRoot, 'pocketpages-globals.d.ts'),
    fs.readFileSync(path.join(referenceAppRoot, 'pocketpages-globals.d.ts'), 'utf8')
  )
  writeFile(
    path.join(corpusAppRoot, 'types.d.ts'),
    `declare namespace types {
  type CorpusShelfFilters = {
    status: string
    query: string
    includeDrafts: boolean
  }

  type CorpusBookForm = {
    title: string
    summary: string
    status: string
  }
}
`
  )
  writeCorpusBooklogSchema(corpusSchemaFilePath)

  writeFile(
    corpusLibraryServiceFilePath,
    `/**
 * @param {{ $app: pocketbase.PocketBase, limit?: number }} ctx
 * @returns {Array<core.Record>}
 */
function listFeaturedBooks(ctx) {
  return ctx.$app.findRecordsByFilter('books', 'is_featured = true && status = "published"', '-published_at', ctx.limit || 12, 0)
}

/**
 * @param {Array<core.Record>} books
 * @returns {core.Record}
 */
function pickFeaturedBook(books) {
  return books[0]
}

/**
 * @param {{ $app: pocketbase.PocketBase, slug: string }} ctx
 * @returns {core.Record}
 */
function findBookBySlug(ctx) {
  return ctx.$app.findFirstRecordByFilter('books', 'slug = "' + ctx.slug + '"')
}

/**
 * @param {{ $app: pocketbase.PocketBase, book: core.Record }} ctx
 * @returns {core.Record}
 */
function findAuthorForBook(ctx) {
  return ctx.$app.findRecordById('authors', String(ctx.book.get('author') || ''))
}

/**
 * @param {core.Record} book
 * @returns {types.CorpusBookForm}
 */
function toBookForm(book) {
  return {
    title: String(book.get('title') || ''),
    summary: String(book.get('summary') || ''),
    status: String(book.get('status') || 'draft'),
  }
}

module.exports = {
  listFeaturedBooks,
  pickFeaturedBook,
  findBookBySlug,
  findAuthorForBook,
  toBookForm,
}
`
  )
  writeFile(
    corpusBookCardFilePath,
    `<article class="book-card" data-book="<%= book.get('slug') %>">
  <a href="/library/<%= book.get('slug') %>"><%= book.get('title') %></a>
  <p><%= book.get('summary') %></p>
  <% if (showActions) { %>
    <button hx-post="/xapi/library/<%= book.get('slug') %>/favorite" hx-target="#flash">Save</button>
  <% } %>
  <a href="<%= returnPath %>">Back</a>
</article>
`
  )
  writeFile(
    corpusLibraryMiddlewareFilePath,
    `module.exports = function ({ request }, next) {
  info('library-request', { method: request.method })
  return next()
}
`
  )
  writeFile(
    corpusLibraryIndexFilePath,
    `<script server>
const libraryService = resolve('library-service')
/** @type {types.CorpusShelfFilters} */
const filters = { status: 'published', query: '', includeDrafts: false }
const featuredBooks = libraryService.listFeaturedBooks({ $app, limit: 12 })
const recommendedBook = libraryService.pickFeaturedBook(featuredBooks)
const allBooks = $app.findRecordsByFilter('books', 'status = "published"', '-published_at', 24, 0)
const bookTotal = $app.countRecords('books')
meta('title', 'Library')
</script>
<section class="library-shell">
  <nav>
    <a href="/library">Library</a>
    <a href="/library/<%= recommendedBook.get('slug') %>"><%= recommendedBook.get('title') %></a>
  </nav>
  <h1><%= recommendedBook.get('title') %></h1>
  <%- include('book-card.ejs', { book: recommendedBook, returnPath: '/library', showActions: true }) %>
  <p><%= filters.status %> / <%= featuredBooks.length %> / <%= bookTotal %></p>
  <% for (const book of allBooks) { %>
    <article data-book="<%= book.get('slug') %>">
      <a href="/library/<%= book.get('slug') %>"><%= book.get('title') %></a>
      <p><%= book.get('summary') %></p>
      <button hx-post="/xapi/library/<%= book.get('slug') %>/favorite" hx-target="#flash">Save</button>
    </article>
  <% } %>
</section>
`
  )
  writeFile(
    corpusLibraryShowFilePath,
    `<script server>
const libraryService = resolve('library-service')
const book = libraryService.findBookBySlug({ $app, slug: params.bookSlug || '' })
const author = libraryService.findAuthorForBook({ $app, book })
const relatedNotes = $app.findRecordsByFilter('book_notes', 'book = "' + book.id + '"', '-created', 10, 0)
meta('title', book.get('title'))
</script>
<article class="book-detail">
  <a href="/library">Library</a>
  <%- include('book-card.ejs', { book, returnPath: '/library/' + book.get('slug'), showActions: false }) %>
  <p><%= author.get('display_name') %></p>
  <% for (const note of relatedNotes) { %>
    <p><%= note.get('note') %></p>
  <% } %>
  <a href="/library/<%= params.bookSlug %>/edit">Edit</a>
</article>
`
  )
  writeFile(
    corpusLibraryEditFilePath,
    `<script server>
const libraryService = resolve('library-service')
const book = libraryService.findBookBySlug({ $app, slug: params.bookSlug || '' })
const formValues = libraryService.toBookForm(book)
meta('title', 'Edit ' + book.get('title'))
</script>
<form action="/xapi/library/<%= book.get('slug') %>/save" method="post">
  <input name="title" value="<%= formValues.title %>">
  <textarea name="summary"><%= formValues.summary %></textarea>
  <select name="status">
    <option value="<%= formValues.status %>"><%= formValues.status %></option>
  </select>
  <button type="submit">Save</button>
</form>
`
  )
  writeFile(
    corpusFavoriteFilePath,
    `<script server>
const libraryService = resolve('library-service')
const book = libraryService.findBookBySlug({ $app, slug: params.bookSlug || '' })
info('favorite-book', { bookId: book.id })
redirect('/library/' + params.bookSlug, { status: 303, message: 'Saved' })
return
</script>
`
  )
  writeFile(
    corpusSaveFilePath,
    `<script server>
const libraryService = resolve('library-service')
const book = libraryService.findBookBySlug({ $app, slug: params.bookSlug || '' })
const values = formData()
info('save-book', { bookId: book.id, title: values.title })
redirect('/library/' + params.bookSlug, { status: 303, message: 'Saved' })
return
</script>
`
  )

  const stressServerLines = Array.from({ length: 80 }, (_value, index) =>
    `const stressBooks${index} = $app.findRecordsByFilter('books', 'status = "published"', '-published_at', 5, ${index})
const stressBook${index} = stressBooks${index}[0]
const stressTitle${index} = stressBook${index}.get('title')
`
  ).join('')
  const stressMarkupRows = Array.from({ length: 80 }, (_value, index) =>
    `  <article data-row="${index}">
    <a href="/library/<%= stressBook${index}.get('slug') %>"><%= stressTitle${index} %></a>
    <p><%= stressBook${index}.get('summary') %></p>
  </article>
`
  ).join('')
  writeFile(
    corpusLargeShelfFilePath,
    `<script server>
const stressService = resolve('library-service')
const stressFeatured = stressService.listFeaturedBooks({ $app, limit: 5 })
${stressServerLines}</script>
<main class="stress-library">
  <h1><%= stressFeatured.length %></h1>
${stressMarkupRows}</main>
`
  )

  return {
    corpusAppRoot,
    corpusSchemaFilePath,
    corpusLibraryIndexFilePath,
    corpusLibraryShowFilePath,
    corpusLibraryEditFilePath,
    corpusLargeShelfFilePath,
    corpusLibraryMiddlewareFilePath,
    corpusLibraryServiceFilePath,
    corpusBookCardFilePath,
    corpusFavoriteFilePath,
    corpusSaveFilePath,
  }
}

function createLspServiceSmokeContext(core, documentsByUri, extra = {}) {
  const documentEntries =
    documentsByUri instanceof Map ? documentsByUri : new Map(Object.entries(documentsByUri || {}))

  const completionKindText = 1
  const inlayKindType = 1
  const inlayKindParameter = 2
  const markupKindMarkdown = 'markdown'
  const insertTextFormatPlainText = 1
  const codeActionKindQuickFix = 'quickfix'
  const completionKindMap = {}
  const runtimeState = extra.runtimeState || createDocumentRuntimeStateRegistry()
  const requestCoordinator = extra.requestCoordinator || createRequestCoordinator({ runtimeState })
  for (const [uri, document] of documentEntries.entries()) {
    runtimeState.updateDocument(uri, {
      version: document ? document.version : null,
    })
  }

  function isSchemaSupportOnlyHookScriptPath(filePath) {
    const normalizedPath = normalizeFilePath(filePath)
    return (
      normalizedPath.includes('/pb_hooks/') &&
      !normalizedPath.includes('/pb_hooks/pages/') &&
      /\.(js|cjs|mjs)$/i.test(normalizedPath)
    )
  }

  const helpers = {
    COMPLETION_KIND_MAP: completionKindMap,
    LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT: 50000,
    LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS: 3000,
    LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET: 2,
    FIRST_REQUEST_WARMUP_IDLE_MS: 700,
    customCompletionKind() {
      return completionKindText
    },
    diagnosticSeverity(category) {
      return category === ts.DiagnosticCategory.Error ? 1 : 2
    },
    elapsedMilliseconds(startedAt) {
      return Number(process.hrtime.bigint() - startedAt) / 1000000
    },
    formatCompletionTrigger(context) {
      if (!context) {
        return 'unspecified'
      }
      if (context.triggerCharacter) {
        return `char:${context.triggerCharacter}`
      }
      return context.triggerKind === 1 ? 'invoke' : 'other'
    },
    getCompletionProfileFields(profile) {
      return profile || {}
    },
    getDiagnosticsProfileFields(profile) {
      return profile || {}
    },
    getPreferredDiagnosticOffset() {
      return null
    },
    rememberInteractiveOffset() {},
    getCachedDiagnosticsResult(uri, key) {
      return typeof runtimeState.getDiagnostics === 'function'
        ? runtimeState.getDiagnostics(uri, key)
        : null
    },
    setCachedDiagnosticsResult(uri, key, value) {
      return typeof runtimeState.setDiagnostics === 'function'
        ? runtimeState.setDiagnostics(uri, key, value)
        : value
    },
    ensureDocumentPrepared(uri, options = {}) {
      return typeof core.prepareDocument === 'function' ? core.prepareDocument(uri, options) : null
    },
    getDocumentByUri(uri) {
      return documentEntries.get(uri) || null
    },
    getDocumentContextByUri(uri) {
      return core.getDocumentContextByUri(uri)
    },
    getDocumentRuntimeState(uri) {
      return typeof runtimeState.getDocument === 'function'
        ? runtimeState.getDocument(uri)
        : null
    },
    getDocumentContextByFilePath(filePath) {
      const document = [...documentEntries.values()].find(
        (entry) => normalizeFilePath(URI.parse(entry.uri).fsPath) === normalizeFilePath(filePath)
      )
      return document ? core.getDocumentContextByUri(document.uri) : null
    },
    getRelativePathLabel(filePath) {
      return normalizeFilePath(filePath)
    },
    isActiveDiagnosticRun() {
      return true
    },
    isStaleDocumentVersion() {
      return false
    },
    scheduleDocumentRequest(uri, key, version, delayMs, callback) {
      return requestCoordinator.schedule(
        { uri, key, version, delayMs },
        callback
      )
    },
    cancelScheduledDocumentRequest(uri, key) {
      requestCoordinator.cancel(uri, key)
    },
    cancelScheduledDocumentRequests(uri) {
      requestCoordinator.cancel(uri)
    },
    updateDocumentRuntimeState(uri, document, options = {}) {
      return runtimeState.updateDocument(uri, {
        version: document ? document.version : null,
        textLength: document && typeof document.getText === 'function' ? document.getText().length : 0,
        opened: options.opened === true,
        changed: options.changed === true,
        saved: options.saved === true,
      })
    },
    clearDocumentRuntimeState(uri) {
      runtimeState.deleteDocument(uri)
    },
    scheduleFirstRequestWarmup() {},
    cancelFirstRequestWarmup() {},
    shouldAbortDocumentRequest() {
      return false
    },
    isExcludedPocketPagesScriptPath() {
      return false
    },
    isSchemaSupportOnlyHookScriptPath(filePath) {
      return isSchemaSupportOnlyHookScriptPath(filePath)
    },
    isEjsFilePath(filePath) {
      return String(filePath || '').endsWith('.ejs')
    },
    isPullDiagnosticRefreshSupported() {
      return false
    },
    isScriptFilePath(filePath) {
      return /\.(js|cjs|mjs)$/i.test(String(filePath || ''))
    },
    logServer() {},
    beginDiagnosticRun() {
      return 1
    },
    uriToFilePath(uri) {
      return URI.parse(uri).fsPath
    },
    toMarkupContent(signature, documentation) {
      return {
        kind: markupKindMarkdown,
        value: [signature, documentation].filter(Boolean).join('\n\n'),
      }
    },
    toRange(document, start, end) {
      return {
        start: document.positionAt(start),
        end: document.positionAt(end),
      }
    },
    toSignatureHelp(value) {
      return value
    },
    toWorkspaceEdit(edits) {
      return edits
    },
  }

  return {
    context: {
      ts,
      core,
      helpers,
      InsertTextFormat: {
        PlainText: insertTextFormatPlainText,
      },
      CompletionItemKind: {
        Text: completionKindText,
      },
      InlayHintKind: {
        Type: inlayKindType,
        Parameter: inlayKindParameter,
      },
      MarkupKind: {
        Markdown: markupKindMarkdown,
      },
      CodeActionKind: {
        QuickFix: codeActionKindQuickFix,
      },
      URI,
      connection: extra.connection || {},
      state: extra.state || {
        diagnosticRunIds: new Map(),
      },
    },
    helpers,
  }
}

function assertCompletionHelperContracts() {
  if (!isTypeScriptCompletionTriggerAllowed({ triggerKind: 1 })) {
    throw new Error('Expected invoked completions to stay routed to TypeScript completion.')
  }
  if (!isTypeScriptCompletionTriggerAllowed({ triggerKind: 2, triggerCharacter: '.' })) {
    throw new Error('Expected member-access completion trigger to stay routed to TypeScript completion.')
  }
  if (!isTypeScriptCompletionTriggerAllowed({ triggerKind: 2, triggerCharacter: '`' })) {
    throw new Error('Expected template-string completion trigger to stay routed to TypeScript completion.')
  }
  if (isTypeScriptCompletionTriggerAllowed({ triggerKind: 2, triggerCharacter: '{' })) {
    throw new Error('Expected PocketPages custom trigger "{" to skip TypeScript completion.')
  }
  if (isTypeScriptCompletionTriggerAllowed({ triggerKind: 2, triggerCharacter: '/' })) {
    throw new Error('Expected EJS path trigger "/" to skip TypeScript completion by default.')
  }
  if (!isTypeScriptCompletionTriggerAllowed({ triggerKind: 2, triggerCharacter: '/' }, { allowPathLikeTrigger: true })) {
    throw new Error('Expected plain JS path trigger "/" to stay available for TypeScript completion.')
  }

  const reusableCompletion = {
    uri: 'file:///workspace/page.ejs',
    version: 3,
    line: 4,
    character: 12,
    result: { isIncomplete: true, items: [{ label: 'value' }] },
  }
  if (
    !shouldReuseLastCompletion(reusableCompletion, {
      uri: 'file:///workspace/page.ejs',
      version: 3,
      line: 4,
      character: 13,
      triggerKind: 3,
    })
  ) {
    throw new Error('Expected nearby incomplete completion requests to reuse the previous completion result.')
  }
  if (
    shouldReuseLastCompletion(reusableCompletion, {
      uri: 'file:///workspace/page.ejs',
      version: 4,
      line: 4,
      character: 13,
      triggerKind: 3,
    })
  ) {
    throw new Error('Expected completion reuse to be disabled after a document version change.')
  }
  if (
    shouldReuseLastCompletion(reusableCompletion, {
      uri: 'file:///workspace/page.ejs',
      version: 3,
      line: 4,
      character: 13,
      triggerKind: 1,
    })
  ) {
    throw new Error('Expected completion reuse to be limited to incomplete retrigger requests.')
  }
  if (
    shouldReuseLastCompletion(
      { ...reusableCompletion, result: { isIncomplete: false, items: [{ label: 'value' }] } },
      {
        uri: 'file:///workspace/page.ejs',
        version: 3,
        line: 4,
        character: 13,
        triggerKind: 3,
      }
    )
  ) {
    throw new Error('Expected complete completion lists to avoid near-position reuse.')
  }

  const completionText = 'const value = foo.ba\n'
  const completionDocument = createTestDocument('C:\\workspace\\page.ejs', 'ejs', 1, completionText)
  const wordOffset = completionText.indexOf('ba') + 'ba'.length
  const stableEdit = createStableCompletionTextEdit(
    completionDocument,
    completionText,
    wordOffset,
    {
      start: completionText.indexOf('foo.ba'),
      end: completionText.indexOf('foo.ba') + 'foo.ba'.length,
    },
    'foo.bar'
  )
  if (!stableEdit || !stableEdit.textEdit || stableEdit.textEdit.newText !== 'bar') {
    throw new Error(`Expected wide TS replacement span to be narrowed to the current word. Got: ${JSON.stringify(stableEdit)}`)
  }
  if (completionDocument.offsetAt(stableEdit.textEdit.range.start) !== completionText.indexOf('ba')) {
    throw new Error(`Expected stable completion edit to start at the current word. Got: ${JSON.stringify(stableEdit.textEdit.range)}`)
  }
  if (
    !Array.isArray(stableEdit.additionalTextEdits) ||
    stableEdit.additionalTextEdits.length !== 1 ||
    stableEdit.additionalTextEdits[0].newText !== 'foo.'
  ) {
    throw new Error(`Expected stable completion edit to preserve the existing prefix separately. Got: ${JSON.stringify(stableEdit)}`)
  }

  const directEdit = createStableCompletionTextEdit(
    completionDocument,
    completionText,
    wordOffset,
    {
      start: completionText.indexOf('ba'),
      end: completionText.indexOf('ba') + 'ba'.length,
    },
    'bar'
  )
  if (!directEdit || directEdit.additionalTextEdits !== undefined || directEdit.textEdit.newText !== 'bar') {
    throw new Error(`Expected already-local TS replacement span to stay unchanged. Got: ${JSON.stringify(directEdit)}`)
  }
}

function assertClientContracts(repoRoot) {
  const legacyExtensionFilePath = path.join(repoRoot, 'tools', 'vscode-pocketpages', 'src', 'extension.js')
  const clientSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'vscode-pocketpages', 'index.js'),
    'utf8'
  )
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'vscode-pocketpages', 'package.json'), 'utf8'))

  if (fs.existsSync(legacyExtensionFilePath)) {
    throw new Error('Expected the legacy extension-host fallback source to be removed once LSP parity is the only runtime path.')
  }

  const activationEvents = Array.isArray(packageJson.activationEvents) ? packageJson.activationEvents : []
  assertIncludes(
    activationEvents,
    'onLanguage:ejs',
    'Expected PocketPages to activate when an EJS document is opened.'
  )
  assertIncludes(
    activationEvents,
    'workspaceContains:**/pocketpages-globals.d.ts',
    'Expected PocketPages to activate for workspaces that declare PocketPages globals.'
  )
  if (activationEvents.includes('onStartupFinished')) {
    throw new Error('Expected PocketPages to stop activating eagerly onStartupFinished.')
  }

  assertMatches(
    clientSource,
    /const LSP_DOCUMENT_SELECTOR = \[\.\.\.EJS_DOCUMENT_SELECTOR,\s*\.\.\.HOOK_SCRIPT_DOCUMENT_SELECTOR\]/,
    'Expected the PocketPages client to route both EJS files and pb_hooks scripts through the LSP.'
  )
  assertMatches(
    clientSource,
    /const serverTemplateBoundaryDecoration = vscode\.window\.createTextEditorDecorationType\(/,
    'Expected the PocketPages client to keep editor-side server\/template boundary decorations.'
  )
  assertMatches(
    clientSource,
    /const boundaryRanges = getServerTemplateBoundaryLineNumbers\(document\.getText\(\), \{\s*includeTopLevelPartialSetup: isPrivatePartialDocument\(document\),\s*\}\)/,
    'Expected the PocketPages client to keep template boundary calculation for EJS and _private partial editors.'
  )
  assertMatches(
    clientSource,
    /const normalizedFileUri = toVscodeUri\(fileUri\)[\s\S]*const result = await client\.sendRequest\(REQUESTS\.allFileReferences, \{ uri: normalizedFileUri\.toString\(\) \}\)/,
    'Expected the PocketPages client to resolve all-file references through the LSP.'
  )
  assertMatches(
    clientSource,
    /const edits = await client\.sendRequest\(REQUESTS\.fileRenameEdits, \{/,
    'Expected the PocketPages client to request cross-file rename edits through the LSP.'
  )
  assertMatches(
    clientSource,
    /activeClient\.sendRequest\(REQUESTS\.extractPartialEdits, \{/,
    'Expected the PocketPages client to request Extract Partial edits through the LSP.'
  )
  assertMatches(
    clientSource,
    /activeClient\.sendRequest\(REQUESTS\.explainCurrentRoute, \{/,
    'Expected the PocketPages client to request current route explanations through the LSP.'
  )
  if (!JSON.stringify(packageJson.contributes || {}).includes('pocketpagesServerScript.extractPartial')) {
    throw new Error('Expected package.json to contribute the Extract Partial command and context menu entry.')
  }
  if (!JSON.stringify(packageJson.contributes || {}).includes('pocketpagesServerScript.explainCurrentRoute')) {
    throw new Error('Expected package.json to contribute the Explain Current File command.')
  }
  assertMatches(
    clientSource,
    /isManagedRenameTargetPath\(entry\.oldUri\.fsPath\)/,
    'Expected the PocketPages client to request rename edits for managed PocketPages targets, including assets.'
  )
  if (clientSource.includes('hasPrivatePagesSegment(entry.oldUri.fsPath)')) {
    throw new Error('Expected the PocketPages client to stop limiting file rename edits to _private files only.')
  }
  assertMatches(
    clientSource,
    /vscode\.workspace\.createFileSystemWatcher\("\*\*\/pb_hooks\/\*\*"\)/,
    'Expected the PocketPages client to watch all pb_hooks files and let the server classify managed changes.'
  )
  assertMatches(
    clientSource,
    /await client\.sendNotification\(NOTIFICATIONS\.didManualSave, \{ uri: document\.uri\.toString\(\) \}\)/,
    'Expected the PocketPages client to keep manual-save diagnostics refresh notifications for EJS documents.'
  )
  assertMatches(
    clientSource,
    /async function ensureLspStarted\(context\) \{[\s\S]*activateLsp\(context\)/,
    'Expected the PocketPages client to expose a lazy LSP bootstrap helper.'
  )
  assertMatches(
    clientSource,
    /function maybeStartLspForDocument\(document\) \{[\s\S]*isManagedLspDocument\(document\)[\s\S]*void ensureLspStarted\(context\);[\s\S]*\}/,
    'Expected the PocketPages client to defer LSP startup until a managed PocketPages document is opened.'
  )
  assertMatches(
    clientSource,
    /function isExcludedManagedPagesScriptPath\(filePath\)[\s\S]*isPagesAssetPath\(normalizedPath\)[\s\S]*relativeSegments\.includes\("vendor"\)[\s\S]*\.endsWith\("\.min\.js"\)/,
    'Expected the PocketPages client to keep public asset/vendor/minified page scripts out of managed LSP startup/status checks.'
  )
  assertMatches(
    clientSource,
    /function isManagedEjsDocument\(document\)[\s\S]*!isPagesAssetPath\(document\.uri\.fsPath\)[\s\S]*findAppRoot\(document\.uri\.fsPath\)/,
    'Expected the PocketPages client to keep public asset .ejs files out of managed LSP startup/status checks.'
  )
  if (clientSource.includes('return await activateLsp(context);')) {
    throw new Error('Expected PocketPages activate() to stop eagerly starting the LSP during extension activation.')
  }
  assertMatches(
    clientSource,
    /vscode\.commands\.registerCommand\("pocketpagesServerScript\.reloadCaches", async \(\) => \{/,
    'Expected the PocketPages client to keep the reloadCaches command on the LSP runtime path.'
  )
  assertMatches(
    clientSource,
    /vscode\.commands\.registerCommand\("pocketpagesServerScript\.reloadCaches", async \(\) => \{[\s\S]*await ensureLspStarted\(context\)/,
    'Expected PocketPages commands to start the LSP lazily before sending reloadCaches requests.'
  )
  assertMatches(
    clientSource,
    /vscode\.commands\.registerCommand\("pocketpagesServerScript\.allFileReferences", async \(resourceUri\) => \{/,
    'Expected the PocketPages client to keep the allFileReferences command on the LSP runtime path.'
  )
  assertMatches(
    clientSource,
    /const fileUri = toVscodeUri\(resourceUri\) \|\| \(editor \? editor\.document\.uri : null\);/,
    'Expected the PocketPages client to normalize LSP CodeLens URI arguments before showing file references.'
  )
  assertMatches(
    clientSource,
    /vscode\.commands\.registerCommand\("pocketpagesServerScript\.openCodeLensTarget", async \(resourceUri\) => \{/,
    'Expected the PocketPages client to own CodeLens target opening so serialized URIs are revived correctly.'
  )
  assertMatches(
    clientSource,
    /vscode\.commands\.registerCommand\("pocketpagesServerScript\.showOutput", \(\) => \{/,
    'Expected the PocketPages client to keep the shared output-channel command for the status item.'
  )
  assertMatches(
    clientSource,
    /clientLogger\.error\("lsp", "startup-failed", \{ message \}\)/,
    'Expected the PocketPages client to report startup failures directly instead of falling back to legacy mode.'
  )

  const templateBoundaryMarkers = [
    'createTextEditorDecorationType',
    'getServerTemplateBoundaryLineNumbers',
    'onDidChangeVisibleTextEditors',
    'includeTopLevelPartialSetup',
  ]
  for (const marker of templateBoundaryMarkers) {
    if (!clientSource.includes(marker)) {
      throw new Error('Expected the LSP client to register server/template boundary decorations for visible EJS editors.')
    }
  }

  if (clientSource.includes("contentText: 'Template'")) {
    throw new Error('Expected Template label to stay out of inline decoration content and remain a CodeLens.')
  }

  const contributedCommands = Array.isArray(packageJson.contributes && packageJson.contributes.commands)
    ? packageJson.contributes.commands.map((entry) => entry.command)
    : []

  assertIncludes(
    contributedCommands,
    'pocketpagesServerScript.probeCurrentFile',
    'Expected PocketPages probeCurrentFile command contribution in package.json.'
  )
  assertIncludes(
    contributedCommands,
    'pocketpagesServerScript.refreshDiagnostics',
    'Expected PocketPages refreshDiagnostics command contribution in package.json.'
  )
  assertIncludes(
    contributedCommands,
    'pocketpagesServerScript.reloadCaches',
    'Expected PocketPages reloadCaches command contribution in package.json.'
  )
  assertIncludes(
    contributedCommands,
    'pocketpagesServerScript.allFileReferences',
    'Expected PocketPages allFileReferences command contribution in package.json.'
  )

  const contributedTsPlugins = Array.isArray(packageJson.contributes && packageJson.contributes.typescriptServerPlugins)
    ? packageJson.contributes.typescriptServerPlugins.map((entry) => entry.name)
    : []

  assertIncludes(
    contributedTsPlugins,
    '@dlstj-local/pocketpages-typescript-plugin',
    'Expected PocketPages TypeScript server plugin contribution in package.json.'
  )
}

function assertLspRuntimeContracts(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'tools', 'vscode-pocketpages', 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const clientSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'vscode-pocketpages', 'index.js'),
    'utf8'
  )
  const serverSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-server', 'server.js'),
    'utf8'
  )
  const tsFeatureSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-server', 'services', 'ts-features.js'),
    'utf8'
  )
  const completionHelperSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-server', 'services', 'completion-helpers.js'),
    'utf8'
  )
  const completionFeatureSource = fs.readFileSync(
    path.join(
      repoRoot,
      'tools',
      'vscode-pocketpages',
      'packages',
      'language-service',
      'features',
      'completion-features.js'
    ),
    'utf8'
  )
  const customFeatureSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-server', 'services', 'custom-features.js'),
    'utf8'
  )
  const diagnosticsFeatureSource = fs.readFileSync(
    path.join(
      repoRoot,
      'tools',
      'vscode-pocketpages',
      'packages',
      'language-server',
      'services',
      'diagnostics-features.js'
    ),
    'utf8'
  )
  const languageServiceSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-service', 'language-service.js'),
    'utf8'
  )
  const serviceManagerSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-service', 'service-manager.js'),
    'utf8'
  )
  const documentSnapshotManagerSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-service', 'document-snapshot-manager.js'),
    'utf8'
  )
  const lifecycleFeatureSource = fs.readFileSync(
    path.join(
      repoRoot,
      'tools',
      'vscode-pocketpages',
      'packages',
      'language-server',
      'services',
      'lifecycle-features.js'
    ),
    'utf8'
  )
  const maintenanceFeatureSource = fs.readFileSync(
    path.join(
      repoRoot,
      'tools',
      'vscode-pocketpages',
      'packages',
      'language-server',
      'services',
      'maintenance-features.js'
    ),
    'utf8'
  )
  const tsPluginSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'typescript-plugin', 'index.js'),
    'utf8'
  )
  const vscodeIgnore = fs.readFileSync(path.join(repoRoot, 'tools', 'vscode-pocketpages', '.vscodeignore'), 'utf8')
  const installScriptSource = fs.readFileSync(
    path.join(repoRoot, 'tools', 'vscode-pocketpages', 'scripts', 'install-vscode-pocketpages.js'),
    'utf8'
  )

  if (packageJson.main !== './packages/vscode-pocketpages/index.js') {
    throw new Error(`Expected package.json main to point at the packaged VS Code client. Got: ${packageJson.main}`)
  }

  if (
    !packageJson.scripts ||
    typeof packageJson.scripts['package:vsix'] !== 'string' ||
    packageJson.scripts['package:vsix'].includes('npm install')
  ) {
    throw new Error('Expected package:vsix to avoid npm install and package the current dependency state directly.')
  }

  if (packageJson.dependencies && Object.prototype.hasOwnProperty.call(packageJson.dependencies, 'vscode-pocketpages')) {
    throw new Error('Expected package.json to avoid self-referential vscode-pocketpages dependency.')
  }

  if (
    !Array.isArray(packageJson.extensionDependencies) ||
    !packageJson.extensionDependencies.includes('vscode.typescript-language-features')
  ) {
    throw new Error('Expected package.json to depend on vscode.typescript-language-features for TS plugin support.')
  }

  assertMatches(
    clientSource,
    /const clientOptions = \{\s*documentSelector: LSP_DOCUMENT_SELECTOR,\s*outputChannel,\s*initializationOptions:\s*\{[\s\S]*?logSessionId,[\s\S]*?\},\s*synchronize:\s*\{[\s\S]*?\},\s*\}/,
    'Expected client.js to route LSP logs through the shared PocketPages output channel.'
  )
  assertMatches(
    clientSource,
    /vscode\.commands\.registerCommand\("pocketpagesServerScript\.copyDebugBundle"/,
    'Expected client.js to register the PocketPages debug bundle command.'
  )
  assertMatches(
    clientSource,
    /new LanguageClient\(\s*"pocketpages",\s*"PocketPages Language Server"/,
    'Expected client.js to start the PocketPages language server client.'
  )
  assertMatches(
    clientSource,
    /await client\.sendNotification\(NOTIFICATIONS\.didManualSave, \{ uri: document\.uri\.toString\(\) \}\)/,
    'Expected client.js to keep EJS manual-save diagnostics notifications.'
  )
  if (clientSource.includes('legacyExtension')) {
    throw new Error('Expected client.js to stop referencing the legacy extension fallback path.')
  }
  if (clientSource.includes('fallback-legacy')) {
    throw new Error('Expected client.js to stop reporting fallback-legacy startup mode.')
  }

  const requiredServiceFactories = [
    'createCustomFeatureService',
    'createTypeScriptFeatureService',
    'createDiagnosticsFeatureService',
    'createLifecycleFeatureService',
    'createMaintenanceFeatureService',
    'createStructureFeatureService',
  ]
  for (const factoryName of requiredServiceFactories) {
    if (!serverSource.includes(factoryName)) {
      throw new Error(`Expected server.js to wire ${factoryName} from split LSP services.`)
    }
  }

  assertMatches(
    serverSource,
    /documentSymbolProvider:\s*true/,
    'Expected server.js to advertise document symbols for PocketPages files.'
  )
  assertMatches(
    serverSource,
    /workspaceSymbolProvider:\s*true/,
    'Expected server.js to advertise workspace symbols for PocketPages files.'
  )
  assertMatches(
    serverSource,
    /connection\.onDocumentSymbol\(\(params\) => \{[\s\S]*const result = structureFeatureService\.provideDocumentSymbols\(params\);[\s\S]*logRequestResult\("symbols",\s*"document"[\s\S]*return result;/,
    'Expected server.js to route document symbols through structure-features and log the request result.'
  )
  assertMatches(
    serverSource,
    /connection\.onWorkspaceSymbol\(\(params,\s*token\) => \{[\s\S]*const result = structureFeatureService\.provideWorkspaceSymbols\(params,\s*\{\s*shouldCancel\s*\}\);[\s\S]*logRequestResult\("symbols",\s*"workspace"[\s\S]*return result;/,
    'Expected server.js to route workspace symbols through structure-features and log the request result.'
  )
  assertMatches(
    serverSource,
    /const pathTargetInfo = customFeatureService\.provideHover\(params\)/,
    'Expected server.js hover path to query PocketPages custom hover first.'
  )
  assertMatches(
    serverSource,
    /if \(!isEjsFilePath\(documentContext\.filePath\)\) \{[\s\S]*case:\s*"non-ejs"[\s\S]*return null;[\s\S]*\}/,
    'Expected server.js hover path to avoid generic JS hover duplication outside EJS and log the non-EJS case.'
  )
  assertMatches(
    serverSource,
    /const quickInfo = typeScriptFeatureService\.provideHover\(params,\s*token\)/,
    'Expected server.js to keep EJS TS quick info ownership in the LSP until TS plugin parity is achieved.'
  )
  assertMatches(
    serverSource,
    /const customTarget = customFeatureService\.provideDefinition\(params\);[\s\S]*if \(customTarget\) \{[\s\S]*return result;[\s\S]*\}[\s\S]*const typeScriptTarget = typeScriptFeatureService\.provideDefinition\(params,\s*token\);[\s\S]*return result;/,
    'Expected server.js definition ownership to check PocketPages custom targets before TS definition fallback.'
  )
  assertMatches(
    serverSource,
    /const customResult = customFeatureService\.provideCompletionItems\(params\)/,
    'Expected server.js completion path to preserve custom PocketPages completions before TS completions.'
  )
  assertMatches(
    serverSource,
    /COMPLETION_TRIGGER_CHARACTERS = \[[^\]]*"`"[^\]]*\]/,
    'Expected server.js to request completion on template-string triggers.'
  )
  assertMatches(
    serverSource,
    /const lastCompletionByUri = new Map\(\)/,
    'Expected server.js to keep a per-document reusable completion result cache.'
  )
  assertMatches(
    serverSource,
    /shouldReuseLastCompletion\(lastCompletion,\s*\{/,
    'Expected server.js to reuse nearby incomplete completion requests before recomputing TS completions.'
  )
  assertMatches(
    serverSource,
    /lastCompletionByUri\.delete\(uri\)/,
    'Expected completion cache invalidation to clear reusable completion results too.'
  )
  assertMatches(
    serverSource,
    /function completionCacheKey\(uri, version, offset, context = \{\}\)[\s\S]*triggerKind[\s\S]*triggerCharacter/,
    'Expected completion cache keys to include trigger kind and trigger character.'
  )
  assertMatches(
    serverSource,
    /completionCacheKey\(document\.uri, document\.version, offset, params\.context\)/,
    'Expected completion cache lookups to pass the active LSP completion trigger context.'
  )
  assertMatches(
    tsFeatureSource,
    /isTypeScriptCompletionTriggerAllowed\(params\.context,\s*\{/,
    'Expected ts-features.js to guard TypeScript completion by trigger character before calling TS.'
  )
  assertMatches(
    tsFeatureSource,
    /triggerCharacter:\s*getCompletionTriggerCharacter\(params\.context\)/,
    'Expected ts-features.js to pass the LSP trigger character into TypeScript completions.'
  )
  assertMatches(
    tsFeatureSource,
    /createStableCompletionTextEdit\(/,
    'Expected ts-features.js to stabilize TypeScript completion replacement ranges before returning LSP edits.'
  )
  assertMatches(
    completionFeatureSource,
    /triggerCharacter:\s*options\.triggerCharacter \|\| undefined/,
    'Expected language-service completion to forward triggerCharacter to getCompletionsAtPosition().'
  )
  assertMatches(
    completionFeatureSource,
    /isIncomplete:\s*!!info\.isIncomplete/,
    'Expected language-service completion to preserve TypeScript incomplete-list metadata.'
  )
  assertMatches(
    completionHelperSource,
    /DEFAULT_TS_TRIGGER_CHARACTERS = new Set\(\[[^\]]*"`"[^\]]*\]\)/,
    'Expected completion helper to restrict TypeScript character triggers to TS-owned characters.'
  )
  assertMatches(
    completionHelperSource,
    /triggerCharacter === "\/" && !!options\.allowPathLikeTrigger/,
    'Expected completion helper to reserve slash completions for non-EJS TS-owned files.'
  )
  assertMatches(
    customFeatureSource,
    /entry\.kind === "asset-path"\s*\?\s*`Open asset target: \$\{entry\.value\}`/,
    'Expected custom document link tooltips to label asset() targets correctly.'
  )
  assertMatches(
    customFeatureSource,
    /helpers\.isExcludedPocketPagesScriptPath\(documentContext\.filePath\)/,
    'Expected custom feature service to skip route-exposed vendor and minified scripts consistently.'
  )
  assertMatches(
    tsFeatureSource,
    /function isTypeScriptFeatureBlockedDocument\(documentContext\)[\s\S]*isExcludedPocketPagesScriptPath\(documentContext\.filePath\)[\s\S]*isSchemaSupportOnlyHookScriptPath\(documentContext\.filePath\)/,
    'Expected all TypeScript feature providers to share the excluded/schema-only document guard.'
  )
  assertMatches(
    serverSource,
    /connection\.onReferences\(\(params,\s*token\) => \{[\s\S]*case:\s*"blocked-document"/,
    'Expected references to skip TypeScript/file-reference fallback for excluded and schema-only documents.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /context\.core\.hasFeatureCoverageForRange\(\s*uri,\s*start,\s*end,\s*"diagnostics"/,
    'Expected diagnostics feature service to selectively publish only diagnostics-covered mapped regions.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /helpers\.isSchemaSupportOnlyHookScriptPath\(documentContext\.filePath\)/,
    'Expected diagnostics feature service to keep schema-support-only hook scripts on the schema-only diagnostic channel.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /code === "pp-schema-collection" \|\| code === "pp-schema-field"/,
    'Expected diagnostics feature service to preserve only schema diagnostics for non-pages pb_hooks scripts.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /helpers\.isExcludedPocketPagesScriptPath\(documentContext\.filePath\)/,
    'Expected diagnostics feature service to skip excluded PocketPages vendor and minified scripts.'
  )
  assertMatches(
    serverSource,
    /function isExcludedPocketPagesScriptPath\(filePath\)[\s\S]*isPagesAssetPath\(normalizedPath\)[\s\S]*!isScriptFilePath\(normalizedPath\)[\s\S]*hasPrivatePagesSegment\(normalizedPath\)[\s\S]*lowerPath\.endsWith\("\.min\.js"\)/,
    'Expected server-side exclusion to match the project index for public assets, route-exposed vendor, and minified scripts without excluding EJS routes.'
  )
  if (/connection\.sendDiagnostics|mode:\s*"push-lanes"/.test(diagnosticsFeatureSource)) {
    throw new Error('Expected diagnostics feature service to stay pull-only without push publish lanes.')
  }
  assertMatches(
    diagnosticsFeatureSource,
    /previousResultId[\s\S]*kind:\s*"unchanged"[\s\S]*resultId/,
    'Expected pull diagnostics to support resultId-based unchanged responses.'
  )
  assertMatches(
    languageServiceSource,
    /getDocumentTextIdentity\(filePath, documentText\)[\s\S]*getDocumentSnapshotIdentity\(filePath, documentText\)/,
    'Expected diagnostics result identities to use the service-owned document snapshot identity.'
  )
  assertMatches(
    languageServiceSource,
    /getDiagnosticsLaneResultIds\(filePath, documentText, options = \{\}\)[\s\S]*"project-rule"/,
    'Expected language-service to expose lane-level diagnostics result identities.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /previousLaneResultIds[\s\S]*previousLaneDiagnostics[\s\S]*laneDiagnosticsOut/,
    'Expected pull diagnostics to pass lane cache state into language-service diagnostics.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /async function providePullDiagnostics\(params, token\)[\s\S]*yieldBeforeHeavyDiagnostics\(token, shouldCancel\)/,
    'Expected pull diagnostics to yield before heavy diagnostics work so stale requests can cancel.'
  )
  assertMatches(
    serverSource,
    /PULL_DIAGNOSTICS_INITIAL_YIELD_MS/,
    'Expected language server to configure an initial pull diagnostics yield delay.'
  )
  assertMatches(
    fs.readFileSync(
      path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'language-service', 'features', 'diagnostics-features.js'),
      'utf8'
    ),
    /getReusableLaneDiagnostics\([\s\S]*reusedDiagnosticLanes[\s\S]*pushLaneDiagnostics/,
    'Expected diagnostics feature handlers to reuse unchanged diagnostic lanes.'
  )
  assertMatches(
    languageServiceSource,
    /new DocumentSnapshotManager\(\{ normalizePath \}\)/,
    'Expected language-service to centralize document snapshots through DocumentSnapshotManager.'
  )
  assertMatches(
    languageServiceSource,
    /getScriptSnapshot:\s*\(fileName\) => this\.documentSnapshotManager\.getScriptSnapshot\(fileName\)/,
    'Expected the TypeScript host to read script snapshots from DocumentSnapshotManager.'
  )
  assertMatches(
    documentSnapshotManagerSource,
    /sourceDocuments = new Map\(\)[\s\S]*preparedDocuments = new Map\(\)[\s\S]*virtualFiles = new Map\(\)/,
    'Expected DocumentSnapshotManager to own source documents, prepared documents, and virtual files together.'
  )
  assertMatches(
    languageServiceSource,
    /function getMappingSegments\(mappings, options = \{\}\)[\s\S]*sortBy === "source"[\s\S]*function mapSourceOffsetToGeneratedOffset\(mappings, sourceOffset\)[\s\S]*getMappingSegments\(mappings, \{ sortBy: "source" \}\)/,
    'Expected source-to-generated mapping to avoid sorting once by generated offset and again by source offset.'
  )
  assertMatches(
    serviceManagerSource,
    /openDocumentsByAppRoot = new Map\(\)[\s\S]*disposeServiceForAppRoot\(appRoot\)[\s\S]*pruneIdleServices\(options = \{\}\)/,
    'Expected language-service manager to evict idle app-root services only after tracking open documents.'
  )
  assertMatches(
    serverSource,
    /diagnosticProvider:\s*\{[\s\S]*interFileDependencies:\s*true,[\s\S]*workspaceDiagnostics:\s*false/,
    'Expected language server to always advertise LSP pull diagnostics for the VS Code client.'
  )
  assertMatches(
    serverSource,
    /pullDiagnosticRefreshSupported[\s\S]*workspace[\s\S]*diagnostics[\s\S]*refreshSupport/,
    'Expected language server to track client support for Svelte-style pull diagnostics refresh requests.'
  )
  assertMatches(
    serverSource,
    /connection\.languages\.diagnostics\.on\(\(params, token\) => \{[\s\S]*providePullDiagnostics\(params, token\)/,
    'Expected language server to route LSP pull diagnostics directly into the diagnostics provider.'
  )
  assertMatches(
    serverSource,
    /pendingDocumentContentChanges[\s\S]*new TextDocuments\(\{[\s\S]*update\(document, changes, version\)[\s\S]*takePendingDocumentContentChanges/,
    'Expected language server to preserve raw LSP content changes for lifecycle edit-offset tracking.'
  )
  assertMatches(
    serverSource,
    /nextRequestId\("cmp"\)[\s\S]*case:\s*"exact-cache"[\s\S]*getPerformanceBucket\("completion"/,
    'Expected completion logs to include request ids, execution case labels, and performance buckets.'
  )
  assertMatches(
    serverSource,
    /connection\.onCompletionResolve\(\(item\) => \{[\s\S]*nextRequestId\("cres"\)[\s\S]*logRequestResult\("completion",\s*"resolve"[\s\S]*case:[\s\S]*"ts-resolve"[\s\S]*"passthrough"/,
    'Expected completion resolve to log whether detail resolution used TS metadata or passed through.'
  )
  assertMatches(
    serverSource,
    /function getDominantStep\([\s\S]*bottleneck[\s\S]*bottleneckMs/,
    'Expected server performance logs to report the dominant bottleneck step.'
  )
  assertMatches(
    serverSource,
    /connection\.onHover\(\(params,\s*token\) => \{[\s\S]*nextRequestId\("hover"\)[\s\S]*case:\s*"path-target"[\s\S]*case:\s*"ts-hover"/,
    'Expected hover logs to distinguish path-target hovers from TS quick-info hovers.'
  )
  assertMatches(
    serverSource,
    /function buildPathTargetHoverMarkdown\([\s\S]*Resolved as:[\s\S]*Include locals:/,
    'Expected path-target hover markdown to show resolved route method and include locals.'
  )
  assertMatches(
    serverSource,
    /connection\.onRenameRequest\(\(params,\s*token\) => \{[\s\S]*workspaceEditStats\(customResult\)[\s\S]*case:\s*"custom-rename"[\s\S]*workspaceEditStats\(typeScriptResult\)[\s\S]*case:\s*"ts-rename"/,
    'Expected rename logs to report custom and TS edit counts separately.'
  )
  assertMatches(
    serverSource,
    /connection\.onCodeAction\(\(params\) => \{[\s\S]*const diagnosticCount[\s\S]*provideCodeActions\(params\)[\s\S]*case:\s*diagnosticCount \? "diagnostic-actions" : resultCount\(result\) \? "context-actions" : "no-diagnostics"/,
    'Expected empty code-action requests to skip full diagnostics while allowing contextual code actions.'
  )
  assertMatches(
    serverSource,
    /connection\.languages\.inlayHint\.on\(\(params\) => \{[\s\S]*const isLargeEjs[\s\S]*case:\s*"large-ejs-skipped"[\s\S]*return null;[\s\S]*provideInlayHints\(params\)/,
    'Expected large EJS inlay-hint requests to be skipped before expensive TS inlay work.'
  )
  assertMatches(
    serverSource,
    /connection\.onDocumentLinks\(\(params\) => \{[\s\S]*case:\s*"document-links"[\s\S]*connection\.languages\.semanticTokens\.on\(\(params\) => \{[\s\S]*case:\s*"ejs-semantic-tokens"/,
    'Expected structural LSP features to log document links and semantic token requests.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /scheduleDiagnosticsRefreshForDocument[\s\S]*schedulePullDiagnosticsRefresh\(options\.reason \|\| "schedule"\)/,
    'Expected diagnostics feature service to use workspace refresh instead of publishing diagnostics.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /getDiagnostics\([\s\S]*requirePreparedVirtualState:\s*true/,
    'Expected pull diagnostics to require the prepared virtual state produced by ensureDocumentPrepared().'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /operation:\s*"diagnostics"[\s\S]*preferredOffset[\s\S]*skipUnrelatedRegions:\s*true[\s\S]*skipStaticRefresh:\s*true/,
    'Expected recent large-file pull diagnostics to prepare only the preferred region before the full quiet-delay refresh.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /const openWarmupDelayMs = !cachedResult[\s\S]*getRecentOpenWarmupDelayMs\(uri\)[\s\S]*large-open-warmup[\s\S]*open-warmup/,
    'Expected initial open diagnostics to defer briefly so first-request warmup can run before full diagnostics.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /createRequestId\("diag"\)[\s\S]*case:\s*"full-pull"[\s\S]*budgetDeferred/,
    'Expected diagnostics logs to include request ids, case labels, budget status, and bottleneck fields.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /function getResultIdLogFields\(resultId, laneResultIds\) \{[\s\S]*resultIdHash[\s\S]*resultIdBytes[\s\S]*laneHashes[\s\S]*POCKETPAGES_LOG_FULL_RESULT_IDS/,
    'Expected unchanged diagnostics logs to summarize result IDs with hashes, sizes, and optional full detail.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /case:\s*"unchanged"[\s\S]*\.\.\.getResultIdLogFields\(resultId, laneResultIds\)/,
    'Expected unchanged pull diagnostics to log compact result ID comparison fields instead of the full result ID by default.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /includeSemanticDiagnostics:\s*false[\s\S]*includeProjectRuleDiagnostics:\s*false[\s\S]*partialDiagnostics:\s*true/,
    'Expected recent large-file partial diagnostics to defer semantic and project-rule checks until the full diagnostics pass.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /getCachedCodeActionDiagnostics\([\s\S]*laneDiagnostics[\s\S]*documentVersion/,
    'Expected code actions to reuse cached pull diagnostics instead of recomputing full diagnostics.'
  )
  assertMatches(
    diagnosticsFeatureSource,
    /const contextDiagnostics =[\s\S]*params\.context\.diagnostics[\s\S]*const cachedDiagnostics = contextDiagnostics\.length[\s\S]*: \[\];/,
    'Expected code-action provider to avoid full diagnostics while still allowing no-diagnostic contextual actions.'
  )
  const collectServerBlockDiagnosticsSource = languageServiceSource.slice(
    languageServiceSource.indexOf('collectServerBlockDiagnostics('),
    languageServiceSource.indexOf('collectTemplateDiagnostics(')
  )
  const collectTemplateDiagnosticsSource = languageServiceSource.slice(
    languageServiceSource.indexOf('collectTemplateDiagnostics('),
    languageServiceSource.indexOf('getWarmupOffset(')
  )
  if (!/getPreparedServerBlockVirtual\(/.test(collectServerBlockDiagnosticsSource) || /upsertVirtualFile\(/.test(collectServerBlockDiagnosticsSource)) {
    throw new Error('Expected server diagnostics to reuse prepared virtual files without ad-hoc upserts.')
  }
  if (!/getPreparedTemplateVirtual\(/.test(collectTemplateDiagnosticsSource) || /upsertTemplateVirtualFile/.test(collectTemplateDiagnosticsSource)) {
    throw new Error('Expected template diagnostics to reuse prepared virtual files without ad-hoc upserts.')
  }
  assertMatches(
    lifecycleFeatureSource,
    /function shouldRunDiagnosticsForFile\(filePath\) \{[\s\S]*!isExcludedPocketPagesScriptPath\(filePath\)/,
    'Expected lifecycle-features.js to suppress diagnostics for excluded PocketPages vendor and minified scripts.'
  )
  assertMatches(
    lifecycleFeatureSource,
    /function shouldSyncCoreDocument\(filePath\) \{[\s\S]*!isExcludedPocketPagesScriptPath\(filePath\)[\s\S]*handleDidOpen\(event\) \{[\s\S]*shouldSyncCoreDocument\(filePath\)[\s\S]*core\.openDocument/,
    'Expected lifecycle-features.js to avoid preparing excluded asset/vendor/minified scripts on open.'
  )
  assertMatches(
    lifecycleFeatureSource,
    /handleDidManualSave\(\{ uri \}\) \{[\s\S]*refreshPullDiagnostics\("manual-save"\)/,
    'Expected manual-save diagnostics to request a pull diagnostics refresh.'
  )
  assertMatches(
    lifecycleFeatureSource,
    /handleDidChangeWatchedFiles\(event\) \{[\s\S]*requestId\("watch"\)[\s\S]*case:\s*"ignored-open-documents"[\s\S]*case:\s*"workspace-file-changes"[\s\S]*diagnosticsRefreshes:/,
    'Expected watched-file lifecycle logs to explain ignored open-doc changes, app-scoped invalidation, and diagnostics refresh counts.'
  )
  assertMatches(
    lifecycleFeatureSource,
    /getPreferredChangeOffset\([\s\S]*rememberInteractiveOffset\(event\.document\.uri,\s*preferredChangeOffset,\s*"edit"\)/,
    'Expected lifecycle change handling to remember the edit offset for preferred diagnostics.'
  )
  assertMatches(
    lifecycleFeatureSource,
    /const preparedState = hasContentChanges[\s\S]*diagnosticsQuiet:[\s\S]*prepared:\s*preparedState/,
    'Expected lifecycle change logs to expose whether diagnostics quiet handling and prepared-state preservation are in effect.'
  )
  assertMatches(
    lifecycleFeatureSource,
    /handleDidManualSave\(\{ uri \}\)[\s\S]*requestId\("save"\)[\s\S]*case:\s*"manual-save-refresh"[\s\S]*updateDocumentRuntimeState\(uri,\s*document,\s*\{[\s\S]*saved:\s*true/,
    'Expected manual save handling to clear the recent-change quiet window before requesting diagnostics.'
  )
  assertMatches(
    languageServiceSource,
    /orderBlocksForPreferredDiagnostics\([\s\S]*preferred[\s\S]*collectServerBlockDiagnostics\([\s\S]*orderedBlocks/,
    'Expected server-block diagnostics to prioritize the preferred dirty region under the large-file semantic budget.'
  )
  assertMatches(
    serverSource,
    /helpers:\s*\{[\s\S]*isEjsFilePath,[\s\S]*isExcludedPocketPagesScriptPath,[\s\S]*isScriptFilePath,[\s\S]*isSchemaSupportOnlyHookScriptPath,/,
    'Expected server.js helper wiring to expose script and EJS path helpers to lifecycle-features.'
  )
  assertMatches(
    tsPluginSource,
    /core\.isFeatureEnabledAtOffset\(\s*documentContext\.uri,\s*position,\s*capabilityName\s*\)/,
    'Expected PocketPages TS plugin to respect mapper ownership before serving TS features for .ejs.'
  )
  assertMatches(
    tsPluginSource,
    /new PocketPagesLanguageCore\(\{\s*managerOptions:\s*\{\s*idleServiceTtlMs:\s*Infinity,\s*\},\s*\}\)/,
    'Expected PocketPages TS plugin to rely on its own document LRU without app-service idle eviction invalidating cached contexts.'
  )
  assertMatches(
    tsFeatureSource,
    /large-ejs-quote-trigger/,
    'Expected TypeScript completion routing to skip large-EJS quote triggers after custom completions decline.'
  )
  assertMatches(
    tsFeatureSource,
    /requirePreparedVirtualState:\s*true/,
    'Expected TypeScript LSP feature requests to use prepared virtual state instead of ad-hoc virtual upserts.'
  )
  assertMatches(
    tsFeatureSource,
    /operation:\s*"completion"[\s\S]*preferredOffset:\s*offset[\s\S]*skipUnrelatedRegions:\s*true/,
    'Expected completion requests to prepare only the region around the requested offset.'
  )
  assertMatches(
    tsFeatureSource,
    /operation:\s*"hover"[\s\S]*preferredOffset:\s*offset[\s\S]*skipUnrelatedRegions:\s*true/,
    'Expected hover requests to prepare only the region around the requested offset.'
  )
  assertMatches(
    tsFeatureSource,
    /provideDefinition\(params,\s*token\) \{[\s\S]*requestId[\s\S]*operation:\s*"definition"[\s\S]*preferredOffset:\s*offset[\s\S]*skipUnrelatedRegions:\s*true[\s\S]*skipStaticRefresh:\s*true/,
    'Expected definition requests to prepare only the region around the requested offset.'
  )
  assertMatches(
    tsFeatureSource,
    /provideSignatureHelp\(params\) \{[\s\S]*isMappedFeatureEnabled\(documentContext,\s*document,\s*offset,\s*"completion"\)[\s\S]*operation:\s*"signature"[\s\S]*skipUnrelatedRegions:\s*true/,
    'Expected signature-help requests to skip unmapped EJS text and prepare only the requested code region.'
  )
  assertMatches(
    tsFeatureSource,
    /provideInlayHints\(params\) \{[\s\S]*hasFeatureCoverageForRange\([\s\S]*"hover"[\s\S]*getInlayHintEntries/,
    'Expected inlay-hint requests to skip EJS ranges that contain no TypeScript-owned regions.'
  )
  assertMatches(
    languageServiceSource,
    /getPreludeSnapshotKey\(filePath, analysisText = "", options = \{\}\)[\s\S]*options\.dirty === false[\s\S]*preludeSnapshotKey/,
    'Expected unchanged virtual regions to skip buildPrelude() through prelude snapshot keys.'
  )
  assertMatches(
    languageServiceSource,
    /skipUnrelatedRegions[\s\S]*preferredOffset[\s\S]*shouldPrepareEmbeddedCode\(embeddedCode\)/,
    'Expected prepared virtual-code sync to skip embedded regions unrelated to the requested offset.'
  )
  assertMatches(
    languageServiceSource,
    /isExcludedRouteExposedPagesScriptFile\(normalizedFilePath\)[\s\S]*return "noop"/,
    'Expected project cache invalidation to ignore route-exposed vendor and minified scripts.'
  )
  assertMatches(
    serverSource,
    /connection\.onReferences\([\s\S]*core\.isFeatureEnabledAtOffset\(params\.textDocument\.uri,\s*offset,\s*"references"\)[\s\S]*ensureDocumentPrepared\(document\.uri,\s*\{[\s\S]*operation:\s*"references"[\s\S]*requirePreparedVirtualState:\s*true/,
    'Expected references routing to keep TypeScript references on the prepared-only mapped feature path.'
  )
  assertMatches(
    tsPluginSource,
    /core\.reloadCachesForAppRoot\(appRoot\)/,
    'Expected PocketPages TS plugin to invalidate app-scoped caches when sibling project files change.'
  )
  assertMatches(
    tsPluginSource,
    /function isRouteExposedVendorOrMinifiedScript\(fileName, appRoot\)[\s\S]*relativeSegments\.includes\("_private"\)[\s\S]*relativeSegments\.includes\("vendor"\)[\s\S]*\.endsWith\("\.min\.js"\)/,
    'Expected PocketPages TS plugin to ignore route-exposed vendor and minified scripts while keeping _private vendor modules.'
  )
  assertMatches(
    tsPluginSource,
    /core\.closeDocument\(uri\)/,
    'Expected PocketPages TS plugin to release managed EJS document state when pruning plugin-owned caches.'
  )
  assertMatches(
    maintenanceFeatureSource,
    /clearCachedCompletionItemsForUri\(affectedUri\)/,
    'Expected reloadCaches maintenance flow to clear cached completion entries for affected open documents.'
  )
  assertMatches(
    maintenanceFeatureSource,
    /provideRefreshDiagnostics\(\{ uri \}\) \{[\s\S]*requestId\("diagcmd"\)[\s\S]*case:\s*"manual-command"/,
    'Expected refreshDiagnostics maintenance requests to log command-triggered refreshes.'
  )
  assertMatches(
    maintenanceFeatureSource,
    /provideProbeCurrentFile\(\{ uri \}\) \{[\s\S]*isExcludedPocketPagesScriptPath\(filePath\)[\s\S]*diagnostics:\s*0[\s\S]*case:\s*getProbeLogCase\(result,\s*isExcluded\)/,
    'Expected probeCurrentFile to avoid running diagnostics for excluded asset/vendor/minified scripts.'
  )
  assertMatches(
    maintenanceFeatureSource,
    /provideReloadCaches\(\{ uri \}\) \{[\s\S]*requestId\("cache"\)[\s\S]*affectedOpenDocuments[\s\S]*perf:/,
    'Expected cache reload maintenance requests to log scope, affected open documents, and performance.'
  )
  assertMatches(
    maintenanceFeatureSource,
    /provideAllFileReferences\(\{ uri \}\) \{[\s\S]*case:\s*result \? "file-reference-graph" : "no-reference-query"[\s\S]*referenceKind:/,
    'Expected all-file-reference maintenance requests to log reference graph kind and count.'
  )
  assertMatches(
    maintenanceFeatureSource,
    /provideFileRenameEdits\(\{ oldUri, newUri \}\) \{[\s\S]*case:\s*"file-rename-edits"[\s\S]*files:\s*countEditFiles\(result\)[\s\S]*edits:/,
    'Expected file rename maintenance requests to log affected file and edit counts.'
  )

  if (!vscodeIgnore.includes('node_modules/**')) {
    throw new Error('Expected .vscodeignore to exclude node_modules by default for VSIX packaging.')
  }
  if (!vscodeIgnore.includes('!node_modules/@dlstj-local/pocketpages-typescript-plugin/**')) {
    throw new Error('Expected .vscodeignore to re-include the bundled PocketPages TS plugin package.')
  }
  if (!vscodeIgnore.includes('!node_modules/typescript/**')) {
    throw new Error('Expected .vscodeignore to re-include the TypeScript runtime needed by the TS plugin.')
  }

  assertMatches(
    installScriptSource,
    /const packageJson = JSON\.parse\(fs\.readFileSync\(PACKAGE_JSON_PATH, 'utf8'\)\)[\s\S]*const EXTENSION_ID = `\$\{packageJson\.publisher\}\.\$\{packageJson\.name\}`/,
    'Expected install-vscode-pocketpages.js to derive the extension ID from package.json metadata.'
  )
}

function createFixtureApp(_repoRoot) {
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
            { name: 'status', type: 'select', maxSelect: 1, values: ['draft', 'published'] },
            { name: 'tags', type: 'select', maxSelect: 5, values: ['news', 'tips'] },
            { name: 'cover', type: 'file', maxSelect: 1 },
            { name: 'gallery', type: 'file', maxSelect: 5 },
            { name: 'owner', type: 'relation', maxSelect: 1, collectionId: 'users' },
            { name: 'members', type: 'relation', maxSelect: 10, collectionId: 'users' },
            { name: 'archived_at', type: 'autodate', onCreate: false, onUpdate: false },
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

  writeFile(
    path.join(appRoot, 'node_modules', '@pocketpages', 'utils', 'package.json'),
    JSON.stringify(
      {
        name: '@pocketpages/utils',
        version: '0.0.1',
        main: './index.js',
        types: './index.d.ts',
      },
      null,
      2
    )
  )
  writeFile(
    path.join(appRoot, 'node_modules', '@pocketpages', 'utils', 'index.js'),
    `module.exports = {
  dateutil: {
    formatDate(value) {
      return String(value)
    },
    startOfDay(value) {
      return value
    },
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'node_modules', '@pocketpages', 'utils', 'index.d.ts'),
    `interface DateutilApi {
  formatDate(value: string): string
  startOfDay(value: string): Date
}

declare const pocketpagesUtils: {
  dateutil: DateutilApi
}

export = pocketpagesUtils
`
  )

  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'), `<a href="/boards">Boards</a>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'sign-in.ejs'), `<h1>Sign In</h1>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', 'index.ejs'), `<h1>Feedback</h1>\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'roles', 'board.js'),
    `module.exports = {
  canRead() {
    return true
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'vendor', 'legacy.js'),
    `module.exports = {
  boot() {
    return true
  },
}
`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'vendor', 'index.ejs'), `<h1>Vendor Route</h1>\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'legacy.min.js'),
    `module.exports = {
  boot() {
    return true
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'bundle.MIN.JS'),
    `module.exports = {
  boot() {
    return true
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+get.js'),
    `module.exports = function () {\n  return { ok: true }\n}\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+post.js'),
    `module.exports = function () {\n  return ''\n}\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+load.js'),
    `module.exports = function () {\n  return {}\n}\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+delete.js'),
    `module.exports = function () {\n  return ''\n}\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+put.js'),
    `module.exports = function () {\n  return ''\n}\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+patch.js'),
    `module.exports = function () {\n  return ''\n}\n`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'booklog-reader.js'), `console.log('reader')\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'snippet.ejs'), `<script server>\nconst ignored = true\n</script>\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'vendor', 'jszip-3.10.1.min.js'), `window.JSZip = {}\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'card.css'), `.board-card { color: #222; }\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'assets', 'board-widget.js'), `console.log('board widget')\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'assets', 'widget.ejs'), `<script server>\nconst ignoredWidget = true\n</script>\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs'),
    `<%- include('flash-alert.ejs', { flashMessage: 'Saved', isErrorFlash: false, flashMeta: { count: 1 } }) %>\n`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'index.ejs'), `<script server>\nboard.get('name')\n</script>\n`)
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'by-file', '[boardSlug].ejs'),
    `<script server>
const directBoardSlug = params.boardSlug
</script>
<div><%= params.boardSlug %></div>
`
  )
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
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'resolve-parent-check.ejs'),
    `<script server>\nconst sharedService = resolve('../shared-service')\n</script>\n`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'shared-panel.ejs'), `<h1>Route Shared Panel</h1>\n`)
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
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-method-reference-check.ejs'),
    `<a href="/feedback">Feedback</a>
<form action="/feedback" method="post"></form>
<button hx-post="/feedback"></button>
<button data-hx-post="/feedback"></button>
<button hx-delete="/feedback"></button>
<button hx-put="/feedback"></button>
<button hx-patch="/feedback"></button>
`
  )
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'method-shadow', '+post.ejs'), `<h1>Not a method route</h1>\n`)
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
    path.join(appRoot, 'pb_hooks', 'jobs', 'rebuild-search.js'),
    `const sharedJob = require('./shared-job')
const boardService = require('../pages/_private/board-service')
const boards = $app.findRecordsByFilter('boards')
const board = $app.findFirstRecordByFilter('boards', 'id != ""')

module.exports = {
  sharedJob,
  boardService,
  boards,
  board,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'jobs', 'shared-job.js'),
    `module.exports = {
  source: 'shared-job',
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', 'api', 'mjs-consumer.mjs'),
    `const cjsStateService = resolve('cjs-state-service')
const cjsState = cjsStateService.readCjsState()
const records = $app.findRecordsByFilter('boards')

module.exports = {
  cjsState,
  records,
}
`
  )
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
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'schema-inferred-service.js'),
    `let deferredExport

function findPostBySlug(slug) {
  return $app.findFirstRecordByFilter('posts', 'slug = {:slug}', { slug })
}

function listPosts() {
  return $app.findRecordsByFilter('posts', '')
}

/**
 * @returns {core.Record}
 */
function documentedBoard() {
  return $app.findFirstRecordByFilter('boards', 'id != ""')
}

module.exports = {
  findPostBySlug,
  listPosts,
  documentedBoard,
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
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'collection-constants.js'),
    `const CACHE_COLLECTION_NAME = 'boards'

module.exports = {
  CACHE_COLLECTION_NAME,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'imported-collection-consumer.js'),
    `const { CACHE_COLLECTION_NAME } = require('./collection-constants')

function loadBoard() {
  let record = null

  try {
    record = $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, '')
    record.get('na')
    const cachedBoardName = record.get('name')
    return cachedBoardName
  } catch (_error) {
    record = null
  }

  const collection = $app.findCollectionByNameOrId(CACHE_COLLECTION_NAME)
  const fallbackRecord = new Record(collection)
  fallbackRecord.get('na')
  return fallbackRecord.get('name')
}

module.exports = {
  loadBoard,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'cjs-state-service.cjs'),
    `/**
 * @returns {{ scope: string }}
 */
function readCjsState() {
  return {
    scope: 'cjs',
  }
}

module.exports = {
  readCjsState,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'shared-service.js'),
    `module.exports = {
  readSummary() {
    return { scope: 'root' }
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'html-to-text-consumer.js'),
    `const { compile } = require(\`\${__hooks}/pages/_private/vendor/html-to-text.bundle.js\`)

module.exports = {
  compile,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'html-to-text-consumer-concat.js'),
    `const { compile } = require(__hooks + '/pages/_private/vendor/html-to-text.bundle.js')

module.exports = {
  compile,
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'html-to-text-preview.ejs'),
    `<script server>
  const { compile } = require(\`\${__hooks}/pages/_private/vendor/html-to-text.bundle.js\`)
  const htmlToText = compile({ wordwrap: false })
</script>
<div><%= htmlToText('<p>Hello</p>') %></div>
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'roles', 'board.js'),
    `module.exports = {
  canAcceptPosts() {
    return true
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'roles', 'post.js'),
    `module.exports = {
  canPublish() {
    return true
  },
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
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'shared-panel.ejs'),
    `<div>root:<%= banner %></div>\n`
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
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '_private', 'vendor', 'html-to-text.bundle.js'),
    `module.exports = {
  compile() {
    return function () {
      return ''
    }
  },
}
`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '_private', 'shared-panel.ejs'),
    `<div>local:<%= banner %></div>\n`
  )
  writeFile(
    path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '_private', 'shared-service.js'),
    `module.exports = {
  readSummary() {
    return { scope: 'local' }
  },
}
`
  )

  const secondaryAppRoot = path.join(fixtureRoot, 'apps', 'secondary-app')

  writeFile(path.join(secondaryAppRoot, 'jsconfig.json'), fs.readFileSync(path.join(appRoot, 'jsconfig.json'), 'utf8'))
  writeFile(
    path.join(secondaryAppRoot, 'pb_data', 'types.d.ts'),
    fs.readFileSync(path.join(appRoot, 'pb_data', 'types.d.ts'), 'utf8')
  )
  writeFile(
    path.join(secondaryAppRoot, 'pocketpages-globals.d.ts'),
    fs.readFileSync(path.join(appRoot, 'pocketpages-globals.d.ts'), 'utf8')
  )
  writeFile(path.join(secondaryAppRoot, 'types.d.ts'), fs.readFileSync(path.join(appRoot, 'types.d.ts'), 'utf8'))
  writeFile(
    path.join(secondaryAppRoot, 'pb_schema.json'),
    JSON.stringify(
      [
        {
          name: 'journals',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'visibility', type: 'text' },
          ],
        },
        {
          name: 'entries',
          fields: [
            { name: 'journal', type: 'relation' },
            { name: 'body', type: 'text' },
          ],
        },
      ],
      null,
      2
    )
  )
  writeFile(
    path.join(secondaryAppRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'),
    `<%- include('status-badge.ejs', { state: 'open' }) %>\n`
  )
  writeFile(
    path.join(secondaryAppRoot, 'pb_hooks', 'pages', '_private', 'journal-service.js'),
    `module.exports = {
  readSummary() {
    return { ok: true }
  },
}
`
  )
  writeFile(
    path.join(secondaryAppRoot, 'pb_hooks', 'pages', '_private', 'status-badge.ejs'),
    `<div><%= state %></div>\n`
  )
  const corpusApp = createCorpusBooklogApp(fixtureRoot, appRoot)

  return {
    fixtureRoot,
    appRoot,
    secondaryAppRoot,
    ...corpusApp,
    schemaFilePath: path.join(appRoot, 'pb_schema.json'),
    siteIndexFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'),
    boardsFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs'),
    boardShowFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'index.ejs'),
    boardFileParamFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'by-file', '[boardSlug].ejs'),
    localsTypeCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'locals-type-check.ejs'),
    overrideCardCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'override-card-check.ejs'),
    resolveParentCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'resolve-parent-check.ejs'),
    optionalNoticeAFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-a.ejs'),
    optionalNoticeBFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-b.ejs'),
    routeReferenceCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-reference-check.ejs'),
    routeMethodReferenceCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-method-reference-check.ejs'),
    methodShadowPostEjsFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'method-shadow', '+post.ejs'),
    globalAssetFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'booklog-reader.js'),
    globalAssetTemplateFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'snippet.ejs'),
    vendorAssetFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'vendor', 'jszip-3.10.1.min.js'),
    localAssetFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'card.css'),
    nestedAssetScriptFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'assets', 'board-widget.js'),
    nestedAssetTemplateFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'assets', 'widget.ejs'),
    propertyLocalsCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'property-locals-check.ejs'),
    renameCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'rename-check.ejs'),
    middlewareFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'api', '+middleware.js'),
    mjsConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'api', 'mjs-consumer.mjs'),
    jobScriptFilePath: path.join(appRoot, 'pb_hooks', 'jobs', 'rebuild-search.js'),
    sharedJobFilePath: path.join(appRoot, 'pb_hooks', 'jobs', 'shared-job.js'),
    boardServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service.js'),
    schemaInferredServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'schema-inferred-service.js'),
    boardServiceConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service-consumer.js'),
    importedCollectionConstantsFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'collection-constants.js'),
    importedCollectionConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'imported-collection-consumer.js'),
    cjsStateServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'cjs-state-service.cjs'),
    sharedServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'shared-service.js'),
    localSharedServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '_private', 'shared-service.js'),
    htmlToTextConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'html-to-text-consumer.js'),
    htmlToTextConcatConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'html-to-text-consumer-concat.js'),
    htmlToTextPageConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'html-to-text-preview.ejs'),
    htmlToTextBundleFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'vendor', 'html-to-text.bundle.js'),
    boardRoleFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'roles', 'board.js'),
    postRoleFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'roles', 'post.js'),
    publicBoardRoleRouteFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'roles', 'board.js'),
    routeVendorScriptFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'vendor', 'legacy.js'),
    routeVendorTemplateFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'vendor', 'index.ejs'),
    routeMinifiedScriptFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'legacy.min.js'),
    routeUppercaseMinifiedScriptFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'bundle.MIN.JS'),
    flashAlertFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'flash-alert.ejs'),
    typedPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'typed-panel.ejs'),
    sharedPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'shared-panel.ejs'),
    propertyPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'property-panel.ejs'),
    overrideCardFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'override-card.ejs'),
    optionalNoticeFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'optional-notice.ejs'),
    errorPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'error-panel.ejs'),
    localSharedPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '_private', 'shared-panel.ejs'),
    routeSharedPanelFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'shared-panel.ejs'),
    signOutFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-out.ejs'),
    signInFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'xapi', 'auth', 'sign-in.ejs'),
    siteSignInFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'sign-in.ejs'),
    feedbackPageFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', 'index.ejs'),
    feedbackGetFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+get.js'),
    feedbackLoadFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+load.js'),
    feedbackPostFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+post.js'),
    feedbackDeleteFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+delete.js'),
    feedbackPutFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+put.js'),
    feedbackPatchFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'feedback', '+patch.js'),
    secondarySiteIndexFilePath: path.join(secondaryAppRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'),
    secondaryJournalServiceFilePath: path.join(secondaryAppRoot, 'pb_hooks', 'pages', '_private', 'journal-service.js'),
    secondaryStatusBadgeFilePath: path.join(secondaryAppRoot, 'pb_hooks', 'pages', '_private', 'status-badge.ejs'),
  }
}

async function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  assertClientContracts(repoRoot)
  assertLspRuntimeContracts(repoRoot)
  assertCompletionHelperContracts()
  const runtimeProbe = createDocumentRuntimeStateRegistry()
  runtimeProbe.updateDocument('file:///runtime.ejs', {
    version: 1,
  })
  if (runtimeProbe.isStaleVersion('file:///runtime.ejs', 1)) {
    throw new Error('Expected document runtime state to track the current document version.')
  }
  runtimeProbe.updateDocument('file:///runtime.ejs', {
    version: 2,
  })
  if (!runtimeProbe.isStaleVersion('file:///runtime.ejs', 1)) {
    throw new Error('Expected document runtime state to report older versions as stale.')
  }
  runtimeProbe.updateDocument('file:///runtime.ejs', {
    version: 2,
    textLength: 20,
    changed: true,
  })
  const changedRuntimeState = runtimeProbe.getDocument('file:///runtime.ejs')
  if (!changedRuntimeState || !changedRuntimeState.changedAt) {
    throw new Error(`Expected document runtime state to track recent edits for diagnostics quiet windows. Got: ${JSON.stringify(changedRuntimeState)}`)
  }
  runtimeProbe.updateDocument('file:///runtime.ejs', {
    version: 2,
    textLength: 20,
    saved: true,
  })
  const savedRuntimeState = runtimeProbe.getDocument('file:///runtime.ejs')
  if (!savedRuntimeState || !savedRuntimeState.savedAt || savedRuntimeState.changedAt !== 0) {
    throw new Error(`Expected document runtime state to clear recent-change quiet windows on save. Got: ${JSON.stringify(savedRuntimeState)}`)
  }
  const coordinatorEvents = []
  const coordinatorTimers = []
  const coordinator = createRequestCoordinator({
    runtimeState: runtimeProbe,
    setTimeout(callback, delayMs) {
      coordinatorTimers.push({ callback, delayMs })
      return coordinatorTimers.length
    },
    clearTimeout(timerId) {
      coordinatorEvents.push(`clear:${timerId}`)
    },
  })
  coordinator.schedule(
    {
      uri: 'file:///runtime.ejs',
      key: 'low',
      version: 2,
      delayMs: 5,
    },
    () => coordinatorEvents.push('low-ran')
  )
  if (!coordinator.hasScheduled('file:///runtime.ejs', 'low') || coordinatorTimers[0].delayMs !== 5) {
    throw new Error(`Expected request coordinator to schedule stale-guarded work with the requested delay. Got: ${JSON.stringify(coordinatorTimers)}`)
  }
  runtimeProbe.setDiagnostics('file:///runtime.ejs', 'pull', {
    resultId: 'pull:2:1',
    items: [{ code: 'cached' }],
  })
  const cachedRuntimeDiagnostics = runtimeProbe.getDiagnostics('file:///runtime.ejs', 'pull')
  if (!cachedRuntimeDiagnostics || cachedRuntimeDiagnostics.resultId !== 'pull:2:1') {
    throw new Error(`Expected document runtime state to cache diagnostics results. Got: ${JSON.stringify(cachedRuntimeDiagnostics)}`)
  }
  runtimeProbe.updateDocument('file:///runtime.ejs', {
    version: 3,
  })
  coordinatorTimers[0].callback()
  if (coordinatorEvents.includes('low-ran')) {
    throw new Error('Expected request coordinator to skip stale scheduled work.')
  }

  const snapshotProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-pocketpages-snapshot-manager-'))
  const normalizeProbePath = (filePath) => path.resolve(filePath).replace(/\\/g, '/').replace(/^[A-Z]:/, (value) => value.toLowerCase())
  const snapshotProbe = new DocumentSnapshotManager({ normalizePath: normalizeProbePath })
  const snapshotProbeFilePath = path.join(snapshotProbeRoot, 'page.ejs')
  const snapshotSourceV1 = snapshotProbe.upsertSourceDocument(snapshotProbeFilePath, 'const value = 1\n', {
    uri: URI.file(snapshotProbeFilePath).toString(),
    version: 1,
    opened: true,
  })
  const snapshotSourceV2 = snapshotProbe.upsertSourceDocument(snapshotProbeFilePath, 'const value = 1\n', {
    uri: URI.file(snapshotProbeFilePath).toString(),
    version: 2,
    changed: true,
  })
  if (
    snapshotSourceV2.snapshotId !== snapshotSourceV1.snapshotId ||
    snapshotSourceV2.lspVersion !== 2 ||
    !snapshotSourceV2.changedAt
  ) {
    throw new Error(`Expected same-text source updates to keep snapshot identity and advance LSP metadata. Got: ${JSON.stringify(snapshotSourceV2)}`)
  }
  const snapshotSourceV3 = snapshotProbe.upsertSourceDocument(snapshotProbeFilePath, 'const value = 12\n', {
    version: 3,
  })
  const snapshotChangeRange = snapshotSourceV3.snapshot.getChangeRange(snapshotSourceV1.snapshot)
  if (
    snapshotSourceV3.snapshotId === snapshotSourceV1.snapshotId ||
    !snapshotChangeRange ||
    typeof snapshotChangeRange.span.start !== 'number'
  ) {
    throw new Error(`Expected changed source updates to advance snapshot identity with a change range. Got: ${JSON.stringify({ snapshotSourceV3, snapshotChangeRange })}`)
  }
  snapshotProbe.setPreparedDocumentState(snapshotProbeFilePath, {
    snapshotId: snapshotSourceV3.snapshotId,
    documentText: snapshotSourceV3.text,
  })
  if (
    !snapshotProbe.isPreparedDocumentStateCurrent(snapshotProbe.getPreparedDocumentState(snapshotProbeFilePath), snapshotProbeFilePath, snapshotSourceV3.text) ||
    snapshotProbe.isPreparedDocumentStateCurrent(snapshotProbe.getPreparedDocumentState(snapshotProbeFilePath), snapshotProbeFilePath, snapshotSourceV1.text)
  ) {
    throw new Error('Expected prepared document current checks to follow source snapshot identity.')
  }
  const snapshotProbeVirtualFilePath = path.join(snapshotProbeRoot, 'page.ejs.__virtual.js')
  snapshotProbe.setVirtualFileState(snapshotProbeVirtualFilePath, {
    text: 'const virtualValue = 1\n',
    filePath: snapshotProbeFilePath,
    kind: 'probe-virtual',
    mappings: [
      {
        sourceOffsets: [0],
        generatedOffsets: [0],
        lengths: [21],
        data: { marker: 'initial' },
      },
    ],
  })
  const snapshotVirtualVersionV1 = snapshotProbe.getScriptVersion(snapshotProbeVirtualFilePath)
  const snapshotVirtualSnapshotV1 = snapshotProbe.getScriptSnapshot(snapshotProbeVirtualFilePath)
  snapshotProbe.setVirtualFileState(snapshotProbeVirtualFilePath, {
    text: 'const virtualValue = 1\n',
    filePath: snapshotProbeFilePath,
    kind: 'probe-virtual-metadata-only',
    mappings: [
      {
        sourceOffsets: [0],
        generatedOffsets: [0],
        lengths: [21],
        data: { marker: 'updated' },
      },
    ],
  })
  const snapshotVirtualStateV2 = snapshotProbe.getTsFileState(snapshotProbeVirtualFilePath)
  if (
    !snapshotProbe.getTsFileNames().includes(normalizeProbePath(snapshotProbeVirtualFilePath)) ||
    snapshotProbe.readFile(snapshotProbeVirtualFilePath) !== 'const virtualValue = 1\n' ||
    !snapshotProbe.getScriptSnapshot(snapshotProbeVirtualFilePath) ||
    snapshotProbe.getScriptVersion(snapshotProbeVirtualFilePath) !== snapshotVirtualVersionV1 ||
    snapshotProbe.getScriptSnapshot(snapshotProbeVirtualFilePath) !== snapshotVirtualSnapshotV1 ||
    snapshotVirtualStateV2.kind !== 'probe-virtual-metadata-only' ||
    snapshotVirtualStateV2.mappings[0].data.marker !== 'updated'
  ) {
    throw new Error('Expected DocumentSnapshotManager to preserve virtual script versions while updating metadata-only state.')
  }
  snapshotProbe.setVirtualFileState(snapshotProbeVirtualFilePath, {
    text: 'const virtualValue = 12\n',
    filePath: snapshotProbeFilePath,
    kind: 'probe-virtual',
  })
  if (
    snapshotProbe.getScriptVersion(snapshotProbeVirtualFilePath) === snapshotVirtualVersionV1 ||
    snapshotProbe.getScriptSnapshot(snapshotProbeVirtualFilePath) === snapshotVirtualSnapshotV1
  ) {
    throw new Error('Expected DocumentSnapshotManager to advance virtual script versions when text changes.')
  }
  const snapshotProbeStaticFilePath = path.join(snapshotProbeRoot, 'ambient-static.d.ts')
  snapshotProbe.setStaticFileState(snapshotProbeStaticFilePath, {
    text: 'declare const staticValue: 1\n',
    mtimeMs: 1,
    marker: 'initial',
  })
  const snapshotStaticVersionV1 = snapshotProbe.getScriptVersion(snapshotProbeStaticFilePath)
  const snapshotStaticSnapshotV1 = snapshotProbe.getScriptSnapshot(snapshotProbeStaticFilePath)
  snapshotProbe.setStaticFileState(snapshotProbeStaticFilePath, {
    text: 'declare const staticValue: 1\n',
    mtimeMs: 2,
    marker: 'updated',
  })
  const snapshotStaticStateV2 = snapshotProbe.getTsFileState(snapshotProbeStaticFilePath)
  if (
    snapshotProbe.getScriptVersion(snapshotProbeStaticFilePath) !== snapshotStaticVersionV1 ||
    snapshotProbe.getScriptSnapshot(snapshotProbeStaticFilePath) !== snapshotStaticSnapshotV1 ||
    snapshotStaticStateV2.mtimeMs !== 2 ||
    snapshotStaticStateV2.marker !== 'updated'
  ) {
    throw new Error('Expected DocumentSnapshotManager to preserve static script versions while updating metadata-only state.')
  }
  snapshotProbe.setStaticFileState(snapshotProbeStaticFilePath, {
    text: 'declare const staticValue: 12\n',
    mtimeMs: 3,
  })
  if (
    snapshotProbe.getScriptVersion(snapshotProbeStaticFilePath) === snapshotStaticVersionV1 ||
    snapshotProbe.getScriptSnapshot(snapshotProbeStaticFilePath) === snapshotStaticSnapshotV1
  ) {
    throw new Error('Expected DocumentSnapshotManager to advance static script versions when text changes.')
  }
  const snapshotProbeDiskFilePath = path.join(snapshotProbeRoot, 'ambient.d.ts')
  writeFile(snapshotProbeDiskFilePath, 'declare const ambientValue: 1\n')
  const snapshotDiskVersionV1 = snapshotProbe.getScriptVersion(snapshotProbeDiskFilePath)
  writeFile(snapshotProbeDiskFilePath, 'declare const ambientValue: 123\n')
  const snapshotDiskTextV2 = snapshotProbe.readFile(snapshotProbeDiskFilePath)
  const snapshotDiskVersionV2 = snapshotProbe.getScriptVersion(snapshotProbeDiskFilePath)
  if (
    snapshotDiskTextV2 !== 'declare const ambientValue: 123\n' ||
    snapshotDiskVersionV2 === snapshotDiskVersionV1
  ) {
    throw new Error(`Expected disk fallback snapshots to refresh through DocumentSnapshotManager. Got: ${JSON.stringify({ snapshotDiskVersionV1, snapshotDiskVersionV2, snapshotDiskTextV2 })}`)
  }
  const statCacheProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-pocketpages-stat-cache-'))
  const statCacheFilePath = path.join(statCacheProbeRoot, 'cache-target.js')
  writeFile(statCacheFilePath, 'const value = 1\n')
  const statCacheDirPath = path.join(statCacheProbeRoot, 'nested')
  ensureDir(statCacheDirPath)
  const statCacheMissingPath = path.join(statCacheProbeRoot, 'missing-target.js')

  if (
    !statCache.statFileExists(statCacheFilePath) ||
    statCache.statDirectoryExists(statCacheFilePath) ||
    !statCache.statDirectoryExists(statCacheDirPath) ||
    statCache.statFileExists(statCacheMissingPath)
  ) {
    throw new Error('Expected stat-cache helpers to report real filesystem state outside an epoch.')
  }

  let statCacheRealStatCount = 0
  const originalStatSync = fs.statSync
  fs.statSync = function countingStatSync(targetPath, ...rest) {
    statCacheRealStatCount += 1
    return originalStatSync.call(fs, targetPath, ...rest)
  }
  try {
    const epochResult = statCache.runStatEpoch(() => {
      const first = statCache.statFileExists(statCacheFilePath)
      const second = statCache.statFileExists(statCacheFilePath)
      const entry = statCache.getStatEntry(statCacheFilePath)
      return { first, second, entry, statsAfterReads: statCacheRealStatCount }
    })
    if (
      !epochResult.first ||
      !epochResult.second ||
      !epochResult.entry.exists ||
      !epochResult.entry.isFile ||
      epochResult.entry.isDirectory ||
      epochResult.statsAfterReads !== 1
    ) {
      throw new Error(`Expected stat-cache to memoize repeated statSync calls within an epoch. Got: ${JSON.stringify(epochResult)}`)
    }

    const statCacheStatsCountBeforeCached = statCacheRealStatCount
    const cachedStatsResult = statCache.runStatEpoch(() => {
      const stats = statCache.statSyncCached(statCacheFilePath)
      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        hasMtime: typeof stats.mtimeMs === 'number',
        hasSize: typeof stats.size === 'number',
      }
    })
    if (
      !cachedStatsResult.isFile ||
      cachedStatsResult.isDirectory ||
      !cachedStatsResult.hasMtime ||
      !cachedStatsResult.hasSize
    ) {
      throw new Error(`Expected statSyncCached to expose a ts.Stats-like shape for existing files. Got: ${JSON.stringify(cachedStatsResult)}`)
    }
    if (statCacheRealStatCount <= statCacheStatsCountBeforeCached) {
      throw new Error('Expected statSyncCached to stat the file when its entry is not yet cached.')
    }

    let missingThrew = false
    statCache.runStatEpoch(() => {
      try {
        statCache.statSyncCached(statCacheMissingPath)
      } catch (_error) {
        missingThrew = true
      }
    })
    if (!missingThrew) {
      throw new Error('Expected statSyncCached to throw for missing files, matching fs.statSync semantics.')
    }

    const nestedStatsCountBefore = statCacheRealStatCount
    statCache.runStatEpoch(() => {
      statCache.statFileExists(statCacheFilePath)
      statCache.runStatEpoch(() => {
        statCache.statFileExists(statCacheFilePath)
      })
      statCache.statFileExists(statCacheFilePath)
    })
    if (statCacheRealStatCount - nestedStatsCountBefore !== 1) {
      throw new Error('Expected nested stat-cache epochs to share a single memoization map.')
    }
  } finally {
    fs.statSync = originalStatSync
  }

  const statCacheReReadFilePath = path.join(statCacheProbeRoot, 'epoch-reread.js')
  writeFile(statCacheReReadFilePath, 'const a = 1\n')
  statCache.runStatEpoch(() => statCache.statFileExists(statCacheReReadFilePath))
  fs.rmSync(statCacheReReadFilePath, { force: true })
  if (statCache.statFileExists(statCacheReReadFilePath)) {
    throw new Error('Expected stat-cache to clear its memoization map when an epoch ends.')
  }
  fs.rmSync(statCacheProbeRoot, { recursive: true, force: true })

  const versionedInitial = createVersionedTextState(null, {
    text: 'const versioned = 1\n',
    kind: 'probe',
    marker: 'initial',
  })
  if (versionedInitial.version !== '1' || !versionedInitial.snapshot) {
    throw new Error(`Expected createVersionedTextState to seed version "1" with a snapshot. Got: ${JSON.stringify({ version: versionedInitial.version })}`)
  }
  const versionedSameText = createVersionedTextState(versionedInitial, {
    text: 'const versioned = 1\n',
    kind: 'probe',
    marker: 'updated',
  })
  if (
    versionedSameText.version !== versionedInitial.version ||
    versionedSameText.snapshot !== versionedInitial.snapshot ||
    versionedSameText.marker !== 'updated'
  ) {
    throw new Error(`Expected identical-text versioned state to keep version/snapshot while merging metadata. Got: ${JSON.stringify({ version: versionedSameText.version, sameSnapshot: versionedSameText.snapshot === versionedInitial.snapshot, marker: versionedSameText.marker })}`)
  }
  const versionedChangedText = createVersionedTextState(versionedSameText, {
    text: 'const versioned = 12\n',
    kind: 'probe',
  })
  if (
    versionedChangedText.version !== '2' ||
    versionedChangedText.snapshot === versionedInitial.snapshot ||
    versionedChangedText.text !== 'const versioned = 12\n'
  ) {
    throw new Error(`Expected changed-text versioned state to advance version and rebuild snapshot. Got: ${JSON.stringify({ version: versionedChangedText.version })}`)
  }
  const versionedNullText = createVersionedTextState(versionedChangedText, {
    kind: 'probe',
  })
  if (versionedNullText.text !== '' || versionedNullText.version !== '3') {
    throw new Error(`Expected createVersionedTextState to coerce missing text to "" and advance version. Got: ${JSON.stringify({ text: versionedNullText.text, version: versionedNullText.version })}`)
  }
  const versionedEmptyPreserved = createVersionedTextState(versionedNullText, {
    text: '',
    marker: 'empty-kept',
  })
  if (
    versionedEmptyPreserved.version !== versionedNullText.version ||
    versionedEmptyPreserved.snapshot !== versionedNullText.snapshot ||
    versionedEmptyPreserved.marker !== 'empty-kept'
  ) {
    throw new Error('Expected empty-text updates to preserve version/snapshot when the previous text was also empty.')
  }

  const assertScriptRouteContext = (label, scriptText, marker, expected) => {
    const offset = scriptText.indexOf(marker)
    if (offset === -1) {
      throw new Error(`Test setup error: marker "${marker}" not found for ${label}.`)
    }

    const context = getPathContextAtOffset(scriptText, offset, { mode: 'script' })
    if (!context || context.kind !== expected.kind) {
      throw new Error(`Expected ${label} to resolve a "${expected.kind}" path context. Got: ${JSON.stringify(context)}`)
    }
    if (expected.routeSource !== undefined && context.routeSource !== expected.routeSource) {
      throw new Error(`Expected ${label} routeSource "${expected.routeSource}". Got: ${JSON.stringify(context)}`)
    }
  }

  assertScriptRouteContext(
    'response.redirect',
    "response.redirect('/boards')\n",
    '/boards',
    { kind: 'route-path', routeSource: 'redirect' }
  )
  assertScriptRouteContext(
    'api.redirect',
    "api.redirect('/boards')\n",
    '/boards',
    { kind: 'route-path', routeSource: 'redirect' }
  )
  assertScriptRouteContext(
    'datastar.redirect',
    "datastar.redirect('/boards')\n",
    '/boards',
    { kind: 'route-path', routeSource: 'redirect' }
  )
  assertScriptRouteContext(
    'datastar.replaceURL',
    "datastar.replaceURL('/boards')\n",
    '/boards',
    { kind: 'route-path', routeSource: 'replace-url' }
  )
  assertScriptRouteContext(
    'api.resolve',
    "api.resolve('./board-service')\n",
    './board-service',
    { kind: 'resolve-path' }
  )
  assertScriptRouteContext(
    'api.include',
    "api.include('./shared-panel.ejs')\n",
    './shared-panel.ejs',
    { kind: 'include-path' }
  )
  assertScriptRouteContext(
    'api.asset',
    "api.asset('/style.css')\n",
    '/style.css',
    { kind: 'asset-path' }
  )

  const responseResolveContext = getPathContextAtOffset(
    "response.resolve('./board-service')\n",
    "response.resolve('./".length + 1,
    { mode: 'script' }
  )
  if (responseResolveContext) {
    throw new Error(`Expected response.resolve to be ignored as a path call. Got: ${JSON.stringify(responseResolveContext)}`)
  }

  const dataHxDocument = '<div data-hx-get="/boards"></div>\n'
  const dataHxContext = getPathContextAtOffset(dataHxDocument, dataHxDocument.indexOf('/boards'), { mode: 'ejs' })
  if (!dataHxContext || dataHxContext.kind !== 'route-path' || dataHxContext.routeSource !== 'hx-get') {
    throw new Error(`Expected data-hx-get to normalize to the hx-get route source. Got: ${JSON.stringify(dataHxContext)}`)
  }

  const formPostDocument = '<form method="post" action="/boards"></form>\n'
  const formPostContext = getPathContextAtOffset(formPostDocument, formPostDocument.indexOf('/boards'), { mode: 'ejs' })
  if (!formPostContext || formPostContext.routeSource !== 'action-post') {
    throw new Error(`Expected form method="post" action to resolve action-post. Got: ${JSON.stringify(formPostContext)}`)
  }
  const formDefaultDocument = '<form action="/boards"></form>\n'
  const formDefaultContext = getPathContextAtOffset(formDefaultDocument, formDefaultDocument.indexOf('/boards'), { mode: 'ejs' })
  if (!formDefaultContext || formDefaultContext.routeSource !== 'action-get') {
    throw new Error(`Expected form action without method to default to action-get. Got: ${JSON.stringify(formDefaultContext)}`)
  }
  const formDialogDocument = '<form method="dialog" action="/boards"></form>\n'
  const formDialogContext = getPathContextAtOffset(formDialogDocument, formDialogDocument.indexOf('/boards'), { mode: 'ejs' })
  if (formDialogContext) {
    throw new Error(`Expected form method="dialog" action to be ignored as a route. Got: ${JSON.stringify(formDialogContext)}`)
  }

  const collectDocument = `<script server>
response.redirect('/home')
api.resolve('./svc')
datastar.replaceURL('/replace')
</script>
`
  const collectedRouteSources = collectPathContexts(collectDocument, { mode: 'ejs' })
    .filter((context) => context.kind === 'route-path')
    .map((context) => context.routeSource)
    .sort()
  if (collectedRouteSources.join(',') !== ['redirect', 'replace-url'].sort().join(',')) {
    throw new Error(`Expected collectPathContexts to surface redirect and replace-url route sources. Got: ${JSON.stringify(collectedRouteSources)}`)
  }

  await runExtensionHostSanityCheck(repoRoot)
  const fixture = createFixtureApp(repoRoot)
  const realHighlightsFilePath = path.join(repoRoot, 'apps', 'booklog', 'pb_hooks', 'pages', '(site)', 'highlights.ejs')
  const realUploadFilePath = path.join(repoRoot, 'apps', 'booklog', 'pb_hooks', 'pages', 'xapi', 'epub', 'upload.ejs')
  const realWeeklySectionTableFilePath = path.join(repoRoot, 'apps', 'kjca', 'pb_hooks', 'pages', '_private', 'weekly-section-table.ejs')

  try {
    const manager = new PocketPagesLanguageServiceManager()
    const service = manager.getServiceForFile(fixture.boardsFilePath)
    const indexService = manager.getServiceForFile(fixture.siteIndexFilePath)
    const authService = manager.getServiceForFile(fixture.signOutFilePath)
    const secondaryService = manager.getServiceForFile(fixture.secondarySiteIndexFilePath)

    if (!service) {
      throw new Error(`PocketPages app root not found for ${fixture.boardsFilePath}`)
    }
    if (!indexService) {
      throw new Error(`PocketPages app root not found for ${fixture.siteIndexFilePath}`)
    }
    if (!authService) {
      throw new Error(`PocketPages app root not found for ${fixture.signOutFilePath}`)
    }
    if (!secondaryService) {
      throw new Error(`PocketPages app root not found for ${fixture.secondarySiteIndexFilePath}`)
    }
    if (secondaryService === service) {
      throw new Error('Expected PocketPages manager to isolate services per app root in a monorepo.')
    }

    const graphRaceDirPath = path.join(fixture.appRoot, 'pb_hooks', 'pages', 'vanishing-race')
    ensureDir(graphRaceDirPath)
    const graphRaceService = new PocketPagesLanguageServiceManager().getServiceForFile(fixture.boardsFilePath)
    const originalReaddirSync = fs.readdirSync
    fs.readdirSync = function patchedGraphRaceReaddirSync(dirPath, ...args) {
      if (normalizeFilePath(dirPath) === normalizeFilePath(graphRaceDirPath)) {
        const error = new Error('simulated ENOENT during pages scan')
        error.code = 'ENOENT'
        throw error
      }
      return originalReaddirSync.call(this, dirPath, ...args)
    }
    try {
      graphRaceService.projectIndex.invalidateStructureCaches()
      const graphRaceState = graphRaceService.projectIndex.getPagesGraphState()
      if (!graphRaceState || !Array.isArray(graphRaceState.allFiles)) {
        throw new Error(`Expected pages graph scan to recover from a disappearing child directory. Got: ${JSON.stringify(graphRaceState)}`)
      }
    } finally {
      fs.readdirSync = originalReaddirSync
      fs.rmSync(graphRaceDirPath, { recursive: true, force: true })
    }

    const metadataSchemaService = new PocketPagesLanguageServiceManager().getServiceForFile(fixture.boardsFilePath)
    const originalMetadataSchemaText = fs.readFileSync(fixture.schemaFilePath, 'utf8')
    const originalMetadataSchemaStats = fs.statSync(fixture.schemaFilePath)
    const metadataSchemaCollectionsBefore = metadataSchemaService.projectIndex.getCollectionNames()
    if (!metadataSchemaCollectionsBefore.includes('posts') || metadataSchemaCollectionsBefore.includes('notes')) {
      throw new Error(`Expected fixture schema cache probe to start with posts only. Got: ${metadataSchemaCollectionsBefore.join(', ')}`)
    }
    const modifiedMetadataSchema = JSON.parse(originalMetadataSchemaText)
    modifiedMetadataSchema[1] = {
      ...modifiedMetadataSchema[1],
      name: 'notes',
    }
    try {
      writeFile(fixture.schemaFilePath, JSON.stringify(modifiedMetadataSchema, null, 2))
      withPatchedStatSync(fixture.schemaFilePath, originalMetadataSchemaStats, () => {
        const metadataSchemaCollectionsAfter = metadataSchemaService.projectIndex.getCollectionNames()
        if (!metadataSchemaCollectionsAfter.includes('notes') || metadataSchemaCollectionsAfter.includes('posts')) {
          throw new Error(
            `Expected schema content hash to refresh collection names when metadata is unchanged. Got: ${metadataSchemaCollectionsAfter.join(', ')}`
          )
        }
      })
    } finally {
      writeFile(fixture.schemaFilePath, originalMetadataSchemaText)
    }

    const metadataTypesPath = path.join(fixture.appRoot, 'pb_data', 'types.d.ts')
    const metadataTypesMethodName = 'findRecordByMetadataHash'
    const metadataTypesService = new PocketPagesLanguageServiceManager().getServiceForFile(fixture.boardsFilePath)
    const originalMetadataTypesText = fs.readFileSync(metadataTypesPath, 'utf8')
    const originalMetadataTypesStats = fs.statSync(metadataTypesPath)
    const metadataTypesMethodNamesBefore = metadataTypesService.projectIndex.getCollectionMethodNames()
    if (metadataTypesMethodNamesBefore.includes(metadataTypesMethodName)) {
      throw new Error(`Expected fixture pb_data types to start without ${metadataTypesMethodName}.`)
    }
    const modifiedMetadataTypesText = originalMetadataTypesText.replace(
      '    isCollectionNameUnique(name: string): boolean',
      `    isCollectionNameUnique(name: string): boolean
    ${metadataTypesMethodName}(collectionModelOrIdentifier: any, value: string): core.Record`
    )
    if (modifiedMetadataTypesText === originalMetadataTypesText) {
      throw new Error('Expected fixture pb_data types to contain the metadata-hash insertion anchor.')
    }
    try {
      writeFile(metadataTypesPath, modifiedMetadataTypesText)
      withPatchedStatSync(metadataTypesPath, originalMetadataTypesStats, () => {
        const metadataTypesMethodNamesAfter = metadataTypesService.projectIndex.getCollectionMethodNames()
        if (!metadataTypesMethodNamesAfter.includes(metadataTypesMethodName)) {
          throw new Error(
            `Expected pb_data types content hash to refresh collection methods when metadata is unchanged. Got: ${metadataTypesMethodNamesAfter.join(', ')}`
          )
        }
      })
    } finally {
      writeFile(metadataTypesPath, originalMetadataTypesText)
    }

    let idleServiceNow = 1000
    const idleServiceManager = new PocketPagesLanguageServiceManager({
      idleServiceTtlMs: 50,
      now: () => idleServiceNow,
    })
    const idleService = idleServiceManager.getServiceForFile(fixture.boardsFilePath)
    if (!idleService) {
      throw new Error('Expected idle service manager fixture service to be created.')
    }
    idleServiceManager.registerOpenDocument(fixture.boardsFilePath)
    idleServiceNow += 1000
    if (idleServiceManager.pruneIdleServices().length || !idleServiceManager.services.has(idleService.appRoot)) {
      throw new Error('Expected idle service pruning to keep app services with open documents.')
    }
    idleServiceManager.unregisterOpenDocument(fixture.boardsFilePath)
    idleServiceNow += 49
    if (idleServiceManager.pruneIdleServices().length || !idleServiceManager.services.has(idleService.appRoot)) {
      throw new Error('Expected idle service pruning to respect the configured idle TTL.')
    }
    idleServiceNow += 1
    const evictedIdleServices = idleServiceManager.pruneIdleServices()
    if (evictedIdleServices.length !== 1 || idleServiceManager.services.has(idleService.appRoot)) {
      throw new Error(`Expected idle service pruning to evict closed app services after the TTL. Got: ${JSON.stringify({
        evicted: evictedIdleServices.map((entry) => entry.appRoot),
        services: [...idleServiceManager.services.keys()],
      })}`)
    }

    const laneDiagnosticsText = `<script server>
const laneValue = missingLaneValue
redirect('/boards')
</script>
<div><%= laneValue %></div>
`
    const laneCalls = []
    const originalLaneCollectServerBlockDiagnostics = service.collectServerBlockDiagnostics.bind(service)
    const originalLaneCollectTemplateDiagnostics = service.collectTemplateDiagnostics.bind(service)
    const originalLaneCollectScriptSchemaDiagnostics = service.collectScriptSchemaDiagnostics.bind(service)
    const originalLaneCollectProjectRuleDiagnostics = service.collectProjectRuleDiagnostics.bind(service)
    service.collectServerBlockDiagnostics = function collectServerLaneProbe(
      _filePath,
      _documentText,
      _blocks,
      _collectionMethodNames,
      _documentAnalysis,
      options = {}
    ) {
      laneCalls.push({
        step: 'server',
        semantic: options.includeSemanticDiagnostics !== false,
        ts: options.includeTypeScriptDiagnostics !== false,
      })
      return []
    }
    service.collectTemplateDiagnostics = function collectTemplateLaneProbe(
      _filePath,
      _documentText,
      _blocks,
      _templateBlocks,
      _collectionMethodNames,
      _documentAnalysis,
      options = {}
    ) {
      laneCalls.push({
        step: 'template',
        semantic: options.includeSemanticDiagnostics !== false,
        ts: options.includeTypeScriptDiagnostics !== false,
      })
      return []
    }
    service.collectScriptSchemaDiagnostics = function collectScriptSchemaLaneProbe() {
      laneCalls.push({ step: 'script-schema' })
      return []
    }
    service.collectProjectRuleDiagnostics = function collectProjectLaneProbe() {
      laneCalls.push({ step: 'project' })
      return []
    }
    try {
      service.getDiagnostics(fixture.boardsFilePath, laneDiagnosticsText, {
        includeSemanticDiagnostics: false,
        includeProjectRuleDiagnostics: false,
        includeTypeScriptDiagnostics: false,
        includeServerBlockDiagnostics: false,
        includeTemplateDiagnostics: false,
        includeScriptSchemaDiagnostics: false,
      })
      if (laneCalls.length !== 0) {
        throw new Error(`Expected cheap fast diagnostics lane to skip server/template/schema/project work. Got: ${JSON.stringify(laneCalls)}`)
      }
      laneCalls.length = 0
      service.getDiagnostics(fixture.boardsFilePath, laneDiagnosticsText, {
        includeSemanticDiagnostics: true,
        includeProjectRuleDiagnostics: false,
        includeTypeScriptDiagnostics: true,
      })
      if (
        laneCalls.some((entry) => entry.step === 'project') ||
        !laneCalls.some((entry) => entry.step === 'server' && entry.semantic === true && entry.ts === true) ||
        !laneCalls.some((entry) => entry.step === 'template' && entry.semantic === true && entry.ts === true) ||
        !laneCalls.some((entry) => entry.step === 'script-schema')
      ) {
        throw new Error(`Expected semantic diagnostics lane to include TS diagnostics and skip project rules. Got: ${JSON.stringify(laneCalls)}`)
      }
      laneCalls.length = 0
      const cancellationProfile = {}
      const cancelledDiagnostics = service.getDiagnostics(fixture.boardsFilePath, laneDiagnosticsText, {
        profile: cancellationProfile,
        shouldCancel(stage) {
          return stage === 'after-server-block-diagnostics'
        },
      })
      if (!cancellationProfile.cancelled || cancellationProfile.cancelledAt !== 'after-server-block-diagnostics') {
        throw new Error(`Expected diagnostics cancellation to mark the cancellation stage. Got: ${JSON.stringify(cancellationProfile)}`)
      }
      if (cancelledDiagnostics.length !== 0 || laneCalls.some((entry) => entry.step === 'project')) {
        throw new Error(`Expected cancelled diagnostics to stop before project-rule diagnostics. Got: ${JSON.stringify({ cancelledDiagnostics, laneCalls })}`)
      }
    } finally {
      service.collectServerBlockDiagnostics = originalLaneCollectServerBlockDiagnostics
      service.collectTemplateDiagnostics = originalLaneCollectTemplateDiagnostics
      service.collectScriptSchemaDiagnostics = originalLaneCollectScriptSchemaDiagnostics
      service.collectProjectRuleDiagnostics = originalLaneCollectProjectRuleDiagnostics
    }

    const tsCancellationRequested = service.runWithCancellationProbe(
      () => true,
      () => service.isTypeScriptCancellationRequested()
    )
    if (!tsCancellationRequested) {
      throw new Error('Expected TypeScript cancellation token to observe active cancellation.')
    }
    if (service.isTypeScriptCancellationRequested()) {
      throw new Error('Expected TypeScript cancellation state to reset after the active operation.')
    }
    let cancellationPollCount = 0
    const throttledCancellationChecks = service.runWithCancellationProbe(
      () => {
        cancellationPollCount += 1
        return false
      },
      () => [
        service.isTypeScriptCancellationRequested(),
        service.isTypeScriptCancellationRequested(),
      ]
    )
    if (
      throttledCancellationChecks[0] !== false ||
      throttledCancellationChecks[1] !== false ||
      cancellationPollCount !== 1
    ) {
      throw new Error(
        `Expected TypeScript cancellation polling to throttle false checks without leaking state. Got: ${JSON.stringify({
          throttledCancellationChecks,
          cancellationPollCount,
        })}`
      )
    }

    let workspaceSymbolCancellationChecks = 0
    const cancelledWorkspaceSymbols = service.getWorkspaceSymbolEntries('', {
      shouldCancel() {
        workspaceSymbolCancellationChecks += 1
        return true
      },
    })
    if (cancelledWorkspaceSymbols.length !== 0 || workspaceSymbolCancellationChecks < 1) {
      throw new Error(
        `Expected workspace symbols to honor cancellation before scanning. Got: ${JSON.stringify({
          cancelledWorkspaceSymbols,
          workspaceSymbolCancellationChecks,
        })}`
      )
    }

    const originalReferenceVirtualStateAtOffset = service.getVirtualStateAtOffset.bind(service)
    const originalFindReferences = service.languageService.findReferences.bind(service.languageService)
    let referenceCancellationChecks = 0
    let sawReferenceCancellationProbe = false
    service.getVirtualStateAtOffset = function getReferenceCancellationVirtualState() {
      return {
        filePath: fixture.boardsFilePath,
        virtual: { fileName: fixture.boardsFilePath },
        virtualOffset: 0,
      }
    }
    service.languageService.findReferences = function findReferencesCancellationProbe() {
      sawReferenceCancellationProbe = service.isTypeScriptCancellationRequested()
      return []
    }
    try {
      const cancelledReferences = service.getTypeScriptReferenceTargets(
        fixture.boardsFilePath,
        laneDiagnosticsText,
        0,
        {
          shouldCancel() {
            referenceCancellationChecks += 1
            return referenceCancellationChecks > 2
          },
        }
      )
      if (cancelledReferences !== null || !sawReferenceCancellationProbe) {
        throw new Error(
          `Expected TypeScript references to run under the cancellation probe. Got: ${JSON.stringify({
            cancelledReferences,
            referenceCancellationChecks,
            sawReferenceCancellationProbe,
          })}`
        )
      }
    } finally {
      service.getVirtualStateAtOffset = originalReferenceVirtualStateAtOffset
      service.languageService.findReferences = originalFindReferences
    }

    const warmupResult = service.warmupDocument(fixture.boardsFilePath, laneDiagnosticsText)
    if (!warmupResult || !warmupResult.warmed || !service.virtualFiles.has(warmupResult.fileName)) {
      throw new Error(`Expected warmupDocument to prepare a TypeScript virtual file. Got: ${JSON.stringify(warmupResult)}`)
    }

    const syncSkipCore = new PocketPagesLanguageCore()
    const syncSkipDocument = createTestDocument(fixture.boardsFilePath, 'ejs', 1, laneDiagnosticsText)
    syncSkipCore.openDocument({
      uri: syncSkipDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: laneDiagnosticsText,
    })
    const syncSkipContext = syncSkipCore.getDocumentContextByUri(syncSkipDocument.uri)
    const syncSkipService = syncSkipContext && syncSkipContext.service
    if (!syncSkipService) {
      throw new Error('Expected sync-skip smoke context to expose a language service.')
    }
    const originalSyncSkipGetDocumentTextForFile = syncSkipCore.getDocumentTextForFile.bind(syncSkipCore)
    syncSkipCore.getDocumentTextForFile = function unexpectedContextFallback() {
      throw new Error('Expected getDocumentContextByUri() to read opened document snapshots without file-path fallback.')
    }
    try {
      const directSnapshotContext = syncSkipCore.getDocumentContextByUri(syncSkipDocument.uri)
      if (!directSnapshotContext || directSnapshotContext.documentText !== laneDiagnosticsText) {
        throw new Error('Expected getDocumentContextByUri() to return the opened sourceScript snapshot text.')
      }
    } finally {
      syncSkipCore.getDocumentTextForFile = originalSyncSkipGetDocumentTextForFile
    }
    let preparedSyncCount = 0
    const originalSyncPreparedDocumentVirtualCode = syncSkipService.syncPreparedDocumentVirtualCode.bind(syncSkipService)
    syncSkipService.syncPreparedDocumentVirtualCode = function patchedSyncPreparedDocumentVirtualCode(...args) {
      preparedSyncCount += 1
      return originalSyncPreparedDocumentVirtualCode(...args)
    }
    try {
      const syncSkipSourceScriptBefore = syncSkipCore.getSourceScript(syncSkipDocument.uri)
      const syncSkipGeneratedBefore =
        syncSkipSourceScriptBefore &&
        syncSkipSourceScriptBefore.generated &&
        syncSkipSourceScriptBefore.generated.root
      const syncSkipGeneratedTextBefore = syncSkipGeneratedBefore ? syncSkipGeneratedBefore.getText() : ''
      syncSkipCore.updateDocument({
        uri: syncSkipDocument.uri,
        languageId: 'ejs',
        version: 2,
        text: `${laneDiagnosticsText}\n<div>changed</div>\n`,
      }, {
        prepareVirtualCode: false,
      })
      if (preparedSyncCount !== 0 || syncSkipService.preparedDocumentStates.has(normalizeFilePath(fixture.boardsFilePath))) {
        throw new Error(`Expected updateDocument(..., prepareVirtualCode:false) to skip prepared virtual-code sync. count=${preparedSyncCount}`)
      }
      const syncSkipSourceScriptAfter = syncSkipCore.getSourceScript(syncSkipDocument.uri)
      const syncSkipGeneratedAfter =
        syncSkipSourceScriptAfter &&
        syncSkipSourceScriptAfter.generated &&
        syncSkipSourceScriptAfter.generated.root
      if (
        syncSkipGeneratedAfter !== syncSkipGeneratedBefore ||
        syncSkipGeneratedAfter.getText() !== syncSkipGeneratedTextBefore ||
        syncSkipSourceScriptAfter.generatedStale !== true
      ) {
        throw new Error(
          `Expected updateDocument(..., prepareVirtualCode:false) to defer generated virtual-code rebuild. Got: ${JSON.stringify({
            sameRoot: syncSkipGeneratedAfter === syncSkipGeneratedBefore,
            beforeLength: syncSkipGeneratedTextBefore.length,
            afterLength: syncSkipGeneratedAfter && syncSkipGeneratedAfter.getText().length,
            generatedStale: syncSkipSourceScriptAfter && syncSkipSourceScriptAfter.generatedStale,
          })}`
        )
      }
      const syncSkipSnapshot = syncSkipService.getDocumentSnapshot(fixture.boardsFilePath)
      if (
        !syncSkipSnapshot ||
        syncSkipSnapshot.text !== `${laneDiagnosticsText}\n<div>changed</div>\n` ||
        syncSkipSnapshot.lspVersion !== 2
      ) {
        throw new Error(
          `Expected updateDocument(..., prepareVirtualCode:false) to keep the service document snapshot current. Got: ${JSON.stringify(syncSkipSnapshot && {
            snapshotId: syncSkipSnapshot.snapshotId,
            lspVersion: syncSkipSnapshot.lspVersion,
            textLength: syncSkipSnapshot.textLength,
          })}`
        )
      }
      const missingPreparedProfile = {}
      const missingPreparedState = syncSkipService.getVirtualStateAtOffset(
        fixture.boardsFilePath,
        `${laneDiagnosticsText}\n<div>changed</div>\n`,
        laneDiagnosticsText.indexOf('laneValue =') + 2,
        {
          profile: missingPreparedProfile,
          requirePreparedVirtualState: true,
        }
      )
      if (missingPreparedState !== null || missingPreparedProfile.upsertKind !== 'missing-prepared') {
        throw new Error(
          `Expected prepared-only synthetic requests to avoid fallback virtual upserts before warmup. Got: ${JSON.stringify({ missingPreparedState, missingPreparedProfile })}`
        )
      }
      const missingPreparedReferences = syncSkipService.getTypeScriptReferenceTargets(
        fixture.boardsFilePath,
        `${laneDiagnosticsText}\n<div>changed</div>\n`,
        laneDiagnosticsText.indexOf('laneValue =') + 2,
        {
          includeDeclaration: true,
          requirePreparedVirtualState: true,
        }
      )
      if (missingPreparedReferences !== null) {
        throw new Error(
          `Expected prepared-only TypeScript references to avoid fallback virtual upserts before warmup. Got: ${JSON.stringify(missingPreparedReferences)}`
        )
      }
      syncSkipCore.prepareDocument(syncSkipDocument.uri)
      if (preparedSyncCount !== 1 || !syncSkipService.preparedDocumentStates.has(normalizeFilePath(fixture.boardsFilePath))) {
        throw new Error(`Expected prepareDocument() to restore prepared virtual-code sync on demand. count=${preparedSyncCount}`)
      }
      const syncSkipSourceScriptPrepared = syncSkipCore.getSourceScript(syncSkipDocument.uri)
      const syncSkipGeneratedPrepared =
        syncSkipSourceScriptPrepared &&
        syncSkipSourceScriptPrepared.generated &&
        syncSkipSourceScriptPrepared.generated.root
      if (
        !syncSkipGeneratedPrepared ||
        !syncSkipGeneratedPrepared.getText().includes('<div>changed</div>') ||
        syncSkipSourceScriptPrepared.generatedStale === true
      ) {
        throw new Error(
          `Expected prepareDocument() to rebuild stale generated virtual-code on demand. Got: ${JSON.stringify({
            generatedTextLength: syncSkipGeneratedPrepared && syncSkipGeneratedPrepared.getText().length,
            generatedStale: syncSkipSourceScriptPrepared && syncSkipSourceScriptPrepared.generatedStale,
          })}`
        )
      }
      const preparedOnlyProfile = {}
      const preparedOnlyState = syncSkipService.getVirtualStateAtOffset(
        fixture.boardsFilePath,
        `${laneDiagnosticsText}\n<div>changed</div>\n`,
        laneDiagnosticsText.indexOf('laneValue =') + 2,
        {
          profile: preparedOnlyProfile,
          requirePreparedVirtualState: true,
        }
      )
      if (!preparedOnlyState || preparedOnlyProfile.upsertKind !== 'server-block-prepared' || preparedOnlyProfile.upsertMs !== 0) {
        throw new Error(
          `Expected prepared-only synthetic requests to reuse prepared virtual state after warmup. Got: ${JSON.stringify({ preparedOnlyState, preparedOnlyProfile })}`
        )
      }
      const preparedReferences = syncSkipService.getTypeScriptReferenceTargets(
        fixture.boardsFilePath,
        `${laneDiagnosticsText}\n<div>changed</div>\n`,
        laneDiagnosticsText.indexOf('laneValue =') + 2,
        {
          includeDeclaration: true,
          requirePreparedVirtualState: true,
        }
      )
      if (!preparedReferences || !Array.isArray(preparedReferences.locations)) {
        throw new Error(
          `Expected prepared-only TypeScript references to use prepared virtual state after warmup. Got: ${JSON.stringify(preparedReferences)}`
        )
      }
    } finally {
      syncSkipService.syncPreparedDocumentVirtualCode = originalSyncPreparedDocumentVirtualCode
    }

    const reloadStaleCore = new PocketPagesLanguageCore()
    const reloadStaleUri = URI.file(fixture.boardsFilePath).toString()
    const reloadStaleTextBefore = laneDiagnosticsText
    const reloadStaleTextAfter = `${laneDiagnosticsText}\n<div>reload stale marker</div>\n`
    reloadStaleCore.openDocument({
      uri: reloadStaleUri,
      languageId: 'ejs',
      version: 1,
      text: reloadStaleTextBefore,
    })
    const reloadStaleContext = reloadStaleCore.getDocumentContextByUri(reloadStaleUri)
    const reloadStaleService = reloadStaleContext && reloadStaleContext.service
    if (!reloadStaleService) {
      throw new Error('Expected reload-stale smoke context to expose a language service.')
    }
    const reloadStaleSourceScriptBefore = reloadStaleCore.getSourceScript(reloadStaleUri)
    const reloadStaleGeneratedBefore =
      reloadStaleSourceScriptBefore &&
      reloadStaleSourceScriptBefore.generated &&
      reloadStaleSourceScriptBefore.generated.root
    reloadStaleCore.updateDocument({
      uri: reloadStaleUri,
      languageId: 'ejs',
      version: 2,
      text: reloadStaleTextAfter,
    }, {
      prepareVirtualCode: false,
    })
    const reloadStaleSourceScriptChanged = reloadStaleCore.getSourceScript(reloadStaleUri)
    if (
      !reloadStaleSourceScriptChanged ||
      reloadStaleSourceScriptChanged.generatedStale !== true ||
      !reloadStaleSourceScriptChanged.generated ||
      reloadStaleSourceScriptChanged.generated.root !== reloadStaleGeneratedBefore
    ) {
      throw new Error(
        `Expected reload-stale setup to keep stale generated virtual code before reload. Got: ${JSON.stringify({
          generatedStale: reloadStaleSourceScriptChanged && reloadStaleSourceScriptChanged.generatedStale,
          sameRoot:
            reloadStaleSourceScriptChanged &&
            reloadStaleSourceScriptChanged.generated &&
            reloadStaleSourceScriptChanged.generated.root === reloadStaleGeneratedBefore,
        })}`
      )
    }
    const reloadStaleResult = reloadStaleCore.reloadCachesForAppRoot(fixture.appRoot)
    const reloadStaleSnapshot = reloadStaleService.getDocumentSnapshot(fixture.boardsFilePath)
    const reloadStaleSourceScriptReloaded = reloadStaleCore.getSourceScript(reloadStaleUri)
    const reloadStaleGeneratedReloaded =
      reloadStaleSourceScriptReloaded &&
      reloadStaleSourceScriptReloaded.generated &&
      reloadStaleSourceScriptReloaded.generated.root
    if (!reloadStaleResult.affectedUris.includes(reloadStaleUri)) {
      throw new Error(`Expected cache reload to resync the changed open document. Got: ${JSON.stringify(reloadStaleResult)}`)
    }
    if (
      !reloadStaleSnapshot ||
      reloadStaleSnapshot.text !== reloadStaleTextAfter ||
      reloadStaleSnapshot.lspVersion !== 2
    ) {
      throw new Error(
        `Expected cache reload resync to preserve the current source snapshot text. Got: ${JSON.stringify(reloadStaleSnapshot && {
          lspVersion: reloadStaleSnapshot.lspVersion,
          text: reloadStaleSnapshot.text,
        })}`
      )
    }
    if (
      !reloadStaleGeneratedReloaded ||
      !reloadStaleGeneratedReloaded.getText().includes('reload stale marker') ||
      reloadStaleSourceScriptReloaded.generatedStale === true
    ) {
      throw new Error(
        `Expected cache reload resync to rebuild stale generated virtual code from the current source snapshot. Got: ${JSON.stringify({
          generatedTextLength: reloadStaleGeneratedReloaded && reloadStaleGeneratedReloaded.getText().length,
          generatedStale: reloadStaleSourceScriptReloaded && reloadStaleSourceScriptReloaded.generatedStale,
        })}`
      )
    }

    if (fs.existsSync(realHighlightsFilePath)) {
      const realHighlightsService = manager.getServiceForFile(realHighlightsFilePath)
      if (!realHighlightsService) {
        throw new Error(`Expected real app service for ${realHighlightsFilePath}`)
      }

      const realHighlightsText = fs.readFileSync(realHighlightsFilePath, 'utf8')
      const realHighlightsBoundaries = getServerTemplateBoundaryLineNumbers(realHighlightsText)
      if (!realHighlightsBoundaries.length) {
        throw new Error('Expected real highlights.ejs to expose a server/template boundary marker.')
      }

      const metaOffset = realHighlightsText.indexOf('meta') + 1
      const realHighlightQuickInfo = realHighlightsService.getQuickInfo(realHighlightsFilePath, realHighlightsText, metaOffset)
      if (!realHighlightQuickInfo || !realHighlightQuickInfo.displayText.includes('meta')) {
        throw new Error(`Expected real highlights.ejs hover info for meta(). Got: ${JSON.stringify(realHighlightQuickInfo)}`)
      }
    }

    if (fs.existsSync(realUploadFilePath)) {
      const realUploadService = manager.getServiceForFile(realUploadFilePath)
      if (!realUploadService) {
        throw new Error(`Expected real app service for ${realUploadFilePath}`)
      }

      const realUploadText = fs.readFileSync(realUploadFilePath, 'utf8')
      const realUploadLinks = realUploadService.getDocumentLinks(realUploadFilePath, realUploadText)
      const resolveLink = realUploadLinks.find((entry) => entry.kind === 'resolve-path' && entry.value === 'data4library-service')
      if (!resolveLink || !resolveLink.targetFilePath) {
        throw new Error(`Expected real upload.ejs resolve() document link for data4library-service. Got: ${JSON.stringify(realUploadLinks.slice(0, 5))}`)
      }
    }

    if (fs.existsSync(realWeeklySectionTableFilePath)) {
      const realWeeklyService = manager.getServiceForFile(realWeeklySectionTableFilePath)
      if (!realWeeklyService) {
        throw new Error(`Expected real app service for ${realWeeklySectionTableFilePath}`)
      }

      const realWeeklyText = fs.readFileSync(realWeeklySectionTableFilePath, 'utf8')
      const realWeeklyReferenceQuery = realWeeklyService.getFileReferenceQuery(realWeeklySectionTableFilePath)
      const realWeeklyReferences = realWeeklyService.getFileReferenceTargets(realWeeklySectionTableFilePath, realWeeklyText, {
        includeDeclaration: false,
      }) || []
      if (!realWeeklyReferenceQuery || realWeeklyReferenceQuery.kind !== 'private-partial') {
        throw new Error(`Expected real weekly-section-table.ejs private-partial reference query. Got: ${JSON.stringify(realWeeklyReferenceQuery)}`)
      }
      if (realWeeklyReferences.length < 3) {
        throw new Error(`Expected real weekly-section-table.ejs to keep caller references from dashboard-shell.ejs. Got: ${JSON.stringify(realWeeklyReferences)}`)
      }
    }

    const core = new PocketPagesLanguageCore()
    const coreBoardsText = fs.readFileSync(fixture.boardsFilePath, 'utf8')
    const coreBoardsUri = URI.file(fixture.boardsFilePath).toString()
    core.openDocument({
      uri: coreBoardsUri,
      languageId: 'ejs',
      version: 1,
      text: coreBoardsText,
    })

    const coreProbe = core.probeFile(fixture.boardsFilePath)
    if (!coreProbe.hasAppRoot) {
      throw new Error(`Expected language-core probe to resolve an app root. Got: ${JSON.stringify(coreProbe)}`)
    }

    const coreReferenceResult = core.getFileReferenceResult(fixture.flashAlertFilePath)
    if (!coreReferenceResult || !coreReferenceResult.referenceQuery || !Array.isArray(coreReferenceResult.references)) {
      throw new Error(`Expected language-core file references for _private partials. Got: ${JSON.stringify(coreReferenceResult)}`)
    }

    if (coreReferenceResult.referenceQuery.kind !== 'private-partial') {
      throw new Error(`Expected language-core partial reference query kind. Got: ${JSON.stringify(coreReferenceResult.referenceQuery)}`)
    }

    const coreReloadResult = core.reloadCaches(fixture.boardsFilePath)
    if (!coreReloadResult || !/reloaded/i.test(coreReloadResult.message)) {
      throw new Error(`Expected language-core cache reload result. Got: ${JSON.stringify(coreReloadResult)}`)
    }

    const boardShowText = fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    const boardShowUri = URI.file(fixture.boardShowFilePath).toString()
    const virtualCode = createVirtualCode(boardShowUri, 'ejs', 1, boardShowText)
    if (!Array.isArray(virtualCode.embeddedCodes) || !virtualCode.embeddedCodes.some((entry) => entry.kind === 'server-script')) {
      throw new Error(`Expected virtual code to expose embedded server-script regions. Got: ${JSON.stringify(virtualCode.embeddedCodes)}`)
    }
    if (!virtualCode.embeddedCodes.some((entry) => entry.kind === 'template')) {
      throw new Error(`Expected virtual code to expose template embedded code.`)
    }

    const updatedVirtualCode = updateVirtualCode(
      virtualCode,
      2,
      boardShowText.replace("board.get('name')", "board.get('slug')"),
      'ejs'
    )
    const serverEmbeddedCode = updatedVirtualCode.embeddedCodes.find((entry) => entry.kind === 'server-script')
    const templateEmbeddedCode = updatedVirtualCode.embeddedCodes.find((entry) => entry.kind === 'template')
    if (!serverEmbeddedCode || !templateEmbeddedCode) {
      throw new Error(`Expected updated virtual code to keep server/template embedded code entries.`)
    }
    if (typeof serverEmbeddedCode.snapshot.getChangeRange !== 'function') {
      throw new Error(`Expected embedded virtual code snapshot to implement getChangeRange().`)
    }
    const stableIdentityText = `<script server>
const firstValue = 1
</script>
<script server>
const secondValue = 2
</script>
`
    const stableIdentityCode = createVirtualCode(boardShowUri, 'ejs', 1, stableIdentityText)
    const stableSecondCode = stableIdentityCode.embeddedCodes.find(
      (entry) => entry.kind === 'server-script' && entry.snapshot.getText(0, entry.snapshot.getLength()).includes('secondValue')
    )
    const shiftedStableIdentityCode = updateVirtualCode(
      stableIdentityCode,
      2,
      `<script server>
const insertedValue = 0
</script>
${stableIdentityText}`,
      'ejs'
    )
    const shiftedSecondCode = shiftedStableIdentityCode.embeddedCodes.find(
      (entry) => entry.kind === 'server-script' && entry.snapshot.getText(0, entry.snapshot.getLength()).includes('secondValue')
    )
    if (!stableSecondCode || !shiftedSecondCode || stableSecondCode.id !== shiftedSecondCode.id) {
      throw new Error(
        `Expected server embedded code identity to survive block index shifts. before=${stableSecondCode && stableSecondCode.id} after=${shiftedSecondCode && shiftedSecondCode.id}`
      )
    }
    const shiftedRegionGraph = shiftedStableIdentityCode.getRegionGraph()
    const shiftedSecondRegion = shiftedRegionGraph.regions.find((entry) => entry.id === shiftedSecondCode.id)
    if (!shiftedSecondRegion || shiftedSecondRegion.dirty !== false) {
      throw new Error(`Expected unchanged shifted server region to be marked clean. Got: ${JSON.stringify(shiftedSecondRegion)}`)
    }
    const shiftedSecondChangeRange = shiftedSecondCode.snapshot.getChangeRange(stableSecondCode.snapshot)
    if (!shiftedSecondChangeRange || shiftedSecondChangeRange.span.length !== 0 || shiftedSecondChangeRange.newLength !== 0) {
      throw new Error(
        `Expected stable server embedded snapshot to report a no-op change for unchanged shifted block. Got: ${JSON.stringify(shiftedSecondChangeRange)}`
      )
    }
    const editableStableIdentityCode = createVirtualCode(boardShowUri, 'ejs', 3, stableIdentityText)
    const editableStableSecondCode = editableStableIdentityCode.embeddedCodes.find(
      (entry) => entry.kind === 'server-script' && entry.snapshot.getText(0, entry.snapshot.getLength()).includes('secondValue')
    )
    const editedStableIdentityCode = updateVirtualCode(
      editableStableIdentityCode,
      3,
      stableIdentityText.replace('const secondValue = 2', 'const secondValue = 3'),
      'ejs'
    )
    const editedSecondCode = editedStableIdentityCode.embeddedCodes.find(
      (entry) => entry.kind === 'server-script' && entry.snapshot.getText(0, entry.snapshot.getLength()).includes('secondValue')
    )
    if (!editableStableSecondCode || !editedSecondCode || editedSecondCode.id !== editableStableSecondCode.id) {
      throw new Error(
        `Expected edited server block to preserve its stable embedded code identity. before=${editableStableSecondCode && editableStableSecondCode.id} after=${editedSecondCode && editedSecondCode.id}`
      )
    }
    const editedSecondRegion = editedStableIdentityCode.getRegionGraph().regions.find((entry) => entry.id === editedSecondCode.id)
    if (!editedSecondRegion || editedSecondRegion.dirty !== true) {
      throw new Error(`Expected edited server region to be marked dirty. Got: ${JSON.stringify(editedSecondRegion)}`)
    }
    const stableTemplateRegionText = `<%= firstValue %>
<%= secondValue %>
`
    const stableTemplateRegionCode = createVirtualCode(boardShowUri, 'ejs', 1, stableTemplateRegionText)
    const shiftedTemplateRegionText = `<%= insertedValue %>
${stableTemplateRegionText}`
    const shiftedTemplateRegionCode = updateVirtualCode(
      stableTemplateRegionCode,
      2,
      shiftedTemplateRegionText,
      'ejs'
    )
    const shiftedTemplateSecondOffset = shiftedTemplateRegionText.indexOf('secondValue')
    const shiftedTemplateSecondRegion = shiftedTemplateRegionCode.getRegionGraph().regions.find(
      (entry) =>
        entry.kind === 'template-block' &&
        entry.sourceStart <= shiftedTemplateSecondOffset &&
        entry.sourceEnd >= shiftedTemplateSecondOffset
    )
    if (!shiftedTemplateSecondRegion || shiftedTemplateSecondRegion.dirty !== false) {
      throw new Error(`Expected unchanged shifted template block region to be marked clean. Got: ${JSON.stringify(shiftedTemplateSecondRegion)}`)
    }
    const unchangedRegionSkipCore = new PocketPagesLanguageCore()
    unchangedRegionSkipCore.openDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 1,
      text: stableIdentityText,
    })
    const unchangedRegionSkipContext = unchangedRegionSkipCore.getDocumentContextByUri(boardShowUri)
    const unchangedRegionSkipService = unchangedRegionSkipContext && unchangedRegionSkipContext.service
    if (!unchangedRegionSkipService) {
      throw new Error('Expected unchanged-region skip test to expose a language service.')
    }
    const originalRegionSkipBuildPrelude = unchangedRegionSkipService.buildPrelude.bind(unchangedRegionSkipService)
    const regionSkipPreludeInputs = []
    unchangedRegionSkipService.buildPrelude = function patchedRegionSkipBuildPrelude(filePath, analysisText, options) {
      regionSkipPreludeInputs.push(String(analysisText || ''))
      return originalRegionSkipBuildPrelude(filePath, analysisText, options)
    }
    try {
      unchangedRegionSkipCore.updateDocument({
        uri: boardShowUri,
        languageId: 'ejs',
        version: 2,
        text: `<script server>
const insertedValue = 0
</script>
${stableIdentityText}`,
      })
    } finally {
      unchangedRegionSkipService.buildPrelude = originalRegionSkipBuildPrelude
    }
    if (regionSkipPreludeInputs.some((entry) => entry.trim() === 'const secondValue = 2')) {
      throw new Error(`Expected unchanged server region prepare to skip buildPrelude(). Got inputs: ${JSON.stringify(regionSkipPreludeInputs)}`)
    }
    const offsetScopedCore = new PocketPagesLanguageCore()
    offsetScopedCore.openDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 1,
      text: stableIdentityText,
    }, {
      prepareVirtualCode: false,
    })
    const offsetScopedContext = offsetScopedCore.getDocumentContextByUri(boardShowUri)
    const offsetScopedService = offsetScopedContext && offsetScopedContext.service
    if (!offsetScopedService) {
      throw new Error('Expected offset-scoped prepare test to expose a language service.')
    }
    const originalOffsetScopedUpsertVirtualFile = offsetScopedService.upsertVirtualFile.bind(offsetScopedService)
    const offsetScopedServerInputs = []
    offsetScopedService.upsertVirtualFile = function patchedOffsetScopedUpsertVirtualFile(filePath, block, options) {
      offsetScopedServerInputs.push(String(block && block.content || '').trim())
      return originalOffsetScopedUpsertVirtualFile(filePath, block, options)
    }
    try {
      offsetScopedCore.prepareDocument(boardShowUri, {
        operation: 'completion',
        preferredOffset: stableIdentityText.indexOf('secondValue') + 1,
        skipUnrelatedRegions: true,
        skipStaticRefresh: true,
      })
    } finally {
      offsetScopedService.upsertVirtualFile = originalOffsetScopedUpsertVirtualFile
    }
    if (
      offsetScopedServerInputs.length !== 1 ||
      offsetScopedServerInputs[0] !== 'const secondValue = 2'
    ) {
      throw new Error(`Expected offset-scoped prepare to upsert only the requested server region. Got: ${JSON.stringify(offsetScopedServerInputs)}`)
    }
    const templatePreludeCacheCore = new PocketPagesLanguageCore()
    const templatePreludeCacheText = `<main>
<%= firstValue %>
</main>
`
    templatePreludeCacheCore.openDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 1,
      text: templatePreludeCacheText,
    })
    const templatePreludeCacheContext = templatePreludeCacheCore.getDocumentContextByUri(boardShowUri)
    const templatePreludeCacheService = templatePreludeCacheContext && templatePreludeCacheContext.service
    if (!templatePreludeCacheService) {
      throw new Error('Expected template prelude cache test to expose a language service.')
    }
    const originalTemplatePreludeBuildPrelude = templatePreludeCacheService.buildPrelude.bind(templatePreludeCacheService)
    const templatePreludeInputs = []
    templatePreludeCacheService.buildPrelude = function patchedTemplatePreludeBuildPrelude(filePath, analysisText, options) {
      templatePreludeInputs.push(String(analysisText || ''))
      return originalTemplatePreludeBuildPrelude(filePath, analysisText, options)
    }
    try {
      templatePreludeCacheCore.updateDocument({
        uri: boardShowUri,
        languageId: 'ejs',
        version: 2,
        text: `<section>plain html moved</section>
${templatePreludeCacheText}`,
      })
    } finally {
      templatePreludeCacheService.buildPrelude = originalTemplatePreludeBuildPrelude
    }
    if (templatePreludeInputs.length !== 0) {
      throw new Error(`Expected unchanged template code regions to reuse the cached prelude across plain HTML shifts. Got: ${JSON.stringify(templatePreludeInputs)}`)
    }
    const fineGrainedText = `<script server>
const boardService = resolve('board-service')
</script>

<div><%= include('flash-alert.ejs') %></div>
`
    const fineGrainedUri = URI.file(fixture.boardsFilePath).toString()
    const fineGrainedCore = new PocketPagesLanguageCore()
    fineGrainedCore.openDocument({
      uri: fineGrainedUri,
      languageId: 'ejs',
      version: 1,
      text: fineGrainedText,
    })
    const fineGrainedVirtualCode = createVirtualCode(fineGrainedUri, 'ejs', 1, fineGrainedText)
    const fineGrainedServerCode = fineGrainedVirtualCode.embeddedCodes.find((entry) => entry.kind === 'server-script')
    const fineGrainedTemplateCode = fineGrainedVirtualCode.embeddedCodes.find((entry) => entry.kind === 'template')
    if (!fineGrainedServerCode || fineGrainedServerCode.mappings.length < 2) {
      throw new Error(`Expected fine-grained server mappings around resolve() path literals. Got: ${JSON.stringify(fineGrainedServerCode && fineGrainedServerCode.mappings)}`)
    }
    if (!fineGrainedTemplateCode || fineGrainedTemplateCode.mappings.length < 2) {
      throw new Error(`Expected fine-grained template mappings around include() path literals. Got: ${JSON.stringify(fineGrainedTemplateCode && fineGrainedTemplateCode.mappings)}`)
    }
    const fineGrainedOwners = fineGrainedCore.getFeatureOwnersAtOffset(
      fineGrainedUri,
      fineGrainedText.indexOf('boardService'),
      'hover'
    )
    if (!fineGrainedOwners.some((entry) => entry.embeddedCode.kind === 'server-script')) {
      throw new Error(`Expected server identifier hover ownership in fine-grained mapper. Got: ${JSON.stringify(fineGrainedOwners)}`)
    }
    if (fineGrainedCore.isFeatureEnabledAtOffset(fineGrainedUri, fineGrainedText.indexOf('<div>') + 1, 'hover')) {
      throw new Error('Expected plain template HTML to stay outside hover-enabled mappings.')
    }
    if (
      fineGrainedCore.isFeatureEnabledAtOffset(
        fineGrainedUri,
        fineGrainedText.indexOf("'board-service'") + 1,
        'hover'
      )
    ) {
      throw new Error('Expected resolve() path literals to stay outside TS hover ownership mappings.')
    }
    if (
      fineGrainedCore.isFeatureEnabledAtOffset(
        fineGrainedUri,
        fineGrainedText.indexOf("'flash-alert.ejs'") + 1,
        'completion'
      )
    ) {
      throw new Error('Expected include() path literals to stay outside TS completion ownership mappings.')
    }
    const fineGrainedServerBlock = extractServerBlocks(fineGrainedText)[0]
    if (
      !fineGrainedServerBlock ||
      !fineGrainedCore.isFeatureEnabledAtOffset(
        fineGrainedUri,
        fineGrainedServerBlock.contentEnd,
        'completion'
      )
    ) {
      throw new Error('Expected server block end offset to stay inside TS completion ownership mappings.')
    }
    const emptyServerText = `<script server></script>
`
    const emptyServerUri = URI.file(fixture.signInFilePath).toString()
    const emptyServerCore = new PocketPagesLanguageCore()
    emptyServerCore.openDocument({
      uri: emptyServerUri,
      languageId: 'ejs',
      version: 1,
      text: emptyServerText,
    })
    const emptyServerBlock = extractServerBlocks(emptyServerText)[0]
    if (
      !emptyServerBlock ||
      !emptyServerCore.isFeatureEnabledAtOffset(
        emptyServerUri,
        emptyServerBlock.contentEnd,
        'completion'
      )
    ) {
      throw new Error('Expected empty server block offset to have TS completion ownership.')
    }
    if (
      !fineGrainedCore.hasFeatureCoverageForRange(
        fineGrainedUri,
        fineGrainedText.indexOf("'board-service'") + 1,
        fineGrainedText.indexOf("'board-service'") + 2,
        'diagnostics'
      )
    ) {
      throw new Error('Expected resolve() path literals to stay inside diagnostics-enabled mappings.')
    }
    if (
      fineGrainedCore.hasFeatureCoverageForRange(
        fineGrainedUri,
        fineGrainedText.indexOf('<div>') + 1,
        fineGrainedText.indexOf('<div>') + 4,
        'diagnostics'
      )
    ) {
      throw new Error('Expected plain template HTML to stay outside diagnostics-enabled mappings.')
    }
    const managedFineGrainedVirtualCode = fineGrainedCore.getVirtualCode(fineGrainedUri)
    const managedFineGrainedServerCode = managedFineGrainedVirtualCode && managedFineGrainedVirtualCode.getEmbeddedCodes().find((entry) => entry.kind === 'server-script')
    if (!managedFineGrainedServerCode) {
      throw new Error('Expected managed fine-grained virtual code to expose the server embedded code.')
    }
    const rootLinkedCodeMap = fineGrainedCore.linkedCodeMaps.get(managedFineGrainedServerCode)
    if (!rootLinkedCodeMap || !rootLinkedCodeMap.has('root')) {
      throw new Error('Expected linked code precision to expose an embedded-code -> root mapper.')
    }
    const linkedRootLocations = [...rootLinkedCodeMap.get('root').toSourceLocation(1)]
    if (!linkedRootLocations.some(([offset]) => offset === fineGrainedText.indexOf('const boardService'))) {
      throw new Error(`Expected linked code mapper to resolve server generated offsets back to source. Got: ${JSON.stringify(linkedRootLocations)}`)
    }
    const embeddedLinkedCodeMap = fineGrainedCore.linkedCodeMaps.get(managedFineGrainedVirtualCode)
    if (!embeddedLinkedCodeMap || !embeddedLinkedCodeMap.has(managedFineGrainedServerCode.id)) {
      throw new Error('Expected linked code precision to expose a root -> embedded-code mapper.')
    }

    const plugin = createPocketPagesLanguagePlugin()
    const initialSnapshot = createScriptSnapshot(boardShowText)
    const pluginVirtualCode = plugin.createVirtualCode(boardShowUri, 'ejs', initialSnapshot)
    const nextSnapshot = createScriptSnapshot(boardShowText.replace("board.get('name')", "board.get('slug')"), initialSnapshot)
    const pluginUpdatedVirtualCode = plugin.updateVirtualCode(boardShowUri, pluginVirtualCode, nextSnapshot)
    if (!pluginUpdatedVirtualCode || pluginUpdatedVirtualCode.version !== 2) {
      throw new Error(`Expected language plugin updateVirtualCode() to increment virtual code version. Got: ${JSON.stringify(pluginUpdatedVirtualCode)}`)
    }

    const changedSnapshot = createScriptSnapshot('const value = 2\n', createScriptSnapshot('const value = 1\n'))
    const changeRange = changedSnapshot.getChangeRange(createScriptSnapshot('const value = 1\n'))
    if (!changeRange || typeof changeRange.span.start !== 'number' || changeRange.newLength <= 0) {
      throw new Error(`Expected incremental script snapshot change range. Got: ${JSON.stringify(changeRange)}`)
    }

    const preparedManager = new PocketPagesLanguageServiceManager()
    const preparedCore = new PocketPagesLanguageCore({ manager: preparedManager })
    const preparedBoardShowText = `<script server>\nparams.\n</script>\n`
    preparedCore.openDocument({
      uri: boardShowUri,
      languageId: 'html',
      version: 1,
      text: preparedBoardShowText,
    })
    const preparedContext = preparedCore.getDocumentContextByUri(boardShowUri)
    const preparedService = preparedContext && preparedContext.service
    const preparedStateKey = path.resolve(fixture.boardShowFilePath).replace(/\\/g, '/').replace(/^[A-Z]:/, (value) => value.toLowerCase())
    const preparedState = preparedService && preparedService.preparedDocumentStates
      ? preparedService.preparedDocumentStates.get(preparedStateKey)
      : null
    if (!preparedService || !preparedState) {
      throw new Error(`Expected prepared document state after openDocument(). Got service=${!!preparedService} keys=${JSON.stringify(preparedService ? [...preparedService.preparedDocumentStates.keys()] : [])}`)
    }
    if (!preparedCore.isFeatureEnabledAtOffset(boardShowUri, preparedBoardShowText.indexOf('params') + 2, 'hover')) {
      throw new Error('Expected .ejs files opened by VS Code as html to enable mapped hover features immediately after openDocument().')
    }
    const preparedInitialDocumentSnapshot = preparedService.getDocumentSnapshot(fixture.boardShowFilePath)
    if (
      !preparedInitialDocumentSnapshot ||
      preparedInitialDocumentSnapshot.text !== preparedBoardShowText ||
      preparedInitialDocumentSnapshot.lspVersion !== 1 ||
      preparedState.snapshotId !== preparedInitialDocumentSnapshot.snapshotId
    ) {
      throw new Error(
        `Expected prepared document state to share the service document snapshot identity. Got: ${JSON.stringify({
          preparedState: preparedState && {
            snapshotId: preparedState.snapshotId,
            contentVersion: preparedState.contentVersion,
            lspVersion: preparedState.lspVersion,
          },
          documentSnapshot: preparedInitialDocumentSnapshot && {
            snapshotId: preparedInitialDocumentSnapshot.snapshotId,
            contentVersion: preparedInitialDocumentSnapshot.contentVersion,
            lspVersion: preparedInitialDocumentSnapshot.lspVersion,
          },
        })}`
      )
    }
    const preparedCompletion = preparedService.getCompletionData(
      fixture.boardShowFilePath,
      preparedBoardShowText,
      preparedBoardShowText.indexOf('params.') + 'params.'.length
    )
    if (!preparedCompletion || !preparedCompletion.profile || preparedCompletion.profile.upsertKind !== 'server-block-prepared') {
      throw new Error(`Expected prepared virtual state completion path. Got: ${JSON.stringify(preparedCompletion && preparedCompletion.profile)}`)
    }
    const preparedServerState = preparedState.serverBlocks && preparedState.serverBlocks[0]
      ? preparedService.virtualFiles.get(preparedState.serverBlocks[0].fileName)
      : null
    if (
      !preparedServerState ||
      !(preparedServerState.associatedScriptMappings instanceof Map) ||
      !preparedServerState.associatedScriptMappings.has('root')
    ) {
      const preparedLinkedTargets =
        preparedServerState && preparedServerState.associatedScriptMappings instanceof Map
          ? [...preparedServerState.associatedScriptMappings.keys()]
          : []
      throw new Error(`Expected prepared server virtual state to keep linked root mappings. Got: ${JSON.stringify(preparedLinkedTargets)}`)
    }
    const preparedMappedOffset = preparedService.mapVirtualOffsetToDocumentOffset(
      preparedState.serverBlocks[0].fileName,
      preparedState.serverBlocks[0].preludeLength + 1
    )
    if (preparedMappedOffset !== preparedBoardShowText.indexOf('params')) {
      throw new Error(`Expected linked mapping-backed virtual offset mapping for prepared server block. Got: ${JSON.stringify({ preparedMappedOffset, expected: preparedBoardShowText.indexOf('params') })}`)
    }
    const preparedOutOfBoundsOffset = preparedService.mapVirtualOffsetToDocumentOffset(
      preparedState.serverBlocks[0].fileName,
      preparedState.serverBlocks[0].preludeLength + preparedServerState.block.content.length + 1
    )
    if (preparedOutOfBoundsOffset !== null) {
      throw new Error(`Expected out-of-bounds server-block virtual offset to stay unmapped. Got: ${preparedOutOfBoundsOffset}`)
    }
    const preparedJSDocReuseCore = new PocketPagesLanguageCore()
    const preparedJSDocReuseText = `<script server>
/** @type {types.FixturePageData} */
let pageData = { boardName: 'Boards', boardCount: 1, postSlugs: ['welcome'] }
pageData.
</script>
`
    const shiftedPreparedJSDocReuseText = `<script server>
const insertedBlock = true
</script>
${preparedJSDocReuseText}`
    preparedJSDocReuseCore.openDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 1,
      text: preparedJSDocReuseText,
    })
    preparedJSDocReuseCore.updateDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 2,
      text: shiftedPreparedJSDocReuseText,
    })
    const preparedJSDocReuseContext = preparedJSDocReuseCore.getDocumentContextByUri(boardShowUri)
    const preparedJSDocReuseService = preparedJSDocReuseContext && preparedJSDocReuseContext.service
    const preparedJSDocReuseCompletion = preparedJSDocReuseService && preparedJSDocReuseService.getCompletionData(
      fixture.boardShowFilePath,
      shiftedPreparedJSDocReuseText,
      shiftedPreparedJSDocReuseText.indexOf('pageData.') + 'pageData.'.length
    )
    const preparedJSDocReuseNames = preparedJSDocReuseCompletion
      ? preparedJSDocReuseCompletion.entries.map((entry) => entry.name)
      : []
    if (
      !preparedJSDocReuseCompletion ||
      !preparedJSDocReuseCompletion.profile ||
      preparedJSDocReuseCompletion.profile.upsertKind !== 'server-block-prepared' ||
      !preparedJSDocReuseNames.includes('boardName') ||
      !preparedJSDocReuseNames.includes('postSlugs')
    ) {
      throw new Error(`Expected clean prepared server-block reuse to keep JSDoc-shifted mappings. Got: ${JSON.stringify({
        profile: preparedJSDocReuseCompletion && preparedJSDocReuseCompletion.profile,
        names: preparedJSDocReuseNames.slice(0, 20),
      })}`)
    }
    const preparedJSDocReuseQuickInfo = preparedJSDocReuseService.getQuickInfo(
      fixture.boardShowFilePath,
      shiftedPreparedJSDocReuseText,
      shiftedPreparedJSDocReuseText.indexOf('boardName') + 2
    )
    if (
      !preparedJSDocReuseQuickInfo ||
      !String(preparedJSDocReuseQuickInfo.displayText || '').includes('boardName') ||
      !String(preparedJSDocReuseQuickInfo.displayText || '').includes('string')
    ) {
      throw new Error(`Expected clean prepared server-block reuse to keep JSDoc-shifted hover mappings. Got: ${JSON.stringify(preparedJSDocReuseQuickInfo)}`)
    }
    const preparedJSDocReuseRenameEdits = preparedJSDocReuseService.getTypeScriptRenameEdits(
      fixture.boardShowFilePath,
      shiftedPreparedJSDocReuseText,
      shiftedPreparedJSDocReuseText.indexOf('pageData =') + 2,
      'renamedPageData'
    )
    if (
      !preparedJSDocReuseRenameEdits ||
      !preparedJSDocReuseRenameEdits.canRename ||
      !Array.isArray(preparedJSDocReuseRenameEdits.edits) ||
      preparedJSDocReuseRenameEdits.edits.length < 2
    ) {
      throw new Error(`Expected clean prepared server-block reuse to keep JSDoc-shifted rename mappings. Got: ${JSON.stringify(preparedJSDocReuseRenameEdits)}`)
    }
    const renamedPreparedJSDocReuseText = applyEditsToText(shiftedPreparedJSDocReuseText, preparedJSDocReuseRenameEdits.edits)
    if (
      !renamedPreparedJSDocReuseText.includes('let renamedPageData =') ||
      !renamedPreparedJSDocReuseText.includes('renamedPageData.')
    ) {
      throw new Error(`Expected JSDoc-shifted prepared reuse rename edits to land on source identifiers. Got: ${renamedPreparedJSDocReuseText}`)
    }
    const preparedLinkedConsumerText = `<script server>
const localValue = { title: 'Boards' }
</script>
<div><%= localValue.title %></div>
`
    preparedCore.updateDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 2,
      text: preparedLinkedConsumerText,
    })
    const preparedLinkedState = preparedService.getPreparedDocumentState(fixture.boardShowFilePath)
    const preparedLinkedDocumentSnapshot = preparedService.getDocumentSnapshot(fixture.boardShowFilePath)
    const preparedLinkedChangeRange =
      preparedLinkedDocumentSnapshot && preparedInitialDocumentSnapshot
        ? preparedLinkedDocumentSnapshot.snapshot.getChangeRange(preparedInitialDocumentSnapshot.snapshot)
        : null
    if (
      !preparedLinkedState ||
      !preparedLinkedDocumentSnapshot ||
      preparedLinkedState.snapshotId !== preparedLinkedDocumentSnapshot.snapshotId ||
      preparedLinkedDocumentSnapshot.snapshotId === preparedInitialDocumentSnapshot.snapshotId ||
      preparedLinkedDocumentSnapshot.lspVersion !== 2 ||
      !preparedLinkedChangeRange ||
      typeof preparedLinkedChangeRange.span.start !== 'number'
    ) {
      throw new Error(
        `Expected document snapshot lifecycle to advance prepared state on text change. Got: ${JSON.stringify({
          preparedLinkedState: preparedLinkedState && {
            snapshotId: preparedLinkedState.snapshotId,
            contentVersion: preparedLinkedState.contentVersion,
            lspVersion: preparedLinkedState.lspVersion,
          },
          preparedLinkedDocumentSnapshot: preparedLinkedDocumentSnapshot && {
            snapshotId: preparedLinkedDocumentSnapshot.snapshotId,
            contentVersion: preparedLinkedDocumentSnapshot.contentVersion,
            lspVersion: preparedLinkedDocumentSnapshot.lspVersion,
          },
          preparedLinkedChangeRange,
        })}`
      )
    }
    const preparedDefinition = preparedService.getTypeScriptDefinitionTarget(
      fixture.boardShowFilePath,
      preparedLinkedConsumerText,
      preparedLinkedConsumerText.lastIndexOf('localValue') + 2
    )
    if (
      !preparedDefinition ||
      normalizeFilePath(preparedDefinition.filePath) !== normalizeFilePath(fixture.boardShowFilePath) ||
      preparedDefinition.line !== 1
    ) {
      throw new Error(`Expected prepared linked definition target to resolve back to the source declaration. Got: ${JSON.stringify(preparedDefinition)}`)
    }
    const preparedRenameServerText = `<script server>
const localValue = 1
const nextValue = localValue + 1
</script>
`
    preparedCore.updateDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 3,
      text: preparedRenameServerText,
    })
    const preparedReferences = preparedService.getTypeScriptReferenceTargets(
      fixture.boardShowFilePath,
      preparedRenameServerText,
      preparedRenameServerText.indexOf('localValue =') + 2,
      { includeDeclaration: true }
    )
    if (!preparedReferences || preparedReferences.locations.length !== 2) {
      throw new Error(`Expected prepared linked references for declaration and server usage. Got: ${JSON.stringify(preparedReferences)}`)
    }
    const preparedRenameEdits = preparedService.getTypeScriptRenameEdits(
      fixture.boardShowFilePath,
      preparedRenameServerText,
      preparedRenameServerText.indexOf('localValue =') + 2,
      'renamedValue'
    )
    if (!preparedRenameEdits || !preparedRenameEdits.canRename || preparedRenameEdits.edits.length !== 2) {
      throw new Error(`Expected prepared linked rename edits for declaration and server usage. Got: ${JSON.stringify(preparedRenameEdits)}`)
    }
    const renamedPreparedLinkedText = applyEditsToText(preparedRenameServerText, preparedRenameEdits.edits)
    if (!renamedPreparedLinkedText.includes('const renamedValue = 1') || !renamedPreparedLinkedText.includes('const nextValue = renamedValue + 1')) {
      throw new Error(`Expected prepared linked rename to update both declaration and server usage. Got: ${renamedPreparedLinkedText}`)
    }
    const preparedDiagnosticsText = `<script server>
const countValue = 1
countValue.trim()
</script>
<div><%= missingAuthState.email %></div>
`
    preparedCore.updateDocument({
      uri: boardShowUri,
      languageId: 'ejs',
      version: 4,
      text: preparedDiagnosticsText,
    })
    const preparedDiagnosticsState = preparedService.getPreparedDocumentState(fixture.boardShowFilePath)
    if (!preparedDiagnosticsState || preparedDiagnosticsState.documentText !== preparedDiagnosticsText) {
      throw new Error(`Expected prepared diagnostics state to match the current document text. Got: ${JSON.stringify(preparedDiagnosticsState && { kind: preparedDiagnosticsState.kind, documentLength: preparedDiagnosticsState.documentLength })}`)
    }
    const originalPreparedDiagnosticsUpsertVirtualFile = preparedService.upsertVirtualFile.bind(preparedService)
    const originalPreparedDiagnosticsUpsertTemplateVirtualFile = preparedService.upsertTemplateVirtualFile.bind(preparedService)
    const originalPreparedDiagnosticsUpsertTemplateVirtualFileState = preparedService.upsertTemplateVirtualFileState.bind(preparedService)
    const preparedDiagnosticsProjectVersion = preparedService.projectVersion
    const preparedDiagnosticsUpsertCalls = []
    preparedService.upsertVirtualFile = function unexpectedPreparedDiagnosticsServerUpsert(...args) {
      preparedDiagnosticsUpsertCalls.push('server')
      return originalPreparedDiagnosticsUpsertVirtualFile(...args)
    }
    preparedService.upsertTemplateVirtualFile = function unexpectedPreparedDiagnosticsTemplateUpsert(...args) {
      preparedDiagnosticsUpsertCalls.push('template')
      return originalPreparedDiagnosticsUpsertTemplateVirtualFile(...args)
    }
    preparedService.upsertTemplateVirtualFileState = function unexpectedPreparedDiagnosticsTemplateStateUpsert(...args) {
      preparedDiagnosticsUpsertCalls.push('template-state')
      return originalPreparedDiagnosticsUpsertTemplateVirtualFileState(...args)
    }
    try {
      const preparedDiagnosticsProfile = {}
      const preparedDiagnostics = preparedService.getDiagnostics(
        fixture.boardShowFilePath,
        preparedDiagnosticsText,
        {
          profile: preparedDiagnosticsProfile,
          requirePreparedVirtualState: true,
        }
      )
      const preparedDiagnosticsMessages = preparedDiagnostics.map((entry) => String(entry.message))
      if (preparedDiagnosticsUpsertCalls.length) {
        throw new Error(`Expected prepared diagnostics to reuse prepared virtual files without ad-hoc upserts. Got: ${JSON.stringify(preparedDiagnosticsUpsertCalls)}`)
      }
      if (preparedService.projectVersion !== preparedDiagnosticsProjectVersion) {
        throw new Error(`Expected prepared diagnostics to keep projectVersion stable. before=${preparedDiagnosticsProjectVersion} after=${preparedService.projectVersion}`)
      }
      if (preparedDiagnosticsProfile.preparedVirtualStateKind !== 'prepared') {
        throw new Error(`Expected diagnostics to use existing prepared virtual state. Got: ${JSON.stringify(preparedDiagnosticsProfile)}`)
      }
      if (!preparedDiagnosticsMessages.some((message) => message.includes("Property 'trim' does not exist"))) {
        throw new Error(`Expected prepared server diagnostics to report number trim(). Got: ${preparedDiagnosticsMessages.join(' | ')}`)
      }
      if (!preparedDiagnostics.some((entry) => entry.code === 2304 && String(entry.message).includes('missingAuthState'))) {
        throw new Error(`Expected prepared template diagnostics to report missingAuthState. Got: ${preparedDiagnosticsMessages.join(' | ')}`)
      }
    } finally {
      preparedService.upsertVirtualFile = originalPreparedDiagnosticsUpsertVirtualFile
      preparedService.upsertTemplateVirtualFile = originalPreparedDiagnosticsUpsertTemplateVirtualFile
      preparedService.upsertTemplateVirtualFileState = originalPreparedDiagnosticsUpsertTemplateVirtualFileState
    }
    preparedCore.closeDocument(boardShowUri)
    const remainingPreparedVirtualFiles = [...preparedService.virtualFiles.values()].filter(
      (state) => state && normalizeFilePath(state.filePath) === preparedStateKey
    )
    if (
      preparedService.getDocumentSnapshot(fixture.boardShowFilePath) ||
      preparedService.preparedDocumentStates.has(preparedStateKey) ||
      remainingPreparedVirtualFiles.length
    ) {
      throw new Error(`Expected closeDocument() to release source, prepared, and virtual document state. Got: ${JSON.stringify({
        hasSource: !!preparedService.getDocumentSnapshot(fixture.boardShowFilePath),
        hasPrepared: preparedService.preparedDocumentStates.has(preparedStateKey),
        virtualCount: remainingPreparedVirtualFiles.length,
      })}`)
    }

    const coldPreparedDiagnosticsManager = new PocketPagesLanguageServiceManager()
    const coldPreparedDiagnosticsService = coldPreparedDiagnosticsManager.getServiceForFile(fixture.boardsFilePath)
    if (!coldPreparedDiagnosticsService) {
      throw new Error('Expected cold prepared diagnostics manager to resolve a service.')
    }
    const coldPreparedDiagnosticsText = `<script server>
const countValue = 1
countValue.trim()
</script>
`
    const originalColdPreparedUpsertVirtualFile = coldPreparedDiagnosticsService.upsertVirtualFile.bind(coldPreparedDiagnosticsService)
    const originalColdPreparedUpsertTemplateVirtualFile = coldPreparedDiagnosticsService.upsertTemplateVirtualFile.bind(coldPreparedDiagnosticsService)
    const originalColdPreparedUpsertTemplateVirtualFileState = coldPreparedDiagnosticsService.upsertTemplateVirtualFileState.bind(coldPreparedDiagnosticsService)
    const coldPreparedUpsertCalls = []
    coldPreparedDiagnosticsService.upsertVirtualFile = function unexpectedColdPreparedServerUpsert(...args) {
      coldPreparedUpsertCalls.push('server')
      return originalColdPreparedUpsertVirtualFile(...args)
    }
    coldPreparedDiagnosticsService.upsertTemplateVirtualFile = function unexpectedColdPreparedTemplateUpsert(...args) {
      coldPreparedUpsertCalls.push('template')
      return originalColdPreparedUpsertTemplateVirtualFile(...args)
    }
    coldPreparedDiagnosticsService.upsertTemplateVirtualFileState = function unexpectedColdPreparedTemplateStateUpsert(...args) {
      coldPreparedUpsertCalls.push('template-state')
      return originalColdPreparedUpsertTemplateVirtualFileState(...args)
    }
    try {
      const coldPreparedProfile = {}
      const coldPreparedVersion = coldPreparedDiagnosticsService.projectVersion
      const coldPreparedVirtualFileCount = coldPreparedDiagnosticsService.virtualFiles.size
      const coldPreparedDiagnostics = coldPreparedDiagnosticsService.getDiagnostics(
        fixture.boardsFilePath,
        coldPreparedDiagnosticsText,
        {
          profile: coldPreparedProfile,
          requirePreparedVirtualState: true,
        }
      )
      if (coldPreparedUpsertCalls.length || coldPreparedDiagnosticsService.virtualFiles.size !== coldPreparedVirtualFileCount) {
        throw new Error(`Expected prepared-only diagnostics to avoid cold virtual upserts. Got: ${JSON.stringify({ calls: coldPreparedUpsertCalls, before: coldPreparedVirtualFileCount, after: coldPreparedDiagnosticsService.virtualFiles.size })}`)
      }
      if (coldPreparedDiagnosticsService.projectVersion !== coldPreparedVersion) {
        throw new Error(`Expected prepared-only cold diagnostics to keep projectVersion stable. before=${coldPreparedVersion} after=${coldPreparedDiagnosticsService.projectVersion}`)
      }
      if (
        coldPreparedProfile.preparedVirtualStateKind !== 'missing-prepared' ||
        coldPreparedProfile.skippedUnpreparedServerBlockDiagnostics !== 1
      ) {
        throw new Error(`Expected cold prepared-only diagnostics to skip TS work when no prepared state exists. Got: ${JSON.stringify(coldPreparedProfile)}`)
      }
      if (coldPreparedDiagnostics.some((entry) => String(entry.message).includes("Property 'trim' does not exist"))) {
        throw new Error(`Expected cold prepared-only diagnostics to skip TS semantic diagnostics. Got: ${JSON.stringify(coldPreparedDiagnostics)}`)
      }
    } finally {
      coldPreparedDiagnosticsService.upsertVirtualFile = originalColdPreparedUpsertVirtualFile
      coldPreparedDiagnosticsService.upsertTemplateVirtualFile = originalColdPreparedUpsertTemplateVirtualFile
      coldPreparedDiagnosticsService.upsertTemplateVirtualFileState = originalColdPreparedUpsertTemplateVirtualFileState
    }

    const lspSmokeCore = new PocketPagesLanguageCore()
    const lspSmokeText = `<script server>
const boardService = resolve('board-service')
const localValue = { title: 'Boards' }
const authState = boardService.readAuthState({ request })
const isSignedIn = !!authState && authState.isSignedIn
</script>
<div><%= localValue.title %></div>
`
    const lspSmokeDocument = createTestDocument(fixture.boardsFilePath, 'ejs', 1, lspSmokeText)
    const lspSmokeUri = lspSmokeDocument.uri
    lspSmokeCore.openDocument({
      uri: lspSmokeUri,
      languageId: 'ejs',
      version: 1,
      text: lspSmokeText,
    })
    const lspSmokeContext = createLspServiceSmokeContext(
      lspSmokeCore,
      new Map([[lspSmokeUri, lspSmokeDocument]])
    )
    const tsFeatureService = createTypeScriptFeatureService(lspSmokeContext.context)
    const customFeatureService = createCustomFeatureService(lspSmokeContext.context)
    const resolvePathHover = tsFeatureService.provideHover({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf("'board-service'") + 1),
    })
    if (resolvePathHover !== null) {
      throw new Error(`Expected TS feature hover to stay disabled inside resolve() path literals. Got: ${JSON.stringify(resolvePathHover)}`)
    }
    const customPathHover = customFeatureService.provideHover({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf("'board-service'") + 1),
    })
    if (
      !customPathHover ||
      normalizeFilePath(customPathHover.targetFilePath) !== normalizeFilePath(fixture.boardServiceFilePath)
    ) {
      throw new Error(`Expected custom feature hover to own resolve() path literals. Got: ${JSON.stringify(customPathHover)}`)
    }
    const tsOwnedHover = tsFeatureService.provideHover({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf('authState =') + 2),
    })
    if (!tsOwnedHover || !String(tsOwnedHover.displayText || '').includes('authState')) {
      throw new Error(`Expected TS feature hover to stay available for script identifiers. Got: ${JSON.stringify(tsOwnedHover)}`)
    }
    const lspSmokeDefinition = tsFeatureService.provideDefinition({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.lastIndexOf('localValue') + 2),
    })
    if (
      !lspSmokeDefinition ||
      normalizeFilePath(lspSmokeDefinition.filePath) !== normalizeFilePath(fixture.boardsFilePath)
    ) {
      throw new Error(`Expected TS feature definition to resolve same-file EJS identifiers. Got: ${JSON.stringify(lspSmokeDefinition)}`)
    }
    const lspSmokeReferences = tsFeatureService.provideReferences({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf('authState =') + 2),
      context: { includeDeclaration: true },
    })
    if (!Array.isArray(lspSmokeReferences) || lspSmokeReferences.length < 3) {
      throw new Error(`Expected TS feature references to include declaration and script usage. Got: ${JSON.stringify(lspSmokeReferences)}`)
    }
    const lspSmokeTemplateLinkedReferences = tsFeatureService.provideReferences({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf('localValue =') + 2),
      context: { includeDeclaration: true },
    })
    if (!Array.isArray(lspSmokeTemplateLinkedReferences) || lspSmokeTemplateLinkedReferences.length !== 2) {
      throw new Error(`Expected TS feature references from server declaration to include template usages. Got: ${JSON.stringify(lspSmokeTemplateLinkedReferences)}`)
    }
    const lspSmokeTemplateLinkedRenameEdits = tsFeatureService.provideRename({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf('localValue =') + 2),
      newName: 'pageState',
    })
    if (!Array.isArray(lspSmokeTemplateLinkedRenameEdits) || lspSmokeTemplateLinkedRenameEdits.length !== 2) {
      throw new Error(`Expected TS feature rename from server declaration to update template usages. Got: ${JSON.stringify(lspSmokeTemplateLinkedRenameEdits)}`)
    }
    const renamedLspSmokeText = applyEditsToText(lspSmokeText, lspSmokeTemplateLinkedRenameEdits)
    if (
      !renamedLspSmokeText.includes("const pageState = { title: 'Boards' }") ||
      !renamedLspSmokeText.includes('<div><%= pageState.title %></div>')
    ) {
      throw new Error(`Expected TS feature rename from server declaration to update the template usage. Got: ${renamedLspSmokeText}`)
    }

    const corpusCore = new PocketPagesLanguageCore()
    const corpusIndexText = fs.readFileSync(fixture.corpusLibraryIndexFilePath, 'utf8')
    const corpusIndexDocument = createTestDocument(fixture.corpusLibraryIndexFilePath, 'ejs', 1, corpusIndexText)
    const corpusIndexUri = corpusIndexDocument.uri
    corpusCore.openDocument({
      uri: corpusIndexUri,
      languageId: 'ejs',
      version: 1,
      text: corpusIndexText,
    })
    const corpusDocuments = new Map([[corpusIndexUri, corpusIndexDocument]])
    const corpusContext = createLspServiceSmokeContext(corpusCore, corpusDocuments)
    const corpusService = corpusCore.getDocumentContextByUri(corpusIndexUri).service
    const corpusTypeScriptFeatures = createTypeScriptFeatureService(corpusContext.context)
    const corpusCustomFeatures = createCustomFeatureService(corpusContext.context)
    const corpusDiagnosticsFeatures = createDiagnosticsFeatureService(corpusContext.context)
    const corpusDiagnosticsReport = await corpusDiagnosticsFeatures.providePullDiagnostics(
      { textDocument: { uri: corpusIndexUri } },
      { isCancellationRequested: false }
    )
    const corpusBlockingDiagnostics = serializeDiagnostics(corpusDiagnosticsReport && corpusDiagnosticsReport.items)
      .filter((entry) =>
        [
          'pp-unresolved-route-path',
          'pp-unresolved-include-path',
          'pp-unresolved-resolve-path',
          'pp-resolve-private-prefix',
          'pp-private-resolve-path',
          'pp-schema-collection',
          'pp-schema-field',
        ].includes(String(entry.code)) ||
        /Cannot find name|Cannot find module|Property .* does not exist/.test(entry.message)
      )
    if (corpusBlockingDiagnostics.length) {
      throw new Error(`Expected corpus app index to be clean for route/include/resolve/schema diagnostics. Got: ${JSON.stringify(corpusBlockingDiagnostics)}`)
    }
    const corpusResolveHover = corpusCustomFeatures.provideHover({
      textDocument: { uri: corpusIndexUri },
      position: corpusIndexDocument.positionAt(corpusIndexText.indexOf("'library-service'") + 1),
    })
    if (
      !corpusResolveHover ||
      normalizeFilePath(corpusResolveHover.targetFilePath) !== normalizeFilePath(fixture.corpusLibraryServiceFilePath)
    ) {
      throw new Error(`Expected corpus resolve() hover to target the local library service. Got: ${JSON.stringify(corpusResolveHover)}`)
    }
    const corpusResolveDefinition = corpusCustomFeatures.provideDefinition({
      textDocument: { uri: corpusIndexUri },
      position: corpusIndexDocument.positionAt(corpusIndexText.indexOf("'library-service'") + 1),
    })
    if (normalizeFilePath(corpusResolveDefinition) !== normalizeFilePath(fixture.corpusLibraryServiceFilePath)) {
      throw new Error(`Expected corpus resolve() definition to target the local library service. Got: ${JSON.stringify(corpusResolveDefinition)}`)
    }
    const corpusDocumentLinks = corpusCustomFeatures.provideDocumentLinks({
      textDocument: { uri: corpusIndexUri },
    })
    const corpusDocumentLinkTargets = Array.isArray(corpusDocumentLinks)
      ? corpusDocumentLinks.map((entry) => normalizeFilePath(URI.parse(entry.target).fsPath))
      : []
    if (
      !corpusDocumentLinkTargets.includes(normalizeFilePath(fixture.corpusLibraryServiceFilePath)) ||
      !corpusDocumentLinkTargets.includes(normalizeFilePath(fixture.corpusBookCardFilePath)) ||
      !corpusDocumentLinkTargets.includes(normalizeFilePath(fixture.corpusFavoriteFilePath))
    ) {
      throw new Error(`Expected corpus document links to cover resolve(), include(), and hx-post targets. Got: ${JSON.stringify(corpusDocumentLinks)}`)
    }
    const corpusServiceCompletionText = `<script server>
const libraryService = resolve('library-service')
libraryService.
</script>
`
    const corpusServiceCompletionOffset =
      corpusServiceCompletionText.indexOf('libraryService.') + 'libraryService.'.length
    const corpusServiceCompletion = corpusService.getCompletionData(
      fixture.corpusLibraryIndexFilePath,
      corpusServiceCompletionText,
      corpusServiceCompletionOffset
    )
    const corpusServiceCompletionNames = corpusServiceCompletion
      ? corpusServiceCompletion.entries.map((entry) => entry.name)
      : []
    if (
      !corpusServiceCompletionNames.includes('listFeaturedBooks') ||
      !corpusServiceCompletionNames.includes('findBookBySlug') ||
      !corpusServiceCompletionNames.includes('toBookForm')
    ) {
      throw new Error(`Expected corpus resolve() completion to expose service exports. Got: ${corpusServiceCompletionNames.slice(0, 30).join(', ')}`)
    }
    const corpusCollectionCompletionText = `<script server>
$app.findRecordsByFilter('')
</script>
`
    const corpusCollectionCompletionOffset = corpusCollectionCompletionText.indexOf("''") + 1
    const corpusCollectionCompletion = corpusService.getCustomCompletionData(
      fixture.corpusLibraryIndexFilePath,
      corpusCollectionCompletionText,
      corpusCollectionCompletionOffset
    )
    const corpusCollectionCompletionNames = corpusCollectionCompletion
      ? corpusCollectionCompletion.items.map((entry) => entry.label)
      : []
    if (
      !corpusCollectionCompletionNames.includes('books') ||
      !corpusCollectionCompletionNames.includes('authors') ||
      !corpusCollectionCompletionNames.includes('book_notes')
    ) {
      throw new Error(`Expected corpus collection completion to expose booklog schema collections. Got: ${corpusCollectionCompletionNames.join(', ')}`)
    }
    const corpusFieldCompletionText = `<script server>
const books = $app.findRecordsByFilter('books')
const book = books[0]
book.get('')
</script>
`
    const corpusFieldCompletionOffset = corpusFieldCompletionText.indexOf("book.get('") + "book.get('".length
    const corpusFieldCompletion = corpusService.getCustomCompletionData(
      fixture.corpusLibraryIndexFilePath,
      corpusFieldCompletionText,
      corpusFieldCompletionOffset
    )
    const corpusFieldCompletionNames = corpusFieldCompletion
      ? corpusFieldCompletion.items.map((entry) => entry.label)
      : []
    if (
      !corpusFieldCompletionNames.includes('title') ||
      !corpusFieldCompletionNames.includes('summary') ||
      !corpusFieldCompletionNames.includes('author')
    ) {
      throw new Error(`Expected corpus field completion to expose books fields. Got: ${corpusFieldCompletionNames.join(', ')}`)
    }
    const corpusServiceHover = corpusTypeScriptFeatures.provideHover({
      textDocument: { uri: corpusIndexUri },
      position: corpusIndexDocument.positionAt(corpusIndexText.indexOf('listFeaturedBooks') + 2),
    })
    if (
      !corpusServiceHover ||
      !String(corpusServiceHover.displayText || '').includes('listFeaturedBooks(ctx:') ||
      !String(corpusServiceHover.displayText || '').includes('limit?: number')
    ) {
      throw new Error(`Expected corpus TS hover to surface JSDoc-backed service signatures. Got: ${JSON.stringify(corpusServiceHover)}`)
    }
    const corpusRenameEdits = corpusTypeScriptFeatures.provideRename({
      textDocument: { uri: corpusIndexUri },
      position: corpusIndexDocument.positionAt(corpusIndexText.indexOf('featuredBooks =') + 2),
      newName: 'visibleBooks',
    })
    if (!Array.isArray(corpusRenameEdits) || corpusRenameEdits.length < 3) {
      throw new Error(`Expected corpus rename to update script and template usages. Got: ${JSON.stringify(corpusRenameEdits)}`)
    }
    const renamedCorpusIndexText = applyEditsToText(corpusIndexText, corpusRenameEdits)
    if (
      !renamedCorpusIndexText.includes('const visibleBooks = libraryService.listFeaturedBooks') ||
      !renamedCorpusIndexText.includes('pickFeaturedBook(visibleBooks)') ||
      !renamedCorpusIndexText.includes('<%= visibleBooks.length %>')
    ) {
      throw new Error(`Expected corpus rename to rewrite server and template usages. Got: ${renamedCorpusIndexText}`)
    }
    const corpusIncludeReferences = corpusCustomFeatures.provideReferences({
      textDocument: { uri: corpusIndexUri },
      position: corpusIndexDocument.positionAt(corpusIndexText.indexOf("'book-card.ejs'") + 1),
      context: { includeDeclaration: true },
    })
    if (
      !Array.isArray(corpusIncludeReferences) ||
      !corpusIncludeReferences.some((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryIndexFilePath)) ||
      !corpusIncludeReferences.some((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryShowFilePath))
    ) {
      throw new Error(`Expected corpus include references to include multiple real route callers. Got: ${JSON.stringify(corpusIncludeReferences)}`)
    }
    const corpusPartialRenameEdits = corpusCore.getFileRenameEdits(
      fixture.corpusBookCardFilePath,
      path.join(path.dirname(fixture.corpusBookCardFilePath), 'volume-card.ejs')
    )
    if (
      !Array.isArray(corpusPartialRenameEdits) ||
      !corpusPartialRenameEdits.some((entry) =>
        normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryIndexFilePath) &&
        entry.newText === 'volume-card.ejs'
      ) ||
      !corpusPartialRenameEdits.some((entry) =>
        normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryShowFilePath) &&
        entry.newText === 'volume-card.ejs'
      )
    ) {
      throw new Error(`Expected corpus partial file rename edits to update all include() callers. Got: ${JSON.stringify(corpusPartialRenameEdits)}`)
    }

    const corpusServiceText = fs.readFileSync(fixture.corpusLibraryServiceFilePath, 'utf8')
    const corpusServiceMemberRename = corpusService.getRenameEdits(
      fixture.corpusLibraryServiceFilePath,
      corpusServiceText,
      corpusServiceText.indexOf('listFeaturedBooks(ctx)') + 2,
      'listPublishedBooks'
    )
    if (!corpusServiceMemberRename || !corpusServiceMemberRename.canRename) {
      throw new Error(`Expected corpus service export rename to be available from the _private module. Got: ${JSON.stringify(corpusServiceMemberRename)}`)
    }
    const corpusServiceFileMemberEdits = corpusServiceMemberRename.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryServiceFilePath)
    )
    const corpusIndexMemberEdits = corpusServiceMemberRename.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryIndexFilePath)
    )
    const corpusLargeMemberEdits = corpusServiceMemberRename.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLargeShelfFilePath)
    )
    if (
      corpusServiceFileMemberEdits.length < 2 ||
      corpusIndexMemberEdits.length !== 1 ||
      corpusLargeMemberEdits.length !== 1
    ) {
      throw new Error(`Expected corpus service export rename to update module export and resolve() callers. Got: ${JSON.stringify(corpusServiceMemberRename)}`)
    }
    const renamedCorpusServiceText = applyEditsToText(corpusServiceText, corpusServiceFileMemberEdits)
    const renamedCorpusIndexMemberText = applyEditsToText(corpusIndexText, corpusIndexMemberEdits)
    const renamedCorpusLargeMemberText = applyEditsToText(
      fs.readFileSync(fixture.corpusLargeShelfFilePath, 'utf8'),
      corpusLargeMemberEdits
    )
    if (
      !renamedCorpusServiceText.includes('function listPublishedBooks(ctx)') ||
      !renamedCorpusServiceText.includes('  listPublishedBooks,') ||
      !renamedCorpusIndexMemberText.includes('libraryService.listPublishedBooks({ $app, limit: 12 })') ||
      !renamedCorpusLargeMemberText.includes('stressService.listPublishedBooks({ $app, limit: 5 })')
    ) {
      throw new Error(
        `Expected corpus service export rename to preserve real callers. Got: ${JSON.stringify({
          renamedCorpusServiceText,
          renamedCorpusIndexMemberText,
          renamedCorpusLargeMemberText,
        })}`
      )
    }

    const corpusUsageMemberRenameEdits = corpusCustomFeatures.provideRename({
      textDocument: { uri: corpusIndexUri },
      position: corpusIndexDocument.positionAt(corpusIndexText.indexOf('listFeaturedBooks') + 2),
      newName: 'listCuratedBooks',
    })
    const corpusUsageServiceEdits = Array.isArray(corpusUsageMemberRenameEdits)
      ? corpusUsageMemberRenameEdits.filter(
          (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryServiceFilePath)
        )
      : []
    const corpusUsageIndexEdits = Array.isArray(corpusUsageMemberRenameEdits)
      ? corpusUsageMemberRenameEdits.filter(
          (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryIndexFilePath)
        )
      : []
    const corpusUsageLargeEdits = Array.isArray(corpusUsageMemberRenameEdits)
      ? corpusUsageMemberRenameEdits.filter(
          (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLargeShelfFilePath)
        )
      : []
    if (
      corpusUsageServiceEdits.length < 2 ||
      corpusUsageIndexEdits.length !== 1 ||
      corpusUsageLargeEdits.length !== 1
    ) {
      throw new Error(`Expected corpus service method rename from EJS usage to update export and callers. Got: ${JSON.stringify(corpusUsageMemberRenameEdits)}`)
    }
    const renamedCorpusUsageIndexText = applyEditsToText(corpusIndexText, corpusUsageIndexEdits)
    if (!renamedCorpusUsageIndexText.includes('libraryService.listCuratedBooks({ $app, limit: 12 })')) {
      throw new Error(`Expected corpus service method rename from EJS usage to update the current caller. Got: ${renamedCorpusUsageIndexText}`)
    }

    const corpusParamDirectoryPath = path.dirname(fixture.corpusLibraryShowFilePath)
    const renamedCorpusParamDirectoryPath = path.join(path.dirname(corpusParamDirectoryPath), '[volumeSlug]')
    const corpusParamRenameEdits = corpusService.getFileRenameEdits(
      corpusParamDirectoryPath,
      renamedCorpusParamDirectoryPath
    )
    const renamedCorpusShowFilePath = path.join(renamedCorpusParamDirectoryPath, 'index.ejs')
    const renamedCorpusEditFilePath = path.join(renamedCorpusParamDirectoryPath, 'edit.ejs')
    const corpusShowParamEdits = corpusParamRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedCorpusShowFilePath)
    )
    const corpusEditParamEdits = corpusParamRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedCorpusEditFilePath)
    )
    if (corpusShowParamEdits.length !== 2 || corpusEditParamEdits.length !== 1) {
      throw new Error(`Expected corpus dynamic route param rename to update show/edit params. Got: ${JSON.stringify(corpusParamRenameEdits)}`)
    }
    const renamedCorpusShowParamText = applyEditsToText(
      fs.readFileSync(fixture.corpusLibraryShowFilePath, 'utf8'),
      corpusShowParamEdits
    )
    const renamedCorpusEditParamText = applyEditsToText(
      fs.readFileSync(fixture.corpusLibraryEditFilePath, 'utf8'),
      corpusEditParamEdits
    )
    if (
      !renamedCorpusShowParamText.includes('slug: params.volumeSlug') ||
      !renamedCorpusShowParamText.includes('/library/<%= params.volumeSlug %>/edit') ||
      renamedCorpusShowParamText.includes('params.bookSlug') ||
      !renamedCorpusEditParamText.includes('slug: params.volumeSlug') ||
      renamedCorpusEditParamText.includes('params.bookSlug')
    ) {
      throw new Error(
        `Expected corpus dynamic route param rename to rewrite only params usage. Got: ${JSON.stringify({
          renamedCorpusShowParamText,
          renamedCorpusEditParamText,
        })}`
      )
    }

    const corpusXapiParamDirectoryPath = path.dirname(fixture.corpusFavoriteFilePath)
    const renamedCorpusXapiParamDirectoryPath = path.join(path.dirname(corpusXapiParamDirectoryPath), '[volumeSlug]')
    const corpusXapiParamRenameEdits = corpusService.getFileRenameEdits(
      corpusXapiParamDirectoryPath,
      renamedCorpusXapiParamDirectoryPath
    )
    const renamedCorpusFavoriteFilePath = path.join(renamedCorpusXapiParamDirectoryPath, 'favorite.ejs')
    const renamedCorpusSaveFilePath = path.join(renamedCorpusXapiParamDirectoryPath, 'save.ejs')
    const corpusFavoriteParamEdits = corpusXapiParamRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedCorpusFavoriteFilePath)
    )
    const corpusSaveParamEdits = corpusXapiParamRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedCorpusSaveFilePath)
    )
    if (corpusFavoriteParamEdits.length !== 2 || corpusSaveParamEdits.length !== 2) {
      throw new Error(`Expected corpus xapi param directory rename to update favorite/save handlers. Got: ${JSON.stringify(corpusXapiParamRenameEdits)}`)
    }
    const renamedCorpusFavoriteParamText = applyEditsToText(
      fs.readFileSync(fixture.corpusFavoriteFilePath, 'utf8'),
      corpusFavoriteParamEdits
    )
    const renamedCorpusSaveParamText = applyEditsToText(
      fs.readFileSync(fixture.corpusSaveFilePath, 'utf8'),
      corpusSaveParamEdits
    )
    if (
      !renamedCorpusFavoriteParamText.includes('slug: params.volumeSlug') ||
      !renamedCorpusFavoriteParamText.includes("redirect('/library/' + params.volumeSlug") ||
      renamedCorpusFavoriteParamText.includes('params.bookSlug') ||
      !renamedCorpusSaveParamText.includes('slug: params.volumeSlug') ||
      !renamedCorpusSaveParamText.includes("redirect('/library/' + params.volumeSlug") ||
      renamedCorpusSaveParamText.includes('params.bookSlug')
    ) {
      throw new Error(
        `Expected corpus xapi param rename to rewrite handler params. Got: ${JSON.stringify({
          renamedCorpusFavoriteParamText,
          renamedCorpusSaveParamText,
        })}`
      )
    }

    const renamedCorpusEditRouteFilePath = path.join(path.dirname(fixture.corpusLibraryEditFilePath), 'settings.ejs')
    const corpusEditRouteRenameEdits = corpusService.getFileRenameEdits(
      fixture.corpusLibraryEditFilePath,
      renamedCorpusEditRouteFilePath
    )
    const corpusShowEditLinkEdits = corpusEditRouteRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.corpusLibraryShowFilePath)
    )
    if (corpusShowEditLinkEdits.length !== 1) {
      throw new Error(`Expected corpus edit route rename to rewrite detail-page edit links. Got: ${JSON.stringify(corpusEditRouteRenameEdits)}`)
    }
    const renamedCorpusShowEditLinkText = applyEditsToText(
      fs.readFileSync(fixture.corpusLibraryShowFilePath, 'utf8'),
      corpusShowEditLinkEdits
    )
    if (!renamedCorpusShowEditLinkText.includes('/library/<%= params.bookSlug %>/settings')) {
      throw new Error(`Expected corpus edit route rename to preserve dynamic segment and change suffix. Got: ${renamedCorpusShowEditLinkText}`)
    }

    const corpusPartialWatchCore = new PocketPagesLanguageCore()
    const corpusPartialWatchDocument = createTestDocument(
      fixture.corpusLibraryIndexFilePath,
      'ejs',
      1,
      corpusIndexText
    )
    const corpusPartialWatchUri = corpusPartialWatchDocument.uri
    corpusPartialWatchCore.openDocument({
      uri: corpusPartialWatchUri,
      languageId: 'ejs',
      version: 1,
      text: corpusIndexText,
    })
    const originalCorpusBookCardText = fs.readFileSync(fixture.corpusBookCardFilePath, 'utf8')
    const getCorpusIncludeDiagnostics = () => serializeDiagnostics(
      corpusPartialWatchCore.getDocumentContextByUri(corpusPartialWatchUri).service.getDiagnostics(
        fixture.corpusLibraryIndexFilePath,
        corpusIndexText
      )
    ).filter((entry) => String(entry.code).startsWith('pp-include-'))
    const corpusIncludeDiagnosticsBefore = getCorpusIncludeDiagnostics()
    if (corpusIncludeDiagnosticsBefore.length) {
      throw new Error(`Expected corpus include callers to start valid. Got: ${JSON.stringify(corpusIncludeDiagnosticsBefore)}`)
    }
    try {
      writeFile(fixture.corpusBookCardFilePath, originalCorpusBookCardText.replace(/returnPath/g, 'backHref'))
      const corpusPartialChangeResult = corpusPartialWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusBookCardFilePath, type: 'change' },
      ])
      const corpusIncludeDiagnosticsAfter = getCorpusIncludeDiagnostics()
      if (
        !corpusPartialChangeResult.affectedUris.includes(corpusPartialWatchUri) ||
        !corpusIncludeDiagnosticsAfter.some((entry) => entry.code === 'pp-include-missing-local' && entry.message.includes('backHref')) ||
        !corpusIncludeDiagnosticsAfter.some((entry) => entry.code === 'pp-include-unknown-local' && entry.message.includes('returnPath'))
      ) {
        throw new Error(
          `Expected corpus partial contract watcher change to refresh caller diagnostics. Got: ${JSON.stringify({
            corpusPartialChangeResult,
            corpusIncludeDiagnosticsAfter,
          })}`
        )
      }
      const corpusIncludeLocalCompletionText = `<script server>
const recommendedBook = {}
</script>
<%- include('book-card.ejs', {  }) %>
`
      const corpusIncludeLocalCompletionOffset = corpusIncludeLocalCompletionText.indexOf('{  }') + 2
      const corpusIncludeLocalCompletion = corpusPartialWatchCore
        .getDocumentContextByUri(corpusPartialWatchUri)
        .service.getCustomCompletionData(
          fixture.corpusLibraryIndexFilePath,
          corpusIncludeLocalCompletionText,
          corpusIncludeLocalCompletionOffset
        )
      const corpusIncludeLocalNames = corpusIncludeLocalCompletion
        ? corpusIncludeLocalCompletion.items.map((entry) => entry.label)
        : []
      if (!corpusIncludeLocalNames.includes('backHref') || corpusIncludeLocalNames.includes('returnPath')) {
        throw new Error(`Expected corpus include local completion to reflect changed partial locals. Got: ${corpusIncludeLocalNames.join(', ')}`)
      }
    } finally {
      writeFile(fixture.corpusBookCardFilePath, originalCorpusBookCardText)
      corpusPartialWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusBookCardFilePath, type: 'change' },
      ])
    }

    const corpusRouteWatchCore = new PocketPagesLanguageCore()
    const corpusRouteWatchText = `<a href="/library/archive/all">Archive</a>\n`
    const corpusRouteWatchDocument = createTestDocument(
      fixture.corpusLibraryIndexFilePath,
      'ejs',
      1,
      corpusRouteWatchText
    )
    const corpusRouteWatchUri = corpusRouteWatchDocument.uri
    const corpusArchiveFilePath = path.join(path.dirname(fixture.corpusLibraryIndexFilePath), 'archive', 'all.ejs')
    corpusRouteWatchCore.openDocument({
      uri: corpusRouteWatchUri,
      languageId: 'ejs',
      version: 1,
      text: corpusRouteWatchText,
    })
    const corpusRouteTargetBefore = corpusRouteWatchCore
      .getDocumentContextByUri(corpusRouteWatchUri)
      .service.getPathTargetInfo(
        fixture.corpusLibraryIndexFilePath,
        corpusRouteWatchText,
        corpusRouteWatchText.indexOf('/library/archive/all') + 2
      )
    if (corpusRouteTargetBefore) {
      throw new Error(`Expected corpus nested route target to be unresolved before file creation. Got: ${JSON.stringify(corpusRouteTargetBefore)}`)
    }
    writeFile(corpusArchiveFilePath, `<h1>Archive</h1>\n`)
    let corpusArchiveCreated = false
    try {
      corpusArchiveCreated = true
      const corpusArchiveCreateResult = corpusRouteWatchCore.handleWatchedFileChanges([
        { filePath: corpusArchiveFilePath, type: 'create' },
      ])
      const corpusRouteWatchService = corpusRouteWatchCore.getDocumentContextByUri(corpusRouteWatchUri).service
      const corpusRouteTargetAfter = corpusRouteWatchService.getPathTargetInfo(
        fixture.corpusLibraryIndexFilePath,
        corpusRouteWatchText,
        corpusRouteWatchText.indexOf('/library/archive/all') + 2
      )
      if (
        !corpusArchiveCreateResult.affectedUris.includes(corpusRouteWatchUri) ||
        !corpusRouteTargetAfter ||
        normalizeFilePath(corpusRouteTargetAfter.targetFilePath) !== normalizeFilePath(corpusArchiveFilePath)
      ) {
        throw new Error(
          `Expected corpus nested route creation to refresh path targets. Got: ${JSON.stringify({
            corpusArchiveCreateResult,
            corpusRouteTargetAfter,
          })}`
        )
      }
      const corpusRouteCompletionText = `<a href="/library/archive/al"></a>\n`
      const corpusRouteCompletion = corpusRouteWatchService.getCustomCompletionData(
        fixture.corpusLibraryIndexFilePath,
        corpusRouteCompletionText,
        corpusRouteCompletionText.indexOf('/library/archive/al') + '/library/archive/al'.length
      )
      const corpusRouteCompletionNames = corpusRouteCompletion
        ? corpusRouteCompletion.items.map((entry) => entry.label)
        : []
      if (!corpusRouteCompletionNames.includes('/library/archive/all')) {
        throw new Error(`Expected corpus nested route creation to refresh route completion. Got: ${corpusRouteCompletionNames.join(', ')}`)
      }
    } finally {
      fs.rmSync(corpusArchiveFilePath, { force: true })
      const corpusArchiveDeleteResult = corpusRouteWatchCore.handleWatchedFileChanges([
        { filePath: corpusArchiveFilePath, type: 'delete' },
      ])
      if (corpusArchiveCreated) {
        const corpusRouteTargetAfterDelete = corpusRouteWatchCore
          .getDocumentContextByUri(corpusRouteWatchUri)
          .service.getPathTargetInfo(
            fixture.corpusLibraryIndexFilePath,
            corpusRouteWatchText,
            corpusRouteWatchText.indexOf('/library/archive/all') + 2
          )
        if (
          !corpusArchiveDeleteResult.affectedUris.includes(corpusRouteWatchUri) ||
          corpusRouteTargetAfterDelete
        ) {
          throw new Error(
            `Expected corpus nested route deletion to clear stale route targets. Got: ${JSON.stringify({
              corpusArchiveDeleteResult,
              corpusRouteTargetAfterDelete,
            })}`
          )
        }
      }
    }

    const corpusLargeCore = new PocketPagesLanguageCore()
    const corpusLargeText = fs.readFileSync(fixture.corpusLargeShelfFilePath, 'utf8')
    const corpusLargeDocument = createTestDocument(fixture.corpusLargeShelfFilePath, 'ejs', 1, corpusLargeText)
    const corpusLargeUri = corpusLargeDocument.uri
    corpusLargeCore.openDocument({
      uri: corpusLargeUri,
      languageId: 'ejs',
      version: 1,
      text: corpusLargeText,
    })
    const corpusLargeContext = createLspServiceSmokeContext(
      corpusLargeCore,
      new Map([[corpusLargeUri, corpusLargeDocument]])
    )
    corpusLargeContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 1000
    const corpusLargeDiagnosticsFeatures = createDiagnosticsFeatureService(corpusLargeContext.context)
    const corpusLargeStartedAt = process.hrtime.bigint()
    const corpusLargeReport = await corpusLargeDiagnosticsFeatures.providePullDiagnostics(
      { textDocument: { uri: corpusLargeUri } },
      { isCancellationRequested: false }
    )
    const corpusLargeElapsedMs = Number(process.hrtime.bigint() - corpusLargeStartedAt) / 1000000
    const corpusLargeBlockingDiagnostics = serializeDiagnostics(corpusLargeReport && corpusLargeReport.items)
      .filter((entry) =>
        String(entry.code) === 'pp-schema-field' ||
        String(entry.code) === 'pp-schema-collection' ||
        /Cannot find name|Property .* does not exist/.test(entry.message)
      )
    if (
      !corpusLargeReport ||
      corpusLargeElapsedMs > 6000 ||
      corpusLargeBlockingDiagnostics.length !== 0
    ) {
      throw new Error(
        `Expected large corpus EJS diagnostics to stay bounded and clean. Got: ${JSON.stringify({
          elapsedMs: corpusLargeElapsedMs.toFixed(1),
          reportKind: corpusLargeReport && corpusLargeReport.kind,
          itemCount: corpusLargeReport && Array.isArray(corpusLargeReport.items) ? corpusLargeReport.items.length : null,
          blockingDiagnostics: corpusLargeBlockingDiagnostics,
        })}`
      )
    }

    const corpusWatchCore = new PocketPagesLanguageCore()
    const corpusWatchText = `<script server>
const watchedLibraryService = resolve('library-service')
watchedLibraryService.
</script>
`
    const corpusWatchDocument = createTestDocument(fixture.corpusLibraryIndexFilePath, 'ejs', 1, corpusWatchText)
    const corpusWatchUri = corpusWatchDocument.uri
    corpusWatchCore.openDocument({
      uri: corpusWatchUri,
      languageId: 'ejs',
      version: 1,
      text: corpusWatchText,
    })
    const getCorpusWatchCompletionNames = () => {
      const currentCorpusWatchService = corpusWatchCore.getDocumentContextByUri(corpusWatchUri).service
      const completion = currentCorpusWatchService.getCompletionData(
        fixture.corpusLibraryIndexFilePath,
        corpusWatchText,
        corpusWatchText.indexOf('watchedLibraryService.') + 'watchedLibraryService.'.length
      )
      return completion ? completion.entries.map((entry) => entry.name) : []
    }
    const corpusWatchNamesBefore = getCorpusWatchCompletionNames()
    if (
      corpusWatchNamesBefore.includes('readRecentlyAddedBooks') ||
      corpusWatchNamesBefore.includes('readSeasonalBooks')
    ) {
      throw new Error(`Expected corpus watch completion to start without temporary service exports. Got: ${corpusWatchNamesBefore.join(', ')}`)
    }
    const originalCorpusServiceText = fs.readFileSync(fixture.corpusLibraryServiceFilePath, 'utf8')
    const corpusServiceWithRecent = originalCorpusServiceText
      .replace(
        '\nmodule.exports = {',
        `
/**
 * @param {{ $app: pocketbase.PocketBase }} ctx
 * @returns {Array<core.Record>}
 */
function readRecentlyAddedBooks(ctx) {
  return ctx.$app.findRecordsByFilter('books', 'status = "published"', '-created', 6, 0)
}

module.exports = {`
      )
      .replace('  toBookForm,\n}', '  toBookForm,\n  readRecentlyAddedBooks,\n}')
    const corpusServiceWithSeasonal = corpusServiceWithRecent
      .replace(/readRecentlyAddedBooks/g, 'readSeasonalBooks')
      .replace('-created', '-rating')
    try {
      writeFile(fixture.corpusLibraryServiceFilePath, corpusServiceWithRecent)
      const corpusRecentWatchResult = corpusWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusLibraryServiceFilePath, type: 'change' },
      ])
      const corpusWatchNamesAfterRecent = getCorpusWatchCompletionNames()
      if (
        !corpusRecentWatchResult.affectedUris.includes(corpusWatchUri) ||
        !corpusWatchNamesAfterRecent.includes('readRecentlyAddedBooks')
      ) {
        throw new Error(
          `Expected corpus service watcher change to expose a newly exported method. Got: ${JSON.stringify({
            corpusRecentWatchResult,
            names: corpusWatchNamesAfterRecent,
          })}`
        )
      }
      writeFile(fixture.corpusLibraryServiceFilePath, corpusServiceWithSeasonal)
      const corpusSeasonalWatchResult = corpusWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusLibraryServiceFilePath, type: 'change' },
      ])
      const corpusWatchNamesAfterSeasonal = getCorpusWatchCompletionNames()
      if (
        !corpusSeasonalWatchResult.affectedUris.includes(corpusWatchUri) ||
        !corpusWatchNamesAfterSeasonal.includes('readSeasonalBooks') ||
        corpusWatchNamesAfterSeasonal.includes('readRecentlyAddedBooks')
      ) {
        throw new Error(
          `Expected consecutive corpus service watcher changes to drop stale exports. Got: ${JSON.stringify({
            corpusSeasonalWatchResult,
            names: corpusWatchNamesAfterSeasonal,
          })}`
        )
      }
    } finally {
      writeFile(fixture.corpusLibraryServiceFilePath, originalCorpusServiceText)
      corpusWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusLibraryServiceFilePath, type: 'change' },
      ])
    }

    const originalCorpusSchemaText = fs.readFileSync(fixture.corpusSchemaFilePath, 'utf8')
    const corpusSubtitleProbeText = `<script server>
const schemaBooks = $app.findRecordsByFilter('books')
const schemaBook = schemaBooks[0]
schemaBook.get('subtitle')
</script>
`
    const corpusIsbnProbeText = corpusSubtitleProbeText.replace("schemaBook.get('subtitle')", "schemaBook.get('isbn')")
    const getCorpusSchemaFieldDiagnostics = (documentText) => serializeDiagnostics(
      corpusWatchCore.getDocumentContextByUri(corpusWatchUri).service.getDiagnostics(fixture.corpusLibraryIndexFilePath, documentText)
    ).filter((entry) => String(entry.code) === 'pp-schema-field')
    const corpusSchemaDiagnosticsBefore = getCorpusSchemaFieldDiagnostics(corpusSubtitleProbeText)
    if (!corpusSchemaDiagnosticsBefore.some((entry) => entry.message.includes('subtitle'))) {
      throw new Error(`Expected corpus schema watcher probe to start with a missing subtitle field. Got: ${JSON.stringify(corpusSchemaDiagnosticsBefore)}`)
    }
    try {
      writeCorpusBooklogSchema(fixture.corpusSchemaFilePath, [{ name: 'subtitle', type: 'text' }])
      const corpusSubtitleWatchResult = corpusWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusSchemaFilePath, type: 'change' },
      ])
      const corpusSchemaDiagnosticsAfterSubtitle = getCorpusSchemaFieldDiagnostics(corpusSubtitleProbeText)
      if (
        !corpusSubtitleWatchResult.affectedUris.includes(corpusWatchUri) ||
        corpusSchemaDiagnosticsAfterSubtitle.some((entry) => entry.message.includes('subtitle'))
      ) {
        throw new Error(
          `Expected corpus schema watcher change to clear subtitle diagnostics. Got: ${JSON.stringify({
            corpusSubtitleWatchResult,
            diagnostics: corpusSchemaDiagnosticsAfterSubtitle,
          })}`
        )
      }
      writeCorpusBooklogSchema(fixture.corpusSchemaFilePath, [{ name: 'isbn', type: 'text' }])
      const corpusIsbnWatchResult = corpusWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusSchemaFilePath, type: 'change' },
      ])
      const corpusSchemaDiagnosticsAfterIsbnForSubtitle = getCorpusSchemaFieldDiagnostics(corpusSubtitleProbeText)
      const corpusSchemaDiagnosticsAfterIsbn = getCorpusSchemaFieldDiagnostics(corpusIsbnProbeText)
      if (
        !corpusIsbnWatchResult.affectedUris.includes(corpusWatchUri) ||
        !corpusSchemaDiagnosticsAfterIsbnForSubtitle.some((entry) => entry.message.includes('subtitle')) ||
        corpusSchemaDiagnosticsAfterIsbn.some((entry) => entry.message.includes('isbn'))
      ) {
        throw new Error(
          `Expected consecutive corpus schema watcher changes to replace fields without stale cache. Got: ${JSON.stringify({
            corpusIsbnWatchResult,
            subtitleDiagnostics: corpusSchemaDiagnosticsAfterIsbnForSubtitle,
            isbnDiagnostics: corpusSchemaDiagnosticsAfterIsbn,
          })}`
        )
      }
    } finally {
      writeFile(fixture.corpusSchemaFilePath, originalCorpusSchemaText)
      corpusWatchCore.handleWatchedFileChanges([
        { filePath: fixture.corpusSchemaFilePath, type: 'change' },
      ])
    }

    const completionGuardCore = new PocketPagesLanguageCore()
    const completionGuardText = `<script server>
const localValue = {
</script>
`
    const completionGuardDocument = createTestDocument(fixture.signInFilePath, 'ejs', 1, completionGuardText)
    completionGuardCore.openDocument({
      uri: completionGuardDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: completionGuardText,
    })
    const completionGuardContext = createLspServiceSmokeContext(
      completionGuardCore,
      new Map([[completionGuardDocument.uri, completionGuardDocument]])
    )
    const completionGuardDocumentContext = completionGuardCore.getDocumentContextByUri(completionGuardDocument.uri)
    let completionGuardCallCount = 0
    completionGuardDocumentContext.service.getCompletionData = function getCompletionDataGuardStub() {
      completionGuardCallCount += 1
      return {
        entries: [],
        isIncomplete: false,
        replacementSpan: null,
        virtualFileName: 'guard.ts',
        virtualOffset: 0,
        profile: {},
      }
    }
    const completionGuardFeatureService = createTypeScriptFeatureService(completionGuardContext.context)
    const guardedCompletionResult = completionGuardFeatureService.provideCompletionItems({
      textDocument: { uri: completionGuardDocument.uri },
      position: completionGuardDocument.positionAt(completionGuardText.indexOf('{') + 1),
      context: { triggerKind: 2, triggerCharacter: '{' },
    })
    if (guardedCompletionResult !== null || completionGuardCallCount !== 0) {
      throw new Error(
        `Expected custom-only "{" trigger to avoid TypeScript completion. calls=${completionGuardCallCount} result=${JSON.stringify(guardedCompletionResult)}`
      )
    }

    let templateStringTriggerCharacter = null
    completionGuardDocumentContext.service.getCompletionData = function getCompletionDataTemplateTriggerStub(
      _filePath,
      _documentText,
      _offset,
      options
    ) {
      templateStringTriggerCharacter = options && options.triggerCharacter
      return {
        entries: [{ name: 'localValue', kind: ts.ScriptElementKind.localVariableElement, sortText: '0' }],
        isIncomplete: true,
        replacementSpan: null,
        virtualFileName: 'guard.ts',
        virtualOffset: 0,
        profile: {},
      }
    }
    const templateStringCompletion = completionGuardFeatureService.provideCompletionItems({
      textDocument: { uri: completionGuardDocument.uri },
      position: completionGuardDocument.positionAt(completionGuardText.indexOf('{') + 1),
      context: { triggerKind: 2, triggerCharacter: '`' },
    })
    if (!templateStringCompletion || templateStringTriggerCharacter !== '`' || !templateStringCompletion.isIncomplete) {
      throw new Error(
        `Expected template-string trigger to reach TypeScript completion with incomplete metadata. trigger=${templateStringTriggerCharacter} result=${JSON.stringify(templateStringCompletion)}`
      )
    }

    const largeQuoteCompletionCore = new PocketPagesLanguageCore()
    const largeQuoteCompletionText = `<script server>
${'const fillerValue = 1\n'.repeat(80)}
const quoteTarget = ""
const memberTarget = { value: 1 }
memberTarget.
</script>
`
    const largeQuoteCompletionDocument = createTestDocument(
      fixture.signInFilePath,
      'ejs',
      1,
      largeQuoteCompletionText
    )
    largeQuoteCompletionCore.openDocument({
      uri: largeQuoteCompletionDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: largeQuoteCompletionText,
    })
    const largeQuoteCompletionContext = createLspServiceSmokeContext(
      largeQuoteCompletionCore,
      new Map([[largeQuoteCompletionDocument.uri, largeQuoteCompletionDocument]])
    )
    largeQuoteCompletionContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 1000
    const largeQuoteCompletionDocumentContext = largeQuoteCompletionCore.getDocumentContextByUri(
      largeQuoteCompletionDocument.uri
    )
    let largeQuoteCompletionCallCount = 0
    const originalLargeQuoteCompletionData =
      largeQuoteCompletionDocumentContext.service.getCompletionData.bind(
        largeQuoteCompletionDocumentContext.service
      )
    largeQuoteCompletionDocumentContext.service.getCompletionData = function getLargeQuoteCompletionDataStub() {
      largeQuoteCompletionCallCount += 1
      return null
    }
    const largeQuoteCompletionFeatureService = createTypeScriptFeatureService(
      largeQuoteCompletionContext.context
    )
    try {
      const largeQuoteCompletionResult = largeQuoteCompletionFeatureService.provideCompletionItems({
        textDocument: { uri: largeQuoteCompletionDocument.uri },
        position: largeQuoteCompletionDocument.positionAt(largeQuoteCompletionText.indexOf('""') + 1),
        context: { triggerKind: 2, triggerCharacter: '"' },
      })
      if (largeQuoteCompletionResult !== null || largeQuoteCompletionCallCount !== 0) {
        throw new Error(
          `Expected large-EJS quote trigger to skip TypeScript completion. calls=${largeQuoteCompletionCallCount} result=${JSON.stringify(largeQuoteCompletionResult)}`
        )
      }
      const largeDotCompletionResult = largeQuoteCompletionFeatureService.provideCompletionItems({
        textDocument: { uri: largeQuoteCompletionDocument.uri },
        position: largeQuoteCompletionDocument.positionAt(largeQuoteCompletionText.indexOf('memberTarget.') + 'memberTarget.'.length),
        context: { triggerKind: 2, triggerCharacter: '.' },
      })
      if (largeDotCompletionResult !== null || largeQuoteCompletionCallCount !== 1) {
        throw new Error(
          `Expected large-EJS member trigger to keep TypeScript completion routing. calls=${largeQuoteCompletionCallCount} result=${JSON.stringify(largeDotCompletionResult)}`
        )
      }
    } finally {
      largeQuoteCompletionDocumentContext.service.getCompletionData = originalLargeQuoteCompletionData
    }

    const completionTextEditCore = new PocketPagesLanguageCore()
    const completionTextEditText = `<script server>
const localValue = foo.ba
</script>
`
    const completionTextEditDocument = createTestDocument(fixture.siteSignInFilePath, 'ejs', 1, completionTextEditText)
    completionTextEditCore.openDocument({
      uri: completionTextEditDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: completionTextEditText,
    })
    const completionTextEditContext = createLspServiceSmokeContext(
      completionTextEditCore,
      new Map([[completionTextEditDocument.uri, completionTextEditDocument]])
    )
    const completionTextEditDocumentContext = completionTextEditCore.getDocumentContextByUri(completionTextEditDocument.uri)
    let completionTextEditTriggerCharacter = null
    completionTextEditDocumentContext.service.getCompletionData = function getCompletionDataTextEditStub(
      _filePath,
      _documentText,
      _offset,
      options
    ) {
      completionTextEditTriggerCharacter = options && options.triggerCharacter
      return {
        entries: [{ name: 'foo.bar', kind: ts.ScriptElementKind.memberVariableElement, sortText: '0', insertText: 'foo.bar' }],
        isIncomplete: true,
        replacementSpan: {
          start: completionTextEditText.indexOf('foo.ba'),
          end: completionTextEditText.indexOf('foo.ba') + 'foo.ba'.length,
        },
        virtualFileName: 'text-edit.ts',
        virtualOffset: 0,
        profile: {},
      }
    }
    const completionTextEditFeatureService = createTypeScriptFeatureService(completionTextEditContext.context)
    const completionTextEditResult = completionTextEditFeatureService.provideCompletionItems({
      textDocument: { uri: completionTextEditDocument.uri },
      position: completionTextEditDocument.positionAt(completionTextEditText.indexOf('ba') + 'ba'.length),
      context: { triggerKind: 2, triggerCharacter: '.' },
    })
    const completionTextEditItem =
      completionTextEditResult && completionTextEditResult.items ? completionTextEditResult.items[0] : null
    if (
      !completionTextEditItem ||
      !completionTextEditItem.textEdit ||
      completionTextEditTriggerCharacter !== '.' ||
      completionTextEditDocument.offsetAt(completionTextEditItem.textEdit.range.start) !== completionTextEditText.indexOf('ba') ||
      completionTextEditItem.textEdit.newText !== 'bar' ||
      !Array.isArray(completionTextEditItem.additionalTextEdits) ||
      completionTextEditItem.additionalTextEdits[0].newText !== 'foo.'
    ) {
      throw new Error(
        `Expected TypeScript completion text edits to be narrowed around the current word. trigger=${completionTextEditTriggerCharacter} result=${JSON.stringify(completionTextEditResult)}`
      )
    }

    const jsSlashCompletionCore = new PocketPagesLanguageCore()
    const jsSlashCompletionText = `const pathValue = '/'\n`
    const jsSlashCompletionDocument = createTestDocument(fixture.middlewareFilePath, 'javascript', 1, jsSlashCompletionText)
    jsSlashCompletionCore.openDocument({
      uri: jsSlashCompletionDocument.uri,
      languageId: 'javascript',
      version: 1,
      text: jsSlashCompletionText,
    })
    const jsSlashCompletionContext = createLspServiceSmokeContext(
      jsSlashCompletionCore,
      new Map([[jsSlashCompletionDocument.uri, jsSlashCompletionDocument]])
    )
    const jsSlashDocumentContext = jsSlashCompletionCore.getDocumentContextByUri(jsSlashCompletionDocument.uri)
    let jsSlashCompletionCallCount = 0
    jsSlashDocumentContext.service.getCompletionData = function getCompletionDataSlashStub() {
      jsSlashCompletionCallCount += 1
      return {
        entries: [{ name: 'pathValue', kind: ts.ScriptElementKind.localVariableElement, sortText: '0' }],
        isIncomplete: false,
        replacementSpan: null,
        virtualFileName: 'slash.js',
        virtualOffset: 0,
        profile: {},
      }
    }
    const jsSlashFeatureService = createTypeScriptFeatureService(jsSlashCompletionContext.context)
    const jsSlashCompletionResult = jsSlashFeatureService.provideCompletionItems({
      textDocument: { uri: jsSlashCompletionDocument.uri },
      position: jsSlashCompletionDocument.positionAt(jsSlashCompletionText.indexOf('/') + 1),
      context: { triggerKind: 2, triggerCharacter: '/' },
    })
    if (!jsSlashCompletionResult || jsSlashCompletionCallCount !== 1) {
      throw new Error(
        `Expected slash trigger to remain available in plain JS completion. calls=${jsSlashCompletionCallCount} result=${JSON.stringify(jsSlashCompletionResult)}`
      )
    }

    const schemaOnlyCustomFeatureCore = new PocketPagesLanguageCore()
    const schemaOnlyCustomFeatureText = `redirect('/')\n`
    const schemaOnlyCustomFeatureDocument = createTestDocument(
      fixture.jobScriptFilePath,
      'javascript',
      1,
      schemaOnlyCustomFeatureText
    )
    const schemaOnlyCustomFeatureUri = schemaOnlyCustomFeatureDocument.uri
    schemaOnlyCustomFeatureCore.openDocument({
      uri: schemaOnlyCustomFeatureUri,
      languageId: 'javascript',
      version: 1,
      text: schemaOnlyCustomFeatureText,
    })
    const schemaOnlyCustomFeatureContext = createLspServiceSmokeContext(
      schemaOnlyCustomFeatureCore,
      new Map([[schemaOnlyCustomFeatureUri, schemaOnlyCustomFeatureDocument]])
    )
    const schemaOnlyCustomFeatureService = createCustomFeatureService(
      schemaOnlyCustomFeatureContext.context
    )
    const schemaOnlyPathPosition = schemaOnlyCustomFeatureDocument.positionAt(
      schemaOnlyCustomFeatureText.indexOf("'/'") + 1
    )
    const schemaOnlyCustomDocumentContext = schemaOnlyCustomFeatureCore.getDocumentContextByUri(
      schemaOnlyCustomFeatureUri
    )
    const originalSchemaOnlyCustomCompletionData =
      schemaOnlyCustomDocumentContext &&
      schemaOnlyCustomDocumentContext.service &&
      typeof schemaOnlyCustomDocumentContext.service.getCustomCompletionData === 'function'
        ? schemaOnlyCustomDocumentContext.service.getCustomCompletionData.bind(
            schemaOnlyCustomDocumentContext.service
          )
        : null
    if (!originalSchemaOnlyCustomCompletionData) {
      throw new Error('Expected schema-support-only hook custom feature smoke context to expose completion data.')
    }
    try {
      schemaOnlyCustomDocumentContext.service.getCustomCompletionData = () => ({
        start: schemaOnlyCustomFeatureText.indexOf("'/'") + 1,
        end: schemaOnlyCustomFeatureText.indexOf("'/'") + 2,
        items: [
          { label: '/sign-in', category: 'route-path' },
          { label: 'boards', category: 'collection-name' },
          { label: 'name', category: 'record-field' },
        ],
      })
      const schemaOnlyFilteredCompletion = schemaOnlyCustomFeatureService.provideCompletionItems({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
        position: schemaOnlyPathPosition,
        context: { triggerKind: 2, triggerCharacter: '/' },
      })
      const schemaOnlyFilteredLabels = schemaOnlyFilteredCompletion && schemaOnlyFilteredCompletion.items
        ? schemaOnlyFilteredCompletion.items.map((entry) => entry.label).sort()
        : []
      if (
        schemaOnlyFilteredLabels.join(',') !== 'boards,name' ||
        schemaOnlyFilteredLabels.includes('/sign-in')
      ) {
        throw new Error(
          `Expected schema-support-only hook custom completion to keep schema items and drop path items. Got: ${JSON.stringify(schemaOnlyFilteredCompletion)}`
        )
      }
    } finally {
      schemaOnlyCustomDocumentContext.service.getCustomCompletionData = originalSchemaOnlyCustomCompletionData
    }
    if (
      schemaOnlyCustomFeatureService.provideHover({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
        position: schemaOnlyPathPosition,
      }) !== null
    ) {
      throw new Error('Expected schema-support-only hook scripts to suppress custom path hover.')
    }
    if (
      schemaOnlyCustomFeatureService.provideDefinition({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
        position: schemaOnlyPathPosition,
      }) !== null
    ) {
      throw new Error('Expected schema-support-only hook scripts to suppress custom path definitions.')
    }
    if (
      schemaOnlyCustomFeatureService.provideDocumentLinks({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
      }) !== null
    ) {
      throw new Error('Expected schema-support-only hook scripts to suppress custom document links.')
    }
    if (
      schemaOnlyCustomFeatureService.provideReferences({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
        position: schemaOnlyPathPosition,
        context: { includeDeclaration: true },
      }) !== null
    ) {
      throw new Error('Expected schema-support-only hook scripts to suppress custom references.')
    }
    if (
      schemaOnlyCustomFeatureService.providePrepareRename({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
        position: schemaOnlyPathPosition,
      }) !== null
    ) {
      throw new Error('Expected schema-support-only hook scripts to suppress custom rename prepare.')
    }
    if (
      schemaOnlyCustomFeatureService.provideRename({
        textDocument: { uri: schemaOnlyCustomFeatureUri },
        position: schemaOnlyPathPosition,
        newName: 'nextPath',
      }) !== null
    ) {
      throw new Error('Expected schema-support-only hook scripts to suppress custom rename edits.')
    }
    const lspSmokePrepareRename = tsFeatureService.providePrepareRename({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf('authState =') + 2),
    })
    if (!lspSmokePrepareRename || lspSmokePrepareRename.placeholder !== 'authState') {
      throw new Error(`Expected TS feature prepareRename placeholder for authState. Got: ${JSON.stringify(lspSmokePrepareRename)}`)
    }
    const lspSmokeRename = tsFeatureService.provideRename({
      textDocument: { uri: lspSmokeUri },
      position: lspSmokeDocument.positionAt(lspSmokeText.indexOf('authState =') + 2),
      newName: 'sessionState',
    })
    if (!Array.isArray(lspSmokeRename) || lspSmokeRename.length < 3) {
      throw new Error(`Expected TS feature rename to include declaration and script usage edits. Got: ${JSON.stringify(lspSmokeRename)}`)
    }
    const jsRenameText = `const sessionState = { signedIn: true }\nconsole.log(sessionState.signedIn)\n`
    const jsRenameDocument = createTestDocument(
      fixture.middlewareFilePath,
      'javascript',
      1,
      jsRenameText
    )
    const jsRenameUri = jsRenameDocument.uri
    lspSmokeCore.openDocument({
      uri: jsRenameUri,
      languageId: 'javascript',
      version: 1,
      text: jsRenameText,
    })
    const jsRenameContext = createLspServiceSmokeContext(
      lspSmokeCore,
      new Map([
        [lspSmokeUri, lspSmokeDocument],
        [jsRenameUri, jsRenameDocument],
      ])
    )
    const jsRenameFeatureService = createTypeScriptFeatureService(jsRenameContext.context)
    const jsRenamePosition = jsRenameDocument.positionAt(jsRenameText.indexOf('sessionState =') + 2)
    const jsPrepareRename = jsRenameFeatureService.providePrepareRename({
      textDocument: { uri: jsRenameUri },
      position: jsRenamePosition,
    })
    if (!jsPrepareRename || jsPrepareRename.placeholder !== 'sessionState') {
      throw new Error(`Expected JS TS prepareRename placeholder for sessionState. Got: ${JSON.stringify(jsPrepareRename)}`)
    }
    const jsRenameReferences = jsRenameFeatureService.provideReferences({
      textDocument: { uri: jsRenameUri },
      position: jsRenamePosition,
      context: { includeDeclaration: true },
    })
    if (!Array.isArray(jsRenameReferences) || jsRenameReferences.length !== 2) {
      throw new Error(`Expected JS TS references to include declaration and local usage. Got: ${JSON.stringify(jsRenameReferences)}`)
    }
    const jsRenameEdits = jsRenameFeatureService.provideRename({
      textDocument: { uri: jsRenameUri },
      position: jsRenamePosition,
      newName: 'authSnapshot',
    })
    if (!Array.isArray(jsRenameEdits) || jsRenameEdits.length !== 2) {
      throw new Error(`Expected JS TS rename to update declaration and local usage. Got: ${JSON.stringify(jsRenameEdits)}`)
    }
    const renamedJsRenameText = applyEditsToText(jsRenameText, jsRenameEdits)
    if (
      !renamedJsRenameText.includes('const authSnapshot = { signedIn: true }') ||
      !renamedJsRenameText.includes('console.log(authSnapshot.signedIn)')
    ) {
      throw new Error(`Expected JS TS rename to update declaration and local usage text. Got: ${renamedJsRenameText}`)
    }
    const templateRenameText = `<%
const flashClasses = 'notice'
%>
<div class="<%= flashClasses %>"><%= flashClasses %></div>
`
    const templateRenameDocument = createTestDocument(
      fixture.flashAlertFilePath,
      'ejs',
      1,
      templateRenameText
    )
    const templateRenameUri = templateRenameDocument.uri
    lspSmokeCore.openDocument({
      uri: templateRenameUri,
      languageId: 'ejs',
      version: 1,
      text: templateRenameText,
    })
    const templateRenameContext = createLspServiceSmokeContext(
      lspSmokeCore,
      new Map([
        [lspSmokeUri, lspSmokeDocument],
        [templateRenameUri, templateRenameDocument],
      ])
    )
    const templateRenameFeatureService = createTypeScriptFeatureService(
      templateRenameContext.context
    )
    const templateRenamePosition = templateRenameDocument.positionAt(
      templateRenameText.indexOf('flashClasses %>') + 2
    )
    const templateRenameReferences = templateRenameFeatureService.provideReferences({
      textDocument: { uri: templateRenameUri },
      position: templateRenamePosition,
      context: { includeDeclaration: true },
    })
    if (!Array.isArray(templateRenameReferences) || templateRenameReferences.length !== 3) {
      throw new Error(`Expected template TS references to include declaration and template usages. Got: ${JSON.stringify(templateRenameReferences)}`)
    }
    const templatePrepareRename = templateRenameFeatureService.providePrepareRename({
      textDocument: { uri: templateRenameUri },
      position: templateRenamePosition,
    })
    if (!templatePrepareRename || templatePrepareRename.placeholder !== 'flashClasses') {
      throw new Error(`Expected template TS prepareRename placeholder for flashClasses. Got: ${JSON.stringify(templatePrepareRename)}`)
    }
    const templateRenameEdits = templateRenameFeatureService.provideRename({
      textDocument: { uri: templateRenameUri },
      position: templateRenamePosition,
      newName: 'bannerClasses',
    })
    if (!Array.isArray(templateRenameEdits) || templateRenameEdits.length !== 3) {
      throw new Error(`Expected template TS rename to update declaration and template usages. Got: ${JSON.stringify(templateRenameEdits)}`)
    }
    const renamedTemplateText = applyEditsToText(templateRenameText, templateRenameEdits)
    if (
      !renamedTemplateText.includes("const bannerClasses = 'notice'") ||
      !renamedTemplateText.includes('<div class="<%= bannerClasses %>"><%= bannerClasses %></div>')
    ) {
      throw new Error(`Expected template TS rename edits to update declaration and template usages. Got: ${renamedTemplateText}`)
    }

    const assetSmokeText = `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n`
    const assetSmokeDocument = createTestDocument(fixture.siteIndexFilePath, 'ejs', 1, assetSmokeText)
    const assetSmokeUri = assetSmokeDocument.uri
    lspSmokeCore.openDocument({
      uri: assetSmokeUri,
      languageId: 'ejs',
      version: 1,
      text: assetSmokeText,
    })
    const assetSmokeContext = createLspServiceSmokeContext(
      lspSmokeCore,
      new Map([
        [lspSmokeUri, lspSmokeDocument],
        [assetSmokeUri, assetSmokeDocument],
      ])
    )
    const assetCustomFeatureService = createCustomFeatureService(assetSmokeContext.context)
    const assetFeatureDocumentLinks = assetCustomFeatureService.provideDocumentLinks({
      textDocument: { uri: assetSmokeUri },
    })
    if (
      !Array.isArray(assetFeatureDocumentLinks) ||
      !assetFeatureDocumentLinks.some((entry) => String(entry.tooltip || '').includes('Open asset target'))
    ) {
      throw new Error(`Expected custom feature document links to preserve asset() tooltips. Got: ${JSON.stringify(assetFeatureDocumentLinks)}`)
    }

    const excludedCustomText = `const boardService = resolve('board-service')\n`
    const excludedCustomDocument = createTestDocument(fixture.routeVendorScriptFilePath, 'javascript', 1, excludedCustomText)
    const excludedCustomUri = excludedCustomDocument.uri
    lspSmokeCore.openDocument({
      uri: excludedCustomUri,
      languageId: 'javascript',
      version: 1,
      text: excludedCustomText,
    })
    const excludedCustomContext = createLspServiceSmokeContext(
      lspSmokeCore,
      new Map([
        [lspSmokeUri, lspSmokeDocument],
        [excludedCustomUri, excludedCustomDocument],
      ])
    )
    excludedCustomContext.context.helpers.isExcludedPocketPagesScriptPath = (filePath) =>
      normalizeFilePath(filePath) === normalizeFilePath(fixture.routeVendorScriptFilePath)
    const excludedCustomFeatures = createCustomFeatureService(excludedCustomContext.context)
    const excludedCustomPosition = excludedCustomDocument.positionAt(excludedCustomText.indexOf("'board-service'") + 1)
    const excludedCustomHover = excludedCustomFeatures.provideHover({
      textDocument: { uri: excludedCustomUri },
      position: excludedCustomPosition,
    })
    if (excludedCustomHover !== null) {
      throw new Error(`Expected custom feature hover to skip excluded route-exposed vendor scripts. Got: ${JSON.stringify(excludedCustomHover)}`)
    }
    const excludedCustomDefinition = excludedCustomFeatures.provideDefinition({
      textDocument: { uri: excludedCustomUri },
      position: excludedCustomPosition,
    })
    if (excludedCustomDefinition !== null) {
      throw new Error(`Expected custom feature definition to skip excluded route-exposed vendor scripts. Got: ${JSON.stringify(excludedCustomDefinition)}`)
    }
    const excludedCustomLinks = excludedCustomFeatures.provideDocumentLinks({
      textDocument: { uri: excludedCustomUri },
    })
    if (excludedCustomLinks !== null) {
      throw new Error(`Expected custom feature document links to skip excluded route-exposed vendor scripts. Got: ${JSON.stringify(excludedCustomLinks)}`)
    }
    let excludedTypeScriptServiceCalls = 0
    let excludedTypeScriptPrepareCalls = 0
    excludedCustomContext.context.helpers.ensureDocumentPrepared = () => {
      excludedTypeScriptPrepareCalls += 1
      throw new Error('Excluded TypeScript feature should not prepare virtual code.')
    }
    excludedCustomContext.context.helpers.isSchemaSupportOnlyHookScriptPath = (filePath) =>
      normalizeFilePath(filePath) === normalizeFilePath(fixture.jobScriptFilePath)
    const excludedDocumentContext = excludedCustomContext.context.core.getDocumentContextByUri(excludedCustomUri)
    for (const methodName of [
      'getCompletionData',
      'getQuickInfo',
      'getTypeScriptDefinitionTarget',
      'getTypeScriptReferenceTargets',
      'getTypeScriptRenameInfo',
      'getTypeScriptRenameEdits',
      'getSignatureHelp',
      'getInlayHintEntries',
    ]) {
      excludedDocumentContext.service[methodName] = () => {
        excludedTypeScriptServiceCalls += 1
        throw new Error(`Excluded TypeScript feature should not call ${methodName}.`)
      }
    }
    const excludedTypeScriptFeatures = createTypeScriptFeatureService(excludedCustomContext.context)
    const excludedTypeScriptParams = {
      textDocument: { uri: excludedCustomUri },
      position: excludedCustomPosition,
      context: {
        includeDeclaration: true,
        triggerKind: 1,
      },
    }
    const excludedTypeScriptResults = [
      excludedTypeScriptFeatures.provideCompletionItems(excludedTypeScriptParams, { isCancellationRequested: false }),
      excludedTypeScriptFeatures.provideHover(excludedTypeScriptParams),
      excludedTypeScriptFeatures.provideDefinition(excludedTypeScriptParams),
      excludedTypeScriptFeatures.provideReferences(excludedTypeScriptParams),
      excludedTypeScriptFeatures.providePrepareRename(excludedTypeScriptParams),
      excludedTypeScriptFeatures.provideRename({ ...excludedTypeScriptParams, newName: 'renamedVendorValue' }),
      excludedTypeScriptFeatures.provideSignatureHelp(excludedTypeScriptParams),
      excludedTypeScriptFeatures.provideInlayHints({
        textDocument: { uri: excludedCustomUri },
        range: {
          start: excludedCustomDocument.positionAt(0),
          end: excludedCustomDocument.positionAt(excludedCustomText.length),
        },
      }),
    ]
    if (excludedTypeScriptResults.some((entry) => entry !== null)) {
      throw new Error(`Expected TypeScript features to skip excluded route-exposed vendor scripts. Got: ${JSON.stringify(excludedTypeScriptResults)}`)
    }
    if (excludedTypeScriptServiceCalls !== 0 || excludedTypeScriptPrepareCalls !== 0) {
      throw new Error(`Expected excluded TypeScript features to return before prepare/service calls. Got service=${excludedTypeScriptServiceCalls} prepare=${excludedTypeScriptPrepareCalls}`)
    }
    const excludedCodeActionFeatures = createDiagnosticsFeatureService(excludedCustomContext.context)
    const excludedCodeActions = excludedCodeActionFeatures.provideCodeActions({
      textDocument: { uri: excludedCustomUri },
      range: {
        start: excludedCustomDocument.positionAt(0),
        end: excludedCustomDocument.positionAt(0),
      },
      context: { diagnostics: [] },
    })
    if (excludedCodeActions !== null) {
      throw new Error(`Expected code actions to skip excluded route-exposed vendor scripts. Got: ${JSON.stringify(excludedCodeActions)}`)
    }

    const schemaOnlyText = `const boardService = require('../pages/_private/board-service')\nconst boards = $app.findRecordsByFilter('boards')\nboards.\n`
    const schemaOnlyDocument = createTestDocument(fixture.jobScriptFilePath, 'javascript', 1, schemaOnlyText)
    const schemaOnlyUri = schemaOnlyDocument.uri
    lspSmokeCore.openDocument({
      uri: schemaOnlyUri,
      languageId: 'javascript',
      version: 1,
      text: schemaOnlyText,
    })
    const schemaOnlyContext = createLspServiceSmokeContext(
      lspSmokeCore,
      new Map([[schemaOnlyUri, schemaOnlyDocument]])
    )
    schemaOnlyContext.context.helpers.isExcludedPocketPagesScriptPath = () => false
    schemaOnlyContext.context.helpers.isSchemaSupportOnlyHookScriptPath = (filePath) =>
      normalizeFilePath(filePath) === normalizeFilePath(fixture.jobScriptFilePath)
    const schemaOnlyFeatureDocumentContext = schemaOnlyContext.context.core.getDocumentContextByUri(schemaOnlyUri)
    if (!schemaOnlyFeatureDocumentContext || !schemaOnlyFeatureDocumentContext.service) {
      throw new Error('Expected schema-only hook script to resolve a document context for guarded LSP feature tests.')
    }
    const schemaOnlyCustomFeatures = createCustomFeatureService(schemaOnlyContext.context)
    const schemaOnlyRequirePosition = schemaOnlyDocument.positionAt(schemaOnlyText.indexOf('../pages/_private/board-service') + 5)
    const schemaOnlyRequireDefinition = schemaOnlyCustomFeatures.provideDefinition({
      textDocument: { uri: schemaOnlyUri },
      position: schemaOnlyRequirePosition,
    })
    if (!schemaOnlyRequireDefinition || normalizeFilePath(schemaOnlyRequireDefinition) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected schema-only custom definition to resolve static require(). Got: ${JSON.stringify(schemaOnlyRequireDefinition)}`)
    }
    const schemaOnlyRequireLinks = schemaOnlyCustomFeatures.provideDocumentLinks({
      textDocument: { uri: schemaOnlyUri },
    })
    if (
      !Array.isArray(schemaOnlyRequireLinks) ||
      schemaOnlyRequireLinks.length !== 1 ||
      schemaOnlyRequireLinks[0].target !== URI.file(fixture.boardServiceFilePath).toString() ||
      !String(schemaOnlyRequireLinks[0].tooltip || '').includes('Open require target')
    ) {
      throw new Error(`Expected schema-only document links to expose only static require(). Got: ${JSON.stringify(schemaOnlyRequireLinks)}`)
    }
    const schemaOnlyRequireReferences = schemaOnlyCustomFeatures.provideReferences({
      textDocument: { uri: schemaOnlyUri },
      position: schemaOnlyRequirePosition,
      context: { includeDeclaration: true },
    })
    if (
      !Array.isArray(schemaOnlyRequireReferences) ||
      !schemaOnlyRequireReferences.some((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.jobScriptFilePath))
    ) {
      throw new Error(`Expected schema-only custom references to include the hook require() caller. Got: ${JSON.stringify(schemaOnlyRequireReferences)}`)
    }
    let schemaOnlyTypeScriptServiceCalls = 0
    let schemaOnlyTypeScriptPrepareCalls = 0
    schemaOnlyContext.context.helpers.ensureDocumentPrepared = () => {
      schemaOnlyTypeScriptPrepareCalls += 1
      throw new Error('Schema-only TypeScript feature should not prepare virtual code.')
    }
    for (const methodName of [
      'getCompletionData',
      'getQuickInfo',
      'getTypeScriptDefinitionTarget',
      'getTypeScriptReferenceTargets',
      'getTypeScriptRenameInfo',
      'getTypeScriptRenameEdits',
      'getSignatureHelp',
      'getInlayHintEntries',
    ]) {
      schemaOnlyFeatureDocumentContext.service[methodName] = () => {
        schemaOnlyTypeScriptServiceCalls += 1
        throw new Error(`Schema-only TypeScript feature should not call ${methodName}.`)
      }
    }
    const schemaOnlyTypeScriptFeatures = createTypeScriptFeatureService(schemaOnlyContext.context)
    const schemaOnlyParams = {
      textDocument: { uri: schemaOnlyUri },
      position: schemaOnlyDocument.positionAt(schemaOnlyText.indexOf('boards.') + 'boards.'.length),
      context: {
        includeDeclaration: true,
        triggerKind: 1,
      },
    }
    const schemaOnlyTypeScriptResults = [
      schemaOnlyTypeScriptFeatures.provideCompletionItems(schemaOnlyParams, { isCancellationRequested: false }),
      schemaOnlyTypeScriptFeatures.provideHover(schemaOnlyParams),
      schemaOnlyTypeScriptFeatures.provideDefinition(schemaOnlyParams),
      schemaOnlyTypeScriptFeatures.provideReferences(schemaOnlyParams),
      schemaOnlyTypeScriptFeatures.providePrepareRename(schemaOnlyParams),
      schemaOnlyTypeScriptFeatures.provideRename({ ...schemaOnlyParams, newName: 'renamedBoards' }),
      schemaOnlyTypeScriptFeatures.provideSignatureHelp(schemaOnlyParams),
      schemaOnlyTypeScriptFeatures.provideInlayHints({
        textDocument: { uri: schemaOnlyUri },
        range: {
          start: schemaOnlyDocument.positionAt(0),
          end: schemaOnlyDocument.positionAt(schemaOnlyText.length),
        },
      }),
    ]
    if (schemaOnlyTypeScriptResults.some((entry) => entry !== null)) {
      throw new Error(`Expected TypeScript features to skip schema-only hook scripts. Got: ${JSON.stringify(schemaOnlyTypeScriptResults)}`)
    }
    if (schemaOnlyTypeScriptServiceCalls !== 0 || schemaOnlyTypeScriptPrepareCalls !== 0) {
      throw new Error(`Expected schema-only TypeScript features to return before prepare/service calls. Got service=${schemaOnlyTypeScriptServiceCalls} prepare=${schemaOnlyTypeScriptPrepareCalls}`)
    }
    const schemaOnlyCodeActionFeatures = createDiagnosticsFeatureService(schemaOnlyContext.context)
    const schemaOnlyCodeActions = schemaOnlyCodeActionFeatures.provideCodeActions({
      textDocument: { uri: schemaOnlyUri },
      range: {
        start: schemaOnlyDocument.positionAt(0),
        end: schemaOnlyDocument.positionAt(0),
      },
      context: { diagnostics: [] },
    })
    if (schemaOnlyCodeActions !== null) {
      throw new Error(`Expected code actions to skip schema-only hook scripts. Got: ${JSON.stringify(schemaOnlyCodeActions)}`)
    }

    const staticSignatureCore = new PocketPagesLanguageCore()
    const staticSignatureText = `<button data-label="Save (draft)"></button>\n`
    const staticSignatureDocument = createTestDocument(fixture.siteIndexFilePath, 'ejs', 2, staticSignatureText)
    const staticSignatureUri = staticSignatureDocument.uri
    staticSignatureCore.openDocument({
      uri: staticSignatureUri,
      languageId: 'ejs',
      version: staticSignatureDocument.version,
      text: staticSignatureText,
    })
    const staticSignatureContext = createLspServiceSmokeContext(
      staticSignatureCore,
      new Map([[staticSignatureUri, staticSignatureDocument]])
    )
    let staticSignaturePrepareCalls = 0
    staticSignatureContext.context.helpers.ensureDocumentPrepared = () => {
      staticSignaturePrepareCalls += 1
      throw new Error('Static EJS signature help should not prepare virtual code.')
    }
    const staticSignatureFeatures = createTypeScriptFeatureService(staticSignatureContext.context)
    const staticSignatureResult = staticSignatureFeatures.provideSignatureHelp({
      textDocument: { uri: staticSignatureUri },
      position: staticSignatureDocument.positionAt(staticSignatureText.indexOf('(draft)') + 1),
      context: { triggerCharacter: '(', isRetrigger: false },
    })
    if (staticSignatureResult !== null || staticSignaturePrepareCalls !== 0) {
      throw new Error(`Expected signature help to skip unmapped static EJS text before prepare. Got: ${JSON.stringify({ staticSignatureResult, staticSignaturePrepareCalls })}`)
    }
    const staticInlayResult = staticSignatureFeatures.provideInlayHints({
      textDocument: { uri: staticSignatureUri },
      range: {
        start: staticSignatureDocument.positionAt(0),
        end: staticSignatureDocument.positionAt(staticSignatureText.length),
      },
    })
    if (staticInlayResult !== null || staticSignaturePrepareCalls !== 0) {
      throw new Error(`Expected inlay hints to skip unmapped static EJS ranges before prepare. Got: ${JSON.stringify({ staticInlayResult, staticSignaturePrepareCalls })}`)
    }

    const diagnosticsSmokeCore = new PocketPagesLanguageCore()
    const diagnosticsSmokeText = `<a href="/missing"></a>\n<script server>\nresolve('/_private/board-service')\n</script>\n<div>ok</div>\n`
    const diagnosticsSmokeDocument = createTestDocument(fixture.boardsFilePath, 'ejs', 1, diagnosticsSmokeText)
    const diagnosticsSmokeUri = diagnosticsSmokeDocument.uri
    diagnosticsSmokeCore.openDocument({
      uri: diagnosticsSmokeUri,
      languageId: 'ejs',
      version: 1,
      text: diagnosticsSmokeText,
    })
    const diagnosticsSmokeContext = createLspServiceSmokeContext(
      diagnosticsSmokeCore,
      new Map([[diagnosticsSmokeUri, diagnosticsSmokeDocument]])
    )
    const diagnosticsFeatureService = createDiagnosticsFeatureService(diagnosticsSmokeContext.context)
    const diagnosticsSmokeReport = await diagnosticsFeatureService.providePullDiagnostics(
      { textDocument: { uri: diagnosticsSmokeUri } },
      { isCancellationRequested: false }
    )
    if (!diagnosticsSmokeReport || !Array.isArray(diagnosticsSmokeReport.items) || diagnosticsSmokeReport.items.length === 0) {
      throw new Error(`Expected diagnostics feature service to return mapper-filtered pull diagnostics. Got: ${JSON.stringify(diagnosticsSmokeReport)}`)
    }
    if (
      !diagnosticsSmokeReport.items.some((entry) =>
        ['pp-private-resolve-path', 'pp-resolve-private-prefix'].includes(String(entry.code))
      )
    ) {
      throw new Error(`Expected diagnostics feature service to keep resolve() path diagnostics reportable. Got: ${JSON.stringify(diagnosticsSmokeReport.items)}`)
    }
    if (!diagnosticsSmokeReport.items.some((entry) => String(entry.code) === 'pp-unresolved-route-path')) {
      throw new Error(`Expected diagnostics feature service to return route-path diagnostics from EJS markup. Got: ${JSON.stringify(diagnosticsSmokeReport.items)}`)
    }

    const normalEjsDiagnosticsCore = new PocketPagesLanguageCore()
    const normalEjsDiagnosticsText = `<script server>
const smallNormalValue = missingSmallNormalValue
</script>
<div><%= smallNormalValue %></div>
`
    const normalEjsDiagnosticsDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      2,
      normalEjsDiagnosticsText
    )
    const normalEjsDiagnosticsUri = normalEjsDiagnosticsDocument.uri
    normalEjsDiagnosticsCore.openDocument({
      uri: normalEjsDiagnosticsUri,
      languageId: 'ejs',
      version: normalEjsDiagnosticsDocument.version,
      text: normalEjsDiagnosticsText,
    })
    const normalEjsDiagnosticsRuntimeState = createDocumentRuntimeStateRegistry()
    normalEjsDiagnosticsRuntimeState.updateDocument(normalEjsDiagnosticsUri, {
      version: normalEjsDiagnosticsDocument.version,
      textLength: normalEjsDiagnosticsText.length,
      changed: true,
    })
    const normalEjsDiagnosticsContext = createLspServiceSmokeContext(
      normalEjsDiagnosticsCore,
      new Map([[normalEjsDiagnosticsUri, normalEjsDiagnosticsDocument]]),
      {
        runtimeState: normalEjsDiagnosticsRuntimeState,
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    const normalEjsSchedules = []
    const normalEjsPrepareCalls = []
    normalEjsDiagnosticsContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 1000
    normalEjsDiagnosticsContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS = 10000
    normalEjsDiagnosticsContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    normalEjsDiagnosticsContext.context.helpers.getPreferredDiagnosticOffset = () =>
      normalEjsDiagnosticsText.indexOf('missingSmallNormalValue')
    normalEjsDiagnosticsContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      normalEjsSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    normalEjsDiagnosticsContext.context.helpers.ensureDocumentPrepared = (uri, options = {}) => {
      normalEjsPrepareCalls.push({ uri, options })
      return normalEjsDiagnosticsCore.prepareDocument(uri, options)
    }
    const normalEjsDiagnosticsService = normalEjsDiagnosticsCore.getDocumentContextByUri(normalEjsDiagnosticsUri).service
    const originalNormalEjsGetDiagnostics = normalEjsDiagnosticsService.getDiagnostics.bind(normalEjsDiagnosticsService)
    const normalEjsDiagnosticOptions = []
    const normalEjsDiagnosticsFeatureService = createDiagnosticsFeatureService(
      normalEjsDiagnosticsContext.context
    )
    let normalEjsDiagnosticsReport = null
    try {
      normalEjsDiagnosticsService.getDiagnostics = (_filePath, _documentText, options = {}) => {
        normalEjsDiagnosticOptions.push(options)
        return originalNormalEjsGetDiagnostics(_filePath, _documentText, options)
      }
      normalEjsDiagnosticsReport = await normalEjsDiagnosticsFeatureService.providePullDiagnostics(
        { textDocument: { uri: normalEjsDiagnosticsUri } },
        { isCancellationRequested: false }
      )
    } finally {
      normalEjsDiagnosticsService.getDiagnostics = originalNormalEjsGetDiagnostics
    }
    if (
      !normalEjsDiagnosticsReport ||
      normalEjsDiagnosticsReport.kind !== 'full' ||
      normalEjsDiagnosticsReport.partialDiagnostics === true ||
      normalEjsDiagnosticsReport.budgetDeferred === true ||
      normalEjsSchedules.length !== 0 ||
      normalEjsPrepareCalls.length !== 1 ||
      normalEjsPrepareCalls[0].options.operation !== 'diagnostics-full' ||
      normalEjsPrepareCalls[0].options.skipUnrelatedRegions === true ||
      normalEjsDiagnosticOptions.length !== 1 ||
      normalEjsDiagnosticOptions[0].includeProjectRuleDiagnostics !== true ||
      normalEjsDiagnosticOptions[0].requirePreparedVirtualState !== true ||
      normalEjsDiagnosticOptions[0].semanticBudget !== null
    ) {
      throw new Error(
        `Expected normal EJS diagnostics to stay on the full non-partial path even with a recent edit and preferred offset. Got: ${JSON.stringify({
          normalEjsDiagnosticsReport,
          normalEjsSchedules,
          normalEjsPrepareCalls,
          normalEjsDiagnosticOptions: normalEjsDiagnosticOptions.map((options) => ({
            project: options.includeProjectRuleDiagnostics,
            requirePreparedVirtualState: options.requirePreparedVirtualState,
            semanticBudget: options.semanticBudget,
          })),
        })}`
      )
    }

    const cachedCodeActionCore = new PocketPagesLanguageCore()
    const cachedCodeActionText = `<script server>\nparams.sort\n</script>\n`
    const cachedCodeActionDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      cachedCodeActionText
    )
    cachedCodeActionCore.openDocument({
      uri: cachedCodeActionDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: cachedCodeActionText,
    })
    const cachedCodeActionContext = createLspServiceSmokeContext(
      cachedCodeActionCore,
      new Map([[cachedCodeActionDocument.uri, cachedCodeActionDocument]])
    )
    const cachedCodeActionFeatureService = createDiagnosticsFeatureService(cachedCodeActionContext.context)
    const cachedCodeActionReport = await cachedCodeActionFeatureService.providePullDiagnostics(
      { textDocument: { uri: cachedCodeActionDocument.uri } },
      { isCancellationRequested: false }
    )
    const cachedCodeActionDiagnostic =
      cachedCodeActionReport &&
      Array.isArray(cachedCodeActionReport.items)
        ? cachedCodeActionReport.items.find((entry) => String(entry.code) === 'pp-query-via-params')
        : null
    if (!cachedCodeActionDiagnostic) {
      throw new Error(`Expected cached code-action probe to publish params diagnostics. Got: ${JSON.stringify(cachedCodeActionReport)}`)
    }
    const cachedCodeActionDocumentContext = cachedCodeActionCore.getDocumentContextByUri(cachedCodeActionDocument.uri)
    const cachedCodeActionService = cachedCodeActionDocumentContext && cachedCodeActionDocumentContext.service
    const originalCachedCodeActionGetDiagnostics =
      cachedCodeActionService && typeof cachedCodeActionService.getDiagnostics === 'function'
        ? cachedCodeActionService.getDiagnostics.bind(cachedCodeActionService)
        : null
    if (!cachedCodeActionService || !originalCachedCodeActionGetDiagnostics) {
      throw new Error('Expected cached code-action smoke context to expose a language service.')
    }
    let cachedCodeActions = null
    try {
      cachedCodeActionService.getDiagnostics = () => {
        throw new Error('Expected code actions to reuse cached pull diagnostics instead of recomputing diagnostics.')
      }
      cachedCodeActions = cachedCodeActionFeatureService.provideCodeActions({
        textDocument: { uri: cachedCodeActionDocument.uri },
        range: cachedCodeActionDiagnostic.range,
        context: {
          diagnostics: [cachedCodeActionDiagnostic],
        },
      })
    } finally {
      cachedCodeActionService.getDiagnostics = originalCachedCodeActionGetDiagnostics
    }
    if (
      !Array.isArray(cachedCodeActions) ||
      !cachedCodeActions.some((entry) =>
        Array.isArray(entry.edit) &&
        entry.edit.some((edit) => edit.newText === 'request.url.query')
      )
    ) {
      throw new Error(`Expected cached pull diagnostics to drive params code actions. Got: ${JSON.stringify(cachedCodeActions)}`)
    }

    const noDiagnosticCodeActionCore = new PocketPagesLanguageCore()
    const noDiagnosticCodeActionText = `<script server>
let posts = []
posts = $app.findRecordsByFilter('posts', '')
const postTitle = posts[0].get('title')
</script>
`
    const noDiagnosticCodeActionDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      noDiagnosticCodeActionText
    )
    noDiagnosticCodeActionCore.openDocument({
      uri: noDiagnosticCodeActionDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: noDiagnosticCodeActionText,
    })
    const noDiagnosticCodeActionContext = createLspServiceSmokeContext(
      noDiagnosticCodeActionCore,
      new Map([[noDiagnosticCodeActionDocument.uri, noDiagnosticCodeActionDocument]])
    )
    const noDiagnosticCodeActionFeatureService = createDiagnosticsFeatureService(noDiagnosticCodeActionContext.context)
    const noDiagnosticDocumentContext = noDiagnosticCodeActionCore.getDocumentContextByUri(noDiagnosticCodeActionDocument.uri)
    const noDiagnosticService = noDiagnosticDocumentContext && noDiagnosticDocumentContext.service
    const originalNoDiagnosticGetDiagnostics =
      noDiagnosticService && typeof noDiagnosticService.getDiagnostics === 'function'
        ? noDiagnosticService.getDiagnostics.bind(noDiagnosticService)
        : null
    if (!noDiagnosticService || !originalNoDiagnosticGetDiagnostics) {
      throw new Error('Expected no-diagnostic code-action smoke context to expose a language service.')
    }
    const noDiagnosticOffset = noDiagnosticCodeActionText.indexOf('posts = []') + 2
    let noDiagnosticActions = null
    try {
      noDiagnosticService.getDiagnostics = () => {
        throw new Error('Expected no-diagnostic JSDoc code actions to avoid full diagnostics.')
      }
      noDiagnosticActions = noDiagnosticCodeActionFeatureService.provideCodeActions({
        textDocument: { uri: noDiagnosticCodeActionDocument.uri },
        range: {
          start: offsetToPosition(noDiagnosticCodeActionText, noDiagnosticOffset),
          end: offsetToPosition(noDiagnosticCodeActionText, noDiagnosticOffset),
        },
        context: {
          diagnostics: [],
        },
      })
    } finally {
      noDiagnosticService.getDiagnostics = originalNoDiagnosticGetDiagnostics
    }
    if (
      !Array.isArray(noDiagnosticActions) ||
      !noDiagnosticActions.some((entry) =>
        entry.title === 'Add JSDoc type for posts' &&
        Array.isArray(entry.edit) &&
        entry.edit.some((edit) => edit.newText.includes('PocketPagesRecordArray<"posts">'))
      )
    ) {
      throw new Error(`Expected no-diagnostic JSDoc type code action through the LSP service path. Got: ${JSON.stringify(noDiagnosticActions)}`)
    }

    const largeDiagnosticsCore = new PocketPagesLanguageCore()
    const largeDiagnosticsText = `<script server>\n${'const value = 1\n'.repeat(80)}</script>\n`
    const largeDiagnosticsDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      largeDiagnosticsText
    )
    const largeDiagnosticsUri = largeDiagnosticsDocument.uri
    largeDiagnosticsCore.openDocument({
      uri: largeDiagnosticsUri,
      languageId: 'ejs',
      version: 1,
      text: largeDiagnosticsText,
    })
    const largeDiagnosticsContext = createLspServiceSmokeContext(
      largeDiagnosticsCore,
      new Map([[largeDiagnosticsUri, largeDiagnosticsDocument]])
    )
    const largeDocumentContext = largeDiagnosticsCore.getDocumentContextByUri(largeDiagnosticsUri)
    const largeService = largeDocumentContext && largeDocumentContext.service
    const originalLargeGetDiagnostics =
      largeService && typeof largeService.getDiagnostics === 'function'
        ? largeService.getDiagnostics.bind(largeService)
        : null
    if (!largeService || !originalLargeGetDiagnostics) {
      throw new Error('Expected large diagnostics smoke context to expose a language service.')
    }
    const largePullDiagnosticsCalls = []
    largeService.getDiagnostics = (_filePath, _documentText, options = {}) => {
      largePullDiagnosticsCalls.push({
        semantic: options.includeSemanticDiagnostics !== false,
        project: options.includeProjectRuleDiagnostics !== false,
        ts: options.includeTypeScriptDiagnostics !== false,
        server: options.includeServerBlockDiagnostics !== false,
        template: options.includeTemplateDiagnostics !== false,
        scriptSchema: options.includeScriptSchemaDiagnostics !== false,
      })
      return [
        {
          code: 'large-pull-diagnostics',
          category: ts.DiagnosticCategory.Error,
          message: 'large pull diagnostics',
          start: largeDiagnosticsText.indexOf('value'),
          end: largeDiagnosticsText.indexOf('value') + 'value'.length,
        },
      ]
    }
    const largeDiagnosticsFeatureService = createDiagnosticsFeatureService(
      largeDiagnosticsContext.context
    )
    let largePullDiagnosticsReport = null
    let largePullDiagnosticsUnchangedReport = null
    let largePullDiagnosticsInvalidatedReport = null
    const originalLargePagesContentVersion = largeService.projectIndex.pagesContentVersion
    try {
      largePullDiagnosticsReport = await largeDiagnosticsFeatureService.providePullDiagnostics(
        { textDocument: { uri: largeDiagnosticsUri } },
        { isCancellationRequested: false }
      )
      largePullDiagnosticsUnchangedReport = await largeDiagnosticsFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: largeDiagnosticsUri },
          previousResultId: largePullDiagnosticsReport && largePullDiagnosticsReport.resultId,
        },
        { isCancellationRequested: false }
      )
      largeService.projectIndex.pagesContentVersion += 1
      largePullDiagnosticsInvalidatedReport = await largeDiagnosticsFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: largeDiagnosticsUri },
          previousResultId: largePullDiagnosticsReport && largePullDiagnosticsReport.resultId,
        },
        { isCancellationRequested: false }
      )
    } finally {
      largeService.getDiagnostics = originalLargeGetDiagnostics
      largeService.projectIndex.pagesContentVersion = originalLargePagesContentVersion
    }
    if (
      !largePullDiagnosticsReport ||
      largePullDiagnosticsReport.kind !== 'full' ||
      typeof largePullDiagnosticsReport.resultId !== 'string' ||
      !Array.isArray(largePullDiagnosticsReport.items) ||
      largePullDiagnosticsReport.items[0].code !== 'large-pull-diagnostics' ||
      !largePullDiagnosticsUnchangedReport ||
      largePullDiagnosticsUnchangedReport.kind !== 'unchanged' ||
      largePullDiagnosticsUnchangedReport.resultId !== largePullDiagnosticsReport.resultId ||
      !largePullDiagnosticsInvalidatedReport ||
      largePullDiagnosticsInvalidatedReport.kind !== 'full' ||
      largePullDiagnosticsInvalidatedReport.resultId === largePullDiagnosticsReport.resultId ||
      largePullDiagnosticsCalls.length !== 2 ||
      largePullDiagnosticsCalls[0].semantic !== true ||
      largePullDiagnosticsCalls[0].project !== true ||
      largePullDiagnosticsCalls[0].ts !== true ||
      largePullDiagnosticsCalls[0].server !== true ||
      largePullDiagnosticsCalls[0].template !== true ||
      largePullDiagnosticsCalls[0].scriptSchema !== true
    ) {
      throw new Error(
        `Expected pull diagnostics to cache resultId, return unchanged for repeated pulls, and invalidate on lane-relevant project changes. Got: ${JSON.stringify({ largePullDiagnosticsReport, largePullDiagnosticsUnchangedReport, largePullDiagnosticsInvalidatedReport, largePullDiagnosticsCalls })}`
      )
    }

    const stableResultIdCore = new PocketPagesLanguageCore()
    const stableResultIdText = `<script server>\nconst stableResultIdValue = 1\nstableResultIdValue.toFixed()\n</script>\n`
    const stableResultIdDocumentV1 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      stableResultIdText
    )
    const stableResultIdUri = stableResultIdDocumentV1.uri
    stableResultIdCore.openDocument({
      uri: stableResultIdUri,
      languageId: 'ejs',
      version: 1,
      text: stableResultIdText,
    })
    const stableResultIdDocuments = new Map([[stableResultIdUri, stableResultIdDocumentV1]])
    const stableResultIdContext = createLspServiceSmokeContext(
      stableResultIdCore,
      stableResultIdDocuments
    )
    const stableResultIdDocumentContext = stableResultIdCore.getDocumentContextByUri(stableResultIdUri)
    const stableResultIdService = stableResultIdDocumentContext && stableResultIdDocumentContext.service
    const originalStableResultIdGetDiagnostics =
      stableResultIdService && typeof stableResultIdService.getDiagnostics === 'function'
        ? stableResultIdService.getDiagnostics.bind(stableResultIdService)
        : null
    if (!stableResultIdService || !originalStableResultIdGetDiagnostics) {
      throw new Error('Expected stable resultId smoke context to expose a language service.')
    }
    let stableResultIdDiagnosticCalls = 0
    stableResultIdService.getDiagnostics = () => {
      stableResultIdDiagnosticCalls += 1
      return []
    }
    const stableResultIdFeatureService = createDiagnosticsFeatureService(
      stableResultIdContext.context
    )
    let stableResultIdFirstReport = null
    let stableResultIdSecondReport = null
    try {
      stableResultIdFirstReport = await stableResultIdFeatureService.providePullDiagnostics(
        { textDocument: { uri: stableResultIdUri } },
        { isCancellationRequested: false }
      )
      stableResultIdCore.updateDocument({
        uri: stableResultIdUri,
        languageId: 'ejs',
        version: 2,
        text: stableResultIdText,
      })
      stableResultIdDocuments.set(
        stableResultIdUri,
        createTestDocument(fixture.boardsFilePath, 'ejs', 2, stableResultIdText)
      )
      stableResultIdSecondReport = await stableResultIdFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: stableResultIdUri },
          previousResultId: stableResultIdFirstReport && stableResultIdFirstReport.resultId,
        },
        { isCancellationRequested: false }
      )
    } finally {
      stableResultIdService.getDiagnostics = originalStableResultIdGetDiagnostics
    }
    if (
      !stableResultIdFirstReport ||
      stableResultIdFirstReport.kind !== 'full' ||
      !stableResultIdSecondReport ||
      stableResultIdSecondReport.kind !== 'unchanged' ||
      stableResultIdSecondReport.resultId !== stableResultIdFirstReport.resultId ||
      stableResultIdDiagnosticCalls !== 1
    ) {
      throw new Error(
        `Expected unchanged pull diagnostics to use stable snapshot identity across LSP version-only updates. Got: ${JSON.stringify({
          stableResultIdFirstReport,
          stableResultIdSecondReport,
          stableResultIdDiagnosticCalls,
        })}`
      )
    }

    const laneReuseCore = new PocketPagesLanguageCore()
    const laneReuseText = `<script server>
const laneReuseValue = 1
laneReuseValue.toFixed()
</script>
<div><%= laneReuseValue %></div>
`
    const laneReuseDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      laneReuseText
    )
    laneReuseCore.openDocument({
      uri: laneReuseDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: laneReuseText,
    })
    const laneReuseContext = laneReuseCore.getDocumentContextByUri(laneReuseDocument.uri)
    const laneReuseService = laneReuseContext && laneReuseContext.service
    if (!laneReuseService) {
      throw new Error('Expected lane reuse smoke context to expose a language service.')
    }
    const laneReuseFirstMetadata = laneReuseService.getDiagnosticsLaneMetadata(
      fixture.boardsFilePath,
      laneReuseText
    )
    const laneReuseFirstResultIds = laneReuseService.getDiagnosticsLaneResultIds(
      fixture.boardsFilePath,
      laneReuseText,
      { laneMetadata: laneReuseFirstMetadata }
    )
    const laneReuseFirstDiagnosticsByLane = {}
    laneReuseService.getDiagnostics(fixture.boardsFilePath, laneReuseText, {
      currentLaneResultIds: laneReuseFirstResultIds,
      currentLaneMetadata: laneReuseFirstMetadata,
      laneDiagnosticsOut: laneReuseFirstDiagnosticsByLane,
    })
    if (
      !Array.isArray(laneReuseFirstDiagnosticsByLane.server) ||
      !Array.isArray(laneReuseFirstDiagnosticsByLane.template) ||
      !Array.isArray(laneReuseFirstDiagnosticsByLane['script-schema']) ||
      !Array.isArray(laneReuseFirstDiagnosticsByLane['project-rule'])
    ) {
      throw new Error(`Expected diagnostics to expose per-lane cached diagnostics. Got: ${JSON.stringify(laneReuseFirstDiagnosticsByLane)}`)
    }
    const originalLaneReuseServerDiagnostics = laneReuseService.collectServerBlockDiagnostics.bind(laneReuseService)
    const originalLaneReuseTemplateDiagnostics = laneReuseService.collectTemplateDiagnostics.bind(laneReuseService)
    const originalLaneReuseScriptSchemaDiagnostics = laneReuseService.collectScriptSchemaDiagnostics.bind(laneReuseService)
    const originalLaneReuseProjectRuleAgentsDiagnostics = laneReuseService.collectProjectRuleAgentsDiagnostics.bind(laneReuseService)
    const originalLaneReuseProjectRuleIncludeCallerDiagnostics = laneReuseService.collectProjectRuleIncludeCallerDiagnostics.bind(laneReuseService)
    let laneReuseProjectRuleAgentsCalls = 0
    let laneReuseProjectRuleIncludeCallerCalls = 0
    try {
      laneReuseService.collectServerBlockDiagnostics = () => {
        throw new Error('Expected unchanged server diagnostics lane to be reused.')
      }
      laneReuseService.collectTemplateDiagnostics = () => {
        throw new Error('Expected unchanged template diagnostics lane to be reused.')
      }
      laneReuseService.collectScriptSchemaDiagnostics = () => {
        throw new Error('Expected unchanged script-schema diagnostics lane to be reused.')
      }
      laneReuseService.collectProjectRuleAgentsDiagnostics = function collectChangedProjectRuleAgentsLane(...args) {
        laneReuseProjectRuleAgentsCalls += 1
        return originalLaneReuseProjectRuleAgentsDiagnostics(...args)
      }
      laneReuseService.collectProjectRuleIncludeCallerDiagnostics = function collectReusedProjectRuleIncludeLane(...args) {
        laneReuseProjectRuleIncludeCallerCalls += 1
        return originalLaneReuseProjectRuleIncludeCallerDiagnostics(...args)
      }
      const laneReuseSecondResultIds = {
        ...laneReuseFirstResultIds,
        'project-rule:agents': `${laneReuseFirstResultIds['project-rule:agents']}|changed`,
      }
      const laneReuseProfile = {}
      laneReuseService.getDiagnostics(fixture.boardsFilePath, laneReuseText, {
        currentLaneResultIds: laneReuseSecondResultIds,
        currentLaneMetadata: laneReuseFirstMetadata,
        previousLaneResultIds: laneReuseFirstResultIds,
        previousLaneMetadata: laneReuseFirstMetadata,
        previousLaneDiagnostics: laneReuseFirstDiagnosticsByLane,
        laneDiagnosticsOut: {},
        profile: laneReuseProfile,
      })
      if (
        laneReuseProjectRuleAgentsCalls !== 1 ||
        laneReuseProjectRuleIncludeCallerCalls !== 0 ||
        !Array.isArray(laneReuseProfile.reusedDiagnosticLanes) ||
        !laneReuseProfile.reusedDiagnosticLanes.includes('server') ||
        !laneReuseProfile.reusedDiagnosticLanes.includes('template') ||
        !laneReuseProfile.reusedDiagnosticLanes.includes('script-schema') ||
        !laneReuseProfile.reusedDiagnosticLanes.includes('project-rule:include-callers') ||
        laneReuseProfile.reusedDiagnosticLanes.includes('project-rule:agents')
      ) {
        throw new Error(`Expected diagnostics lane cache to recompute only the changed sublane. Got: ${JSON.stringify({ laneReuseProjectRuleAgentsCalls, laneReuseProjectRuleIncludeCallerCalls, laneReuseProfile })}`)
      }
    } finally {
      laneReuseService.collectServerBlockDiagnostics = originalLaneReuseServerDiagnostics
      laneReuseService.collectTemplateDiagnostics = originalLaneReuseTemplateDiagnostics
      laneReuseService.collectScriptSchemaDiagnostics = originalLaneReuseScriptSchemaDiagnostics
      laneReuseService.collectProjectRuleAgentsDiagnostics = originalLaneReuseProjectRuleAgentsDiagnostics
      laneReuseService.collectProjectRuleIncludeCallerDiagnostics = originalLaneReuseProjectRuleIncludeCallerDiagnostics
    }

    const dependencyLaneCore = new PocketPagesLanguageCore()
    const dependencyLaneText = `<script server>
const boardService = resolve('board-service')
boardService.readAuthState({ request })
</script>
`
    const dependencyLaneUri = URI.file(fixture.boardsFilePath).toString()
    dependencyLaneCore.openDocument({
      uri: dependencyLaneUri,
      languageId: 'ejs',
      version: 1,
      text: dependencyLaneText,
    })
    const dependencyLaneContext = dependencyLaneCore.getDocumentContextByUri(dependencyLaneUri)
    const dependencyLaneService = dependencyLaneContext && dependencyLaneContext.service
    if (!dependencyLaneService) {
      throw new Error('Expected dependency lane smoke context to expose a language service.')
    }
    const dependencyLaneFirstMetadata = dependencyLaneService.getDiagnosticsLaneMetadata(
      fixture.boardsFilePath,
      dependencyLaneText
    )
    const dependencyLaneFirstResultIds = dependencyLaneService.getDiagnosticsLaneResultIds(
      fixture.boardsFilePath,
      dependencyLaneText,
      { laneMetadata: dependencyLaneFirstMetadata }
    )
    const originalBoardServiceText = fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
    try {
      writeFile(
        fixture.boardServiceFilePath,
        `${originalBoardServiceText}
module.exports.__diagnosticsLaneProbe = 1
`
      )
      dependencyLaneService.invalidateManagedFile(fixture.boardServiceFilePath, { type: 'change' })
      const dependencyLaneSecondMetadata = dependencyLaneService.getDiagnosticsLaneMetadata(
        fixture.boardsFilePath,
        dependencyLaneText
      )
      const dependencyLaneSecondResultIds = dependencyLaneService.getDiagnosticsLaneResultIds(
        fixture.boardsFilePath,
        dependencyLaneText,
        { laneMetadata: dependencyLaneSecondMetadata }
      )
      if (
        dependencyLaneSecondResultIds.server === dependencyLaneFirstResultIds.server ||
        dependencyLaneSecondResultIds.template === dependencyLaneFirstResultIds.template
      ) {
        throw new Error(
          `Expected resolved module changes to invalidate TypeScript diagnostics lanes. Got: ${JSON.stringify({
            firstServer: dependencyLaneFirstResultIds.server,
            secondServer: dependencyLaneSecondResultIds.server,
            firstTemplate: dependencyLaneFirstResultIds.template,
            secondTemplate: dependencyLaneSecondResultIds.template,
          })}`
        )
      }
    } finally {
      writeFile(fixture.boardServiceFilePath, originalBoardServiceText)
      dependencyLaneService.invalidateManagedFile(fixture.boardServiceFilePath, { type: 'change' })
    }

    const regionRemapCore = new PocketPagesLanguageCore()
    const regionRemapText = `<script server>
missingRegionValue.toString()
</script>
`
    const regionRemapDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      regionRemapText
    )
    regionRemapCore.openDocument({
      uri: regionRemapDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: regionRemapText,
    })
    const regionRemapContext = regionRemapCore.getDocumentContextByUri(regionRemapDocument.uri)
    const regionRemapService = regionRemapContext && regionRemapContext.service
    if (!regionRemapService) {
      throw new Error('Expected region-remap smoke context to expose a language service.')
    }
    const regionRemapFirstMetadata = regionRemapService.getDiagnosticsLaneMetadata(
      fixture.boardsFilePath,
      regionRemapText
    )
    const regionRemapFirstResultIds = regionRemapService.getDiagnosticsLaneResultIds(
      fixture.boardsFilePath,
      regionRemapText,
      { laneMetadata: regionRemapFirstMetadata }
    )
    const regionRemapFirstDiagnosticsByLane = {}
    regionRemapService.getDiagnostics(fixture.boardsFilePath, regionRemapText, {
      currentLaneResultIds: regionRemapFirstResultIds,
      currentLaneMetadata: regionRemapFirstMetadata,
      laneDiagnosticsOut: regionRemapFirstDiagnosticsByLane,
    })
    const regionRemapFirstDiagnostic = regionRemapFirstDiagnosticsByLane.server.find(
      (entry) => entry.code === 2304 && String(entry.message).includes('missingRegionValue')
    )
    if (!regionRemapFirstDiagnostic) {
      throw new Error(`Expected first server diagnostics to include missingRegionValue. Got: ${JSON.stringify(regionRemapFirstDiagnosticsByLane.server)}`)
    }
    const regionRemapPrefix = '<div>plain html shift</div>\n'
    const regionRemapShiftedText = `${regionRemapPrefix}${regionRemapText}`
    regionRemapCore.updateDocument({
      uri: regionRemapDocument.uri,
      languageId: 'ejs',
      version: 2,
      text: regionRemapShiftedText,
    })
    const regionRemapSecondMetadata = regionRemapService.getDiagnosticsLaneMetadata(
      fixture.boardsFilePath,
      regionRemapShiftedText
    )
    const regionRemapSecondResultIds = regionRemapService.getDiagnosticsLaneResultIds(
      fixture.boardsFilePath,
      regionRemapShiftedText,
      { laneMetadata: regionRemapSecondMetadata }
    )
    if (regionRemapSecondResultIds.server !== regionRemapFirstResultIds.server) {
      throw new Error(`Expected unchanged server region diagnostics resultId to survive source shifts. Got: ${JSON.stringify({ before: regionRemapFirstResultIds.server, after: regionRemapSecondResultIds.server })}`)
    }
    const originalRegionRemapServerDiagnostics = regionRemapService.collectServerBlockDiagnostics.bind(regionRemapService)
    try {
      regionRemapService.collectServerBlockDiagnostics = () => {
        throw new Error('Expected shifted unchanged server region diagnostics to be remapped from cache.')
      }
      const regionRemapProfile = {}
      const regionRemapSecondDiagnostics = regionRemapService.getDiagnostics(
        fixture.boardsFilePath,
        regionRemapShiftedText,
        {
          currentLaneResultIds: regionRemapSecondResultIds,
          currentLaneMetadata: regionRemapSecondMetadata,
          previousLaneResultIds: regionRemapFirstResultIds,
          previousLaneMetadata: regionRemapFirstMetadata,
          previousLaneDiagnostics: regionRemapFirstDiagnosticsByLane,
          laneDiagnosticsOut: {},
          profile: regionRemapProfile,
        }
      )
      const regionRemapSecondDiagnostic = regionRemapSecondDiagnostics.find(
        (entry) => entry.code === 2304 && String(entry.message).includes('missingRegionValue')
      )
      if (
        !regionRemapSecondDiagnostic ||
        regionRemapSecondDiagnostic.start !== regionRemapFirstDiagnostic.start + regionRemapPrefix.length ||
        !Array.isArray(regionRemapProfile.reusedDiagnosticLanes) ||
        !regionRemapProfile.reusedDiagnosticLanes.includes('server')
      ) {
        throw new Error(
          `Expected cached server diagnostics to remap to the shifted source region. Got: ${JSON.stringify({ regionRemapSecondDiagnostic, regionRemapProfile })}`
        )
      }
    } finally {
      regionRemapService.collectServerBlockDiagnostics = originalRegionRemapServerDiagnostics
    }

    const serverRegionCacheCore = new PocketPagesLanguageCore()
    const serverRegionCacheText = `<script server>
const unchangedServerRegion = 1
</script>
<script server>
missingServerRegionOne.toString()
</script>
`
    const serverRegionCacheDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      serverRegionCacheText
    )
    serverRegionCacheCore.openDocument({
      uri: serverRegionCacheDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: serverRegionCacheText,
    })
    const serverRegionCacheContext = serverRegionCacheCore.getDocumentContextByUri(serverRegionCacheDocument.uri)
    const serverRegionCacheService = serverRegionCacheContext && serverRegionCacheContext.service
    if (!serverRegionCacheService) {
      throw new Error('Expected server-region cache smoke context to expose a language service.')
    }
    const serverRegionCacheFirstMetadata = serverRegionCacheService.getDiagnosticsLaneMetadata(
      fixture.boardsFilePath,
      serverRegionCacheText
    )
    const serverRegionCacheFirstResultIds = serverRegionCacheService.getDiagnosticsLaneResultIds(
      fixture.boardsFilePath,
      serverRegionCacheText,
      { laneMetadata: serverRegionCacheFirstMetadata }
    )
    const serverRegionCacheFirstDiagnosticsByLane = {}
    serverRegionCacheService.getDiagnostics(fixture.boardsFilePath, serverRegionCacheText, {
      currentLaneResultIds: serverRegionCacheFirstResultIds,
      currentLaneMetadata: serverRegionCacheFirstMetadata,
      laneDiagnosticsOut: serverRegionCacheFirstDiagnosticsByLane,
    })
    const serverRegionCacheChangedText = serverRegionCacheText.replace(
      'missingServerRegionOne',
      'missingServerRegionTwo'
    )
    serverRegionCacheCore.updateDocument({
      uri: serverRegionCacheDocument.uri,
      languageId: 'ejs',
      version: 2,
      text: serverRegionCacheChangedText,
    })
    const serverRegionCacheSecondMetadata = serverRegionCacheService.getDiagnosticsLaneMetadata(
      fixture.boardsFilePath,
      serverRegionCacheChangedText
    )
    const serverRegionCacheSecondResultIds = serverRegionCacheService.getDiagnosticsLaneResultIds(
      fixture.boardsFilePath,
      serverRegionCacheChangedText,
      { laneMetadata: serverRegionCacheSecondMetadata }
    )
    const originalServerRegionSemanticDiagnostics = serverRegionCacheService.languageService.getSemanticDiagnostics.bind(
      serverRegionCacheService.languageService
    )
    let serverRegionSemanticCalls = 0
    try {
      serverRegionCacheService.languageService.getSemanticDiagnostics = function countServerRegionSemanticDiagnostics(...args) {
        serverRegionSemanticCalls += 1
        return originalServerRegionSemanticDiagnostics(...args)
      }
      const serverRegionCacheProfile = {}
      const serverRegionCacheDiagnostics = serverRegionCacheService.getDiagnostics(
        fixture.boardsFilePath,
        serverRegionCacheChangedText,
        {
          currentLaneResultIds: serverRegionCacheSecondResultIds,
          currentLaneMetadata: serverRegionCacheSecondMetadata,
          previousLaneResultIds: serverRegionCacheFirstResultIds,
          previousLaneMetadata: serverRegionCacheFirstMetadata,
          previousLaneDiagnostics: serverRegionCacheFirstDiagnosticsByLane,
          laneDiagnosticsOut: {},
          profile: serverRegionCacheProfile,
        }
      )
      if (
        serverRegionSemanticCalls !== 1 ||
        !Array.isArray(serverRegionCacheProfile.reusedDiagnosticRegions) ||
        !serverRegionCacheProfile.reusedDiagnosticRegions.some((regionId) => String(regionId).startsWith('server:')) ||
        !serverRegionCacheDiagnostics.some((entry) => String(entry.message).includes('missingServerRegionTwo'))
      ) {
        throw new Error(
          `Expected unchanged server region diagnostics to reuse cache and compute only the dirty block. Got: ${JSON.stringify({ serverRegionSemanticCalls, serverRegionCacheProfile, serverRegionCacheDiagnostics: serializeDiagnostics(serverRegionCacheDiagnostics) })}`
        )
      }
    } finally {
      serverRegionCacheService.languageService.getSemanticDiagnostics = originalServerRegionSemanticDiagnostics
    }

    const yieldCancelCore = new PocketPagesLanguageCore()
    const yieldCancelText = `<script server>\nconst yieldCancelValue = 1\n</script>\n`
    const yieldCancelDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      yieldCancelText
    )
    yieldCancelCore.openDocument({
      uri: yieldCancelDocument.uri,
      languageId: 'ejs',
      version: 1,
      text: yieldCancelText,
    })
    const yieldCancelContext = createLspServiceSmokeContext(
      yieldCancelCore,
      new Map([[yieldCancelDocument.uri, yieldCancelDocument]])
    )
    yieldCancelContext.context.helpers.PULL_DIAGNOSTICS_INITIAL_YIELD_MS = 1
    const yieldCancelDocumentContext = yieldCancelCore.getDocumentContextByUri(yieldCancelDocument.uri)
    const yieldCancelService = yieldCancelDocumentContext && yieldCancelDocumentContext.service
    const originalYieldCancelGetDiagnostics =
      yieldCancelService && typeof yieldCancelService.getDiagnostics === 'function'
        ? yieldCancelService.getDiagnostics.bind(yieldCancelService)
        : null
    const originalYieldCancelEnsureDocumentPrepared = yieldCancelContext.context.helpers.ensureDocumentPrepared
    if (!yieldCancelService || !originalYieldCancelGetDiagnostics) {
      throw new Error('Expected yield cancellation smoke context to expose a language service.')
    }
    yieldCancelContext.context.helpers.ensureDocumentPrepared = () => {
      throw new Error('Expected pull diagnostics cancellation before prepare to skip virtual document preparation.')
    }
    yieldCancelService.getDiagnostics = () => {
      throw new Error('Expected pull diagnostics cancellation after initial yield to skip heavy diagnostics.')
    }
    const yieldCancelDiagnosticsFeatureService = createDiagnosticsFeatureService(
      yieldCancelContext.context
    )
    const yieldCancelToken = { isCancellationRequested: false }
    let yieldCancelReport = null
    try {
      const yieldCancelPromise = yieldCancelDiagnosticsFeatureService.providePullDiagnostics(
        { textDocument: { uri: yieldCancelDocument.uri } },
        yieldCancelToken
      )
      yieldCancelToken.isCancellationRequested = true
      yieldCancelReport = await yieldCancelPromise
    } finally {
      yieldCancelService.getDiagnostics = originalYieldCancelGetDiagnostics
      yieldCancelContext.context.helpers.ensureDocumentPrepared = originalYieldCancelEnsureDocumentPrepared
    }
    if (yieldCancelReport !== null) {
      throw new Error(`Expected pull diagnostics to return null when cancelled after initial yield. Got: ${JSON.stringify(yieldCancelReport)}`)
    }

    const quietLargeDiagnosticsCore = new PocketPagesLanguageCore()
    const quietLargeDiagnosticsText = `<script server>\n${'const quietValue = 1\n'.repeat(80)}</script>\n`
    const quietLargeDiagnosticsDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      7,
      quietLargeDiagnosticsText
    )
    const quietLargeDiagnosticsUri = quietLargeDiagnosticsDocument.uri
    quietLargeDiagnosticsCore.openDocument({
      uri: quietLargeDiagnosticsUri,
      languageId: 'ejs',
      version: quietLargeDiagnosticsDocument.version,
      text: quietLargeDiagnosticsText,
    })
    const quietRuntimeState = createDocumentRuntimeStateRegistry()
    quietRuntimeState.updateDocument(quietLargeDiagnosticsUri, {
      version: quietLargeDiagnosticsDocument.version,
      textLength: quietLargeDiagnosticsText.length,
      changed: true,
    })
    const quietLargeDiagnosticsContext = createLspServiceSmokeContext(
      quietLargeDiagnosticsCore,
      new Map([[quietLargeDiagnosticsUri, quietLargeDiagnosticsDocument]]),
      { runtimeState: quietRuntimeState }
    )
    const quietLargeDocumentContext = quietLargeDiagnosticsCore.getDocumentContextByUri(quietLargeDiagnosticsUri)
    const quietLargeService = quietLargeDocumentContext && quietLargeDocumentContext.service
    const originalQuietLargeGetDiagnostics =
      quietLargeService && typeof quietLargeService.getDiagnostics === 'function'
        ? quietLargeService.getDiagnostics.bind(quietLargeService)
        : null
    if (!quietLargeService || !originalQuietLargeGetDiagnostics) {
      throw new Error('Expected quiet large diagnostics smoke context to expose a language service.')
    }
    const quietLargeSchedules = []
    quietLargeDiagnosticsContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 1000
    quietLargeDiagnosticsContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS = 10000
    quietLargeDiagnosticsContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    quietLargeDiagnosticsContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      quietLargeSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    let quietLargePrepareCalls = 0
    quietLargeDiagnosticsContext.context.helpers.ensureDocumentPrepared = () => {
      quietLargePrepareCalls += 1
      throw new Error('Expected recent large-file pull diagnostics to defer before preparing virtual state.')
    }
    quietLargeDiagnosticsContext.context.connection.languages = {
      diagnostics: {
        refresh() {},
      },
    }
    quietLargeService.getDiagnosticsLaneMetadata = () => {
      throw new Error('Expected recent large-file pull diagnostics to defer before computing lane metadata.')
    }
    quietLargeService.getDiagnostics = () => {
      throw new Error('Expected recent large-file pull diagnostics to defer heavy diagnostics.')
    }
    const quietLargeDiagnosticsFeatureService = createDiagnosticsFeatureService(
      quietLargeDiagnosticsContext.context
    )
    let quietLargeDiagnosticsReport = null
    try {
      quietLargeDiagnosticsReport = await quietLargeDiagnosticsFeatureService.providePullDiagnostics(
        { textDocument: { uri: quietLargeDiagnosticsUri } },
        { isCancellationRequested: false }
      )
    } finally {
      quietLargeService.getDiagnostics = originalQuietLargeGetDiagnostics
    }
    if (
      !quietLargeDiagnosticsReport ||
      quietLargeDiagnosticsReport.kind !== 'full' ||
      quietLargeDiagnosticsReport.items.length !== 0 ||
      quietLargePrepareCalls !== 0 ||
      quietLargeSchedules.length !== 1 ||
      quietLargeSchedules[0].uri !== 'workspace' ||
      quietLargeSchedules[0].key !== 'diagnostics:refresh' ||
      quietLargeSchedules[0].delayMs <= 0
    ) {
      throw new Error(
        `Expected recent large-file pull diagnostics to return immediately and schedule a refresh. Got: ${JSON.stringify({ quietLargeDiagnosticsReport, quietLargePrepareCalls, quietLargeSchedules })}`
      )
    }
    if (quietRuntimeState.getDiagnostics(quietLargeDiagnosticsUri, 'pull')) {
      throw new Error('Expected deferred large-file diagnostics not to cache an empty quiet result as the real pull result.')
    }

    const openWarmupCore = new PocketPagesLanguageCore()
    const openWarmupText = `<script server>
missingOpenWarmup.toString()
</script>
${'<div>open warmup filler</div>\n'.repeat(4)}
`
    const openWarmupDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      openWarmupText
    )
    const openWarmupUri = openWarmupDocument.uri
    openWarmupCore.openDocument({
      uri: openWarmupUri,
      languageId: 'ejs',
      version: 1,
      text: openWarmupText,
    })
    const openWarmupRuntimeState = createDocumentRuntimeStateRegistry()
    openWarmupRuntimeState.updateDocument(openWarmupUri, {
      version: 1,
      textLength: openWarmupText.length,
      opened: true,
    })
    const openWarmupSchedules = []
    const openWarmupContext = createLspServiceSmokeContext(
      openWarmupCore,
      new Map([[openWarmupUri, openWarmupDocument]]),
      {
        runtimeState: openWarmupRuntimeState,
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    openWarmupContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50
    openWarmupContext.context.helpers.FIRST_REQUEST_WARMUP_IDLE_MS = 10000
    openWarmupContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    openWarmupContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      openWarmupSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    openWarmupContext.context.helpers.ensureDocumentPrepared = () => {
      throw new Error('Expected recent large-EJS open diagnostics to defer before preparing virtual state.')
    }
    const openWarmupService = openWarmupCore.getDocumentContextByUri(openWarmupUri).service
    const originalOpenWarmupDiagnostics = openWarmupService.getDiagnostics.bind(openWarmupService)
    let openWarmupReport = null
    try {
      openWarmupService.getDiagnostics = () => {
        throw new Error('Expected recent large-EJS open diagnostics to defer before computing diagnostics.')
      }
      const openWarmupFeatureService = createDiagnosticsFeatureService(
        openWarmupContext.context
      )
      openWarmupReport = await openWarmupFeatureService.providePullDiagnostics(
        { textDocument: { uri: openWarmupUri } },
        { isCancellationRequested: false }
      )
    } finally {
      openWarmupService.getDiagnostics = originalOpenWarmupDiagnostics
    }
    if (
      !openWarmupReport ||
      !String(openWarmupReport.resultId || '').startsWith('large-open-warmup:') ||
      !Array.isArray(openWarmupReport.items) ||
      openWarmupReport.items.length !== 0 ||
      openWarmupSchedules.length !== 1 ||
      openWarmupSchedules[0].uri !== 'workspace' ||
      openWarmupSchedules[0].key !== 'diagnostics:refresh' ||
      openWarmupSchedules[0].delayMs <= 0
    ) {
      throw new Error(
        `Expected recent large-EJS open diagnostics to defer an empty result and schedule a refresh. Got: ${JSON.stringify({ openWarmupReport, openWarmupSchedules })}`
      )
    }

    const normalOpenWarmupCore = new PocketPagesLanguageCore()
    const normalOpenWarmupText = `<script server>\nmissingNormalOpenWarmup.toString()\n</script>\n`
    const normalOpenWarmupDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      normalOpenWarmupText
    )
    const normalOpenWarmupUri = normalOpenWarmupDocument.uri
    normalOpenWarmupCore.openDocument({
      uri: normalOpenWarmupUri,
      languageId: 'ejs',
      version: 1,
      text: normalOpenWarmupText,
    })
    const normalOpenWarmupRuntimeState = createDocumentRuntimeStateRegistry()
    normalOpenWarmupRuntimeState.updateDocument(normalOpenWarmupUri, {
      version: 1,
      textLength: normalOpenWarmupText.length,
      opened: true,
    })
    const normalOpenWarmupSchedules = []
    const normalOpenWarmupContext = createLspServiceSmokeContext(
      normalOpenWarmupCore,
      new Map([[normalOpenWarmupUri, normalOpenWarmupDocument]]),
      {
        runtimeState: normalOpenWarmupRuntimeState,
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    normalOpenWarmupContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 10000
    normalOpenWarmupContext.context.helpers.FIRST_REQUEST_WARMUP_IDLE_MS = 10000
    normalOpenWarmupContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    normalOpenWarmupContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      normalOpenWarmupSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    normalOpenWarmupContext.context.helpers.ensureDocumentPrepared = () => {
      throw new Error('Expected recent non-large EJS open diagnostics to defer before preparing virtual state.')
    }
    const normalOpenWarmupService = normalOpenWarmupCore.getDocumentContextByUri(normalOpenWarmupUri).service
    const originalNormalOpenWarmupDiagnostics = normalOpenWarmupService.getDiagnostics.bind(normalOpenWarmupService)
    let normalOpenWarmupReport = null
    try {
      normalOpenWarmupService.getDiagnostics = () => {
        throw new Error('Expected recent non-large EJS open diagnostics to defer before computing diagnostics.')
      }
      const normalOpenWarmupFeatureService = createDiagnosticsFeatureService(
        normalOpenWarmupContext.context
      )
      normalOpenWarmupReport = await normalOpenWarmupFeatureService.providePullDiagnostics(
        { textDocument: { uri: normalOpenWarmupUri } },
        { isCancellationRequested: false }
      )
    } finally {
      normalOpenWarmupService.getDiagnostics = originalNormalOpenWarmupDiagnostics
    }
    if (
      !normalOpenWarmupReport ||
      !String(normalOpenWarmupReport.resultId || '').startsWith('open-warmup:') ||
      String(normalOpenWarmupReport.resultId || '').startsWith('large-open-warmup:') ||
      !Array.isArray(normalOpenWarmupReport.items) ||
      normalOpenWarmupReport.items.length !== 0 ||
      normalOpenWarmupSchedules.length !== 1 ||
      normalOpenWarmupSchedules[0].uri !== 'workspace' ||
      normalOpenWarmupSchedules[0].key !== 'diagnostics:refresh' ||
      normalOpenWarmupSchedules[0].delayMs <= 0
    ) {
      throw new Error(
        `Expected recent non-large EJS open diagnostics to use the normal open-warmup path. Got: ${JSON.stringify({ normalOpenWarmupReport, normalOpenWarmupSchedules })}`
      )
    }

    const partialQuietCore = new PocketPagesLanguageCore()
    const partialQuietText = `<script server>
const quietPartialStable = 1
</script>
${'<div>large quiet filler</div>\n'.repeat(4)}
<script server>
missingQuietPartial.toString()
</script>
`
    const partialQuietDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      partialQuietText
    )
    const partialQuietUri = partialQuietDocument.uri
    partialQuietCore.openDocument({
      uri: partialQuietUri,
      languageId: 'ejs',
      version: 1,
      text: partialQuietText,
    })
    const partialQuietRuntimeState = createDocumentRuntimeStateRegistry()
    partialQuietRuntimeState.updateDocument(partialQuietUri, {
      version: 1,
      textLength: partialQuietText.length,
      changed: true,
    })
    const partialQuietDocuments = new Map([[partialQuietUri, partialQuietDocument]])
    const partialQuietSchedules = []
    const partialQuietContext = createLspServiceSmokeContext(
      partialQuietCore,
      partialQuietDocuments,
      {
        runtimeState: partialQuietRuntimeState,
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    const partialQuietOffset = partialQuietText.indexOf('missingQuietPartial')
    partialQuietContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50
    partialQuietContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    partialQuietContext.context.helpers.getPreferredDiagnosticOffset = () => partialQuietOffset
    partialQuietContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      partialQuietSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    const partialQuietPrepareCalls = []
    partialQuietContext.context.helpers.ensureDocumentPrepared = (uri, options = {}) => {
      partialQuietPrepareCalls.push({ uri, options })
      return partialQuietCore.prepareDocument(uri, options)
    }
    const partialQuietService = partialQuietCore.getDocumentContextByUri(partialQuietUri).service
    const originalPartialQuietGetDiagnostics = partialQuietService.getDiagnostics.bind(partialQuietService)
    const partialQuietDiagnosticOptions = []
    const partialQuietFeatureService = createDiagnosticsFeatureService(
      partialQuietContext.context
    )
    let partialQuietReport = null
    let partialQuietUnchangedReport = null
    let partialQuietCachedReport = null
    let partialQuietFullReport = null
    try {
      partialQuietService.getDiagnostics = (_filePath, _documentText, options = {}) => {
        partialQuietDiagnosticOptions.push(options)
        return [
          {
            code: 'partial-quiet-diagnostics',
            category: ts.DiagnosticCategory.Error,
            message: 'partial quiet diagnostics',
            start: partialQuietOffset,
            end: partialQuietOffset + 'missingQuietPartial'.length,
          },
        ]
      }
      partialQuietReport = await partialQuietFeatureService.providePullDiagnostics(
        { textDocument: { uri: partialQuietUri } },
        { isCancellationRequested: false }
      )
      partialQuietUnchangedReport = await partialQuietFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: partialQuietUri },
          previousResultId: partialQuietReport && partialQuietReport.resultId,
        },
        { isCancellationRequested: false }
      )
      partialQuietCachedReport = await partialQuietFeatureService.providePullDiagnostics(
        { textDocument: { uri: partialQuietUri } },
        { isCancellationRequested: false }
      )
      partialQuietRuntimeState.updateDocument(partialQuietUri, {
        version: 1,
        textLength: partialQuietText.length,
        saved: true,
      })
      partialQuietFullReport = await partialQuietFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: partialQuietUri },
          previousResultId: partialQuietReport && partialQuietReport.resultId,
        },
        { isCancellationRequested: false }
      )
    } finally {
      partialQuietService.getDiagnostics = originalPartialQuietGetDiagnostics
    }
    if (
      !partialQuietReport ||
      partialQuietReport.partialDiagnostics !== true ||
      partialQuietReport.budgetDeferred !== true ||
      partialQuietReport.preferredOffset !== partialQuietOffset ||
      !partialQuietUnchangedReport ||
      partialQuietUnchangedReport.kind !== 'unchanged' ||
      partialQuietUnchangedReport.resultId !== partialQuietReport.resultId ||
      !partialQuietCachedReport ||
      partialQuietCachedReport.kind !== 'full' ||
      partialQuietCachedReport.partialDiagnostics !== true ||
      partialQuietCachedReport.resultId !== partialQuietReport.resultId ||
      !Array.isArray(partialQuietReport.items) ||
      !partialQuietReport.items.some((entry) => entry.code === 'partial-quiet-diagnostics') ||
      partialQuietSchedules.length !== 3 ||
      partialQuietSchedules[0].uri !== 'workspace' ||
      partialQuietSchedules[0].key !== 'diagnostics:refresh' ||
      partialQuietPrepareCalls.length < 2 ||
      partialQuietPrepareCalls.length !== 2 ||
      partialQuietPrepareCalls[0].options.operation !== 'diagnostics' ||
      partialQuietPrepareCalls[0].options.preferredOffset !== partialQuietOffset ||
      partialQuietPrepareCalls[0].options.skipUnrelatedRegions !== true ||
      partialQuietPrepareCalls[0].options.skipStaticRefresh !== true ||
      partialQuietDiagnosticOptions.length !== 2 ||
      partialQuietDiagnosticOptions[0].includeSemanticDiagnostics !== false ||
      partialQuietDiagnosticOptions[0].includeProjectRuleDiagnostics !== false ||
      !partialQuietDiagnosticOptions[0].semanticBudget ||
      partialQuietDiagnosticOptions[0].semanticBudget.preferredOffset !== partialQuietOffset ||
      partialQuietDiagnosticOptions[1].includeProjectRuleDiagnostics !== true ||
      !partialQuietFullReport ||
      partialQuietFullReport.partialDiagnostics === true ||
      partialQuietFullReport.budgetDeferred === true
    ) {
      throw new Error(
        `Expected recent large-file diagnostics to run a preferred-region partial pass, then run full diagnostics after save. Got: ${JSON.stringify({
          partialQuietReport,
          partialQuietUnchangedReport,
          partialQuietCachedReport,
          partialQuietFullReport,
          partialQuietSchedules,
          partialQuietPrepareCalls,
          partialQuietDiagnosticOptions: partialQuietDiagnosticOptions.map((options) => ({
            semantic: options.includeSemanticDiagnostics,
            project: options.includeProjectRuleDiagnostics,
            preferredOffset: options.semanticBudget && options.semanticBudget.preferredOffset,
            requirePreparedVirtualState: options.requirePreparedVirtualState,
          })),
        })}`
      )
    }

    const stalePartialQuietCore = new PocketPagesLanguageCore()
    const stalePartialQuietText = `<script server>
missingStalePartial.toString()
</script>
${'<div>stale quiet filler</div>\n'.repeat(4)}
`
    const stalePartialQuietDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      3,
      stalePartialQuietText
    )
    const stalePartialQuietUri = stalePartialQuietDocument.uri
    stalePartialQuietCore.openDocument({
      uri: stalePartialQuietUri,
      languageId: 'ejs',
      version: 3,
      text: stalePartialQuietText,
    })
    const stalePartialQuietRuntimeState = createDocumentRuntimeStateRegistry()
    stalePartialQuietRuntimeState.updateDocument(stalePartialQuietUri, {
      version: 3,
      textLength: stalePartialQuietText.length,
      changed: true,
    })
    const stalePartialQuietSchedules = []
    const stalePartialQuietContext = createLspServiceSmokeContext(
      stalePartialQuietCore,
      new Map([[stalePartialQuietUri, stalePartialQuietDocument]]),
      {
        runtimeState: stalePartialQuietRuntimeState,
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    stalePartialQuietContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50
    stalePartialQuietContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    stalePartialQuietContext.context.helpers.getPreferredDiagnosticOffset = () => stalePartialQuietText.indexOf('missingStalePartial')
    stalePartialQuietContext.context.helpers.isStaleDocumentVersion = () => true
    stalePartialQuietContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      stalePartialQuietSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    stalePartialQuietContext.context.helpers.ensureDocumentPrepared = () => {
      throw new Error('Expected stale recent large-file partial diagnostics to cancel before preparing virtual state.')
    }
    const stalePartialQuietService = stalePartialQuietCore.getDocumentContextByUri(stalePartialQuietUri).service
    stalePartialQuietService.getDiagnostics = () => {
      throw new Error('Expected stale recent large-file partial diagnostics to cancel before running diagnostics.')
    }
    const stalePartialQuietFeatureService = createDiagnosticsFeatureService(
      stalePartialQuietContext.context
    )
    const stalePartialQuietReport = await stalePartialQuietFeatureService.providePullDiagnostics(
      { textDocument: { uri: stalePartialQuietUri } },
      { isCancellationRequested: false }
    )
    if (
      stalePartialQuietReport !== null ||
      stalePartialQuietSchedules.length !== 1 ||
      stalePartialQuietRuntimeState.getDiagnostics(stalePartialQuietUri, 'pull')
    ) {
      throw new Error(
        `Expected stale recent large-file partial diagnostics to cancel without caching a partial result. Got: ${JSON.stringify({ stalePartialQuietReport, stalePartialQuietSchedules, cached: stalePartialQuietRuntimeState.getDiagnostics(stalePartialQuietUri, 'pull') })}`
      )
    }

    const semanticBudgetCore = new PocketPagesLanguageCore()
    const semanticBudgetText = `<script server>
missingBudgetOne.toString()
</script>
<script server>
missingBudgetTwo.toString()
</script>
`
    const semanticBudgetDocumentV1 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      semanticBudgetText
    )
    const semanticBudgetUri = semanticBudgetDocumentV1.uri
    semanticBudgetCore.openDocument({
      uri: semanticBudgetUri,
      languageId: 'ejs',
      version: 1,
      text: semanticBudgetText,
    })
    const semanticBudgetDocuments = new Map([[semanticBudgetUri, semanticBudgetDocumentV1]])
    const semanticBudgetSchedules = []
    const semanticBudgetRefreshes = []
    const semanticBudgetContext = createLspServiceSmokeContext(
      semanticBudgetCore,
      semanticBudgetDocuments,
      {
        connection: {
          languages: {
            diagnostics: {
              refresh() {
                semanticBudgetRefreshes.push('refresh')
              },
            },
          },
        },
      }
    )
    semanticBudgetContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50
    semanticBudgetContext.context.helpers.LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET = 1
    semanticBudgetContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    let semanticBudgetPreferredOffset = null
    semanticBudgetContext.context.helpers.getPreferredDiagnosticOffset = () => semanticBudgetPreferredOffset
    semanticBudgetContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      semanticBudgetSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    const semanticBudgetFeatureService = createDiagnosticsFeatureService(
      semanticBudgetContext.context
    )
    const semanticBudgetFirstReport = await semanticBudgetFeatureService.providePullDiagnostics(
      { textDocument: { uri: semanticBudgetUri } },
      { isCancellationRequested: false }
    )
    const semanticBudgetTextV2 = semanticBudgetText
      .replace('missingBudgetOne', 'missingBudgetThree')
      .replace('missingBudgetTwo', 'missingBudgetFour')
    semanticBudgetPreferredOffset = semanticBudgetTextV2.indexOf('missingBudgetFour')
    const semanticBudgetDocumentV2 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      2,
      semanticBudgetTextV2
    )
    semanticBudgetDocuments.set(semanticBudgetUri, semanticBudgetDocumentV2)
    semanticBudgetCore.updateDocument({
      uri: semanticBudgetUri,
      languageId: 'ejs',
      version: 2,
      text: semanticBudgetTextV2,
    })
    const semanticBudgetService = semanticBudgetCore.getDocumentContextByUri(semanticBudgetUri).service
    const originalSemanticBudgetDiagnostics = semanticBudgetService.languageService.getSemanticDiagnostics.bind(
      semanticBudgetService.languageService
    )
    let semanticBudgetCalls = 0
    const semanticBudgetSemanticFileNames = []
    let semanticBudgetSecondReport = null
    try {
      semanticBudgetService.languageService.getSemanticDiagnostics = function countBudgetedSemanticDiagnostics(fileName, ...args) {
        semanticBudgetCalls += 1
        semanticBudgetSemanticFileNames.push(normalizeFilePath(fileName))
        return originalSemanticBudgetDiagnostics(fileName, ...args)
      }
      semanticBudgetSecondReport = await semanticBudgetFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: semanticBudgetUri },
          previousResultId: semanticBudgetFirstReport && semanticBudgetFirstReport.resultId,
        },
        { isCancellationRequested: false }
      )
    } finally {
      semanticBudgetService.languageService.getSemanticDiagnostics = originalSemanticBudgetDiagnostics
    }
    const semanticBudgetPreparedState = semanticBudgetService.getPreparedDocumentState(fixture.boardsFilePath)
    const semanticBudgetPreferredPreparedBlock =
      semanticBudgetPreparedState &&
      Array.isArray(semanticBudgetPreparedState.serverBlocks)
        ? semanticBudgetPreparedState.serverBlocks.find((block) =>
            semanticBudgetPreferredOffset >= block.contentStart &&
            semanticBudgetPreferredOffset <= block.contentEnd
          )
        : null
    if (
      !semanticBudgetSecondReport ||
      semanticBudgetSecondReport.budgetDeferred !== true ||
      semanticBudgetCalls !== 1 ||
      !semanticBudgetPreferredPreparedBlock ||
      semanticBudgetSemanticFileNames[0] !== normalizeFilePath(semanticBudgetPreferredPreparedBlock.fileName) ||
      semanticBudgetSchedules.length !== 1 ||
      semanticBudgetSchedules[0].uri !== 'workspace' ||
      semanticBudgetSchedules[0].key !== 'diagnostics:refresh'
    ) {
      throw new Error(
        `Expected large EJS semantic diagnostics to prioritize the preferred dirty region, respect the per-region budget, and schedule a follow-up refresh. Got: ${JSON.stringify({ semanticBudgetSecondReport, semanticBudgetCalls, semanticBudgetSemanticFileNames, semanticBudgetPreferredPreparedBlock, semanticBudgetSchedules, semanticBudgetRefreshes })}`
      )
    }

    const templateBudgetCore = new PocketPagesLanguageCore()
    const templateBudgetText = `<div><%= missingTemplateOne %></div>
<div><%= missingTemplateTwo %></div>
`
    const templateBudgetDocumentV1 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      templateBudgetText
    )
    const templateBudgetUri = templateBudgetDocumentV1.uri
    templateBudgetCore.openDocument({
      uri: templateBudgetUri,
      languageId: 'ejs',
      version: 1,
      text: templateBudgetText,
    })
    const templateBudgetDocuments = new Map([[templateBudgetUri, templateBudgetDocumentV1]])
    const templateBudgetSchedules = []
    const templateBudgetContext = createLspServiceSmokeContext(
      templateBudgetCore,
      templateBudgetDocuments,
      {
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    templateBudgetContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50
    templateBudgetContext.context.helpers.LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET = 1
    templateBudgetContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    let templateBudgetPreferredOffset = null
    templateBudgetContext.context.helpers.getPreferredDiagnosticOffset = () => templateBudgetPreferredOffset
    templateBudgetContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      templateBudgetSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    const templateBudgetFeatureService = createDiagnosticsFeatureService(
      templateBudgetContext.context
    )
    const templateBudgetFirstReport = await templateBudgetFeatureService.providePullDiagnostics(
      { textDocument: { uri: templateBudgetUri } },
      { isCancellationRequested: false }
    )
    const templateBudgetTextV2 = templateBudgetText
      .replace('missingTemplateOne', 'missingTemplateThree')
      .replace('missingTemplateTwo', 'missingTemplateFour')
    templateBudgetPreferredOffset = templateBudgetTextV2.indexOf('missingTemplateFour')
    const templateBudgetDocumentV2 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      2,
      templateBudgetTextV2
    )
    templateBudgetDocuments.set(templateBudgetUri, templateBudgetDocumentV2)
    templateBudgetCore.updateDocument({
      uri: templateBudgetUri,
      languageId: 'ejs',
      version: 2,
      text: templateBudgetTextV2,
    })
    const templateBudgetService = templateBudgetCore.getDocumentContextByUri(templateBudgetUri).service
    const originalTemplateBudgetDiagnostics = templateBudgetService.languageService.getSemanticDiagnostics.bind(
      templateBudgetService.languageService
    )
    let templateBudgetCalls = 0
    let templateBudgetSecondReport = null
    try {
      templateBudgetService.languageService.getSemanticDiagnostics = function countTemplateBudgetDiagnostics(fileName, ...args) {
        templateBudgetCalls += 1
        return originalTemplateBudgetDiagnostics(fileName, ...args)
      }
      templateBudgetSecondReport = await templateBudgetFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: templateBudgetUri },
          previousResultId: templateBudgetFirstReport && templateBudgetFirstReport.resultId,
        },
        { isCancellationRequested: false }
      )
    } finally {
      templateBudgetService.languageService.getSemanticDiagnostics = originalTemplateBudgetDiagnostics
    }
    const templateBudgetMessages = Array.isArray(templateBudgetSecondReport && templateBudgetSecondReport.items)
      ? templateBudgetSecondReport.items.map((entry) => String(entry.message || ''))
      : []
    if (
      !templateBudgetSecondReport ||
      templateBudgetSecondReport.budgetDeferred !== true ||
      templateBudgetCalls !== 1 ||
      !templateBudgetMessages.some((message) => message.includes('missingTemplateFour')) ||
      templateBudgetMessages.some((message) => message.includes('missingTemplateThree')) ||
      templateBudgetSchedules.length !== 1 ||
      templateBudgetSchedules[0].uri !== 'workspace' ||
      templateBudgetSchedules[0].key !== 'diagnostics:refresh'
    ) {
      throw new Error(
        `Expected large EJS template diagnostics to publish only the preferred dirty template region under the semantic budget. Got: ${JSON.stringify({ templateBudgetSecondReport, templateBudgetCalls, templateBudgetMessages, templateBudgetSchedules })}`
      )
    }

    const largeRealisticCore = new PocketPagesLanguageCore()
    const largeRealisticSections = Array.from({ length: 24 }, (_, index) => `
<script server>
const boardList${index} = $app.findRecordsByFilter('boards', 'is_active = true', '-created', 5, 0)
const boardCount${index} = boardList${index}.length
</script>
<section class="board-row" data-board-index="${index}" x-data="{ open: false }">
  <header>
    <button type="button" hx-get="/xapi/boards/${index}" @click="open = !open">
      Board <%= boardCount${index} %>
    </button>
  </header>
  <% for (const board of boardList${index}) { %>
    <article class="board-card">
      <a href="/boards/<%= board.get('slug') %>"><%= board.get('name') %></a>
      <p><%= board.get('description') %></p>
    </article>
  <% } %>
</section>
`).join('\n')
    const largeRealisticTextV1 = `<script server>
const pageTitle = meta('title') || 'Boards'
</script>
<main class="boards-shell">
  <h1><%= pageTitle %></h1>
${largeRealisticSections}
</main>
`
    const largeRealisticDocumentV1 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      largeRealisticTextV1
    )
    const largeRealisticUri = largeRealisticDocumentV1.uri
    largeRealisticCore.openDocument({
      uri: largeRealisticUri,
      languageId: 'ejs',
      version: 1,
      text: largeRealisticTextV1,
    })
    const largeRealisticDocuments = new Map([[largeRealisticUri, largeRealisticDocumentV1]])
    const largeRealisticSchedules = []
    const largeRealisticContext = createLspServiceSmokeContext(
      largeRealisticCore,
      largeRealisticDocuments,
      {
        connection: {
          languages: {
            diagnostics: {
              refresh() {},
            },
          },
        },
      }
    )
    largeRealisticContext.context.helpers.LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 1000
    largeRealisticContext.context.helpers.LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET = 2
    largeRealisticContext.context.helpers.isPullDiagnosticRefreshSupported = () => true
    let largeRealisticPreferredOffset = null
    largeRealisticContext.context.helpers.getPreferredDiagnosticOffset = () => largeRealisticPreferredOffset
    largeRealisticContext.context.helpers.scheduleDocumentRequest = (uri, key, version, delayMs, callback) => {
      largeRealisticSchedules.push({ uri, key, version, delayMs, callback })
      return { uri, key, version, delayMs }
    }
    const largeRealisticFeatureService = createDiagnosticsFeatureService(
      largeRealisticContext.context
    )
    const largeRealisticFirstReport = await largeRealisticFeatureService.providePullDiagnostics(
      { textDocument: { uri: largeRealisticUri } },
      { isCancellationRequested: false }
    )
    const largeRealisticTextV2 = largeRealisticTextV1.replace(
      'const boardCount17 = boardList17.length',
      'const boardCount17 = missingLargeRealisticBoardList.length'
    )
    largeRealisticPreferredOffset = largeRealisticTextV2.indexOf('missingLargeRealisticBoardList')
    const largeRealisticDocumentV2 = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      2,
      largeRealisticTextV2
    )
    largeRealisticDocuments.set(largeRealisticUri, largeRealisticDocumentV2)
    largeRealisticCore.updateDocument({
      uri: largeRealisticUri,
      languageId: 'ejs',
      version: 2,
      text: largeRealisticTextV2,
    })
    const largeRealisticService = largeRealisticCore.getDocumentContextByUri(largeRealisticUri).service
    const largeRealisticPreparedState = largeRealisticService.getPreparedDocumentState(fixture.boardsFilePath)
    const originalLargeRealisticSemanticDiagnostics = largeRealisticService.languageService.getSemanticDiagnostics.bind(
      largeRealisticService.languageService
    )
    let largeRealisticSemanticCalls = 0
    let largeRealisticSecondReport = null
    const largeRealisticStartedAt = process.hrtime.bigint()
    try {
      largeRealisticService.languageService.getSemanticDiagnostics = function countLargeRealisticSemanticDiagnostics(fileName, ...args) {
        largeRealisticSemanticCalls += 1
        return originalLargeRealisticSemanticDiagnostics(fileName, ...args)
      }
      largeRealisticSecondReport = await largeRealisticFeatureService.providePullDiagnostics(
        {
          textDocument: { uri: largeRealisticUri },
          previousResultId: largeRealisticFirstReport && largeRealisticFirstReport.resultId,
        },
        { isCancellationRequested: false }
      )
    } finally {
      largeRealisticService.languageService.getSemanticDiagnostics = originalLargeRealisticSemanticDiagnostics
    }
    const largeRealisticSecondMs = Number(process.hrtime.bigint() - largeRealisticStartedAt) / 1000000
    const largeRealisticServerBlockCount =
      largeRealisticPreparedState &&
      Array.isArray(largeRealisticPreparedState.serverBlocks)
        ? largeRealisticPreparedState.serverBlocks.length
        : 0
    const largeRealisticBounds = {
      textLength: largeRealisticTextV1.length >= 10000,
      preparedState: !!largeRealisticPreparedState,
      serverBlocks: largeRealisticServerBlockCount >= 20,
      report: !!largeRealisticSecondReport && largeRealisticSecondReport.kind === 'full',
      semanticCalls: largeRealisticSemanticCalls <= 2,
      elapsed: largeRealisticSecondMs <= 6000,
    }
    if (!Object.values(largeRealisticBounds).every(Boolean)) {
      throw new Error(
        `Expected realistic large EJS diagnostics to stay budgeted and bounded. Got: ${JSON.stringify({
          bounds: largeRealisticBounds,
          textLength: largeRealisticTextV1.length,
          serverBlocks: largeRealisticServerBlockCount,
          report: largeRealisticSecondReport
            ? {
                kind: largeRealisticSecondReport.kind,
                budgetDeferred: largeRealisticSecondReport.budgetDeferred,
                itemCount: Array.isArray(largeRealisticSecondReport.items) ? largeRealisticSecondReport.items.length : null,
                resultIdLength: String(largeRealisticSecondReport.resultId || '').length,
              }
            : null,
          largeRealisticSemanticCalls,
          largeRealisticSchedules,
          largeRealisticSecondMs: largeRealisticSecondMs.toFixed(1),
        })}`
      )
    }

    const pullRefreshDiagnosticsEvents = []
    const pullRefreshSchedules = []
    const pullRefreshCore = new PocketPagesLanguageCore()
    const pullRefreshText = `<script server>\nconst refreshValue = 1\n</script>\n`
    const pullRefreshDocument = createTestDocument(
      fixture.boardsFilePath,
      'ejs',
      1,
      pullRefreshText
    )
    const pullRefreshUri = pullRefreshDocument.uri
    pullRefreshCore.openDocument({
      uri: pullRefreshUri,
      languageId: 'ejs',
      version: 1,
      text: pullRefreshText,
    })
    const pullRefreshContext = createLspServiceSmokeContext(
      pullRefreshCore,
      new Map([[pullRefreshUri, pullRefreshDocument]]),
      {
        connection: {
          languages: {
            diagnostics: {
              refresh() {
                pullRefreshDiagnosticsEvents.push('refresh')
              },
            },
          },
        },
        requestCoordinator: {
          schedule(request, callback) {
            pullRefreshSchedules.push(request)
            callback()
            return request
          },
          cancel() {},
        },
      }
    )
    let pullRefreshSupported = true
    pullRefreshContext.context.helpers.isPullDiagnosticRefreshSupported = () => pullRefreshSupported
    const pullRefreshDocumentContext = pullRefreshCore.getDocumentContextByUri(pullRefreshUri)
    const pullRefreshService = pullRefreshDocumentContext && pullRefreshDocumentContext.service
    const originalPullRefreshGetDiagnostics =
      pullRefreshService && typeof pullRefreshService.getDiagnostics === 'function'
        ? pullRefreshService.getDiagnostics.bind(pullRefreshService)
        : null
    if (!pullRefreshService || !originalPullRefreshGetDiagnostics) {
      throw new Error('Expected pull refresh diagnostics smoke context to expose a language service.')
    }
    pullRefreshService.getDiagnostics = () => {
      throw new Error('Expected diagnostics refresh path not to compute diagnostics.')
    }
    const pullRefreshDiagnosticsFeatureService = createDiagnosticsFeatureService(
      pullRefreshContext.context
    )
    try {
      pullRefreshDiagnosticsFeatureService.refreshPullDiagnostics('manual-save')
      pullRefreshDiagnosticsFeatureService.scheduleDiagnosticsRefreshForDocument(pullRefreshUri, {
        reason: 'file-watch',
      })
      pullRefreshSupported = false
      pullRefreshDiagnosticsFeatureService.refreshPullDiagnostics('manual-save')
    } finally {
      pullRefreshService.getDiagnostics = originalPullRefreshGetDiagnostics
    }
    if (
      pullRefreshDiagnosticsEvents.length !== 2 ||
      pullRefreshSchedules.length !== 1 ||
      pullRefreshSchedules.some((request) =>
        request.uri !== 'workspace' || request.key !== 'diagnostics:refresh'
      )
    ) {
      throw new Error(
        `Expected pull diagnostics mode to request workspace diagnostic refreshes without computing diagnostics. Got: ${JSON.stringify({
          refreshes: pullRefreshDiagnosticsEvents,
          schedules: pullRefreshSchedules,
        })}`
      )
    }

    const schemaOnlyDiagnosticsCore = new PocketPagesLanguageCore()
    const schemaOnlyDiagnosticsText = `missingGlobal()\n$app.findRecordsByFilter('missing_collection')\n`
    const schemaOnlyDiagnosticsDocument = createTestDocument(
      fixture.jobScriptFilePath,
      'javascript',
      1,
      schemaOnlyDiagnosticsText
    )
    const schemaOnlyDiagnosticsUri = schemaOnlyDiagnosticsDocument.uri
    schemaOnlyDiagnosticsCore.openDocument({
      uri: schemaOnlyDiagnosticsUri,
      languageId: 'javascript',
      version: 1,
      text: schemaOnlyDiagnosticsText,
    })
    const schemaOnlyDiagnosticsSmokeContext = createLspServiceSmokeContext(
      schemaOnlyDiagnosticsCore,
      new Map([[schemaOnlyDiagnosticsUri, schemaOnlyDiagnosticsDocument]])
    )
    const schemaOnlyDocumentContext = schemaOnlyDiagnosticsCore.getDocumentContextByUri(
      schemaOnlyDiagnosticsUri
    )
    const schemaOnlyService = schemaOnlyDocumentContext && schemaOnlyDocumentContext.service
    const originalSchemaOnlyGetDiagnostics =
      schemaOnlyService && typeof schemaOnlyService.getDiagnostics === 'function'
        ? schemaOnlyService.getDiagnostics.bind(schemaOnlyService)
        : null
    if (!schemaOnlyService || !originalSchemaOnlyGetDiagnostics) {
      throw new Error('Expected schema-support-only hook diagnostics smoke context to expose a language service.')
    }
    schemaOnlyService.getDiagnostics = () => ([
      {
        code: 'pp-schema-collection',
        category: ts.DiagnosticCategory.Error,
        message: 'Unknown PocketBase collection "missing_collection" in findRecordsByFilter().',
        start: schemaOnlyDiagnosticsText.indexOf('missing_collection'),
        end: schemaOnlyDiagnosticsText.indexOf('missing_collection') + 'missing_collection'.length,
      },
      {
        code: 2304,
        category: ts.DiagnosticCategory.Error,
        message: "Cannot find name 'missingGlobal'.",
        start: schemaOnlyDiagnosticsText.indexOf('missingGlobal'),
        end: schemaOnlyDiagnosticsText.indexOf('missingGlobal') + 'missingGlobal'.length,
      },
    ])
    const schemaOnlyDiagnosticsFeatureService = createDiagnosticsFeatureService(
      schemaOnlyDiagnosticsSmokeContext.context
    )
    let schemaOnlyDiagnosticsReport = null
    try {
      schemaOnlyDiagnosticsReport = await schemaOnlyDiagnosticsFeatureService.providePullDiagnostics(
        { textDocument: { uri: schemaOnlyDiagnosticsUri } },
        { isCancellationRequested: false }
      )
    } finally {
      schemaOnlyService.getDiagnostics = originalSchemaOnlyGetDiagnostics
    }
    if (!schemaOnlyDiagnosticsReport || !Array.isArray(schemaOnlyDiagnosticsReport.items)) {
      throw new Error(
        `Expected schema-support-only hook diagnostics pull report. Got: ${JSON.stringify(schemaOnlyDiagnosticsReport)}`
      )
    }
    if (
      schemaOnlyDiagnosticsReport.items.some(
        (entry) =>
          String(entry.code) !== 'pp-schema-collection' &&
          String(entry.code) !== 'pp-schema-field'
      )
    ) {
      throw new Error(
        `Expected schema-support-only hook diagnostics to drop non-schema entries. Got: ${JSON.stringify(schemaOnlyDiagnosticsReport.items)}`
      )
    }
    if (!schemaOnlyDiagnosticsReport.items.some((entry) => String(entry.code) === 'pp-schema-collection')) {
      throw new Error(
        `Expected schema-support-only hook diagnostics to keep collection diagnostics. Got: ${JSON.stringify(schemaOnlyDiagnosticsReport.items)}`
      )
    }

    const excludedVendorDiagnosticsCore = new PocketPagesLanguageCore()
    const excludedVendorDiagnosticsText = `window.JSZip = {}\n`
    const excludedVendorDiagnosticsDocument = createTestDocument(
      fixture.vendorAssetFilePath,
      'javascript',
      1,
      excludedVendorDiagnosticsText
    )
    const excludedVendorDiagnosticsUri = excludedVendorDiagnosticsDocument.uri
    excludedVendorDiagnosticsCore.openDocument({
      uri: excludedVendorDiagnosticsUri,
      languageId: 'javascript',
      version: 1,
      text: excludedVendorDiagnosticsText,
    })
    const excludedVendorDiagnosticsContext = createLspServiceSmokeContext(
      excludedVendorDiagnosticsCore,
      new Map([[excludedVendorDiagnosticsUri, excludedVendorDiagnosticsDocument]])
    )
    excludedVendorDiagnosticsContext.context.helpers.isExcludedPocketPagesScriptPath = (filePath) =>
      normalizeFilePath(filePath) === normalizeFilePath(fixture.vendorAssetFilePath)
    const excludedVendorDiagnosticsFeatureService = createDiagnosticsFeatureService(
      excludedVendorDiagnosticsContext.context
    )
    const excludedVendorDiagnosticsReport = await excludedVendorDiagnosticsFeatureService.providePullDiagnostics(
      { textDocument: { uri: excludedVendorDiagnosticsUri } },
      { isCancellationRequested: false }
    )
    if (
      !excludedVendorDiagnosticsReport ||
      !Array.isArray(excludedVendorDiagnosticsReport.items) ||
      excludedVendorDiagnosticsReport.items.length !== 0
    ) {
      throw new Error(
        `Expected excluded PocketPages vendor scripts to return empty pull diagnostics. Got: ${JSON.stringify(excludedVendorDiagnosticsReport)}`
      )
    }

    const clearedCompletionUris = []
    const maintenanceFeatureService = createMaintenanceFeatureService({
      core: {
        reloadCaches(targetFilePath) {
          return {
            targetFilePath,
            scoped: !!targetFilePath,
            affectedUris: [diagnosticsSmokeUri, assetSmokeUri],
            message: 'PocketPages caches reloaded for the current app.',
          }
        },
      },
      helpers: {
        clearCachedCompletionItemsForUri(uri) {
          clearedCompletionUris.push(uri)
        },
        elapsedMilliseconds() {
          return 0
        },
        getRelativePathLabel(filePath) {
          return normalizeFilePath(filePath)
        },
        logServer() {},
        refreshPullDiagnostics() {},
        uriToFilePath(uri) {
          return URI.parse(uri).fsPath
        },
      },
    })
    maintenanceFeatureService.provideReloadCaches({ uri: diagnosticsSmokeUri })
    if (
      clearedCompletionUris.length !== 2 ||
      !clearedCompletionUris.includes(diagnosticsSmokeUri) ||
      !clearedCompletionUris.includes(assetSmokeUri)
    ) {
      throw new Error(
        `Expected reloadCaches maintenance flow to clear completion cache entries for every affected URI. Got: ${JSON.stringify(clearedCompletionUris)}`
      )
    }

    const watchedManager = new PocketPagesLanguageServiceManager()
    const watchedPrimaryService = watchedManager.getServiceForFile(fixture.boardsFilePath)
    const watchedSecondaryService = watchedManager.getServiceForFile(fixture.secondarySiteIndexFilePath)
    if (!watchedPrimaryService || !watchedSecondaryService) {
      throw new Error('Expected watched-file manager smoke to resolve both primary and secondary app services.')
    }
    const primaryProjectVersionBeforeWatch = watchedPrimaryService.projectVersion
    const secondaryProjectVersionBeforeWatch = watchedSecondaryService.projectVersion
    const watchedManagerResults = watchedManager.handleWatchedFileChanges([
      { filePath: fixture.boardServiceFilePath, type: 'change' },
      { filePath: fixture.secondaryJournalServiceFilePath, type: 'change' },
      { filePath: path.join(fixture.fixtureRoot, 'README.md'), type: 'change' },
    ])
    const watchedManagerAppRoots = watchedManagerResults.map((entry) => normalizeFilePath(entry.appRoot)).sort()
    if (
      watchedManagerAppRoots.length !== 2 ||
      !watchedManagerAppRoots.includes(normalizeFilePath(fixture.appRoot)) ||
      !watchedManagerAppRoots.includes(normalizeFilePath(fixture.secondaryAppRoot))
    ) {
      throw new Error(
        `Expected watched-file manager handling to stay app-scoped and ignore unrelated files. Got: ${JSON.stringify(watchedManagerResults)}`
      )
    }
    if (watchedPrimaryService.projectVersion <= primaryProjectVersionBeforeWatch) {
      throw new Error('Expected watched-file manager to reset the primary app service after a managed file change.')
    }
    if (watchedSecondaryService.projectVersion <= secondaryProjectVersionBeforeWatch) {
      throw new Error('Expected watched-file manager to reset the secondary app service after a managed file change.')
    }

    const schemaOnlyHookProjectVersionBeforeWatch = watchedPrimaryService.projectVersion
    const schemaOnlyHookWatchResults = watchedManager.handleWatchedFileChanges([
      { filePath: fixture.sharedJobFilePath, type: 'change' },
    ])
    if (
      schemaOnlyHookWatchResults.length !== 1 ||
      normalizeFilePath(schemaOnlyHookWatchResults[0].appRoot) !== normalizeFilePath(fixture.appRoot) ||
      !schemaOnlyHookWatchResults[0].invalidationKinds.includes('partial') ||
      watchedPrimaryService.projectVersion <= schemaOnlyHookProjectVersionBeforeWatch
    ) {
      throw new Error(
        `Expected schema-only hook script changes to trigger app-scoped partial invalidation. Got: ${JSON.stringify({
          results: schemaOnlyHookWatchResults,
          before: schemaOnlyHookProjectVersionBeforeWatch,
          after: watchedPrimaryService.projectVersion,
        })}`
      )
    }

    const createdSchemaOnlyHookFilePath = path.join(fixture.appRoot, 'pb_hooks', 'jobs', 'created-watch-job.js')
    writeFile(createdSchemaOnlyHookFilePath, `module.exports = { created: true }\n`)
    const schemaOnlyHookCreateResults = watchedManager.handleWatchedFileChanges([
      { filePath: createdSchemaOnlyHookFilePath, type: 'create' },
    ])
    if (
      schemaOnlyHookCreateResults.length !== 1 ||
      !schemaOnlyHookCreateResults[0].invalidationKinds.includes('structure')
    ) {
      throw new Error(
        `Expected schema-only hook script creates to trigger structure invalidation. Got: ${JSON.stringify(schemaOnlyHookCreateResults)}`
      )
    }

    const schemaCacheFilePath = path.join(fixture.appRoot, 'pb_hooks', 'pages', '_private', 'schema-cache-check.js')
    writeFile(
      schemaCacheFilePath,
      `const board = $app.findFirstRecordByFilter('boards', 'id != ""')
board.get('na')
board.get('name')

module.exports = {
  board,
}
`
    )
    const schemaCacheText = fs.readFileSync(schemaCacheFilePath, 'utf8')
    const schemaCacheCollectionMethodNames = service.projectIndex.getCollectionMethodNames()
    const originalBuildDocumentSchemaFieldDiagnostic = service.buildDocumentSchemaFieldDiagnostic
    let schemaFieldDiagnosticBuildCount = 0
    service.buildDocumentSchemaFieldDiagnostic = function patchedBuildDocumentSchemaFieldDiagnostic(...args) {
      schemaFieldDiagnosticBuildCount += 1
      return originalBuildDocumentSchemaFieldDiagnostic.apply(this, args)
    }
    try {
      const firstScriptSchemaDiagnostics = serializeDiagnostics(
        service.collectScriptSchemaDiagnostics(schemaCacheFilePath, schemaCacheText, schemaCacheCollectionMethodNames)
      )
      const buildCountAfterFirstRun = schemaFieldDiagnosticBuildCount
      if (buildCountAfterFirstRun === 0) {
        throw new Error('Expected script schema diagnostics cache probe to evaluate at least one record-field context on the first run.')
      }
      const secondScriptSchemaDiagnostics = serializeDiagnostics(
        service.collectScriptSchemaDiagnostics(schemaCacheFilePath, schemaCacheText, schemaCacheCollectionMethodNames)
      )
      if (JSON.stringify(firstScriptSchemaDiagnostics) !== JSON.stringify(secondScriptSchemaDiagnostics)) {
        throw new Error(
          `Expected cached script schema diagnostics to stay stable across repeated runs. Got: ${JSON.stringify({ firstScriptSchemaDiagnostics, secondScriptSchemaDiagnostics })}`
        )
      }
      if (schemaFieldDiagnosticBuildCount !== buildCountAfterFirstRun) {
        throw new Error('Expected script schema diagnostics cache to skip record-field recomputation on a repeated run.')
      }

      service.invalidateManagedFile(schemaCacheFilePath, { type: 'change' })
      service.collectScriptSchemaDiagnostics(schemaCacheFilePath, schemaCacheText, schemaCacheCollectionMethodNames)
      const buildCountAfterSelfInvalidation = schemaFieldDiagnosticBuildCount
      if (buildCountAfterSelfInvalidation <= buildCountAfterFirstRun) {
        throw new Error('Expected script schema diagnostics cache to invalidate after a managed file change.')
      }

      const originalBoardServiceTextForCacheProbe = fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
      writeFile(
        fixture.boardServiceFilePath,
        `${originalBoardServiceTextForCacheProbe}\nconst CACHE_BREAKER = 'boards'\n`
      )
      try {
        service.invalidateManagedFile(fixture.boardServiceFilePath, { type: 'change' })
        service.collectScriptSchemaDiagnostics(schemaCacheFilePath, schemaCacheText, schemaCacheCollectionMethodNames)
        if (schemaFieldDiagnosticBuildCount <= buildCountAfterSelfInvalidation) {
          throw new Error(
            'Expected script schema diagnostics cache to invalidate when another PocketPages content file changes.'
          )
        }
      } finally {
        writeFile(fixture.boardServiceFilePath, originalBoardServiceTextForCacheProbe)
        service.invalidateManagedFile(fixture.boardServiceFilePath, { type: 'change' })
      }
    } finally {
      service.buildDocumentSchemaFieldDiagnostic = originalBuildDocumentSchemaFieldDiagnostic
    }

    const partialWatchManager = new PocketPagesLanguageServiceManager()
    const partialWatchService = partialWatchManager.getServiceForFile(fixture.boardsFilePath)
    if (!partialWatchService) {
      throw new Error('Expected partial watched-file manager smoke to resolve the primary app service.')
    }
    partialWatchService.getDiagnostics(fixture.boardsFilePath, fs.readFileSync(fixture.boardsFilePath, 'utf8'))
    partialWatchService.getDiagnostics(fixture.localsTypeCheckFilePath, fs.readFileSync(fixture.localsTypeCheckFilePath, 'utf8'))
    partialWatchService.collectScriptSchemaDiagnostics(
      schemaCacheFilePath,
      schemaCacheText,
      partialWatchService.projectIndex.getCollectionMethodNames()
    )
    const partialWatchStaticFileCountBefore = partialWatchService.staticFiles.size
    const partialWatchScriptSchemaCacheSizeBefore = partialWatchService.scriptSchemaDiagnosticsCache.size
    const changedVirtualFileCountBefore = [...partialWatchService.virtualFiles.values()].filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    ).length
    const unrelatedVirtualFileCountBefore = [...partialWatchService.virtualFiles.values()].filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.localsTypeCheckFilePath)
    ).length
    const changedPreparedStateBefore = partialWatchService.preparedDocumentStates.has(normalizeFilePath(fixture.boardsFilePath))
    const unrelatedPreparedStateBefore = partialWatchService.preparedDocumentStates.has(normalizeFilePath(fixture.localsTypeCheckFilePath))
    if (changedVirtualFileCountBefore === 0) {
      throw new Error('Expected partial watched-file smoke to warm virtual files for the changed file before invalidation.')
    }
    if (unrelatedVirtualFileCountBefore === 0) {
      throw new Error('Expected partial watched-file smoke to warm virtual files for the unrelated file before invalidation.')
    }
    if (partialWatchStaticFileCountBefore === 0) {
      throw new Error('Expected partial watched-file smoke to warm ambient static files before invalidation.')
    }
    if (partialWatchScriptSchemaCacheSizeBefore === 0) {
      throw new Error('Expected partial watched-file smoke to warm script schema diagnostics cache before invalidation.')
    }
    if (!changedPreparedStateBefore || !unrelatedPreparedStateBefore) {
      throw new Error('Expected service-only diagnostics warmup to prepare diagnostics virtual state before invalidation.')
    }
    const partialWatchResults = partialWatchManager.handleWatchedFileChanges([
      { filePath: fixture.boardsFilePath, type: 'change' },
    ])
    if (partialWatchResults.length !== 1 || !partialWatchResults[0].invalidationKinds.includes('partial')) {
      throw new Error(
        `Expected watched-file manager to report partial invalidation for plain content changes. Got: ${JSON.stringify(
          partialWatchResults.map((entry) => ({
            appRoot: entry.appRoot,
            changes: entry.changes,
            invalidationKinds: entry.invalidationKinds,
          }))
        )}`
      )
    }
    const changedVirtualFileCountAfter = [...partialWatchService.virtualFiles.values()].filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    ).length
    const unrelatedVirtualFileCountAfter = [...partialWatchService.virtualFiles.values()].filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.localsTypeCheckFilePath)
    ).length
    if (changedVirtualFileCountAfter !== 0) {
      throw new Error('Expected partial watched-file invalidation to drop virtual files for the changed file only.')
    }
    if (unrelatedVirtualFileCountAfter !== unrelatedVirtualFileCountBefore) {
      throw new Error('Expected partial watched-file invalidation to keep unrelated virtual files warm.')
    }
    if (partialWatchService.preparedDocumentStates.has(normalizeFilePath(fixture.boardsFilePath))) {
      throw new Error('Expected partial watched-file invalidation to drop prepared diagnostics state for the changed file.')
    }
    if (!partialWatchService.preparedDocumentStates.has(normalizeFilePath(fixture.localsTypeCheckFilePath))) {
      throw new Error('Expected partial watched-file invalidation to keep unrelated prepared diagnostics state warm.')
    }
    if (partialWatchService.staticFiles.size !== partialWatchStaticFileCountBefore) {
      throw new Error('Expected partial watched-file invalidation to preserve ambient static files instead of resetting the whole service.')
    }
    if (partialWatchService.scriptSchemaDiagnosticsCache.size !== partialWatchScriptSchemaCacheSizeBefore) {
      throw new Error('Expected partial watched-file invalidation to keep unrelated script schema diagnostics cache entries warm.')
    }

    const assetContentWatchManager = new PocketPagesLanguageServiceManager()
    const assetContentWatchService = assetContentWatchManager.getServiceForFile(fixture.boardsFilePath)
    if (!assetContentWatchService) {
      throw new Error('Expected asset content watched-file smoke to resolve the primary app service.')
    }
    const assetContentProjectVersionBefore = assetContentWatchService.projectVersion
    const assetContentWatchResults = assetContentWatchManager.handleWatchedFileChanges([
      { filePath: fixture.globalAssetFilePath, type: 'change' },
    ])
    if (assetContentWatchResults.length !== 0 || assetContentWatchService.projectVersion !== assetContentProjectVersionBefore) {
      throw new Error(
        `Expected public asset content changes to avoid app cache resync. Got: ${JSON.stringify({
          results: assetContentWatchResults.map((entry) => ({
            appRoot: entry.appRoot,
            changes: entry.changes,
            invalidationKinds: entry.invalidationKinds,
          })),
          before: assetContentProjectVersionBefore,
          after: assetContentWatchService.projectVersion,
        })}`
      )
    }
    const routeVendorWatchResults = assetContentWatchManager.handleWatchedFileChanges([
      { filePath: fixture.routeVendorScriptFilePath, type: 'change' },
      { filePath: fixture.routeMinifiedScriptFilePath, type: 'delete' },
      { filePath: fixture.routeUppercaseMinifiedScriptFilePath, type: 'change' },
    ])
    if (routeVendorWatchResults.length !== 0 || assetContentWatchService.projectVersion !== assetContentProjectVersionBefore) {
      throw new Error(
        `Expected route-exposed vendor/minified scripts to avoid app cache resync. Got: ${JSON.stringify({
          results: routeVendorWatchResults.map((entry) => ({
            appRoot: entry.appRoot,
            changes: entry.changes,
            invalidationKinds: entry.invalidationKinds,
          })),
          before: assetContentProjectVersionBefore,
          after: assetContentWatchService.projectVersion,
        })}`
      )
    }

    const fineInvalidationManager = new PocketPagesLanguageServiceManager()
    const fineInvalidationService = fineInvalidationManager.getServiceForFile(fixture.boardsFilePath)
    const moduleConstantsAFilePath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      '_private',
      'cache-constants-a.js'
    )
    const moduleConstantsBFilePath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      '_private',
      'cache-constants-b.js'
    )
    writeFile(moduleConstantsAFilePath, `const CACHE_A = 'boards'\nmodule.exports = { CACHE_A }\n`)
    writeFile(moduleConstantsBFilePath, `const CACHE_B = 'posts'\nmodule.exports = { CACHE_B }\n`)
    fineInvalidationService.projectIndex.getModuleExportedStringConstants(moduleConstantsAFilePath)
    fineInvalidationService.projectIndex.getModuleExportedStringConstants(moduleConstantsBFilePath)
    if (
      !fineInvalidationService.projectIndex.moduleExportedStringConstantsCache.has(normalizeFilePath(moduleConstantsAFilePath)) ||
      !fineInvalidationService.projectIndex.moduleExportedStringConstantsCache.has(normalizeFilePath(moduleConstantsBFilePath))
    ) {
      throw new Error('Expected module string constant cache probe to warm both module cache entries.')
    }
    fineInvalidationService.invalidateManagedFile(moduleConstantsAFilePath, { type: 'change' })
    if (fineInvalidationService.projectIndex.moduleExportedStringConstantsCache.has(normalizeFilePath(moduleConstantsAFilePath))) {
      throw new Error('Expected module string constant invalidation to drop only the changed module cache entry.')
    }
    if (!fineInvalidationService.projectIndex.moduleExportedStringConstantsCache.has(normalizeFilePath(moduleConstantsBFilePath))) {
      throw new Error('Expected module string constant invalidation to preserve unrelated module cache entries.')
    }
    fs.rmSync(moduleConstantsAFilePath, { force: true })
    fs.rmSync(moduleConstantsBFilePath, { force: true })

    const fineBoardsAnalysisText = buildTemplateVirtualText(fs.readFileSync(fixture.boardsFilePath, 'utf8'))
    const fineLocalsAnalysisText = buildTemplateVirtualText(fs.readFileSync(fixture.localsTypeCheckFilePath, 'utf8'))
    fineInvalidationService.getIncludeCallEntries(fixture.boardsFilePath, fineBoardsAnalysisText)
    fineInvalidationService.getIncludeCallEntries(fixture.localsTypeCheckFilePath, fineLocalsAnalysisText)
    if (
      !fineInvalidationService.includeCallEntriesCache.has(normalizeFilePath(fixture.boardsFilePath)) ||
      !fineInvalidationService.includeCallEntriesCache.has(normalizeFilePath(fixture.localsTypeCheckFilePath))
    ) {
      throw new Error('Expected include call entry cache probe to warm both caller cache entries.')
    }
    fineInvalidationService.invalidateManagedFile(fixture.boardsFilePath, { type: 'change' })
    if (fineInvalidationService.includeCallEntriesCache.has(normalizeFilePath(fixture.boardsFilePath))) {
      throw new Error('Expected include call invalidation to drop only the changed caller cache entry.')
    }
    if (!fineInvalidationService.includeCallEntriesCache.has(normalizeFilePath(fixture.localsTypeCheckFilePath))) {
      throw new Error('Expected include call invalidation to preserve unrelated caller cache entries.')
    }

    const includeLocalReadCounts = new Map()
    const readIncludeLocalText = (filePath) => {
      const normalizedFilePath = normalizeFilePath(filePath)
      includeLocalReadCounts.set(normalizedFilePath, (includeLocalReadCounts.get(normalizedFilePath) || 0) + 1)
      return fineInvalidationService.getDocumentText(filePath)
    }
    fineInvalidationService.projectIndex.getIncludeLocalsState({
      readFileText: readIncludeLocalText,
    })
    const firstIncludeLocalReadFileCount = includeLocalReadCounts.size
    if (firstIncludeLocalReadFileCount < 2) {
      throw new Error(`Expected include locals warmup to read multiple caller files. Got: ${firstIncludeLocalReadFileCount}`)
    }
    includeLocalReadCounts.clear()
    fineInvalidationService.invalidateManagedFile(fixture.boardsFilePath, { type: 'change' })
    fineInvalidationService.projectIndex.getIncludeLocalsState({
      readFileText: readIncludeLocalText,
    })
    const secondIncludeLocalReadPaths = [...includeLocalReadCounts.keys()].sort()
    if (
      secondIncludeLocalReadPaths.length !== 1 ||
      secondIncludeLocalReadPaths[0] !== normalizeFilePath(fixture.boardsFilePath)
    ) {
      throw new Error(
        `Expected include locals invalidation to reread only the changed caller file. Got: ${JSON.stringify(secondIncludeLocalReadPaths)}`
      )
    }

    fineInvalidationService.getIncludeContractLocals(fixture.flashAlertFilePath)
    fineInvalidationService.getIncludeContractLocals(fixture.typedPanelFilePath)
    if (
      !fineInvalidationService.includeContractCache.has(normalizeFilePath(fixture.flashAlertFilePath)) ||
      !fineInvalidationService.includeContractCache.has(normalizeFilePath(fixture.typedPanelFilePath))
    ) {
      throw new Error('Expected include contract cache probe to warm both target cache entries.')
    }
    fineInvalidationService.buildPrelude(
      fixture.flashAlertFilePath,
      fs.readFileSync(fixture.flashAlertFilePath, 'utf8')
    )
    const fineFlashPreludeCacheEntry = fineInvalidationService.includePreludeCache.get(
      normalizeFilePath(fixture.flashAlertFilePath)
    )
    if (!fineFlashPreludeCacheEntry) {
      throw new Error('Expected include prelude cache probe to warm the partial prelude cache entry.')
    }
    fineInvalidationService.invalidateManagedFile(fixture.flashAlertFilePath, { type: 'change' })
    if (fineInvalidationService.includeContractCache.has(normalizeFilePath(fixture.flashAlertFilePath))) {
      throw new Error('Expected include contract invalidation to drop only the changed target cache entry.')
    }
    if (!fineInvalidationService.includeContractCache.has(normalizeFilePath(fixture.typedPanelFilePath))) {
      throw new Error('Expected include contract invalidation to preserve unrelated target cache entries.')
    }
    if (
      fineInvalidationService.includePreludeCache.get(normalizeFilePath(fixture.flashAlertFilePath)) !==
      fineFlashPreludeCacheEntry
    ) {
      throw new Error('Expected plain content invalidation to leave include prelude cache entries to snapshot-key reuse checks.')
    }

    fineInvalidationService.projectIndex.getSchemaState()
    fineInvalidationService.projectIndex.getCollectionMethodState()
    fineInvalidationService.projectIndex.getRouteState()
    fineInvalidationService.projectIndex.getIncludeCandidates(fixture.boardsFilePath)
    const fineSchemaCacheBeforeStructureChange = fineInvalidationService.projectIndex.schemaCache
    const fineCollectionMethodCacheBeforeStructureChange = fineInvalidationService.projectIndex.collectionMethodCache
    const structureProbeRouteFilePath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      '(site)',
      'cache-invalidation-probe.ejs'
    )
    writeFile(structureProbeRouteFilePath, `<h1>Probe</h1>\n`)
    const fineStructureInvalidationKind = fineInvalidationService.invalidateManagedFile(
      structureProbeRouteFilePath,
      { type: 'create' }
    )
    if (fineStructureInvalidationKind !== 'structure') {
      throw new Error(`Expected page create invalidation to report structure. Got: ${fineStructureInvalidationKind}`)
    }
    if (fineInvalidationService.projectIndex.schemaCache !== fineSchemaCacheBeforeStructureChange) {
      throw new Error('Expected page structure invalidation to preserve schema cache.')
    }
    if (fineInvalidationService.projectIndex.collectionMethodCache !== fineCollectionMethodCacheBeforeStructureChange) {
      throw new Error('Expected page structure invalidation to preserve pb_data collection method cache.')
    }
    if (
      fineInvalidationService.projectIndex.pagesGraphCache !== null ||
      fineInvalidationService.projectIndex.routeStateCache !== null ||
      fineInvalidationService.projectIndex.searchRootFileCache.size !== 0
    ) {
      throw new Error('Expected page structure invalidation to clear route/search graph caches only.')
    }
    fs.rmSync(structureProbeRouteFilePath, { force: true })

    fineInvalidationService.projectIndex.getRouteState()
    fineInvalidationService.projectIndex.getIncludeLocalsState({
      readFileText: (filePath) => fineInvalidationService.getDocumentText(filePath),
    })
    fineInvalidationService.projectIndex.getIncludeCandidates(fixture.boardsFilePath)
    const assetProbeRouteStateBefore = fineInvalidationService.projectIndex.routeStateCache
    const assetProbeIncludeLocalsBefore = fineInvalidationService.projectIndex.includeLocalsCache
    const assetProbeStructureVersionBefore = fineInvalidationService.projectIndex.pagesStructureVersion
    const assetProbeContentVersionBefore = fineInvalidationService.projectIndex.pagesContentVersion
    const assetProbeVersionBefore = fineInvalidationService.projectIndex.pagesAssetVersion
    const assetProbeFilePath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      'assets',
      'cache-invalidation-probe.css'
    )
    writeFile(assetProbeFilePath, `body { color: #123456; }\n`)
    const assetCreateInvalidationKind = fineInvalidationService.invalidateManagedFile(
      assetProbeFilePath,
      { type: 'create' }
    )
    if (assetCreateInvalidationKind !== 'asset') {
      throw new Error(`Expected asset create invalidation to report asset. Got: ${assetCreateInvalidationKind}`)
    }
    if (
      fineInvalidationService.projectIndex.pagesStructureVersion !== assetProbeStructureVersionBefore ||
      fineInvalidationService.projectIndex.pagesContentVersion !== assetProbeContentVersionBefore
    ) {
      throw new Error('Expected asset create invalidation to avoid route/include content version bumps.')
    }
    if (fineInvalidationService.projectIndex.pagesAssetVersion !== assetProbeVersionBefore + 1) {
      throw new Error('Expected asset create invalidation to bump only the asset version.')
    }
    if (
      fineInvalidationService.projectIndex.routeStateCache !== assetProbeRouteStateBefore ||
      fineInvalidationService.projectIndex.includeLocalsCache !== assetProbeIncludeLocalsBefore
    ) {
      throw new Error('Expected asset create invalidation to preserve route and include locals caches.')
    }
    const resolvedAssetProbeTarget = fineInvalidationService.projectIndex.resolveAssetTarget(
      fixture.boardsFilePath,
      '/assets/cache-invalidation-probe.css'
    )
    if (!resolvedAssetProbeTarget || normalizeFilePath(resolvedAssetProbeTarget) !== normalizeFilePath(assetProbeFilePath)) {
      throw new Error(`Expected asset create invalidation to refresh asset resolution. Got: ${resolvedAssetProbeTarget}`)
    }
    const assetProbeRouteStateAfterCreate = fineInvalidationService.projectIndex.routeStateCache
    const assetProbeIncludeLocalsAfterCreate = fineInvalidationService.projectIndex.includeLocalsCache
    fs.rmSync(assetProbeFilePath, { force: true })
    const assetDeleteInvalidationKind = fineInvalidationService.invalidateManagedFile(
      assetProbeFilePath,
      { type: 'delete' }
    )
    if (assetDeleteInvalidationKind !== 'asset') {
      throw new Error(`Expected asset delete invalidation to report asset. Got: ${assetDeleteInvalidationKind}`)
    }
    if (
      fineInvalidationService.projectIndex.routeStateCache !== assetProbeRouteStateAfterCreate ||
      fineInvalidationService.projectIndex.includeLocalsCache !== assetProbeIncludeLocalsAfterCreate
    ) {
      throw new Error('Expected asset delete invalidation to preserve route and include locals caches.')
    }
    const deletedAssetProbeTarget = fineInvalidationService.projectIndex.resolveAssetTarget(
      fixture.boardsFilePath,
      '/assets/cache-invalidation-probe.css'
    )
    if (deletedAssetProbeTarget) {
      throw new Error(`Expected asset delete invalidation to refresh missing asset resolution. Got: ${deletedAssetProbeTarget}`)
    }

    const assetScriptProbeFilePath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      'assets',
      'cache-invalidation-probe.js'
    )
    const normalizedAssetScriptProbeFilePath = normalizeFilePath(assetScriptProbeFilePath)
    const pagesRootSearchRoot = normalizeFilePath(path.join(fixture.appRoot, 'pb_hooks', 'pages'))
    writeFile(assetScriptProbeFilePath, `module.exports = { probe: true }\n`)
    if (fineInvalidationService.invalidateManagedFile(assetScriptProbeFilePath, { type: 'create' }) !== 'asset') {
      throw new Error('Expected asset script create invalidation to report asset.')
    }
    const assetScriptSearchStateAfterCreate = fineInvalidationService.projectIndex.getSearchRootFileState(
      pagesRootSearchRoot,
      ['.js', '.json', '.cjs', '.mjs']
    )
    if (!assetScriptSearchStateAfterCreate.filePathSet.has(normalizedAssetScriptProbeFilePath)) {
      throw new Error('Expected asset script create invalidation to refresh the search-root file cache with the new script.')
    }
    fs.rmSync(assetScriptProbeFilePath, { force: true })
    if (fineInvalidationService.invalidateManagedFile(assetScriptProbeFilePath, { type: 'delete' }) !== 'asset') {
      throw new Error('Expected asset script delete invalidation to report asset.')
    }
    const assetScriptSearchStateAfterDelete = fineInvalidationService.projectIndex.getSearchRootFileState(
      pagesRootSearchRoot,
      ['.js', '.json', '.cjs', '.mjs']
    )
    if (assetScriptSearchStateAfterDelete.filePathSet.has(normalizedAssetScriptProbeFilePath)) {
      throw new Error('Expected asset script delete invalidation to evict the stale script from the search-root file cache.')
    }

    const watchedRouteCore = new PocketPagesLanguageCore()
    const watchedRouteBoardsText = fs.readFileSync(fixture.boardsFilePath, 'utf8')
    const watchedRouteBoardsUri = URI.file(fixture.boardsFilePath).toString()
    watchedRouteCore.openDocument({
      uri: watchedRouteBoardsUri,
      languageId: 'ejs',
      version: 1,
      text: watchedRouteBoardsText,
    })
    const watchedRouteText = `<a href="/live-preview">Preview</a>\n`
    const watchedRouteOffset = watchedRouteText.indexOf('/live-preview') + 2
    const watchedRouteFilePath = path.join(fixture.appRoot, 'pb_hooks', 'pages', '(site)', 'live-preview.ejs')
    const watchedRouteContextBefore = watchedRouteCore.getDocumentContextByUri(watchedRouteBoardsUri)
    const watchedRouteTargetBefore = watchedRouteContextBefore.service.getPathTargetInfo(
      fixture.boardsFilePath,
      watchedRouteText,
      watchedRouteOffset
    )
    if (watchedRouteTargetBefore) {
      throw new Error(`Expected unresolved route path before watched-file creation. Got: ${JSON.stringify(watchedRouteTargetBefore)}`)
    }
    writeFile(watchedRouteFilePath, `<h1>Preview</h1>\n`)
    const watchedRouteCreateResult = watchedRouteCore.handleWatchedFileChanges([
      { filePath: watchedRouteFilePath, type: 'create' },
    ])
    if (!watchedRouteCreateResult.affectedUris.includes(watchedRouteBoardsUri)) {
      throw new Error(
        `Expected route watched-file create to resync open documents in the same app. Got: ${JSON.stringify(watchedRouteCreateResult)}`
      )
    }
    const watchedRouteTargetAfterCreate = watchedRouteCore.getDocumentContextByUri(watchedRouteBoardsUri).service.getPathTargetInfo(
      fixture.boardsFilePath,
      watchedRouteText,
      watchedRouteOffset
    )
    if (
      !watchedRouteTargetAfterCreate ||
      normalizeFilePath(watchedRouteTargetAfterCreate.targetFilePath) !== normalizeFilePath(watchedRouteFilePath)
    ) {
      throw new Error(
        `Expected watched-file route create to surface the new route target immediately. Got: ${JSON.stringify(watchedRouteTargetAfterCreate)}`
      )
    }
    fs.rmSync(watchedRouteFilePath, { force: true })
    watchedRouteCore.handleWatchedFileChanges([
      { filePath: watchedRouteFilePath, type: 'delete' },
    ])
    const watchedRouteTargetAfterDelete = watchedRouteCore.getDocumentContextByUri(watchedRouteBoardsUri).service.getPathTargetInfo(
      fixture.boardsFilePath,
      watchedRouteText,
      watchedRouteOffset
    )
    if (watchedRouteTargetAfterDelete) {
      throw new Error(
        `Expected watched-file route delete to drop the removed route target. Got: ${JSON.stringify(watchedRouteTargetAfterDelete)}`
      )
    }

    const watchedSchemaCore = new PocketPagesLanguageCore()
    const watchedSchemaBoardsUri = URI.file(fixture.boardsFilePath).toString()
    watchedSchemaCore.openDocument({
      uri: watchedSchemaBoardsUri,
      languageId: 'ejs',
      version: 1,
      text: watchedRouteBoardsText,
    })
    const schemaCollectionsBeforeWatch = watchedSchemaCore
      .getDocumentContextByUri(watchedSchemaBoardsUri)
      .service.projectIndex.getCollectionNames()
    if (schemaCollectionsBeforeWatch.includes('comments')) {
      throw new Error(`Expected fixture schema to start without comments collection. Got: ${schemaCollectionsBeforeWatch.join(', ')}`)
    }
    const originalFixtureSchemaText = fs.readFileSync(fixture.schemaFilePath, 'utf8')
    writeFile(
      fixture.schemaFilePath,
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
          {
            name: 'comments',
            fields: [
              { name: 'body', type: 'text' },
            ],
          },
        ],
        null,
        2
      )
    )
    const watchedSchemaChangeResult = watchedSchemaCore.handleWatchedFileChanges([
      { filePath: fixture.schemaFilePath, type: 'change' },
    ])
    if (!watchedSchemaChangeResult.affectedUris.includes(watchedSchemaBoardsUri)) {
      throw new Error(
        `Expected schema watched-file change to resync open documents in the same app. Got: ${JSON.stringify(watchedSchemaChangeResult)}`
      )
    }
    const schemaCollectionsAfterWatch = watchedSchemaCore
      .getDocumentContextByUri(watchedSchemaBoardsUri)
      .service.projectIndex.getCollectionNames()
    if (!schemaCollectionsAfterWatch.includes('comments')) {
      throw new Error(
        `Expected schema watched-file change to refresh collection cache for open documents. Got: ${schemaCollectionsAfterWatch.join(', ')}`
      )
    }
    writeFile(fixture.schemaFilePath, originalFixtureSchemaText)

    const watchedTypesCore = new PocketPagesLanguageCore()
    const watchedTypesBoardsUri = URI.file(fixture.boardsFilePath).toString()
    watchedTypesCore.openDocument({
      uri: watchedTypesBoardsUri,
      languageId: 'ejs',
      version: 1,
      text: watchedRouteBoardsText,
    })
    const watchedTypesService = watchedTypesCore.getDocumentContextByUri(watchedTypesBoardsUri).service
    const watchedTypesPath = path.join(fixture.appRoot, 'pb_data', 'types.d.ts')
    const watchedTypesMethodName = 'findRecordBySlug'
    const watchedTypesSecondMethodName = 'findRecordsBySlug'
    const watchedTypesMethodNamesBefore = watchedTypesService.projectIndex.getCollectionMethodNames()
    if (
      watchedTypesMethodNamesBefore.includes(watchedTypesMethodName) ||
      watchedTypesMethodNamesBefore.includes(watchedTypesSecondMethodName)
    ) {
      throw new Error(`Expected fixture pb_data types to start without temporary slug helpers. Got: ${watchedTypesMethodNamesBefore.join(', ')}`)
    }
    const originalFixtureTypesText = fs.readFileSync(watchedTypesPath, 'utf8')
    const modifiedFixtureTypesText = originalFixtureTypesText.replace(
      '    isCollectionNameUnique(name: string): boolean',
      `    isCollectionNameUnique(name: string): boolean
    ${watchedTypesMethodName}(collectionModelOrIdentifier: any, slug: string): core.Record`
    )
    const secondModifiedFixtureTypesText = modifiedFixtureTypesText.replace(
      `${watchedTypesMethodName}(collectionModelOrIdentifier: any, slug: string): core.Record`,
      `${watchedTypesSecondMethodName}(collectionModelOrIdentifier: any, slug: string): Array<core.Record>`
    )
    if (modifiedFixtureTypesText === originalFixtureTypesText) {
      throw new Error('Expected fixture pb_data types to contain the collection method insertion anchor.')
    }
    if (secondModifiedFixtureTypesText === modifiedFixtureTypesText) {
      throw new Error('Expected fixture pb_data types to support a second collection method mutation.')
    }
    try {
      writeFile(watchedTypesPath, modifiedFixtureTypesText)
      const modifiedFixtureTypesStats = fs.statSync(watchedTypesPath)
      if (watchedTypesService.projectIndex.collectionMethodCache) {
        watchedTypesService.projectIndex.collectionMethodCache = {
          ...watchedTypesService.projectIndex.collectionMethodCache,
          mtimeMs: modifiedFixtureTypesStats.mtimeMs,
          size: modifiedFixtureTypesStats.size,
        }
      }
      const watchedTypesChangeResult = watchedTypesCore.handleWatchedFileChanges([
        { filePath: watchedTypesPath, type: 'change' },
      ])
      if (!watchedTypesChangeResult.affectedUris.includes(watchedTypesBoardsUri)) {
        throw new Error(
          `Expected pb_data watched-file change to resync open documents in the same app. Got: ${JSON.stringify(watchedTypesChangeResult)}`
        )
      }
      const watchedTypesMethodNamesAfter = watchedTypesCore
        .getDocumentContextByUri(watchedTypesBoardsUri)
        .service.projectIndex.getCollectionMethodNames()
      if (!watchedTypesMethodNamesAfter.includes(watchedTypesMethodName)) {
        throw new Error(
          `Expected pb_data watched-file change to refresh collection method cache. Got: ${watchedTypesMethodNamesAfter.join(', ')}`
        )
      }
      writeFile(watchedTypesPath, secondModifiedFixtureTypesText)
      const secondModifiedFixtureTypesStats = fs.statSync(watchedTypesPath)
      if (watchedTypesService.projectIndex.collectionMethodCache) {
        watchedTypesService.projectIndex.collectionMethodCache = {
          ...watchedTypesService.projectIndex.collectionMethodCache,
          mtimeMs: secondModifiedFixtureTypesStats.mtimeMs,
          size: secondModifiedFixtureTypesStats.size,
        }
      }
      const watchedTypesSecondChangeResult = watchedTypesCore.handleWatchedFileChanges([
        { filePath: watchedTypesPath, type: 'change' },
      ])
      if (!watchedTypesSecondChangeResult.affectedUris.includes(watchedTypesBoardsUri)) {
        throw new Error(
          `Expected consecutive pb_data watched-file changes to keep resyncing open documents. Got: ${JSON.stringify(watchedTypesSecondChangeResult)}`
        )
      }
      const watchedTypesMethodNamesSecond = watchedTypesCore
        .getDocumentContextByUri(watchedTypesBoardsUri)
        .service.projectIndex.getCollectionMethodNames()
      if (
        !watchedTypesMethodNamesSecond.includes(watchedTypesSecondMethodName) ||
        watchedTypesMethodNamesSecond.includes(watchedTypesMethodName)
      ) {
        throw new Error(
          `Expected consecutive pb_data watched-file change to drop stale methods and load the newest helper. Got: ${watchedTypesMethodNamesSecond.join(', ')}`
        )
      }
    } finally {
      writeFile(watchedTypesPath, originalFixtureTypesText)
    }
    watchedTypesCore.handleWatchedFileChanges([
      { filePath: watchedTypesPath, type: 'change' },
    ])
    const watchedTypesMethodNamesRestored = watchedTypesCore
      .getDocumentContextByUri(watchedTypesBoardsUri)
      .service.projectIndex.getCollectionMethodNames()
    if (
      watchedTypesMethodNamesRestored.includes(watchedTypesMethodName) ||
      watchedTypesMethodNamesRestored.includes(watchedTypesSecondMethodName)
    ) {
      throw new Error(
        `Expected restored pb_data types to drop the temporary collection method. Got: ${watchedTypesMethodNamesRestored.join(', ')}`
      )
    }

    const lifecycleWarmupUris = []
    const lifecycleScheduledRefreshes = []
    const lifecycleRefreshReasons = []
    const lifecycleCancelledRequestUris = []
    const lifecycleClearedCompletionUris = []
    const lifecycleWatchedChanges = []
    const lifecycleRememberedOffsets = []
    const lifecycleRuntimeUpdates = []
    const lifecycleCoreCalls = {
      open: [],
      update: [],
      close: [],
    }
    const lifecycleDocs = new Map()
    const lifecycleBoardsText = `<script server>\nmeta('title')\n</script>\n`
    const lifecycleBoardsDocument = createTestDocument(fixture.boardsFilePath, 'ejs', 1, lifecycleBoardsText)
    const lifecycleBoardsUri = lifecycleBoardsDocument.uri
    lifecycleDocs.set(lifecycleBoardsUri, lifecycleBoardsDocument)
    const lifecycleWatchedDocument = createTestDocument(
      fixture.localAssetFilePath,
      'javascript',
      1,
      `console.log('asset')\n`
    )
    lifecycleDocs.set(lifecycleWatchedDocument.uri, lifecycleWatchedDocument)
    const lifecycleVendorDocument = createTestDocument(
      fixture.vendorAssetFilePath,
      'javascript',
      1,
      `window.JSZip = {}\n`
    )
    const lifecycleCore = {
      openDocument(document) {
        lifecycleCoreCalls.open.push(document)
      },
      updateDocument(document) {
        lifecycleCoreCalls.update.push(document)
      },
      closeDocument(uri) {
        lifecycleCoreCalls.close.push(uri)
      },
      handleWatchedFileChanges(changes) {
        lifecycleWatchedChanges.push(changes)
        return {
          affectedUris: [lifecycleBoardsUri, lifecycleVendorDocument.uri],
          appResults: [
            {
              appRoot: fixture.appRoot,
              changes,
              affectedUris: [lifecycleBoardsUri],
            },
          ],
        }
      },
    }
    const lifecycleFeatureService = createLifecycleFeatureService({
      core: lifecycleCore,
      documents: lifecycleDocs,
      connection: {},
      state: {
        diagnosticRunIds: new Map([[lifecycleBoardsUri, 1]]),
      },
      FileChangeType: {
        Created: 1,
        Changed: 2,
        Deleted: 3,
      },
      helpers: {
        clearCachedCompletionItemsForUri(uri) {
          lifecycleClearedCompletionUris.push(uri)
        },
        cancelScheduledDocumentRequests(uri) {
          lifecycleCancelledRequestUris.push(uri)
        },
        cancelFirstRequestWarmup(uri) {
          lifecycleCancelledRequestUris.push(`${uri}:warmup`)
        },
        getRelativePathLabel(filePath) {
          return normalizeFilePath(filePath)
        },
        isEjsFilePath(filePath) {
          return String(filePath || '').endsWith('.ejs')
        },
        isExcludedPocketPagesScriptPath(filePath) {
          return normalizeFilePath(filePath) === normalizeFilePath(fixture.vendorAssetFilePath)
        },
        isScriptFilePath(filePath) {
          return /\.(js|cjs|mjs)$/i.test(String(filePath || ''))
        },
        logServer() {},
        rememberInteractiveOffset(uri, offset, operation) {
          lifecycleRememberedOffsets.push({ uri, offset, operation })
        },
        refreshPullDiagnostics(reason) {
          lifecycleRefreshReasons.push(reason)
        },
        scheduleDiagnosticsRefreshForDocument(uri, options = {}) {
          lifecycleScheduledRefreshes.push({ uri, reason: options.reason })
        },
        scheduleFirstRequestWarmup(uri) {
          lifecycleWarmupUris.push(uri)
        },
        updateDocumentRuntimeState(uri, document, options = {}) {
          lifecycleRuntimeUpdates.push({
            uri,
            version: document ? document.version : null,
            changed: options.changed === true,
            saved: options.saved === true,
          })
        },
        uriToFilePath(uri) {
          return URI.parse(uri).fsPath
        },
      },
    })
    lifecycleFeatureService.handleDidOpen({ document: lifecycleBoardsDocument })
    lifecycleFeatureService.handleDidOpen({ document: lifecycleVendorDocument })
    if (
      lifecycleCoreCalls.open.length !== 1 ||
      lifecycleCoreCalls.open[0].uri !== lifecycleBoardsUri
    ) {
      throw new Error(`Expected lifecycle open to avoid preparing excluded scripts. Got: ${JSON.stringify(lifecycleCoreCalls.open)}`)
    }
    if (
      !lifecycleWarmupUris.includes(lifecycleBoardsUri) ||
      lifecycleRefreshReasons.length !== 0 ||
      lifecycleScheduledRefreshes.length !== 0
    ) {
      throw new Error(
        `Expected lifecycle open to warm regular documents without push diagnostics. Got: ${JSON.stringify({ warmup: lifecycleWarmupUris, refresh: lifecycleRefreshReasons, scheduled: lifecycleScheduledRefreshes })}`
      )
    }
    lifecycleFeatureService.handleDidChangeContent({
      document: lifecycleBoardsDocument,
      contentChanges: [{
        range: {
          start: lifecycleBoardsDocument.positionAt(lifecycleBoardsText.indexOf('meta')),
          end: lifecycleBoardsDocument.positionAt(lifecycleBoardsText.indexOf('meta') + 'meta'.length),
        },
        text: 'meta(\'description\')',
      }],
    })
    lifecycleFeatureService.handleDidChangeContent({
      document: lifecycleVendorDocument,
      contentChanges: [{ text: 'window.JSZip = { loaded: true }' }],
    })
    const lifecycleRememberedOffsetCountBeforeEmptyChange = lifecycleRememberedOffsets.length
    lifecycleFeatureService.handleDidChangeContent({
      document: lifecycleBoardsDocument,
      contentChanges: [],
    })
    if (
      lifecycleCoreCalls.update.length !== 1 ||
      lifecycleCoreCalls.update[0].uri !== lifecycleBoardsUri ||
      !lifecycleClearedCompletionUris.includes(lifecycleBoardsUri) ||
      !lifecycleClearedCompletionUris.includes(lifecycleVendorDocument.uri) ||
      lifecycleClearedCompletionUris.filter((uri) => uri === lifecycleBoardsUri).length !== 1
    ) {
      throw new Error(
        `Expected lifecycle change handling to update only managed core documents while preserving prepared state on empty sync changes. Got updates=${JSON.stringify(lifecycleCoreCalls.update)} cleared=${JSON.stringify(lifecycleClearedCompletionUris)}`
      )
    }
    if (
      !lifecycleRememberedOffsets.some((entry) =>
        entry.uri === lifecycleBoardsUri &&
        entry.offset === lifecycleBoardsText.indexOf('meta') &&
        entry.operation === 'edit'
      ) ||
      lifecycleRememberedOffsets.some((entry) =>
        entry.uri === lifecycleVendorDocument.uri &&
        entry.offset === 0 &&
        entry.operation === 'edit'
      ) ||
      lifecycleRememberedOffsets.length !== lifecycleRememberedOffsetCountBeforeEmptyChange
    ) {
      throw new Error(`Expected lifecycle change handling to remember only ranged edit offsets for preferred diagnostics. Got: ${JSON.stringify(lifecycleRememberedOffsets)}`)
    }
    const lifecycleEmptyChangeRuntimeUpdate = lifecycleRuntimeUpdates[lifecycleRuntimeUpdates.length - 1]
    if (
      !lifecycleEmptyChangeRuntimeUpdate ||
      lifecycleEmptyChangeRuntimeUpdate.uri !== lifecycleBoardsUri ||
      lifecycleEmptyChangeRuntimeUpdate.changed === true
    ) {
      throw new Error(`Expected empty content changes not to extend the recent-change diagnostics quiet window. Got: ${JSON.stringify(lifecycleRuntimeUpdates)}`)
    }
    if (lifecycleScheduledRefreshes.length !== 0 || lifecycleRefreshReasons.length !== 0) {
      throw new Error(
        `Expected lifecycle change to rely on client pull diagnostics without server refresh. Got: ${JSON.stringify({ refresh: lifecycleRefreshReasons, scheduled: lifecycleScheduledRefreshes })}`
      )
    }
    lifecycleFeatureService.handleDidManualSave({ uri: lifecycleBoardsUri })
    if (
      !lifecycleRefreshReasons.includes('manual-save') ||
      !lifecycleRuntimeUpdates.some((entry) => entry.uri === lifecycleBoardsUri && entry.saved === true)
    ) {
      throw new Error(`Expected manual save to mark the document saved and request pull diagnostics refresh. Got: ${JSON.stringify({ lifecycleRefreshReasons, lifecycleRuntimeUpdates })}`)
    }
    lifecycleFeatureService.handleDidChangeWatchedFiles({
      changes: [
        { uri: lifecycleWatchedDocument.uri, type: 2 },
        { uri: URI.file(fixture.boardServiceFilePath).toString(), type: 2 },
        { uri: URI.file(fixture.feedbackPageFilePath).toString(), type: 1 },
        { uri: URI.file(fixture.vendorAssetFilePath).toString(), type: 3 },
      ],
    })
    if (
      lifecycleWatchedChanges.length !== 1 ||
      lifecycleWatchedChanges[0].length !== 3 ||
      lifecycleWatchedChanges[0][0].type !== 'change' ||
      lifecycleWatchedChanges[0][1].type !== 'create' ||
      lifecycleWatchedChanges[0][2].type !== 'delete'
    ) {
      throw new Error(`Expected lifecycle watched-file handling to ignore open changed docs and normalize change kinds. Got: ${JSON.stringify(lifecycleWatchedChanges)}`)
    }
    if (!lifecycleScheduledRefreshes.some((entry) => entry.uri === lifecycleBoardsUri && entry.reason === 'file-watch')) {
      throw new Error(`Expected watched-file handling to request pull diagnostics refresh for affected regular docs. Got: ${JSON.stringify(lifecycleScheduledRefreshes)}`)
    }
    lifecycleFeatureService.handleDidClose({ document: lifecycleBoardsDocument })
    if (
      lifecycleCoreCalls.close.length !== 1 ||
      lifecycleCoreCalls.close[0] !== lifecycleBoardsUri ||
      !lifecycleCancelledRequestUris.includes(lifecycleBoardsUri)
    ) {
      throw new Error(`Expected lifecycle close to clear state, cancel document requests, and close the core document. Got: ${JSON.stringify({ close: lifecycleCoreCalls.close, cancelled: lifecycleCancelledRequestUris })}`)
    }

    const maintenanceProbeCalls = []
    const maintenanceRefreshReasons = []
    const maintenanceReferenceCalls = []
    const maintenanceRenameCalls = []
    const maintenanceFeatureServiceFull = createMaintenanceFeatureService({
      core: {
        probeFile(filePath) {
          maintenanceProbeCalls.push(filePath)
          return { filePath, hasAppRoot: true, diagnostics: 2 }
        },
        reloadCaches(targetFilePath) {
          return {
            targetFilePath,
            scoped: !!targetFilePath,
            affectedUris: [lifecycleBoardsUri],
            message: 'PocketPages caches reloaded for the current app.',
          }
        },
        getFileReferenceResult(filePath) {
          maintenanceReferenceCalls.push(filePath)
          return { referenceQuery: { kind: 'route-file', routePath: '/boards' }, references: [{ filePath }] }
        },
        getFileRenameEdits(oldFilePath, newFilePath) {
          maintenanceRenameCalls.push([oldFilePath, newFilePath])
          return [{ filePath: oldFilePath, textChanges: [{ start: 0, end: 1, newText: newFilePath }] }]
        },
        getDocumentContextByFilePath(filePath) {
          return normalizeFilePath(filePath).includes('/pb_hooks/pages/')
            ? { filePath }
            : null
        },
      },
      helpers: {
        clearCachedCompletionItemsForUri() {},
        elapsedMilliseconds() {
          return 0
        },
        getRelativePathLabel(filePath) {
          return normalizeFilePath(filePath)
        },
        isExcludedPocketPagesScriptPath(filePath) {
          return normalizeFilePath(filePath) === normalizeFilePath(fixture.vendorAssetFilePath)
        },
        logServer() {},
        refreshPullDiagnostics(reason) {
          maintenanceRefreshReasons.push(reason)
        },
        uriToFilePath(uri) {
          return URI.parse(uri).fsPath
        },
      },
    })
    const maintenanceProbeResult = maintenanceFeatureServiceFull.provideProbeCurrentFile({ uri: lifecycleBoardsUri })
    if (
      !maintenanceProbeResult.hasAppRoot ||
      normalizeFilePath(maintenanceProbeCalls[0]) !== normalizeFilePath(fixture.boardsFilePath)
    ) {
      throw new Error(`Expected maintenance probe to forward the normalized file path and return core results. Got: ${JSON.stringify({ maintenanceProbeResult, maintenanceProbeCalls })}`)
    }
    const maintenanceProbeCallCountBeforeExcluded = maintenanceProbeCalls.length
    const maintenanceExcludedProbeResult = maintenanceFeatureServiceFull.provideProbeCurrentFile({
      uri: URI.file(fixture.vendorAssetFilePath).toString(),
    })
    if (
      !maintenanceExcludedProbeResult ||
      maintenanceExcludedProbeResult.excluded !== true ||
      maintenanceExcludedProbeResult.diagnostics !== 0 ||
      maintenanceProbeCalls.length !== maintenanceProbeCallCountBeforeExcluded
    ) {
      throw new Error(`Expected maintenance probe to skip diagnostics for excluded scripts. Got: ${JSON.stringify({ maintenanceExcludedProbeResult, maintenanceProbeCalls })}`)
    }
    const maintenanceRefreshResult = maintenanceFeatureServiceFull.provideRefreshDiagnostics({ uri: lifecycleBoardsUri })
    if (!maintenanceRefreshResult.ok || !maintenanceRefreshReasons.includes('command')) {
      throw new Error(`Expected maintenance refreshDiagnostics to request a pull refresh. Got: ${JSON.stringify({ maintenanceRefreshResult, maintenanceRefreshReasons })}`)
    }
    const maintenanceReferencesResult = maintenanceFeatureServiceFull.provideAllFileReferences({ uri: lifecycleBoardsUri })
    if (
      normalizeFilePath(maintenanceReferenceCalls[0]) !== normalizeFilePath(fixture.boardsFilePath) ||
      !maintenanceReferencesResult ||
      !Array.isArray(maintenanceReferencesResult.references) ||
      maintenanceReferencesResult.references.length !== 1
    ) {
      throw new Error(`Expected maintenance all-file-references to proxy the core result. Got: ${JSON.stringify({ maintenanceReferencesResult, maintenanceReferenceCalls })}`)
    }
    const maintenanceRenameResult = maintenanceFeatureServiceFull.provideFileRenameEdits({
      oldUri: URI.file(fixture.flashAlertFilePath).toString(),
      newUri: URI.file(path.join(path.dirname(fixture.flashAlertFilePath), 'flash-banner.ejs')).toString(),
    })
    if (
      maintenanceRenameCalls.length !== 1 ||
      normalizeFilePath(maintenanceRenameCalls[0][0]) !== normalizeFilePath(fixture.flashAlertFilePath) ||
      !Array.isArray(maintenanceRenameResult) ||
      maintenanceRenameResult.length !== 1
    ) {
      throw new Error(`Expected maintenance fileRenameEdits to proxy old/new paths into core rename edits. Got: ${JSON.stringify({ maintenanceRenameResult, maintenanceRenameCalls })}`)
    }

    class TestSemanticTokensBuilder {
      constructor() {
        this.values = []
      }

      push(line, character, length, tokenType, modifiers) {
        this.values.push(line, character, length, tokenType, modifiers)
      }

      build() {
        return { data: this.values }
      }
    }
    const lspSymbolKind = {
      File: 1,
      Module: 2,
      Namespace: 3,
      String: 15,
      Object: 19,
    }
    const structureBoardText = `<script server>\nconst mode = 'board'\n</script>\n<div><%= mode %></div>\n`
    const structureBoardDocument = createTestDocument(fixture.boardsFilePath, 'ejs', 1, structureBoardText)
    const structureBoardUri = structureBoardDocument.uri
    const structureCore = new PocketPagesLanguageCore()
    structureCore.openDocument({
      uri: structureBoardUri,
      languageId: 'ejs',
      version: 1,
      text: structureBoardText,
    })
    const structureDocuments = new Map([[structureBoardUri, structureBoardDocument]])
    const structureDocumentContexts = new Map([
      [
        structureBoardUri,
        {
          filePath: fixture.boardsFilePath,
          service: {
            getCodeLensEntries() {
              return [
                {
                  title: 'Open flash alert',
                  start: 0,
                  targetFilePath: fixture.flashAlertFilePath,
                },
                {
                  title: 'Show refs',
                  start: 5,
                  command: 'pocketpagesServerScript.allFileReferences',
                  arguments: [structureBoardUri],
                },
              ]
            },
          },
        },
      ],
    ])
    const structureFeatureService = createStructureFeatureService({
      URI,
      TextDocument: {
        create(uri, languageId, version, text) {
          return createTestDocument(URI.parse(uri).fsPath, languageId, version, text)
        },
      },
      core: structureCore,
      helpers: {
        getDocumentByUri(uri) {
          return structureDocuments.get(uri) || null
        },
        getDocumentContextByUri(uri) {
          return structureDocumentContexts.get(uri) || null
        },
        hasPrivatePagesSegment(filePath) {
          return normalizeFilePath(filePath).includes('/pb_hooks/pages/_private/')
        },
        isEjsFilePath(filePath) {
          return String(filePath || '').endsWith('.ejs')
        },
        uriToFilePath(uri) {
          return URI.parse(uri).fsPath
        },
      },
      getServerTemplateBoundaryLineNumbers,
      collectEjsSemanticTokenEntries,
      getTokenTypeIndex,
      SemanticTokensBuilder: TestSemanticTokensBuilder,
      SymbolKind: lspSymbolKind,
    })
    const structureSemanticTokens = structureFeatureService.provideSemanticTokens({
      textDocument: { uri: structureBoardUri },
    })
    if (!structureSemanticTokens || !Array.isArray(structureSemanticTokens.data) || structureSemanticTokens.data.length === 0) {
      throw new Error(`Expected structure service to emit semantic tokens for EJS documents. Got: ${JSON.stringify(structureSemanticTokens)}`)
    }
    const multilineTokenDocument = createTestDocument(
      path.join(path.dirname(fixture.boardsFilePath), 'semantic-empty-line.ejs'),
      'ejs',
      1,
      `<% /* first line\n\nsecond line */ %>\n`
    )
    structureDocuments.set(multilineTokenDocument.uri, multilineTokenDocument)
    const multilineSemanticTokens = structureFeatureService.provideSemanticTokens({
      textDocument: { uri: multilineTokenDocument.uri },
    })
    const hasZeroLengthSemanticToken = multilineSemanticTokens.data.some((value, index) => index % 5 === 2 && value === 0)
    if (hasZeroLengthSemanticToken) {
      throw new Error(`Expected semantic tokens to skip empty multiline chunks. Got: ${JSON.stringify(multilineSemanticTokens)}`)
    }
    const structureMissingSemanticTokens = structureFeatureService.provideSemanticTokens({
      textDocument: { uri: URI.file(fixture.boardServiceFilePath).toString() },
    })
    if (!structureMissingSemanticTokens || structureMissingSemanticTokens.data.length !== 0) {
      throw new Error(`Expected structure service to return empty semantic tokens for non-EJS or missing documents. Got: ${JSON.stringify(structureMissingSemanticTokens)}`)
    }
    const structureCodeLensEntries = structureFeatureService.provideCodeLens({
      textDocument: { uri: structureBoardUri },
    })
    if (
      !Array.isArray(structureCodeLensEntries) ||
      !structureCodeLensEntries.some((entry) => entry.command && entry.command.title === 'Template') ||
      !structureCodeLensEntries.some(
        (entry) =>
          entry.command &&
          entry.command.command === 'pocketpagesServerScript.openCodeLensTarget' &&
          entry.command.arguments &&
          entry.command.arguments[0] === URI.file(fixture.flashAlertFilePath).toString()
      )
    ) {
      throw new Error(`Expected structure service to expose boundary and target-opening CodeLens entries. Got: ${JSON.stringify(structureCodeLensEntries)}`)
    }
    const structureFallbackDocument = structureFeatureService.getDocumentForFile(fixture.flashAlertFilePath)
    if (!structureFallbackDocument || !String(structureFallbackDocument.getText()).includes('flashTone')) {
      throw new Error(`Expected structure service getDocumentForFile() to fall back to core-backed file text. Got: ${JSON.stringify(structureFallbackDocument)}`)
    }

    const symbolManager = new PocketPagesLanguageServiceManager()
    const symbolRouteService = symbolManager.getServiceForFile(fixture.boardShowFilePath)
    if (!symbolRouteService) {
      throw new Error(`Expected symbol test manager to resolve a service for ${fixture.boardShowFilePath}`)
    }
    const symbolStructureCore = new PocketPagesLanguageCore({ manager: symbolManager })
    const symbolBoardText = fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    const symbolBoardDocument = createTestDocument(fixture.boardShowFilePath, 'ejs', 1, symbolBoardText)
    const symbolBoardUri = symbolBoardDocument.uri
    symbolStructureCore.openDocument({
      uri: symbolBoardUri,
      languageId: 'ejs',
      version: 1,
      text: symbolBoardText,
    })
    const symbolDocuments = new Map([[symbolBoardUri, symbolBoardDocument]])
    const symbolStructureFeatureService = createStructureFeatureService({
      URI,
      TextDocument: {
        create(uri, languageId, version, text) {
          return createTestDocument(URI.parse(uri).fsPath, languageId, version, text)
        },
      },
      core: symbolStructureCore,
      helpers: {
        getDocumentByUri(uri) {
          return symbolDocuments.get(uri) || null
        },
        getDocumentContextByUri(uri) {
          return symbolStructureCore.getDocumentContextByUri(uri)
        },
        hasPrivatePagesSegment(filePath) {
          return normalizeFilePath(filePath).includes('/pb_hooks/pages/_private/')
        },
        isEjsFilePath(filePath) {
          return String(filePath || '').endsWith('.ejs')
        },
        uriToFilePath(uri) {
          return URI.parse(uri).fsPath
        },
      },
      getServerTemplateBoundaryLineNumbers,
      collectEjsSemanticTokenEntries,
      getTokenTypeIndex,
      SemanticTokensBuilder: TestSemanticTokensBuilder,
      SymbolKind: lspSymbolKind,
    })
    const structureDocumentSymbols = symbolStructureFeatureService.provideDocumentSymbols({
      textDocument: { uri: symbolBoardUri },
    })
    if (
      !Array.isArray(structureDocumentSymbols) ||
      !structureDocumentSymbols.length ||
      structureDocumentSymbols[0].name !== 'Route /boards/[boardSlug]' ||
      !Array.isArray(structureDocumentSymbols[0].children) ||
      !structureDocumentSymbols[0].children.some((entry) => entry.name === 'Server')
    ) {
      throw new Error(`Expected structure service to expose document symbols for dynamic route files. Got: ${JSON.stringify(structureDocumentSymbols)}`)
    }
    const structureWorkspaceSymbols = symbolStructureFeatureService.provideWorkspaceSymbols({
      query: 'feedback',
    })
    if (
      !Array.isArray(structureWorkspaceSymbols) ||
      !structureWorkspaceSymbols.some((entry) => entry.name === 'Route /feedback') ||
      !structureWorkspaceSymbols.some((entry) => entry.name === 'Route POST /feedback')
    ) {
      throw new Error(`Expected structure service to expose workspace symbols for PocketPages routes. Got: ${JSON.stringify(structureWorkspaceSymbols)}`)
    }
    const assetWorkspaceSymbols = symbolStructureFeatureService.provideWorkspaceSymbols({
      query: 'booklog-reader',
    })
    if (
      !Array.isArray(assetWorkspaceSymbols) ||
      !assetWorkspaceSymbols.some((entry) => entry.name === 'Asset /assets/booklog-reader.js')
    ) {
      throw new Error(`Expected structure service to expose workspace symbols for asset files. Got: ${JSON.stringify(assetWorkspaceSymbols)}`)
    }

    const coldDiagnosticsWriteProbe = withWriteFileSyncCount(() => {
      const coldManager = new PocketPagesLanguageServiceManager()
      const coldService = coldManager.getServiceForFile(fixture.boardsFilePath)
      if (!coldService) {
        throw new Error(`PocketPages app root not found for cold diagnostics probe: ${fixture.boardsFilePath}`)
      }

      return coldService.getDiagnostics(
        fixture.boardsFilePath,
        fs.readFileSync(fixture.boardsFilePath, 'utf8')
      )
    })
    if (coldDiagnosticsWriteProbe.writeCount !== 0) {
      throw new Error(
        `Expected cold diagnostics to avoid sync virtual-file writes. Got writeFileSync count ${coldDiagnosticsWriteProbe.writeCount}.`
      )
    }

    const indexedCodeFilePaths = service.projectIndex.getPagesCodeFiles().map((entry) => normalizeFilePath(entry.filePath))
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.globalAssetFilePath))) {
      throw new Error(`Expected pages code index to exclude client asset scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.vendorAssetFilePath))) {
      throw new Error(`Expected pages code index to exclude asset vendor scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.nestedAssetScriptFilePath))) {
      throw new Error(`Expected pages code index to exclude route-local asset scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.routeVendorScriptFilePath))) {
      throw new Error(`Expected pages code index to exclude route-exposed vendor scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.routeMinifiedScriptFilePath))) {
      throw new Error(`Expected pages code index to exclude route-exposed minified scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.routeUppercaseMinifiedScriptFilePath))) {
      throw new Error(`Expected pages code index to exclude route-exposed uppercase minified scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (!indexedCodeFilePaths.includes(normalizeFilePath(fixture.routeVendorTemplateFilePath))) {
      throw new Error(`Expected pages code index to keep EJS routes under route-exposed vendor directories. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (!indexedCodeFilePaths.includes(normalizeFilePath(fixture.htmlToTextBundleFilePath))) {
      throw new Error(`Expected pages code index to keep _private vendor modules. Got: ${indexedCodeFilePaths.join(', ')}`)
    }

    const diagCodeFilePaths = collectPagesCodeFiles(fixture.appRoot).map((filePath) => normalizeFilePath(filePath))
    if (diagCodeFilePaths.includes(normalizeFilePath(fixture.vendorAssetFilePath))) {
      throw new Error(`Expected CLI diag file scan to exclude asset vendor scripts. Got: ${diagCodeFilePaths.join(', ')}`)
    }
    if (diagCodeFilePaths.includes(normalizeFilePath(fixture.routeVendorScriptFilePath))) {
      throw new Error(`Expected CLI diag file scan to exclude route-exposed vendor scripts. Got: ${diagCodeFilePaths.join(', ')}`)
    }
    if (diagCodeFilePaths.includes(normalizeFilePath(fixture.routeUppercaseMinifiedScriptFilePath))) {
      throw new Error(`Expected CLI diag file scan to exclude route-exposed uppercase minified scripts. Got: ${diagCodeFilePaths.join(', ')}`)
    }
    if (diagCodeFilePaths.includes(normalizeFilePath(fixture.htmlToTextBundleFilePath))) {
      throw new Error(`Expected CLI diag file scan to exclude _private vendor modules. Got: ${diagCodeFilePaths.join(', ')}`)
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
      (
        !typedTemplateQuickInfo.displayText.includes('const pageData: types.FixturePageData') &&
        (
          !typedTemplateQuickInfo.displayText.includes('const pageData: {') ||
          !typedTemplateQuickInfo.displayText.includes('boardName: string;') ||
          !typedTemplateQuickInfo.displayText.includes('postSlugs: string[];')
        )
      )
    ) {
      throw new Error(`Expected JSDoc-backed hover info inside EJS template. Got: ${JSON.stringify(typedTemplateQuickInfo)}`)
    }

    const jsdocTypedServerText = `<script server>
/** @type {types.FixturePageData} */
let pageData = { boardName: 'Boards', boardCount: 1, postSlugs: ['welcome'] }
const firstSlug = pageData.postSlugs[0]
</script>
`
    const jsdocTypedServerQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      jsdocTypedServerText,
      jsdocTypedServerText.indexOf('firstSlug =') + 2
    )
    if (!jsdocTypedServerQuickInfo || !jsdocTypedServerQuickInfo.displayText.includes('const firstSlug: string')) {
      throw new Error(`Expected server-block JSDoc @type to survive TS virtual-file mapping. Got: ${JSON.stringify(jsdocTypedServerQuickInfo)}`)
    }
    const jsdocTypedServerCompletionText = `<script server>
/** @type {types.FixturePageData} */
let pageData = { boardName: 'Boards', boardCount: 1, postSlugs: ['welcome'] }
pageData.
</script>
`
    const jsdocTypedServerCompletion = service.getCompletionData(
      fixture.boardsFilePath,
      jsdocTypedServerCompletionText,
      jsdocTypedServerCompletionText.indexOf('pageData.') + 'pageData.'.length
    )
    const jsdocTypedServerCompletionNames = jsdocTypedServerCompletion
      ? jsdocTypedServerCompletion.entries.map((entry) => entry.name)
      : []
    if (
      !jsdocTypedServerCompletionNames.includes('boardName') ||
      !jsdocTypedServerCompletionNames.includes('postSlugs')
    ) {
      throw new Error(`Expected server-block JSDoc @type completion to survive virtual offset mapping. Got: ${jsdocTypedServerCompletionNames.slice(0, 20).join(', ')}`)
    }
    const jsdocTypedServerRenameText = `<script server>
/** @type {types.FixturePageData} */
let pageData = { boardName: 'Boards', boardCount: 1, postSlugs: ['welcome'] }
const firstSlug = pageData.postSlugs[0]
firstSlug
</script>
`
    const jsdocTypedServerDefinition = service.getTypeScriptDefinitionTarget(
      fixture.boardsFilePath,
      jsdocTypedServerRenameText,
      jsdocTypedServerRenameText.lastIndexOf('pageData') + 2
    )
    const jsdocTypedServerDefinitionOffset = jsdocTypedServerDefinition
      ? positionToOffset(jsdocTypedServerRenameText, jsdocTypedServerDefinition)
      : -1
    if (
      !jsdocTypedServerDefinition ||
      normalizeFilePath(jsdocTypedServerDefinition.filePath) !== normalizeFilePath(fixture.boardsFilePath) ||
      jsdocTypedServerDefinitionOffset !== jsdocTypedServerRenameText.indexOf('pageData =')
    ) {
      throw new Error(`Expected TS definition mapping to survive JSDoc virtual insertion. Got: ${JSON.stringify(jsdocTypedServerDefinition)}`)
    }
    const jsdocTypedServerRenameEdits = service.getTypeScriptRenameEdits(
      fixture.boardsFilePath,
      jsdocTypedServerRenameText,
      jsdocTypedServerRenameText.lastIndexOf('firstSlug') + 2,
      'renamedSlug'
    )
    if (!jsdocTypedServerRenameEdits || !jsdocTypedServerRenameEdits.canRename || jsdocTypedServerRenameEdits.edits.length !== 2) {
      throw new Error(`Expected TS rename mapping to survive JSDoc virtual insertion. Got: ${JSON.stringify(jsdocTypedServerRenameEdits)}`)
    }
    const renamedJSDocTypedServerText = applyEditsToText(jsdocTypedServerRenameText, jsdocTypedServerRenameEdits.edits)
    if (
      !renamedJSDocTypedServerText.includes('const renamedSlug = pageData.postSlugs[0]') ||
      !renamedJSDocTypedServerText.includes('\nrenamedSlug\n')
    ) {
      throw new Error(`Expected JSDoc-shifted rename edits to apply at source offsets. Got: ${renamedJSDocTypedServerText}`)
    }

    const jsdocTypedRecordAliasText = `<script server>
/** @type {PocketPagesRecord<'posts'> | null} */
let postRecord = null
postRecord = $app.findFirstRecordByFilter('posts', 'slug = "welcome"')
const postTitle = postRecord.get('title')
</script>
`
    const jsdocTypedRecordAliasQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      jsdocTypedRecordAliasText,
      jsdocTypedRecordAliasText.indexOf('postTitle =') + 2
    )
    if (!jsdocTypedRecordAliasQuickInfo || !jsdocTypedRecordAliasQuickInfo.displayText.includes('const postTitle: string')) {
      throw new Error(`Expected PocketPagesRecord alias JSDoc to keep schema field typing. Got: ${JSON.stringify(jsdocTypedRecordAliasQuickInfo)}`)
    }

    const jsdocTypeActionText = `<script server>
let posts = []
posts = $app.findRecordsByFilter('posts', '')
const postTitle = posts[0].get('title')
</script>
`
    const jsdocTypeActionDiagnostics = service.getDiagnostics(fixture.boardsFilePath, jsdocTypeActionText)
    if (jsdocTypeActionDiagnostics.some((entry) => String(entry.code) === 'pp-ambiguous-initializer')) {
      throw new Error(`Expected JSDoc type action to stay out of diagnostics. Got: ${JSON.stringify(jsdocTypeActionDiagnostics)}`)
    }
    const jsdocTypeActions = service.getCodeActions(
      fixture.boardsFilePath,
      jsdocTypeActionText,
      {
        start: jsdocTypeActionText.indexOf('posts = []') + 2,
        end: jsdocTypeActionText.indexOf('posts = []') + 2,
      },
      { diagnostics: [] }
    )
    if (
      !Array.isArray(jsdocTypeActions) ||
      !jsdocTypeActions.some((entry) =>
        entry.title === 'Add JSDoc type for posts' &&
        Array.isArray(entry.edits) &&
        entry.edits.some((edit) => edit.newText.includes('PocketPagesRecordArray<"posts">'))
      )
    ) {
      throw new Error(`Expected no-diagnostic JSDoc type code action. Got: ${JSON.stringify(jsdocTypeActions)}`)
    }
    const jsdocTypeFixedText = applyEditsToText(jsdocTypeActionText, jsdocTypeActions[0].edits)
    const jsdocTypeFixedQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      jsdocTypeFixedText,
      jsdocTypeFixedText.indexOf('postTitle =') + 2
    )
    if (!jsdocTypeFixedQuickInfo || !jsdocTypeFixedQuickInfo.displayText.includes('const postTitle: string')) {
      throw new Error(
        `Expected no-diagnostic JSDoc type code action to restore connected field typing. Got: ${JSON.stringify({
          fixedText: jsdocTypeFixedText,
          quickInfo: jsdocTypeFixedQuickInfo,
        })}`
      )
    }

    const typedRequireCompletionText = `<script server>
const { dateutil } = require('@pocketpages/utils')
dateutil.
</script>
`
    const typedRequireCompletionOffset =
      typedRequireCompletionText.indexOf('dateutil.') + 'dateutil.'.length
    const typedRequireCompletion = service.getCompletionData(
      fixture.boardsFilePath,
      typedRequireCompletionText,
      typedRequireCompletionOffset
    )
    const typedRequireCompletionNames = typedRequireCompletion
      ? typedRequireCompletion.entries.map((entry) => entry.name)
      : []
    if (!typedRequireCompletionNames.includes('formatDate') || !typedRequireCompletionNames.includes('startOfDay')) {
      throw new Error(
        `Expected typed require() completion from app-local node_modules package types. Got: ${typedRequireCompletionNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const typedRequireHoverText = `<script server>
const { dateutil } = require('@pocketpages/utils')
</script>
`
    const typedRequireHoverOffset = typedRequireHoverText.indexOf('dateutil } = require') + 2
    const typedRequireQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRequireHoverText,
      typedRequireHoverOffset
    )
    if (
      !typedRequireQuickInfo ||
      !typedRequireQuickInfo.displayText.includes('const dateutil: DateutilApi')
    ) {
      throw new Error(`Expected typed require() hover info from package declarations. Got: ${JSON.stringify(typedRequireQuickInfo)}`)
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

    const inferredResolveReturnText = `<script server>
const schemaService = resolve('schema-inferred-service')
const post = schemaService.findPostBySlug('welcome')
const postTitle = post.get('title')
const posts = schemaService.listPosts()
const firstPostTitle = posts[0].get('title')
const documentedBoard = schemaService.documentedBoard()
const documentedBoardTableName = documentedBoard.tableName()
</script>
`
    const inferredResolvePostQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      inferredResolveReturnText,
      inferredResolveReturnText.indexOf('postTitle =') + 2
    )
    if (!inferredResolvePostQuickInfo || !inferredResolvePostQuickInfo.displayText.includes('const postTitle: string')) {
      throw new Error(`Expected resolve() to infer undocumented direct $app record returns. Got: ${JSON.stringify(inferredResolvePostQuickInfo)}`)
    }
    const inferredResolvePostArrayQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      inferredResolveReturnText,
      inferredResolveReturnText.indexOf('firstPostTitle =') + 2
    )
    if (!inferredResolvePostArrayQuickInfo || !inferredResolvePostArrayQuickInfo.displayText.includes('const firstPostTitle: string')) {
      throw new Error(`Expected resolve() to infer undocumented direct $app array returns. Got: ${JSON.stringify(inferredResolvePostArrayQuickInfo)}`)
    }
    const documentedResolveQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      inferredResolveReturnText,
      inferredResolveReturnText.indexOf('documentedBoard =') + 2
    )
    if (
      !documentedResolveQuickInfo ||
      !documentedResolveQuickInfo.displayText.includes('const documentedBoard: core.Record') ||
      documentedResolveQuickInfo.displayText.includes('PocketPagesRecord<"boards">')
    ) {
      throw new Error(`Expected explicit JSDoc return types to keep precedence over schema inference. Got: ${JSON.stringify(documentedResolveQuickInfo)}`)
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
    const typedResolvePrelude = service.buildPrelude(fixture.boardsFilePath, typedResolveCompletionText)
    if (
      !typedResolvePrelude.includes('declare const resolve: ((requestPath: string, ...args: any[]) => any) & {') ||
      !typedResolvePrelude.includes(
        `(requestPath: "board-service", ...args: any[]): typeof import(${JSON.stringify(
          normalizeFilePath(fixture.boardServiceFilePath)
        )});`
      )
    ) {
      throw new Error(`Expected buildPrelude() to expose typed resolve() overloads for TS. Got: ${typedResolvePrelude}`)
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
    if (resolveNames.includes('./shared-service') || resolveNames.includes('../board-service')) {
      throw new Error(`Expected resolve() completion to prefer canonical non-relative names. Got: ${resolveNames.slice(0, 20).join(', ')}`)
    }

    const resolveSharedText = `<script server>\nresolve('sh')\n</script>\n`
    const resolveSharedOffset = resolveSharedText.indexOf('sh') + 'sh'.length
    const resolveSharedCompletion = service.getCustomCompletionData(fixture.boardsFilePath, resolveSharedText, resolveSharedOffset)
    const resolveSharedNames = resolveSharedCompletion ? resolveSharedCompletion.items.map((entry) => entry.label) : []
    if (!resolveSharedNames.includes('shared-service')) {
      throw new Error(`Expected resolve() completion for "shared-service". Got: ${resolveSharedNames.slice(0, 20).join(', ')}`)
    }
    if (resolveSharedNames.includes('shared-panel') || resolveSharedNames.includes('shared-panel.ejs')) {
      throw new Error(`Expected resolve() completion to exclude .ejs partials. Got: ${resolveSharedNames.slice(0, 20).join(', ')}`)
    }

    const resolveRelativeText = `<script server>\nresolve('./sh')\n</script>\n`
    const resolveRelativeOffset = resolveRelativeText.indexOf('./sh') + './sh'.length
    const resolveRelativeCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      resolveRelativeText,
      resolveRelativeOffset
    )
    const resolveRelativeNames = resolveRelativeCompletion ? resolveRelativeCompletion.items.map((entry) => entry.label) : []
    if (!resolveRelativeNames.includes('./shared-service')) {
      throw new Error(`Expected resolve() completion to keep explicit relative style. Got: ${resolveRelativeNames.slice(0, 20).join(', ')}`)
    }
    if (resolveRelativeNames.includes('shared-service')) {
      throw new Error(`Expected resolve() relative completion to avoid duplicate canonical variants. Got: ${resolveRelativeNames.slice(0, 20).join(', ')}`)
    }

    const resolveBacktickText = `<script server>\nresolve(\`bo\`)\n</script>\n`
    const resolveBacktickOffset = resolveBacktickText.indexOf('bo') + 'bo'.length
    const resolveBacktickCompletion = service.getCustomCompletionData(fixture.boardsFilePath, resolveBacktickText, resolveBacktickOffset)
    const resolveBacktickNames = resolveBacktickCompletion ? resolveBacktickCompletion.items.map((entry) => entry.label) : []
    if (!resolveBacktickNames.includes('board-service')) {
      throw new Error(`Expected resolve() completion inside backticks. Got: ${resolveBacktickNames.slice(0, 20).join(', ')}`)
    }

    const includeText = `<%- include('fl') %>\n`
    const includeOffset = includeText.indexOf('fl') + 'fl'.length
    const includeCompletion = service.getCustomCompletionData(fixture.boardsFilePath, includeText, includeOffset)
    const includeNames = includeCompletion ? includeCompletion.items.map((entry) => entry.label) : []
    if (!includeNames.includes('flash-alert.ejs')) {
      throw new Error(`Expected include() completion to prefer explicit .ejs paths. Got: ${includeNames.slice(0, 20).join(', ')}`)
    }
    if (includeNames.includes('flash-alert') || includeNames.includes('./flash-alert.ejs')) {
      throw new Error(`Expected include() completion to avoid duplicate non-.ejs variants by default. Got: ${includeNames.slice(0, 20).join(', ')}`)
    }

    const includeBacktickText = `<%- include(\`fl\`) %>\n`
    const includeBacktickOffset = includeBacktickText.indexOf('fl') + 'fl'.length
    const includeBacktickCompletion = service.getCustomCompletionData(fixture.boardsFilePath, includeBacktickText, includeBacktickOffset)
    const includeBacktickNames = includeBacktickCompletion ? includeBacktickCompletion.items.map((entry) => entry.label) : []
    if (!includeBacktickNames.includes('flash-alert.ejs')) {
      throw new Error(
        `Expected include() completion inside backticks to prefer explicit .ejs paths. Got: ${includeBacktickNames.slice(0, 20).join(', ')}`
      )
    }
    if (includeBacktickNames.includes('flash-alert') || includeBacktickNames.includes('./flash-alert.ejs')) {
      throw new Error(
        `Expected include() backtick completion to avoid duplicate non-.ejs variants. Got: ${includeBacktickNames.slice(0, 20).join(', ')}`
      )
    }

    const includeRelativeText = `<%- include('./sh') %>\n`
    const includeRelativeOffset = includeRelativeText.indexOf('./sh') + './sh'.length
    const includeRelativeCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      includeRelativeText,
      includeRelativeOffset
    )
    const includeRelativeNames = includeRelativeCompletion ? includeRelativeCompletion.items.map((entry) => entry.label) : []
    if (!includeRelativeNames.includes('./shared-panel.ejs')) {
      throw new Error(`Expected include() completion to keep explicit relative .ejs style. Got: ${includeRelativeNames.slice(0, 20).join(', ')}`)
    }
    if (includeRelativeNames.includes('shared-panel') || includeRelativeNames.includes('./shared-panel')) {
      throw new Error(`Expected include() relative completion to avoid duplicate non-.ejs variants. Got: ${includeRelativeNames.slice(0, 20).join(', ')}`)
    }

    const includeExplicitExtensionText = `<%- include('flash-alert.e') %>\n`
    const includeExplicitExtensionOffset = includeExplicitExtensionText.indexOf('flash-alert.e') + 'flash-alert.e'.length
    const includeExplicitExtensionCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      includeExplicitExtensionText,
      includeExplicitExtensionOffset
    )
    const includeExplicitExtensionNames = includeExplicitExtensionCompletion
      ? includeExplicitExtensionCompletion.items.map((entry) => entry.label)
      : []
    if (!includeExplicitExtensionNames.includes('flash-alert.ejs')) {
      throw new Error(`Expected include() completion to preserve explicit extension style. Got: ${includeExplicitExtensionNames.slice(0, 20).join(', ')}`)
    }
    if (includeExplicitExtensionNames.includes('flash-alert')) {
      throw new Error(`Expected include() explicit extension completion to avoid extless duplicates. Got: ${includeExplicitExtensionNames.slice(0, 20).join(', ')}`)
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
    const resolveCompletionAfterReset = service.getCustomCompletionData(fixture.boardsFilePath, resolveText, resolveOffset)
    if (!resolveCompletionAfterReset || service.projectIndex.collectionMethodCache !== null) {
      throw new Error('Expected path completion to avoid initializing schema collection method cache.')
    }
    const rawOverrideCacheKeyMarker = 'raw-override-cache-key-marker'
    service.projectIndex.getIncludeLocalsState({
      overrides: {
        [fixture.boardsFilePath]: `<script server>\n// ${rawOverrideCacheKeyMarker}\n</script>\n`,
      },
      readFileText: (filePath) => service.getDocumentText(filePath),
    })
    if (
      !service.projectIndex.includeLocalsCache ||
      service.projectIndex.includeLocalsCache.snapshotKey.includes(rawOverrideCacheKeyMarker)
    ) {
      throw new Error('Expected include locals cache key to use a compact override identity instead of raw document text.')
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

    const secondaryIncludeCompletionText = `<%- include('status-badge.ejs', { st }) %>\n`
    const secondaryIncludeCompletionOffset = secondaryIncludeCompletionText.lastIndexOf('st') + 'st'.length
    const secondaryIncludeCompletion = secondaryService.getCustomCompletionData(
      fixture.secondarySiteIndexFilePath,
      secondaryIncludeCompletionText,
      secondaryIncludeCompletionOffset
    )
    const secondaryIncludeLocalNames = secondaryIncludeCompletion
      ? secondaryIncludeCompletion.items.map((entry) => entry.label)
      : []
    if (!secondaryIncludeLocalNames.includes('state')) {
      throw new Error(`Expected secondary app include() local completion. Got: ${secondaryIncludeLocalNames.join(', ')}`)
    }

    if (!service.includeContractCache || service.includeContractCache.size === 0 || !service.includeCallEntriesCache || service.includeCallEntriesCache.size === 0) {
      throw new Error('Expected primary app include caches to be repopulated before scoped cache reset.')
    }
    if (
      !secondaryService.includeContractCache ||
      secondaryService.includeContractCache.size === 0 ||
      !secondaryService.includeCallEntriesCache ||
      secondaryService.includeCallEntriesCache.size === 0
    ) {
      throw new Error('Expected secondary app include caches to be populated before scoped cache reset.')
    }

    const scopedResetService = manager.resetCachesForFile(fixture.secondarySiteIndexFilePath)
    if (scopedResetService !== secondaryService) {
      throw new Error('Expected resetCachesForFile() to return the matching app service.')
    }
    if (secondaryService.includeContractCache.size !== 0 || secondaryService.includeCallEntriesCache.size !== 0) {
      throw new Error('Expected resetCachesForFile() to clear include caches only for the target app.')
    }
    if (service.includeContractCache.size === 0 || service.includeCallEntriesCache.size === 0) {
      throw new Error('Expected resetCachesForFile() to keep other app caches warm.')
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
    const datastarRouteCompletionText = `<button data-on:click="@get('/si"></button>\n`
    const datastarRouteCompletionOffset = datastarRouteCompletionText.indexOf('/si') + '/si'.length
    const datastarRouteCompletion = service.getCustomCompletionData(
      fixture.siteIndexFilePath,
      datastarRouteCompletionText,
      datastarRouteCompletionOffset
    )
    const datastarRouteNames = datastarRouteCompletion ? datastarRouteCompletion.items.map((entry) => entry.label) : []
    if (!datastarRouteNames.includes('/sign-in')) {
      throw new Error(`Expected Datastar @get route path completion for "/sign-in". Got: ${datastarRouteNames.slice(0, 20).join(', ')}`)
    }

    const commentedResolveCompletionText = `<script server>\n// resolve('bo')\n</script>\n`
    const commentedResolveCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      commentedResolveCompletionText,
      commentedResolveCompletionText.indexOf('bo') + 'bo'.length
    )
    if (commentedResolveCompletion) {
      throw new Error(`Expected path completion to ignore commented resolve() calls. Got: ${JSON.stringify(commentedResolveCompletion)}`)
    }

    const stringRouteCompletionText = `<script server>\nconst html = '<a href="/si"></a>'\n</script>\n`
    const stringRouteCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      stringRouteCompletionText,
      stringRouteCompletionText.indexOf('/si') + '/si'.length
    )
    if (stringRouteCompletion) {
      throw new Error(`Expected path completion to ignore route attributes inside server strings. Got: ${JSON.stringify(stringRouteCompletion)}`)
    }

    const clientScriptPathCompletionText = `<script>\nconst call = "resolve('bo')"\nconst html = '<a href="/si"></a>'\n</script>\n`
    const clientResolveCompletion = service.getCustomCompletionData(
      fixture.siteIndexFilePath,
      clientScriptPathCompletionText,
      clientScriptPathCompletionText.indexOf('bo') + 'bo'.length
    )
    const clientRouteCompletion = service.getCustomCompletionData(
      fixture.siteIndexFilePath,
      clientScriptPathCompletionText,
      clientScriptPathCompletionText.indexOf('/si') + '/si'.length
    )
    if (clientResolveCompletion || clientRouteCompletion) {
      throw new Error(
        `Expected path completion to ignore client script strings. Got: ${JSON.stringify({ clientResolveCompletion, clientRouteCompletion })}`
      )
    }

    const schemaContextFalsePositiveText = [
      `// $app.findRecordsByFilter('missing_collection')`,
      `const literal = "board.get('missing_field')"`,
      `const records = $app.findRecordsByFilter('boards')`,
    ].join('\n')
    const schemaContextFalsePositives = collectSchemaContexts(schemaContextFalsePositiveText, {
      collectionMethodNames: service.projectIndex.getCollectionMethodNames(),
    })
    const schemaContextValues = schemaContextFalsePositives.map((entry) => `${entry.kind}:${entry.value}`)
    if (
      schemaContextValues.includes('collection-name:missing_collection') ||
      schemaContextValues.includes('record-field:missing_field') ||
      !schemaContextValues.includes('collection-name:boards')
    ) {
      throw new Error(`Expected schema contexts to ignore comments/strings and keep real calls. Got: ${schemaContextValues.join(', ')}`)
    }

    const schemaInferenceReuseText = [
      `const board = $app.findFirstRecordByFilter('boards', 'id != ""')`,
      `board.get('name')`,
    ].join('\n')
    const schemaInferenceSourceFile = ts.createSourceFile(
      'schema-inference-reuse.js',
      schemaInferenceReuseText,
      ts.ScriptTarget.Latest,
      true
    )
    const inferredCollection = service.projectIndex.inferCollectionReference(
      'board',
      schemaInferenceReuseText,
      schemaInferenceReuseText.indexOf("board.get('name')"),
      {
        filePath: fixture.boardsFilePath,
        sourceFile: schemaInferenceSourceFile,
      }
    )
    if (!inferredCollection || inferredCollection.collectionName !== 'boards') {
      throw new Error(`Expected schema collection inference to keep working with a provided SourceFile. Got: ${JSON.stringify(inferredCollection)}`)
    }

    const commentedSchemaCompletionText = `<script server>\n// $app.findRecordsByFilter('bo')\n</script>\n`
    const commentedSchemaCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      commentedSchemaCompletionText,
      commentedSchemaCompletionText.indexOf('bo') + 'bo'.length
    )
    if (commentedSchemaCompletion) {
      throw new Error(`Expected collection completion to ignore commented schema calls. Got: ${JSON.stringify(commentedSchemaCompletion)}`)
    }

    const stringFieldCompletionText = `<script server>\nconst literal = "board.get('na')"\n</script>\n`
    const stringFieldCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      stringFieldCompletionText,
      stringFieldCompletionText.indexOf('na') + 'na'.length
    )
    if (stringFieldCompletion) {
      throw new Error(`Expected field completion to ignore schema-looking calls inside strings. Got: ${JSON.stringify(stringFieldCompletion)}`)
    }

    const emptyRouteAttributeCompletionText = `<form action=""></form>\n`
    const emptyRouteAttributeCompletionOffset = emptyRouteAttributeCompletionText.indexOf('action="') + 'action="'.length
    const emptyRouteAttributeCompletion = service.getCustomCompletionData(
      fixture.siteIndexFilePath,
      emptyRouteAttributeCompletionText,
      emptyRouteAttributeCompletionOffset
    )
    const emptyRouteAttributeNames = emptyRouteAttributeCompletion
      ? emptyRouteAttributeCompletion.items.map((entry) => entry.label)
      : []
    if (!emptyRouteAttributeNames.includes('/sign-in')) {
      throw new Error(`Expected route completion inside empty action attribute. Got: ${emptyRouteAttributeNames.slice(0, 20).join(', ')}`)
    }

    const slashlessRouteAttributeCompletionText = `<form action="si"></form>\n`
    const slashlessRouteAttributeCompletionOffset = slashlessRouteAttributeCompletionText.indexOf('si') + 'si'.length
    const slashlessRouteAttributeCompletion = service.getCustomCompletionData(
      fixture.siteIndexFilePath,
      slashlessRouteAttributeCompletionText,
      slashlessRouteAttributeCompletionOffset
    )
    const slashlessRouteAttributeNames = slashlessRouteAttributeCompletion
      ? slashlessRouteAttributeCompletion.items.map((entry) => entry.label)
      : []
    if (!slashlessRouteAttributeNames.includes('/sign-in')) {
      throw new Error(`Expected route completion inside slashless action attribute. Got: ${slashlessRouteAttributeNames.slice(0, 20).join(', ')}`)
    }

    const localAssetCompletionText = `<link rel="stylesheet" href="<%= asset('ca') %>">\n`
    const localAssetCompletionOffset = localAssetCompletionText.indexOf('ca') + 'ca'.length
    const localAssetCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      localAssetCompletionText,
      localAssetCompletionOffset
    )
    const localAssetNames = localAssetCompletion ? localAssetCompletion.items.map((entry) => entry.label) : []
    if (!localAssetNames.includes('card.css')) {
      throw new Error(`Expected asset() completion for local card.css. Got: ${localAssetNames.slice(0, 20).join(', ')}`)
    }

    const globalAssetCompletionText = `<script src="<%= asset('/assets/bo') %>"></script>\n`
    const globalAssetCompletionOffset = globalAssetCompletionText.indexOf('/assets/bo') + '/assets/bo'.length
    const globalAssetCompletion = service.getCustomCompletionData(
      fixture.boardsFilePath,
      globalAssetCompletionText,
      globalAssetCompletionOffset
    )
    const globalAssetNames = globalAssetCompletion ? globalAssetCompletion.items.map((entry) => entry.label) : []
    if (!globalAssetNames.includes('/assets/booklog-reader.js')) {
      throw new Error(`Expected asset() completion for global /assets/booklog-reader.js. Got: ${globalAssetNames.slice(0, 20).join(', ')}`)
    }

    const collectionText = `<script server>\n$app.findRecordsByFilter('bo')\n</script>\n`
    const collectionOffset = collectionText.indexOf('bo') + 'bo'.length
    const collectionCompletion = service.getCustomCompletionData(fixture.boardsFilePath, collectionText, collectionOffset)
    const collectionNames = collectionCompletion ? collectionCompletion.items.map((entry) => entry.label) : []
    if (!collectionNames.includes('boards') || !collectionNames.includes('posts')) {
      throw new Error(`Expected collection completions for "boards" and "posts". Got: ${collectionNames.slice(0, 20).join(', ')}`)
    }
    if (collectionNames.includes('journals')) {
      throw new Error(`Expected primary app collection completions to stay isolated from other apps. Got: ${collectionNames.slice(0, 20).join(', ')}`)
    }

    const secondaryCollectionText = `$app.findCollectionByNameOrId('jo')\n`
    const secondaryCollectionOffset = secondaryCollectionText.indexOf('jo') + 'jo'.length
    const secondaryCollectionCompletion = secondaryService.getCustomCompletionData(
      fixture.secondaryJournalServiceFilePath,
      secondaryCollectionText,
      secondaryCollectionOffset
    )
    const secondaryCollectionNames = secondaryCollectionCompletion
      ? secondaryCollectionCompletion.items.map((entry) => entry.label)
      : []
    if (!secondaryCollectionNames.includes('journals')) {
      throw new Error(
        `Expected secondary app collection completions to use its own schema. Got: ${secondaryCollectionNames.slice(0, 20).join(', ')}`
      )
    }
    if (secondaryCollectionNames.includes('boards') || secondaryCollectionNames.includes('posts')) {
      throw new Error(
        `Expected secondary app collection completions to avoid primary-app schema leakage. Got: ${secondaryCollectionNames.slice(0, 20).join(', ')}`
      )
    }

    const originalSchemaText = fs.readFileSync(fixture.schemaFilePath, 'utf8')
    try {
      writeFile(fixture.schemaFilePath, '{\n')
      const collectionCompletionAfterInvalidSchema = service.getCustomCompletionData(
        fixture.boardsFilePath,
        collectionText,
        collectionOffset
      )
      const collectionNamesAfterInvalidSchema = collectionCompletionAfterInvalidSchema
        ? collectionCompletionAfterInvalidSchema.items.map((entry) => entry.label)
        : []
      if (!collectionNamesAfterInvalidSchema.includes('boards') || !collectionNamesAfterInvalidSchema.includes('posts')) {
        throw new Error(
          `Expected collection completions to keep last known good schema after invalid pb_schema.json. Got: ${collectionNamesAfterInvalidSchema.slice(0, 20).join(', ')}`
        )
      }

      const recoveredSchema = JSON.parse(originalSchemaText)
      recoveredSchema.push({
        name: 'drafts',
        fields: [{ name: 'title', type: 'text' }],
      })
      writeFile(fixture.schemaFilePath, JSON.stringify(recoveredSchema, null, 2))
      const collectionCompletionAfterSchemaRecovery = service.getCustomCompletionData(
        fixture.boardsFilePath,
        collectionText,
        collectionOffset
      )
      const collectionNamesAfterSchemaRecovery = collectionCompletionAfterSchemaRecovery
        ? collectionCompletionAfterSchemaRecovery.items.map((entry) => entry.label)
        : []
      if (!collectionNamesAfterSchemaRecovery.includes('drafts')) {
        throw new Error(
          `Expected collection completions to recover after pb_schema.json becomes valid again. Got: ${collectionNamesAfterSchemaRecovery.slice(0, 20).join(', ')}`
        )
      }
    } finally {
      writeFile(fixture.schemaFilePath, originalSchemaText)
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

    const jobCollectionText = `$app.findRecordsByFilter('bo')\n`
    const jobCollectionOffset = jobCollectionText.indexOf('bo') + 'bo'.length
    const jobCollectionCompletion = service.getCustomCompletionData(fixture.jobScriptFilePath, jobCollectionText, jobCollectionOffset)
    const jobCollectionNames = jobCollectionCompletion ? jobCollectionCompletion.items.map((entry) => entry.label) : []
    if (!jobCollectionNames.includes('boards') || !jobCollectionNames.includes('posts')) {
      throw new Error(`Expected pb_hooks/jobs collection completions for "boards" and "posts". Got: ${jobCollectionNames.slice(0, 20).join(', ')}`)
    }

    const jobFieldText = `const board = $app.findFirstRecordByFilter('boards', 'id != ""')\nboard.get('na')\n`
    const jobFieldOffset = jobFieldText.lastIndexOf('na') + 'na'.length
    const jobFieldCompletion = service.getCustomCompletionData(fixture.jobScriptFilePath, jobFieldText, jobFieldOffset)
    const jobFieldNames = jobFieldCompletion ? jobFieldCompletion.items.map((entry) => entry.label) : []
    if (!jobFieldNames.includes('name') || !jobFieldNames.includes('slug')) {
      throw new Error(`Expected pb_hooks/jobs field completions. Got: ${jobFieldNames.slice(0, 20).join(', ')}`)
    }

    const jobDiagnostics = service.getDiagnostics(
      fixture.jobScriptFilePath,
      `const board = $app.findFirstRecordByFilter('boards', 'id != ""')\nboard.set('missing_field', 1)\n$app.findRecordsByFilter('missing_collection')\n`
    )
    const jobDiagnosticMessages = jobDiagnostics.map((entry) => String(entry.message))
    if (!jobDiagnosticMessages.some((message) => message.includes('Unknown PocketBase collection "missing_collection"'))) {
      throw new Error(`Expected pb_hooks/jobs unknown collection diagnostic. Got: ${jobDiagnosticMessages.join(' | ')}`)
    }
    if (!jobDiagnosticMessages.some((message) => message.includes('Unknown field "missing_field" for collection "boards"'))) {
      throw new Error(`Expected pb_hooks/jobs unknown field diagnostic. Got: ${jobDiagnosticMessages.join(' | ')}`)
    }

    const mjsConsumerText = fs.readFileSync(fixture.mjsConsumerFilePath, 'utf8')
    const mjsCompletionOffset = mjsConsumerText.indexOf('cjsStateService.') + 'cjsStateService.'.length
    const mjsCompletion = service.getCompletionData(fixture.mjsConsumerFilePath, mjsConsumerText, mjsCompletionOffset)
    const mjsCompletionNames = mjsCompletion ? mjsCompletion.entries.map((entry) => entry.name) : []
    if (!mjsCompletionNames.includes('readCjsState')) {
      throw new Error(`Expected .mjs resolve()-derived member completion for "readCjsState". Got: ${mjsCompletionNames.slice(0, 20).join(', ')}`)
    }

    const mjsCollectionText = `$app.findRecordsByFilter('bo')\n`
    const mjsCollectionOffset = mjsCollectionText.indexOf('bo') + 'bo'.length
    const mjsCollectionCompletion = service.getCustomCompletionData(fixture.mjsConsumerFilePath, mjsCollectionText, mjsCollectionOffset)
    const mjsCollectionNames = mjsCollectionCompletion ? mjsCollectionCompletion.items.map((entry) => entry.label) : []
    if (!mjsCollectionNames.includes('boards') || !mjsCollectionNames.includes('posts')) {
      throw new Error(`Expected .mjs collection completions for "boards" and "posts". Got: ${mjsCollectionNames.slice(0, 20).join(', ')}`)
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

    const indexedFieldText =
      `const boardRecords = $app.findRecordsByFilter('boards', '', '-sort_order,+name', 10, 0)\nboardRecords[0].get('na')\n`
    const indexedFieldOffset = indexedFieldText.lastIndexOf('na') + 'na'.length
    const indexedFieldCompletion = service.getCustomCompletionData(
      fixture.boardServiceFilePath,
      indexedFieldText,
      indexedFieldOffset
    )
    const indexedFieldNames = indexedFieldCompletion ? indexedFieldCompletion.items.map((entry) => entry.label) : []
    if (!indexedFieldNames.includes('name') || !indexedFieldNames.includes('slug')) {
      throw new Error(`Expected indexed record field completions. Got: ${indexedFieldNames.slice(0, 20).join(', ')}`)
    }

    const roleFieldText = `function canAccept(record) {\n  return !!record.get('na')\n}\n`
    const roleFieldOffset = roleFieldText.lastIndexOf('na') + 'na'.length
    const roleFieldCompletion = service.getCustomCompletionData(fixture.boardRoleFilePath, roleFieldText, roleFieldOffset)
    const roleFieldNames = roleFieldCompletion ? roleFieldCompletion.items.map((entry) => entry.label) : []
    if (!roleFieldNames.includes('name') || !roleFieldNames.includes('slug')) {
      throw new Error(`Expected role-file generic record field completions from filename heuristic. Got: ${roleFieldNames.slice(0, 20).join(', ')}`)
    }

    const publicRoleFieldCompletion = service.getCustomCompletionData(
      fixture.publicBoardRoleRouteFilePath,
      roleFieldText,
      roleFieldOffset
    )
    const publicRoleFieldNames = publicRoleFieldCompletion ? publicRoleFieldCompletion.items.map((entry) => entry.label) : []
    if (publicRoleFieldNames.includes('name') || publicRoleFieldNames.includes('slug')) {
      throw new Error(`Expected public roles route files to skip _private roles field heuristic. Got: ${publicRoleFieldNames.slice(0, 20).join(', ')}`)
    }

    const jsAuthFieldText = `const record = $app.findAuthRecordByEmail('boards', 'test@example.com')\nrecord.get('na')\n`
    const jsAuthFieldOffset = jsAuthFieldText.lastIndexOf('na') + 'na'.length
    const jsAuthFieldCompletion = service.getCustomCompletionData(fixture.boardServiceFilePath, jsAuthFieldText, jsAuthFieldOffset)
    const jsAuthFieldNames = jsAuthFieldCompletion ? jsAuthFieldCompletion.items.map((entry) => entry.label) : []
    if (!jsAuthFieldNames.includes('name') || !jsAuthFieldNames.includes('slug')) {
      throw new Error(`Expected JS auth record field completions. Got: ${jsAuthFieldNames.slice(0, 20).join(', ')}`)
    }

    const importedCollectionConsumerText = fs.readFileSync(fixture.importedCollectionConsumerFilePath, 'utf8')
    const importedRecordFieldOffset =
      importedCollectionConsumerText.indexOf("record.get('na") + "record.get('na".length
    const importedRecordFieldCompletion = service.getCustomCompletionData(
      fixture.importedCollectionConsumerFilePath,
      importedCollectionConsumerText,
      importedRecordFieldOffset
    )
    const importedRecordFieldNames = importedRecordFieldCompletion
      ? importedRecordFieldCompletion.items.map((entry) => entry.label)
      : []
    if (!importedRecordFieldNames.includes('name') || !importedRecordFieldNames.includes('slug')) {
      throw new Error(
        `Expected CommonJS imported collection constant field completions. Got: ${importedRecordFieldNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const importedFallbackFieldOffset =
      importedCollectionConsumerText.indexOf("fallbackRecord.get('na") + "fallbackRecord.get('na".length
    const importedFallbackFieldCompletion = service.getCustomCompletionData(
      fixture.importedCollectionConsumerFilePath,
      importedCollectionConsumerText,
      importedFallbackFieldOffset
    )
    const importedFallbackFieldNames = importedFallbackFieldCompletion
      ? importedFallbackFieldCompletion.items.map((entry) => entry.label)
      : []
    if (!importedFallbackFieldNames.includes('name') || !importedFallbackFieldNames.includes('slug')) {
      throw new Error(
        `Expected imported collection constant constructor field completions. Got: ${importedFallbackFieldNames
          .slice(0, 20)
          .join(', ')}`
      )
    }

    const importedCollectionDiagnosticText =
      `const { CACHE_COLLECTION_NAME } = require('./collection-constants')\n` +
      `const record = $app.findFirstRecordByFilter(CACHE_COLLECTION_NAME, '')\n` +
      `record.get('missing_field')\n`
    const importedCollectionDiagnostics = service.getDiagnostics(
      fixture.importedCollectionConsumerFilePath,
      importedCollectionDiagnosticText
    )
    if (!importedCollectionDiagnostics.some((entry) => String(entry.message).includes('Unknown field "missing_field" for collection "boards"'))) {
      throw new Error(
        `Expected imported collection constant schema diagnostics. Got: ${importedCollectionDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const templateFieldText = `<% const board = pageData.board %>\n<p><%= board.get('na') %></p>\n`
    const templateFieldOffset = templateFieldText.indexOf('na') + 'na'.length
    const templateFieldCompletion = service.getCustomCompletionData(fixture.boardShowFilePath, templateFieldText, templateFieldOffset)
    const templateFieldNames = templateFieldCompletion ? templateFieldCompletion.items.map((entry) => entry.label) : []
    if (!templateFieldNames.includes('name') || !templateFieldNames.includes('description')) {
      throw new Error(`Expected EJS template field completions. Got: ${templateFieldNames.slice(0, 20).join(', ')}`)
    }

    const removedLatestCollectionFallbackText = `const records = $app.findRecordsByFilter('posts')\ncurrent.get('na')\n`
    const removedLatestCollectionFallbackOffset = removedLatestCollectionFallbackText.lastIndexOf('na') + 'na'.length
    const removedLatestCollectionFallbackCompletion = service.getCustomCompletionData(
      fixture.boardServiceFilePath,
      removedLatestCollectionFallbackText,
      removedLatestCollectionFallbackOffset
    )
    const removedLatestCollectionFallbackNames = removedLatestCollectionFallbackCompletion
      ? removedLatestCollectionFallbackCompletion.items.map((entry) => entry.label)
      : []
    if (removedLatestCollectionFallbackNames.includes('title') || removedLatestCollectionFallbackNames.includes('board')) {
      throw new Error(`Expected latest-collection-call fallback completions to stay removed. Got: ${removedLatestCollectionFallbackNames.slice(0, 20).join(', ')}`)
    }

    const removedSingleCollectionFallbackText = `row.get('na')\nconst records = $app.findRecordsByFilter('posts')\n`
    const removedSingleCollectionFallbackOffset = removedSingleCollectionFallbackText.indexOf('na') + 'na'.length
    const removedSingleCollectionFallbackCompletion = service.getCustomCompletionData(
      fixture.boardServiceFilePath,
      removedSingleCollectionFallbackText,
      removedSingleCollectionFallbackOffset
    )
    const removedSingleCollectionFallbackNames = removedSingleCollectionFallbackCompletion
      ? removedSingleCollectionFallbackCompletion.items.map((entry) => entry.label)
      : []
    if (removedSingleCollectionFallbackNames.includes('title') || removedSingleCollectionFallbackNames.includes('board')) {
      throw new Error(`Expected single-collection-in-file fallback completions to stay removed. Got: ${removedSingleCollectionFallbackNames.slice(0, 20).join(', ')}`)
    }

    const resolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-service')\n</script>\n`,
      `<script server>\nresolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!resolveDefinition || !resolveDefinition.endsWith('/pb_hooks/pages/_private/board-service.js')) {
      throw new Error(`Expected resolve() definition target. Got: ${resolveDefinition}`)
    }
    const apiResolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\napi.resolve('board-service')\n</script>\n`,
      `<script server>\napi.resolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!apiResolveDefinition || normalizeFilePath(apiResolveDefinition) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected api.resolve() definition target. Got: ${apiResolveDefinition}`)
    }

    const cjsResolveDefinition = service.getDefinitionTarget(
      fixture.mjsConsumerFilePath,
      mjsConsumerText,
      mjsConsumerText.indexOf('cjs-state-service') + 2
    )
    if (!cjsResolveDefinition || normalizeFilePath(cjsResolveDefinition) !== normalizeFilePath(fixture.cjsStateServiceFilePath)) {
      throw new Error(`Expected .mjs resolve() definition target for .cjs module. Got: ${cjsResolveDefinition}`)
    }

    const cjsResolvedMemberDefinition = service.getDefinitionTarget(
      fixture.mjsConsumerFilePath,
      mjsConsumerText,
      mjsConsumerText.indexOf('readCjsState') + 2
    )
    if (!cjsResolvedMemberDefinition || typeof cjsResolvedMemberDefinition === 'string') {
      throw new Error(`Expected .cjs resolved member definition target. Got: ${JSON.stringify(cjsResolvedMemberDefinition)}`)
    }
    if (normalizeFilePath(cjsResolvedMemberDefinition.filePath) !== normalizeFilePath(fixture.cjsStateServiceFilePath)) {
      throw new Error(`Expected .cjs resolved member definition file. Got: ${JSON.stringify(cjsResolvedMemberDefinition)}`)
    }

    const resolvePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-service')\n</script>\n`,
      `<script server>\nresolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!resolvePathTargetInfo || normalizeFilePath(resolvePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected resolve() path target info. Got: ${JSON.stringify(resolvePathTargetInfo)}`)
    }
    const apiResolvePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<script server>\napi.resolve('board-service')\n</script>\n`,
      `<script server>\napi.resolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!apiResolvePathTargetInfo || normalizeFilePath(apiResolvePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected api.resolve() path target info. Got: ${JSON.stringify(apiResolvePathTargetInfo)}`)
    }
    const customResolveDefinition = service.getCustomDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nresolve('board-service')\n</script>\n`,
      `<script server>\nresolve('board-service')\n</script>\n`.indexOf('board-service') + 2
    )
    if (!customResolveDefinition || normalizeFilePath(customResolveDefinition) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected custom definition target for resolve() path. Got: ${JSON.stringify(customResolveDefinition)}`)
    }
    const mjsResolvePathTargetInfo = service.getPathTargetInfo(
      fixture.mjsConsumerFilePath,
      mjsConsumerText,
      mjsConsumerText.indexOf('cjs-state-service') + 2
    )
    if (!mjsResolvePathTargetInfo || normalizeFilePath(mjsResolvePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.cjsStateServiceFilePath)) {
      throw new Error(`Expected .mjs resolve() path target info. Got: ${JSON.stringify(mjsResolvePathTargetInfo)}`)
    }
    const mjsDocumentLinks = service.getDocumentLinks(fixture.mjsConsumerFilePath, mjsConsumerText)
    const mjsDocumentLinkTargets = mjsDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!mjsDocumentLinkTargets.includes(normalizeFilePath(fixture.cjsStateServiceFilePath))) {
      throw new Error(`Expected .mjs resolve() document link target. Got: ${mjsDocumentLinkTargets.join(', ')}`)
    }

    const groupedResolveText = `<script server>
const roles = {
  boardRole: resolve('roles/board'),
  postRole: resolve('roles/post'),
}
</script>\n`
    const groupedBoardResolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      groupedResolveText,
      groupedResolveText.indexOf('roles/board') + 2
    )
    if (!groupedBoardResolveDefinition || normalizeFilePath(groupedBoardResolveDefinition) !== normalizeFilePath(fixture.boardRoleFilePath)) {
      throw new Error(`Expected grouped resolve() definition target for roles/board. Got: ${groupedBoardResolveDefinition}`)
    }

    const groupedPostResolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      groupedResolveText,
      groupedResolveText.indexOf('roles/post') + 2
    )
    if (!groupedPostResolveDefinition || normalizeFilePath(groupedPostResolveDefinition) !== normalizeFilePath(fixture.postRoleFilePath)) {
      throw new Error(`Expected grouped resolve() definition target for roles/post. Got: ${groupedPostResolveDefinition}`)
    }

    const originalBoardRoleText = fs.readFileSync(fixture.boardRoleFilePath, 'utf8')
    const originalPostRoleText = fs.readFileSync(fixture.postRoleFilePath, 'utf8')
    const shadowedResolveMemberName = 'readScopedState'
    service.setDocumentOverride(
      fixture.boardRoleFilePath,
      `${originalBoardRoleText}

function readScopedState(params) {
  return !!params
}

module.exports.readScopedState = readScopedState
`
    )
    service.setDocumentOverride(
      fixture.postRoleFilePath,
      `${originalPostRoleText}

function readScopedState(params) {
  return !params
}

module.exports.readScopedState = readScopedState
`
    )
    const shadowedResolveText = `<script server>
const roleService = resolve('roles/board')
roleService.readScopedState({ request })

function loadPostRole() {
  const roleService = resolve('roles/post')
  return roleService.readScopedState({ request })
}
</script>
`
    const shadowedOuterOffset = shadowedResolveText.indexOf(shadowedResolveMemberName) + 2
    const shadowedInnerOffset = shadowedResolveText.lastIndexOf(shadowedResolveMemberName) + 2
    const shadowedOuterDefinition = service.getCustomDefinitionTarget(
      fixture.renameCheckFilePath,
      shadowedResolveText,
      shadowedOuterOffset
    )
    if (
      !shadowedOuterDefinition ||
      typeof shadowedOuterDefinition === 'string' ||
      normalizeFilePath(shadowedOuterDefinition.filePath) !== normalizeFilePath(fixture.boardRoleFilePath)
    ) {
      throw new Error(`Expected outer shadowed resolve() member definition to stay on roles/board. Got: ${JSON.stringify(shadowedOuterDefinition)}`)
    }
    const shadowedInnerDefinition = service.getCustomDefinitionTarget(
      fixture.renameCheckFilePath,
      shadowedResolveText,
      shadowedInnerOffset
    )
    if (
      !shadowedInnerDefinition ||
      typeof shadowedInnerDefinition === 'string' ||
      normalizeFilePath(shadowedInnerDefinition.filePath) !== normalizeFilePath(fixture.postRoleFilePath)
    ) {
      throw new Error(`Expected inner shadowed resolve() member definition to stay on roles/post. Got: ${JSON.stringify(shadowedInnerDefinition)}`)
    }
    const shadowedOuterRenameInfo = service.getCustomRenameInfo(
      fixture.renameCheckFilePath,
      shadowedResolveText,
      shadowedOuterOffset
    )
    if (
      !shadowedOuterRenameInfo ||
      !shadowedOuterRenameInfo.canRename ||
      normalizeFilePath(shadowedOuterRenameInfo.moduleDefinitionInfo.filePath) !== normalizeFilePath(fixture.boardRoleFilePath)
    ) {
      throw new Error(`Expected outer shadowed rename info to target roles/board. Got: ${JSON.stringify(shadowedOuterRenameInfo)}`)
    }
    const shadowedOuterRenameEdits = service.getCustomRenameEdits(
      fixture.renameCheckFilePath,
      shadowedResolveText,
      shadowedOuterOffset,
      'readBoardScopedState'
    )
    if (!shadowedOuterRenameEdits || !shadowedOuterRenameEdits.canRename) {
      throw new Error(`Expected outer shadowed rename edits. Got: ${JSON.stringify(shadowedOuterRenameEdits)}`)
    }
    const shadowedCallerEdits = shadowedOuterRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
    )
    const shadowedBoardRoleEdits = shadowedOuterRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardRoleFilePath)
    )
    const shadowedPostRoleEdits = shadowedOuterRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.postRoleFilePath)
    )
    const shadowedRenamedCallerText = applyEditsToText(shadowedResolveText, shadowedCallerEdits)
    if (!shadowedRenamedCallerText.includes('roleService.readBoardScopedState({ request })')) {
      throw new Error(`Expected outer shadowed caller usage to rename. Got: ${shadowedRenamedCallerText}`)
    }
    if (!shadowedRenamedCallerText.includes('return roleService.readScopedState({ request })')) {
      throw new Error(`Expected inner shadowed caller usage to stay unchanged. Got: ${shadowedRenamedCallerText}`)
    }
    if (!shadowedBoardRoleEdits.length) {
      throw new Error(`Expected outer shadowed rename to update roles/board export. Got: ${JSON.stringify(shadowedOuterRenameEdits)}`)
    }
    if (shadowedPostRoleEdits.length) {
      throw new Error(`Expected outer shadowed rename to avoid roles/post edits. Got: ${JSON.stringify(shadowedPostRoleEdits)}`)
    }
    service.clearDocumentOverride(fixture.boardRoleFilePath)
    service.clearDocumentOverride(fixture.postRoleFilePath)

    const backtickResolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nresolve(\`board-service\`)\n</script>\n`,
      `<script server>\nresolve(\`board-service\`)\n</script>\n`.indexOf('board-service') + 2
    )
    if (!backtickResolveDefinition || normalizeFilePath(backtickResolveDefinition) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected backtick resolve() definition target. Got: ${backtickResolveDefinition}`)
    }

    const parentResolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nresolve('../shared-service')\n</script>\n`,
      `<script server>\nresolve('../shared-service')\n</script>\n`.indexOf('../shared-service') + 3
    )
    if (!parentResolveDefinition || normalizeFilePath(parentResolveDefinition) !== normalizeFilePath(fixture.sharedServiceFilePath)) {
      throw new Error(`Expected ../ resolve() to skip the local _private module and use the parent-level one. Got: ${parentResolveDefinition}`)
    }

    const localResolveDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script server>\nresolve('shared-service')\n</script>\n`,
      `<script server>\nresolve('shared-service')\n</script>\n`.indexOf('shared-service') + 2
    )
    if (!localResolveDefinition || normalizeFilePath(localResolveDefinition) !== normalizeFilePath(fixture.localSharedServiceFilePath)) {
      throw new Error(`Expected simple resolve() to keep preferring the nearest _private module. Got: ${localResolveDefinition}`)
    }

    const includeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs') %>\n`,
      `<%- include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!includeDefinition || !includeDefinition.endsWith('/pb_hooks/pages/_private/flash-alert.ejs')) {
      throw new Error(`Expected include() definition target. Got: ${includeDefinition}`)
    }
    const apiIncludeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- api.include('flash-alert.ejs') %>\n`,
      `<%- api.include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!apiIncludeDefinition || normalizeFilePath(apiIncludeDefinition) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected api.include() definition target. Got: ${apiIncludeDefinition}`)
    }

    const includePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs') %>\n`,
      `<%- include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!includePathTargetInfo || normalizeFilePath(includePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected include() path target info. Got: ${JSON.stringify(includePathTargetInfo)}`)
    }
    if (
      !Array.isArray(includePathTargetInfo.includeLocals) ||
      !includePathTargetInfo.includeLocals.some((entry) => entry.name === 'flashMessage') ||
      !includePathTargetInfo.includeLocals.some((entry) => entry.name === 'flashMeta') ||
      !String(includePathTargetInfo.includeLocalsSummary || '').includes('isErrorFlash')
    ) {
      throw new Error(`Expected include() path hover info to expose locals contract. Got: ${JSON.stringify(includePathTargetInfo)}`)
    }
    const apiIncludePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<%- api.include('flash-alert.ejs') %>\n`,
      `<%- api.include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!apiIncludePathTargetInfo || normalizeFilePath(apiIncludePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected api.include() path target info. Got: ${JSON.stringify(apiIncludePathTargetInfo)}`)
    }
    if (
      !Array.isArray(apiIncludePathTargetInfo.includeLocals) ||
      !apiIncludePathTargetInfo.includeLocals.some((entry) => entry.name === 'flashMessage')
    ) {
      throw new Error(`Expected api.include() path hover info to expose locals contract. Got: ${JSON.stringify(apiIncludePathTargetInfo)}`)
    }

    const extlessIncludeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- include('flash-alert') %>\n`,
      `<%- include('flash-alert') %>\n`.indexOf('flash-alert') + 2
    )
    if (!extlessIncludeDefinition || normalizeFilePath(extlessIncludeDefinition) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected extless include() definition target. Got: ${extlessIncludeDefinition}`)
    }

    const extlessIncludeDiagnostics = serializeDiagnostics(service.getDiagnostics(fixture.boardsFilePath, `<%- include('flash-alert') %>\n`))
    if (extlessIncludeDiagnostics.some((entry) => entry.code === 'pp-unresolved-include-path')) {
      throw new Error(`Expected extless include() to avoid unresolved diagnostics. Got: ${JSON.stringify(extlessIncludeDiagnostics)}`)
    }

    const backtickIncludeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- include(\`flash-alert.ejs\`) %>\n`,
      `<%- include(\`flash-alert.ejs\`) %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!backtickIncludeDefinition || normalizeFilePath(backtickIncludeDefinition) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected backtick include() definition target. Got: ${backtickIncludeDefinition}`)
    }

    const localIncludeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- include('shared-panel.ejs', { banner: 'Saved' }) %>\n`,
      `<%- include('shared-panel.ejs', { banner: 'Saved' }) %>\n`.indexOf('shared-panel.ejs') + 2
    )
    if (!localIncludeDefinition || normalizeFilePath(localIncludeDefinition) !== normalizeFilePath(fixture.localSharedPanelFilePath)) {
      throw new Error(`Expected include() to prefer the nearest _private partial over route files. Got: ${localIncludeDefinition}`)
    }
    if (normalizeFilePath(localIncludeDefinition) === normalizeFilePath(fixture.routeSharedPanelFilePath)) {
      throw new Error(`Expected include() to avoid route-file shadowing. Got: ${localIncludeDefinition}`)
    }

    const parentIncludeDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<%- include('../shared-panel.ejs', { banner: 'Saved' }) %>\n`,
      `<%- include('../shared-panel.ejs', { banner: 'Saved' }) %>\n`.indexOf('../shared-panel.ejs') + 3
    )
    if (!parentIncludeDefinition || normalizeFilePath(parentIncludeDefinition) !== normalizeFilePath(fixture.sharedPanelFilePath)) {
      throw new Error(`Expected ../ include() to skip the local _private partial and use the parent-level one. Got: ${parentIncludeDefinition}`)
    }

    const globalAssetDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n`,
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n`.indexOf('/assets/booklog-reader.js') + 4
    )
    if (!globalAssetDefinition || normalizeFilePath(globalAssetDefinition) !== normalizeFilePath(fixture.globalAssetFilePath)) {
      throw new Error(`Expected asset() definition target for global asset. Got: ${globalAssetDefinition}`)
    }

    const localAssetDefinition = service.getDefinitionTarget(
      fixture.boardsFilePath,
      `<link rel="stylesheet" href="<%= asset('card.css') %>">\n`,
      `<link rel="stylesheet" href="<%= asset('card.css') %>">\n`.indexOf('card.css') + 2
    )
    if (!localAssetDefinition || normalizeFilePath(localAssetDefinition) !== normalizeFilePath(fixture.localAssetFilePath)) {
      throw new Error(`Expected asset() definition target for local asset. Got: ${localAssetDefinition}`)
    }

    const assetPathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n`,
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n`.indexOf('/assets/booklog-reader.js') + 4
    )
    if (!assetPathTargetInfo || normalizeFilePath(assetPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.globalAssetFilePath)) {
      throw new Error(`Expected asset() path target info. Got: ${JSON.stringify(assetPathTargetInfo)}`)
    }
    const hrefAssetPathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<a href="/assets/booklog-reader.js?v=1"></a>\n`,
      `<a href="/assets/booklog-reader.js?v=1"></a>\n`.indexOf('/assets/booklog-reader.js') + 4
    )
    if (
      !hrefAssetPathTargetInfo ||
      hrefAssetPathTargetInfo.kind !== 'asset-path' ||
      normalizeFilePath(hrefAssetPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.globalAssetFilePath)
    ) {
      throw new Error(`Expected href static asset path target info. Got: ${JSON.stringify(hrefAssetPathTargetInfo)}`)
    }

    const hooksRequireText = fs.readFileSync(fixture.htmlToTextConsumerFilePath, 'utf8')
    const hooksRequireOffset = hooksRequireText.indexOf('/pages/_private/vendor/html-to-text.bundle.js') + 5
    const hooksRequireDefinition = service.getDefinitionTarget(
      fixture.htmlToTextConsumerFilePath,
      hooksRequireText,
      hooksRequireOffset
    )
    if (!hooksRequireDefinition || normalizeFilePath(hooksRequireDefinition) !== normalizeFilePath(fixture.htmlToTextBundleFilePath)) {
      throw new Error(`Expected __hooks require() definition target. Got: ${JSON.stringify(hooksRequireDefinition)}`)
    }

    const hooksRequirePathTargetInfo = service.getPathTargetInfo(
      fixture.htmlToTextConsumerFilePath,
      hooksRequireText,
      hooksRequireOffset
    )
    if (
      !hooksRequirePathTargetInfo
      || normalizeFilePath(hooksRequirePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.htmlToTextBundleFilePath)
    ) {
      throw new Error(`Expected __hooks require() path target info. Got: ${JSON.stringify(hooksRequirePathTargetInfo)}`)
    }
    const hooksConcatRequireText = fs.readFileSync(fixture.htmlToTextConcatConsumerFilePath, 'utf8')
    const hooksConcatRequireOffset = hooksConcatRequireText.indexOf('/pages/_private/vendor/html-to-text.bundle.js') + 5
    const hooksConcatRequireDefinition = service.getDefinitionTarget(
      fixture.htmlToTextConcatConsumerFilePath,
      hooksConcatRequireText,
      hooksConcatRequireOffset
    )
    if (!hooksConcatRequireDefinition || normalizeFilePath(hooksConcatRequireDefinition) !== normalizeFilePath(fixture.htmlToTextBundleFilePath)) {
      throw new Error(`Expected __hooks string-concatenation require() definition target. Got: ${JSON.stringify(hooksConcatRequireDefinition)}`)
    }
    const hooksConcatRequirePathTargetInfo = service.getPathTargetInfo(
      fixture.htmlToTextConcatConsumerFilePath,
      hooksConcatRequireText,
      hooksConcatRequireOffset
    )
    if (
      !hooksConcatRequirePathTargetInfo
      || normalizeFilePath(hooksConcatRequirePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.htmlToTextBundleFilePath)
    ) {
      throw new Error(`Expected __hooks string-concatenation require() path target info. Got: ${JSON.stringify(hooksConcatRequirePathTargetInfo)}`)
    }

    const jobRequireText = fs.readFileSync(fixture.jobScriptFilePath, 'utf8')
    const jobRequireOffset = jobRequireText.indexOf('../pages/_private/board-service') + 5
    const jobRequireDefinition = service.getDefinitionTarget(
      fixture.jobScriptFilePath,
      jobRequireText,
      jobRequireOffset
    )
    if (!jobRequireDefinition || normalizeFilePath(jobRequireDefinition) !== normalizeFilePath(fixture.boardServiceFilePath)) {
      throw new Error(`Expected schema-only hook require() definition target. Got: ${JSON.stringify(jobRequireDefinition)}`)
    }
    const jobRequirePathTargetInfo = service.getRequirePathTargetInfo(
      fixture.jobScriptFilePath,
      jobRequireText,
      jobRequireOffset
    )
    if (
      !jobRequirePathTargetInfo
      || normalizeFilePath(jobRequirePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.boardServiceFilePath)
    ) {
      throw new Error(`Expected schema-only hook require() path target info. Got: ${JSON.stringify(jobRequirePathTargetInfo)}`)
    }

    const resolvedGlobalAssetTarget = service.projectIndex.resolveAssetTarget(
      fixture.boardsFilePath,
      '/assets/booklog-reader.js'
    )
    if (!resolvedGlobalAssetTarget || normalizeFilePath(resolvedGlobalAssetTarget) !== normalizeFilePath(fixture.globalAssetFilePath)) {
      throw new Error(`Expected project index to resolve global asset target. Got: ${resolvedGlobalAssetTarget}`)
    }

    const misclassifiedAssetRouteTarget = service.projectIndex.resolveRouteTarget(
      fixture.boardsFilePath,
      '/assets/booklog-reader',
      { routeSource: 'href' }
    )
    if (misclassifiedAssetRouteTarget) {
      throw new Error(`Expected asset files to stay out of route resolution. Got: ${misclassifiedAssetRouteTarget}`)
    }

    const resolvedLocalAssetTarget = service.projectIndex.resolveAssetTarget(
      fixture.boardsFilePath,
      'card.css'
    )
    if (!resolvedLocalAssetTarget || normalizeFilePath(resolvedLocalAssetTarget) !== normalizeFilePath(fixture.localAssetFilePath)) {
      throw new Error(`Expected project index to resolve local asset target. Got: ${resolvedLocalAssetTarget}`)
    }

    const hrefPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<a href="/boards"></a>\n`,
      `<a href="/boards"></a>\n`.indexOf('/boards') + 2
    )
    if (!hrefPathTargetInfo || normalizeFilePath(hrefPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.boardsFilePath)) {
      throw new Error(`Expected href path target info. Got: ${JSON.stringify(hrefPathTargetInfo)}`)
    }
    if (hrefPathTargetInfo.routeMethod !== 'PAGE' || hrefPathTargetInfo.routePath !== '/boards' || hrefPathTargetInfo.routeSource !== 'href') {
      throw new Error(`Expected href hover info to expose PAGE route resolution. Got: ${JSON.stringify(hrefPathTargetInfo)}`)
    }
    const feedbackActionPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<form action="/feedback" method="post"></form>\n`,
      `<form action="/feedback" method="post"></form>\n`.indexOf('/feedback') + 2
    )
    if (
      !feedbackActionPathTargetInfo
      || normalizeFilePath(feedbackActionPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.feedbackPostFilePath)
    ) {
      throw new Error(`Expected action path target info for feedback POST route. Got: ${JSON.stringify(feedbackActionPathTargetInfo)}`)
    }
    const feedbackHtmxPostPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<button hx-post="/feedback"></button>\n`,
      `<button hx-post="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (
      !feedbackHtmxPostPathTargetInfo
      || normalizeFilePath(feedbackHtmxPostPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.feedbackPostFilePath)
    ) {
      throw new Error(`Expected hx-post path target info for feedback POST route. Got: ${JSON.stringify(feedbackHtmxPostPathTargetInfo)}`)
    }
    const feedbackDataHtmxPostPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<button data-hx-post="/feedback"></button>\n`,
      `<button data-hx-post="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (
      !feedbackDataHtmxPostPathTargetInfo
      || normalizeFilePath(feedbackDataHtmxPostPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.feedbackPostFilePath)
    ) {
      throw new Error(`Expected data-hx-post path target info for feedback POST route. Got: ${JSON.stringify(feedbackDataHtmxPostPathTargetInfo)}`)
    }
    const feedbackHtmxDeletePathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<button hx-delete="/feedback"></button>\n`,
      `<button hx-delete="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (
      !feedbackHtmxDeletePathTargetInfo
      || normalizeFilePath(feedbackHtmxDeletePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.feedbackDeleteFilePath)
    ) {
      throw new Error(`Expected hx-delete path target info for feedback DELETE route. Got: ${JSON.stringify(feedbackHtmxDeletePathTargetInfo)}`)
    }
    const feedbackHtmxPutPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<button hx-put="/feedback"></button>\n`,
      `<button hx-put="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (
      !feedbackHtmxPutPathTargetInfo
      || normalizeFilePath(feedbackHtmxPutPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.feedbackPutFilePath)
    ) {
      throw new Error(`Expected hx-put path target info for feedback PUT route. Got: ${JSON.stringify(feedbackHtmxPutPathTargetInfo)}`)
    }
    const feedbackHtmxPatchPathTargetInfo = indexService.getPathTargetInfo(
      fixture.siteIndexFilePath,
      `<button hx-patch="/feedback"></button>\n`,
      `<button hx-patch="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (
      !feedbackHtmxPatchPathTargetInfo
      || normalizeFilePath(feedbackHtmxPatchPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.feedbackPatchFilePath)
    ) {
      throw new Error(`Expected hx-patch path target info for feedback PATCH route. Got: ${JSON.stringify(feedbackHtmxPatchPathTargetInfo)}`)
    }
    for (const [source, text, expectedFilePath, expectedMethod] of [
      ['@get', `<button data-on:click="@get('/feedback')"></button>\n`, fixture.feedbackPageFilePath, 'PAGE'],
      ['@post', `<button data-on:click="@post('/feedback')"></button>\n`, fixture.feedbackPostFilePath, 'POST'],
      ['@delete', `<button data-on:click="@delete('/feedback')"></button>\n`, fixture.feedbackDeleteFilePath, 'DELETE'],
      ['@put', `<button data-on:click="@put('/feedback')"></button>\n`, fixture.feedbackPutFilePath, 'PUT'],
      ['@patch', `<button data-on:click="@patch('/feedback')"></button>\n`, fixture.feedbackPatchFilePath, 'PATCH'],
    ]) {
      const datastarPathTargetInfo = indexService.getPathTargetInfo(
        fixture.siteIndexFilePath,
        text,
        text.indexOf('/feedback') + 2
      )
      if (
        !datastarPathTargetInfo
        || normalizeFilePath(datastarPathTargetInfo.targetFilePath) !== normalizeFilePath(expectedFilePath)
        || datastarPathTargetInfo.routeMethod !== expectedMethod
        || datastarPathTargetInfo.routePath !== '/feedback'
        || datastarPathTargetInfo.routeSource !== source
      ) {
        throw new Error(`Expected ${source} Datastar route path target info for ${expectedMethod} /feedback. Got: ${JSON.stringify(datastarPathTargetInfo)}`)
      }
    }
    for (const [label, info, expectedMethod, expectedSource] of [
      ['action', feedbackActionPathTargetInfo, 'POST', 'action-post'],
      ['hx-post', feedbackHtmxPostPathTargetInfo, 'POST', 'hx-post'],
      ['data-hx-post', feedbackDataHtmxPostPathTargetInfo, 'POST', 'hx-post'],
      ['hx-delete', feedbackHtmxDeletePathTargetInfo, 'DELETE', 'hx-delete'],
      ['hx-put', feedbackHtmxPutPathTargetInfo, 'PUT', 'hx-put'],
      ['hx-patch', feedbackHtmxPatchPathTargetInfo, 'PATCH', 'hx-patch'],
    ]) {
      if (info.routeMethod !== expectedMethod || info.routePath !== '/feedback' || info.routeSource !== expectedSource) {
        throw new Error(`Expected ${label} hover info to expose ${expectedMethod} route resolution. Got: ${JSON.stringify(info)}`)
      }
    }
    const jsRedirectText = `module.exports = function () {\n  redirect('/sign-in')\n  return\n}\n`
    const jsRedirectPathTargetInfo = service.getPathTargetInfo(
      fixture.feedbackLoadFilePath,
      jsRedirectText,
      jsRedirectText.indexOf('/sign-in') + 2
    )
    if (!jsRedirectPathTargetInfo || normalizeFilePath(jsRedirectPathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.siteSignInFilePath)) {
      throw new Error(`Expected JS redirect() path target info. Got: ${JSON.stringify(jsRedirectPathTargetInfo)}`)
    }
    const jsRedirectDocumentLinks = service.getDocumentLinks(fixture.feedbackLoadFilePath, jsRedirectText)
    const jsRedirectDocumentLinkTargets = jsRedirectDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!jsRedirectDocumentLinkTargets.includes(normalizeFilePath(fixture.siteSignInFilePath))) {
      throw new Error(`Expected JS redirect() document link target. Got: ${jsRedirectDocumentLinkTargets.join(', ')}`)
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
    service.setDocumentOverride(fixture.boardsFilePath, `<%- api.include('flash-alert.ejs') %>\n`)
    const apiPartialFileReferences = service.getFileReferenceTargets(fixture.flashAlertFilePath, fs.readFileSync(fixture.flashAlertFilePath, 'utf8'))
    const apiPartialCallerReferences = apiPartialFileReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    if (apiPartialCallerReferences.length !== 1) {
      throw new Error(`Expected api.include() file-based partial reference. Got: ${JSON.stringify(apiPartialFileReferences)}`)
    }
    service.clearDocumentOverride(fixture.boardsFilePath)

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
    const flashAlertPrelude = service.buildPrelude(fixture.flashAlertFilePath, privateTemplateHoverText)
    if (!flashAlertPrelude.includes('declare const flashMessage: string;')) {
      throw new Error(`Expected buildPrelude() to declare include locals for partial TS analysis. Got: ${flashAlertPrelude}`)
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
    const customRenameInfo = service.getCustomRenameInfo(fixture.renameCheckFilePath, renameText, renameOffset)
    if (!customRenameInfo || !customRenameInfo.canRename || customRenameInfo.placeholder !== 'readAuthState') {
      throw new Error(`Expected custom rename info for resolve()-derived member. Got: ${JSON.stringify(customRenameInfo)}`)
    }

    const renameEdits = service.getRenameEdits(fixture.renameCheckFilePath, renameText, renameOffset, 'readSessionState')
    if (!renameEdits || !renameEdits.canRename) {
      throw new Error(`Expected rename edits for resolve()-derived member. Got: ${JSON.stringify(renameEdits)}`)
    }
    const customRenameEdits = service.getCustomRenameEdits(
      fixture.renameCheckFilePath,
      renameText,
      renameOffset,
      'readSessionState'
    )
    if (!customRenameEdits || !customRenameEdits.canRename) {
      throw new Error(`Expected custom rename edits for resolve()-derived member. Got: ${JSON.stringify(customRenameEdits)}`)
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

    const tsRenameText = `<script server>\nconst localValue = 1\nlocalValue\n</script>\n`
    const tsRenameOffset = tsRenameText.lastIndexOf('localValue') + 2
    const tsRenameInfo = service.getTypeScriptRenameInfo(fixture.renameCheckFilePath, tsRenameText, tsRenameOffset)
    if (!tsRenameInfo || !tsRenameInfo.canRename || tsRenameInfo.placeholder !== 'localValue') {
      throw new Error(`Expected TypeScript rename info for local variable. Got: ${JSON.stringify(tsRenameInfo)}`)
    }
    const tsRenameEdits = service.getTypeScriptRenameEdits(
      fixture.renameCheckFilePath,
      tsRenameText,
      tsRenameOffset,
      'renamedValue'
    )
    if (!tsRenameEdits || !tsRenameEdits.canRename || tsRenameEdits.edits.length !== 2) {
      throw new Error(`Expected TypeScript rename edits for local variable. Got: ${JSON.stringify(tsRenameEdits)}`)
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

    if (moduleInitiatedBoardServiceEdits.length !== 2) {
      throw new Error(`Expected JS-initiated custom rename edits to update module declaration + export. Got: ${JSON.stringify(moduleInitiatedBoardServiceEdits)}`)
    }
    const renamedModuleInitiatedBoardServiceText = applyEditsToText(moduleRenameText, moduleInitiatedBoardServiceEdits)
    if (
      !renamedModuleInitiatedBoardServiceText.includes('function readSessionState(params)') ||
      !renamedModuleInitiatedBoardServiceText.includes('module.exports = {\n  readSessionState,')
    ) {
      throw new Error(`Expected JS-initiated custom rename to update module file text. Got: ${renamedModuleInitiatedBoardServiceText}`)
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

    const mjsRenameOffset = mjsConsumerText.indexOf('readCjsState') + 2
    const mjsRenameInfo = service.getRenameInfo(fixture.mjsConsumerFilePath, mjsConsumerText, mjsRenameOffset)
    if (!mjsRenameInfo || !mjsRenameInfo.canRename || mjsRenameInfo.placeholder !== 'readCjsState') {
      throw new Error(`Expected .mjs -> .cjs rename info. Got: ${JSON.stringify(mjsRenameInfo)}`)
    }

    const mjsRenameEdits = service.getRenameEdits(
      fixture.mjsConsumerFilePath,
      mjsConsumerText,
      mjsRenameOffset,
      'readServerState'
    )
    if (!mjsRenameEdits || !mjsRenameEdits.canRename) {
      throw new Error(`Expected .mjs -> .cjs rename edits. Got: ${JSON.stringify(mjsRenameEdits)}`)
    }

    const cjsModuleRenameEdits = mjsRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.cjsStateServiceFilePath)
    )
    const mjsConsumerRenameEdits = mjsRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.mjsConsumerFilePath)
    )

    if (cjsModuleRenameEdits.length < 2) {
      throw new Error(`Expected .cjs module rename edits for declaration + export. Got: ${JSON.stringify(cjsModuleRenameEdits)}`)
    }
    if (mjsConsumerRenameEdits.length !== 1) {
      throw new Error(`Expected .mjs caller rename edit. Got: ${JSON.stringify(mjsConsumerRenameEdits)}`)
    }

    const renamedCjsModuleText = applyEditsToText(fs.readFileSync(fixture.cjsStateServiceFilePath, 'utf8'), cjsModuleRenameEdits)
    if (!renamedCjsModuleText.includes('function readServerState()')) {
      throw new Error(`Expected renamed .cjs module declaration. Got: ${renamedCjsModuleText}`)
    }
    if (!renamedCjsModuleText.includes('module.exports = {\n  readServerState,')) {
      throw new Error(`Expected renamed .cjs module export. Got: ${renamedCjsModuleText}`)
    }

    const renamedMjsConsumerText = applyEditsToText(mjsConsumerText, mjsConsumerRenameEdits)
    if (!renamedMjsConsumerText.includes('cjsStateService.readServerState()')) {
      throw new Error(`Expected renamed .mjs caller usage. Got: ${renamedMjsConsumerText}`)
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

    const requiredModuleText = fs.readFileSync(fixture.importedCollectionConstantsFilePath, 'utf8')
    const requiredModuleOffset = requiredModuleText.indexOf('CACHE_COLLECTION_NAME') + 2
    const requiredModuleReferences = service.getReferenceTargets(
      fixture.importedCollectionConstantsFilePath,
      requiredModuleText,
      requiredModuleOffset,
      { includeDeclaration: true }
    )
    const requiredConsumerReferences = (requiredModuleReferences || []).filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConsumerFilePath)
    )
    if (!requiredModuleReferences || requiredConsumerReferences.length !== 3) {
      throw new Error(`Expected CommonJS require() member references to include binding and usages. Got: ${JSON.stringify(requiredModuleReferences)}`)
    }

    const missingModuleDefinitionRename = service.getModuleRenameLocations(undefined)
    if (!missingModuleDefinitionRename || missingModuleDefinitionRename.canRename !== false) {
      throw new Error(`Expected getModuleRenameLocations to safely report a non-renamable result for a missing definition instead of throwing. Got: ${JSON.stringify(missingModuleDefinitionRename)}`)
    }

    const requiredConsumerText = fs.readFileSync(fixture.importedCollectionConsumerFilePath, 'utf8')
    const requiredUsageOffset = requiredConsumerText.indexOf('CACHE_COLLECTION_NAME,') + 2
    const requiredMemberDefinition = service.getDefinitionTarget(
      fixture.importedCollectionConsumerFilePath,
      requiredConsumerText,
      requiredUsageOffset
    )
    if (
      !requiredMemberDefinition ||
      typeof requiredMemberDefinition === 'string' ||
      normalizeFilePath(requiredMemberDefinition.filePath) !== normalizeFilePath(fixture.importedCollectionConstantsFilePath)
    ) {
      throw new Error(`Expected CommonJS require() member definition to resolve to exported member. Got: ${JSON.stringify(requiredMemberDefinition)}`)
    }

    const requiredUsageReferences = service.getReferenceTargets(
      fixture.importedCollectionConsumerFilePath,
      requiredConsumerText,
      requiredUsageOffset,
      { includeDeclaration: true }
    )
    if (
      !requiredUsageReferences ||
      !requiredUsageReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConstantsFilePath)
      ) ||
      requiredUsageReferences.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConsumerFilePath)
      ).length !== 3
    ) {
      throw new Error(`Expected CommonJS require() member references from usage to include export and local usages. Got: ${JSON.stringify(requiredUsageReferences)}`)
    }

    const requiredModuleRenameEdits = service.getRenameEdits(
      fixture.importedCollectionConstantsFilePath,
      requiredModuleText,
      requiredModuleOffset,
      'BOARD_COLLECTION_NAME'
    )
    if (!requiredModuleRenameEdits || !requiredModuleRenameEdits.canRename) {
      throw new Error(`Expected CommonJS require() member rename from export to be available. Got: ${JSON.stringify(requiredModuleRenameEdits)}`)
    }

    const requiredModuleFileRenameEdits = requiredModuleRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConstantsFilePath)
    )
    const requiredConsumerRenameEdits = requiredModuleRenameEdits.edits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConsumerFilePath)
    )
    if (requiredModuleFileRenameEdits.length < 2 || requiredConsumerRenameEdits.length !== 3) {
      throw new Error(`Expected CommonJS require() rename to update export and require consumer. Got: ${JSON.stringify(requiredModuleRenameEdits)}`)
    }

    const renamedRequiredConsumerText = applyEditsToText(requiredConsumerText, requiredConsumerRenameEdits)
    if (
      !renamedRequiredConsumerText.includes("const { BOARD_COLLECTION_NAME } = require('./collection-constants')") ||
      renamedRequiredConsumerText.includes('CACHE_COLLECTION_NAME')
    ) {
      throw new Error(`Expected CommonJS require() rename to update binding and usages. Got: ${renamedRequiredConsumerText}`)
    }

    const requiredUsageRenameEdits = service.getRenameEdits(
      fixture.importedCollectionConsumerFilePath,
      requiredConsumerText,
      requiredUsageOffset,
      'BOARD_COLLECTION_NAME'
    )
    if (!requiredUsageRenameEdits || !requiredUsageRenameEdits.canRename) {
      throw new Error(`Expected CommonJS require() member rename from usage to be available. Got: ${JSON.stringify(requiredUsageRenameEdits)}`)
    }
    if (
      requiredUsageRenameEdits.edits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConstantsFilePath)
      ).length < 2 ||
      requiredUsageRenameEdits.edits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.importedCollectionConsumerFilePath)
      ).length !== 3
    ) {
      throw new Error(`Expected CommonJS require() rename from usage to update export and require consumer. Got: ${JSON.stringify(requiredUsageRenameEdits)}`)
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
    if (!moduleFileReferences || moduleFileReferences.length !== 5) {
      throw new Error(`Expected file-based resolve()/require() references in five files. Got: ${JSON.stringify(moduleFileReferences)}`)
    }
    if (!moduleFileReferences.some((entry) => normalizeFilePath(entry.filePath).endsWith('/pb_hooks/pages/_private/board-service-consumer.js'))) {
      throw new Error(`Expected file-based module references to include static require() usage. Got: ${JSON.stringify(moduleFileReferences)}`)
    }
    if (!moduleFileReferences.some((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.jobScriptFilePath))) {
      throw new Error(`Expected file-based module references to include schema-only hook require() usage. Got: ${JSON.stringify(moduleFileReferences)}`)
    }

    const hookScriptReferenceQuery = service.getFileReferenceQuery(fixture.sharedJobFilePath)
    if (!hookScriptReferenceQuery || hookScriptReferenceQuery.kind !== 'hook-script-module') {
      throw new Error(`Expected schema-only hook script reference query. Got: ${JSON.stringify(hookScriptReferenceQuery)}`)
    }
    const hookScriptReferences = service.getFileReferenceTargets(
      fixture.sharedJobFilePath,
      fs.readFileSync(fixture.sharedJobFilePath, 'utf8')
    )
    if (
      !hookScriptReferences ||
      hookScriptReferences.length !== 1 ||
      normalizeFilePath(hookScriptReferences[0].filePath) !== normalizeFilePath(fixture.jobScriptFilePath)
    ) {
      throw new Error(`Expected schema-only hook require() references. Got: ${JSON.stringify(hookScriptReferences)}`)
    }
    service.setDocumentOverride(fixture.renameCheckFilePath, `<script server>\nconst boardService = api.resolve('board-service')\n</script>\n`)
    const apiModuleFileReferences = service.getFileReferenceTargets(
      fixture.boardServiceFilePath,
      fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
    )
    const apiModuleCallerReferences = apiModuleFileReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath)
    )
    if (apiModuleCallerReferences.length !== 1) {
      throw new Error(`Expected api.resolve() file-based module reference. Got: ${JSON.stringify(apiModuleFileReferences)}`)
    }
    service.clearDocumentOverride(fixture.renameCheckFilePath)

    const hooksRequireReferenceQuery = service.getFileReferenceQuery(fixture.htmlToTextBundleFilePath)
    if (!hooksRequireReferenceQuery || hooksRequireReferenceQuery.kind !== 'private-module') {
      throw new Error(`Expected __hooks require target to expose a private-module reference query. Got: ${JSON.stringify(hooksRequireReferenceQuery)}`)
    }

    const hooksRequireReferences = service.getFileReferenceTargets(
      fixture.htmlToTextBundleFilePath,
      fs.readFileSync(fixture.htmlToTextBundleFilePath, 'utf8')
    )
    if (!hooksRequireReferences || hooksRequireReferences.length !== 3) {
      throw new Error(`Expected __hooks require references for JS and EJS callers. Got: ${JSON.stringify(hooksRequireReferences)}`)
    }
    if (
      normalizeFilePath(hooksRequireReferences[0].filePath) !== normalizeFilePath(fixture.htmlToTextConsumerFilePath)
      && normalizeFilePath(hooksRequireReferences[0].filePath) !== normalizeFilePath(fixture.htmlToTextConcatConsumerFilePath)
      && normalizeFilePath(hooksRequireReferences[0].filePath) !== normalizeFilePath(fixture.htmlToTextPageConsumerFilePath)
    ) {
      throw new Error(`Expected __hooks require reference to point at an html-to-text consumer file. Got: ${JSON.stringify(hooksRequireReferences)}`)
    }
    if (
      !hooksRequireReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextConcatConsumerFilePath)
      )
    ) {
      throw new Error(`Expected __hooks string-concatenation require reference. Got: ${JSON.stringify(hooksRequireReferences)}`)
    }
    if (
      !hooksRequireReferences.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextPageConsumerFilePath)
      )
    ) {
      throw new Error(`Expected __hooks EJS require reference. Got: ${JSON.stringify(hooksRequireReferences)}`)
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

    const extensionlessPartialCallerText = `<%- include('flash-alert', { flashMessage: 'Saved' }) %>\n`
    service.setDocumentOverride(fixture.boardsFilePath, extensionlessPartialCallerText)
    const extensionlessPartialRenameEdits = service.getFileRenameEdits(
      fixture.flashAlertFilePath,
      path.resolve(path.dirname(fixture.flashAlertFilePath), 'notice-alert.ejs')
    )
    const extensionlessBoardsEdits = extensionlessPartialRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    if (extensionlessBoardsEdits.length !== 1) {
      throw new Error(`Expected extensionless include() rename edit. Got: ${JSON.stringify(extensionlessPartialRenameEdits)}`)
    }
    const renamedExtensionlessPartialText = applyEditsToText(extensionlessPartialCallerText, extensionlessBoardsEdits)
    if (
      !renamedExtensionlessPartialText.includes(`include('notice-alert'`) ||
      renamedExtensionlessPartialText.includes('notice-alert.ejs')
    ) {
      throw new Error(`Expected extensionless include() rename to preserve extensionless style. Got: ${renamedExtensionlessPartialText}`)
    }
    service.clearDocumentOverride(fixture.boardsFilePath)

    const apiPartialCallerText = `<%- api.include('flash-alert.ejs') %>\n`
    service.setDocumentOverride(fixture.boardsFilePath, apiPartialCallerText)
    const apiPartialRenameEdits = service.getFileRenameEdits(
      fixture.flashAlertFilePath,
      path.resolve(path.dirname(fixture.flashAlertFilePath), 'notice-alert.ejs')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath))
    if (apiPartialRenameEdits.length !== 1) {
      throw new Error(`Expected api.include() rename edit. Got: ${JSON.stringify(apiPartialRenameEdits)}`)
    }
    const renamedApiPartialText = applyEditsToText(apiPartialCallerText, apiPartialRenameEdits)
    if (!renamedApiPartialText.includes(`api.include('notice-alert.ejs')`)) {
      throw new Error(`Expected api.include() request path to update after partial file rename. Got: ${renamedApiPartialText}`)
    }
    service.clearDocumentOverride(fixture.boardsFilePath)

    const moduleFileRenameEdits = service.getFileRenameEdits(
      fixture.boardServiceFilePath,
      path.resolve(path.dirname(fixture.boardServiceFilePath), 'session-service.js')
    )
    if (!moduleFileRenameEdits || moduleFileRenameEdits.length !== 5) {
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

    const parentResolveRenameEdits = service.getFileRenameEdits(
      fixture.sharedServiceFilePath,
      path.resolve(path.dirname(fixture.sharedServiceFilePath), 'summary-service.js')
    )
    const resolveParentCheckEdits = parentResolveRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.resolveParentCheckFilePath)
    )
    if (resolveParentCheckEdits.length !== 1) {
      throw new Error(`Expected parent-level resolve() rename edit. Got: ${JSON.stringify(resolveParentCheckEdits)}`)
    }
    const renamedResolveParentCheckText = applyEditsToText(
      fs.readFileSync(fixture.resolveParentCheckFilePath, 'utf8'),
      resolveParentCheckEdits
    )
    if (!renamedResolveParentCheckText.includes(`resolve('../summary-service')`)) {
      throw new Error(`Expected ../ resolve() path to update after parent module rename. Got: ${renamedResolveParentCheckText}`)
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

    const renamedJobRequireText = applyEditsToText(
      fs.readFileSync(fixture.jobScriptFilePath, 'utf8'),
      moduleFileRenameEdits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.jobScriptFilePath)
      )
    )
    if (!renamedJobRequireText.includes(`require('../pages/_private/session-service')`)) {
      throw new Error(`Expected schema-only hook require() path to update after module file rename. Got: ${renamedJobRequireText}`)
    }

    const hookScriptRenameEdits = service.getFileRenameEdits(
      fixture.sharedJobFilePath,
      path.resolve(path.dirname(fixture.sharedJobFilePath), 'shared-job-renamed.js')
    )
    const jobHookRenameEdits = hookScriptRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.jobScriptFilePath)
    )
    if (jobHookRenameEdits.length !== 1) {
      throw new Error(`Expected schema-only hook target rename to update require() caller. Got: ${JSON.stringify(hookScriptRenameEdits)}`)
    }
    const renamedHookRequireText = applyEditsToText(
      fs.readFileSync(fixture.jobScriptFilePath, 'utf8'),
      jobHookRenameEdits
    )
    if (!renamedHookRequireText.includes(`require('./shared-job-renamed')`)) {
      throw new Error(`Expected schema-only hook target rename to preserve relative require() style. Got: ${renamedHookRequireText}`)
    }

    const apiModuleCallerText = `<script server>\nconst boardService = api.resolve('board-service')\n</script>\n`
    service.setDocumentOverride(fixture.renameCheckFilePath, apiModuleCallerText)
    const apiModuleRenameEdits = service.getFileRenameEdits(
      fixture.boardServiceFilePath,
      path.resolve(path.dirname(fixture.boardServiceFilePath), 'session-service.js')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.renameCheckFilePath))
    if (apiModuleRenameEdits.length !== 1) {
      throw new Error(`Expected api.resolve() rename edit. Got: ${JSON.stringify(apiModuleRenameEdits)}`)
    }
    const renamedApiModuleText = applyEditsToText(apiModuleCallerText, apiModuleRenameEdits)
    if (!renamedApiModuleText.includes(`api.resolve('session-service')`)) {
      throw new Error(`Expected api.resolve() path to update after module file rename. Got: ${renamedApiModuleText}`)
    }
    service.clearDocumentOverride(fixture.renameCheckFilePath)

    const hooksRequireRenameEdits = service.getFileRenameEdits(
      fixture.htmlToTextBundleFilePath,
      path.resolve(path.dirname(fixture.htmlToTextBundleFilePath), 'markdown-renderer.bundle.js')
    )
    if (!hooksRequireRenameEdits || hooksRequireRenameEdits.length !== 3) {
      throw new Error(`Expected __hooks require rename edits for JS and EJS callers. Got: ${JSON.stringify(hooksRequireRenameEdits)}`)
    }
    if (
      !hooksRequireRenameEdits.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextConsumerFilePath)
      )
    ) {
      throw new Error(`Expected template-literal require rename edit in html-to-text-consumer.js. Got: ${JSON.stringify(hooksRequireRenameEdits)}`)
    }

    const renamedHooksRequireConsumerText = applyEditsToText(
      fs.readFileSync(fixture.htmlToTextConsumerFilePath, 'utf8'),
      hooksRequireRenameEdits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextConsumerFilePath)
      )
    )
    if (!renamedHooksRequireConsumerText.includes('require(`${__hooks}/pages/_private/vendor/markdown-renderer.bundle.js`)')) {
      throw new Error(`Expected template-literal require(__hooks...) path to update after module file rename. Got: ${renamedHooksRequireConsumerText}`)
    }

    const renamedHooksConcatConsumerText = applyEditsToText(
      fs.readFileSync(fixture.htmlToTextConcatConsumerFilePath, 'utf8'),
      hooksRequireRenameEdits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextConcatConsumerFilePath)
      )
    )
    if (!renamedHooksConcatConsumerText.includes("require(__hooks + '/pages/_private/vendor/markdown-renderer.bundle.js')")) {
      throw new Error(`Expected __hooks string-concatenation require path to update after module file rename. Got: ${renamedHooksConcatConsumerText}`)
    }

    const renamedHooksPageConsumerText = applyEditsToText(
      fs.readFileSync(fixture.htmlToTextPageConsumerFilePath, 'utf8'),
      hooksRequireRenameEdits.filter(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextPageConsumerFilePath)
      )
    )
    if (!renamedHooksPageConsumerText.includes("require(`${__hooks}/pages/_private/vendor/markdown-renderer.bundle.js`)")) {
      throw new Error(`Expected EJS __hooks require path to update after module file rename. Got: ${renamedHooksPageConsumerText}`)
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

    const requireFalsePositiveCallerText = `// require('./board-service') should stay comment
const ignoredRequireText = "require('./board-service')"
const actualBoardService = require('./board-service')

module.exports = {
  ignoredRequireText,
  actualBoardService,
}
`
    service.setDocumentOverride(fixture.boardServiceConsumerFilePath, requireFalsePositiveCallerText)
    const requireFalsePositiveRenameEdits = service.getFileRenameEdits(
      fixture.boardServiceFilePath,
      path.resolve(path.dirname(fixture.boardServiceFilePath), 'session-service.js')
    )
    const filteredRequireFalsePositiveEdits = requireFalsePositiveRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardServiceConsumerFilePath)
    )
    if (filteredRequireFalsePositiveEdits.length !== 1) {
      throw new Error(`Expected only one executable require() rename edit. Got: ${JSON.stringify(filteredRequireFalsePositiveEdits)}`)
    }
    const requireFalsePositiveRenamedText = applyEditsToText(
      requireFalsePositiveCallerText,
      filteredRequireFalsePositiveEdits
    )
    if ((requireFalsePositiveRenamedText.match(/board-service/g) || []).length !== 2) {
      throw new Error(`Expected comment/string require text to stay unchanged. Got: ${requireFalsePositiveRenamedText}`)
    }
    if ((requireFalsePositiveRenamedText.match(/session-service/g) || []).length !== 1) {
      throw new Error(`Expected only the executable require() path to rename. Got: ${requireFalsePositiveRenamedText}`)
    }

    const hooksRequireFalsePositivePageText = `<script server>
  const { compile } = require(\`\${__hooks}/pages/_private/vendor/html-to-text.bundle.js\`)
</script>
<!-- require(\`\${__hooks}/pages/_private/vendor/html-to-text.bundle.js\`) should stay comment -->
<div data-example="require(\`\${__hooks}/pages/_private/vendor/html-to-text.bundle.js\`)"></div>
<div><%= compile('<p>Hello</p>') %></div>
`
    service.setDocumentOverride(fixture.htmlToTextPageConsumerFilePath, hooksRequireFalsePositivePageText)
    const hooksRequireFalsePositiveRenameEdits = service.getFileRenameEdits(
      fixture.htmlToTextBundleFilePath,
      path.resolve(path.dirname(fixture.htmlToTextBundleFilePath), 'markdown-renderer.bundle.js')
    )
    const filteredHooksRequireFalsePositiveEdits = hooksRequireFalsePositiveRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.htmlToTextPageConsumerFilePath)
    )
    if (filteredHooksRequireFalsePositiveEdits.length !== 1) {
      throw new Error(`Expected only one executable __hooks require() rename edit in EJS. Got: ${JSON.stringify(filteredHooksRequireFalsePositiveEdits)}`)
    }
    const hooksRequireFalsePositiveRenamedText = applyEditsToText(
      hooksRequireFalsePositivePageText,
      filteredHooksRequireFalsePositiveEdits
    )
    if ((hooksRequireFalsePositiveRenamedText.match(/html-to-text\.bundle\.js/g) || []).length !== 2) {
      throw new Error(`Expected comment/html __hooks require text to stay unchanged. Got: ${hooksRequireFalsePositiveRenamedText}`)
    }
    if ((hooksRequireFalsePositiveRenamedText.match(/markdown-renderer\.bundle\.js/g) || []).length !== 1) {
      throw new Error(`Expected only the executable EJS require() path to rename. Got: ${hooksRequireFalsePositiveRenamedText}`)
    }

    service.clearDocumentOverride(fixture.renameCheckFilePath)
    service.clearDocumentOverride(fixture.boardServiceConsumerFilePath)
    service.clearDocumentOverride(fixture.htmlToTextPageConsumerFilePath)

    const renamedSignInRouteFilePath = path.join(path.dirname(fixture.siteSignInFilePath), 'login.ejs')
    const routeFileRenameEdits = service.getFileRenameEdits(fixture.siteSignInFilePath, renamedSignInRouteFilePath)
    const routeReferenceCheckEdits = routeFileRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    const signOutRouteEdits = routeFileRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.signOutFilePath)
    )
    if (routeReferenceCheckEdits.length !== 4) {
      throw new Error(`Expected four route-path edits for renamed /sign-in route callers. Got: ${JSON.stringify(routeReferenceCheckEdits)}`)
    }
    if (signOutRouteEdits.length !== 1) {
      throw new Error(`Expected one redirect edit in sign-out.ejs for renamed /sign-in route. Got: ${JSON.stringify(signOutRouteEdits)}`)
    }
    const routeReferenceCheckRenamedText = applyEditsToText(
      fs.readFileSync(fixture.routeReferenceCheckFilePath, 'utf8'),
      routeReferenceCheckEdits
    )
    if ((routeReferenceCheckRenamedText.match(/\/login/g) || []).length !== 4) {
      throw new Error(`Expected href/action/hx-get/redirect callers to rewrite to /login. Got: ${routeReferenceCheckRenamedText}`)
    }
    const signOutRenamedText = applyEditsToText(
      fs.readFileSync(fixture.signOutFilePath, 'utf8'),
      signOutRouteEdits
    )
    if (!signOutRenamedText.includes("redirect('/login')")) {
      throw new Error(`Expected sign-out redirect caller to rewrite to /login. Got: ${signOutRenamedText}`)
    }

    const apiRedirectCallerText = `<script server>\napi.redirect('/sign-in')\n</script>\n`
    service.setDocumentOverride(fixture.routeReferenceCheckFilePath, apiRedirectCallerText)
    const apiRedirectRouteReferences = service.getFileReferenceTargets(
      fixture.siteSignInFilePath,
      fs.readFileSync(fixture.siteSignInFilePath, 'utf8')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath))
    if (apiRedirectRouteReferences.length !== 1) {
      throw new Error(`Expected api.redirect() route reference for /sign-in. Got: ${JSON.stringify(apiRedirectRouteReferences)}`)
    }
    const apiRedirectRenameEdits = service.getFileRenameEdits(fixture.siteSignInFilePath, renamedSignInRouteFilePath).filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (apiRedirectRenameEdits.length !== 1) {
      throw new Error(`Expected api.redirect() route rename edit for /sign-in. Got: ${JSON.stringify(apiRedirectRenameEdits)}`)
    }
    const apiRedirectRenamedText = applyEditsToText(apiRedirectCallerText, apiRedirectRenameEdits)
    if (!apiRedirectRenamedText.includes("api.redirect('/login')")) {
      throw new Error(`Expected api.redirect() caller to rewrite to /login. Got: ${apiRedirectRenamedText}`)
    }

    const responseRedirectCallerText = `<script server>\nresponse.redirect('/sign-in')\n</script>\n`
    service.setDocumentOverride(fixture.routeReferenceCheckFilePath, responseRedirectCallerText)
    const responseRedirectRouteReferences = service.getFileReferenceTargets(
      fixture.siteSignInFilePath,
      fs.readFileSync(fixture.siteSignInFilePath, 'utf8')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath))
    if (responseRedirectRouteReferences.length !== 1) {
      throw new Error(`Expected response.redirect() route reference for /sign-in. Got: ${JSON.stringify(responseRedirectRouteReferences)}`)
    }
    const responseRedirectRenameEdits = service.getFileRenameEdits(fixture.siteSignInFilePath, renamedSignInRouteFilePath).filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (responseRedirectRenameEdits.length !== 1) {
      throw new Error(`Expected response.redirect() route rename edit for /sign-in. Got: ${JSON.stringify(responseRedirectRenameEdits)}`)
    }
    const responseRedirectRenamedText = applyEditsToText(responseRedirectCallerText, responseRedirectRenameEdits)
    if (!responseRedirectRenamedText.includes("response.redirect('/login')")) {
      throw new Error(`Expected response.redirect() caller to rewrite to /login. Got: ${responseRedirectRenamedText}`)
    }

    const datastarUrlCallerText = `<script server>\ndatastar.redirect('/sign-in')\ndatastar.replaceURL('/sign-in')\n</script>\n`
    service.setDocumentOverride(fixture.routeReferenceCheckFilePath, datastarUrlCallerText)
    const datastarUrlRouteReferences = service.getFileReferenceTargets(
      fixture.siteSignInFilePath,
      fs.readFileSync(fixture.siteSignInFilePath, 'utf8')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath))
    if (datastarUrlRouteReferences.length !== 2) {
      throw new Error(`Expected Datastar URL helpers to reference /sign-in. Got: ${JSON.stringify(datastarUrlRouteReferences)}`)
    }
    const datastarUrlRenameEdits = service.getFileRenameEdits(fixture.siteSignInFilePath, renamedSignInRouteFilePath).filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (datastarUrlRenameEdits.length !== 2) {
      throw new Error(`Expected Datastar URL helper rename edits for /sign-in. Got: ${JSON.stringify(datastarUrlRenameEdits)}`)
    }
    const datastarUrlRenamedText = applyEditsToText(datastarUrlCallerText, datastarUrlRenameEdits)
    if (
      !datastarUrlRenamedText.includes("datastar.redirect('/login')") ||
      !datastarUrlRenamedText.includes("datastar.replaceURL('/login')")
    ) {
      throw new Error(`Expected Datastar URL helper callers to rewrite to /login. Got: ${datastarUrlRenamedText}`)
    }
    service.clearDocumentOverride(fixture.routeReferenceCheckFilePath)

    const renamedFeedbackPageFilePath = path.join(path.dirname(fixture.feedbackPageFilePath), 'login.ejs')
    const feedbackRouteRenameEdits = service.getFileRenameEdits(fixture.feedbackPageFilePath, renamedFeedbackPageFilePath)
    const feedbackRouteReferenceEdits = feedbackRouteRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    if (feedbackRouteReferenceEdits.length !== 1) {
      throw new Error(`Expected only href callers to rewrite when the feedback page route is renamed alongside a POST route. Got: ${JSON.stringify(feedbackRouteReferenceEdits)}`)
    }
    const feedbackRouteReferenceRenamedText = applyEditsToText(
      fs.readFileSync(fixture.routeMethodReferenceCheckFilePath, 'utf8'),
      feedbackRouteReferenceEdits
    )
    if (!feedbackRouteReferenceRenamedText.includes('href="/feedback/login"')) {
      throw new Error(`Expected href caller to rewrite to /feedback/login. Got: ${feedbackRouteReferenceRenamedText}`)
    }
    if (!feedbackRouteReferenceRenamedText.includes('action="/feedback"')) {
      throw new Error(`Expected POST form action to stay on /feedback while +post.js still exists. Got: ${feedbackRouteReferenceRenamedText}`)
    }
    if (!feedbackRouteReferenceRenamedText.includes('hx-post="/feedback"')) {
      throw new Error(`Expected hx-post caller to stay on /feedback while +post.js still exists. Got: ${feedbackRouteReferenceRenamedText}`)
    }
    if (!feedbackRouteReferenceRenamedText.includes('data-hx-post="/feedback"')) {
      throw new Error(`Expected data-hx-post caller to stay on /feedback while +post.js still exists. Got: ${feedbackRouteReferenceRenamedText}`)
    }

    const formMethodRouteCallerText = `<form action="/feedback"></form>
<form action="/feedback" method="get"></form>
<form action="/feedback" method="post"></form>
<form action="/feedback" method="<%= request.method %>"></form>
`
    service.setDocumentOverride(fixture.routeMethodReferenceCheckFilePath, formMethodRouteCallerText)
    const formMethodPageReferences = service.getFileReferenceTargets(
      fixture.feedbackPageFilePath,
      fs.readFileSync(fixture.feedbackPageFilePath, 'utf8')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath))
    const formMethodPostReferences = service.getFileReferenceTargets(
      fixture.feedbackPostFilePath,
      fs.readFileSync(fixture.feedbackPostFilePath, 'utf8')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath))
    if (formMethodPageReferences.length !== 2) {
      throw new Error(`Expected default/get form actions to reference the page route. Got: ${JSON.stringify(formMethodPageReferences)}`)
    }
    if (formMethodPostReferences.length !== 2) {
      throw new Error(`Expected post form action to reference the POST route. Got: ${JSON.stringify(formMethodPostReferences)}`)
    }

    const formMethodPageRenameEdits = service.getFileRenameEdits(fixture.feedbackPageFilePath, renamedFeedbackPageFilePath)
    const formMethodPageCallerEdits = formMethodPageRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    if (formMethodPageCallerEdits.length !== 2) {
      throw new Error(`Expected default/get form actions to rewrite when the page route is renamed. Got: ${JSON.stringify(formMethodPageCallerEdits)}`)
    }
    const formMethodPageRenamedText = applyEditsToText(formMethodRouteCallerText, formMethodPageCallerEdits)
    if ((formMethodPageRenamedText.match(/action="\/feedback\/login"/g) || []).length !== 2) {
      throw new Error(`Expected default/get form actions to rewrite to /feedback/login. Got: ${formMethodPageRenamedText}`)
    }
    if (
      !formMethodPageRenamedText.includes('<form action="/feedback" method="post"></form>') ||
      !formMethodPageRenamedText.includes('<form action="/feedback" method="<%= request.method %>"></form>')
    ) {
      throw new Error(`Expected post/dynamic form actions to stay on the broader action route while +post.js still exists. Got: ${formMethodPageRenamedText}`)
    }
    service.clearDocumentOverride(fixture.routeMethodReferenceCheckFilePath)

    const oldFeedbackRouteDirectoryPath = path.dirname(fixture.feedbackPageFilePath)
    const newFeedbackRouteDirectoryPath = path.join(path.dirname(oldFeedbackRouteDirectoryPath), 'responses')
    const feedbackDirectoryRenameEdits = service.getFileRenameEdits(
      oldFeedbackRouteDirectoryPath,
      newFeedbackRouteDirectoryPath
    )
    const feedbackDirectoryRouteReferenceEdits = feedbackDirectoryRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    if (feedbackDirectoryRouteReferenceEdits.length !== 7) {
      throw new Error(`Expected all method-aware feedback route callers to rewrite on folder rename. Got: ${JSON.stringify(feedbackDirectoryRenameEdits)}`)
    }
    const feedbackDirectoryRenamedText = applyEditsToText(
      fs.readFileSync(fixture.routeMethodReferenceCheckFilePath, 'utf8'),
      feedbackDirectoryRouteReferenceEdits
    )
    for (const expectedRouteCaller of [
      'href="/responses"',
      'action="/responses"',
      'hx-post="/responses"',
      'data-hx-post="/responses"',
      'hx-delete="/responses"',
      'hx-put="/responses"',
      'hx-patch="/responses"',
    ]) {
      if (!feedbackDirectoryRenamedText.includes(expectedRouteCaller)) {
        throw new Error(`Expected feedback folder rename to rewrite ${expectedRouteCaller}. Got: ${feedbackDirectoryRenamedText}`)
      }
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

    const partialCodeLensEntries = service.getCodeLensEntries(
      fixture.flashAlertFilePath,
      fs.readFileSync(fixture.flashAlertFilePath, 'utf8')
    )
    if (!partialCodeLensEntries.some((entry) => entry.title.startsWith('Partial callers: '))) {
      throw new Error(`Expected partial caller CodeLens entry. Got: ${JSON.stringify(partialCodeLensEntries)}`)
    }
    if (!partialCodeLensEntries.some((entry) => entry.title === 'Caller: pb_hooks/pages/(site)/boards/index.ejs:1')) {
      throw new Error(`Expected partial caller CodeLens to preview the caller file and line. Got: ${JSON.stringify(partialCodeLensEntries)}`)
    }
    if (!partialCodeLensEntries.some((entry) => entry.title.startsWith('All File References ('))) {
      throw new Error(`Expected partial all-file-references CodeLens entry. Got: ${JSON.stringify(partialCodeLensEntries)}`)
    }

    const boardsCodeLensEntries = service.getCodeLensEntries(
      fixture.boardsFilePath,
      fs.readFileSync(fixture.boardsFilePath, 'utf8')
    )
    const includePathCodeLens = boardsCodeLensEntries.find((entry) => entry.title.startsWith('-> pb_hooks/pages/_private/flash-alert.ejs'))
    if (
      !includePathCodeLens ||
      typeof includePathCodeLens.start !== 'number' ||
      includePathCodeLens.start <= 0 ||
      normalizeFilePath(includePathCodeLens.targetFilePath) !== normalizeFilePath(fixture.flashAlertFilePath)
    ) {
      throw new Error(`Expected include() path CodeLens entry above the include call. Got: ${JSON.stringify(boardsCodeLensEntries)}`)
    }
    if (
      !includePathCodeLens.title.includes('locals:') ||
      !includePathCodeLens.title.includes('flashMessage') ||
      !includePathCodeLens.title.includes('flashMeta') ||
      !includePathCodeLens.title.includes('isErrorFlash')
    ) {
      throw new Error(`Expected include() path CodeLens title to expose the partial locals contract. Got: ${JSON.stringify(includePathCodeLens)}`)
    }

    const routeCodeLensEntries = service.getCodeLensEntries(
      fixture.boardShowFilePath,
      fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    )
    if (!routeCodeLensEntries.some((entry) => entry.title === 'Route: PAGE /boards/[boardSlug]')) {
      throw new Error(`Expected dynamic route CodeLens entry. Got: ${JSON.stringify(routeCodeLensEntries)}`)
    }
    const feedbackGetCodeLensEntries = service.getCodeLensEntries(
      fixture.feedbackGetFilePath,
      fs.readFileSync(fixture.feedbackGetFilePath, 'utf8')
    )
    if (!feedbackGetCodeLensEntries.some((entry) => entry.title === 'Route: GET /feedback')) {
      throw new Error(`Expected GET route CodeLens entry. Got: ${JSON.stringify(feedbackGetCodeLensEntries)}`)
    }
    const feedbackPostCodeLensEntries = service.getCodeLensEntries(
      fixture.feedbackPostFilePath,
      fs.readFileSync(fixture.feedbackPostFilePath, 'utf8')
    )
    if (!feedbackPostCodeLensEntries.some((entry) => entry.title === 'Route: POST /feedback')) {
      throw new Error(`Expected POST route CodeLens entry. Got: ${JSON.stringify(feedbackPostCodeLensEntries)}`)
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

    const dynamicRouteCallerText = `<a href="/boards/demo-board"></a>
<button hx-get="/boards/demo-board"></button>
<script server>
redirect('/boards/demo-board')
</script>
`
    service.setDocumentOverride(fixture.routeReferenceCheckFilePath, dynamicRouteCallerText)
    const dynamicRouteReferenceQuery = service.getFileReferenceQuery(fixture.boardShowFilePath)
    if (
      !dynamicRouteReferenceQuery ||
      dynamicRouteReferenceQuery.kind !== 'route-file' ||
      dynamicRouteReferenceQuery.routePath !== '/boards/[boardSlug]' ||
      dynamicRouteReferenceQuery.routeMethod !== 'PAGE'
    ) {
      throw new Error(`Expected dynamic route file reference query for /boards/[boardSlug]. Got: ${JSON.stringify(dynamicRouteReferenceQuery)}`)
    }
    const dynamicRouteReferences = service.getFileReferenceTargets(
      fixture.boardShowFilePath,
      fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    )
    const dynamicRouteCallerMatches = dynamicRouteReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (dynamicRouteCallerMatches.length !== 3) {
      throw new Error(`Expected href/hx-get/redirect references for dynamic board route. Got: ${JSON.stringify(dynamicRouteReferences)}`)
    }
    const renamedBoardRouteFilePath = path.join(path.dirname(fixture.boardShowFilePath), 'details.ejs')
    const dynamicRouteRenameEdits = service.getFileRenameEdits(fixture.boardShowFilePath, renamedBoardRouteFilePath)
    const dynamicRouteReferenceEdits = dynamicRouteRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (dynamicRouteReferenceEdits.length !== 3) {
      throw new Error(`Expected href/hx-get/redirect callers to rewrite when dynamic route file is renamed. Got: ${JSON.stringify(dynamicRouteReferenceEdits)}`)
    }
    const dynamicRouteRenamedText = applyEditsToText(dynamicRouteCallerText, dynamicRouteReferenceEdits)
    if ((dynamicRouteRenamedText.match(/\/boards\/demo-board\/details/g) || []).length !== 3) {
      throw new Error(`Expected dynamic route callers to rewrite to /boards/demo-board/details. Got: ${dynamicRouteRenamedText}`)
    }

    const dynamicTemplateRouteCallerText = `<a href="/boards/<%= boardSlug %>"></a>
<button hx-get="/boards/<%= boardSlug %>?tab=posts#top"></button>
`
    service.setDocumentOverride(fixture.routeReferenceCheckFilePath, dynamicTemplateRouteCallerText)
    const dynamicTemplateRouteReferences = service.getFileReferenceTargets(
      fixture.boardShowFilePath,
      fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath))
    if (dynamicTemplateRouteReferences.length !== 2) {
      throw new Error(`Expected EJS-interpolated href/hx-get callers to reference the dynamic board route. Got: ${JSON.stringify(dynamicTemplateRouteReferences)}`)
    }

    const dynamicTemplateRouteRenameEdits = service.getFileRenameEdits(fixture.boardShowFilePath, renamedBoardRouteFilePath)
    const dynamicTemplateRouteCallerEdits = dynamicTemplateRouteRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
    )
    if (dynamicTemplateRouteCallerEdits.length !== 2) {
      throw new Error(`Expected EJS-interpolated dynamic route callers to rewrite when the dynamic route file is renamed. Got: ${JSON.stringify(dynamicTemplateRouteCallerEdits)}`)
    }
    const dynamicTemplateRouteRenamedText = applyEditsToText(dynamicTemplateRouteCallerText, dynamicTemplateRouteCallerEdits)
    if (!dynamicTemplateRouteRenamedText.includes('href="/boards/<%= boardSlug %>/details"')) {
      throw new Error(`Expected EJS-interpolated href caller to preserve the dynamic segment and append /details. Got: ${dynamicTemplateRouteRenamedText}`)
    }
    if (!dynamicTemplateRouteRenamedText.includes('hx-get="/boards/<%= boardSlug %>/details?tab=posts#top"')) {
      throw new Error(`Expected EJS-interpolated hx-get caller to preserve the dynamic segment, query, and hash. Got: ${dynamicTemplateRouteRenamedText}`)
    }
    service.clearDocumentOverride(fixture.routeReferenceCheckFilePath)

    const routeParamRenameText = `<script server>
const currentBoard = params.boardSlug
const bracketBoard = params["boardSlug"]
const { boardSlug, boardSlug: explicitBoardSlug } = params
</script>
<div><%= params.boardSlug %></div>
`
    service.setDocumentOverride(fixture.boardShowFilePath, routeParamRenameText)
    const oldBoardParamDirectoryPath = path.dirname(fixture.boardShowFilePath)
    const newBoardParamDirectoryPath = path.join(path.dirname(oldBoardParamDirectoryPath), '[slug]')
    const routeParamRenameEdits = service.getFileRenameEdits(oldBoardParamDirectoryPath, newBoardParamDirectoryPath)
    const renamedBoardShowParamFilePath = path.join(newBoardParamDirectoryPath, 'index.ejs')
    const boardShowParamEdits = routeParamRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedBoardShowParamFilePath)
    )
    if (boardShowParamEdits.length !== 5) {
      throw new Error(`Expected route param directory rename to rewrite five params.boardSlug references in the moved route file. Got: ${JSON.stringify(boardShowParamEdits)}`)
    }
    const routeParamRenamedText = applyEditsToText(routeParamRenameText, boardShowParamEdits)
    for (const expectedRouteParamText of [
      'params.slug',
      'params["slug"]',
      'const { slug: boardSlug, slug: explicitBoardSlug } = params',
      '<div><%= params.slug %></div>',
    ]) {
      if (!routeParamRenamedText.includes(expectedRouteParamText)) {
        throw new Error(`Expected route param rename to preserve local bindings while updating ${expectedRouteParamText}. Got: ${routeParamRenamedText}`)
      }
    }
    const renamedPropertyLocalsFilePath = path.join(newBoardParamDirectoryPath, 'property-locals-check.ejs')
    const propertyLocalsParamEdits = routeParamRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedPropertyLocalsFilePath)
    )
    if (propertyLocalsParamEdits.length !== 1) {
      throw new Error(`Expected route param directory rename to update child route files under the moved param directory. Got: ${JSON.stringify(routeParamRenameEdits)}`)
    }
    const propertyLocalsParamRenamedText = applyEditsToText(
      fs.readFileSync(fixture.propertyLocalsCheckFilePath, 'utf8'),
      propertyLocalsParamEdits
    )
    if (!propertyLocalsParamRenamedText.includes('boardSlug: params.slug')) {
      throw new Error(`Expected child route include locals to read params.slug after param directory rename. Got: ${propertyLocalsParamRenamedText}`)
    }
    service.clearDocumentOverride(fixture.boardShowFilePath)

    const renamedBoardFileParamFilePath = path.join(path.dirname(fixture.boardFileParamFilePath), '[slug].ejs')
    const directRouteParamRenameEdits = service.getFileRenameEdits(
      fixture.boardFileParamFilePath,
      renamedBoardFileParamFilePath
    ).filter((entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedBoardFileParamFilePath))
    if (directRouteParamRenameEdits.length !== 2) {
      throw new Error(`Expected direct [param].ejs file rename to update params references in the moved file. Got: ${JSON.stringify(directRouteParamRenameEdits)}`)
    }
    const directRouteParamRenamedText = applyEditsToText(
      fs.readFileSync(fixture.boardFileParamFilePath, 'utf8'),
      directRouteParamRenameEdits
    )
    if (
      !directRouteParamRenamedText.includes('const directBoardSlug = params.slug') ||
      !directRouteParamRenamedText.includes('<div><%= params.slug %></div>')
    ) {
      throw new Error(`Expected direct route param file rename to rewrite script and template params usage. Got: ${directRouteParamRenamedText}`)
    }

    const routeDirectoryCallerText = `<a href="/boards">Boards</a>
<a href="/boards/demo-board">Demo</a>
<button hx-get="/boards/demo-board?tab=posts#top"></button>
<script server>
redirect('/boards/demo-board')
</script>
`
    service.setDocumentOverride(fixture.routeReferenceCheckFilePath, routeDirectoryCallerText)
    const oldBoardsRouteDirectoryPath = path.dirname(fixture.boardsFilePath)
    const newBoardsRouteDirectoryPath = path.join(path.dirname(oldBoardsRouteDirectoryPath), 'topics')
    const renamedRouteReferenceCheckFilePath = path.join(
      newBoardsRouteDirectoryPath,
      path.relative(oldBoardsRouteDirectoryPath, fixture.routeReferenceCheckFilePath)
    )
    const routeDirectoryRenameEdits = service.getFileRenameEdits(oldBoardsRouteDirectoryPath, newBoardsRouteDirectoryPath)
    const routeDirectorySiteIndexEdits = routeDirectoryRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.siteIndexFilePath)
    )
    const routeDirectoryMovedCallerEdits = routeDirectoryRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(renamedRouteReferenceCheckFilePath)
    )
    if (routeDirectorySiteIndexEdits.length !== 1) {
      throw new Error(`Expected /boards href outside the renamed folder to rewrite on route directory rename. Got: ${JSON.stringify(routeDirectoryRenameEdits)}`)
    }
    if (routeDirectoryMovedCallerEdits.length !== 4) {
      throw new Error(`Expected moved route caller edits to target the renamed folder path. Got: ${JSON.stringify(routeDirectoryRenameEdits)}`)
    }
    if (
      routeDirectoryRenameEdits.some(
        (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeReferenceCheckFilePath)
      )
    ) {
      throw new Error(`Expected route directory rename edits to avoid stale old folder paths. Got: ${JSON.stringify(routeDirectoryRenameEdits)}`)
    }
    const routeDirectorySiteIndexRenamedText = applyEditsToText(
      fs.readFileSync(fixture.siteIndexFilePath, 'utf8'),
      routeDirectorySiteIndexEdits
    )
    if (!routeDirectorySiteIndexRenamedText.includes('href="/topics"')) {
      throw new Error(`Expected outside route caller to rewrite to /topics. Got: ${routeDirectorySiteIndexRenamedText}`)
    }
    const routeDirectoryMovedCallerRenamedText = applyEditsToText(
      routeDirectoryCallerText,
      routeDirectoryMovedCallerEdits
    )
    if ((routeDirectoryMovedCallerRenamedText.match(/\/topics/g) || []).length !== 4) {
      throw new Error(`Expected moved route callers to rewrite to /topics while preserving suffixes. Got: ${routeDirectoryMovedCallerRenamedText}`)
    }
    if (routeDirectoryMovedCallerRenamedText.includes('/boards')) {
      throw new Error(`Expected moved route callers to remove old /boards paths. Got: ${routeDirectoryMovedCallerRenamedText}`)
    }
    service.clearDocumentOverride(fixture.routeReferenceCheckFilePath)

    const extractPartialSourceText = `<script server>
const board = { title: 'Demo' }
const currentUser = { email: 'demo@example.com' }
</script>
<section class="card">
  <% const tone = currentUser ? 'ok' : 'guest' %>
  <h2><%= board.title %></h2>
  <span><%= tone %></span>
  <img src="<%= asset('/logo.png') %>">
</section>
`
    const extractSelectionStart = extractPartialSourceText.indexOf('<section')
    const extractSelectionEnd = extractPartialSourceText.indexOf('</section>') + '</section>'.length
    const extractPartialResult = service.getExtractPartialEdits(
      fixture.boardsFilePath,
      extractPartialSourceText,
      { start: extractSelectionStart, end: extractSelectionEnd },
      'cards/board-card'
    )
    if (!extractPartialResult || extractPartialResult.ok !== true) {
      throw new Error(`Expected Extract Partial edits for a selected template range. Got: ${JSON.stringify(extractPartialResult)}`)
    }
    if (
      normalizeFilePath(extractPartialResult.partialFilePath) !==
      normalizeFilePath(path.join(path.dirname(fixture.boardsFilePath), '_private', 'cards', 'board-card.ejs'))
    ) {
      throw new Error(`Expected Extract Partial to create a route-local _private partial. Got: ${JSON.stringify(extractPartialResult)}`)
    }
    if (
      !Array.isArray(extractPartialResult.locals) ||
      extractPartialResult.locals.join(',') !== 'board,currentUser'
    ) {
      throw new Error(`Expected Extract Partial locals to include free template identifiers only. Got: ${JSON.stringify(extractPartialResult.locals)}`)
    }
    if (
      !extractPartialResult.edits ||
      extractPartialResult.edits.length !== 1 ||
      extractPartialResult.edits[0].newText !== "<%- include('cards/board-card.ejs', { board, currentUser }) %>"
    ) {
      throw new Error(`Expected Extract Partial to replace the selection with an include call. Got: ${JSON.stringify(extractPartialResult.edits)}`)
    }
    if (
      !extractPartialResult.creates ||
      extractPartialResult.creates.length !== 1 ||
      !extractPartialResult.creates[0].text.includes('<h2><%= board.title %></h2>')
    ) {
      throw new Error(`Expected Extract Partial to create a partial containing the selected template. Got: ${JSON.stringify(extractPartialResult.creates)}`)
    }
    const extractServerResult = service.getExtractPartialEdits(
      fixture.boardsFilePath,
      extractPartialSourceText,
      { start: 0, end: extractSelectionStart },
      'bad-server-block'
    )
    if (!extractServerResult || extractServerResult.ok !== false || !String(extractServerResult.message || '').includes('<script server>')) {
      throw new Error(`Expected Extract Partial to reject server-block selections. Got: ${JSON.stringify(extractServerResult)}`)
    }
    const extractInvalidNameResult = service.getExtractPartialEdits(
      fixture.boardsFilePath,
      extractPartialSourceText,
      { start: extractSelectionStart, end: extractSelectionEnd },
      '../bad'
    )
    if (!extractInvalidNameResult || extractInvalidNameResult.ok !== false) {
      throw new Error(`Expected Extract Partial to reject parent-directory partial names. Got: ${JSON.stringify(extractInvalidNameResult)}`)
    }
    const extractExistingNameResult = service.getExtractPartialEdits(
      fixture.boardsFilePath,
      extractPartialSourceText,
      { start: extractSelectionStart, end: extractSelectionEnd },
      'shared-panel.ejs'
    )
    if (
      !extractExistingNameResult ||
      extractExistingNameResult.ok !== false ||
      !String(extractExistingNameResult.message || '').includes('already exists')
    ) {
      throw new Error(`Expected Extract Partial to reject an existing target partial. Got: ${JSON.stringify(extractExistingNameResult)}`)
    }
    const extractNonEjsResult = service.getExtractPartialEdits(
      fixture.middlewareFilePath,
      '<section>API</section>\n',
      { start: 0, end: '<section>API</section>'.length },
      'api-card'
    )
    if (
      !extractNonEjsResult ||
      extractNonEjsResult.ok !== false ||
      !String(extractNonEjsResult.message || '').includes('EJS')
    ) {
      throw new Error(`Expected Extract Partial to reject non-EJS source files. Got: ${JSON.stringify(extractNonEjsResult)}`)
    }

    const feedbackPageReferenceQuery = service.getFileReferenceQuery(fixture.feedbackPageFilePath)
    if (!feedbackPageReferenceQuery || feedbackPageReferenceQuery.kind !== 'route-file' || feedbackPageReferenceQuery.routePath !== '/feedback' || feedbackPageReferenceQuery.routeMethod !== 'PAGE') {
      throw new Error(`Expected page route file reference query for /feedback. Got: ${JSON.stringify(feedbackPageReferenceQuery)}`)
    }
    const feedbackGetReferenceQuery = service.getFileReferenceQuery(fixture.feedbackGetFilePath)
    if (!feedbackGetReferenceQuery || feedbackGetReferenceQuery.kind !== 'route-file' || feedbackGetReferenceQuery.routePath !== '/feedback' || feedbackGetReferenceQuery.routeMethod !== 'GET') {
      throw new Error(`Expected GET route file reference query for /feedback. Got: ${JSON.stringify(feedbackGetReferenceQuery)}`)
    }

    const feedbackPostReferenceQuery = service.getFileReferenceQuery(fixture.feedbackPostFilePath)
    if (!feedbackPostReferenceQuery || feedbackPostReferenceQuery.kind !== 'route-file' || feedbackPostReferenceQuery.routePath !== '/feedback' || feedbackPostReferenceQuery.routeMethod !== 'POST') {
      throw new Error(`Expected POST route file reference query for /feedback. Got: ${JSON.stringify(feedbackPostReferenceQuery)}`)
    }

    const feedbackDeleteReferenceQuery = service.getFileReferenceQuery(fixture.feedbackDeleteFilePath)
    if (!feedbackDeleteReferenceQuery || feedbackDeleteReferenceQuery.kind !== 'route-file' || feedbackDeleteReferenceQuery.routePath !== '/feedback' || feedbackDeleteReferenceQuery.routeMethod !== 'DELETE') {
      throw new Error(`Expected DELETE route file reference query for /feedback. Got: ${JSON.stringify(feedbackDeleteReferenceQuery)}`)
    }
    const feedbackPutReferenceQuery = service.getFileReferenceQuery(fixture.feedbackPutFilePath)
    if (!feedbackPutReferenceQuery || feedbackPutReferenceQuery.kind !== 'route-file' || feedbackPutReferenceQuery.routePath !== '/feedback' || feedbackPutReferenceQuery.routeMethod !== 'PUT') {
      throw new Error(`Expected PUT route file reference query for /feedback. Got: ${JSON.stringify(feedbackPutReferenceQuery)}`)
    }
    const feedbackPatchReferenceQuery = service.getFileReferenceQuery(fixture.feedbackPatchFilePath)
    if (!feedbackPatchReferenceQuery || feedbackPatchReferenceQuery.kind !== 'route-file' || feedbackPatchReferenceQuery.routePath !== '/feedback' || feedbackPatchReferenceQuery.routeMethod !== 'PATCH') {
      throw new Error(`Expected PATCH route file reference query for /feedback. Got: ${JSON.stringify(feedbackPatchReferenceQuery)}`)
    }
    const routeVendorReferenceQuery = service.getFileReferenceQuery(fixture.routeVendorScriptFilePath)
    if (routeVendorReferenceQuery) {
      throw new Error(`Expected route-exposed vendor scripts to stay out of route references. Got: ${JSON.stringify(routeVendorReferenceQuery)}`)
    }
    const routeMinifiedReferenceQuery = service.getFileReferenceQuery(fixture.routeMinifiedScriptFilePath)
    if (routeMinifiedReferenceQuery) {
      throw new Error(`Expected route-exposed minified scripts to stay out of route references. Got: ${JSON.stringify(routeMinifiedReferenceQuery)}`)
    }
    const routeUppercaseMinifiedReferenceQuery = service.getFileReferenceQuery(fixture.routeUppercaseMinifiedScriptFilePath)
    if (routeUppercaseMinifiedReferenceQuery) {
      throw new Error(`Expected route-exposed uppercase minified scripts to stay out of route references. Got: ${JSON.stringify(routeUppercaseMinifiedReferenceQuery)}`)
    }
    const routeVendorTemplateReferenceQuery = service.getFileReferenceQuery(fixture.routeVendorTemplateFilePath)
    if (
      !routeVendorTemplateReferenceQuery ||
      routeVendorTemplateReferenceQuery.kind !== 'route-file' ||
      routeVendorTemplateReferenceQuery.routePath !== '/vendor'
    ) {
      throw new Error(`Expected EJS routes under route-exposed vendor directories to stay route-referenceable. Got: ${JSON.stringify(routeVendorTemplateReferenceQuery)}`)
    }
    const assetReferenceCallerText = `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>
<script src="<%= asset('/assets/booklog-reader.js?v=1#main') %>"></script>
<link rel="stylesheet" href="<%= asset('card.css') %>">
<a href="/assets/booklog-reader.js?v=1">Download</a>
`
    service.setDocumentOverride(fixture.boardsFilePath, assetReferenceCallerText)
    const globalAssetReferenceQuery = service.getFileReferenceQuery(fixture.globalAssetFilePath)
    if (
      !globalAssetReferenceQuery ||
      globalAssetReferenceQuery.kind !== 'asset-file' ||
      globalAssetReferenceQuery.assetPath !== '/assets/booklog-reader.js'
    ) {
      throw new Error(`Expected asset file reference query for /assets/booklog-reader.js. Got: ${JSON.stringify(globalAssetReferenceQuery)}`)
    }
    const localAssetReferenceQuery = service.getFileReferenceQuery(fixture.localAssetFilePath)
    if (!localAssetReferenceQuery || localAssetReferenceQuery.kind !== 'asset-file') {
      throw new Error(`Expected asset file reference query for local board asset. Got: ${JSON.stringify(localAssetReferenceQuery)}`)
    }
    const globalAssetReferences = service.getFileReferenceTargets(
      fixture.globalAssetFilePath,
      fs.readFileSync(fixture.globalAssetFilePath, 'utf8')
    )
    const localAssetReferences = service.getFileReferenceTargets(
      fixture.localAssetFilePath,
      fs.readFileSync(fixture.localAssetFilePath, 'utf8')
    )
    const globalAssetCallerMatches = globalAssetReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    const localAssetCallerMatches = localAssetReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    if (globalAssetCallerMatches.length !== 3) {
      throw new Error(`Expected asset() and href callers for the global asset file. Got: ${JSON.stringify(globalAssetReferences)}`)
    }
    if (localAssetCallerMatches.length !== 1) {
      throw new Error(`Expected one asset() caller for the local asset file. Got: ${JSON.stringify(localAssetReferences)}`)
    }
    const renamedGlobalAssetFilePath = path.join(path.dirname(fixture.globalAssetFilePath), 'reader-client.js')
    const globalAssetRenameEdits = service.getFileRenameEdits(
      fixture.globalAssetFilePath,
      renamedGlobalAssetFilePath
    )
    const globalAssetCallerEdits = globalAssetRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    if (globalAssetCallerEdits.length !== 3) {
      throw new Error(`Expected asset() and href caller rewrites for the renamed global asset file. Got: ${JSON.stringify(globalAssetRenameEdits)}`)
    }
    const globalAssetRenamedText = applyEditsToText(assetReferenceCallerText, globalAssetCallerEdits)
    if (
      !globalAssetRenamedText.includes("asset('/assets/reader-client.js')") ||
      !globalAssetRenamedText.includes("asset('/assets/reader-client.js?v=1#main')") ||
      !globalAssetRenamedText.includes('href="/assets/reader-client.js?v=1"')
    ) {
      throw new Error(`Expected global asset() and href callers to rewrite to /assets/reader-client.js while preserving query suffixes. Got: ${globalAssetRenamedText}`)
    }
    const renamedLocalAssetFilePath = path.join(path.dirname(fixture.localAssetFilePath), 'board-card.css')
    const localAssetRenameEdits = service.getFileRenameEdits(
      fixture.localAssetFilePath,
      renamedLocalAssetFilePath
    )
    const localAssetCallerEdits = localAssetRenameEdits.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.boardsFilePath)
    )
    if (localAssetCallerEdits.length !== 1) {
      throw new Error(`Expected one caller rewrite for the renamed local asset file. Got: ${JSON.stringify(localAssetRenameEdits)}`)
    }
    const localAssetRenamedText = applyEditsToText(assetReferenceCallerText, localAssetCallerEdits)
    if (!localAssetRenamedText.includes("asset('board-card.css')")) {
      throw new Error(`Expected local asset() caller to rewrite to board-card.css. Got: ${localAssetRenamedText}`)
    }
    service.clearDocumentOverride(fixture.boardsFilePath)

    const feedbackPageReferences = service.getFileReferenceTargets(
      fixture.feedbackPageFilePath,
      fs.readFileSync(fixture.feedbackPageFilePath, 'utf8')
    )
    const feedbackPostReferences = service.getFileReferenceTargets(
      fixture.feedbackPostFilePath,
      fs.readFileSync(fixture.feedbackPostFilePath, 'utf8')
    )
    const feedbackDeleteReferences = service.getFileReferenceTargets(
      fixture.feedbackDeleteFilePath,
      fs.readFileSync(fixture.feedbackDeleteFilePath, 'utf8')
    )
    const feedbackPutReferences = service.getFileReferenceTargets(
      fixture.feedbackPutFilePath,
      fs.readFileSync(fixture.feedbackPutFilePath, 'utf8')
    )
    const feedbackPatchReferences = service.getFileReferenceTargets(
      fixture.feedbackPatchFilePath,
      fs.readFileSync(fixture.feedbackPatchFilePath, 'utf8')
    )
    const feedbackPageCallerMatches = feedbackPageReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    const feedbackPostCallerMatches = feedbackPostReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    const feedbackDeleteCallerMatches = feedbackDeleteReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    const feedbackPutCallerMatches = feedbackPutReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    const feedbackPatchCallerMatches = feedbackPatchReferences.filter(
      (entry) => normalizeFilePath(entry.filePath) === normalizeFilePath(fixture.routeMethodReferenceCheckFilePath)
    )
    if (feedbackPageCallerMatches.length !== 1) {
      throw new Error(`Expected href-only references for feedback page route. Got: ${JSON.stringify(feedbackPageReferences)}`)
    }
    if (feedbackPostCallerMatches.length !== 3) {
      throw new Error(`Expected action + hx-post + data-hx-post references for feedback POST route. Got: ${JSON.stringify(feedbackPostReferences)}`)
    }
    if (feedbackDeleteCallerMatches.length !== 1) {
      throw new Error(`Expected hx-delete references for feedback DELETE route. Got: ${JSON.stringify(feedbackDeleteReferences)}`)
    }
    if (feedbackPutCallerMatches.length !== 1) {
      throw new Error(`Expected hx-put references for feedback PUT route. Got: ${JSON.stringify(feedbackPutReferences)}`)
    }
    if (feedbackPatchCallerMatches.length !== 1) {
      throw new Error(`Expected hx-patch references for feedback PATCH route. Got: ${JSON.stringify(feedbackPatchReferences)}`)
    }

    const hrefDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<a href="/boards"></a>\n`,
      `<a href="/boards"></a>\n`.indexOf('/boards') + 2
    )
    if (!hrefDefinition || !hrefDefinition.endsWith('/pb_hooks/pages/(site)/boards/index.ejs')) {
      throw new Error(`Expected href route definition target. Got: ${hrefDefinition}`)
    }

    const methodShadowPostDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-post="/method-shadow"></button>\n`,
      `<button hx-post="/method-shadow"></button>\n`.indexOf('/method-shadow') + 2
    )
    if (methodShadowPostDefinition) {
      throw new Error(`Expected hx-post /method-shadow not to resolve to non-script +post files. Got: ${methodShadowPostDefinition}`)
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
    const dataHtmxDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button data-hx-post="/feedback"></button>\n`,
      `<button data-hx-post="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (!dataHtmxDefinition || normalizeFilePath(dataHtmxDefinition) !== normalizeFilePath(fixture.feedbackPostFilePath)) {
      throw new Error(`Expected data-hx-post route definition target. Got: ${dataHtmxDefinition}`)
    }

    const redirectDefinition = authService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<script server>\nredirect('/sign-in', { status: 303 })\n</script>\n`,
      `<script server>\nredirect('/sign-in', { status: 303 })\n</script>\n`.indexOf('/sign-in') + 2
    )
    if (!redirectDefinition || !redirectDefinition.endsWith('/pb_hooks/pages/(site)/sign-in.ejs')) {
      throw new Error(`Expected redirect() route definition target. Got: ${redirectDefinition}`)
    }
    const apiRedirectDefinition = authService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<script server>\napi.redirect('/sign-in', { status: 303 })\n</script>\n`,
      `<script server>\napi.redirect('/sign-in', { status: 303 })\n</script>\n`.indexOf('/sign-in') + 2
    )
    if (!apiRedirectDefinition || !apiRedirectDefinition.endsWith('/pb_hooks/pages/(site)/sign-in.ejs')) {
      throw new Error(`Expected api.redirect() route definition target. Got: ${apiRedirectDefinition}`)
    }

    const feedbackHrefDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<a href="/feedback"></a>\n`,
      `<a href="/feedback"></a>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackHrefDefinition || normalizeFilePath(feedbackHrefDefinition) !== normalizeFilePath(fixture.feedbackPageFilePath)) {
      throw new Error(`Expected href to resolve to feedback page route. Got: ${feedbackHrefDefinition}`)
    }

    const feedbackHtmxGetDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-get="/feedback"></button>\n`,
      `<button hx-get="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackHtmxGetDefinition || normalizeFilePath(feedbackHtmxGetDefinition) !== normalizeFilePath(fixture.feedbackPageFilePath)) {
      throw new Error(`Expected hx-get to resolve to feedback page route. Got: ${feedbackHtmxGetDefinition}`)
    }

    const feedbackRedirectDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<script server>\nredirect('/feedback')\n</script>\n`,
      `<script server>\nredirect('/feedback')\n</script>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackRedirectDefinition || normalizeFilePath(feedbackRedirectDefinition) !== normalizeFilePath(fixture.feedbackPageFilePath)) {
      throw new Error(`Expected redirect() to resolve to feedback page route. Got: ${feedbackRedirectDefinition}`)
    }

    const feedbackActionDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<form action="/feedback" method="post"></form>\n`,
      `<form action="/feedback" method="post"></form>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackActionDefinition || normalizeFilePath(feedbackActionDefinition) !== normalizeFilePath(fixture.feedbackPostFilePath)) {
      throw new Error(`Expected action to resolve to feedback POST route. Got: ${feedbackActionDefinition}`)
    }

    const feedbackHtmxPostDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-post="/feedback"></button>\n`,
      `<button hx-post="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackHtmxPostDefinition || normalizeFilePath(feedbackHtmxPostDefinition) !== normalizeFilePath(fixture.feedbackPostFilePath)) {
      throw new Error(`Expected hx-post to resolve to feedback POST route. Got: ${feedbackHtmxPostDefinition}`)
    }

    const feedbackHtmxDeleteDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-delete="/feedback"></button>\n`,
      `<button hx-delete="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackHtmxDeleteDefinition || normalizeFilePath(feedbackHtmxDeleteDefinition) !== normalizeFilePath(fixture.feedbackDeleteFilePath)) {
      throw new Error(`Expected hx-delete to resolve to feedback DELETE route. Got: ${feedbackHtmxDeleteDefinition}`)
    }
    const feedbackHtmxPutDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-put="/feedback"></button>\n`,
      `<button hx-put="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackHtmxPutDefinition || normalizeFilePath(feedbackHtmxPutDefinition) !== normalizeFilePath(fixture.feedbackPutFilePath)) {
      throw new Error(`Expected hx-put to resolve to feedback PUT route. Got: ${feedbackHtmxPutDefinition}`)
    }
    const feedbackHtmxPatchDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<button hx-patch="/feedback"></button>\n`,
      `<button hx-patch="/feedback"></button>\n`.indexOf('/feedback') + 2
    )
    if (!feedbackHtmxPatchDefinition || normalizeFilePath(feedbackHtmxPatchDefinition) !== normalizeFilePath(fixture.feedbackPatchFilePath)) {
      throw new Error(`Expected hx-patch to resolve to feedback PATCH route. Got: ${feedbackHtmxPatchDefinition}`)
    }

    const dynamicHrefDefinition = indexService.getDefinitionTarget(
      fixture.siteIndexFilePath,
      `<a href="/boards/demo-board"></a>\n`,
      `<a href="/boards/demo-board"></a>\n`.indexOf('/boards/demo-board') + 2
    )
    if (!dynamicHrefDefinition || normalizeFilePath(dynamicHrefDefinition) !== normalizeFilePath(fixture.boardShowFilePath)) {
      throw new Error(`Expected concrete dynamic href to resolve to [boardSlug].ejs. Got: ${dynamicHrefDefinition}`)
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

    const schemaStringCommentDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\n// $app.findRecordsByFilter('missing_collection')\nconst literal = "board.get('missing_field')"\n</script>\n`
    )
    const schemaStringCommentMessages = schemaStringCommentDiagnostics.map((entry) => String(entry.message))
    if (
      schemaStringCommentMessages.some((message) => message.includes('missing_collection')) ||
      schemaStringCommentMessages.some((message) => message.includes('missing_field'))
    ) {
      throw new Error(
        `Expected schema diagnostics to ignore comments and strings. Got: ${schemaStringCommentDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const recordSetDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst board = $app.findRecordById('boards', 'board-1')\nboard.set('missing_field', request.url.query.sort)\n</script>\n`
    )
    if (
      !recordSetDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "boards"')
      )
    ) {
      throw new Error(
        `Expected record.set() schema diagnostic. Got: ${recordSetDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const explicitAssignmentSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
let settingsRecord = null
try {
  settingsRecord = $app.findFirstRecordByFilter('posts', 'slug = {:slug}', { slug: 'welcome' })
} catch (error) {
  settingsRecord = null
}
settingsRecord.get('missing_field')
</script>\n`
    )
    if (
      !explicitAssignmentSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "posts"')
      )
    ) {
      throw new Error(
        `Expected explicit record assignment schema diagnostic. Got: ${explicitAssignmentSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const aliasedCollectionSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const COLLECTION_NAME = 'posts'
const postRecord = $app.findFirstRecordByFilter(COLLECTION_NAME, 'slug = {:slug}', { slug: 'welcome' })
postRecord.get('missing_field')
</script>\n`
    )
    if (
      !aliasedCollectionSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "posts"')
      )
    ) {
      throw new Error(
        `Expected same-file string alias schema diagnostic. Got: ${aliasedCollectionSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const constructedRecordSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const COLLECTION_NAME = 'posts'
const collection = $app.findCollectionByNameOrId(COLLECTION_NAME)
const postRecord = new Record(collection)
postRecord.get('missing_field')
</script>\n`
    )
    if (
      !constructedRecordSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "posts"')
      )
    ) {
      throw new Error(
        `Expected new Record(collection) schema diagnostic. Got: ${constructedRecordSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const fallbackRecordSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const COLLECTION_NAME = 'posts'
const collection = $app.findCollectionByNameOrId(COLLECTION_NAME)
let postRecord = null
try {
  postRecord = $app.findFirstRecordByFilter(COLLECTION_NAME, 'slug = {:slug}', { slug: 'welcome' })
} catch (error) {
  postRecord = null
}
const targetRecord = postRecord || new Record(collection)
targetRecord.get('missing_field')
</script>\n`
    )
    if (
      !fallbackRecordSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "posts"')
      )
    ) {
      throw new Error(
        `Expected record fallback constructor schema diagnostic. Got: ${fallbackRecordSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const callbackRecordSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const COLLECTION_NAME = 'posts'
const postRecords = $app.findRecordsByFilter(COLLECTION_NAME, '')
postRecords.map((postRecord) => postRecord.get('missing_field'))
</script>\n`
    )
    if (
      !callbackRecordSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "posts"')
      )
    ) {
      throw new Error(
        `Expected direct callback param schema diagnostic. Got: ${callbackRecordSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const forOfRecordSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const COLLECTION_NAME = 'posts'
const postRecords = $app.findRecordsByFilter(COLLECTION_NAME, '')
for (const postRecord of postRecords) {
  postRecord.get('missing_field')
}
</script>\n`
    )
    if (
      !forOfRecordSchemaDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "posts"')
      )
    ) {
      throw new Error(
        `Expected for-of iteration schema diagnostic. Got: ${forOfRecordSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const indexedRecordSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const COLLECTION_NAME = 'posts'
const index = 0
const postRecords = $app.findRecordsByFilter(COLLECTION_NAME, '', '-created', 10, 0)
postRecords[index].get('missing_field')
postRecords[0].get('missing_field')
</script>\n`
    )
    const indexedRecordDiagnosticMessages = indexedRecordSchemaDiagnostics.map((entry) => String(entry.message))
    if (indexedRecordDiagnosticMessages.filter((message) => message.includes('Unknown field "missing_field" for collection "posts"')).length < 2) {
      throw new Error(
        `Expected indexed array access schema diagnostics. Got: ${indexedRecordSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const mediumConfidenceSchemaDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>
const weekTextRows = $app.findRecordsByFilter('posts')
const weekResults = $app.findRecordsByFilter('boards')
weekTextRows.map((row) => String(row.get('title') || '').trim())
</script>\n`
    )
    if (mediumConfidenceSchemaDiagnostics.some((entry) => entry.code === 'pp-schema-field')) {
      throw new Error(
        `Expected medium-confidence generic row/item schema hints to stay suppressed. Got: ${mediumConfidenceSchemaDiagnostics
          .map((entry) => `${String(entry.code)}:${String(entry.message)}`)
          .join(' | ')}`
      )
    }

    const systemFieldText = `<script server>
const board = $app.findRecordById('boards', 'board-1')
const boardId = board.get('id')
boardId.trim()
</script>\n`
    const boardIdQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      systemFieldText,
      systemFieldText.indexOf('boardId =') + 2
    )
    if (!boardIdQuickInfo || !boardIdQuickInfo.displayText.includes('const boardId: string')) {
      throw new Error(`Expected record.get('id') quick info to resolve to string. Got: ${JSON.stringify(boardIdQuickInfo)}`)
    }
    const systemFieldDiagnostics = service.getDiagnostics(fixture.boardsFilePath, systemFieldText)
    if (systemFieldDiagnostics.some((entry) => String(entry.message).includes('Unknown field "id"'))) {
      throw new Error(`Expected record.get('id') to be treated as a built-in field. Got: ${systemFieldDiagnostics.map((entry) => String(entry.message)).join(' | ')}`)
    }

    const typedRecordGetText = `<script server>
const board = $app.findRecordById('boards', 'board-1')
const boardName = board.get('name')
const isActive = board.get('is_active')
const sortOrder = board.get('sort_order')
const metaPayload = board.get('meta_json')
const boardStatus = board.get('status')
const boardTags = board.get('tags')
const boardCover = board.get('cover')
const boardGallery = board.get('gallery')
const boardOwner = board.get('owner')
const boardMembers = board.get('members')
const boardArchivedAt = board.get('archived_at')

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

    const boardStatusQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardStatus =') + 2
    )
    if (!boardStatusQuickInfo || !boardStatusQuickInfo.displayText.includes('const boardStatus: "draft" | "published"')) {
      throw new Error(`Expected record.get('status') quick info to resolve to a select union. Got: ${JSON.stringify(boardStatusQuickInfo)}`)
    }

    const boardTagsQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardTags =') + 2
    )
    if (!boardTagsQuickInfo || !boardTagsQuickInfo.displayText.includes('const boardTags: ("news" | "tips")[]')) {
      throw new Error(`Expected record.get('tags') quick info to resolve to a multi-select array. Got: ${JSON.stringify(boardTagsQuickInfo)}`)
    }

    const boardCoverQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardCover =') + 2
    )
    if (!boardCoverQuickInfo || !boardCoverQuickInfo.displayText.includes('const boardCover: string')) {
      throw new Error(`Expected record.get('cover') quick info to resolve to string. Got: ${JSON.stringify(boardCoverQuickInfo)}`)
    }

    const boardGalleryQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardGallery =') + 2
    )
    if (!boardGalleryQuickInfo || !boardGalleryQuickInfo.displayText.includes('const boardGallery: string[]')) {
      throw new Error(`Expected record.get('gallery') quick info to resolve to string[] for multi-file. Got: ${JSON.stringify(boardGalleryQuickInfo)}`)
    }

    const boardOwnerQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardOwner =') + 2
    )
    if (!boardOwnerQuickInfo || !boardOwnerQuickInfo.displayText.includes('const boardOwner: string')) {
      throw new Error(`Expected record.get('owner') quick info to resolve to string for single relation. Got: ${JSON.stringify(boardOwnerQuickInfo)}`)
    }

    const boardMembersQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardMembers =') + 2
    )
    if (!boardMembersQuickInfo || !boardMembersQuickInfo.displayText.includes('const boardMembers: string[]')) {
      throw new Error(`Expected record.get('members') quick info to resolve to string[] for multi relation. Got: ${JSON.stringify(boardMembersQuickInfo)}`)
    }

    const boardArchivedAtQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedRecordGetText,
      typedRecordGetText.indexOf('boardArchivedAt =') + 2
    )
    if (!boardArchivedAtQuickInfo || !boardArchivedAtQuickInfo.displayText.includes('const boardArchivedAt: string')) {
      throw new Error(`Expected record.get('archived_at') quick info to resolve to string for autodate. Got: ${JSON.stringify(boardArchivedAtQuickInfo)}`)
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
    const typedRecordGetFastDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      typedRecordGetText,
      { includeSemanticDiagnostics: false }
    )
    const typedRecordGetFastMessages = typedRecordGetFastDiagnostics.map((entry) => String(entry.message))
    if (
      typedRecordGetFastMessages.some((message) =>
        message.includes("Property 'trim' does not exist on type 'boolean'") ||
        message.includes("Property 'trim' does not exist on type 'number'")
      )
    ) {
      throw new Error(
        `Expected fast diagnostics to skip TS semantic record.get() errors. Got: ${typedRecordGetFastMessages.join(' | ')}`
      )
    }
    const typedRecordGetPrelude = service.buildPrelude(fixture.boardsFilePath, typedRecordGetText)
    if (
      !typedRecordGetPrelude.includes('get(name: "name"): string;') ||
      !typedRecordGetPrelude.includes('get(name: "is_active"): boolean;') ||
      !typedRecordGetPrelude.includes('get(name: "sort_order"): number;')
    ) {
      throw new Error(`Expected buildPrelude() to expose typed record.get() overloads for TS. Got: ${typedRecordGetPrelude}`)
    }
    if (
      !typedRecordGetPrelude.includes('"status": "draft" | "published";') ||
      !typedRecordGetPrelude.includes('"tags": Array<"news" | "tips">;')
    ) {
      throw new Error(`Expected buildPrelude() to expose select union field types. Got: ${typedRecordGetPrelude}`)
    }
    if (
      !typedRecordGetPrelude.includes('"cover": string;') ||
      !typedRecordGetPrelude.includes('"gallery": Array<string>;') ||
      !typedRecordGetPrelude.includes('"owner": string;') ||
      !typedRecordGetPrelude.includes('"members": Array<string>;') ||
      !typedRecordGetPrelude.includes('"archived_at": string;')
    ) {
      throw new Error(`Expected buildPrelude() to expose file/relation/autodate field types. Got: ${typedRecordGetPrelude}`)
    }

    const typedRecordGetInlayHints = service.getInlayHintEntries(fixture.boardsFilePath, typedRecordGetText)
    if (!typedRecordGetInlayHints.some((entry) => entry.label === ': string')) {
      throw new Error(`Expected record.get() string inlay hint. Got: ${JSON.stringify(typedRecordGetInlayHints)}`)
    }
    if (!typedRecordGetInlayHints.some((entry) => entry.label === ': boolean')) {
      throw new Error(`Expected record.get() boolean inlay hint. Got: ${JSON.stringify(typedRecordGetInlayHints)}`)
    }

    const nonRecordGetInlayText = `<script server>
const params = new URLSearchParams('name=PocketPages')
params.get('name')
const headers = new Headers()
headers.get('slug')
</script>\n`
    const nonRecordGetInlayHints = service.getInlayHintEntries(fixture.boardsFilePath, nonRecordGetInlayText)
    if (nonRecordGetInlayHints.some((entry) => String(entry.tooltip || '').includes('Field type:'))) {
      throw new Error(`Expected non-record .get() calls to avoid schema field inlay hints. Got: ${JSON.stringify(nonRecordGetInlayHints)}`)
    }

    const typedConstructorText = `<script server>
const postCollection = $app.findCollectionByNameOrId('posts')
const postRecord = new Record(postCollection)
const postTableName = postRecord.tableName()
const postCollectionName = postRecord.collection().name
</script>\n`
    const postRecordQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedConstructorText,
      typedConstructorText.indexOf('postRecord =') + 2
    )
    if (!postRecordQuickInfo || !postRecordQuickInfo.displayText.includes('const postRecord: PocketPagesTypedRecord<"posts">')) {
      throw new Error(`Expected new Record(collection) quick info to resolve to PocketPagesTypedRecord<'posts'>. Got: ${JSON.stringify(postRecordQuickInfo)}`)
    }
    const postTableNameQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedConstructorText,
      typedConstructorText.indexOf('postTableName =') + 2
    )
    if (!postTableNameQuickInfo || !postTableNameQuickInfo.displayText.includes('const postTableName: "posts"')) {
      throw new Error(`Expected new Record(collection).tableName() quick info to resolve to the posts literal. Got: ${JSON.stringify(postTableNameQuickInfo)}`)
    }
    const postCollectionNameQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedConstructorText,
      typedConstructorText.indexOf('postCollectionName =') + 2
    )
    if (!postCollectionNameQuickInfo || !postCollectionNameQuickInfo.displayText.includes('const postCollectionName: "posts"')) {
      throw new Error(`Expected new Record(collection).collection().name quick info to resolve to the posts literal. Got: ${JSON.stringify(postCollectionNameQuickInfo)}`)
    }
    const typedConstructorFieldText = `const postCollection = $app.findCollectionByNameOrId('posts')\nconst postRecord = new Record(postCollection)\npostRecord.get('ti')\n`
    const typedConstructorFieldOffset = typedConstructorFieldText.lastIndexOf('ti') + 'ti'.length
    const typedConstructorFieldCompletion = service.getCustomCompletionData(
      fixture.boardServiceFilePath,
      typedConstructorFieldText,
      typedConstructorFieldOffset
    )
    const typedConstructorFieldNames = typedConstructorFieldCompletion ? typedConstructorFieldCompletion.items.map((entry) => entry.label) : []
    if (!typedConstructorFieldNames.includes('title') || !typedConstructorFieldNames.includes('board')) {
      throw new Error(`Expected new Record(collection) field completions. Got: ${typedConstructorFieldNames.slice(0, 20).join(', ')}`)
    }

    const typedCollectionFlowText = `<script server>
const boardCollection = $app.findCollectionByNameOrId('boards')
const board = $app.findFirstRecordByFilter(boardCollection, 'id != ""')
const boardTableName = board.tableName()
const boardCollectionName = board.collection().name
const boardTableNames = $app.findRecordsByFilter('boards', '').map((entry) => entry.tableName())
</script>\n`
    const boardCollectionQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedCollectionFlowText,
      typedCollectionFlowText.indexOf('boardCollection =') + 2
    )
    if (!boardCollectionQuickInfo || !boardCollectionQuickInfo.displayText.includes('PocketPagesCollectionModel<"boards">')) {
      throw new Error(`Expected findCollectionByNameOrId() quick info to resolve to PocketPagesCollectionModel<'boards'>. Got: ${JSON.stringify(boardCollectionQuickInfo)}`)
    }
    const boardTableNameQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedCollectionFlowText,
      typedCollectionFlowText.indexOf('boardTableName =') + 2
    )
    if (!boardTableNameQuickInfo || !boardTableNameQuickInfo.displayText.includes('const boardTableName: "boards"')) {
      throw new Error(`Expected board.tableName() quick info to resolve to the boards literal. Got: ${JSON.stringify(boardTableNameQuickInfo)}`)
    }
    const boardCollectionNameQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedCollectionFlowText,
      typedCollectionFlowText.indexOf('boardCollectionName =') + 2
    )
    if (!boardCollectionNameQuickInfo || !boardCollectionNameQuickInfo.displayText.includes('const boardCollectionName: "boards"')) {
      throw new Error(`Expected board.collection().name quick info to resolve to the boards literal. Got: ${JSON.stringify(boardCollectionNameQuickInfo)}`)
    }
    const boardTableNamesQuickInfo = service.getQuickInfo(
      fixture.boardsFilePath,
      typedCollectionFlowText,
      typedCollectionFlowText.indexOf('boardTableNames =') + 2
    )
    if (!boardTableNamesQuickInfo || !boardTableNamesQuickInfo.displayText.includes('const boardTableNames: "boards"[]')) {
      throw new Error(`Expected array callback tableName() quick info to resolve to boards[]. Got: ${JSON.stringify(boardTableNamesQuickInfo)}`)
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
    const fastTemplateDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst authState = { email: '' }\n</script>\n<p><%= authState.email %></p>\n<p><%= missingAuthState.email %></p>\n`,
      { includeSemanticDiagnostics: false }
    )
    if (fastTemplateDiagnostics.some((entry) => entry.code === 2304 && String(entry.message).includes('missingAuthState'))) {
      throw new Error(
        `Expected fast EJS template diagnostics to skip missingAuthState semantic errors. Got: ${fastTemplateDiagnostics
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

    const templateControlFlowText = [
      `<% if (true) { %>`,
      `<p>yes</p>`,
      `<% } else { %>`,
      `<p>no</p>`,
      `<% } %>`,
      `<% try { %>`,
      `<% throw new Error('test') %>`,
      `<% } catch (error) { %>`,
      `<p><%= error.message %></p>`,
      `<% } finally { %>`,
      `<p>done</p>`,
      `<% } %>`,
      `<% let loopIndex = 0; do { %>`,
      `<% loopIndex += 1 %>`,
      `<% } while (loopIndex < 1) %>`,
    ].join('\n')
    const templateControlFlowVirtualText = buildTemplateVirtualText(templateControlFlowText)
    for (const pattern of [/\}\s*;\s*else\b/, /\}\s*;\s*catch\b/, /\}\s*;\s*finally\b/, /\}\s*;\s*while\b/]) {
      if (pattern.test(templateControlFlowVirtualText)) {
        throw new Error(`Expected EJS control-flow tag joins to avoid injected semicolons. Pattern: ${pattern}`)
      }
    }
    const templateControlFlowDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      templateControlFlowText,
      { includeSemanticDiagnostics: false }
    )
    if (templateControlFlowDiagnostics.some((entry) => entry.category === ts.DiagnosticCategory.Error)) {
      throw new Error(
        `Expected EJS control-flow tag joins to stay syntactically valid. Got: ${templateControlFlowDiagnostics
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

    const guardedCodeActionText = `alpha beta gamma\n`
    const guardedCodeActionStart = guardedCodeActionText.indexOf('beta')
    const guardedCodeActionEnd = guardedCodeActionStart + 'beta'.length
    function getGuardedCodeActions(fixes) {
      return service.getCodeActions(
        fixture.boardsFilePath,
        guardedCodeActionText,
        {
          start: guardedCodeActionStart,
          end: guardedCodeActionEnd,
        },
        {
          diagnostics: [
            {
              code: 'pp-code-action-edit-guard',
              message: 'Synthetic edit guard diagnostic',
              start: guardedCodeActionStart,
              end: guardedCodeActionEnd,
              fixes,
            },
          ],
        }
      )
    }

    const guardedInsertionActions = getGuardedCodeActions([
      {
        title: 'Insert known text',
        edits: [
          {
            start: guardedCodeActionStart,
            end: guardedCodeActionStart,
            newText: 'known ',
          },
        ],
      },
    ])
    const guardedInsertionAction = guardedInsertionActions.find((entry) => entry.title === 'Insert known text')
    if (!guardedInsertionAction) {
      throw new Error(`Expected valid insertion quick fix to pass edit validation. Got: ${JSON.stringify(guardedInsertionActions)}`)
    }
    const guardedInsertionPatchedText = applyEditsToText(guardedCodeActionText, guardedInsertionAction.edits)
    if (guardedInsertionPatchedText !== `alpha known beta gamma\n`) {
      throw new Error(`Expected valid insertion quick fix to apply cleanly. Got: ${guardedInsertionPatchedText}`)
    }

    const guardedMultiEditActions = getGuardedCodeActions([
      {
        title: 'Replace separate words',
        edits: [
          {
            start: guardedCodeActionText.indexOf('alpha'),
            end: guardedCodeActionText.indexOf('alpha') + 'alpha'.length,
            newText: 'ALPHA',
          },
          {
            start: guardedCodeActionText.indexOf('gamma'),
            end: guardedCodeActionText.indexOf('gamma') + 'gamma'.length,
            newText: 'GAMMA',
          },
        ],
      },
    ])
    const guardedMultiEditAction = guardedMultiEditActions.find((entry) => entry.title === 'Replace separate words')
    if (!guardedMultiEditAction) {
      throw new Error(`Expected non-overlapping multi-edit quick fix to pass validation. Got: ${JSON.stringify(guardedMultiEditActions)}`)
    }
    const guardedMultiEditPatchedText = applyEditsToText(guardedCodeActionText, guardedMultiEditAction.edits)
    if (guardedMultiEditPatchedText !== `ALPHA beta GAMMA\n`) {
      throw new Error(`Expected valid multi-edit quick fix to apply cleanly. Got: ${guardedMultiEditPatchedText}`)
    }

    const guardedCrossFileTargetPath = path.join(
      fixture.appRoot,
      'pb_hooks',
      'pages',
      '_private',
      'code-action-target.ejs'
    )
    const guardedCrossFileTargetText = `target local\n`
    writeFile(guardedCrossFileTargetPath, guardedCrossFileTargetText)
    const guardedCrossFileActions = getGuardedCodeActions([
      {
        title: 'Replace readable target file text',
        edits: [
          {
            filePath: guardedCrossFileTargetPath,
            start: 0,
            end: 'target'.length,
            newText: 'shared',
          },
        ],
      },
    ])
    const guardedCrossFileAction = guardedCrossFileActions.find((entry) => entry.title === 'Replace readable target file text')
    if (!guardedCrossFileAction) {
      throw new Error(`Expected readable cross-file quick fix to pass validation. Got: ${JSON.stringify(guardedCrossFileActions)}`)
    }
    const guardedCrossFilePatchedText = applyEditsToText(guardedCrossFileTargetText, guardedCrossFileAction.edits)
    if (guardedCrossFilePatchedText !== `shared local\n`) {
      throw new Error(`Expected valid cross-file quick fix to apply cleanly. Got: ${guardedCrossFilePatchedText}`)
    }

    const invalidGuardedEditFixes = [
      {
        title: 'Reject negative start',
        edits: [{ start: -1, end: 0, newText: 'x' }],
      },
      {
        title: 'Reject reversed range',
        edits: [{ start: guardedCodeActionEnd, end: guardedCodeActionStart, newText: 'x' }],
      },
      {
        title: 'Reject fractional offset',
        edits: [{ start: guardedCodeActionStart + 0.5, end: guardedCodeActionEnd, newText: 'x' }],
      },
      {
        title: 'Reject out-of-bounds end',
        edits: [{ start: 0, end: guardedCodeActionText.length + 1, newText: 'x' }],
      },
      {
        title: 'Reject missing newText',
        edits: [{ start: guardedCodeActionStart, end: guardedCodeActionEnd }],
      },
      {
        title: 'Reject empty no-op insertion',
        edits: [{ start: guardedCodeActionStart, end: guardedCodeActionStart, newText: '' }],
      },
      {
        title: 'Reject overlapping edits',
        edits: [
          { start: guardedCodeActionText.indexOf('alpha'), end: guardedCodeActionEnd, newText: 'first' },
          { start: guardedCodeActionStart, end: guardedCodeActionText.indexOf('gamma'), newText: 'second' },
        ],
      },
      {
        title: 'Reject duplicate insertions',
        edits: [
          { start: guardedCodeActionStart, end: guardedCodeActionStart, newText: 'first ' },
          { start: guardedCodeActionStart, end: guardedCodeActionStart, newText: 'second ' },
        ],
      },
      {
        title: 'Reject unreadable target file',
        edits: [
          {
            filePath: path.join(fixture.appRoot, 'pb_hooks', 'pages', '_private', 'missing-code-action-target.ejs'),
            start: 0,
            end: 1,
            newText: 'x',
          },
        ],
      },
    ]
    const invalidGuardedEditActions = getGuardedCodeActions(invalidGuardedEditFixes)
    const leakedInvalidGuardedEditAction = invalidGuardedEditActions.find((entry) =>
      invalidGuardedEditFixes.some((fix) => fix.title === entry.title)
    )
    if (leakedInvalidGuardedEditAction) {
      throw new Error(
        `Expected invalid quick-fix edits to be filtered centrally. Got: ${JSON.stringify(leakedInvalidGuardedEditAction)}`
      )
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

    const flashParamDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nparams.__flash\n</script>\n`
    )
    if (flashParamDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected params.__flash to skip AGENTS query diagnostic. Got: ${flashParamDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const flashGuardPatternDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst flashMessage = params && params.__flash ? String(params.__flash).trim() : ''\nflashMessage\n</script>\n`
    )
    if (flashGuardPatternDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected real flash guard pattern to skip AGENTS query diagnostic. Got: ${flashGuardPatternDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const routeParamTrimDiagnostics = service.getDiagnostics(
      fixture.boardShowFilePath,
      `<script server>\nconst boardSlug = String(params.boardSlug || '').trim()\nboardSlug\n</script>\n`
    )
    if (routeParamTrimDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected route param String(...).trim() pattern to skip AGENTS query diagnostic. Got: ${routeParamTrimDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const queryParamTrimDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst sort = String(params.sort || '').trim()\nsort\n</script>\n`
    )
    if (!queryParamTrimDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected query-like String(params.sort || '').trim() pattern to report AGENTS query diagnostic. Got: ${queryParamTrimDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const aliasedParamsDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst query = params\nquery.sort\n</script>\n`
    )
    if (!aliasedParamsDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected aliased params access diagnostic. Got: ${aliasedParamsDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const destructuredParamsDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nconst { sort } = params\nsort\n</script>\n`
    )
    if (!destructuredParamsDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected destructured params diagnostic. Got: ${destructuredParamsDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const aliasedRouteParamDiagnostics = service.getDiagnostics(
      fixture.boardShowFilePath,
      `<script server>\nconst routeParams = params\nrouteParams.boardSlug\n</script>\n`
    )
    if (aliasedRouteParamDiagnostics.some((entry) => entry.code === 'pp-query-via-params')) {
      throw new Error(
        `Expected aliased route params access to skip AGENTS query diagnostic. Got: ${aliasedRouteParamDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const stableParamsDiagnosticsText = `<script server>\nconst query = params\nquery.sort\n</script>\n`
    const stableParamsDiagnosticsFirst = serializeDiagnostics(
      service.getDiagnostics(fixture.boardsFilePath, stableParamsDiagnosticsText)
    )
    const stableParamsDiagnosticsSecond = serializeDiagnostics(
      service.getDiagnostics(fixture.boardsFilePath, stableParamsDiagnosticsText)
    )
    if (JSON.stringify(stableParamsDiagnosticsFirst) !== JSON.stringify(stableParamsDiagnosticsSecond)) {
      throw new Error(
        `Expected repeated diagnostics to stay stable for the same JS input. Got: ${JSON.stringify({
          first: stableParamsDiagnosticsFirst,
          second: stableParamsDiagnosticsSecond,
        })}`
      )
    }

    const staleSchemaFirstText =
      `<script server>\nconst board = $app.findRecordById('boards', 'board-1')\nboard.get('missing_field')\n</script>\n`
    const staleSchemaSecondText =
      `<script server>\nconst board = $app.findRecordById('boards', 'board-1')\nboard.get('name')\n</script>\n`
    const staleSchemaFirstDiagnostics = service.getDiagnostics(fixture.boardsFilePath, staleSchemaFirstText)
    if (
      !staleSchemaFirstDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "boards"')
      )
    ) {
      throw new Error(
        `Expected first repeated schema diagnostic run to report missing_field. Got: ${staleSchemaFirstDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }
    const staleSchemaSecondDiagnostics = service.getDiagnostics(fixture.boardsFilePath, staleSchemaSecondText)
    if (
      staleSchemaSecondDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "boards"')
      )
    ) {
      throw new Error(
        `Expected second repeated schema diagnostic run to drop stale missing_field issues. Got: ${staleSchemaSecondDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const staleRecordSetFirstText =
      `<script server>\nconst board = $app.findRecordById('boards', 'board-1')\nboard.set('missing_field', request.url.query.sort)\n</script>\n`
    const staleRecordSetSecondText =
      `<script server>\nconst board = $app.findRecordById('boards', 'board-1')\nboard.set('name', request.url.query.sort)\n</script>\n`
    const staleRecordSetFirstDiagnostics = service.getDiagnostics(fixture.boardsFilePath, staleRecordSetFirstText)
    if (
      !staleRecordSetFirstDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "boards"')
      )
    ) {
      throw new Error(
        `Expected first repeated record.set() diagnostic run to report missing_field. Got: ${staleRecordSetFirstDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }
    const staleRecordSetSecondDiagnostics = service.getDiagnostics(fixture.boardsFilePath, staleRecordSetSecondText)
    if (
      staleRecordSetSecondDiagnostics.some((entry) =>
        String(entry.message).includes('Unknown field "missing_field" for collection "boards"')
      )
    ) {
      throw new Error(
        `Expected second repeated record.set() diagnostic run to drop stale missing_field issues. Got: ${staleRecordSetSecondDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }

    const staleTemplateFirstText =
      `<script server>\nconst authState = { email: '' }\n</script>\n<p><%= missingAuthState.email %></p>\n`
    const staleTemplateSecondText =
      `<script server>\nconst authState = { email: '' }\n</script>\n<p><%= authState.email %></p>\n`
    const staleTemplateFirstDiagnostics = service.getDiagnostics(fixture.boardsFilePath, staleTemplateFirstText)
    if (
      !staleTemplateFirstDiagnostics.some((entry) => entry.code === 2304 && String(entry.message).includes('missingAuthState'))
    ) {
      throw new Error(
        `Expected first repeated template diagnostic run to report missingAuthState. Got: ${staleTemplateFirstDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
      )
    }
    const staleTemplateSecondDiagnostics = service.getDiagnostics(fixture.boardsFilePath, staleTemplateSecondText)
    if (
      staleTemplateSecondDiagnostics.some((entry) => entry.code === 2304 && String(entry.message).includes('missingAuthState'))
    ) {
      throw new Error(
        `Expected second repeated template diagnostic run to drop stale missingAuthState issues. Got: ${staleTemplateSecondDiagnostics
          .map((entry) => String(entry.message))
          .join(' | ')}`
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

    const resolvePrivateRelativeDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nresolve('_private/board-service')\n</script>\n`
    )
    if (!resolvePrivateRelativeDiagnostics.some((entry) => entry.code === 'pp-resolve-private-prefix')) {
      throw new Error(
        `Expected resolve('_private/...') diagnostic. Got: ${resolvePrivateRelativeDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const resolvePrivateRelativeCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<script server>\nresolve('_private/board-service')\n</script>\n`,
      {
        start: `<script server>\nresolve('_private/board-service')\n</script>\n`.indexOf('_private/board-service'),
        end:
          `<script server>\nresolve('_private/board-service')\n</script>\n`.indexOf('_private/board-service') +
          '_private/board-service'.length,
      }
    )
    if (
      !resolvePrivateRelativeCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === 'board-service')
      )
    ) {
      throw new Error(`Expected resolve('_private/...') quick fix. Got: ${JSON.stringify(resolvePrivateRelativeCodeActions)}`)
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

    const partialResolveDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script server>\nresolve('flash-alert')\n</script>\n`
    )
    if (!partialResolveDiagnostics.some((entry) => entry.code === 'pp-unresolved-resolve-path')) {
      throw new Error(`Expected resolve() to reject .ejs partial targets. Got: ${JSON.stringify(partialResolveDiagnostics)}`)
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
    const unresolvedAssetDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<script src="<%= asset('/assets/booklog-reder.js') %>"></script>\n`
    )
    const unresolvedAssetDiagnostic = unresolvedAssetDiagnostics.find((entry) => entry.code === 'pp-unresolved-asset-path')
    if (!unresolvedAssetDiagnostic || !String(unresolvedAssetDiagnostic.message).includes('/assets/booklog-reader.js')) {
      throw new Error(`Expected unresolved asset() path diagnostic with suggestion. Got: ${JSON.stringify(unresolvedAssetDiagnostics)}`)
    }
    const unresolvedAssetCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<script src="<%= asset('/assets/booklog-reder.js') %>"></script>\n`,
      {
        start: `<script src="<%= asset('/assets/booklog-reder.js') %>"></script>\n`.indexOf('/assets/booklog-reder.js'),
        end:
          `<script src="<%= asset('/assets/booklog-reder.js') %>"></script>\n`.indexOf('/assets/booklog-reder.js') +
          '/assets/booklog-reder.js'.length,
      }
    )
    if (
      !unresolvedAssetCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === '/assets/booklog-reader.js')
      )
    ) {
      throw new Error(`Expected unresolved asset() path quick fix. Got: ${JSON.stringify(unresolvedAssetCodeActions)}`)
    }
    const unresolvedAssetWithQueryCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      `<script src="<%= asset('/assets/booklog-reder.js?v=1#main') %>"></script>\n`,
      {
        start: `<script src="<%= asset('/assets/booklog-reder.js?v=1#main') %>"></script>\n`.indexOf('/assets/booklog-reder.js?v=1#main'),
        end:
          `<script src="<%= asset('/assets/booklog-reder.js?v=1#main') %>"></script>\n`.indexOf('/assets/booklog-reder.js?v=1#main') +
          '/assets/booklog-reder.js?v=1#main'.length,
      }
    )
    if (
      !unresolvedAssetWithQueryCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === '/assets/booklog-reader.js?v=1#main')
      )
    ) {
      throw new Error(`Expected unresolved asset() quick fix to preserve query/hash suffixes. Got: ${JSON.stringify(unresolvedAssetWithQueryCodeActions)}`)
    }

    const hrefAssetDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<a href="/assets/booklog-reader.js?v=1"></a>\n`
    )
    if (hrefAssetDiagnostics.some((entry) => entry.code === 'pp-unresolved-route-path')) {
      throw new Error(`Expected href static asset URL to avoid unresolved route diagnostics. Got: ${JSON.stringify(hrefAssetDiagnostics)}`)
    }

    const unresolvedHrefAssetDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<a href="/assets/booklog-reder.js?v=1"></a>\n`
    )
    const unresolvedHrefAssetDiagnostic = unresolvedHrefAssetDiagnostics.find((entry) => entry.code === 'pp-unresolved-asset-path')
    if (
      !unresolvedHrefAssetDiagnostic ||
      !String(unresolvedHrefAssetDiagnostic.message).includes('/assets/booklog-reader.js')
    ) {
      throw new Error(`Expected unresolved href static asset URL diagnostic with asset suggestion. Got: ${JSON.stringify(unresolvedHrefAssetDiagnostics)}`)
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

    const unresolvedRouteHashCodeActions = service.getCodeActions(
      fixture.siteIndexFilePath,
      `<a href="/signn-in?next=/boards#hero"></a>\n`,
      {
        start: `<a href="/signn-in?next=/boards#hero"></a>\n`.indexOf('/signn-in?next=/boards#hero'),
        end:
          `<a href="/signn-in?next=/boards#hero"></a>\n`.indexOf('/signn-in?next=/boards#hero') +
          '/signn-in?next=/boards#hero'.length,
      }
    )
    if (
      !unresolvedRouteHashCodeActions.some((entry) =>
        entry.edits.some((edit) => edit.newText === '/sign-in?next=/boards#hero')
      )
    ) {
      throw new Error(`Expected unresolved route path quick fix to preserve query and hash suffixes. Got: ${JSON.stringify(unresolvedRouteHashCodeActions)}`)
    }

    const dynamicRouteDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      `<a href="/boards/<%= params.boardSlug %>/posts/new"></a>\n`
    )
    if (dynamicRouteDiagnostics.some((entry) => entry.code === 'pp-unresolved-route-path')) {
      throw new Error(`Expected dynamic EJS route paths to skip unresolved-route diagnostics. Got: ${JSON.stringify(dynamicRouteDiagnostics)}`)
    }

    const concreteDynamicRouteDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<a href="/boards/demo-board"></a>\n`
    )
    if (concreteDynamicRouteDiagnostics.some((entry) => entry.code === 'pp-unresolved-route-path')) {
      throw new Error(
        `Expected concrete dynamic route URLs to resolve without unresolved-route diagnostics. Got: ${JSON.stringify(concreteDynamicRouteDiagnostics)}`
      )
    }

    const dynamicTemplateRouteDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<a href="/boards/\${window.currentBoardSlug}"></a>\n`
    )
    if (dynamicTemplateRouteDiagnostics.some((entry) => entry.code === 'pp-unresolved-route-path')) {
      throw new Error(`Expected \${...} route paths to skip unresolved-route diagnostics. Got: ${JSON.stringify(dynamicTemplateRouteDiagnostics)}`)
    }

    const ejsRegionBoundaryText = `<script server>
const serverHtml = '<a href="/missing-server-string"></a>'
const serverIncludeText = "include('missing-server-string.ejs')"
resolve('board-service')
</script>
<script>
const clientHtml = '<a href="/missing-client-string"></a>'
const clientResolve = "resolve('missing-client-service')"
</script>
plain include('missing-plain-text.ejs')
<%# include('missing-comment.ejs') %>
<a href="/missing-real-route"></a>
<%- include('missing-real-partial.ejs') %>
`
    const ejsRegionBoundaryDiagnostics = service.getDiagnostics(
      fixture.boardsFilePath,
      ejsRegionBoundaryText
    )
    const ejsRegionBoundaryFalsePositiveValues = [
      '/missing-server-string',
      'missing-server-string.ejs',
      '/missing-client-string',
      'missing-client-service',
      'missing-plain-text.ejs',
      'missing-comment.ejs',
    ]
    const ejsRegionBoundaryFalsePositive = ejsRegionBoundaryDiagnostics.find((entry) =>
      ejsRegionBoundaryFalsePositiveValues.some((value) => String(entry.message || '').includes(value))
    )
    if (ejsRegionBoundaryFalsePositive) {
      throw new Error(`Expected path diagnostics to ignore strings, client scripts, plain text, and EJS comments. Got: ${JSON.stringify(ejsRegionBoundaryDiagnostics)}`)
    }
    if (
      !ejsRegionBoundaryDiagnostics.some((entry) =>
        entry.code === 'pp-unresolved-route-path' &&
        String(entry.message || '').includes('/missing-real-route')
      ) ||
      !ejsRegionBoundaryDiagnostics.some((entry) =>
        entry.code === 'pp-unresolved-include-path' &&
        String(entry.message || '').includes('missing-real-partial.ejs')
      )
    ) {
      throw new Error(`Expected path diagnostics to keep real route/include contexts. Got: ${JSON.stringify(ejsRegionBoundaryDiagnostics)}`)
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

    const partialContextText = `<%- include('flash-alert.ejs', { params, request }) %>\n`
    const partialContextParamsCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      partialContextText,
      {
        start: partialContextText.indexOf('params'),
        end: partialContextText.indexOf('params') + 'params'.length,
      }
    )
    const removeParamsAction = partialContextParamsCodeActions.find((entry) =>
      entry.title === 'Remove local "params"'
    )
    if (!removeParamsAction) {
      throw new Error(`Expected partial full-context params quick fix. Got: ${JSON.stringify(partialContextParamsCodeActions)}`)
    }
    const partialWithoutParamsText = applyEditsToText(partialContextText, removeParamsAction.edits)
    if (partialWithoutParamsText !== `<%- include('flash-alert.ejs', { request }) %>\n`) {
      throw new Error(`Expected partial full-context quick fix to remove first local cleanly. Got: ${partialWithoutParamsText}`)
    }

    const partialContextRequestCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      partialContextText,
      {
        start: partialContextText.indexOf('request'),
        end: partialContextText.indexOf('request') + 'request'.length,
      }
    )
    const removeRequestAction = partialContextRequestCodeActions.find((entry) =>
      entry.title === 'Remove local "request"'
    )
    if (!removeRequestAction) {
      throw new Error(`Expected partial full-context request quick fix. Got: ${JSON.stringify(partialContextRequestCodeActions)}`)
    }
    const partialWithoutRequestText = applyEditsToText(partialContextText, removeRequestAction.edits)
    if (partialWithoutRequestText !== `<%- include('flash-alert.ejs', { params }) %>\n`) {
      throw new Error(`Expected partial full-context quick fix to remove last local cleanly. Got: ${partialWithoutRequestText}`)
    }

    const partialContextTrailingText = `<%- include('flash-alert.ejs', {\n  params,\n  request,\n}) %>\n`
    const partialContextTrailingCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      partialContextTrailingText,
      {
        start: partialContextTrailingText.indexOf('request'),
        end: partialContextTrailingText.indexOf('request') + 'request'.length,
      }
    )
    const removeTrailingRequestAction = partialContextTrailingCodeActions.find((entry) =>
      entry.title === 'Remove local "request"'
    )
    if (!removeTrailingRequestAction) {
      throw new Error(`Expected trailing partial full-context request quick fix. Got: ${JSON.stringify(partialContextTrailingCodeActions)}`)
    }
    const partialWithoutTrailingRequestText = applyEditsToText(partialContextTrailingText, removeTrailingRequestAction.edits)
    if (partialWithoutTrailingRequestText.includes('request') || /,\s*\}/.test(partialWithoutTrailingRequestText)) {
      throw new Error(`Expected trailing partial full-context quick fix to remove local and comma. Got: ${partialWithoutTrailingRequestText}`)
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
    const manualFlashText = `<script server>\nredirect('/boards?__flash=saved')\n</script>\n`
    const manualFlashCodeActions = service.getCodeActions(
      fixture.boardsFilePath,
      manualFlashText,
      {
        start: manualFlashText.indexOf('__flash'),
        end: manualFlashText.indexOf('__flash') + '__flash'.length,
      }
    )
    const removeManualFlashAction = manualFlashCodeActions.find((entry) =>
      entry.title === 'Remove __flash query'
    )
    if (!removeManualFlashAction) {
      throw new Error(`Expected manual __flash query quick fix. Got: ${JSON.stringify(manualFlashCodeActions)}`)
    }
    const manualFlashPatchedText = applyEditsToText(manualFlashText, removeManualFlashAction.edits)
    if (manualFlashPatchedText !== `<script server>\nredirect('/boards')\n</script>\n`) {
      throw new Error(`Expected manual __flash quick fix to remove empty query. Got: ${manualFlashPatchedText}`)
    }

    const manualFlashHrefDiagnostics = service.getDiagnostics(
      fixture.siteIndexFilePath,
      `<a href="/boards?__flash=saved"></a>\n`
    )
    if (!manualFlashHrefDiagnostics.some((entry) => entry.code === 'pp-manual-flash-query')) {
      throw new Error(
        `Expected manual __flash query diagnostic for href. Got: ${manualFlashHrefDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }
    const manualFlashHrefText = `<a href="/boards?next=/home&__flash=saved#done"></a>\n`
    const manualFlashHrefCodeActions = service.getCodeActions(
      fixture.siteIndexFilePath,
      manualFlashHrefText,
      {
        start: manualFlashHrefText.indexOf('__flash'),
        end: manualFlashHrefText.indexOf('__flash') + '__flash'.length,
      }
    )
    const removeManualFlashHrefAction = manualFlashHrefCodeActions.find((entry) =>
      entry.title === 'Remove __flash query'
    )
    if (!removeManualFlashHrefAction) {
      throw new Error(`Expected manual __flash href quick fix. Got: ${JSON.stringify(manualFlashHrefCodeActions)}`)
    }
    const manualFlashHrefPatchedText = applyEditsToText(manualFlashHrefText, removeManualFlashHrefAction.edits)
    if (manualFlashHrefPatchedText !== `<a href="/boards?next=/home#done"></a>\n`) {
      throw new Error(`Expected manual __flash href quick fix to preserve other query and hash. Got: ${manualFlashHrefPatchedText}`)
    }

    const redirectMissingReturnDiagnostics = service.getDiagnostics(
      fixture.feedbackLoadFilePath,
      `module.exports = function () {\n  redirect('/sign-in')\n}\n`
    )
    if (!redirectMissingReturnDiagnostics.some((entry) => entry.code === 'pp-redirect-missing-return')) {
      throw new Error(
        `Expected redirect() missing return diagnostic in +load.js. Got: ${redirectMissingReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }
    const responseRedirectMissingReturnDiagnostics = service.getDiagnostics(
      fixture.feedbackLoadFilePath,
      `module.exports = function ({ response }) {\n  response.redirect('/sign-in')\n}\n`
    )
    if (!responseRedirectMissingReturnDiagnostics.some((entry) => entry.code === 'pp-redirect-missing-return')) {
      throw new Error(
        `Expected response.redirect() missing return diagnostic in +load.js. Got: ${responseRedirectMissingReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }
    const redirectMissingReturnText = `module.exports = function () {\n  redirect('/sign-in')\n}\n`
    const redirectMissingReturnCodeActions = service.getCodeActions(
      fixture.feedbackLoadFilePath,
      redirectMissingReturnText,
      {
        start: redirectMissingReturnText.indexOf('redirect'),
        end: redirectMissingReturnText.indexOf('redirect') + 'redirect'.length,
      }
    )
    const addReturnAction = redirectMissingReturnCodeActions.find((entry) =>
      entry.title === 'Add return before redirect()'
    )
    if (!addReturnAction) {
      throw new Error(`Expected redirect() missing return quick fix. Got: ${JSON.stringify(redirectMissingReturnCodeActions)}`)
    }
    const redirectMissingReturnPatchedText = applyEditsToText(redirectMissingReturnText, addReturnAction.edits)
    if (!redirectMissingReturnPatchedText.includes(`return redirect('/sign-in')`)) {
      throw new Error(`Expected redirect() quick fix to add return. Got: ${redirectMissingReturnPatchedText}`)
    }

    const redirectFollowedByReturnDiagnostics = service.getDiagnostics(
      fixture.feedbackLoadFilePath,
      `module.exports = function () {\n  redirect('/sign-in')\n  return\n}\n`
    )
    if (redirectFollowedByReturnDiagnostics.some((entry) => entry.code === 'pp-redirect-missing-return')) {
      throw new Error(
        `Expected redirect() followed by return to skip missing return diagnostic. Got: ${redirectFollowedByReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const redirectReturnedDiagnostics = service.getDiagnostics(
      fixture.feedbackLoadFilePath,
      `module.exports = function () {\n  return redirect('/sign-in')\n}\n`
    )
    if (redirectReturnedDiagnostics.some((entry) => entry.code === 'pp-redirect-missing-return')) {
      throw new Error(
        `Expected returned redirect() to skip missing return diagnostic. Got: ${redirectReturnedDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const ejsRedirectMissingReturnDiagnostics = service.getDiagnostics(
      fixture.signOutFilePath,
      `<script server>\nredirect('/sign-in')\n</script>\n`
    )
    if (!ejsRedirectMissingReturnDiagnostics.some((entry) => entry.code === 'pp-redirect-missing-return')) {
      throw new Error(
        `Expected redirect() missing return diagnostic in <script server>. Got: ${ejsRedirectMissingReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }
    const ejsRedirectMissingReturnText = `<script server>\nredirect('/sign-in')\n</script>\n`
    const ejsRedirectMissingReturnCodeActions = service.getCodeActions(
      fixture.signOutFilePath,
      ejsRedirectMissingReturnText,
      {
        start: ejsRedirectMissingReturnText.indexOf('redirect'),
        end: ejsRedirectMissingReturnText.indexOf('redirect') + 'redirect'.length,
      }
    )
    const ejsAddReturnAction = ejsRedirectMissingReturnCodeActions.find((entry) =>
      entry.title === 'Add return before redirect()'
    )
    if (!ejsAddReturnAction) {
      throw new Error(`Expected EJS redirect() missing return quick fix. Got: ${JSON.stringify(ejsRedirectMissingReturnCodeActions)}`)
    }
    const ejsRedirectMissingReturnPatchedText = applyEditsToText(ejsRedirectMissingReturnText, ejsAddReturnAction.edits)
    if (ejsRedirectMissingReturnPatchedText !== `<script server>\nreturn redirect('/sign-in')\n</script>\n`) {
      throw new Error(`Expected EJS redirect() quick fix to add return. Got: ${ejsRedirectMissingReturnPatchedText}`)
    }

    const ejsRedirectFollowedByReturnDiagnostics = service.getDiagnostics(
      fixture.signOutFilePath,
      `<script server>\nredirect('/sign-in')\nreturn\n</script>\n`
    )
    if (ejsRedirectFollowedByReturnDiagnostics.some((entry) => entry.code === 'pp-redirect-missing-return')) {
      throw new Error(
        `Expected redirect() followed by return in <script server> to skip missing return diagnostic. Got: ${ejsRedirectFollowedByReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const middlewareMissingNextDiagnostics = service.getDiagnostics(
      fixture.middlewareFilePath,
      `module.exports = function ({ response }, next) {\n  return response.json(200, { ok: true })\n}\n`
    )
    if (!middlewareMissingNextDiagnostics.some((entry) => entry.code === 'pp-middleware-next-missing-call')) {
      throw new Error(
        `Expected +middleware.js next() missing call diagnostic. Got: ${middlewareMissingNextDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const middlewareBareReturnDiagnostics = service.getDiagnostics(
      fixture.middlewareFilePath,
      `module.exports = function (api, next) {\n  if (!api.request) {\n    return\n  }\n  return next()\n}\n`
    )
    if (!middlewareBareReturnDiagnostics.some((entry) => entry.code === 'pp-middleware-next-bare-return')) {
      throw new Error(
        `Expected +middleware.js bare return diagnostic with next(). Got: ${middlewareBareReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const middlewareEmptyReturnDiagnostics = service.getDiagnostics(
      fixture.middlewareFilePath,
      `module.exports = function (api, next) {\n  if (!api.request) {\n    return {}\n  }\n  return next()\n}\n`
    )
    if (!middlewareEmptyReturnDiagnostics.some((entry) => entry.code === 'pp-middleware-next-empty-return')) {
      throw new Error(
        `Expected +middleware.js return {} diagnostic with next(). Got: ${middlewareEmptyReturnDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const validMiddlewareNextDiagnostics = service.getDiagnostics(
      fixture.middlewareFilePath,
      `module.exports = function ({ response }, next) {\n  if (false) {\n    return response.json(400, { error: 'invalid' })\n  }\n  return next()\n}\n`
    )
    if (
      validMiddlewareNextDiagnostics.some((entry) =>
        ['pp-middleware-next-missing-call', 'pp-middleware-next-bare-return', 'pp-middleware-next-empty-return'].includes(entry.code)
      )
    ) {
      throw new Error(
        `Expected valid +middleware.js next() flow to skip middleware control diagnostics. Got: ${validMiddlewareNextDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const privateModuleResolveDiagnostics = service.getDiagnostics(
      fixture.boardServiceFilePath,
      `const innerService = resolve('board-service')\nmodule.exports = { innerService }\n`
    )
    if (!privateModuleResolveDiagnostics.some((entry) => entry.code === 'pp-private-resolve')) {
      throw new Error(
        `Expected _private module resolve() diagnostic. Got: ${privateModuleResolveDiagnostics
          .map((entry) => String(entry.code))
          .join(', ')}`
      )
    }

    const privatePartialResolveDiagnostics = service.getDiagnostics(
      fixture.flashAlertFilePath,
      `<% resolve('board-service') %>\n<div><%= flashMessage %></div>\n`
    )
    if (!privatePartialResolveDiagnostics.some((entry) => entry.code === 'pp-private-resolve')) {
      throw new Error(
        `Expected _private partial resolve() diagnostic. Got: ${privatePartialResolveDiagnostics
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

    const requireDocumentLinks = service.getDocumentLinks(
      fixture.htmlToTextPageConsumerFilePath,
      fs.readFileSync(fixture.htmlToTextPageConsumerFilePath, 'utf8')
    )
    const requireDocumentLinkTargets = requireDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!requireDocumentLinkTargets.includes(normalizeFilePath(fixture.htmlToTextBundleFilePath))) {
      throw new Error(`Expected __hooks require() document link target. Got: ${requireDocumentLinkTargets.join(', ')}`)
    }
    const concatRequireDocumentLinks = service.getDocumentLinks(
      fixture.htmlToTextConcatConsumerFilePath,
      fs.readFileSync(fixture.htmlToTextConcatConsumerFilePath, 'utf8')
    )
    const concatRequireDocumentLinkTargets = concatRequireDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!concatRequireDocumentLinkTargets.includes(normalizeFilePath(fixture.htmlToTextBundleFilePath))) {
      throw new Error(`Expected __hooks string-concatenation require() document link target. Got: ${concatRequireDocumentLinkTargets.join(', ')}`)
    }

    const groupedResolveDocumentLinks = service.getDocumentLinks(fixture.boardsFilePath, groupedResolveText)
    const groupedResolveTargets = groupedResolveDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!groupedResolveTargets.includes(normalizeFilePath(fixture.boardRoleFilePath))) {
      throw new Error(`Expected grouped resolve() document link target for roles/board. Got: ${groupedResolveTargets.join(', ')}`)
    }
    if (!groupedResolveTargets.includes(normalizeFilePath(fixture.postRoleFilePath))) {
      throw new Error(`Expected grouped resolve() document link target for roles/post. Got: ${groupedResolveTargets.join(', ')}`)
    }

    const assetDocumentLinks = service.getDocumentLinks(
      fixture.boardsFilePath,
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n<script src="<%= asset('/assets/booklog-reader.js?v=1#main') %>"></script>\n<link rel="stylesheet" href="<%= asset('card.css') %>">\n<a href="/assets/booklog-reader.js?v=1">Download</a>\n`
    )
    const assetDocumentLinkTargets = assetDocumentLinks.map((entry) => entry.targetFilePath)
    if (!assetDocumentLinkTargets.some((target) => normalizeFilePath(target) === normalizeFilePath(fixture.globalAssetFilePath))) {
      throw new Error(`Expected asset() document link target for global asset. Got: ${assetDocumentLinkTargets.join(', ')}`)
    }
    if (!assetDocumentLinkTargets.some((target) => normalizeFilePath(target) === normalizeFilePath(fixture.localAssetFilePath))) {
      throw new Error(`Expected asset() document link target for local asset. Got: ${assetDocumentLinkTargets.join(', ')}`)
    }
    if (assetDocumentLinkTargets.filter((target) => normalizeFilePath(target) === normalizeFilePath(fixture.globalAssetFilePath)).length !== 3) {
      throw new Error(`Expected asset() and href static asset document links for global asset. Got: ${assetDocumentLinkTargets.join(', ')}`)
    }
    const hrefAssetDocumentLink = assetDocumentLinks.find(
      (entry) => entry.value === '/assets/booklog-reader.js?v=1'
    )
    if (!hrefAssetDocumentLink || hrefAssetDocumentLink.kind !== 'asset-path') {
      throw new Error(`Expected href static asset document link to be labeled as asset-path. Got: ${JSON.stringify(assetDocumentLinks)}`)
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

    const routeMethodDocumentLinks = indexService.getDocumentLinks(
      fixture.routeMethodReferenceCheckFilePath,
      fs.readFileSync(fixture.routeMethodReferenceCheckFilePath, 'utf8')
    )
    const routeMethodDocumentLinkTargets = routeMethodDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!routeMethodDocumentLinkTargets.includes(normalizeFilePath(fixture.feedbackPageFilePath))) {
      throw new Error(`Expected href method route document link target. Got: ${routeMethodDocumentLinkTargets.join(', ')}`)
    }
    if (routeMethodDocumentLinkTargets.filter((target) => target === normalizeFilePath(fixture.feedbackPostFilePath)).length !== 3) {
      throw new Error(`Expected action, hx-post, and data-hx-post to target feedback POST route. Got: ${routeMethodDocumentLinkTargets.join(', ')}`)
    }
    if (!routeMethodDocumentLinkTargets.includes(normalizeFilePath(fixture.feedbackDeleteFilePath))) {
      throw new Error(`Expected hx-delete method route document link target. Got: ${routeMethodDocumentLinkTargets.join(', ')}`)
    }
    if (!routeMethodDocumentLinkTargets.includes(normalizeFilePath(fixture.feedbackPutFilePath))) {
      throw new Error(`Expected hx-put method route document link target. Got: ${routeMethodDocumentLinkTargets.join(', ')}`)
    }
    if (!routeMethodDocumentLinkTargets.includes(normalizeFilePath(fixture.feedbackPatchFilePath))) {
      throw new Error(`Expected hx-patch method route document link target. Got: ${routeMethodDocumentLinkTargets.join(', ')}`)
    }

    const dynamicRouteDocumentLinks = indexService.getDocumentLinks(
      fixture.siteIndexFilePath,
      `<a href="/boards/demo-board">Board</a>\n`
    )
    const dynamicRouteDocumentLinkTargets = dynamicRouteDocumentLinks.map((entry) => normalizeFilePath(entry.targetFilePath))
    if (!dynamicRouteDocumentLinkTargets.includes(normalizeFilePath(fixture.boardShowFilePath))) {
      throw new Error(
        `Expected concrete dynamic route document link target for [boardSlug].ejs. Got: ${dynamicRouteDocumentLinkTargets.join(', ')}`
      )
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

    const explicitServerBlocks = extractServerBlocks(`<script server>const authState = resolve('auth-service')</script>`)
    if (explicitServerBlocks.length !== 1) {
      throw new Error(`Expected explicit server attribute to produce one server block. Got: ${explicitServerBlocks.length}`)
    }

    const dataServerBlocks = extractServerBlocks(`<script data-server="1">const authState = resolve('auth-service')</script>`)
    if (dataServerBlocks.length !== 0) {
      throw new Error(`Expected data-server attribute to stay out of PocketPages server block parsing. Got: ${dataServerBlocks.length}`)
    }

    const serverlessBlocks = extractServerBlocks(`<script serverless>const authState = resolve('auth-service')</script>`)
    if (serverlessBlocks.length !== 0) {
      throw new Error(`Expected serverless attribute to stay out of PocketPages server block parsing. Got: ${serverlessBlocks.length}`)
    }

    const attributeOrderServerBlocks = extractServerBlocks(
      `<script type="text/javascript" server class="panel">const authState = resolve('auth-service')</script>`
    )
    if (attributeOrderServerBlocks.length !== 1) {
      throw new Error(
        `Expected server attribute mixed with other attributes to produce one server block. Got: ${attributeOrderServerBlocks.length}`
      )
    }

    const commentedServerBlocks = extractServerBlocks(`<!-- <script server>const authState = resolve('auth-service')</script> -->`)
    if (commentedServerBlocks.length !== 0) {
      throw new Error(`Expected HTML-commented server scripts to stay out of PocketPages server block parsing. Got: ${commentedServerBlocks.length}`)
    }

    const strayCommentMarkerServerBlocks = extractServerBlocks(`<div title="<!--"> <script server>const authState = resolve('auth-service')</script>`)
    if (strayCommentMarkerServerBlocks.length !== 1) {
      throw new Error(`Expected a stray "<!--" outside a closed comment to not drop a real server block. Got: ${strayCommentMarkerServerBlocks.length}`)
    }

    const mirroredServerSource = `<script server>
const authState = resolve('auth-service')
</script>

<section>
  <div>Dashboard</div>
</section>
`
    const mirroredServerText = buildScriptServerMirrorText(mirroredServerSource)
    if (mirroredServerText.length !== mirroredServerSource.length) {
      throw new Error(
        `Expected mirrored server text to preserve source length. Got: ${mirroredServerText.length}`
      )
    }
    if (!mirroredServerText.includes("const authState = resolve('auth-service')")) {
      throw new Error(`Expected mirrored server text to preserve <script server> contents. Got: ${mirroredServerText}`)
    }
    if (/<section>|Dashboard/.test(mirroredServerText)) {
      throw new Error(`Expected mirrored server text to blank template HTML. Got: ${mirroredServerText}`)
    }

    if (!isPocketPagesEjsFile(fixture.signInFilePath)) {
      throw new Error('Expected PocketPages TS plugin helpers to recognize page .ejs files.')
    }
    if (isPocketPagesEjsFile(fixture.boardRoleFilePath)) {
      throw new Error('Expected PocketPages TS plugin helpers to ignore non-.ejs files.')
    }
    if (!isPocketPagesAssetFile(fixture.globalAssetTemplateFilePath)) {
      throw new Error('Expected PocketPages TS plugin helpers to recognize page asset files.')
    }
    if (isPocketPagesEjsFile(fixture.globalAssetTemplateFilePath) || isPocketPagesEjsFile(fixture.nestedAssetTemplateFilePath)) {
      throw new Error('Expected PocketPages TS plugin helpers to ignore .ejs files under public page assets.')
    }

    const pluginExternalFiles = collectExternalPocketPagesEjsFiles(
      {
        sys: {
          readDirectory(rootPath) {
            if (normalizeFilePath(rootPath) !== normalizeFilePath(fixture.appRoot)) {
              return []
            }

            return [fixture.signInFilePath, fixture.flashAlertFilePath, fixture.globalAssetTemplateFilePath]
          },
        },
      },
      {
        getCurrentDirectory() {
          return fixture.appRoot
        },
      }
    )
    if (!pluginExternalFiles.includes(fixture.signInFilePath) || !pluginExternalFiles.includes(fixture.flashAlertFilePath)) {
      throw new Error(
        `Expected PocketPages TS plugin helper to surface page and partial .ejs files. Got: ${pluginExternalFiles.join(', ')}`
      )
    }
    if (pluginExternalFiles.includes(fixture.globalAssetTemplateFilePath)) {
      throw new Error(
        `Expected PocketPages TS plugin helper to exclude public asset .ejs files. Got: ${pluginExternalFiles.join(', ')}`
      )
    }

    const pluginRuntimeFactory = initTypeScriptPlugin({ typescript: ts })
    let pluginProjectVersion = '1'
    let pluginNow = 1000
    const pluginSnapshotOverrides = new Map()
    const pluginScriptFileNames = [
      fixture.signInFilePath,
      fixture.boardServiceFilePath,
    ]
    const pluginDirectoryWatchers = []
    let pluginBaseDisposed = false
    let pluginBaseReferencesAtPosition = null
    let pluginBaseRenameInfoAtPosition = null
    let pluginBaseRenameLocationsAtPosition = null
    function triggerPluginFileWatch(filePath) {
      const normalizedFilePath = normalizeFilePath(filePath)
      let triggered = 0
      for (const watcher of pluginDirectoryWatchers) {
        if (watcher.closed) {
          continue
        }

        const normalizedDirectory = normalizeFilePath(watcher.directory)
        const matched = watcher.recursive
          ? normalizedFilePath === normalizedDirectory || normalizedFilePath.startsWith(`${normalizedDirectory}/`)
          : normalizeFilePath(path.dirname(filePath)) === normalizedDirectory
        if (!matched) {
          continue
        }

        watcher.callback(filePath)
        triggered += 1
      }

      return triggered
    }
    const pluginBaseLanguageService = {
      getCompletionsAtPosition() {
        return null
      },
      getCompletionEntryDetails() {
        return null
      },
      getQuickInfoAtPosition() {
        return null
      },
      getDefinitionAtPosition() {
        return null
      },
      getDefinitionAndBoundSpan() {
        return null
      },
      getReferencesAtPosition(fileName, position) {
        return typeof pluginBaseReferencesAtPosition === 'function'
          ? pluginBaseReferencesAtPosition(fileName, position)
          : null
      },
      getRenameInfo(fileName, position, options) {
        return typeof pluginBaseRenameInfoAtPosition === 'function'
          ? pluginBaseRenameInfoAtPosition(fileName, position, options)
          : {
              canRename: false,
              localizedErrorMessage: 'Base rename disabled in sanity test.',
            }
      },
      findRenameLocations(fileName, position, findInStrings, findInComments, providePrefixAndSuffixTextForRename) {
        return typeof pluginBaseRenameLocationsAtPosition === 'function'
          ? pluginBaseRenameLocationsAtPosition(
              fileName,
              position,
              findInStrings,
              findInComments,
              providePrefixAndSuffixTextForRename
            )
          : null
      },
      dispose() {
        pluginBaseDisposed = true
      },
    }
    const pluginHost = {
      getScriptSnapshot(fileName) {
        if (pluginSnapshotOverrides.has(fileName)) {
          return ts.ScriptSnapshot.fromString(pluginSnapshotOverrides.get(fileName))
        }

        if (!fs.existsSync(fileName)) {
          return undefined
        }
        return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'))
      },
      getScriptVersion() {
        return ''
      },
      getScriptFileNames() {
        return pluginScriptFileNames.slice()
      },
      getProjectVersion() {
        return pluginProjectVersion
      },
      getScriptKind() {
        return ts.ScriptKind.JS
      },
      getCurrentDirectory() {
        return fixture.appRoot
      },
      getCompilationSettings() {
        return {}
      },
    }
    const pluginProject = {
      getProjectVersion() {
        return pluginProjectVersion
      },
      getProjectName() {
        return path.join(fixture.appRoot, 'jsconfig.json')
      },
      getCurrentDirectory() {
        return fixture.appRoot
      },
      projectService: {
        host: {
          watchDirectory(directory, callback, recursive) {
            const watcher = {
              directory,
              callback,
              recursive: recursive === true,
              closed: false,
            }
            pluginDirectoryWatchers.push(watcher)
            return {
              close() {
                watcher.closed = true
              },
            }
          },
        },
      },
    }
    const originalPluginReloadCachesForAppRoot = PocketPagesLanguageCore.prototype.reloadCachesForAppRoot
    const originalPluginCloseDocument = PocketPagesLanguageCore.prototype.closeDocument
    const originalPluginUpdateDocument = PocketPagesLanguageCore.prototype.updateDocument
    const originalPluginDateNow = Date.now
    const originalPluginReaddirSync = fs.readdirSync
    const pluginReloadAppRoots = []
    const pluginClosedUris = []
    const pluginUpdatedUris = []
    let pluginPagesReaddirCount = 0
    Date.now = function patchedPluginDateNow() {
      return pluginNow
    }
    fs.readdirSync = function patchedPluginReaddirSync(dirPath, ...args) {
      if (normalizeFilePath(dirPath).startsWith(`${normalizeFilePath(fixture.appRoot)}/pb_hooks/pages`)) {
        pluginPagesReaddirCount += 1
      }

      return originalPluginReaddirSync.call(fs, dirPath, ...args)
    }
    PocketPagesLanguageCore.prototype.reloadCachesForAppRoot = function patchedReloadCachesForAppRoot(appRoot) {
      pluginReloadAppRoots.push(normalizeFilePath(appRoot))
      return originalPluginReloadCachesForAppRoot.call(this, appRoot)
    }
    PocketPagesLanguageCore.prototype.closeDocument = function patchedCloseDocument(uri) {
      pluginClosedUris.push(uri)
      return originalPluginCloseDocument.call(this, uri)
    }
    PocketPagesLanguageCore.prototype.updateDocument = function patchedUpdateDocument(document, options) {
      pluginUpdatedUris.push(document && document.uri)
      return originalPluginUpdateDocument.call(this, document, options)
    }
    try {
      const pluginProxy = pluginRuntimeFactory.create({
        languageServiceHost: pluginHost,
        languageService: pluginBaseLanguageService,
        project: pluginProject,
      })
      const originalSignInText = fs.readFileSync(fixture.signInFilePath, 'utf8')
      pluginSnapshotOverrides.set(fixture.signInFilePath, '')
      const emptySignInSnapshot = pluginHost.getScriptSnapshot(fixture.signInFilePath)
      if (!emptySignInSnapshot || emptySignInSnapshot.getLength() !== 0) {
        throw new Error(
          `Expected TS plugin host to preserve an empty editor snapshot instead of falling back to disk. Got length=${emptySignInSnapshot && emptySignInSnapshot.getLength()}`
        )
      }
      const emptySignInQuickInfo = pluginProxy.getQuickInfoAtPosition(
        fixture.signInFilePath,
        originalSignInText.indexOf('signInWithPassword')
      )
      if (emptySignInQuickInfo) {
        throw new Error(`Expected empty editor snapshot to bypass stale disk quick info. Got: ${JSON.stringify(emptySignInQuickInfo)}`)
      }
      pluginSnapshotOverrides.delete(fixture.signInFilePath)
      const pluginUpdateCountBeforeContextCache = pluginUpdatedUris.length
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      const pluginUpdateCountAfterContextCacheWarmup = pluginUpdatedUris.length
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (
        !pluginDirectoryWatchers.some(
          (watcher) =>
            watcher.recursive === true &&
            normalizeFilePath(watcher.directory).endsWith('/pb_hooks/pages')
        )
      ) {
        throw new Error(`Expected TS plugin runtime to register a recursive pages watcher. Got: ${JSON.stringify(pluginDirectoryWatchers)}`)
      }
      if (
        pluginUpdateCountAfterContextCacheWarmup <= pluginUpdateCountBeforeContextCache ||
        pluginUpdatedUris.length !== pluginUpdateCountAfterContextCacheWarmup
      ) {
        throw new Error(
          `Expected TS plugin runtime to reuse unchanged EJS document context. Before=${pluginUpdateCountBeforeContextCache}, afterWarmup=${pluginUpdateCountAfterContextCacheWarmup}, afterCached=${pluginUpdatedUris.length}`
        )
      }

      const pluginBoardServiceText = fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
      const pluginRenameCheckText = fs.readFileSync(fixture.renameCheckFilePath, 'utf8')
      const pluginMiddlewareText = fs.readFileSync(fixture.middlewareFilePath, 'utf8')
      const pluginModuleOffset = pluginBoardServiceText.indexOf('readAuthState') + 2
      const pluginEjsUsageOffset = pluginRenameCheckText.indexOf('readAuthState') + 2
      const pluginJsUsageOffset = pluginMiddlewareText.indexOf('readAuthState') + 2
      const pluginEjsUsageSpan = {
        start: pluginRenameCheckText.indexOf('readAuthState'),
        length: 'readAuthState'.length,
      }
      const pluginLocationKey = (entry) =>
        `${normalizeFilePath(entry.fileName)}:${entry.textSpan.start}:${entry.textSpan.length}`
      const pluginReferenceKeySet = (entries) => new Set((entries || []).map(pluginLocationKey))
      const expectPluginLocation = (entries, filePath, text, needle, label) => {
        const start = text.indexOf(needle)
        if (start < 0) {
          throw new Error(`Expected fixture text for ${label} to contain "${needle}".`)
        }

        if (
          !(entries || []).some(
            (entry) =>
              normalizeFilePath(entry.fileName) === normalizeFilePath(filePath) &&
              entry.textSpan.start === start &&
              entry.textSpan.length === needle.length
          )
        ) {
          throw new Error(`Expected ${label} to include ${normalizeFilePath(filePath)}:${start}. Got: ${JSON.stringify(entries)}`)
        }
      }
      const expectSamePluginLocations = (leftEntries, rightEntries, label) => {
        const leftKeys = pluginReferenceKeySet(leftEntries)
        const rightKeys = pluginReferenceKeySet(rightEntries)
        if (
          leftKeys.size !== rightKeys.size ||
          [...leftKeys].some((key) => !rightKeys.has(key))
        ) {
          throw new Error(
            `Expected TS plugin ${label} locations to match.\nLeft=${JSON.stringify([...leftKeys])}\nRight=${JSON.stringify([...rightKeys])}`
          )
        }
      }
      const expectNoDuplicatePluginLocations = (entries, label) => {
        const keys = pluginReferenceKeySet(entries)
        if (keys.size !== (entries || []).length) {
          throw new Error(`Expected TS plugin ${label} locations to be deduped. Got: ${JSON.stringify(entries)}`)
        }
      }

      pluginBaseReferencesAtPosition = () => [
        {
          fileName: fixture.renameCheckFilePath,
          textSpan: pluginEjsUsageSpan,
          isWriteAccess: false,
          isDefinition: false,
        },
      ]
      const pluginModuleReferences = pluginProxy.getReferencesAtPosition(
        fixture.boardServiceFilePath,
        pluginModuleOffset
      )
      expectNoDuplicatePluginLocations(pluginModuleReferences, 'module export references')
      expectPluginLocation(
        pluginModuleReferences,
        fixture.boardServiceFilePath,
        pluginBoardServiceText,
        'readAuthState',
        'module export references'
      )
      expectPluginLocation(
        pluginModuleReferences,
        fixture.renameCheckFilePath,
        pluginRenameCheckText,
        'readAuthState',
        'module export references'
      )
      expectPluginLocation(
        pluginModuleReferences,
        fixture.middlewareFilePath,
        pluginMiddlewareText,
        'readAuthState',
        'module export references'
      )

      pluginBaseReferencesAtPosition = null
      const pluginEjsReferences = pluginProxy.getReferencesAtPosition(
        fixture.renameCheckFilePath,
        pluginEjsUsageOffset
      )
      const pluginJsUsageReferences = pluginProxy.getReferencesAtPosition(
        fixture.middlewareFilePath,
        pluginJsUsageOffset
      )
      expectSamePluginLocations(pluginModuleReferences, pluginEjsReferences, 'JS export and EJS reference')
      expectSamePluginLocations(pluginModuleReferences, pluginJsUsageReferences, 'JS export and JS resolve() reference')

      const pluginModuleRenameInfo = pluginProxy.getRenameInfo(
        fixture.boardServiceFilePath,
        pluginModuleOffset
      )
      if (
        !pluginModuleRenameInfo ||
        !pluginModuleRenameInfo.canRename ||
        pluginModuleRenameInfo.displayName !== 'readAuthState'
      ) {
        throw new Error(`Expected TS plugin module export rename info. Got: ${JSON.stringify(pluginModuleRenameInfo)}`)
      }

      const pluginEjsRenameInfo = pluginProxy.getRenameInfo(
        fixture.renameCheckFilePath,
        pluginEjsUsageOffset
      )
      if (
        !pluginEjsRenameInfo ||
        !pluginEjsRenameInfo.canRename ||
        pluginEjsRenameInfo.displayName !== 'readAuthState'
      ) {
        throw new Error(`Expected TS plugin EJS resolve() usage rename info. Got: ${JSON.stringify(pluginEjsRenameInfo)}`)
      }

      pluginBaseRenameLocationsAtPosition = () => [
        {
          fileName: fixture.renameCheckFilePath,
          textSpan: pluginEjsUsageSpan,
        },
      ]
      const pluginModuleRenameLocations = pluginProxy.findRenameLocations(
        fixture.boardServiceFilePath,
        pluginModuleOffset,
        false,
        false,
        {}
      )
      expectNoDuplicatePluginLocations(pluginModuleRenameLocations, 'module export rename')
      expectPluginLocation(
        pluginModuleRenameLocations,
        fixture.renameCheckFilePath,
        pluginRenameCheckText,
        'readAuthState',
        'module export rename'
      )
      expectPluginLocation(
        pluginModuleRenameLocations,
        fixture.middlewareFilePath,
        pluginMiddlewareText,
        'readAuthState',
        'module export rename'
      )

      pluginBaseRenameLocationsAtPosition = null
      const pluginEjsRenameLocations = pluginProxy.findRenameLocations(
        fixture.renameCheckFilePath,
        pluginEjsUsageOffset,
        false,
        false,
        {}
      )
      const pluginJsUsageRenameLocations = pluginProxy.findRenameLocations(
        fixture.middlewareFilePath,
        pluginJsUsageOffset,
        false,
        false,
        {}
      )
      expectSamePluginLocations(pluginModuleRenameLocations, pluginEjsRenameLocations, 'JS export and EJS rename')
      expectSamePluginLocations(pluginModuleRenameLocations, pluginJsUsageRenameLocations, 'JS export and JS resolve() rename')

      const cachedTrackedFileListReaddirCount = pluginPagesReaddirCount
      pluginProjectVersion = '2'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginPagesReaddirCount !== cachedTrackedFileListReaddirCount) {
        throw new Error(
          `Expected TS plugin runtime to reuse the app file list cache across quick project-version changes. Before=${cachedTrackedFileListReaddirCount}, after=${pluginPagesReaddirCount}`
        )
      }

      const pluginReloadCountBeforeCssChange = pluginReloadAppRoots.length
      writeFile(fixture.localAssetFilePath, `.board-card { color: #444; }\n`)
      pluginProjectVersion = '3'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length !== pluginReloadCountBeforeCssChange) {
        throw new Error(
          `Expected TS plugin runtime to ignore non-code page assets when reconciling app caches. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginReloadCountBeforeAssetScriptChange = pluginReloadAppRoots.length
      writeFile(fixture.globalAssetFilePath, `console.log('reader v2')\n`)
      writeFile(fixture.vendorAssetFilePath, `window.JSZip = { version: 'test' }\n`)
      writeFile(fixture.nestedAssetScriptFilePath, `console.log('board widget v2')\n`)
      pluginProjectVersion = 'asset-script-change'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length !== pluginReloadCountBeforeAssetScriptChange) {
        throw new Error(
          `Expected TS plugin runtime to ignore public page asset scripts, including route-local assets. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginReloadCountBeforeRouteVendorChange = pluginReloadAppRoots.length
      writeFile(fixture.routeVendorScriptFilePath, `module.exports = { boot() { return 'ignored' } }\n`)
      writeFile(fixture.routeMinifiedScriptFilePath, `module.exports={boot(){return'ignored'}}\n`)
      writeFile(fixture.routeUppercaseMinifiedScriptFilePath, `module.exports={boot(){return'ignored-uppercase'}}\n`)
      pluginProjectVersion = 'route-vendor-change'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length !== pluginReloadCountBeforeRouteVendorChange) {
        throw new Error(
          `Expected TS plugin runtime to ignore route-exposed vendor and minified scripts. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const originalHtmlToTextBundleText = fs.readFileSync(fixture.htmlToTextBundleFilePath, 'utf8')
      const pluginReloadCountBeforePrivateVendorChange = pluginReloadAppRoots.length
      writeFile(
        fixture.htmlToTextBundleFilePath,
        `${originalHtmlToTextBundleText}\nmodule.exports.__pluginTracked = true\n`
      )
      pluginProjectVersion = 'private-vendor-change'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforePrivateVendorChange) {
        throw new Error(
          `Expected TS plugin runtime to keep server-side _private vendor modules in the tracked app set. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const originalBoardServiceText = fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
      const pluginReloadCountBeforeServiceChange = pluginReloadAppRoots.length
      writeFile(
        fixture.boardServiceFilePath,
        `${originalBoardServiceText}\nmodule.exports.readMethod = function readMethod() { return 'ok' }\n`
      )
      pluginProjectVersion = '4'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeServiceChange) {
        throw new Error(
          `Expected TS plugin runtime to reload app-scoped caches after sibling file changes. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginReloadCountBeforeSchemaChange = pluginReloadAppRoots.length
      writeFile(fixture.schemaFilePath, `${fs.readFileSync(fixture.schemaFilePath, 'utf8')}\n`)
      pluginProjectVersion = '5'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeSchemaChange) {
        throw new Error(
          `Expected TS plugin runtime to keep root schema files in the tracked app set. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginKnownTrackedFilePath = path.join(
        fixture.appRoot,
        'pb_hooks',
        'pages',
        '_private',
        'plugin-known-service.js'
      )
      const pluginReloadCountBeforeKnownFile = pluginReloadAppRoots.length
      writeFile(pluginKnownTrackedFilePath, `module.exports = { known: true }\n`)
      pluginScriptFileNames.push(pluginKnownTrackedFilePath)
      pluginProjectVersion = '6'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeKnownFile) {
        throw new Error(
          `Expected TS plugin runtime to merge TS project file names into the tracked app set. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginReloadCountBeforeKnownDelete = pluginReloadAppRoots.length
      fs.rmSync(pluginKnownTrackedFilePath, { force: true })
      pluginScriptFileNames.splice(pluginScriptFileNames.indexOf(pluginKnownTrackedFilePath), 1)
      pluginProjectVersion = '7'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeKnownDelete) {
        throw new Error(
          `Expected TS plugin runtime to detect deleted files already present in the cached tracked app set. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginHiddenTrackedFilePath = path.join(
        fixture.appRoot,
        'pb_hooks',
        'pages',
        '_private',
        'plugin-hidden-service.js'
      )
      const pluginReloadCountBeforeHiddenFile = pluginReloadAppRoots.length
      const pluginReaddirCountBeforeHiddenFile = pluginPagesReaddirCount
      writeFile(pluginHiddenTrackedFilePath, `module.exports = { hidden: true }\n`)
      pluginProjectVersion = '8'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length !== pluginReloadCountBeforeHiddenFile) {
        throw new Error(
          `Expected TS plugin runtime to defer unknown new sibling files until the file-list scan window expires. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }
      if (pluginPagesReaddirCount !== pluginReaddirCountBeforeHiddenFile) {
        throw new Error(
          `Expected TS plugin runtime to avoid an immediate disk rescan for unknown new sibling files. Before=${pluginReaddirCountBeforeHiddenFile}, after=${pluginPagesReaddirCount}`
        )
      }

      pluginNow += 2500
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeHiddenFile) {
        throw new Error(
          `Expected TS plugin runtime to pick up unknown new sibling files after the file-list scan window expires without a project version bump. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }
      if (pluginPagesReaddirCount === pluginReaddirCountBeforeHiddenFile) {
        throw new Error('Expected TS plugin runtime to rescan the app file list after the scan window expires.')
      }

      const pluginWatchedTrackedFilePath = path.join(
        fixture.appRoot,
        'pb_hooks',
        'pages',
        '_private',
        'plugin-watched-service.js'
      )
      const pluginReloadCountBeforeWatchedCreate = pluginReloadAppRoots.length
      const pluginReaddirCountBeforeWatchedCreate = pluginPagesReaddirCount
      writeFile(pluginWatchedTrackedFilePath, `module.exports = { watched: true }\n`)
      if (triggerPluginFileWatch(pluginWatchedTrackedFilePath) === 0) {
        throw new Error('Expected TS plugin watcher test to trigger at least one directory watcher for a new _private module.')
      }
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeWatchedCreate) {
        throw new Error(
          `Expected TS plugin watcher dirty state to pick up a new sibling file without a project version bump. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }
      if (pluginPagesReaddirCount === pluginReaddirCountBeforeWatchedCreate) {
        throw new Error('Expected TS plugin watcher dirty state to force an app file-list rescan.')
      }

      const pluginReloadCountBeforeWatchedAsset = pluginReloadAppRoots.length
      const pluginReaddirCountBeforeWatchedAsset = pluginPagesReaddirCount
      writeFile(fixture.globalAssetFilePath, `console.log('reader watcher ignored')\n`)
      triggerPluginFileWatch(fixture.globalAssetFilePath)
      writeFile(fixture.nestedAssetScriptFilePath, `console.log('board widget watcher ignored')\n`)
      triggerPluginFileWatch(fixture.nestedAssetScriptFilePath)
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (
        pluginReloadAppRoots.length !== pluginReloadCountBeforeWatchedAsset ||
        pluginPagesReaddirCount !== pluginReaddirCountBeforeWatchedAsset
      ) {
        throw new Error(
          `Expected TS plugin watcher dirty state to ignore public page assets, including route-local assets. Got: ${JSON.stringify({
            reloadBefore: pluginReloadCountBeforeWatchedAsset,
            reloadAfter: pluginReloadAppRoots.length,
            readdirBefore: pluginReaddirCountBeforeWatchedAsset,
            readdirAfter: pluginPagesReaddirCount,
          })}`
        )
      }

      const pluginReloadCountBeforeWatchedDelete = pluginReloadAppRoots.length
      fs.rmSync(pluginWatchedTrackedFilePath, { force: true })
      if (triggerPluginFileWatch(pluginWatchedTrackedFilePath) === 0) {
        throw new Error('Expected TS plugin watcher test to trigger at least one directory watcher for a deleted _private module.')
      }
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (pluginReloadAppRoots.length === pluginReloadCountBeforeWatchedDelete) {
        throw new Error(
          `Expected TS plugin watcher dirty state to pick up a deleted sibling file without a project version bump. Got: ${JSON.stringify(pluginReloadAppRoots)}`
        )
      }

      const pluginLruFiles = []
      for (let index = 0; index < 42; index += 1) {
        const pluginLruFilePath = path.join(
          fixture.appRoot,
          'pb_hooks',
          'pages',
          '(site)',
          'plugin-lru',
          `page-${index}.ejs`
        )
        pluginLruFiles.push(pluginLruFilePath)
        writeFile(
          pluginLruFilePath,
          `<script server>\nconst pageIndex = ${index}\n</script>\n<div><%= pageIndex %></div>\n`
        )
        pluginProxy.getQuickInfoAtPosition(pluginLruFilePath, 0)
      }
      if (!pluginClosedUris.length) {
        throw new Error('Expected TS plugin runtime to prune visited EJS documents once the managed cache grows past the limit.')
      }
      const openPluginWatcherCountBeforeDispose = pluginDirectoryWatchers.filter((watcher) => !watcher.closed).length
      pluginProxy.dispose()
      if (openPluginWatcherCountBeforeDispose > 0 && pluginDirectoryWatchers.some((watcher) => !watcher.closed)) {
        throw new Error('Expected TS plugin runtime to close app directory watchers on dispose.')
      }
      if (!pluginBaseDisposed) {
        throw new Error('Expected TS plugin runtime dispose to delegate to the base language service dispose.')
      }
    } finally {
      fs.readdirSync = originalPluginReaddirSync
      Date.now = originalPluginDateNow
      PocketPagesLanguageCore.prototype.reloadCachesForAppRoot = originalPluginReloadCachesForAppRoot
      PocketPagesLanguageCore.prototype.closeDocument = originalPluginCloseDocument
      PocketPagesLanguageCore.prototype.updateDocument = originalPluginUpdateDocument
    }

    const boardShowExplanation = service.getCurrentRouteExplanation(
      fixture.boardShowFilePath,
      fs.readFileSync(fixture.boardShowFilePath, 'utf8')
    )
    if (
      !boardShowExplanation ||
      !boardShowExplanation.route ||
      boardShowExplanation.route.path !== '/boards/[boardSlug]' ||
      boardShowExplanation.route.method !== 'PAGE' ||
      !boardShowExplanation.params.includes('boardSlug')
    ) {
      throw new Error(`Expected Explain Current Route to describe dynamic PAGE routes. Got: ${JSON.stringify(boardShowExplanation)}`)
    }

    const feedbackPostExplanation = service.getCurrentRouteExplanation(
      fixture.feedbackPostFilePath,
      fs.readFileSync(fixture.feedbackPostFilePath, 'utf8')
    )
    if (
      !feedbackPostExplanation ||
      !feedbackPostExplanation.route ||
      feedbackPostExplanation.route.path !== '/feedback' ||
      feedbackPostExplanation.route.method !== 'POST' ||
      !feedbackPostExplanation.loaders.some((entry) => entry.fileName === '+post.js' && entry.method === 'POST')
    ) {
      throw new Error(`Expected Explain Current Route to describe method route files. Got: ${JSON.stringify(feedbackPostExplanation)}`)
    }

    const feedbackLoadExplanation = service.getCurrentRouteExplanation(
      fixture.feedbackLoadFilePath,
      fs.readFileSync(fixture.feedbackLoadFilePath, 'utf8')
    )
    if (
      !feedbackLoadExplanation ||
      feedbackLoadExplanation.sourceKind !== 'loader' ||
      !feedbackLoadExplanation.route ||
      feedbackLoadExplanation.route.path !== '/feedback' ||
      !feedbackLoadExplanation.loaders.some((entry) => entry.fileName === '+load.js')
    ) {
      throw new Error(`Expected Explain Current Route to describe loader files. Got: ${JSON.stringify(feedbackLoadExplanation)}`)
    }

    const flashAlertExplanation = service.getCurrentRouteExplanation(
      fixture.flashAlertFilePath,
      fs.readFileSync(fixture.flashAlertFilePath, 'utf8')
    )
    if (
      !flashAlertExplanation ||
      flashAlertExplanation.sourceKind !== 'private-partial' ||
      flashAlertExplanation.route !== null ||
      flashAlertExplanation.references.count < 1
    ) {
      throw new Error(`Expected Explain Current Route to summarize private partial callers. Got: ${JSON.stringify(flashAlertExplanation)}`)
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

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
