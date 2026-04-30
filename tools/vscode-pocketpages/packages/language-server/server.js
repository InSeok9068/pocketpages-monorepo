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
const { createDocumentRuntimeStateRegistry } = require("./document-runtime-state");
const { createRequestCoordinator } = require("./request-coordinator");

const pendingDocumentContentChanges = new Map();
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments({
  create: TextDocument.create,
  update(document, changes, version) {
    pendingDocumentContentChanges.set(
      documentContentChangeKey(document.uri, version),
      Array.isArray(changes) ? changes.slice() : []
    );
    return TextDocument.update(document, changes, version);
  },
});
const core = new PocketPagesLanguageCore({
  logger: {
    log(message) {
      connection.console.log(message);
    },
  },
});

const LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT = 50000;
const LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS = 3000;
const PULL_DIAGNOSTICS_INITIAL_YIELD_MS = 120;
const LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET = 2;
const FIRST_REQUEST_WARMUP_IDLE_MS = 700;
const COMPLETION_TRIGGER_CHARACTERS = [".", "'", "\"", "`", "/", "{", ","];
const SIGNATURE_TRIGGER_CHARACTERS = ["(", ","];
const diagnosticRunIds = new Map();
const completionCache = new Map();
const lastCompletionByUri = new Map();
const lastInteractiveOffsetByUri = new Map();
const documentRuntimeState = createDocumentRuntimeStateRegistry();
const requestCoordinator = createRequestCoordinator({ runtimeState: documentRuntimeState });
let pullDiagnosticRefreshSupported = false;
let serverRequestSequence = 0;

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

function nextRequestId(prefix) {
  serverRequestSequence += 1;
  return `${prefix}:${serverRequestSequence}`;
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

function formatMilliseconds(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : null;
}

function getPerformanceBucket(kind, totalMs) {
  const elapsed = Number(totalMs);
  if (!Number.isFinite(elapsed)) {
    return null;
  }

  let thresholds;
  if (kind === "completion") {
    thresholds = { ok: 75, warm: 180, slow: 350 };
  } else if (kind === "diagnostics") {
    thresholds = { ok: 250, warm: 900, slow: 3000 };
  } else if (kind === "navigation") {
    thresholds = { ok: 80, warm: 200, slow: 600 };
  } else if (kind === "structure") {
    thresholds = { ok: 120, warm: 350, slow: 1000 };
  } else {
    thresholds = { ok: 100, warm: 300, slow: 1000 };
  }

  if (elapsed <= thresholds.ok) {
    return "ok";
  }
  if (elapsed <= thresholds.warm) {
    return "warm";
  }
  if (elapsed <= thresholds.slow) {
    return "slow";
  }
  return "blocked";
}

function getDominantStep(steps) {
  let selected = null;
  for (const step of Array.isArray(steps) ? steps : []) {
    const elapsed = Number(step && step.ms);
    if (!step || !step.name || !Number.isFinite(elapsed)) {
      continue;
    }

    if (!selected || elapsed > selected.ms) {
      selected = {
        name: step.name,
        ms: elapsed,
      };
    }
  }

  return selected;
}

function getSampleList(value, limit = 8) {
  if (!Array.isArray(value) || !value.length) {
    return null;
  }

  return value.slice(0, Math.max(0, limit));
}

function resultCount(value) {
  if (!value) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.length;
  }

  if (Array.isArray(value.items)) {
    return value.items.length;
  }

  if (Array.isArray(value.data)) {
    return Math.floor(value.data.length / 5);
  }

  return 1;
}

function countDocumentSymbols(entries) {
  let count = 0;
  const visit = (entry) => {
    if (!entry) {
      return;
    }

    count += 1;
    for (const child of Array.isArray(entry.children) ? entry.children : []) {
      visit(child);
    }
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    visit(entry);
  }
  return count;
}

function workspaceEditStats(edit) {
  if (!edit || typeof edit !== "object") {
    return {
      files: 0,
      edits: 0,
    };
  }

  let files = 0;
  let edits = 0;
  if (edit.changes && typeof edit.changes === "object") {
    for (const fileEdits of Object.values(edit.changes)) {
      files += 1;
      edits += Array.isArray(fileEdits) ? fileEdits.length : 0;
    }
  }

  if (Array.isArray(edit.documentChanges)) {
    for (const documentChange of edit.documentChanges) {
      files += 1;
      edits += Array.isArray(documentChange && documentChange.edits)
        ? documentChange.edits.length
        : 1;
    }
  }

  return { files, edits };
}

