'use strict'

const vscode = require('vscode')
const { PocketPagesLanguageServiceManager, findAppRoot, ts } = require('./language-service')
const { TOKEN_TYPES, collectEjsSemanticTokenEntries, getTokenTypeIndex } = require('./ejs-semantic-tokens')

const EJS_DOCUMENT_SELECTOR = [
  { scheme: 'file', pattern: '**/*.ejs' },
  { scheme: 'untitled', pattern: '**/*.ejs' },
]
const SCRIPT_DOCUMENT_SELECTOR = [
  { scheme: 'file', pattern: '**/pb_hooks/pages/**/*.js' },
  { scheme: 'file', pattern: '**/pb_hooks/pages/**/*.cjs' },
  { scheme: 'file', pattern: '**/pb_hooks/pages/**/*.mjs' },
]
const CODE_DOCUMENT_SELECTOR = [...EJS_DOCUMENT_SELECTOR, ...SCRIPT_DOCUMENT_SELECTOR]
const RENAME_DOCUMENT_SELECTOR = [
  ...EJS_DOCUMENT_SELECTOR,
  ...SCRIPT_DOCUMENT_SELECTOR,
]
const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, [])

const COMPLETION_KIND_MAP = {
  [ts.ScriptElementKind.primitiveType]: vscode.CompletionItemKind.Keyword,
  [ts.ScriptElementKind.keyword]: vscode.CompletionItemKind.Keyword,
  [ts.ScriptElementKind.constElement]: vscode.CompletionItemKind.Constant,
  [ts.ScriptElementKind.letElement]: vscode.CompletionItemKind.Variable,
  [ts.ScriptElementKind.variableElement]: vscode.CompletionItemKind.Variable,
  [ts.ScriptElementKind.localVariableElement]: vscode.CompletionItemKind.Variable,
  [ts.ScriptElementKind.alias]: vscode.CompletionItemKind.Reference,
  [ts.ScriptElementKind.memberVariableElement]: vscode.CompletionItemKind.Field,
  [ts.ScriptElementKind.memberGetAccessorElement]: vscode.CompletionItemKind.Field,
  [ts.ScriptElementKind.memberSetAccessorElement]: vscode.CompletionItemKind.Field,
  [ts.ScriptElementKind.functionElement]: vscode.CompletionItemKind.Function,
  [ts.ScriptElementKind.localFunctionElement]: vscode.CompletionItemKind.Function,
  [ts.ScriptElementKind.memberFunctionElement]: vscode.CompletionItemKind.Method,
  [ts.ScriptElementKind.constructSignatureElement]: vscode.CompletionItemKind.Constructor,
  [ts.ScriptElementKind.callSignatureElement]: vscode.CompletionItemKind.Function,
  [ts.ScriptElementKind.indexSignatureElement]: vscode.CompletionItemKind.Property,
  [ts.ScriptElementKind.enumElement]: vscode.CompletionItemKind.Enum,
  [ts.ScriptElementKind.moduleElement]: vscode.CompletionItemKind.Module,
  [ts.ScriptElementKind.classElement]: vscode.CompletionItemKind.Class,
  [ts.ScriptElementKind.interfaceElement]: vscode.CompletionItemKind.Interface,
  [ts.ScriptElementKind.warning]: vscode.CompletionItemKind.Text,
}

function toRange(document, start, end) {
  return new vscode.Range(document.positionAt(start), document.positionAt(end))
}

function toDefinitionLocation(target) {
  if (!target) {
    return null
  }

  if (typeof target === 'string') {
    return new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0))
  }

  return new vscode.Location(
    vscode.Uri.file(target.filePath),
    new vscode.Position(target.line || 0, target.character || 0)
  )
}

function toReferenceLocation(document, reference) {
  return new vscode.Location(document.uri, toRange(document, reference.start, reference.end))
}

function workspaceRelativePath(filePath) {
  return vscode.workspace.asRelativePath(filePath, false)
}

