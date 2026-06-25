"use strict";

const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind, State } = require("vscode-languageclient/node");
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
const DEBUG_BUNDLE_LOG_LIMIT = 500;
const CLIENT_LOG_SCOPES = [
  "lsp",
  "help",
  "lifecycle",
  "document",
  "editor",
  "diagnostics",
  "cache",
  "references",
  "rename",
  "refactor",
  "command",
];
const SERVER_LOG_SCOPES = [
  "lifecycle",
  "prepare",
  "warmup",
  "document",
  "watch",
  "diagnostics",
  "completion",
  "hover",
  "definition",
  "references",
  "code-action",
  "rename",
  "refactor",
  "links",
  "signature",
  "inlay",
  "semantic-tokens",
  "symbols",
  "codelens",
  "cache",
  "probe",
];
const LOG_LEVELS = ["info", "warn", "error", "perf"];

let client = null;
let lspStatusController = null;
let outputChannel = null;
let clientLogger = null;
let lspStartPromise = null;
let lspStopRequested = false;
let lastUnexpectedStopRestartAt = 0;
let lspRuntimeDisposables = [];
const logSessionId = createLogSessionId();
const logBuffer = createLogBuffer(DEBUG_BUNDLE_LOG_LIMIT);
const saveReasons = new Map();
const LSP_UNEXPECTED_STOP_RESTART_COOLDOWN_MS = 10000;

function padNumber(value, length) {
  return String(value).padStart(length, "0");
}

function getLogTimestamp() {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  return [
    now.getFullYear(),
    "-",
    padNumber(now.getMonth() + 1, 2),
    "-",
    padNumber(now.getDate(), 2),
    "T",
    padNumber(now.getHours(), 2),
    ":",
    padNumber(now.getMinutes(), 2),
    ":",
    padNumber(now.getSeconds(), 2),
    ".",
    padNumber(now.getMilliseconds(), 3),
    offsetSign,
    padNumber(Math.floor(absoluteOffsetMinutes / 60), 2),
    ":",
    padNumber(absoluteOffsetMinutes % 60, 2),
  ].join("");
}