function logRequestResult(scope, message, startedAt, fields = {}, kind = "navigation") {
  const totalMs = elapsedMilliseconds(startedAt);
  logServer("perf", scope, message, {
    ...fields,
    totalMs: totalMs.toFixed(1),
    perf: getPerformanceBucket(kind, totalMs),
  });
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

  const dominantStep = getDominantStep([
    { name: "prepare", ms: profile.prepareMs },
    { name: "virtual-state", ms: profile.getVirtualStateAtOffsetMs },
    { name: "upsert", ms: profile.upsertMs },
    { name: "ts-ls", ms: profile.getCompletionsAtPositionMs },
  ]);

  return {
    prepareMs: formatMilliseconds(profile.prepareMs),
    getVirtualStateMs:
      typeof profile.getVirtualStateAtOffsetMs === "number"
        ? profile.getVirtualStateAtOffsetMs.toFixed(1)
        : null,
    upsertKind: profile.upsertKind || null,
    upsertMs: formatMilliseconds(profile.upsertMs),
    tsLsMs:
      typeof profile.getCompletionsAtPositionMs === "number"
        ? profile.getCompletionsAtPositionMs.toFixed(1)
        : null,
    bottleneck: dominantStep ? dominantStep.name : null,
    bottleneckMs: dominantStep ? formatMilliseconds(dominantStep.ms) : null,
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

  const dominantStep = getDominantStep([
    { name: "analysis", ms: profile.createDocumentAnalysisMs },
    { name: "prepare", ms: profile.prepareDiagnosticsVirtualStateMs },
    { name: "client", ms: profile.collectClientScriptSyntacticDiagnosticsMs },
    { name: "private", ms: profile.collectPrivateResolveDiagnosticsMs },
    { name: "server", ms: profile.collectServerBlockDiagnosticsMs },
    { name: "template", ms: profile.collectTemplateDiagnosticsMs },
    { name: "schema", ms: profile.collectScriptSchemaDiagnosticsMs },
    { name: "rules", ms: profile.collectProjectRuleDiagnosticsMs },
    { name: "dedupe", ms: profile.dedupeDiagnosticsMs },
  ]);

  return {
    semantic: profile.includeSemanticDiagnostics,
    typeScript: profile.includeTypeScriptDiagnostics,
    rules: profile.includeProjectRuleDiagnostics,
    serverBlocks: profile.includeServerBlockDiagnostics,
    templateBlocks: profile.includeTemplateDiagnostics,
    scriptSchema: profile.includeScriptSchemaDiagnostics,
    requirePrepared: profile.requirePreparedVirtualState,
    prepareKind: profile.preparedVirtualStateKind || null,
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
    prepareMs:
      typeof profile.prepareDiagnosticsVirtualStateMs === "number"
        ? profile.prepareDiagnosticsVirtualStateMs.toFixed(1)
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
    reusedLaneCount: Array.isArray(profile.reusedDiagnosticLanes)
      ? profile.reusedDiagnosticLanes.length
      : null,
    reusedLanes: getSampleList(profile.reusedDiagnosticLanes),
    reusedRegionCount: Array.isArray(profile.reusedDiagnosticRegions)
      ? profile.reusedDiagnosticRegions.length
      : null,
    reusedRegions: getSampleList(profile.reusedDiagnosticRegions),
    deferredServerRegions: profile.deferredServerSemanticRegions || null,
    deferredTemplateRegions: profile.deferredTemplateSemanticRegions || null,
    skippedServerRegions: profile.skippedUnpreparedServerBlockDiagnostics || null,
    skippedTemplateRegions: profile.skippedUnpreparedTemplateDiagnostics || null,
    bottleneck: dominantStep ? dominantStep.name : null,
    bottleneckMs: dominantStep ? formatMilliseconds(dominantStep.ms) : null,
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

function completionCacheKey(uri, version, offset, context = {}) {
  const triggerKind =
    context && context.triggerKind !== undefined && context.triggerKind !== null
      ? String(context.triggerKind)
      : "none";
  const triggerCharacter =
    context && typeof context.triggerCharacter === "string"
      ? context.triggerCharacter
      : "";
  return `${uri}::${version}::${offset}::${triggerKind}::${triggerCharacter}`;
}

function documentContentChangeKey(uri, version) {
  return `${String(uri || "")}::${version}`;
}

function takePendingDocumentContentChanges(uri, version) {
  const key = documentContentChangeKey(uri, version);
  if (!pendingDocumentContentChanges.has(key)) {
    return null;
  }

  const changes = pendingDocumentContentChanges.get(key);
  pendingDocumentContentChanges.delete(key);
  return Array.isArray(changes) ? changes : null;
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
    offset,
    result,
  });
}

function rememberInteractiveOffset(uri, offset, operation) {
  if (
    !uri ||
    offset === null ||
    offset === undefined ||
    offset === "" ||
    !Number.isFinite(Number(offset))
  ) {
    return;
  }

  lastInteractiveOffsetByUri.set(uri, {
    offset: Number(offset),
    operation: operation || "request",
    updatedAt: Date.now(),
  });
}

function getPreferredDiagnosticOffset(uri) {
  const entry = lastInteractiveOffsetByUri.get(uri);
  return entry && Number.isFinite(Number(entry.offset)) ? Number(entry.offset) : null;
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
  lastInteractiveOffsetByUri.delete(uri);
  for (const key of [...pendingDocumentContentChanges.keys()]) {
    if (key.startsWith(`${String(uri || "")}::`)) {
      pendingDocumentContentChanges.delete(key);
    }
  }
}

function updateDocumentRuntimeState(uri, document, options = {}) {
  return documentRuntimeState.updateDocument(uri, {
    version: document ? document.version : null,
    textLength: document && typeof document.getText === "function" ? document.getText().length : 0,
    opened: options.opened === true,
    changed: options.changed === true,
    saved: options.saved === true,
  });
}

function getDocumentRuntimeState(uri) {
  return typeof documentRuntimeState.getDocument === "function"
    ? documentRuntimeState.getDocument(uri)
    : null;
}

function getCachedDiagnosticsResult(uri, key) {
  return typeof documentRuntimeState.getDiagnostics === "function"
    ? documentRuntimeState.getDiagnostics(uri, key)
    : null;
}

function setCachedDiagnosticsResult(uri, key, value) {
  return typeof documentRuntimeState.setDiagnostics === "function"
    ? documentRuntimeState.setDiagnostics(uri, key, value)
    : value;
}

function clearDocumentRuntimeState(uri) {
  documentRuntimeState.deleteDocument(uri);
}

function scheduleDocumentRequest(uri, key, version, delayMs, callback) {
  return requestCoordinator.schedule(
    {
      uri,
      key,
      version,
      delayMs,
    },
    callback
  );
}

function cancelScheduledDocumentRequest(uri, key) {
  requestCoordinator.cancel(uri, key);
}

function cancelScheduledDocumentRequests(uri) {
  requestCoordinator.cancel(uri);
}

function isPullDiagnosticRefreshSupported() {
  return pullDiagnosticRefreshSupported;
}

function ensureDocumentPrepared(uri, options = {}) {
  if (typeof core.prepareDocument !== "function") {
    return null;
  }

  const startedAt = process.hrtime.bigint();
  const result = core.prepareDocument(uri, options);
  const totalMs = elapsedMilliseconds(startedAt);
  if (options.operation || totalMs >= 25) {
    const document = documents.get(uri);
    logServer("perf", "prepare", "document", {
      req: options.requestId,
      file: getRelativePathLabel(uriToFilePath(uri)),
      version: document ? document.version : undefined,
      operation: options.operation || "unspecified",
      mode: options.skipUnrelatedRegions === true ? "partial" : "full",
      preferredOffset: options.preferredOffset,
      staticRefresh: options.skipStaticRefresh === true ? "skip" : "run",
      totalMs: totalMs.toFixed(1),
      perf: getPerformanceBucket("prepare", totalMs),
    });
  }
  return result;
}

function cancelFirstRequestWarmup(uri) {
  cancelScheduledDocumentRequest(uri, "first-request-warmup");
}

function scheduleFirstRequestWarmup(uri, options = {}) {
  cancelFirstRequestWarmup(uri);

  const document = documents.get(uri);
  if (!document) {
    return;
  }

  const documentContext = core.getDocumentContextByUri(uri);
  if (!documentContext || !documentContext.service) {
    return;
  }

  const filePath = documentContext.filePath;
  if (!isEjsFilePath(filePath) && !isScriptFilePath(filePath)) {
    return;
  }

  const version = document.version;
  scheduleDocumentRequest(
    uri,
    "first-request-warmup",
    version,
    FIRST_REQUEST_WARMUP_IDLE_MS,
    () => {
      if (isStaleDocumentVersion(uri, version)) {
        return;
      }

      ensureDocumentPrepared(uri);
      const freshDocument = documents.get(uri);
      const freshContext = core.getDocumentContextByUri(uri);
      if (!freshDocument || !freshContext || !freshContext.service) {
        return;
      }

      const startedAt = process.hrtime.bigint();
      const result =
        typeof freshContext.service.warmupDocument === "function"
          ? freshContext.service.warmupDocument(
              freshContext.filePath,
              freshDocument.getText(),
              options
            )
          : { warmed: false, reason: "unsupported" };
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "warmup", result && result.warmed ? "warmed" : "skipped", {
        file: getRelativePathLabel(freshContext.filePath),
        version,
        case: result && result.warmed ? "first-request-warmup" : "warmup-skipped",
        reason: options.reason || "",
        warmupReason: result && result.reason,
        offset: result && result.offset,
        totalMs: totalMs.toFixed(1),
        perf: getPerformanceBucket("prepare", totalMs),
      });
    }
  );
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
    diagnosticRunIds,
    completionCache,
    lastCompletionByUri,
  },
  helpers: {
    COMPLETION_KIND_MAP,
    LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT,
    LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS,
    LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET,
    FIRST_REQUEST_WARMUP_IDLE_MS,
    PULL_DIAGNOSTICS_INITIAL_YIELD_MS,
    beginDiagnosticRun,
    cancelFirstRequestWarmup,
    cancelScheduledDocumentRequest,
    cancelScheduledDocumentRequests,
    clearDocumentRuntimeState,
    clearCachedCompletionItemsForUri,
    createRequestId: nextRequestId,
    customCompletionKind,
    diagnosticSeverity,
    elapsedMilliseconds,
    getPerformanceBucket,
    ensureDocumentPrepared,
    formatCompletionTrigger,
    getDocumentByUri: (uri) => documents.get(uri),
    getDocumentContextByFilePath: (filePath) => core.getDocumentContextByFilePath(filePath),
    getDocumentContextByUri: (uri) => core.getDocumentContextByUri(uri),
    getDocumentRuntimeState,
    getCachedDiagnosticsResult,
    getCompletionProfileFields,
    getDiagnosticsProfileFields,
    getPreferredDiagnosticOffset,
    getRelativePathLabel,
    hasPrivatePagesSegment,
    isActiveDiagnosticRun,
    isEjsFilePath,
    isExcludedPocketPagesScriptPath,
    isPullDiagnosticRefreshSupported,
    isScriptFilePath,
    isSchemaSupportOnlyHookScriptPath,
    isStaleDocumentVersion,
    logServer,
    rememberInteractiveOffset,
    refreshPullDiagnostics: (...args) => diagnosticsFeatureService.refreshPullDiagnostics(...args),
    scheduleDiagnosticsRefreshForDocument: (...args) =>
      diagnosticsFeatureService.scheduleDiagnosticsRefreshForDocument(...args),
    scheduleFirstRequestWarmup,
    scheduleDocumentRequest,
    setCachedDiagnosticsResult,
    shouldAbortDocumentRequest,
    toLocation,
    toMarkupContent,
    toRange,
    toSignatureHelp,
    toWorkspaceEdit,
    updateDocumentRuntimeState,
    uriToFilePath,
  },
};

