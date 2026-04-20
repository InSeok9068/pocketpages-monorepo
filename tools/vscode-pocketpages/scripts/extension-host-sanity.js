'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { URI } = require('vscode-uri')
const { REQUESTS } = require('../packages/language-server/protocol')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf8')
}

function normalizeFilePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^[A-Z]:/, (value) => value.toLowerCase())
}

function offsetToPosition(text, offset) {
  const sourceText = String(text || '')
  const clampedOffset = Math.max(0, Math.min(sourceText.length, Number(offset) || 0))
  let line = 0
  let character = 0

  for (let index = 0; index < clampedOffset; index += 1) {
    if (sourceText[index] === '\n') {
      line += 1
      character = 0
      continue
    }

    character += 1
  }

  return { line, character }
}

function positionToOffset(text, position) {
  const sourceText = String(text || '')
  const targetLine = Math.max(0, Number(position && position.line) || 0)
  const targetCharacter = Math.max(0, Number(position && position.character) || 0)
  let line = 0
  let character = 0

  for (let index = 0; index < sourceText.length; index += 1) {
    if (line === targetLine && character === targetCharacter) {
      return index
    }

    if (sourceText[index] === '\n') {
      line += 1
      character = 0
      if (line > targetLine) {
        return index + 1
      }
      continue
    }

    character += 1
  }

  return sourceText.length
}

function inferLanguageId(filePath) {
  if (String(filePath || '').endsWith('.ejs')) {
    return 'ejs'
  }

  if (/\.(js|cjs|mjs)$/i.test(String(filePath || ''))) {
    return 'javascript'
  }

  return 'plaintext'
}

function createMockDocument(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const documentUri = URI.file(filePath)

  return {
    uri: documentUri,
    languageId: inferLanguageId(filePath),
    version: 1,
    getText() {
      return sourceText
    },
    positionAt(offset) {
      const position = offsetToPosition(sourceText, offset)
      return new MockPosition(position.line, position.character)
    },
    offsetAt(position) {
      return positionToOffset(sourceText, position)
    },
  }
}

class MockPosition {
  constructor(line, character) {
    this.line = Number(line) || 0
    this.character = Number(character) || 0
  }
}

class MockRange {
  constructor(start, end) {
    this.start = start
    this.end = end
  }
}

class MockLocation {
  constructor(uri, range) {
    this.uri = uri
    this.range = range
  }
}

class MockWorkspaceEdit {
  constructor() {
    this.replacements = []
  }

  replace(uri, range, newText) {
    this.replacements.push({ uri, range, newText })
  }
}

class MockThemeColor {
  constructor(id) {
    this.id = id
  }
}