function describeReferenceQuery(referenceQuery) {
  if (!referenceQuery) {
    return 'references'
  }

  if (referenceQuery.kind === 'include-path') {
    return 'include references'
  }

  if (referenceQuery.kind === 'resolve-path') {
    return 'resolve references'
  }

  if (referenceQuery.kind === 'route-path') {
    return referenceQuery.routePath ? `route references for ${referenceQuery.routePath}` : 'route references'
  }

  if (referenceQuery.kind === 'private-module') {
    return 'resolve() and require() references'
  }

  if (referenceQuery.kind === 'private-partial') {
    return 'include() references'
  }

  if (referenceQuery.kind === 'route-file') {
    return referenceQuery.routePath ? `route references for ${referenceQuery.routePath}` : 'route references'
  }

  return 'references'
}

async function showFileReferences({ manager, output, document, editor, filePath }) {
  const service = manager.getServiceForFile(filePath)
  if (!service) {
    vscode.window.showWarningMessage('Current file is not inside a PocketPages app root.')
    return
  }

  const referenceQuery = service.getFileReferenceQuery(filePath)
  if (!referenceQuery) {
    vscode.window.showWarningMessage(
      'This file is not a supported PocketPages target. Use a _private partial, a _private module, or a static route file.'
    )
    return
  }

  const effectiveDocument =
    document && document.uri.fsPath === filePath ? document : await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
  const references = service.getFileReferenceTargets(filePath, effectiveDocument.getText(), {
    includeDeclaration: false,
  })

  output.appendLine(
    `showFileReferences: kind=${referenceQuery.kind} path=${filePath} refs=${references ? references.length : 0}`
  )

  if (!references || !references.length) {
    vscode.window.showInformationMessage(referenceQuery.emptyMessage || `No ${describeReferenceQuery(referenceQuery)} found.`)
    return
  }

  const uniqueFilePaths = [...new Set(references.map((entry) => entry.filePath))]
  const referenceDocuments = await Promise.all(
    uniqueFilePaths.map(async (referenceFilePath) => [
      referenceFilePath,
      await vscode.workspace.openTextDocument(vscode.Uri.file(referenceFilePath)),
    ])
  )
  const documentMap = new Map(referenceDocuments)
  const locations = references
    .map((reference) => {
      const referenceDocument = documentMap.get(reference.filePath)
      if (!referenceDocument) {
        return null
      }

      return toReferenceLocation(referenceDocument, reference)
    })
    .filter(Boolean)

  if (!locations.length) {
    vscode.window.showInformationMessage('Found references, but failed to open the target files.')
    return
  }

  const activeEditor =
    editor && editor.document.uri.fsPath === filePath
      ? editor
      : vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.fsPath === filePath)
  const anchorPosition = activeEditor ? activeEditor.selection.active : new vscode.Position(0, 0)

  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    effectiveDocument.uri,
    anchorPosition,
    locations
  )
}

function diagnosticSeverity(category) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return vscode.DiagnosticSeverity.Error
    case ts.DiagnosticCategory.Warning:
      return vscode.DiagnosticSeverity.Warning
    case ts.DiagnosticCategory.Suggestion:
      return vscode.DiagnosticSeverity.Hint
    case ts.DiagnosticCategory.Message:
    default:
      return vscode.DiagnosticSeverity.Information
  }
}

function customCompletionKind(category) {
  switch (category) {
    case 'resolve-path':
    case 'include-path':
    case 'route-path':
      return vscode.CompletionItemKind.File
    case 'collection-name':
      return vscode.CompletionItemKind.Struct
    case 'record-field':
      return vscode.CompletionItemKind.Field
    default:
      return vscode.CompletionItemKind.Text
  }
}

function toSignatureHelp(signatureHelpItems) {
  if (!signatureHelpItems || !signatureHelpItems.items || !signatureHelpItems.items.length) {
    return null
  }

  const signatureHelp = new vscode.SignatureHelp()
  signatureHelp.activeSignature = signatureHelpItems.selectedItemIndex || 0
  signatureHelp.activeParameter = signatureHelpItems.argumentIndex || 0
  signatureHelp.signatures = signatureHelpItems.items.map((item) => {
    const prefix = ts.displayPartsToString(item.prefixDisplayParts || [])
    const suffix = ts.displayPartsToString(item.suffixDisplayParts || [])
    const separator = ts.displayPartsToString(item.separatorDisplayParts || [])
    let label = prefix
    const parameters = []

    item.parameters.forEach((parameter, index) => {
      if (index > 0) {
        label += separator
      }

      const parameterLabel = ts.displayPartsToString(parameter.displayParts || [])
      const start = label.length
      label += parameterLabel
      parameters.push(
        new vscode.ParameterInformation([start, label.length], ts.displayPartsToString(parameter.documentation || []))
      )
    })

    label += suffix

    const signatureInformation = new vscode.SignatureInformation(
      label,
      ts.displayPartsToString(item.documentation || [])
    )
    signatureInformation.parameters = parameters
    return signatureInformation
  })

  return signatureHelp
}