const customFeatureService = createCustomFeatureService(featureServiceContext);
const typeScriptFeatureService = createTypeScriptFeatureService(featureServiceContext);
const diagnosticsFeatureService = createDiagnosticsFeatureService(featureServiceContext);
const lifecycleFeatureService = createLifecycleFeatureService(featureServiceContext);
const maintenanceFeatureService = createMaintenanceFeatureService(featureServiceContext);
const structureFeatureService = createStructureFeatureService(featureServiceContext);

function refreshManagedDiagnostics() {
  return diagnosticsFeatureService.refreshManagedDiagnostics();
}

connection.onInitialize((params) => {
  pullDiagnosticRefreshSupported = !!(
    params &&
    params.capabilities &&
    params.capabilities.workspace &&
    params.capabilities.workspace.diagnostics &&
    params.capabilities.workspace.diagnostics.refreshSupport
  );
  logServer("info", "lifecycle", "initialize", {
    pid: process.pid,
    cwd: process.cwd(),
    diagnostics: "pull",
    pullDiagnosticsRefresh: pullDiagnosticRefreshSupported,
  });
  const capabilities = {
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
    diagnosticProvider: {
      interFileDependencies: true,
      workspaceDiagnostics: false,
    },
  };

  return {
    capabilities,
  };
});

