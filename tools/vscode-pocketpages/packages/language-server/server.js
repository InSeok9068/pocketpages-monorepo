"use strict";

const path = require("path");
const {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItemKind,
  InsertTextFormat,
  DiagnosticSeverity,
  CodeActionKind,
  MarkupKind,
  InlayHintKind,
  SymbolKind,
  SemanticTokensBuilder,
  FileChangeType,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");
const { URI } = require("vscode-uri");
const { PocketPagesLanguageCore, uriToFilePath } = require("../language-core/language-core");
const { REQUESTS, NOTIFICATIONS } = require("./protocol");
const { ts, findAppRoot } = require("../language-service/language-service");
const { TOKEN_TYPES, collectEjsSemanticTokenEntries, getTokenTypeIndex } = require("./ejs-semantic-tokens");
const { getServerTemplateBoundaryLineNumbers } = require("../language-core/ejs-server-boundary");
const { createCustomFeatureService } = require("./services/custom-features");
const { createTypeScriptFeatureService } = require("./services/ts-features");
const { createDiagnosticsFeatureService } = require("./services/diagnostics-features");
const { createLifecycleFeatureService } = require("./services/lifecycle-features");
const { createMaintenanceFeatureService } = require("./services/maintenance-features");
const { createStructureFeatureService } = require("./services/structure-features");
const { shouldReuseLastCompletion } = require("./services/completion-helpers");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const core = new PocketPagesLanguageCore({
  logger: {
    log(message) {
      connection.console.log(message);
    },
  },
});

const SCRIPT_DIAGNOSTICS_DEBOUNCE_MS = 400;
const SCRIPT_SEMANTIC_DIAGNOSTICS_IDLE_MS = 1800;
const LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50000;
const LARGE_DOCUMENT_DIAGNOSTICS_IDLE_MS = 5000;
const COMPLETION_TRIGGER_CHARACTERS = [".", "'", "\"", "`", "/", "{", ","];
const SIGNATURE_TRIGGER_CHARACTERS = ["(", ","];
const diagnosticTimeouts = new Map();
const semanticDiagnosticTimeouts = new Map();
const diagnosticRunIds = new Map();
const completionCache = new Map();
const lastCompletionByUri = new Map();

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

function logServer(level, scope, message, fields = {}) {
  connection.console.log(
    `[${getLogTimestamp()}] [server] [${scope}] [${level}] ${message}${formatLogFields(fields)}`
  );
}

const COMPLETION_KIND_MAP = {
  [ts.ScriptElementKind.primitiveType]: CompletionItemKind.Keyword,
  [ts.ScriptElementKind.keyword]: CompletionItemKind.Keyword,
  [ts.ScriptElementKind.constElement]: CompletionItemKind.Constant,
  [ts.ScriptElementKind.letElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.variableElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.localVariableElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.alias]: CompletionItemKind.Reference,
  [ts.ScriptElementKind.memberVariableElement]: CompletionItemKind.Field,
  [ts.ScriptElementKind.memberGetAccessorElement]: CompletionItemKind.Field,
  [ts.ScriptElementKind.memberSetAccessorElement]: CompletionItemKind.Field,
  [ts.ScriptElementKind.functionElement]: CompletionItemKind.Function,
  [ts.ScriptElementKind.localFunctionElement]: CompletionItemKind.Function,
  [ts.ScriptElementKind.memberFunctionElement]: CompletionItemKind.Method,
  [ts.ScriptElementKind.constructSignatureElement]: CompletionItemKind.Constructor,
  [ts.ScriptElementKind.callSignatureElement]: CompletionItemKind.Function,
  [ts.ScriptElementKind.indexSignatureElement]: CompletionItemKind.Property,
  [ts.ScriptElementKind.enumElement]: CompletionItemKind.Enum,
  [ts.ScriptElementKind.moduleElement]: CompletionItemKind.Module,
  [ts.ScriptElementKind.classElement]: CompletionItemKind.Class,
  [ts.ScriptElementKind.interfaceElement]: CompletionItemKind.Interface,
  [ts.ScriptElementKind.warning]: CompletionItemKind.Text,
};

function elapsedMilliseconds(startTime) {
  return Number(process.hrtime.bigint() - startTime) / 1e6;
}

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

function isExcludedPocketPagesScriptPath(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  if (!normalizedPath.includes("/pb_hooks/pages/")) {
    return false;
  }

  const pagesRelativePath = normalizedPath.split("/pb_hooks/pages/")[1] || "";
  const relativeSegments = pagesRelativePath.split("/").filter(Boolean);
  if (hasPrivatePagesSegment(normalizedPath)) {
    return false;
  }

  return (
    relativeSegments.includes("vendor") ||
    normalizedPath.endsWith(".min.js") ||
    normalizedPath.endsWith(".min.cjs") ||
    normalizedPath.endsWith(".min.mjs")
  );
}

function isEjsFilePath(filePath) {
  return String(filePath || "").toLowerCase().endsWith(".ejs");
}

function isScriptFilePath(filePath) {
  return [".js", ".cjs", ".mjs"].includes(path.extname(String(filePath || "")).toLowerCase());
}

function isSchemaSupportOnlyHookScriptPath(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  return (
    normalizedPath.includes("/pb_hooks/") &&
    !normalizedPath.includes("/pb_hooks/pages/") &&
    isScriptFilePath(normalizedPath) &&
    !!findAppRoot(normalizedPath)
  );
}

function shouldSkipInvokeBeforeMemberAccess(documentText, offset, context) {
  if (!isFinite(offset) || !context || context.triggerKind !== 1) {
    return false;
  }

  return offset >= 0 && offset < documentText.length && documentText[offset] === ".";
}

function customCompletionKind(category) {
  switch (category) {
    case "resolve-path":
    case "include-path":
    case "route-path":
      return CompletionItemKind.File;
    case "include-local":
      return CompletionItemKind.Property;
    case "collection-name":
      return CompletionItemKind.Struct;
    case "record-field":
      return CompletionItemKind.Field;
    default:
      return CompletionItemKind.Text;
  }
}

function diagnosticSeverity(category) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
    case ts.DiagnosticCategory.Message:
    default:
      return DiagnosticSeverity.Information;
  }
}