function createLogSessionId() {
  return `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createLogBuffer(limit) {
  const maxLines = Math.max(1, Number(limit) || 500);
  const lines = [];
  let pendingLine = "";

  function pushLine(line) {
    lines.push(String(line));
    while (lines.length > maxLines) {
      lines.shift();
    }
  }

  function append(value) {
    const text = String(value || "");
    const parts = text.split(/\r?\n/);
    if (parts.length === 1) {
      pendingLine += parts[0];
      return;
    }

    pushLine(pendingLine + parts[0]);
    for (let index = 1; index < parts.length - 1; index += 1) {
      pushLine(parts[index]);
    }
    pendingLine = parts[parts.length - 1];
  }

  return {
    append,
    appendLine(value) {
      append(`${String(value || "")}\n`);
    },
    replace(value) {
      lines.length = 0;
      pendingLine = "";
      append(value);
    },
    clear() {
      lines.length = 0;
      pendingLine = "";
    },
    getLines() {
      return pendingLine ? [...lines, pendingLine] : [...lines];
    },
  };
}

function createBufferedOutputChannel(realOutput, buffer) {
  return {
    get name() {
      return realOutput.name;
    },
    append(value) {
      buffer.append(value);
      realOutput.append(value);
    },
    appendLine(value) {
      buffer.appendLine(value);
      realOutput.appendLine(value);
    },
    replace(value) {
      buffer.replace(value);
      if (typeof realOutput.replace === "function") {
        realOutput.replace(value);
      } else {
        realOutput.clear();
        realOutput.append(value);
      }
    },
    clear() {
      buffer.clear();
      realOutput.clear();
    },
    show(...args) {
      return realOutput.show(...args);
    },
    hide() {
      return realOutput.hide();
    },
    dispose() {
      return realOutput.dispose();
    },
  };
}

function ensureOutputChannel(context) {
  if (!outputChannel) {
    const realOutput = vscode.window.createOutputChannel("VSCode PocketPages");
    outputChannel = createBufferedOutputChannel(realOutput, logBuffer);
    context.subscriptions.push(outputChannel);
  }

  return outputChannel;
}

function getExtensionVersion(context) {
  return context && context.extension && context.extension.packageJSON
    ? context.extension.packageJSON.version
    : null;
}

function getWorkspaceFolderCount() {
  return Array.isArray(vscode.workspace.workspaceFolders)
    ? vscode.workspace.workspaceFolders.length
    : 0;
}

function getWorkspaceFolderLabels() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.name);
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
      `[${getLogTimestamp()}] [client] [${scope}] [${level}] ${message}${formatLogFields({
        session: logSessionId,
        ...fields,
      })}`
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

function normalizeFsPath(filePath) {
  const normalizedPath = path.resolve(String(filePath || "")).replace(/\\/g, "/");
  return normalizedPath.replace(/^[A-Z]:/, (value) => value.toLowerCase());
}

function isSameOrChildFsPath(parentPath, candidatePath) {
  const relativePath = path.relative(normalizeFsPath(parentPath), normalizeFsPath(candidatePath));
  return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getPagesRelativeSegments(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  const pagesMarker = "/pb_hooks/pages/";
  const markerIndex = normalizedPath.indexOf(pagesMarker);
  if (markerIndex === -1) {
    return null;
  }

  return normalizedPath
    .slice(markerIndex + pagesMarker.length)
    .split("/")
    .filter(Boolean);
}

function isPagesAssetPath(filePath) {
  const relativeSegments = getPagesRelativeSegments(filePath);
  return !!relativeSegments && relativeSegments.includes("assets");
}

function isExcludedManagedPagesScriptPath(filePath) {
  if (!/\.(js|cjs|mjs)$/i.test(String(filePath || ""))) {
    return false;
  }

  const normalizedPath = normalizeDocumentPath(filePath);
  const relativeSegments = getPagesRelativeSegments(normalizedPath);
  if (!relativeSegments) {
    return false;
  }

  if (isPagesAssetPath(normalizedPath)) {
    return true;
  }

  if (hasPrivatePagesSegment(normalizedPath)) {
    return false;
  }

  const lowerPath = normalizedPath.toLowerCase();
  return (
    relativeSegments.includes("vendor") ||
    lowerPath.endsWith(".min.js") ||
    lowerPath.endsWith(".min.cjs") ||
    lowerPath.endsWith(".min.mjs")
  );
}

function isManagedRenameTargetPath(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  if (!normalizedPath.includes("/pb_hooks/")) {
    return false;
  }

  if (
    !normalizedPath.includes("/pb_hooks/pages/") &&
    !/\.(js|cjs|mjs)$/i.test(normalizedPath)
  ) {
    return false;
  }

  return !!findAppRoot(filePath);
}

function isManagedHookScriptDocument(document) {
  if (!document || document.uri.scheme !== "file") {
    return false;
  }

  const filePath = document.uri.fsPath;
  if (!/\.(js|cjs|mjs)$/i.test(filePath)) {
    return false;
  }

  if (isExcludedManagedPagesScriptPath(filePath)) {
    return false;
  }

  return normalizeDocumentPath(filePath).includes("/pb_hooks/") && !!findAppRoot(filePath);
}

function hasPrivatePagesSegment(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  const relativeSegments = getPagesRelativeSegments(normalizedPath);
  if (!relativeSegments) {
    return false;
  }

  return relativeSegments.includes("_private");
}

function isPrivatePartialDocument(document) {
  return !!document && document.uri.scheme === "file" && document.uri.fsPath.endsWith(".ejs") && hasPrivatePagesSegment(document.uri.fsPath);
}

function isManagedEjsDocument(document) {
  return !!document
    && document.uri.scheme === "file"
    && document.uri.fsPath.endsWith(".ejs")
    && !isPagesAssetPath(document.uri.fsPath)
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

function getPreRenameEditUri(filePath, renameSpecs) {
  const normalizedFilePath = normalizeFsPath(filePath);
  for (const renameSpec of renameSpecs) {
    const oldPath = normalizeFsPath(renameSpec.oldUri.fsPath);
    const newPath = normalizeFsPath(renameSpec.newUri.fsPath);
    if (normalizedFilePath === newPath) {
      return renameSpec.oldUri;
    }

    if (isSameOrChildFsPath(newPath, normalizedFilePath)) {
      const relativePath = path.relative(newPath, normalizedFilePath);
      return vscode.Uri.file(path.join(renameSpec.oldUri.fsPath, relativePath));
    }
  }

  return vscode.Uri.file(filePath);
}

function toReferenceLocation(document, reference) {
  return new vscode.Location(document.uri, toRange(document, reference.start, reference.end));
}

function isEmptySelection(selection) {
  if (!selection) {
    return true;
  }

  if (typeof selection.isEmpty === "boolean") {
    return selection.isEmpty;
  }

  return !!selection.start && !!selection.end &&
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character;
}

function normalizeSelectionRange(selection) {
  if (!selection || !selection.start || !selection.end) {
    return null;
  }

  const startsBeforeEnd =
    selection.start.line < selection.end.line ||
    (selection.start.line === selection.end.line && selection.start.character <= selection.end.character);

  return startsBeforeEnd
    ? { start: selection.start, end: selection.end }
    : { start: selection.end, end: selection.start };
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
      lastUnexpectedStopRestartAt = 0;
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

function disposeLspRuntimeDisposables() {
  const disposables = lspRuntimeDisposables;
  lspRuntimeDisposables = [];
  for (const disposable of disposables) {
    if (disposable && typeof disposable.dispose === "function") {
      try {
        disposable.dispose();
      } catch (_error) {}
    }
  }
}

function getActiveManagedDocument() {
  const activeDocument = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  return isManagedLspDocument(activeDocument) ? activeDocument : null;
}

function scheduleLspRestartForActiveDocument(context, reason) {
  const activeDocument = getActiveManagedDocument();
  if (!activeDocument) {
    return;
  }

  const now = Date.now();
  if (now - lastUnexpectedStopRestartAt < LSP_UNEXPECTED_STOP_RESTART_COOLDOWN_MS) {
    if (clientLogger) {
      clientLogger.warn("lsp", "restart-skipped", {
        reason,
        file: vscode.workspace.asRelativePath(activeDocument.uri.fsPath, false),
      });
    }
    return;
  }

  lastUnexpectedStopRestartAt = now;
  if (clientLogger) {
    clientLogger.warn("lsp", "restart", {
      reason,
      file: vscode.workspace.asRelativePath(activeDocument.uri.fsPath, false),
    });
  }
  void ensureLspStarted(context);
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
      "File is not a supported PocketPages reference target. Use a PocketPages route file, asset file, _private partial, or _private module."
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
    uniqueFilePaths.map(async (referenceFilePath) => {
      try {
        return [
          referenceFilePath,
          await vscode.workspace.openTextDocument(vscode.Uri.file(referenceFilePath)),
        ];
      } catch (error) {
        logger.warn("references", "open-target-failed", {
          file: vscode.workspace.asRelativePath(referenceFilePath, false),
          message: error && error.message ? error.message : String(error),
        });
        return null;
      }
    })
  );
  const documentMap = new Map(referenceDocuments.filter(Boolean));
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

async function createManagedFileRenameWorkspaceEdit({ logger, event, mapRenamedTargetsToOldUris = false }) {
  const renameSpecs = event.files.filter(
    (entry) =>
      entry.oldUri &&
      entry.newUri &&
      entry.oldUri.scheme === "file" &&
      entry.newUri.scheme === "file" &&
      isManagedRenameTargetPath(entry.oldUri.fsPath)
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

    logger.info("rename", "provide-edits", {
      old: vscode.workspace.asRelativePath(renameSpec.oldUri.fsPath, false),
      next: vscode.workspace.asRelativePath(renameSpec.newUri.fsPath, false),
      edits: Array.isArray(edits) ? edits.length : 0,
    });

    for (const edit of edits || []) {
      const targetUri = mapRenamedTargetsToOldUris
        ? getPreRenameEditUri(edit.filePath, renameSpecs)
        : vscode.Uri.file(edit.filePath);
      const targetKey = targetUri.toString();
      let targetDocument = documentCache.get(targetKey);
      if (!targetDocument) {
        try {
          targetDocument = await vscode.workspace.openTextDocument(targetUri);
        } catch (error) {
          logger.warn("rename", "open-target-failed", {
            file: targetUri.scheme === "file"
              ? vscode.workspace.asRelativePath(targetUri.fsPath, false)
              : targetUri.toString(),
            message: error && error.message ? error.message : String(error),
          });
          continue;
        }
        documentCache.set(targetKey, targetDocument);
      }

      workspaceEdit.replace(targetDocument.uri, toRange(targetDocument, edit.start, edit.end), edit.newText);
      editCount += 1;
    }
  }

  return editCount > 0 ? workspaceEdit : null;
}

async function applyManagedFileRenameEdits({ logger, event }) {
  const workspaceEdit = await createManagedFileRenameWorkspaceEdit({ logger, event });
  if (workspaceEdit) {
    await vscode.workspace.applyEdit(workspaceEdit);
  }
}

async function applyExtractPartialEdits(result) {
  const workspaceEdit = new vscode.WorkspaceEdit();
  const documentCache = new Map();
  let editCount = 0;

  for (const create of result && Array.isArray(result.creates) ? result.creates : []) {
    const targetUri = vscode.Uri.file(create.filePath);
    workspaceEdit.createFile(targetUri, { ignoreIfExists: false });
    workspaceEdit.insert(targetUri, new vscode.Position(0, 0), String(create.text || ""));
    editCount += 2;
  }

  for (const edit of result && Array.isArray(result.edits) ? result.edits : []) {
    let targetDocument = documentCache.get(edit.filePath);
    if (!targetDocument) {
      targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.filePath));
      documentCache.set(edit.filePath, targetDocument);
    }

    workspaceEdit.replace(targetDocument.uri, toRange(targetDocument, edit.start, edit.end), edit.newText);
    editCount += 1;
  }

  if (editCount > 0) {
    await vscode.workspace.applyEdit(workspaceEdit);
  }

  return editCount;
}

async function extractPartialFromSelection(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isManagedEjsDocument(editor.document)) {
    vscode.window.showWarningMessage("Open a PocketPages EJS file before extracting a partial.");
    return;
  }

  if (isEmptySelection(editor.selection)) {
    vscode.window.showWarningMessage("Select template markup before extracting a partial.");
    return;
  }

  const selectionRange = normalizeSelectionRange(editor.selection);
  if (!selectionRange) {
    vscode.window.showWarningMessage("Select template markup before extracting a partial.");
    return;
  }

  const partialName = await vscode.window.showInputBox({
    prompt: "Partial name",
    placeHolder: "card or cards/card.ejs",
    validateInput(value) {
      const text = String(value || "").trim();
      if (!text) {
        return "Enter a partial name.";
      }
      if (text.startsWith("/") || text.includes("..")) {
        return "Use a relative partial name.";
      }
      if (path.extname(text) && path.extname(text).toLowerCase() !== ".ejs") {
        return "Partial files must use .ejs.";
      }
      return null;
    },
  });
  if (!partialName) {
    return;
  }

  const activeClient = await ensureLspStarted(context);
  if (!activeClient) {
    return;
  }

  const result = await activeClient.sendRequest(REQUESTS.extractPartialEdits, {
    uri: editor.document.uri.toString(),
    range: selectionRange,
    partialName,
  });

  if (!result || result.ok === false) {
    vscode.window.showWarningMessage(result && result.message ? result.message : "Unable to extract partial.");
    return;
  }

  const editCount = await applyExtractPartialEdits(result);
  clientLogger.info("refactor", "extract-partial", {
    file: vscode.workspace.asRelativePath(editor.document.uri.fsPath, false),
    partial: result.partialFilePath ? vscode.workspace.asRelativePath(result.partialFilePath, false) : null,
    edits: editCount,
  });
  if (result.partialFilePath) {
    vscode.window.showInformationMessage(`Extracted partial: ${vscode.workspace.asRelativePath(result.partialFilePath, false)}`);
  }
}

function hasManagedFileRenameTargets(event) {
  return (event.files || []).some(
    (entry) =>
      entry.oldUri &&
      entry.newUri &&
      entry.oldUri.scheme === "file" &&
      entry.newUri.scheme === "file" &&
      isManagedRenameTargetPath(entry.oldUri.fsPath)
  );
}

async function handleManagedFileRenameEvent(context, event) {
  if (!hasManagedFileRenameTargets(event)) {
    return;
  }

  const activeClient = await ensureLspStarted(context);
  if (!activeClient) {
    return;
  }

  await applyManagedFileRenameEdits({ logger: clientLogger, event });
}

function handleManagedFileWillRenameEvent(context, event) {
  if (!hasManagedFileRenameTargets(event) || typeof event.waitUntil !== "function") {
    return;
  }

  event.waitUntil((async () => {
    const activeClient = await ensureLspStarted(context);
    if (!activeClient) {
      return null;
    }

    return createManagedFileRenameWorkspaceEdit({
      logger: clientLogger,
      event,
      mapRenamedTargetsToOldUris: true,
    });
  })());
}

function getRelativePathLabel(filePath) {
  return filePath ? vscode.workspace.asRelativePath(filePath, false) : null;
}

function getActiveEditorDebugInfo() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document) {
    return {
      hasActiveEditor: false,
    };
  }

  return {
    hasActiveEditor: true,
    uri: editor.document.uri.toString(),
    file: editor.document.uri.scheme === "file"
      ? getRelativePathLabel(editor.document.uri.fsPath)
      : editor.document.uri.toString(),
    languageId: editor.document.languageId,
    version: editor.document.version,
    line: editor.selection.active.line + 1,
    character: editor.selection.active.character + 1,
    managed: isManagedLspDocument(editor.document),
  };
}

function buildDebugBundle({ context, probeResult, probeError }) {
  const activeEditor = getActiveEditorDebugInfo();
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(),
  }));
  const recentLogs = logBuffer.getLines().slice(-DEBUG_BUNDLE_LOG_LIMIT);
  const metadata = {
    generatedAt: getLogTimestamp(),
    session: logSessionId,
    extensionVersion: getExtensionVersion(context),
    vscodeVersion: vscode.version,
    nodeVersion: process.version,
    workspaceFolderCount: workspaceFolders.length,
    workspaceFolders,
    activeEditor,
  };

  return [
    "# PocketPages Debug Bundle",
    "",
    "## Metadata",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "## Probe",
    "```json",
    JSON.stringify(
      {
        ok: !probeError,
        result: probeResult || null,
        error: probeError ? String(probeError && probeError.message ? probeError.message : probeError) : null,
      },
      null,
      2
    ),
    "```",
    "",
    "## Recent Logs",
    "```text",
    recentLogs.join("\n"),
    "```",
    "",
  ].join("\n");
}