documents.onDidOpen((event) => lifecycleFeatureService.handleDidOpen(event));

documents.onDidChangeContent((event) => {
  lifecycleFeatureService.handleDidChangeContent({
    ...event,
    contentChanges: takePendingDocumentContentChanges(event.document.uri, event.document.version),
  });
});

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
  const requestId = nextRequestId("cmp");
  params.__pocketpagesRequestId = requestId;
  rememberInteractiveOffset(document.uri, offset, "completion");

  if (shouldSkipInvokeBeforeMemberAccess(documentText, offset, params.context)) {
    logServer("info", "completion", "skip", {
      req: requestId,
      case: "invoke-before-member-access",
      file: relativePath,
      version: requestedVersion,
      trigger,
      offset,
      reason: "invoke-before-dot",
      totalMs: elapsedMilliseconds(startedAt).toFixed(1),
    });
    return null;
  }

  const cacheKey = completionCacheKey(document.uri, document.version, offset, params.context);
  const cachedItems = getCachedCompletionItems(cacheKey);
  if (cachedItems !== undefined) {
    const totalMs = elapsedMilliseconds(startedAt);
    logServer("perf", "completion", "cache-hit", {
      req: requestId,
      case: "exact-cache",
      file: relativePath,
      version: requestedVersion,
      trigger,
      offset,
      count: cachedItems ? cachedItems.items.length : 0,
      totalMs: totalMs.toFixed(1),
      perf: getPerformanceBucket("completion", totalMs),
    });
    return cachedItems;
  }

  const reusableItems = getReusableCompletionItems(document.uri, document, offset, params.context);
  if (reusableItems !== undefined) {
    const totalMs = elapsedMilliseconds(startedAt);
    logServer("perf", "completion", "near-cache-hit", {
      req: requestId,
      case: "line-cache",
      file: relativePath,
      version: requestedVersion,
      trigger,
      offset,
      count: reusableItems ? reusableItems.items.length : 0,
      totalMs: totalMs.toFixed(1),
      perf: getPerformanceBucket("completion", totalMs),
    });
    return reusableItems;
  }

  const customStartedAt = process.hrtime.bigint();
  const customResult = customFeatureService.provideCompletionItems(params);
  const customElapsedMs = elapsedMilliseconds(customStartedAt);
  const isSchemaSupportOnlyDocument = isSchemaSupportOnlyHookScriptPath(context.filePath);

  if (shouldAbortDocumentRequest(document.uri, requestedVersion, token)) {
    logServer("warn", "completion", "abort", {
      req: requestId,
      case: "stale-or-cancelled",
      file: relativePath,
      version: requestedVersion,
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
    const totalMs = elapsedMilliseconds(startedAt);
    logServer("perf", "completion", "custom", {
      req: requestId,
      case: "custom-completion",
      file: relativePath,
      version: requestedVersion,
      trigger,
      offset,
      count: customResult.items.length,
      getCustomMs: customElapsedMs.toFixed(1),
      totalMs: totalMs.toFixed(1),
      perf: getPerformanceBucket("completion", totalMs),
      bottleneck: "custom",
      bottleneckMs: customElapsedMs.toFixed(1),
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
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("cres");
  const result = typeScriptFeatureService.resolveCompletionItem(item);
  const data = item && item.data ? item.data : null;
  logRequestResult("completion", "resolve", startedAt, {
    req: requestId,
    case: data && data.kind === "ts" ? "ts-resolve" : "passthrough",
    label: item && item.label,
    source: data && data.source,
    result: result && (result.detail || result.documentation) ? "hit" : "none",
  }, "completion");
  return result;
});

connection.onHover((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("hover");
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    logRequestResult("hover", "result", startedAt, {
      req: requestId,
      case: "missing-document",
      result: "none",
    });
    return null;
  }

  const documentContext = core.getDocumentContextByUri(params.textDocument.uri);
  if (!documentContext) {
    logRequestResult("hover", "result", startedAt, {
      req: requestId,
      case: "missing-context",
      file: getRelativePathLabel(uriToFilePath(params.textDocument.uri)),
      version: document.version,
      result: "none",
    });
    return null;
  }
  const offset = document.offsetAt(params.position);
  rememberInteractiveOffset(params.textDocument.uri, offset, "hover");

  const pathTargetInfo = customFeatureService.provideHover(params);
  if (pathTargetInfo) {
    logRequestResult("hover", "result", startedAt, {
      req: requestId,
      case: "path-target",
      file: getRelativePathLabel(documentContext.filePath),
      version: document.version,
      offset,
      kind: pathTargetInfo.kind,
      result: "hit",
    });
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
    logRequestResult("hover", "result", startedAt, {
      req: requestId,
      case: "non-ejs",
      file: getRelativePathLabel(documentContext.filePath),
      version: document.version,
      offset,
      result: "none",
    });
    return null;
  }

  const quickInfo = typeScriptFeatureService.provideHover(params);
  if (!quickInfo || quickInfo.start === null || quickInfo.end === null) {
    logRequestResult("hover", "result", startedAt, {
      req: requestId,
      case: "ts-hover",
      file: getRelativePathLabel(documentContext.filePath),
      version: document.version,
      offset,
      result: "none",
    });
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

  logRequestResult("hover", "result", startedAt, {
    req: requestId,
    case: "ts-hover",
    file: getRelativePathLabel(documentContext.filePath),
    version: document.version,
    offset,
    result: "hit",
    rangeStart: quickInfo.start,
    rangeEnd: quickInfo.end,
  });
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: parts.join("\n\n"),
    },
    range: toRange(document, quickInfo.start, quickInfo.end),
  };
});

connection.onDefinition((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("def");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const offset = document ? document.offsetAt(params.position) : null;
  params.__pocketpagesRequestId = requestId;
  const customTarget = customFeatureService.provideDefinition(params);
  if (customTarget) {
    const result = toLocation(customTarget);
    logRequestResult("definition", "result", startedAt, {
      req: requestId,
      case: "custom-definition",
      file: context ? getRelativePathLabel(context.filePath) : null,
      version: document ? document.version : null,
      offset,
      result: result ? "hit" : "none",
      target: customTarget.filePath ? getRelativePathLabel(customTarget.filePath) : null,
    });
    return result;
  }

  const typeScriptTarget = typeScriptFeatureService.provideDefinition(params);
  const result = toLocation(typeScriptTarget);
  logRequestResult("definition", "result", startedAt, {
    req: requestId,
    case: "ts-definition",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    offset,
    result: result ? "hit" : "none",
    target: typeScriptTarget && typeScriptTarget.filePath
      ? getRelativePathLabel(typeScriptTarget.filePath)
      : null,
  });
  return result;
});

connection.onReferences((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("ref");
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    logRequestResult("references", "result", startedAt, {
      req: requestId,
      case: "missing-document",
      result: "none",
      count: 0,
    });
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    logRequestResult("references", "result", startedAt, {
      req: requestId,
      case: "missing-context",
      file: getRelativePathLabel(uriToFilePath(params.textDocument.uri)),
      version: document.version,
      result: "none",
      count: 0,
    });
    return null;
  }

  const offset = document.offsetAt(params.position);
  const includeDeclaration = !!(params.context && params.context.includeDeclaration);
  const customReferences = customFeatureService.provideReferences(params);
  if (customReferences) {
    const result = customReferences.map((reference) => {
      const targetUri = URI.file(reference.filePath).toString();
      const targetDocument = documents.get(targetUri) || TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
      return {
        uri: targetUri,
        range: toRange(targetDocument, reference.start, reference.end),
      };
    });
    logRequestResult("references", "result", startedAt, {
      req: requestId,
      case: "custom-references",
      file: getRelativePathLabel(context.filePath),
      version: document.version,
      offset,
      includeDeclaration,
      result: result.length ? "hit" : "none",
      count: result.length,
    });
    return result;
  }

  const shouldTryTypeScriptReferences =
    !isEjsFilePath(context.filePath) ||
    core.isFeatureEnabledAtOffset(params.textDocument.uri, offset, "references");
  let typeScriptReferenceResult = null;
  if (shouldTryTypeScriptReferences) {
    ensureDocumentPrepared(document.uri, {
      requestId,
      operation: "references",
    });
    typeScriptReferenceResult = context.service.getTypeScriptReferenceTargets(
      context.filePath,
      document.getText(),
      offset,
      {
        includeDeclaration,
        requirePreparedVirtualState: true,
      }
    );
  }
  const fileReferenceContext = context.service.getPrivateIncludeReferenceContext(context.filePath);

  if (
    typeScriptReferenceResult &&
    typeScriptReferenceResult.locations.length &&
    (!fileReferenceContext ||
      typeScriptReferenceResult.hasMappedDefinition ||
    typeScriptReferenceResult.hasExternalReference)
  ) {
    const result = typeScriptReferenceResult.locations.map((reference) => {
      const targetUri = URI.file(reference.filePath).toString();
      const targetDocument =
        documents.get(targetUri) ||
        TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
      return {
        uri: targetUri,
        range: toRange(targetDocument, reference.start, reference.end),
      };
    });
    logRequestResult("references", "result", startedAt, {
      req: requestId,
      case: "ts-references",
      file: getRelativePathLabel(context.filePath),
      version: document.version,
      offset,
      includeDeclaration,
      result: result.length ? "hit" : "none",
      count: result.length,
      mappedDefinition: !!typeScriptReferenceResult.hasMappedDefinition,
      externalReference: !!typeScriptReferenceResult.hasExternalReference,
    });
    return result;
  }

  if (!fileReferenceContext) {
    logRequestResult("references", "result", startedAt, {
      req: requestId,
      case: shouldTryTypeScriptReferences ? "ts-references" : "mapper-disabled",
      file: getRelativePathLabel(context.filePath),
      version: document.version,
      offset,
      includeDeclaration,
      result: "none",
      count: 0,
    });
    return null;
  }

  const fileReferences =
    context.service.getFileReferenceTargets(context.filePath, document.getText(), {
      includeDeclaration,
  }) || [];
  if (!fileReferences.length) {
    logRequestResult("references", "result", startedAt, {
      req: requestId,
      case: "file-references",
      file: getRelativePathLabel(context.filePath),
      version: document.version,
      offset,
      includeDeclaration,
      result: "none",
      count: 0,
      fileReferenceKind: fileReferenceContext.kind,
    });
    return null;
  }

  const result = fileReferences.map((reference) => {
    const targetUri = URI.file(reference.filePath).toString();
    const targetDocument =
      documents.get(targetUri) ||
      TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
    return {
      uri: targetUri,
      range: toRange(targetDocument, reference.start, reference.end),
    };
  });
  logRequestResult("references", "result", startedAt, {
    req: requestId,
    case: "file-references",
    file: getRelativePathLabel(context.filePath),
    version: document.version,
    offset,
    includeDeclaration,
    result: "hit",
    count: result.length,
    fileReferenceKind: fileReferenceContext.kind,
  });
  return result;
});