function formatCompletionTrigger(context) {
  if (!context) {
    return "unknown";
  }

  if (context.triggerKind === 2) {
    return `char:${context.triggerCharacter || ""}`;
  }

  if (context.triggerKind === 3) {
    return "incomplete";
  }

  if (context.triggerKind === 1) {
    return "invoke";
  }

  return `kind:${context.triggerKind}`;
}

function formatCompletionProfile(profile) {
  if (!profile) {
    return "";
  }

  const parts = [];
  if (typeof profile.getVirtualStateAtOffsetMs === "number") {
    parts.push(`getVirtualState=${profile.getVirtualStateAtOffsetMs.toFixed(1)}ms`);
  }
  if (typeof profile.upsertMs === "number") {
    parts.push(`${profile.upsertKind || "upsert"}=${profile.upsertMs.toFixed(1)}ms`);
  }
  if (typeof profile.getCompletionsAtPositionMs === "number") {
    parts.push(`tsLS=${profile.getCompletionsAtPositionMs.toFixed(1)}ms`);
  }

  return parts.length ? ` ${parts.join(" ")}` : "";
}

function getCompletionProfileFields(profile) {
  if (!profile) {
    return {};
  }

  return {
    getVirtualStateMs:
      typeof profile.getVirtualStateAtOffsetMs === "number"
        ? profile.getVirtualStateAtOffsetMs.toFixed(1)
        : null,
    upsertKind: profile.upsertKind || null,
    upsertMs: typeof profile.upsertMs === "number" ? profile.upsertMs.toFixed(1) : null,
    tsLsMs:
      typeof profile.getCompletionsAtPositionMs === "number"
        ? profile.getCompletionsAtPositionMs.toFixed(1)
        : null,
  };
}