function createEventSource() {
  const listeners = []

  return {
    register(listener) {
      listeners.push(listener)
      return {
        dispose() {
          const listenerIndex = listeners.indexOf(listener)
          if (listenerIndex !== -1) {
            listeners.splice(listenerIndex, 1)
          }
        },
      }
    },
    async fire(event) {
      for (const listener of [...listeners]) {
        await listener(event)
      }
    },
    get size() {
      return listeners.length
    },
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function createExtensionHostFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketpages-extension-host-'))
  const workspaceRoot = path.join(fixtureRoot, 'apps', 'booklog')
  const routeFilePath = path.join(workspaceRoot, 'pb_hooks', 'pages', '(site)', 'index.ejs')
  const routeReferenceFilePath = path.join(workspaceRoot, 'pb_hooks', 'pages', '(site)', 'posts.ejs')
  const partialFilePath = path.join(workspaceRoot, 'pb_hooks', 'pages', '_private', 'flash-alert.ejs')
  const renameTargetFilePath = path.join(workspaceRoot, 'pb_hooks', 'pages', '(site)', 'dashboard.ejs')
  const renamedRouteFilePath = path.join(workspaceRoot, 'pb_hooks', 'pages', '(site)', 'dashboard-renamed.ejs')
  const hookScriptFilePath = path.join(workspaceRoot, 'pb_hooks', 'jobs', 'reindex.js')
  const unmanagedFilePath = path.join(fixtureRoot, 'scratch', 'notes.ejs')

  writeFile(path.join(workspaceRoot, 'pocketpages-globals.d.ts'), 'export {}\n')
  writeFile(
    routeFilePath,
    `<script server>
const pageTitle = 'Dashboard'
</script>
<section><%= pageTitle %></section>
`
  )
  writeFile(
    routeReferenceFilePath,
    `<script server>
const postsTitle = 'Posts'
</script>
<article><%= postsTitle %></article>
`
  )
  writeFile(partialFilePath, `<div class="flash-alert">Saved</div>\n`)
  writeFile(
    renameTargetFilePath,
    `<script server>
const renameLabel = 'Before'
</script>
<div><%= renameLabel %></div>
`
  )
  writeFile(
    hookScriptFilePath,
    `module.exports = function reindex() {
  return 'ok'
}
`
  )
  writeFile(unmanagedFilePath, '<div>Scratch</div>\n')

  return {
    fixtureRoot,
    workspaceRoot,
    routeFilePath,
    routeReferenceFilePath,
    partialFilePath,
    renameTargetFilePath,
    renamedRouteFilePath,
    hookScriptFilePath,
    unmanagedFilePath,
  }
}

function createMockExtensionHost({ repoRoot, fixture, languageClientOptions = {} }) {
  const extensionRoot = path.join(repoRoot, 'tools', 'vscode-pocketpages')
  const openDocumentEvents = createEventSource()
  const changeDocumentEvents = createEventSource()
  const closeDocumentEvents = createEventSource()
  const willSaveDocumentEvents = createEventSource()
  const didSaveDocumentEvents = createEventSource()
  const renameFilesEvents = createEventSource()
  const activeEditorEvents = createEventSource()
  const visibleEditorsEvents = createEventSource()

  const commandHandlers = new Map()
  const executedCommands = []
  const openTextDocumentCalls = []
  const applyEditCalls = []
  const warningMessages = []
  const informationMessages = []
  const errorMessages = []
  const outputLines = []
  const outputShows = []
  const fileWatchers = []
  const documentsByUri = new Map()
  const textDocuments = []
  const clientState = {
    instances: [],
    startCalls: 0,
    stopCalls: 0,
    requestCalls: [],
    notificationCalls: [],
  }

  function rememberDocument(document) {
    const documentUri = document.uri.toString()
    if (!documentsByUri.has(documentUri)) {
      documentsByUri.set(documentUri, document)
      textDocuments.push(document)
    }
    return documentsByUri.get(documentUri)
  }

  function getDocumentByFilePath(filePath) {
    const documentUri = URI.file(filePath).toString()
    let document = documentsByUri.get(documentUri)
    if (!document) {
      document = createMockDocument(filePath)
      rememberDocument(document)
    }
    return document
  }

  function createEditor(document, selectionPosition = new MockPosition(0, 0)) {
    return {
      document,
      selection: {
        active: selectionPosition,
      },
      decorationCalls: [],
      setDecorations(decoration, ranges) {
        this.decorationCalls.push({ decoration, ranges })
      },
    }
  }

  let activeTextEditor = null
  let visibleTextEditors = []

  function setActiveTextEditor(editor) {
    activeTextEditor = editor || null
    visibleTextEditors = editor ? [editor] : []
  }

  const vscode = {
    Uri: URI,
    Position: MockPosition,
    Range: MockRange,
    Location: MockLocation,
    WorkspaceEdit: MockWorkspaceEdit,
    ThemeColor: MockThemeColor,
    StatusBarAlignment: {
      Right: 2,
    },
    DecorationRangeBehavior: {
      ClosedClosed: 3,
    },
    OverviewRulerLane: {
      Right: 4,
    },
    TextDocumentSaveReason: {
      Manual: 1,
      AfterDelay: 2,
      FocusOut: 3,
    },
    workspace: {
      get textDocuments() {
        return textDocuments
      },
      asRelativePath(filePath) {
        const relativePath = path.relative(fixture.fixtureRoot, String(filePath || ''))
        return normalizeFilePath(relativePath || filePath)
      },
      createFileSystemWatcher(globPattern) {
        const watcher = {
          globPattern,
          disposed: false,
          dispose() {
            watcher.disposed = true
          },
        }
        fileWatchers.push(watcher)
        return watcher
      },
      async openTextDocument(uri) {
        const targetUri = uri instanceof URI ? uri : URI.parse(String(uri || ''))
        const targetPath = targetUri.fsPath
        openTextDocumentCalls.push(targetPath)
        return getDocumentByFilePath(targetPath)
      },
      async applyEdit(workspaceEdit) {
        applyEditCalls.push(workspaceEdit)
        return true
      },
      onDidOpenTextDocument(listener) {
        return openDocumentEvents.register(listener)
      },
      onDidChangeTextDocument(listener) {
        return changeDocumentEvents.register(listener)
      },
      onDidCloseTextDocument(listener) {
        return closeDocumentEvents.register(listener)
      },
      onWillSaveTextDocument(listener) {
        return willSaveDocumentEvents.register(listener)
      },
      onDidSaveTextDocument(listener) {
        return didSaveDocumentEvents.register(listener)
      },
      onDidRenameFiles(listener) {
        return renameFilesEvents.register(listener)
      },
    },
    window: {
      get activeTextEditor() {
        return activeTextEditor
      },
      get visibleTextEditors() {
        return visibleTextEditors
      },
      createOutputChannel(name) {
        return {
          name,
          appendLine(line) {
            outputLines.push(String(line))
          },
          show(preserveFocus) {
            outputShows.push(Boolean(preserveFocus))
          },
          dispose() {},
        }
      },
      createStatusBarItem() {
        return {
          text: '',
          tooltip: '',
          name: '',
          command: '',
          visible: false,
          show() {
            this.visible = true
          },
          hide() {
            this.visible = false
          },
          dispose() {},
        }
      },
      createTextEditorDecorationType(options) {
        return {
          options,
          dispose() {},
        }
      },
      async showWarningMessage(message) {
        warningMessages.push(String(message))
        return message
      },
      async showInformationMessage(message) {
        informationMessages.push(String(message))
        return message
      },
      async showErrorMessage(message) {
        errorMessages.push(String(message))
        return message
      },
      onDidChangeActiveTextEditor(listener) {
        return activeEditorEvents.register(listener)
      },
      onDidChangeVisibleTextEditors(listener) {
        return visibleEditorsEvents.register(listener)
      },
    },
    commands: {
      registerCommand(commandId, handler) {
        commandHandlers.set(commandId, handler)
        return {
          dispose() {
            commandHandlers.delete(commandId)
          },
        }
      },
      async executeCommand(commandId, ...args) {
        executedCommands.push({ commandId, args, registered: commandHandlers.has(commandId) })
        if (!commandHandlers.has(commandId)) {
          return undefined
        }

        return commandHandlers.get(commandId)(...args)
      },
    },
  }

  const languageClientModule = {
    TransportKind: {
      ipc: 1,
    },
    LanguageClient: class MockLanguageClient {
      constructor(id, name, serverOptions, clientOptions) {
        this.id = id
        this.name = name
        this.serverOptions = serverOptions
        this.clientOptions = clientOptions
        clientState.instances.push(this)
      }

      async start() {
        clientState.startCalls += 1
        if (typeof languageClientOptions.start === 'function') {
          return languageClientOptions.start(this, clientState)
        }
      }

      async stop() {
        clientState.stopCalls += 1
        if (typeof languageClientOptions.stop === 'function') {
          return languageClientOptions.stop(this, clientState)
        }
      }

      async sendRequest(method, params) {
        clientState.requestCalls.push({ method, params })
        if (typeof languageClientOptions.sendRequest === 'function') {
          return languageClientOptions.sendRequest(method, params, this, clientState)
        }
        return null
      }

      async sendNotification(method, params) {
        clientState.notificationCalls.push({ method, params })
        if (typeof languageClientOptions.sendNotification === 'function') {
          return languageClientOptions.sendNotification(method, params, this, clientState)
        }
      }
    },
  }

  const context = {
    subscriptions: [],
    asAbsolutePath(relativePath) {
      return path.join(extensionRoot, relativePath)
    },
  }

  return {
    context,
    mocks: {
      vscode,
      languageClientModule,
    },
    controls: {
      clientState,
      commandHandlers,
      executedCommands,
      openTextDocumentCalls,
      applyEditCalls,
      warningMessages,
      informationMessages,
      errorMessages,
      outputLines,
      outputShows,
      fileWatchers,
      getDocumentByFilePath,
      createEditor,
      setActiveTextEditor,
      async fireOpenDocument(document) {
        rememberDocument(document)
        await openDocumentEvents.fire(document)
      },
      async fireRenameFiles(event) {
        await renameFilesEvents.fire(event)
      },
      async fireActiveEditorChange(editor) {
        setActiveTextEditor(editor)
        await activeEditorEvents.fire(editor)
      },
      async executeCommand(commandId, ...args) {
        return vscode.commands.executeCommand(commandId, ...args)
      },
    },
  }
}

async function withMockedExtensionModule(repoRoot, mocks, callback) {
  const extensionModulePath = path.join(repoRoot, 'tools', 'vscode-pocketpages', 'packages', 'vscode-pocketpages', 'index.js')
  const originalLoad = Module._load
  delete require.cache[require.resolve(extensionModulePath)]

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return mocks.vscode
    }

    if (request === 'vscode-languageclient/node') {
      return mocks.languageClientModule
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const extensionModule = require(extensionModulePath)
    return await callback(extensionModule)
  } finally {
    Module._load = originalLoad
    delete require.cache[require.resolve(extensionModulePath)]
  }
}