function debounce(fn, waitMs) {
  let timeoutId = null

  return (...args) => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    timeoutId = setTimeout(() => {
      timeoutId = null
      fn(...args)
    }, waitMs)
  }
}

class PocketPagesCompletionProvider {
  constructor(manager) {
    this.manager = manager
  }

  provideCompletionItems(document, position) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const customCompletionData = service.getCustomCompletionData(document.uri.fsPath, document.getText(), offset)

    if (customCompletionData) {
      return customCompletionData.items.map((entry) => {
        const item = new vscode.CompletionItem(entry.label, customCompletionKind(entry.category))
        item.insertText = entry.insertText || entry.label
        item.detail = entry.detail || ''

        if (entry.documentation) {
          item.documentation = new vscode.MarkdownString(String(entry.documentation))
        }

        item.range = toRange(document, customCompletionData.start, customCompletionData.end)
        return item
      })
    }

    const completionData = service.getCompletionData(document.uri.fsPath, document.getText(), offset)

    if (!completionData) {
      return null
    }

    return completionData.entries.map((entry) => {
      const item = new vscode.CompletionItem(
        entry.name,
        COMPLETION_KIND_MAP[entry.kind] || vscode.CompletionItemKind.Text
      )

      item.sortText = entry.sortText
      item.insertText = entry.insertText || entry.name
      item.detail = entry.kindModifiers ? `${entry.kind} ${entry.kindModifiers}` : entry.kind
      item.filterText = entry.insertText || entry.name
      item.data = {
        filePath: document.uri.fsPath,
        virtualFileName: completionData.virtualFileName,
        virtualOffset: completionData.virtualOffset,
        name: entry.name,
        source: entry.source,
      }

      if (completionData.replacementSpan) {
        item.range = toRange(document, completionData.replacementSpan.start, completionData.replacementSpan.end)
      }

      return item
    })
  }

  resolveCompletionItem(item) {
    if (!item.data) {
      return item
    }

    const service = this.manager.getServiceForFile(item.data.filePath)
    if (!service) {
      return item
    }

    const details = service.getCompletionDetails(
      item.data.virtualFileName,
      item.data.virtualOffset,
      item.data.name,
      item.data.source
    )

    if (!details) {
      return item
    }

    const signature = ts.displayPartsToString(details.displayParts || [])
    const documentation = ts.displayPartsToString(details.documentation || [])

    if (signature) {
      item.detail = signature
    }

    if (documentation) {
      item.documentation = new vscode.MarkdownString().appendCodeblock(signature || item.label.toString(), 'ts').appendMarkdown(
        `\n\n${documentation}`
      )
    }

    return item
  }
}

class PocketPagesHoverProvider {
  constructor(manager) {
    this.manager = manager
  }

  provideHover(document, position) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const quickInfo = service.getQuickInfo(document.uri.fsPath, document.getText(), offset)
    const pathTargetInfo = service.getPathTargetInfo(document.uri.fsPath, document.getText(), offset)

    if ((!quickInfo || quickInfo.start === null || quickInfo.end === null) && !pathTargetInfo) {
      return null
    }

    const contents = []

    if (quickInfo && quickInfo.displayText) {
      contents.push(new vscode.MarkdownString().appendCodeblock(quickInfo.displayText, 'ts'))
    }

    if (quickInfo && quickInfo.documentation) {
      contents.push(new vscode.MarkdownString(quickInfo.documentation))
    }
    if (pathTargetInfo && pathTargetInfo.targetFilePath) {
      const targetLabel = workspaceRelativePath(pathTargetInfo.targetFilePath)
      const pathDetails = new vscode.MarkdownString()
      pathDetails.appendMarkdown(`PocketPages target: \`${targetLabel}\``)

      if (pathTargetInfo.kind === 'route-path' && pathTargetInfo.value) {
        pathDetails.appendMarkdown(`\n\nRoute: \`${pathTargetInfo.value}\``)
      }

      contents.push(pathDetails)
    }