function formatDiagnosticsProfile(profile) {
  if (!profile) {
    return "";
  }

  const parts = [];
  if (typeof profile.createDocumentAnalysisMs === "number") {
    parts.push(`analysis=${profile.createDocumentAnalysisMs.toFixed(1)}ms`);
  }
  if (typeof profile.collectClientScriptSyntacticDiagnosticsMs === "number") {
    parts.push(`client=${profile.collectClientScriptSyntacticDiagnosticsMs.toFixed(1)}ms`);
  }
  if (typeof profile.collectPrivateResolveDiagnosticsMs === "number") {
    parts.push(`private=${profile.collectPrivateResolveDiagnosticsMs.toFixed(1)}ms`);
  }
  if (typeof profile.collectServerBlockDiagnosticsMs === "number") {
    parts.push(`server=${profile.collectServerBlockDiagnosticsMs.toFixed(1)}ms`);
  }
  if (typeof profile.collectTemplateDiagnosticsMs === "number") {
    parts.push(`template=${profile.collectTemplateDiagnosticsMs.toFixed(1)}ms`);
  }
  if (typeof profile.collectScriptSchemaDiagnosticsMs === "number") {
    parts.push(`schema=${profile.collectScriptSchemaDiagnosticsMs.toFixed(1)}ms`);
  }
  if (typeof profile.collectProjectRuleDiagnosticsMs === "number") {
    parts.push(`rules=${profile.collectProjectRuleDiagnosticsMs.toFixed(1)}ms`);
  }
  if (typeof profile.dedupeDiagnosticsMs === "number") {
    parts.push(`dedupe=${profile.dedupeDiagnosticsMs.toFixed(1)}ms`);
  }

  return parts.length ? ` ${parts.join(" ")}` : "";
}

function getDiagnosticsProfileFields(profile) {
  if (!profile) {
    return {};
  }

  return {
    analysisMs:
      typeof profile.createDocumentAnalysisMs === "number"
        ? profile.createDocumentAnalysisMs.toFixed(1)
        : null,
    clientMs:
      typeof profile.collectClientScriptSyntacticDiagnosticsMs === "number"
        ? profile.collectClientScriptSyntacticDiagnosticsMs.toFixed(1)
        : null,
    privateMs:
      typeof profile.collectPrivateResolveDiagnosticsMs === "number"
        ? profile.collectPrivateResolveDiagnosticsMs.toFixed(1)
        : null,
    serverMs:
      typeof profile.collectServerBlockDiagnosticsMs === "number"
        ? profile.collectServerBlockDiagnosticsMs.toFixed(1)
        : null,
    templateMs:
      typeof profile.collectTemplateDiagnosticsMs === "number"
        ? profile.collectTemplateDiagnosticsMs.toFixed(1)
        : null,
    schemaMs:
      typeof profile.collectScriptSchemaDiagnosticsMs === "number"
        ? profile.collectScriptSchemaDiagnosticsMs.toFixed(1)
        : null,
    rulesMs:
      typeof profile.collectProjectRuleDiagnosticsMs === "number"
        ? profile.collectProjectRuleDiagnosticsMs.toFixed(1)
        : null,
    dedupeMs:
      typeof profile.dedupeDiagnosticsMs === "number"
        ? profile.dedupeDiagnosticsMs.toFixed(1)
        : null,
  };
}

function toRange(document, start, end) {
  return {
    start: document.positionAt(start),
    end: document.positionAt(end),
  };
}

function toMarkupContent(signature, documentation) {
  if (!signature && !documentation) {
    return null;
  }

  const parts = [];
  if (signature) {
    parts.push("```ts");
    parts.push(signature);
    parts.push("```");
  }
  if (documentation) {
    parts.push(documentation);
  }

  return {
    kind: MarkupKind.Markdown,
    value: parts.join("\n\n"),
  };
}

function toWorkspaceEdit(edits) {
  const changes = {};

  for (const edit of edits || []) {
    const targetUri = URI.file(edit.filePath).toString();
    const targetDocument = documents.get(targetUri) || TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(edit.filePath));
    if (!changes[targetUri]) {
      changes[targetUri] = [];
    }

    changes[targetUri].push({
      range: toRange(targetDocument, edit.start, edit.end),
      newText: edit.newText,
    });
  }

  return { changes };
}