connection.onCodeAction((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("act");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const diagnosticCount = params.context && Array.isArray(params.context.diagnostics)
    ? params.context.diagnostics.length
    : 0;
  const result = diagnosticCount
    ? diagnosticsFeatureService.provideCodeActions(params)
    : null;
  logRequestResult("code-action", "result", startedAt, {
    req: requestId,
    case: diagnosticCount ? "diagnostic-actions" : "no-diagnostics",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    diagnostics: diagnosticCount,
    result: resultCount(result) ? "hit" : "none",
    count: resultCount(result),
  });
  return result;
});

connection.onPrepareRename((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("ren");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const offset = document ? document.offsetAt(params.position) : null;
  try {
    const customResult = customFeatureService.providePrepareRename(params);
    if (customResult) {
      logRequestResult("rename", "prepare", startedAt, {
        req: requestId,
        case: "custom-prepare",
        file: context ? getRelativePathLabel(context.filePath) : null,
        version: document ? document.version : null,
        offset,
        result: "hit",
        placeholder: customResult.placeholder,
      });
      return customResult;
    }

    const typeScriptResult = typeScriptFeatureService.providePrepareRename(params);
    logRequestResult("rename", "prepare", startedAt, {
      req: requestId,
      case: "ts-prepare",
      file: context ? getRelativePathLabel(context.filePath) : null,
      version: document ? document.version : null,
      offset,
      result: typeScriptResult ? "hit" : "none",
      placeholder: typeScriptResult && typeScriptResult.placeholder,
    });
    return typeScriptResult;
  } catch (error) {
    logRequestResult("rename", "prepare-failed", startedAt, {
      req: requestId,
      case: "prepare-error",
      file: context ? getRelativePathLabel(context.filePath) : null,
      version: document ? document.version : null,
      offset,
      error: error && error.message ? error.message : String(error),
    });
    throw error;
  }
});

