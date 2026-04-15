"use strict";

const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { findAppRoot } = require("../language-service/language-service");
const { getServerTemplateBoundaryLineNumbers } = require("../language-core/ejs-server-boundary");
const { REQUESTS, NOTIFICATIONS } = require("../language-server/protocol");

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
let lspStatusController = null;
let outputChannel = null;
let clientLogger = null;
const saveReasons = new Map();

function getLogTimestamp() {
  return new Date().toISOString().slice(11, 23);
}

function formatLogFieldValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return value.length ? JSON.stringify(value) : null;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function formatLogFields(fields = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    const formattedValue = formatLogFieldValue(value);
    if (formattedValue === null) {
      continue;
    }

    parts.push(`${key}=${formattedValue}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function createOutputLogger(output) {
  function write(level, scope, message, fields = {}) {
    output.appendLine(
      `[${getLogTimestamp()}] [client] [${scope}] [${level}] ${message}${formatLogFields(fields)}`
    );
  }

  return {
    info(scope, message, fields) {
      write("info", scope, message, fields);
    },
    warn(scope, message, fields) {
      write("warn", scope, message, fields);
    },
    error(scope, message, fields) {
      write("error", scope, message, fields);
    },
    perf(scope, message, fields) {
      write("perf", scope, message, fields);
    },
  };
}

function toVscodeUri(value) {
  if (!value) {
    return null;
  }

  if (value instanceof vscode.Uri) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return value.includes("://") ? vscode.Uri.parse(value) : vscode.Uri.file(value);
    } catch (_error) {
      return null;
    }
  }

  if (typeof value === "object") {
    if (typeof value.scheme === "string") {
      try {
        return vscode.Uri.revive(value);
      } catch (_error) {}
    }

    if (typeof value.fsPath === "string") {
      try {
        return vscode.Uri.file(value.fsPath);
      } catch (_error) {
        return null;
      }
    }
  }

  return null;
}

function normalizeDocumentPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function isManagedHookScriptDocument(document) {
  if (!document || document.uri.scheme !== "file") {
    return false;
  }

  const filePath = document.uri.fsPath;
  if (!/\.(js|cjs|mjs)$/i.test(filePath)) {
    return false;
  }

  return normalizeDocumentPath(filePath).includes("/pb_hooks/") && !!findAppRoot(filePath);
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

function isManagedLspDocument(document) {
  return isManagedEjsDocument(document) || isManagedHookScriptDocument(document);
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

function createLspStatusController(context, output) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  let phase = "starting";

  const showOutputCommand = vscode.commands.registerCommand("pocketpagesServerScript.showOutput", () => {
    output.show(true);
  });
  context.subscriptions.push(showOutputCommand);

  statusBarItem.name = "PocketPages LSP";
  statusBarItem.command = "pocketpagesServerScript.showOutput";

  function applyPhase() {
    if (phase === "starting") {
      statusBarItem.text = "$(loading~spin) PocketPages LSP";
      statusBarItem.tooltip = "PocketPages language server is starting.";
      return;
    }

    if (phase === "ready") {
      statusBarItem.text = "$(server-process) PocketPages LSP";
      statusBarItem.tooltip = "PocketPages language server is running.";
      return;
    }

    if (phase === "failed") {
      statusBarItem.text = "$(error) PocketPages LSP";
      statusBarItem.tooltip = "PocketPages language server failed to start.";
      return;
    }

    statusBarItem.text = "$(circle-slash) PocketPages LSP";
    statusBarItem.tooltip = "PocketPages language server is stopped.";
  }

  function refreshVisibility() {
    const activeDocument = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    if (isManagedLspDocument(activeDocument)) {
      statusBarItem.show();
      return;
    }

    statusBarItem.hide();
  }

  return {
    setStarting() {
      phase = "starting";
      applyPhase();
      refreshVisibility();
    },
    setReady() {
      phase = "ready";
      applyPhase();
      refreshVisibility();
    },
    setFailed() {
      phase = "failed";
      applyPhase();
      refreshVisibility();
    },
    setStopped() {
      phase = "stopped";
      applyPhase();
      refreshVisibility();
    },
    refreshVisibility,
    dispose() {
      statusBarItem.dispose();
    },
    item: statusBarItem,
  };
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

async function showFileReferences({ logger, fileUri }) {
  const normalizedFileUri = toVscodeUri(fileUri);
  if (!normalizedFileUri) {
    logger.warn("references", "invalid-uri", {
      raw: typeof fileUri === "string" ? fileUri : typeof fileUri,
    });
    vscode.window.showWarningMessage("Unable to resolve the current file for PocketPages references.");
    return;
  }

  logger.info("references", "query", {
    file: vscode.workspace.asRelativePath(normalizedFileUri.fsPath, false),
  });
  const result = await client.sendRequest(REQUESTS.allFileReferences, { uri: normalizedFileUri.toString() });
  if (!result) {
    logger.warn("references", "unsupported-target", {
      file: vscode.workspace.asRelativePath(normalizedFileUri.fsPath, false),
    });
    vscode.window.showWarningMessage(
      "File is not a supported PocketPages reference target. Use a _private partial, a _private module, or a static route file."
    );
    return;
  }

  const references = Array.isArray(result.references) ? result.references : [];
  logger.info("references", "result", {
    file: vscode.workspace.asRelativePath(normalizedFileUri.fsPath, false),
    kind: result.referenceQuery && result.referenceQuery.kind,
    refs: references.length,
  });

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
    logger.warn("references", "open-target-failed", {
      file: vscode.workspace.asRelativePath(normalizedFileUri.fsPath, false),
      refs: references.length,
    });
    vscode.window.showInformationMessage("References were found, but the target files could not be opened.");
    return;
  }

  const activeEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === normalizedFileUri.fsPath);
  const anchorPosition = activeEditor ? activeEditor.selection.active : new vscode.Position(0, 0);
  await vscode.commands.executeCommand("editor.action.showReferences", normalizedFileUri, anchorPosition, locations);
}

async function applyPrivateFileRenameEdits({ logger, event }) {
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

    logger.info("rename", "apply-edits", {
      old: vscode.workspace.asRelativePath(renameSpec.oldUri.fsPath, false),
      next: vscode.workspace.asRelativePath(renameSpec.newUri.fsPath, false),
      edits: Array.isArray(edits) ? edits.length : 0,
    });

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
  outputChannel = vscode.window.createOutputChannel("VSCode PocketPages");
  clientLogger = createOutputLogger(outputChannel);
  const logger = clientLogger;
  lspStatusController = createLspStatusController(context, outputChannel);
  lspStatusController.setStarting();
  const serverModule = context.asAbsolutePath(path.join("packages", "language-server", "server.js"));
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const clientOptions = {
    documentSelector: LSP_DOCUMENT_SELECTOR,
    outputChannel,
  };

  client = new LanguageClient(
    "pocketpages",
    "PocketPages Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(outputChannel, lspStatusController.item);
  logger.info("lsp", "start", {
    serverModule,
    selector: ["ejs", "pb_hooks-scripts"],
  });
  await client.start();
  lspStatusController.setReady();
  logger.info("lsp", "ready", {
    transport: "ipc",
  });
  logger.info("help", "log-groups", {
    groups: ["lifecycle", "document", "completion", "diagnostics", "cache", "references", "rename", "command"],
  });

  const serverTemplateBoundaryDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "1px 0 0 0",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorIndentGuide.background"),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    opacity: "0.999",
  });

  context.subscriptions.push(
    serverTemplateBoundaryDecoration,
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isManagedLspDocument(document)) {
        logger.info("document", "open", {
          file: vscode.workspace.asRelativePath(document.uri.fsPath, false),
          languageId: document.languageId,
          version: document.version,
        });
      }
      updateServerTemplateBoundariesForDocument(document, serverTemplateBoundaryDecoration);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isManagedLspDocument(event.document)) {
        logger.perf("document", "change", {
          file: vscode.workspace.asRelativePath(event.document.uri.fsPath, false),
          version: event.document.version,
          changes: event.contentChanges.length,
        });
      }
      updateServerTemplateBoundariesForDocument(event.document, serverTemplateBoundaryDecoration);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      saveReasons.delete(document.uri.toString());
      if (isManagedLspDocument(document)) {
        logger.info("document", "close", {
          file: vscode.workspace.asRelativePath(document.uri.fsPath, false),
        });
      }
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
        logger.info("diagnostics", "skip-auto-save", {
          file: vscode.workspace.asRelativePath(document.uri.fsPath, false),
          saveReason: formatSaveReason(saveReason),
        });
        return;
      }

      logger.info("diagnostics", "manual-save", {
        file: vscode.workspace.asRelativePath(document.uri.fsPath, false),
      });
      await client.sendNotification(NOTIFICATIONS.didManualSave, { uri: document.uri.toString() });
    }),
    vscode.workspace.onDidRenameFiles((event) => applyPrivateFileRenameEdits({ logger, event })),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      lspStatusController.refreshVisibility();
      if (editor) {
        if (isManagedLspDocument(editor.document)) {
          logger.info("editor", "active", {
            file: vscode.workspace.asRelativePath(editor.document.uri.fsPath, false),
          });
        }
        updateServerTemplateBoundaries(editor, serverTemplateBoundaryDecoration);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      lspStatusController.refreshVisibility();
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
      logger.info("command", "probe", {
        file: vscode.workspace.asRelativePath(editor.document.uri.fsPath, false),
        hasAppRoot: result.hasAppRoot,
        diagnostics: result.diagnostics,
      });
      outputChannel.show(true);
      vscode.window.showInformationMessage(message);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.refreshDiagnostics", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      logger.info("command", "refresh-diagnostics", {
        file: vscode.workspace.asRelativePath(editor.document.uri.fsPath, false),
      });
      await client.sendRequest(REQUESTS.refreshDiagnostics, { uri: editor.document.uri.toString() });
      updateServerTemplateBoundaries(editor, serverTemplateBoundaryDecoration);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.reloadCaches", async () => {
      const editor = vscode.window.activeTextEditor;
      const result = await client.sendRequest(REQUESTS.reloadCaches, {
        uri: editor ? editor.document.uri.toString() : null,
      });
      logger.info("cache", "reload", {
        file: editor && editor.document ? vscode.workspace.asRelativePath(editor.document.uri.fsPath, false) : null,
        scoped: result.scoped,
      });
      outputChannel.show(true);
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.allFileReferences", async (resourceUri) => {
      const editor = vscode.window.activeTextEditor;
      const fileUri = toVscodeUri(resourceUri) || (editor ? editor.document.uri : null);
      if (!fileUri) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      await showFileReferences({ logger, fileUri });
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.openCodeLensTarget", async (resourceUri) => {
      const fileUri = toVscodeUri(resourceUri);
      if (!fileUri) {
        vscode.window.showWarningMessage("Unable to resolve the target file.");
        return;
      }

      await vscode.commands.executeCommand("vscode.open", fileUri);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.noopCodeLens", () => {})
  );

  for (const document of vscode.workspace.textDocuments) {
    updateServerTemplateBoundariesForDocument(document, serverTemplateBoundaryDecoration);
  }
  lspStatusController.refreshVisibility();
  logger.info("lifecycle", "activate-complete", {
    openDocuments: vscode.workspace.textDocuments.filter((document) => isManagedLspDocument(document)).length,
  });
}

async function activate(context) {
  try {
    return await activateLsp(context);
  } catch (error) {
    if (client) {
      try {
        await client.stop();
      } catch (_stopError) {}
      client = null;
    }
    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel("VSCode PocketPages");
      context.subscriptions.push(outputChannel);
    }
    if (!clientLogger) {
      clientLogger = createOutputLogger(outputChannel);
    }
    if (!lspStatusController) {
      lspStatusController = createLspStatusController(context, outputChannel);
      context.subscriptions.push(lspStatusController.item);
    }
    lspStatusController.setFailed();
    const message = error && error.message ? error.message : String(error);
    clientLogger.error("lsp", "startup-failed", { message });
    vscode.window.showErrorMessage(`PocketPages LSP failed to start. (${message})`);
  }
}

async function deactivate() {
  if (client) {
    const activeClient = client;
    client = null;
    if (lspStatusController) {
      lspStatusController.setStopped();
    }
    return activeClient.stop();
  }

  if (lspStatusController) {
    lspStatusController.setStopped();
  }
}

module.exports = {
  activate,
  deactivate,
};