function toLocation(target) {
  if (!target) {
    return null;
  }

  if (typeof target === "string") {
    return {
      uri: URI.file(target).toString(),
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
  }

  return {
    uri: URI.file(target.filePath).toString(),
    range: {
      start: { line: target.line || 0, character: target.character || 0 },
      end: { line: target.line || 0, character: target.character || 0 },
    },
  };
}

function toSignatureHelp(signatureHelpItems) {
  if (!signatureHelpItems || !signatureHelpItems.items || !signatureHelpItems.items.length) {
    return null;
  }

  return {
    activeSignature: signatureHelpItems.selectedItemIndex || 0,
    activeParameter: signatureHelpItems.argumentIndex || 0,
    signatures: signatureHelpItems.items.map((item) => {
      const prefix = ts.displayPartsToString(item.prefixDisplayParts || []);
      const suffix = ts.displayPartsToString(item.suffixDisplayParts || []);
      const separator = ts.displayPartsToString(item.separatorDisplayParts || []);
      let label = prefix;
      const parameters = [];

      item.parameters.forEach((parameter, index) => {
        if (index > 0) {
          label += separator;
        }

        const parameterLabel = ts.displayPartsToString(parameter.displayParts || []);
        const start = label.length;
        label += parameterLabel;
        parameters.push({
          label: [start, label.length],
          documentation: ts.displayPartsToString(parameter.documentation || []),
        });
      });

      label += suffix;
      return {
        label,
        documentation: ts.displayPartsToString(item.documentation || []),
        parameters,
      };
    }),
  };
}

function completionCacheKey(uri, version, offset) {
  return `${uri}::${version}::${offset}`;
}

function getCachedCompletionItems(cacheKey) {
  if (!completionCache.has(cacheKey)) {
    return undefined;
  }

  const cachedValue = completionCache.get(cacheKey);
  completionCache.delete(cacheKey);
  completionCache.set(cacheKey, cachedValue);
  return cachedValue;
}

function getReusableCompletionItems(uri, document, offset, context) {
  const position = document.positionAt(offset);
  const lastCompletion = lastCompletionByUri.get(uri);
  if (
    shouldReuseLastCompletion(lastCompletion, {
      uri,
      version: document.version,
      line: position.line,
      character: position.character,
      triggerKind: context && context.triggerKind,
    })
  ) {
    return lastCompletion.result;
  }

  return undefined;
}

function rememberReusableCompletionItems(uri, document, offset, result) {
  if (!result) {
    lastCompletionByUri.delete(uri);
    return;
  }

  const position = document.positionAt(offset);
  lastCompletionByUri.set(uri, {
    uri,
    version: document.version,
    line: position.line,
    character: position.character,
    result,
  });
}

function setCachedCompletionItems(cacheKey, value) {
  completionCache.set(cacheKey, value);
  while (completionCache.size > 60) {
    const oldestKey = completionCache.keys().next().value;
    completionCache.delete(oldestKey);
  }
}

function clearCachedCompletionItemsForUri(uri) {
  for (const key of [...completionCache.keys()]) {
    if (key.startsWith(`${uri}::`)) {
      completionCache.delete(key);
    }
  }
  lastCompletionByUri.delete(uri);
}

function isCancellationRequested(token) {
  return !!(token && token.isCancellationRequested);
}

function isStaleDocumentVersion(uri, version) {
  const document = documents.get(uri);
  return !document || document.version !== version;
}

function shouldAbortDocumentRequest(uri, version, token) {
  return isCancellationRequested(token) || isStaleDocumentVersion(uri, version);
}

function beginDiagnosticRun(uri) {
  const runId = (diagnosticRunIds.get(uri) || 0) + 1;
  diagnosticRunIds.set(uri, runId);
  return runId;
}

function isActiveDiagnosticRun(uri, runId) {
  return diagnosticRunIds.get(uri) === runId;
}

function scheduleDiagnostics(uri) {
  return diagnosticsFeatureService.scheduleDiagnostics(uri);
}

function cancelScheduledDiagnostics(uri, options) {
  return diagnosticsFeatureService.cancelScheduledDiagnostics(uri, options);
}

function getSemanticTokens(documentText, document) {
  const builder = new SemanticTokensBuilder();
  const entries = collectEjsSemanticTokenEntries(documentText);
  for (const entry of entries) {
    const tokenTypeIndex = getTokenTypeIndex(entry.tokenType);
    if (tokenTypeIndex === null) {
      continue;
    }

    let currentOffset = entry.start;
    const endOffset = entry.start + entry.length;
    while (currentOffset < endOffset) {
      const start = document.positionAt(currentOffset);
      let lineEndOffset = documentText.indexOf("\n", currentOffset);
      if (lineEndOffset === -1 || lineEndOffset > endOffset) {
        lineEndOffset = endOffset;
      }

      const chunkLength = Math.max(0, lineEndOffset - currentOffset);
      if (chunkLength > 0) {
        builder.push(start.line, start.character, chunkLength, tokenTypeIndex, 0);
      }

      currentOffset = lineEndOffset + 1;
      if (lineEndOffset === endOffset) {
        break;
      }
    }
  }

  return builder.build();
}

function getRelativePathLabel(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

const featureServiceContext = {
  connection,
  documents,
  core,
  URI,
  TextDocument,
  FileChangeType,
  ts,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  InlayHintKind,
  SymbolKind,
  CodeActionKind,
  SemanticTokensBuilder,
  collectEjsSemanticTokenEntries,
  getTokenTypeIndex,
  getServerTemplateBoundaryLineNumbers,
  state: {
    diagnosticTimeouts,
    semanticDiagnosticTimeouts,
    diagnosticRunIds,
    completionCache,
    lastCompletionByUri,
  },
  helpers: {
    COMPLETION_KIND_MAP,
    SCRIPT_DIAGNOSTICS_DEBOUNCE_MS,
    SCRIPT_SEMANTIC_DIAGNOSTICS_IDLE_MS,
    LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT,
    LARGE_DOCUMENT_DIAGNOSTICS_IDLE_MS,
    beginDiagnosticRun,
    cancelScheduledDiagnostics,
    clearCachedCompletionItemsForUri,
    customCompletionKind,
    diagnosticSeverity,
    elapsedMilliseconds,
    formatCompletionTrigger,
    getDocumentByUri: (uri) => documents.get(uri),
    getDocumentContextByFilePath: (filePath) => core.getDocumentContextByFilePath(filePath),
    getDocumentContextByUri: (uri) => core.getDocumentContextByUri(uri),
    getCompletionProfileFields,
    getDiagnosticsProfileFields,
    getRelativePathLabel,
    hasPrivatePagesSegment,
    isActiveDiagnosticRun,
    isEjsFilePath,
    isExcludedPocketPagesScriptPath,
    isScriptFilePath,
    isSchemaSupportOnlyHookScriptPath,
    isStaleDocumentVersion,
    logServer,
    publishDiagnostics,
    scheduleDiagnostics,
    shouldAbortDocumentRequest,
    toLocation,
    toMarkupContent,
    toRange,
    toSignatureHelp,
    toWorkspaceEdit,
    uriToFilePath,
  },
};

const customFeatureService = createCustomFeatureService(featureServiceContext);
const typeScriptFeatureService = createTypeScriptFeatureService(featureServiceContext);
const diagnosticsFeatureService = createDiagnosticsFeatureService(featureServiceContext);
const lifecycleFeatureService = createLifecycleFeatureService(featureServiceContext);
const maintenanceFeatureService = createMaintenanceFeatureService(featureServiceContext);
const structureFeatureService = createStructureFeatureService(featureServiceContext);

function publishDiagnostics(uri, options) {
  return diagnosticsFeatureService.publishDiagnostics(uri, options);
}

function publishManagedDiagnostics() {
  return diagnosticsFeatureService.publishManagedDiagnostics();
}

connection.onInitialize(() => {
  logServer("info", "lifecycle", "initialize", {
    pid: process.pid,
    cwd: process.cwd(),
  });
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: false,
      },
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      codeActionProvider: true,
      documentLinkProvider: {},
      signatureHelpProvider: {
        triggerCharacters: SIGNATURE_TRIGGER_CHARACTERS,
        retriggerCharacters: SIGNATURE_TRIGGER_CHARACTERS,
      },
      inlayHintProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: TOKEN_TYPES,
          tokenModifiers: [],
        },
        full: true,
      },
      codeLensProvider: {
        resolveProvider: false,
      },
    },
  };
});