async function runLifecycleExecutionTest(repoRoot, fixture) {
  const startDeferred = createDeferred()
  const harness = createMockExtensionHost({
    repoRoot,
    fixture,
    languageClientOptions: {
      start() {
        return startDeferred.promise
      },
      async sendRequest(method) {
        if (method === REQUESTS.refreshDiagnostics) {
          return null
        }
        return null
      },
    },
  })

  await withMockedExtensionModule(repoRoot, harness.mocks, async (extensionModule) => {
    const managedDocument = createMockDocument(fixture.routeFilePath)
    const managedEditor = harness.controls.createEditor(managedDocument, new MockPosition(2, 4))

    await extensionModule.activate(harness.context)
    if (harness.controls.clientState.startCalls !== 0) {
      throw new Error('Expected PocketPages activate() to keep the LSP stopped until a managed document is opened.')
    }

    await harness.controls.fireActiveEditorChange(managedEditor)
    await harness.controls.fireOpenDocument(managedDocument)
    await flushAsyncWork()
    if (harness.controls.clientState.startCalls !== 1) {
      throw new Error(
        `Expected lazy LSP startup to stay single-flight across repeated managed-document triggers. Got: ${harness.controls.clientState.startCalls}`
      )
    }

    startDeferred.resolve()
    await flushAsyncWork()

    await harness.controls.executeCommand('pocketpagesServerScript.refreshDiagnostics')
    if (harness.controls.clientState.startCalls !== 1) {
      throw new Error(
        `Expected PocketPages commands to reuse the active LSP client after bootstrap. Got: ${harness.controls.clientState.startCalls}`
      )
    }
    if (!harness.controls.clientState.requestCalls.some((entry) => entry.method === REQUESTS.refreshDiagnostics)) {
      throw new Error('Expected refreshDiagnostics command to reach the LSP after lazy bootstrap.')
    }

    await extensionModule.deactivate()
    if (harness.controls.clientState.stopCalls !== 1) {
      throw new Error(`Expected PocketPages deactivate() to stop the active LSP client once. Got: ${harness.controls.clientState.stopCalls}`)
    }
  })
}

