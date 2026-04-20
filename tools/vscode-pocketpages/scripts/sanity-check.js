'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { URI } = require('vscode-uri')
const { PocketPagesLanguageServiceManager, ts } = require('../packages/language-service/language-service')
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
const initTypeScriptPlugin = require('../packages/typescript-plugin')
const {
  buildScriptServerMirrorText,
  collectExternalPocketPagesEjsFiles,
  isPocketPagesEjsFile,
} = require('../packages/typescript-plugin/shared')
const { getTokenTypeIndex } = require('../packages/language-server/ejs-semantic-tokens')
const { runExtensionHostSanityCheck } = require('./extension-host-sanity')

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
    SCRIPT_DIAGNOSTICS_DEBOUNCE_MS: 10,
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
    getDocumentByUri(uri) {
      return documentEntries.get(uri) || null
    },
    getDocumentContextByUri(uri) {
      return core.getDocumentContextByUri(uri)
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
      connection: extra.connection || {
        sendDiagnostics() {},
      },
      state: extra.state || {
        diagnosticTimeouts: new Map(),
      },
    },
    helpers,
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
    /isManagedRenameTargetPath\(entry\.oldUri\.fsPath\)/,
    'Expected the PocketPages client to request rename edits for managed PocketPages targets, including assets.'
  )
  if (clientSource.includes('hasPrivatePagesSegment(entry.oldUri.fsPath)')) {
    throw new Error('Expected the PocketPages client to stop limiting file rename edits to _private files only.')
  }
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
    /const clientOptions = \{\s*documentSelector: LSP_DOCUMENT_SELECTOR,\s*outputChannel,(?:\s*synchronize:\s*\{[\s\S]*?\},)?\s*\}/,
    'Expected client.js to route LSP logs through the shared PocketPages output channel.'
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
    /connection\.onDocumentSymbol\(\(params\) => \{\s*return structureFeatureService\.provideDocumentSymbols\(params\);\s*\}\);/,
    'Expected server.js to route document symbols through structure-features.'
  )
  assertMatches(
    serverSource,
    /connection\.onWorkspaceSymbol\(\(params\) => \{\s*return structureFeatureService\.provideWorkspaceSymbols\(params\);\s*\}\);/,
    'Expected server.js to route workspace symbols through structure-features.'
  )
  assertMatches(
    serverSource,
    /const pathTargetInfo = customFeatureService\.provideHover\(params\)/,
    'Expected server.js hover path to query PocketPages custom hover first.'
  )
  assertMatches(
    serverSource,
    /if \(!isEjsFilePath\(documentContext\.filePath\)\) \{\s*return null;\s*\}/,
    'Expected server.js hover path to avoid generic JS hover duplication outside EJS.'
  )
  assertMatches(
    serverSource,
    /const quickInfo = typeScriptFeatureService\.provideHover\(params\)/,
    'Expected server.js to keep EJS TS quick info ownership in the LSP until TS plugin parity is achieved.'
  )
  assertMatches(
    serverSource,
    /const customTarget = customFeatureService\.provideDefinition\(params\);[\s\S]*if \(customTarget\) \{[\s\S]*return toLocation\(customTarget\);[\s\S]*\}[\s\S]*return toLocation\(typeScriptFeatureService\.provideDefinition\(params\)\);/,
    'Expected server.js definition ownership to check PocketPages custom targets before TS definition fallback.'
  )
  assertMatches(
    serverSource,
    /const customResult = customFeatureService\.provideCompletionItems\(params\)/,
    'Expected server.js completion path to preserve custom PocketPages completions before TS completions.'
  )
  assertMatches(
    customFeatureSource,
    /entry\.kind === "asset-path"\s*\?\s*`Open asset target: \$\{entry\.value\}`/,
    'Expected custom document link tooltips to label asset() targets correctly.'
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
    lifecycleFeatureSource,
    /function shouldRunDiagnosticsForFile\(filePath\) \{[\s\S]*!isExcludedPocketPagesScriptPath\(filePath\)/,
    'Expected lifecycle-features.js to suppress diagnostics for excluded PocketPages vendor and minified scripts.'
  )
  assertMatches(
    tsPluginSource,
    /core\.isFeatureEnabledAtOffset\(\s*documentContext\.uri,\s*position,\s*capabilityName\s*\)/,
    'Expected PocketPages TS plugin to respect mapper ownership before serving TS features for .ejs.'
  )
  assertMatches(
    tsPluginSource,
    /core\.reloadCachesForAppRoot\(appRoot\)/,
    'Expected PocketPages TS plugin to invalidate app-scoped caches when sibling project files change.'
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
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'vendor', 'jszip-3.10.1.min.js'), `window.JSZip = {}\n`)
  writeFile(path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'card.css'), `.board-card { color: #222; }\n`)
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
<button hx-delete="/feedback"></button>
<button hx-put="/feedback"></button>
<button hx-patch="/feedback"></button>
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
    path.join(appRoot, 'pb_hooks', 'jobs', 'rebuild-search.js'),
    `const boards = $app.findRecordsByFilter('boards')
const board = $app.findFirstRecordByFilter('boards', 'id != ""')

module.exports = {
  boards,
  board,
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

  return {
    fixtureRoot,
    appRoot,
    secondaryAppRoot,
    schemaFilePath: path.join(appRoot, 'pb_schema.json'),
    siteIndexFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs'),
    boardsFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'index.ejs'),
    boardShowFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'index.ejs'),
    localsTypeCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'locals-type-check.ejs'),
    overrideCardCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'override-card-check.ejs'),
    resolveParentCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'resolve-parent-check.ejs'),
    optionalNoticeAFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-a.ejs'),
    optionalNoticeBFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'optional-notice-b.ejs'),
    routeReferenceCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-reference-check.ejs'),
    routeMethodReferenceCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'route-method-reference-check.ejs'),
    globalAssetFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'booklog-reader.js'),
    vendorAssetFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'assets', 'vendor', 'jszip-3.10.1.min.js'),
    localAssetFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'card.css'),
    propertyLocalsCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', '[boardSlug]', 'property-locals-check.ejs'),
    renameCheckFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'rename-check.ejs'),
    middlewareFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'api', '+middleware.js'),
    mjsConsumerFilePath: path.join(appRoot, 'pb_hooks', 'pages', 'api', 'mjs-consumer.mjs'),
    jobScriptFilePath: path.join(appRoot, 'pb_hooks', 'jobs', 'rebuild-search.js'),
    boardServiceFilePath: path.join(appRoot, 'pb_hooks', 'pages', '_private', 'board-service.js'),
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
    routeMinifiedScriptFilePath: path.join(appRoot, 'pb_hooks', 'pages', '(site)', 'boards', 'legacy.min.js'),
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
    if (!embeddedLinkedCodeMap || !embeddedLinkedCodeMap.has('server:0')) {
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
      languageId: 'ejs',
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

    const diagnosticsEvents = []
    const diagnosticsSmokeCore = new PocketPagesLanguageCore()
    const diagnosticsSmokeText = `<script server>\nresolve('/_private/board-service')\n</script>\n<div>ok</div>\n`
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
      new Map([[diagnosticsSmokeUri, diagnosticsSmokeDocument]]),
      {
        connection: {
          sendDiagnostics(payload) {
            diagnosticsEvents.push(payload)
          },
        },
      }
    )
    const diagnosticsFeatureService = createDiagnosticsFeatureService(diagnosticsSmokeContext.context)
    diagnosticsFeatureService.publishDiagnostics(diagnosticsSmokeUri)
    if (!diagnosticsEvents.length || !Array.isArray(diagnosticsEvents[0].diagnostics) || diagnosticsEvents[0].diagnostics.length === 0) {
      throw new Error(`Expected diagnostics feature service to publish mapper-filtered diagnostics. Got: ${JSON.stringify(diagnosticsEvents)}`)
    }
    if (
      !diagnosticsEvents[0].diagnostics.some((entry) =>
        ['pp-private-resolve-path', 'pp-resolve-private-prefix'].includes(String(entry.code))
      )
    ) {
      throw new Error(`Expected diagnostics feature service to keep resolve() path diagnostics reportable. Got: ${JSON.stringify(diagnosticsEvents[0].diagnostics)}`)
    }

    const schemaOnlyDiagnosticsEvents = []
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
      new Map([[schemaOnlyDiagnosticsUri, schemaOnlyDiagnosticsDocument]]),
      {
        connection: {
          sendDiagnostics(payload) {
            schemaOnlyDiagnosticsEvents.push(payload)
          },
        },
      }
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
    try {
      schemaOnlyDiagnosticsFeatureService.publishDiagnostics(schemaOnlyDiagnosticsUri)
    } finally {
      schemaOnlyService.getDiagnostics = originalSchemaOnlyGetDiagnostics
    }
    if (!schemaOnlyDiagnosticsEvents.length || !Array.isArray(schemaOnlyDiagnosticsEvents[0].diagnostics)) {
      throw new Error(
        `Expected schema-support-only hook diagnostics publish event. Got: ${JSON.stringify(schemaOnlyDiagnosticsEvents)}`
      )
    }
    if (
      schemaOnlyDiagnosticsEvents[0].diagnostics.some(
        (entry) =>
          String(entry.code) !== 'pp-schema-collection' &&
          String(entry.code) !== 'pp-schema-field'
      )
    ) {
      throw new Error(
        `Expected schema-support-only hook diagnostics publishing to drop non-schema entries. Got: ${JSON.stringify(schemaOnlyDiagnosticsEvents[0].diagnostics)}`
      )
    }
    if (!schemaOnlyDiagnosticsEvents[0].diagnostics.some((entry) => String(entry.code) === 'pp-schema-collection')) {
      throw new Error(
        `Expected schema-support-only hook diagnostics publishing to keep collection diagnostics. Got: ${JSON.stringify(schemaOnlyDiagnosticsEvents[0].diagnostics)}`
      )
    }

    const excludedVendorDiagnosticsEvents = []
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
      new Map([[excludedVendorDiagnosticsUri, excludedVendorDiagnosticsDocument]]),
      {
        connection: {
          sendDiagnostics(payload) {
            excludedVendorDiagnosticsEvents.push(payload)
          },
        },
      }
    )
    excludedVendorDiagnosticsContext.context.helpers.isExcludedPocketPagesScriptPath = (filePath) =>
      normalizeFilePath(filePath) === normalizeFilePath(fixture.vendorAssetFilePath)
    const excludedVendorDiagnosticsFeatureService = createDiagnosticsFeatureService(
      excludedVendorDiagnosticsContext.context
    )
    excludedVendorDiagnosticsFeatureService.publishDiagnostics(excludedVendorDiagnosticsUri)
    if (
      !excludedVendorDiagnosticsEvents.length ||
      !Array.isArray(excludedVendorDiagnosticsEvents[0].diagnostics) ||
      excludedVendorDiagnosticsEvents[0].diagnostics.length !== 0
    ) {
      throw new Error(
        `Expected excluded PocketPages vendor scripts to publish empty diagnostics. Got: ${JSON.stringify(excludedVendorDiagnosticsEvents)}`
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
        publishDiagnostics() {},
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

    const lifecycleOpenPublishCalls = []
    const lifecycleScheduledUris = []
    const lifecycleCancelledUris = []
    const lifecycleClearedCompletionUris = []
    const lifecycleSentDiagnostics = []
    const lifecycleWatchedChanges = []
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
      connection: {
        sendDiagnostics(payload) {
          lifecycleSentDiagnostics.push(payload)
        },
      },
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
        cancelScheduledDiagnostics(uri) {
          lifecycleCancelledUris.push(uri)
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
        publishDiagnostics(uri) {
          lifecycleOpenPublishCalls.push(uri)
        },
        scheduleDiagnostics(uri) {
          lifecycleScheduledUris.push(uri)
        },
        uriToFilePath(uri) {
          return URI.parse(uri).fsPath
        },
      },
    })
    lifecycleFeatureService.handleDidOpen({ document: lifecycleBoardsDocument })
    lifecycleFeatureService.handleDidOpen({ document: lifecycleVendorDocument })
    if (lifecycleCoreCalls.open.length !== 2) {
      throw new Error(`Expected lifecycle open to forward both documents to core. Got: ${JSON.stringify(lifecycleCoreCalls.open)}`)
    }
    if (!lifecycleOpenPublishCalls.includes(lifecycleBoardsUri)) {
      throw new Error(`Expected lifecycle open to publish diagnostics for regular EJS documents. Got: ${JSON.stringify(lifecycleOpenPublishCalls)}`)
    }
    if (
      !lifecycleSentDiagnostics.some(
        (entry) => entry.uri === lifecycleVendorDocument.uri && Array.isArray(entry.diagnostics) && entry.diagnostics.length === 0
      )
    ) {
      throw new Error(`Expected lifecycle open to publish empty diagnostics for excluded vendor scripts. Got: ${JSON.stringify(lifecycleSentDiagnostics)}`)
    }
    lifecycleFeatureService.handleDidChangeContent({
      document: lifecycleBoardsDocument,
      contentChanges: [{ text: 'meta(\'description\')' }],
    })
    lifecycleFeatureService.handleDidChangeContent({
      document: lifecycleVendorDocument,
      contentChanges: [{ text: 'window.JSZip = { loaded: true }' }],
    })
    if (
      lifecycleCoreCalls.update.length !== 2 ||
      !lifecycleClearedCompletionUris.includes(lifecycleBoardsUri) ||
      !lifecycleClearedCompletionUris.includes(lifecycleVendorDocument.uri)
    ) {
      throw new Error(
        `Expected lifecycle change handling to update core state and clear completion caches for both document kinds. Got updates=${JSON.stringify(lifecycleCoreCalls.update)} cleared=${JSON.stringify(lifecycleClearedCompletionUris)}`
      )
    }
    if (!lifecycleScheduledUris.includes(lifecycleBoardsUri)) {
      throw new Error(`Expected lifecycle change to schedule diagnostics for regular documents. Got: ${JSON.stringify(lifecycleScheduledUris)}`)
    }
    lifecycleFeatureService.handleDidManualSave({ uri: lifecycleBoardsUri })
    if (lifecycleOpenPublishCalls.filter((uri) => uri === lifecycleBoardsUri).length < 2) {
      throw new Error(`Expected manual save to republish diagnostics for the requested document. Got: ${JSON.stringify(lifecycleOpenPublishCalls)}`)
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
    lifecycleFeatureService.handleDidClose({ document: lifecycleBoardsDocument })
    if (
      lifecycleCoreCalls.close.length !== 1 ||
      lifecycleCoreCalls.close[0] !== lifecycleBoardsUri ||
      !lifecycleCancelledUris.includes(lifecycleBoardsUri)
    ) {
      throw new Error(`Expected lifecycle close to clear state, cancel diagnostics, and close the core document. Got: ${JSON.stringify({ close: lifecycleCoreCalls.close, cancelled: lifecycleCancelledUris })}`)
    }

    const maintenanceProbeCalls = []
    const maintenanceRefreshUris = []
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
      },
      helpers: {
        clearCachedCompletionItemsForUri() {},
        elapsedMilliseconds() {
          return 0
        },
        getRelativePathLabel(filePath) {
          return normalizeFilePath(filePath)
        },
        logServer() {},
        publishDiagnostics(uri) {
          maintenanceRefreshUris.push(uri)
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
    const maintenanceRefreshResult = maintenanceFeatureServiceFull.provideRefreshDiagnostics({ uri: lifecycleBoardsUri })
    if (!maintenanceRefreshResult.ok || !maintenanceRefreshUris.includes(lifecycleBoardsUri)) {
      throw new Error(`Expected maintenance refreshDiagnostics to republish diagnostics for the requested URI. Got: ${JSON.stringify({ maintenanceRefreshResult, maintenanceRefreshUris })}`)
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
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.routeVendorScriptFilePath))) {
      throw new Error(`Expected pages code index to exclude route-exposed vendor scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (indexedCodeFilePaths.includes(normalizeFilePath(fixture.routeMinifiedScriptFilePath))) {
      throw new Error(`Expected pages code index to exclude route-exposed minified scripts. Got: ${indexedCodeFilePaths.join(', ')}`)
    }
    if (!indexedCodeFilePaths.includes(normalizeFilePath(fixture.htmlToTextBundleFilePath))) {
      throw new Error(`Expected pages code index to keep _private vendor modules. Got: ${indexedCodeFilePaths.join(', ')}`)
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

    const includePathTargetInfo = service.getPathTargetInfo(
      fixture.boardsFilePath,
      `<%- include('flash-alert.ejs') %>\n`,
      `<%- include('flash-alert.ejs') %>\n`.indexOf('flash-alert.ejs') + 2
    )
    if (!includePathTargetInfo || normalizeFilePath(includePathTargetInfo.targetFilePath) !== normalizeFilePath(fixture.flashAlertFilePath)) {
      throw new Error(`Expected include() path target info. Got: ${JSON.stringify(includePathTargetInfo)}`)
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
    service.clearDocumentOverride(fixture.routeReferenceCheckFilePath)

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
    const assetReferenceCallerText = `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>
<link rel="stylesheet" href="<%= asset('card.css') %>">
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
    if (globalAssetCallerMatches.length !== 1) {
      throw new Error(`Expected one asset() caller for the global asset file. Got: ${JSON.stringify(globalAssetReferences)}`)
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
    if (globalAssetCallerEdits.length !== 1) {
      throw new Error(`Expected one caller rewrite for the renamed global asset file. Got: ${JSON.stringify(globalAssetRenameEdits)}`)
    }
    const globalAssetRenamedText = applyEditsToText(assetReferenceCallerText, globalAssetCallerEdits)
    if (!globalAssetRenamedText.includes("asset('/assets/reader-client.js')")) {
      throw new Error(`Expected global asset() caller to rewrite to /assets/reader-client.js. Got: ${globalAssetRenamedText}`)
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
    if (feedbackPostCallerMatches.length !== 2) {
      throw new Error(`Expected action + hx-post references for feedback POST route. Got: ${JSON.stringify(feedbackPostReferences)}`)
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
      `<script src="<%= asset('/assets/booklog-reader.js') %>"></script>\n<link rel="stylesheet" href="<%= asset('card.css') %>">\n`
    )
    const assetDocumentLinkTargets = assetDocumentLinks.map((entry) => entry.targetFilePath)
    if (!assetDocumentLinkTargets.some((target) => normalizeFilePath(target) === normalizeFilePath(fixture.globalAssetFilePath))) {
      throw new Error(`Expected asset() document link target for global asset. Got: ${assetDocumentLinkTargets.join(', ')}`)
    }
    if (!assetDocumentLinkTargets.some((target) => normalizeFilePath(target) === normalizeFilePath(fixture.localAssetFilePath))) {
      throw new Error(`Expected asset() document link target for local asset. Got: ${assetDocumentLinkTargets.join(', ')}`)
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
    if (routeMethodDocumentLinkTargets.filter((target) => target === normalizeFilePath(fixture.feedbackPostFilePath)).length !== 2) {
      throw new Error(`Expected action and hx-post to target feedback POST route. Got: ${routeMethodDocumentLinkTargets.join(', ')}`)
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

    const pluginExternalFiles = collectExternalPocketPagesEjsFiles(
      {
        sys: {
          readDirectory(rootPath) {
            if (normalizeFilePath(rootPath) !== normalizeFilePath(fixture.appRoot)) {
              return []
            }

            return [fixture.signInFilePath, fixture.flashAlertFilePath]
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

    const pluginRuntimeFactory = initTypeScriptPlugin({ typescript: ts })
    let pluginProjectVersion = '1'
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
    }
    const pluginHost = {
      getScriptSnapshot(fileName) {
        if (!fs.existsSync(fileName)) {
          return undefined
        }
        return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'))
      },
      getScriptVersion() {
        return ''
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
    }
    const originalPluginReloadCachesForAppRoot = PocketPagesLanguageCore.prototype.reloadCachesForAppRoot
    const originalPluginCloseDocument = PocketPagesLanguageCore.prototype.closeDocument
    const pluginReloadAppRoots = []
    const pluginClosedUris = []
    PocketPagesLanguageCore.prototype.reloadCachesForAppRoot = function patchedReloadCachesForAppRoot(appRoot) {
      pluginReloadAppRoots.push(normalizeFilePath(appRoot))
      return originalPluginReloadCachesForAppRoot.call(this, appRoot)
    }
    PocketPagesLanguageCore.prototype.closeDocument = function patchedCloseDocument(uri) {
      pluginClosedUris.push(uri)
      return originalPluginCloseDocument.call(this, uri)
    }
    try {
      const pluginProxy = pluginRuntimeFactory.create({
        languageServiceHost: pluginHost,
        languageService: pluginBaseLanguageService,
        project: pluginProject,
      })
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      const originalBoardServiceText = fs.readFileSync(fixture.boardServiceFilePath, 'utf8')
      writeFile(
        fixture.boardServiceFilePath,
        `${originalBoardServiceText}\nmodule.exports.readMethod = function readMethod() { return 'ok' }\n`
      )
      pluginProjectVersion = '2'
      pluginProxy.getQuickInfoAtPosition(fixture.signInFilePath, 0)
      if (!pluginReloadAppRoots.includes(normalizeFilePath(fixture.appRoot))) {
        throw new Error(
          `Expected TS plugin runtime to reload app-scoped caches after sibling file changes. Got: ${JSON.stringify(pluginReloadAppRoots)}`
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
    } finally {
      PocketPagesLanguageCore.prototype.reloadCachesForAppRoot = originalPluginReloadCachesForAppRoot
      PocketPagesLanguageCore.prototype.closeDocument = originalPluginCloseDocument
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