function formatExplainRouteMethod(method) {
  return method === "PAGE" ? "GET" : String(method || "UNKNOWN");
}

function formatExplainRelativePath(filePath) {
  return filePath ? getRelativePathLabel(filePath) : null;
}

function formatExplainFileList(filePaths) {
  const entries = (Array.isArray(filePaths) ? filePaths : [])
    .map((filePath) => formatExplainRelativePath(filePath))
    .filter(Boolean);
  return entries.length ? entries.join(" -> ") : "(none)";
}

function formatExplainLoaderList(loaders) {
  const entries = (Array.isArray(loaders) ? loaders : [])
    .map((loader) => {
      const label = loader && loader.fileName ? loader.fileName : null;
      if (!label) {
        return null;
      }
      return loader.method ? `${label} (${loader.method})` : label;
    })
    .filter(Boolean);
  return entries.length ? entries.join(", ") : "(none)";
}

function formatRouteExplanation(result) {
  if (!result || result.ok === false) {
    return result && result.message
      ? result.message
      : "The current file is not a PocketPages route, partial, module, or asset target.";
  }

  const lines = [
    "PocketPages File Explanation",
    "",
    `File: ${result.appRelativePath || formatExplainRelativePath(result.filePath) || result.filePath}`,
    `Kind: ${result.sourceKind || "file"}`,
    "",
    "Route",
  ];

  if (result.route) {
    const routeLabel = `${formatExplainRouteMethod(result.route.method)} ${result.route.path}`;
    lines.push(`  ${routeLabel}${result.route.method === "PAGE" ? " (page)" : ""}`);
    lines.push(`  Static: ${result.route.isStaticRoute ? "yes" : "no"}`);
  } else {
    lines.push("  (not a routable file)");
  }

  const params = Array.isArray(result.params) ? result.params : [];
  lines.push(`  Params: ${params.length ? params.join(", ") : "(none)"}`);
  lines.push("");
  lines.push("Execution");
  lines.push(`  Layout chain: ${formatExplainFileList(result.layoutChain)}`);
  lines.push(`  Middleware chain: ${formatExplainFileList(result.middlewareChain)}`);
  lines.push(`  Loaders: ${formatExplainLoaderList(result.loaders)}`);
  lines.push("");
  lines.push("References");
  lines.push(`  Inbound callers: ${result.references && result.references.count ? result.references.count : 0}`);
  if (result.references && result.references.queryKind) {
    lines.push(`  Inbound kind: ${result.references.queryKind}`);
  }
  lines.push(`  Route links: ${result.outgoing && result.outgoing.routeLinks ? result.outgoing.routeLinks : 0}`);
  lines.push(`  Includes: ${result.outgoing && result.outgoing.includes ? result.outgoing.includes : 0}`);
  lines.push(`  Resolves: ${result.outgoing && result.outgoing.resolves ? result.outgoing.resolves : 0}`);
  lines.push(`  Assets: ${result.outgoing && result.outgoing.assets ? result.outgoing.assets : 0}`);

  return lines.join("\n");
}