    const hoverRange =
      quickInfo && quickInfo.start !== null && quickInfo.end !== null
        ? toRange(document, quickInfo.start, quickInfo.end)
        : toRange(document, pathTargetInfo.start, pathTargetInfo.end)

    return new vscode.Hover(contents, hoverRange)
  }
}

class PocketPagesSignatureHelpProvider {
  constructor(manager) {
    this.manager = manager
  }

  provideSignatureHelp(document, position, _token, context) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const signatureHelp = service.getSignatureHelp(document.uri.fsPath, document.getText(), offset, {
      triggerCharacter: context ? context.triggerCharacter : undefined,
      isRetrigger: !!(context && context.isRetrigger),
    })

    return toSignatureHelp(signatureHelp)
  }
}

class PocketPagesDefinitionProvider {
  constructor(manager) {
    this.manager = manager
  }

  provideDefinition(document, position) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const target = service.getDefinitionTarget(document.uri.fsPath, document.getText(), offset)
    const location = toDefinitionLocation(target)
    if (!location) {
      return null
    }

    return location
  }
}

class PocketPagesCodeActionProvider {
  constructor(manager) {
    this.manager = manager
  }

  async provideCodeActions(document, range) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const actionSpecs = service.getCodeActions(document.uri.fsPath, document.getText(), {
      start: document.offsetAt(range.start),
      end: document.offsetAt(range.end),
    })
    if (!actionSpecs || !actionSpecs.length) {
      return null
    }

    const documentCache = new Map([[document.uri.fsPath, document]])
    const actions = []

    for (const actionSpec of actionSpecs) {
      const action = new vscode.CodeAction(actionSpec.title, vscode.CodeActionKind.QuickFix)
      const workspaceEdit = new vscode.WorkspaceEdit()

      for (const edit of actionSpec.edits) {
        let targetDocument = documentCache.get(edit.filePath)
        if (!targetDocument) {
          targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.filePath))
          documentCache.set(edit.filePath, targetDocument)
        }

        workspaceEdit.replace(targetDocument.uri, toRange(targetDocument, edit.start, edit.end), edit.newText)
      }

      action.edit = workspaceEdit
      actions.push(action)
    }

    return actions
  }
}

class PocketPagesRenameProvider {
  constructor(manager) {
    this.manager = manager
  }

  prepareRename(document, position) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const renameInfo = service.getRenameInfo(document.uri.fsPath, document.getText(), offset)
    if (!renameInfo) {
      return null
    }

    if (!renameInfo.canRename) {
      throw new Error(renameInfo.localizedErrorMessage || 'Unable to rename this PocketPages symbol.')
    }

    return {
      range: toRange(document, renameInfo.start, renameInfo.end),
      placeholder: renameInfo.placeholder,
    }
  }

  async provideRenameEdits(document, position, newName) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const renameResult = service.getRenameEdits(document.uri.fsPath, document.getText(), offset, newName)
    if (!renameResult) {
      return null
    }

    if (!renameResult.canRename) {
      throw new Error(renameResult.localizedErrorMessage || 'Unable to rename this PocketPages symbol.')
    }

    const workspaceEdit = new vscode.WorkspaceEdit()
    const documentCache = new Map([[document.uri.fsPath, document]])

    for (const edit of renameResult.edits) {
      let targetDocument = documentCache.get(edit.filePath)
      if (!targetDocument) {
        targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.filePath))
        documentCache.set(edit.filePath, targetDocument)
      }

      workspaceEdit.replace(targetDocument.uri, toRange(targetDocument, edit.start, edit.end), edit.newText)
    }

    return workspaceEdit
  }
}

class PocketPagesReferenceProvider {
  constructor(manager) {
    this.manager = manager
  }

  async provideReferences(document, position, context) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const offset = document.offsetAt(position)
    const references = service.getReferenceTargets(document.uri.fsPath, document.getText(), offset, {
      includeDeclaration: !!(context && context.includeDeclaration),
    })
    if (!references || !references.length) {
      return null
    }