documents.onDidOpen((event) => lifecycleFeatureService.handleDidOpen(event));

documents.onDidChangeContent((event) => lifecycleFeatureService.handleDidChangeContent(event));

documents.onDidClose((event) => lifecycleFeatureService.handleDidClose(event));

connection.onDidChangeWatchedFiles((event) => lifecycleFeatureService.handleDidChangeWatchedFiles(event));

connection.onCompletion((params, token) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context || isExcludedPocketPagesScriptPath(context.filePath)) {
    return null;
  }

  const startedAt = process.hrtime.bigint();
  const offset = document.offsetAt(params.position);
  const documentText = document.getText();
  const requestedVersion = document.version;
  const relativePath = getRelativePathLabel(context.filePath);
  const trigger = formatCompletionTrigger(params.context);

  if (shouldSkipInvokeBeforeMemberAccess(documentText, offset, params.context)) {
    logServer("info", "completion", "skip", {
      file: relativePath,
      trigger,
      offset,
      reason: "invoke-before-dot",
      totalMs: elapsedMilliseconds(startedAt).toFixed(1),
    });
    return null;
  }

  const cacheKey = completionCacheKey(document.uri, document.version, offset);
  const cachedItems = getCachedCompletionItems(cacheKey);
  if (cachedItems !== undefined) {
    logServer("perf", "completion", "cache-hit", {
      file: relativePath,
      trigger,
      offset,
      count: cachedItems ? cachedItems.items.length : 0,
      totalMs: elapsedMilliseconds(startedAt).toFixed(1),
    });
    return cachedItems;
  }

  const reusableItems = getReusableCompletionItems(document.uri, document, offset, params.context);
  if (reusableItems !== undefined) {
    logServer("perf", "completion", "near-cache-hit", {
      file: relativePath,
      trigger,
      offset,
      count: reusableItems ? reusableItems.items.length : 0,
      totalMs: elapsedMilliseconds(startedAt).toFixed(1),
    });
    return reusableItems;
  }

  const customStartedAt = process.hrtime.bigint();
  const customResult = customFeatureService.provideCompletionItems(params);
  const customElapsedMs = elapsedMilliseconds(customStartedAt);
  const isSchemaSupportOnlyDocument = isSchemaSupportOnlyHookScriptPath(context.filePath);

  if (shouldAbortDocumentRequest(document.uri, requestedVersion, token)) {
    logServer("warn", "completion", "abort", {
      file: relativePath,
      trigger,
      offset,
      stage: "custom",
      totalMs: elapsedMilliseconds(startedAt).toFixed(1),
    });
    return null;
  }

  if (customResult) {
    const result = customResult.items.length ? customResult : null;
    setCachedCompletionItems(cacheKey, result);
    rememberReusableCompletionItems(document.uri, document, offset, result);
    logServer("perf", "completion", "custom", {
      file: relativePath,
      trigger,
      offset,
      count: customResult.items.length,
      getCustomMs: customElapsedMs.toFixed(1),
      totalMs: elapsedMilliseconds(startedAt).toFixed(1),
    });
    return result;
  }

  if (isSchemaSupportOnlyDocument) {
    setCachedCompletionItems(cacheKey, null);
    return null;
  }

  const result = typeScriptFeatureService.provideCompletionItems(params, token);
  setCachedCompletionItems(cacheKey, result || null);
  rememberReusableCompletionItems(document.uri, document, offset, result || null);
  return result;
});