async function explainCurrentRoute(context) {
  const activeClient = await ensureLspStarted(context);
  if (!activeClient) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const result = await activeClient.sendRequest(REQUESTS.explainCurrentRoute, {
    uri: editor.document.uri.toString(),
  });
  const text = formatRouteExplanation(result);
  outputChannel.appendLine("");
  outputChannel.appendLine(text);
  outputChannel.show(true);
  clientLogger.info("command", "explain-current-route", {
    file: editor.document.uri.scheme === "file" ? getRelativePathLabel(editor.document.uri.fsPath) : editor.document.uri.toString(),
    route: result && result.route ? result.route.path : null,
    method: result && result.route ? result.route.method : null,
    layouts: result && Array.isArray(result.layoutChain) ? result.layoutChain.length : 0,
    middleware: result && Array.isArray(result.middlewareChain) ? result.middlewareChain.length : 0,
  });
}

async function copyDebugBundle(context) {
  const activeClient = await ensureLspStarted(context);
  const editor = vscode.window.activeTextEditor;
  let probeResult = null;
  let probeError = null;

  if (activeClient && editor && editor.document && editor.document.uri.scheme === "file") {
    try {
      probeResult = await activeClient.sendRequest(REQUESTS.probeCurrentFile, {
        uri: editor.document.uri.toString(),
      });
    } catch (error) {
      probeError = error;
    }
  }

  const bundle = buildDebugBundle({ context, probeResult, probeError });
  await vscode.env.clipboard.writeText(bundle);
  clientLogger.info("command", "copy-debug-bundle", {
    file: editor && editor.document && editor.document.uri.scheme === "file"
      ? getRelativePathLabel(editor.document.uri.fsPath)
      : null,
    probe: probeResult ? "ok" : probeError ? "failed" : "skipped",
    logLines: logBuffer.getLines().length,
  });
  vscode.window.showInformationMessage("PocketPages debug bundle copied to clipboard.");
}

