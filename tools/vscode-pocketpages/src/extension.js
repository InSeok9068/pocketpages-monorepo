'use strict'

const vscode = require('vscode')
const { PocketPagesLanguageServiceManager, findAppRoot, ts } = require('./language-service')

const DOCUMENT_SELECTOR = [
  { scheme: 'file', pattern: '**/*.ejs' },
  { scheme: 'untitled', pattern: '**/*.ejs' },
]

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
      return vscode.CompletionItemKind.File
    case 'collection-name':
      return vscode.CompletionItemKind.Struct
    case 'record-field':
      return vscode.CompletionItemKind.Field
    default:
      return vscode.CompletionItemKind.Text
  }
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

    if (!quickInfo || quickInfo.start === null || quickInfo.end === null) {
      return null
    }

    const contents = []

    if (quickInfo.displayText) {
      contents.push(new vscode.MarkdownString().appendCodeblock(quickInfo.displayText, 'ts'))
    }

    if (quickInfo.documentation) {
      contents.push(new vscode.MarkdownString(quickInfo.documentation))
    }

    return new vscode.Hover(contents, toRange(document, quickInfo.start, quickInfo.end))
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
    const targetFilePath = service.getDefinitionTarget(document.uri.fsPath, document.getText(), offset)

    if (!targetFilePath) {
      return null
    }

    return new vscode.Location(vscode.Uri.file(targetFilePath), new vscode.Position(0, 0))
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
      DOCUMENT_SELECTOR,
      new PocketPagesCompletionProvider(manager),
      '.',
      "'",
      '"',
      '/'
    ),
    vscode.languages.registerDocumentLinkProvider(DOCUMENT_SELECTOR, new PocketPagesDocumentLinkProvider(manager)),
    vscode.languages.registerDefinitionProvider(DOCUMENT_SELECTOR, new PocketPagesDefinitionProvider(manager)),
    vscode.languages.registerHoverProvider(DOCUMENT_SELECTOR, new PocketPagesHoverProvider(manager)),
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