connection.onCompletionResolve((item) => {
  return typeScriptFeatureService.resolveCompletionItem(item);
});

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const documentContext = core.getDocumentContextByUri(params.textDocument.uri);
  if (!documentContext) {
    return null;
  }

  const pathTargetInfo = customFeatureService.provideHover(params);
  if (pathTargetInfo) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value:
          pathTargetInfo.kind === "route-path" && pathTargetInfo.value
            ? `Target: \`${pathTargetInfo.targetFilePath.replace(/\\/g, "/")}\`\n\nRoute: \`${pathTargetInfo.value}\``
            : `Target: \`${pathTargetInfo.targetFilePath.replace(/\\/g, "/")}\``,
      },
      range: toRange(document, pathTargetInfo.start, pathTargetInfo.end),
    };
  }

  if (!isEjsFilePath(documentContext.filePath)) {
    return null;
  }

  const quickInfo = typeScriptFeatureService.provideHover(params);
  if (!quickInfo || quickInfo.start === null || quickInfo.end === null) {
    return null;
  }

  const parts = [];
  if (quickInfo.displayText) {
    parts.push("```ts");
    parts.push(quickInfo.displayText);
    parts.push("```");
  }
  if (quickInfo.documentation) {
    parts.push(quickInfo.documentation);
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: parts.join("\n\n"),
    },
    range: toRange(document, quickInfo.start, quickInfo.end),
  };
});

connection.onDefinition((params) => {
  const customTarget = customFeatureService.provideDefinition(params);
  if (customTarget) {
    return toLocation(customTarget);
  }

  return toLocation(typeScriptFeatureService.provideDefinition(params));
});