async function activateLsp(context) {
  disposeLspRuntimeDisposables();
  ensureOutputChannel(context);
  if (!clientLogger) {
    clientLogger = createOutputLogger(outputChannel);
  }
  const logger = clientLogger;
  if (!lspStatusController) {
    lspStatusController = createLspStatusController(context, outputChannel);
    context.subscriptions.push(lspStatusController.item);
  }
  lspStatusController.setStarting();
  const serverModule = context.asAbsolutePath(path.join("packages", "language-server", "server.js"));
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const synchronizedFileWatchers = [
    vscode.workspace.createFileSystemWatcher("**/pb_hooks/**"),
    vscode.workspace.createFileSystemWatcher("**/pb_schema.json"),
    vscode.workspace.createFileSystemWatcher("**/pb_data/types.d.ts"),
    vscode.workspace.createFileSystemWatcher("**/pocketpages-globals.d.ts"),
    vscode.workspace.createFileSystemWatcher("**/types.d.ts"),
  ];
  const clientOptions = {
    documentSelector: LSP_DOCUMENT_SELECTOR,
    outputChannel,
    initializationOptions: {
      logSessionId,
      extensionVersion: getExtensionVersion(context),
      vscodeVersion: vscode.version,
      nodeVersion: process.version,
      workspaceFolderCount: getWorkspaceFolderCount(),
      workspaceFolders: getWorkspaceFolderLabels(),
    },
    synchronize: {
      fileEvents: synchronizedFileWatchers,
    },
  };

  client = new LanguageClient(
    "pocketpages",
    "PocketPages Language Server",
    serverOptions,
    clientOptions
  );
  const activeClient = client;

  lspRuntimeDisposables.push(
    activeClient.onDidChangeState((event) => {
      if (event.newState !== State.Stopped || client !== activeClient) {
        return;
      }

      client = null;
      disposeLspRuntimeDisposables();
      if (lspStatusController) {
        lspStatusController.setStopped();
      }

      if (lspStopRequested) {
        return;
      }

      logger.warn("lsp", "stopped-unexpectedly", {
        oldState: event.oldState,
        newState: event.newState,
      });
      scheduleLspRestartForActiveDocument(context, "unexpected-stop");
    })
  );

  lspRuntimeDisposables.push(...synchronizedFileWatchers);
  logger.info("lsp", "start", {
    extensionVersion: getExtensionVersion(context),
    vscodeVersion: vscode.version,
    nodeVersion: process.version,
    workspaceFolders: getWorkspaceFolderCount(),
    workspaceNames: getWorkspaceFolderLabels(),
    serverModule,
    selector: ["ejs", "pb_hooks-scripts"],
  });
  lspStopRequested = false;
  await client.start();
  lspStatusController.setReady();
  logger.info("lsp", "ready", {
    transport: "ipc",
  });
  logger.info("help", "log-groups", {
    levels: LOG_LEVELS,
    clientScopes: CLIENT_LOG_SCOPES,
    serverScopes: SERVER_LOG_SCOPES,
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

  lspRuntimeDisposables.push(
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
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    updateServerTemplateBoundariesForDocument(document, serverTemplateBoundaryDecoration);
  }
  lspStatusController.refreshVisibility();
  logger.info("lifecycle", "activate-complete", {
    openDocuments: vscode.workspace.textDocuments.filter((document) => isManagedLspDocument(document)).length,
  });
}

async function handleLspStartupFailure(context, error) {
  if (client) {
    lspStopRequested = true;
    try {
      await client.stop();
    } catch (_stopError) {}
    lspStopRequested = false;
    client = null;
  }
  disposeLspRuntimeDisposables();
  ensureOutputChannel(context);
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

async function ensureLspStarted(context) {
  if (lspStartPromise) {
    await lspStartPromise;
    return client;
  }

  if (client) {
    return client;
  }

  lspStartPromise = activateLsp(context)
    .catch(async (error) => {
      await handleLspStartupFailure(context, error);
    })
    .finally(() => {
      lspStartPromise = null;
    });

  await lspStartPromise;
  return client;
}

async function activate(context) {
  function maybeStartLspForDocument(document) {
    if (document && isManagedLspDocument(document)) {
      void ensureLspStarted(context);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pocketpagesServerScript.probeCurrentFile", async () => {
      const activeClient = await ensureLspStarted(context);
      if (!activeClient) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      const result = await activeClient.sendRequest(REQUESTS.probeCurrentFile, { uri: editor.document.uri.toString() });
      const message = [
        `path=${result.filePath}`,
        `hasAppRoot=${result.hasAppRoot ? "yes" : "no"}`,
        `diagnostics=${result.diagnostics}`,
      ].join(" | ");
      clientLogger.info("command", "probe", {
        file: vscode.workspace.asRelativePath(editor.document.uri.fsPath, false),
        hasAppRoot: result.hasAppRoot,
        diagnostics: result.diagnostics,
      });
      outputChannel.show(true);
      vscode.window.showInformationMessage(message);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.refreshDiagnostics", async () => {
      const activeClient = await ensureLspStarted(context);
      if (!activeClient) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      clientLogger.info("command", "refresh-diagnostics", {
        file: vscode.workspace.asRelativePath(editor.document.uri.fsPath, false),
      });
      await activeClient.sendRequest(REQUESTS.refreshDiagnostics, { uri: editor.document.uri.toString() });
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.reloadCaches", async () => {
      const activeClient = await ensureLspStarted(context);
      if (!activeClient) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const result = await activeClient.sendRequest(REQUESTS.reloadCaches, {
        uri: editor ? editor.document.uri.toString() : null,
      });
      clientLogger.info("cache", "reload", {
        file: editor && editor.document ? vscode.workspace.asRelativePath(editor.document.uri.fsPath, false) : null,
        scoped: result.scoped,
      });
      outputChannel.show(true);
      vscode.window.showInformationMessage(result.message);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.allFileReferences", async (resourceUri) => {
      const activeClient = await ensureLspStarted(context);
      if (!activeClient) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const fileUri = toVscodeUri(resourceUri) || (editor ? editor.document.uri : null);
      if (!fileUri) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }

      await showFileReferences({ logger: clientLogger, fileUri });
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.explainCurrentRoute", async () => {
      await explainCurrentRoute(context);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.extractPartial", async () => {
      await extractPartialFromSelection(context);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.copyDebugBundle", async () => {
      await copyDebugBundle(context);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.openCodeLensTarget", async (resourceUri) => {
      const fileUri = toVscodeUri(resourceUri);
      if (!fileUri) {
        vscode.window.showWarningMessage("Unable to resolve the target file.");
        return;
      }

      await vscode.commands.executeCommand("vscode.open", fileUri);
    }),
    vscode.commands.registerCommand("pocketpagesServerScript.noopCodeLens", () => {}),
    typeof vscode.workspace.onWillRenameFiles === "function"
      ? vscode.workspace.onWillRenameFiles((event) => handleManagedFileWillRenameEvent(context, event))
      : vscode.workspace.onDidRenameFiles((event) => handleManagedFileRenameEvent(context, event)),
    vscode.workspace.onDidOpenTextDocument((document) => maybeStartLspForDocument(document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      maybeStartLspForDocument(editor && editor.document);
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    maybeStartLspForDocument(document);
  }
}

async function deactivate() {
  if (client) {
    const activeClient = client;
    client = null;
    lspStartPromise = null;
    lspStopRequested = true;
    if (lspStatusController) {
      lspStatusController.setStopped();
    }
    try {
      return await activeClient.stop();
    } finally {
      lspStopRequested = false;
      disposeLspRuntimeDisposables();
    }
  }

  lspStartPromise = null;
  disposeLspRuntimeDisposables();
  if (lspStatusController) {
    lspStatusController.setStopped();
  }
}

module.exports = {
  activate,
  deactivate,
};