connection.onRenameRequest((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("ren");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const offset = document ? document.offsetAt(params.position) : null;
  try {
    const customResult = customFeatureService.provideRename(params);
    if (customResult) {
      const stats = workspaceEditStats(customResult);
      logRequestResult("rename", "edits", startedAt, {
        req: requestId,
        case: "custom-rename",
        file: context ? getRelativePathLabel(context.filePath) : null,
        version: document ? document.version : null,
        offset,
        newName: params.newName,
        files: stats.files,
        edits: stats.edits,
        result: stats.edits ? "hit" : "none",
      });
      return customResult;
    }

    const typeScriptResult = typeScriptFeatureService.provideRename(params);
    const stats = workspaceEditStats(typeScriptResult);
    logRequestResult("rename", "edits", startedAt, {
      req: requestId,
      case: "ts-rename",
      file: context ? getRelativePathLabel(context.filePath) : null,
      version: document ? document.version : null,
      offset,
      newName: params.newName,
      files: stats.files,
      edits: stats.edits,
      result: stats.edits ? "hit" : "none",
    });
    return typeScriptResult;
  } catch (error) {
    logRequestResult("rename", "failed", startedAt, {
      req: requestId,
      case: "rename-error",
      file: context ? getRelativePathLabel(context.filePath) : null,
      version: document ? document.version : null,
      offset,
      newName: params.newName,
      error: error && error.message ? error.message : String(error),
    });
    throw error;
  }
});