    const documentCache = new Map([[document.uri.fsPath, document]])
    const locations = []

    for (const reference of references) {
      let targetDocument = documentCache.get(reference.filePath)
      if (!targetDocument) {
        targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(reference.filePath))
        documentCache.set(reference.filePath, targetDocument)
      }

      locations.push(new vscode.Location(targetDocument.uri, toRange(targetDocument, reference.start, reference.end)))
    }

    return locations
  }
}

class PocketPagesDocumentLinkProvider {
  constructor(manager) {
    this.manager = manager
  }

  provideDocumentLinks(document) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    return service.getDocumentLinks(document.uri.fsPath, document.getText()).map((entry) => {
      const link = new vscode.DocumentLink(toRange(document, entry.start, entry.end), vscode.Uri.file(entry.targetFilePath))
      link.tooltip =
        entry.kind === 'resolve-path'
          ? `Open resolved module: ${entry.value}`
          : entry.kind === 'include-path'
            ? `Open included template: ${entry.value}`
            : `Open route target: ${entry.value}`
      return link
    })
  }
}

class PocketPagesCodeLensProvider {
  constructor(manager) {
    this.manager = manager
  }

  provideCodeLenses(document) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const service = this.manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      return null
    }

    const referenceQuery = service.getFileReferenceQuery(document.uri.fsPath)
    if (!referenceQuery) {
      return null
    }

    const references = service.getFileReferenceTargets(document.uri.fsPath, document.getText(), {
      includeDeclaration: false,
    })
    const referenceCount = references ? references.length : 0
    const title = `All File References (${referenceCount})`
    const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))

    return [
      new vscode.CodeLens(range, {
        title,
        command: 'pocketpagesServerScript.allFileReferences',
        arguments: [document.uri],
      }),
    ]
  }
}

class PocketPagesSemanticTokensProvider {
  provideDocumentSemanticTokens(document) {
    if (!findAppRoot(document.uri.fsPath)) {
      return null
    }

    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND)
    const entries = collectEjsSemanticTokenEntries(document.getText())

    for (const entry of entries) {
      const tokenTypeIndex = getTokenTypeIndex(entry.tokenType)
      if (tokenTypeIndex === null) {
        continue
      }

      const start = document.positionAt(entry.start)
      const end = document.positionAt(entry.start + entry.length)

      if (start.line === end.line) {
        builder.push(start.line, start.character, entry.length, tokenTypeIndex, 0)
        continue
      }

      let currentOffset = entry.start
      while (currentOffset < entry.start + entry.length) {
        const currentStart = document.positionAt(currentOffset)
        const lineEndOffset = document.offsetAt(new vscode.Position(currentStart.line, document.lineAt(currentStart.line).range.end.character))
        const chunkEnd = Math.min(lineEndOffset, entry.start + entry.length)
        const chunkLength = chunkEnd - currentOffset

        if (chunkLength > 0) {
          builder.push(currentStart.line, currentStart.character, chunkLength, tokenTypeIndex, 0)
        }

        if (chunkEnd === currentOffset) {
          currentOffset += document.getText(new vscode.Range(document.positionAt(currentOffset), document.positionAt(currentOffset + 2))).startsWith('\r\n') ? 2 : 1
          continue
        }

        currentOffset = chunkEnd
      }
    }

    return builder.build()
  }
}