connection.onReferences((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  const customReferences = customFeatureService.provideReferences(params);
  if (customReferences) {
    return customReferences.map((reference) => {
      const targetUri = URI.file(reference.filePath).toString();
      const targetDocument = documents.get(targetUri) || TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
      return {
        uri: targetUri,
        range: toRange(targetDocument, reference.start, reference.end),
      };
    });
  }

  const offset = document.offsetAt(params.position);
  const includeDeclaration = !!(params.context && params.context.includeDeclaration);
  const typeScriptReferenceResult = context.service.getTypeScriptReferenceTargets(
    context.filePath,
    document.getText(),
    offset,
    { includeDeclaration }
  );
  const fileReferenceContext = context.service.getPrivateIncludeReferenceContext(context.filePath);

  if (
    typeScriptReferenceResult &&
    typeScriptReferenceResult.locations.length &&
    (!fileReferenceContext ||
      typeScriptReferenceResult.hasMappedDefinition ||
      typeScriptReferenceResult.hasExternalReference)
  ) {
    return typeScriptReferenceResult.locations.map((reference) => {
      const targetUri = URI.file(reference.filePath).toString();
      const targetDocument =
        documents.get(targetUri) ||
        TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
      return {
        uri: targetUri,
        range: toRange(targetDocument, reference.start, reference.end),
      };
    });
  }

  if (!fileReferenceContext) {
    return null;
  }

  const fileReferences =
    context.service.getFileReferenceTargets(context.filePath, document.getText(), {
      includeDeclaration,
    }) || [];
  if (!fileReferences.length) {
    return null;
  }

  return fileReferences.map((reference) => {
    const targetUri = URI.file(reference.filePath).toString();
    const targetDocument =
      documents.get(targetUri) ||
      TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
    return {
      uri: targetUri,
      range: toRange(targetDocument, reference.start, reference.end),
    };
  });
});

connection.onCodeAction((params) => {
  return diagnosticsFeatureService.provideCodeActions(params);
});

connection.onPrepareRename((params) => {
  return (
    customFeatureService.providePrepareRename(params) ||
    typeScriptFeatureService.providePrepareRename(params)
  );
});

connection.onRenameRequest((params) => {
  return (
    customFeatureService.provideRename(params) ||
    typeScriptFeatureService.provideRename(params)
  );
});

connection.onDocumentLinks((params) => {
  return customFeatureService.provideDocumentLinks(params);
});

connection.onSignatureHelp((params) => {
  return (
    customFeatureService.provideSignatureHelp(params) ||
    typeScriptFeatureService.provideSignatureHelp(params)
  );
});

connection.languages.inlayHint.on((params) => {
  return typeScriptFeatureService.provideInlayHints(params);
});

connection.languages.semanticTokens.on((params) => {
  return structureFeatureService.provideSemanticTokens(params);
});

connection.onDocumentSymbol((params) => {
  return structureFeatureService.provideDocumentSymbols(params);
});

connection.onWorkspaceSymbol((params) => {
  return structureFeatureService.provideWorkspaceSymbols(params);
});

connection.onCodeLens((params) => {
  return structureFeatureService.provideCodeLens(params);
});

connection.onRequest(REQUESTS.probeCurrentFile, ({ uri }) => {
  return maintenanceFeatureService.provideProbeCurrentFile({ uri });
});

connection.onRequest(REQUESTS.refreshDiagnostics, ({ uri }) => {
  return maintenanceFeatureService.provideRefreshDiagnostics({ uri });
});

connection.onRequest(REQUESTS.reloadCaches, ({ uri }) => {
  const result = maintenanceFeatureService.provideReloadCaches({ uri });
  publishManagedDiagnostics();
  return result;
});

connection.onRequest(REQUESTS.allFileReferences, ({ uri }) => {
  return maintenanceFeatureService.provideAllFileReferences({ uri });
});

connection.onRequest(REQUESTS.fileRenameEdits, ({ oldUri, newUri }) => {
  return maintenanceFeatureService.provideFileRenameEdits({ oldUri, newUri });
});

connection.onNotification(NOTIFICATIONS.didManualSave, ({ uri }) => {
  lifecycleFeatureService.handleDidManualSave({ uri });
});

documents.listen(connection);
connection.listen();