async function runLifecycleRetryTest(repoRoot, fixture) {
  let startAttempt = 0
  const harness = createMockExtensionHost({
    repoRoot,
    fixture,
    languageClientOptions: {
      async start() {
        startAttempt += 1
        if (startAttempt === 1) {
          throw new Error('simulated startup failure')
        }
      },
    },
  })

  await withMockedExtensionModule(repoRoot, harness.mocks, async (extensionModule) => {
    const managedDocument = createMockDocument(fixture.routeFilePath)

    await extensionModule.activate(harness.context)
    await harness.controls.fireOpenDocument(managedDocument)
    await flushAsyncWork()

    if (harness.controls.clientState.startCalls !== 1) {
      throw new Error(`Expected the first managed-document trigger to attempt one LSP start. Got: ${harness.controls.clientState.startCalls}`)
    }
    if (!harness.controls.errorMessages.some((message) => message.includes('simulated startup failure'))) {
      throw new Error('Expected failed LSP startup to surface an extension-host error message.')
    }

    await harness.controls.fireOpenDocument(managedDocument)
    await flushAsyncWork()
    if (harness.controls.clientState.startCalls !== 2) {
      throw new Error(
        `Expected PocketPages to retry lazy LSP startup after a failed attempt. Got: ${harness.controls.clientState.startCalls}`
      )
    }

    await extensionModule.deactivate()
  })
}