function activate(context) {
  const manager = new PocketPagesLanguageServiceManager()
  const diagnostics = vscode.languages.createDiagnosticCollection('pocketpages-server-script')
  const output = vscode.window.createOutputChannel('VSCode PocketPages')

  output.appendLine('VSCode PocketPages activated.')

  const updateDiagnostics = (document) => {
    if (!document || document.uri.scheme !== 'file' || !document.uri.fsPath.endsWith('.ejs')) {
      return
    }

    output.appendLine(`updateDiagnostics: ${document.uri.fsPath}`)

    const service = manager.getServiceForFile(document.uri.fsPath)
    if (!service) {
      output.appendLine('  skipped: not inside a PocketPages app root')
      diagnostics.delete(document.uri)
      return
    }

    const rawDiagnostics = service.getDiagnostics(document.uri.fsPath, document.getText())
    output.appendLine(`  diagnostics: ${rawDiagnostics.length}`)
    const mappedDiagnostics = rawDiagnostics.map((diagnostic) => {
      const entry = new vscode.Diagnostic(
        toRange(document, diagnostic.start, diagnostic.end),
        diagnostic.message,
        diagnosticSeverity(diagnostic.category)
      )

      entry.source = 'pocketpages-server-script'
      entry.code = diagnostic.code
      return entry
    })

    diagnostics.set(document.uri, mappedDiagnostics)
  }

  const debouncedUpdateDiagnostics = debounce(updateDiagnostics, 200)

  context.subscriptions.push(
    diagnostics,
    output,
    vscode.languages.registerCompletionItemProvider(
      CODE_DOCUMENT_SELECTOR,
      new PocketPagesCompletionProvider(manager),
      '.',
      "'",
      '"',
      '/'
    ),
    vscode.languages.registerDocumentLinkProvider(CODE_DOCUMENT_SELECTOR, new PocketPagesDocumentLinkProvider(manager)),
    vscode.languages.registerDefinitionProvider(CODE_DOCUMENT_SELECTOR, new PocketPagesDefinitionProvider(manager)),
    vscode.languages.registerCodeLensProvider(CODE_DOCUMENT_SELECTOR, new PocketPagesCodeLensProvider(manager)),
    vscode.languages.registerCodeActionsProvider(
      CODE_DOCUMENT_SELECTOR,
      new PocketPagesCodeActionProvider(manager),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }
    ),
    vscode.languages.registerReferenceProvider(RENAME_DOCUMENT_SELECTOR, new PocketPagesReferenceProvider(manager)),
    vscode.languages.registerRenameProvider(RENAME_DOCUMENT_SELECTOR, new PocketPagesRenameProvider(manager)),
    vscode.languages.registerHoverProvider(CODE_DOCUMENT_SELECTOR, new PocketPagesHoverProvider(manager)),
    vscode.languages.registerSignatureHelpProvider(
      CODE_DOCUMENT_SELECTOR,
      new PocketPagesSignatureHelpProvider(manager),
      '(',
      ','
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      EJS_DOCUMENT_SELECTOR,
      new PocketPagesSemanticTokensProvider(),
      SEMANTIC_TOKENS_LEGEND
    ),
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.workspace.onDidChangeTextDocument((event) => debouncedUpdateDiagnostics(event.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateDiagnostics(editor.document)
      }
    }),
    vscode.commands.registerCommand('pocketpagesServerScript.refreshDiagnostics', () => {
      const editor = vscode.window.activeTextEditor
      if (editor) {
        updateDiagnostics(editor.document)
      }
    }),
    vscode.commands.registerCommand('pocketpagesServerScript.probeCurrentFile', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showWarningMessage('No active editor.')
        return
      }

      const document = editor.document
      const service = manager.getServiceForFile(document.uri.fsPath)
      const messageLines = [
        `languageId=${document.languageId}`,
        `path=${document.uri.fsPath}`,
        `hasAppRoot=${service ? 'yes' : 'no'}`,
      ]

      if (service) {
        const rawDiagnostics = service.getDiagnostics(document.uri.fsPath, document.getText())
        messageLines.push(`diagnostics=${rawDiagnostics.length}`)
      }

      const message = messageLines.join(' | ')
      output.appendLine(`probe: ${message}`)
      output.show(true)
      vscode.window.showInformationMessage(message)
    }),
    vscode.commands.registerCommand('pocketpagesServerScript.allFileReferences', async (resourceUri) => {
      const editor = vscode.window.activeTextEditor
      const filePath = resourceUri && resourceUri.fsPath ? resourceUri.fsPath : editor && editor.document.uri.fsPath
      if (!filePath) {
        vscode.window.showWarningMessage('No active editor.')
        return
      }

      await showFileReferences({
        manager,
        output,
        document: editor && editor.document.uri.fsPath === filePath ? editor.document : null,
        editor,
        filePath,
      })
    })
  )

  for (const document of vscode.workspace.textDocuments) {
    updateDiagnostics(document)
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
}
