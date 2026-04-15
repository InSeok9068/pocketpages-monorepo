"use strict";

const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { findAppRoot } = require("./language-service");
const { getServerTemplateBoundaryLineNumbers } = require("./ejs-server-boundary");
const { REQUESTS, NOTIFICATIONS } = require("./lsp/protocol");
const legacyExtension = require("./extension");

const EJS_DOCUMENT_SELECTOR = [
  { scheme: "file", pattern: "**/*.ejs" },
  { scheme: "untitled", pattern: "**/*.ejs" },
];
const HOOK_SCRIPT_DOCUMENT_SELECTOR = [
  { scheme: "file", pattern: "**/pb_hooks/**/*.js" },
  { scheme: "file", pattern: "**/pb_hooks/**/*.cjs" },
  { scheme: "file", pattern: "**/pb_hooks/**/*.mjs" },
];
const LSP_DOCUMENT_SELECTOR = [...EJS_DOCUMENT_SELECTOR, ...HOOK_SCRIPT_DOCUMENT_SELECTOR];

let client = null;
let legacyMode = false;
const saveReasons = new Map();

function normalizeDocumentPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function hasPrivatePagesSegment(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  const pagesMarker = "/pb_hooks/pages/";
  const markerIndex = normalizedPath.indexOf(pagesMarker);
  if (markerIndex === -1) {
    return false;
  }

  return normalizedPath
    .slice(markerIndex + pagesMarker.length)
    .split("/")
    .includes("_private");
}

function isPrivatePartialDocument(document) {
  return !!document && document.uri.scheme === "file" && document.uri.fsPath.endsWith(".ejs") && hasPrivatePagesSegment(document.uri.fsPath);
}

function isManagedEjsDocument(document) {
  return !!document
    && document.uri.scheme === "file"
    && document.uri.fsPath.endsWith(".ejs")
    && !!findAppRoot(document.uri.fsPath);
}

function formatSaveReason(reason) {
  if (reason === vscode.TextDocumentSaveReason.Manual) {
    return "manual";
  }

  if (reason === vscode.TextDocumentSaveReason.AfterDelay) {
    return "afterDelay";
  }

  if (reason === vscode.TextDocumentSaveReason.FocusOut) {
    return "focusOut";
  }

  return `unknown:${String(reason)}`;
}

function toRange(document, start, end) {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function toReferenceLocation(document, reference) {
  return new vscode.Location(document.uri, toRange(document, reference.start, reference.end));
}

function updateServerTemplateBoundaries(editor, decoration) {
  if (!editor || !editor.document) {
    return;
  }

  const document = editor.document;
  if (
    document.uri.scheme !== "file" ||
    !document.uri.fsPath.endsWith(".ejs") ||
    !findAppRoot(document.uri.fsPath)
  ) {
    editor.setDecorations(decoration, []);
    return;
  }

  const boundaryRanges = getServerTemplateBoundaryLineNumbers(document.getText(), {
    includeTopLevelPartialSetup: isPrivatePartialDocument(document),
  }).map((lineIndex) =>
    new vscode.Range(new vscode.Position(lineIndex, 0), new vscode.Position(lineIndex, 0))
  );

  editor.setDecorations(decoration, boundaryRanges);
}

function updateServerTemplateBoundariesForDocument(document, decoration) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() !== document.uri.toString()) {
      continue;
    }

    updateServerTemplateBoundaries(editor, decoration);
  }
}

async function showFileReferences({ output, fileUri }) {
  const result = await client.sendRequest(REQUESTS.allFileReferences, { uri: fileUri.toString() });
  if (!result) {
    vscode.window.showWarningMessage(
      "File is not a supported PocketPages reference target. Use a _private partial, a _private module, or a static route file."
    );
    return;
  }

  const references = Array.isArray(result.references) ? result.references : [];
  output.appendLine(
    `showFileReferences: kind=${result.referenceQuery.kind} path=${fileUri.fsPath} refs=${references.length}`
  );

  if (!references.length) {
    vscode.window.showInformationMessage(result.referenceQuery.emptyMessage || "No references found.");
    return;
  }

  const uniqueFilePaths = [...new Set(references.map((entry) => entry.filePath))];
  const referenceDocuments = await Promise.all(
    uniqueFilePaths.map(async (referenceFilePath) => [
      referenceFilePath,
      await vscode.workspace.openTextDocument(vscode.Uri.file(referenceFilePath)),
    ])
  );
  const documentMap = new Map(referenceDocuments);
  const locations = references
    .map((reference) => {
      const referenceDocument = documentMap.get(reference.filePath);
      if (!referenceDocument) {
        return null;
      }

      return toReferenceLocation(referenceDocument, reference);
    })
    .filter(Boolean);

  if (!locations.length) {
    vscode.window.showInformationMessage("References were found, but the target files could not be opened.");
    return;
  }

  const activeEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === fileUri.fsPath);
  const anchorPosition = activeEditor ? activeEditor.selection.active : new vscode.Position(0, 0);
  await vscode.commands.executeCommand("editor.action.showReferences", fileUri, anchorPosition, locations);
}