async function runReferencesBoundaryTest(repoRoot, fixture) {
  const harness = createMockExtensionHost({
    repoRoot,
    fixture,
    languageClientOptions: {
      async sendRequest(method) {
        if (method === REQUESTS.allFileReferences) {
          return {
            referenceQuery: {
              kind: 'route-file',
              emptyMessage: 'No references found.',
            },
            references: [
              { filePath: fixture.routeReferenceFilePath, start: 0, end: 6 },
              { filePath: fixture.routeReferenceFilePath, start: 24, end: 34 },
              { filePath: fixture.partialFilePath, start: 0, end: 4 },
            ],
          }
        }
        return null
      },
    },
  })

  await withMockedExtensionModule(repoRoot, harness.mocks, async (extensionModule) => {
    const managedDocument = createMockDocument(fixture.routeFilePath)
    const managedEditor = harness.controls.createEditor(managedDocument, new MockPosition(3, 2))

    await extensionModule.activate(harness.context)
    await harness.controls.fireActiveEditorChange(managedEditor)
    await flushAsyncWork()
    await harness.controls.executeCommand('pocketpagesServerScript.allFileReferences')

    const showReferencesCall = harness.controls.executedCommands.find(
      (entry) => entry.commandId === 'editor.action.showReferences'
    )
    if (!showReferencesCall) {
      throw new Error('Expected allFileReferences command to forward resolved references into editor.action.showReferences.')
    }

    const [targetUri, anchorPosition, locations] = showReferencesCall.args
    if (normalizeFilePath(targetUri.fsPath) !== normalizeFilePath(fixture.routeFilePath)) {
      throw new Error(`Expected showReferences target to stay anchored on the active PocketPages file. Got: ${targetUri.fsPath}`)
    }
    if (anchorPosition.line !== 3 || anchorPosition.character !== 2) {
      throw new Error(`Expected showReferences anchor position to reuse the active editor selection. Got: ${JSON.stringify(anchorPosition)}`)
    }
    if (!Array.isArray(locations) || locations.length !== 3) {
      throw new Error(`Expected showReferences to receive resolved reference locations. Got: ${JSON.stringify(locations)}`)
    }

    const openedReferencePaths = harness.controls.openTextDocumentCalls.map(normalizeFilePath)
    const duplicateReferenceOpenCount = openedReferencePaths.filter(
      (filePath) => filePath === normalizeFilePath(fixture.routeReferenceFilePath)
    ).length
    if (duplicateReferenceOpenCount !== 1) {
      throw new Error(
        `Expected showFileReferences() to dedupe repeated target document opens. Got: ${JSON.stringify(openedReferencePaths)}`
      )
    }
  })
}