connection.onDocumentLinks((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("lnk");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const result = customFeatureService.provideDocumentLinks(params);
  logRequestResult("links", "result", startedAt, {
    req: requestId,
    case: "document-links",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    result: resultCount(result) ? "hit" : "none",
    count: resultCount(result),
  }, "structure");
  return result;
});

connection.onSignatureHelp((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("sig");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const offset = document ? document.offsetAt(params.position) : null;
  const customResult = customFeatureService.provideSignatureHelp(params);
  if (customResult) {
    logRequestResult("signature", "result", startedAt, {
      req: requestId,
      case: "custom-signature",
      file: context ? getRelativePathLabel(context.filePath) : null,
      version: document ? document.version : null,
      offset,
      result: "hit",
      signatures: Array.isArray(customResult.signatures) ? customResult.signatures.length : 0,
    });
    return customResult;
  }

  const typeScriptResult = typeScriptFeatureService.provideSignatureHelp(params);
  logRequestResult("signature", "result", startedAt, {
    req: requestId,
    case: "ts-signature",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    offset,
    result: typeScriptResult ? "hit" : "none",
    signatures: typeScriptResult && Array.isArray(typeScriptResult.signatures)
      ? typeScriptResult.signatures.length
      : 0,
  });
  return typeScriptResult;
});