async function applyPrivateFileRenameEdits({ output, event }) {
  const renameSpecs = event.files.filter(
    (entry) =>
      entry.oldUri &&
      entry.newUri &&
      entry.oldUri.scheme === "file" &&
      entry.newUri.scheme === "file" &&
      hasPrivatePagesSegment(entry.oldUri.fsPath)
  );
  if (!renameSpecs.length) {
    return;
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  const documentCache = new Map();
  let editCount = 0;

  for (const renameSpec of renameSpecs) {
    const edits = await client.sendRequest(REQUESTS.fileRenameEdits, {
      oldUri: renameSpec.oldUri.toString(),
      newUri: renameSpec.newUri.toString(),
    });

    output.appendLine(
      `fileRename: old=${renameSpec.oldUri.fsPath} new=${renameSpec.newUri.fsPath} edits=${Array.isArray(edits) ? edits.length : 0}`
    );

    for (const edit of edits || []) {
      let targetDocument = documentCache.get(edit.filePath);
      if (!targetDocument) {
        targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.filePath));
        documentCache.set(edit.filePath, targetDocument);
      }

      workspaceEdit.replace(targetDocument.uri, toRange(targetDocument, edit.start, edit.end), edit.newText);
      editCount += 1;
    }
  }

  if (editCount > 0) {
    await vscode.workspace.applyEdit(workspaceEdit);
  }
}

async function activateLsp(context) {
  const output = vscode.window.createOutputChannel("VSCode PocketPages");
  const serverModule = context.asAbsolutePath(path.join("src", "lsp", "server.js"));
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const clientOptions = {
    documentSelector: LSP_DOCUMENT_SELECTOR,
    outputChannel: output,
  };

  client = new LanguageClient(
    "pocketpages",
    "PocketPages Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(output);
  await client.start();

  const serverTemplateBoundaryDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    opacity: "0.999",
  });

  context.subscriptions.push(
    serverTemplateBoundaryDecoration,
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateServerTemplateBoundariesForDocument(document, serverTemplateBoundaryDecoration);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      updateServerTemplateBoundariesForDocument(event.document, serverTemplateBoundaryDecoration);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      saveReasons.delete(document.uri.toString());
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      saveReasons.set(event.document.uri.toString(), event.reason);
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const documentKey = document.uri.toString();
      const saveReason = saveReasons.get(documentKey);
      saveReasons.delete(documentKey);
      updateServerTemplateBoundariesForDocument(document, serverTemplateBoundaryDecoration);

      if (!isManagedEjsDocument(document)) {
        return;
      }

      if (saveReason !== vscode.TextDocumentSaveReason.Manual) {
        output.appendLine(
          `updateDiagnostics skipped: ${document.uri.fsPath} (saveReason=${formatSaveReason(saveReason)})`
        );
        return;
      }

      await client.sendNotification(NOTIFICATIONS.didManualSave, { uri: document.uri.toString() });
    }),
    vscode.workspace.onDidRenameFiles((event) => applyPrivateFileRenameEdits({ output, event })),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateServerTemplateBoundaries(editor, serverTemplateBoundaryDecoration);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      editors.forEach((editor) => updateServerTemplateBoundaries(editor, serverTemplateBoundaryDecoration));
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.probeCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      const result = await client.sendRequest(REQUESTS.probeCurrentFile, { uri: editor.document.uri.toString() });
      const message = [
        `path=${result.filePath}`,
        `hasAppRoot=${result.hasAppRoot ? "yes" : "no"}`,
        `diagnostics=${result.diagnostics}`,
      ].join(" | ");
      output.appendLine(`probe: ${message}`);
      output.show(true);
      vscode.window.showInformationMessage(message);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.refreshDiagnostics", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      await client.sendRequest(REQUESTS.refreshDiagnostics, { uri: editor.document.uri.toString() });
      updateServerTemplateBoundaries(editor, serverTemplateBoundaryDecoration);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.reloadCaches", async () => {
      const editor = vscode.window.activeTextEditor;
      const result = await client.sendRequest(REQUESTS.reloadCaches, {
        uri: editor ? editor.document.uri.toString() : null,
      });
      output.appendLine(`reloadCaches: ${result.message}`);
      output.show(true);
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.allFileReferences", async (resourceUri) => {
      const editor = vscode.window.activeTextEditor;
      const fileUri = resourceUri || (editor ? editor.document.uri : null);
      if (!fileUri) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      await showFileReferences({ output, fileUri });
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.noopCodeLens", () => {})
  );

  for (const document of vscode.workspace.textDocuments) {
    updateServerTemplateBoundariesForDocument(document, serverTemplateBoundaryDecoration);
  }
}

async function activate(context) {
  try {
    return await activateLsp(context);
  } catch (error) {
    legacyMode = true;
    const message = error && error.message ? error.message : String(error);
    vscode.window.showWarningMessage(`PocketPages LSP failed to start. Falling back to legacy extension host mode. (${message})`);
    return legacyExtension.activate(context);
  }
}

async function deactivate() {
  if (legacyMode && legacyExtension && typeof legacyExtension.deactivate === "function") {
    return legacyExtension.deactivate();
  }

  if (client) {
    const activeClient = client;
    client = null;
    return activeClient.stop();
  }
}

module.exports = {
  activate,
  deactivate,
};