async function runRenameBoundaryTest(repoRoot, fixture) {
  const harness = createMockExtensionHost({
    repoRoot,
    fixture,
    languageClientOptions: {
      async sendRequest(method, params) {
        if (method === REQUESTS.fileRenameEdits) {
          return [
            {
              filePath: fixture.routeFilePath,
              start: 24,
              end: 33,
              newText: 'Dashboard Renamed',
            },
            {
              filePath: fixture.routeFilePath,
              start: 54,
              end: 63,
              newText: 'dashboard-renamed',
            },
          ]
        }

        if (method === REQUESTS.refreshDiagnostics) {
          return null
        }

        throw new Error(`Unexpected request during rename boundary test: ${method} ${JSON.stringify(params)}`)
      },
    },
  })

  await withMockedExtensionModule(repoRoot, harness.mocks, async (extensionModule) => {
    const managedDocument = createMockDocument(fixture.routeFilePath)

    await extensionModule.activate(harness.context)
    await harness.controls.fireOpenDocument(managedDocument)
    await flushAsyncWork()

    await harness.controls.fireRenameFiles({
      files: [
        {
          oldUri: URI.file(fixture.renameTargetFilePath),
          newUri: URI.file(fixture.renamedRouteFilePath),
        },
      ],
    })

    const renameRequests = harness.controls.clientState.requestCalls.filter(
      (entry) => entry.method === REQUESTS.fileRenameEdits
    )
    if (renameRequests.length !== 1) {
      throw new Error(`Expected one managed fileRenameEdits request. Got: ${JSON.stringify(renameRequests)}`)
    }
    if (renameRequests[0].params.oldUri !== URI.file(fixture.renameTargetFilePath).toString()) {
      throw new Error(`Expected rename oldUri to match the managed PocketPages file. Got: ${renameRequests[0].params.oldUri}`)
    }
    if (renameRequests[0].params.newUri !== URI.file(fixture.renamedRouteFilePath).toString()) {
      throw new Error(`Expected rename newUri to match the new PocketPages file. Got: ${renameRequests[0].params.newUri}`)
    }

    if (harness.controls.applyEditCalls.length !== 1) {
      throw new Error(`Expected applyManagedFileRenameEdits() to apply one workspace edit. Got: ${harness.controls.applyEditCalls.length}`)
    }

    const appliedWorkspaceEdit = harness.controls.applyEditCalls[0]
    if (!appliedWorkspaceEdit || appliedWorkspaceEdit.replacements.length !== 2) {
      throw new Error(
        `Expected applyManagedFileRenameEdits() to translate rename specs into two document replacements. Got: ${JSON.stringify(appliedWorkspaceEdit)}`
      )
    }

    const openedRenameTargets = harness.controls.openTextDocumentCalls.map(normalizeFilePath)
    const openedRouteDocumentCount = openedRenameTargets.filter(
      (filePath) => filePath === normalizeFilePath(fixture.routeFilePath)
    ).length
    if (openedRouteDocumentCount !== 1) {
      throw new Error(
        `Expected applyManagedFileRenameEdits() to cache opened edit documents per target file. Got: ${JSON.stringify(openedRenameTargets)}`
      )
    }

    await harness.controls.fireRenameFiles({
      files: [
        {
          oldUri: URI.file(fixture.unmanagedFilePath),
          newUri: URI.file(path.join(path.dirname(fixture.unmanagedFilePath), 'notes-renamed.ejs')),
        },
      ],
    })

    const renameRequestCountAfterUnmanagedRename = harness.controls.clientState.requestCalls.filter(
      (entry) => entry.method === REQUESTS.fileRenameEdits
    ).length
    if (renameRequestCountAfterUnmanagedRename !== 1) {
      throw new Error('Expected unmanaged rename targets to bypass PocketPages fileRenameEdits requests.')
    }
  })
}

async function runExtensionHostSanityCheck(repoRoot) {
  const fixture = createExtensionHostFixture()

  try {
    await runLifecycleExecutionTest(repoRoot, fixture)
    await runLifecycleRetryTest(repoRoot, fixture)
    await runReferencesBoundaryTest(repoRoot, fixture)
    await runRenameBoundaryTest(repoRoot, fixture)
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
}

module.exports = {
  runExtensionHostSanityCheck,
}