connection.languages.inlayHint.on((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("inlay");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const isLargeEjs =
    document &&
    context &&
    isEjsFilePath(context.filePath) &&
    document.getText().length >= LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT;
  if (isLargeEjs) {
    logRequestResult("inlay", "result", startedAt, {
      req: requestId,
      case: "large-ejs-skipped",
      file: getRelativePathLabel(context.filePath),
      version: document.version,
      result: "none",
      count: 0,
      reason: "large-ejs",
    }, "structure");
    return null;
  }

  const result = typeScriptFeatureService.provideInlayHints(params);
  logRequestResult("inlay", "result", startedAt, {
    req: requestId,
    case: "ts-inlay",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    result: resultCount(result) ? "hit" : "none",
    count: resultCount(result),
  }, "structure");
  return result;
});

connection.languages.semanticTokens.on((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("sem");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const result = structureFeatureService.provideSemanticTokens(params);
  logRequestResult("semantic-tokens", "result", startedAt, {
    req: requestId,
    case: "ejs-semantic-tokens",
    file: context ? getRelativePathLabel(context.filePath) : getRelativePathLabel(uriToFilePath(params.textDocument.uri)),
    version: document ? document.version : null,
    tokens: resultCount(result),
    encodedLength: result && Array.isArray(result.data) ? result.data.length : 0,
  }, "structure");
  return result;
});

connection.languages.diagnostics.on((params, token) => {
  return diagnosticsFeatureService.providePullDiagnostics(params, token);
});

connection.onDocumentSymbol((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("sym");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const result = structureFeatureService.provideDocumentSymbols(params);
  logRequestResult("symbols", "document", startedAt, {
    req: requestId,
    case: "document-symbols",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    topLevel: Array.isArray(result) ? result.length : 0,
    count: countDocumentSymbols(result),
    result: resultCount(result) ? "hit" : "none",
  }, "structure");
  return result;
});

connection.onWorkspaceSymbol((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("wsym");
  const result = structureFeatureService.provideWorkspaceSymbols(params);
  logRequestResult("symbols", "workspace", startedAt, {
    req: requestId,
    case: "workspace-symbols",
    query: params && params.query,
    count: resultCount(result),
    result: resultCount(result) ? "hit" : "none",
  }, "structure");
  return result;
});

connection.onCodeLens((params) => {
  const startedAt = process.hrtime.bigint();
  const requestId = nextRequestId("lens");
  const document = documents.get(params.textDocument.uri);
  const context = core.getDocumentContextByUri(params.textDocument.uri);
  const result = structureFeatureService.provideCodeLens(params);
  logRequestResult("codelens", "result", startedAt, {
    req: requestId,
    case: "document-codelens",
    file: context ? getRelativePathLabel(context.filePath) : null,
    version: document ? document.version : null,
    count: resultCount(result),
    result: resultCount(result) ? "hit" : "none",
  }, "structure");
  return result;
});

connection.onRequest(REQUESTS.probeCurrentFile, ({ uri }) => {
  return maintenanceFeatureService.provideProbeCurrentFile({ uri });
});

connection.onRequest(REQUESTS.refreshDiagnostics, ({ uri }) => {
  return maintenanceFeatureService.provideRefreshDiagnostics({ uri });
});

connection.onRequest(REQUESTS.reloadCaches, ({ uri }) => {
  const result = maintenanceFeatureService.provideReloadCaches({ uri });
  refreshManagedDiagnostics();
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
