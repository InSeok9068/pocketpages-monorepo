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
  SemanticTokensBuilder,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");
const { URI } = require("vscode-uri");
const { PocketPagesLanguageCore, uriToFilePath } = require("../core/language-core");
const { REQUESTS, NOTIFICATIONS } = require("./protocol");
const { ts, findAppRoot } = require("../language-service");
const { TOKEN_TYPES, collectEjsSemanticTokenEntries, getTokenTypeIndex } = require("../ejs-semantic-tokens");
const { getServerTemplateBoundaryLineNumbers } = require("../ejs-server-boundary");

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
const COMPLETION_TRIGGER_CHARACTERS = [".", "'", "\"", "/", "{", ","];
const SIGNATURE_TRIGGER_CHARACTERS = ["(", ","];
const diagnosticTimeouts = new Map();
const diagnosticRunIds = new Map();
const completionCache = new Map();

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

function isExcludedPocketPagesScriptPath(filePath) {
  const normalizedPath = normalizeDocumentPath(filePath);
  if (!normalizedPath.includes("/pb_hooks/pages/")) {
    return false;
  }

  const pagesRelativePath = normalizedPath.split("/pb_hooks/pages/")[1] || "";
  const relativeSegments = pagesRelativePath.split("/").filter(Boolean);
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
  if (diagnosticTimeouts.has(uri)) {
    clearTimeout(diagnosticTimeouts.get(uri));
  }

  const timeoutId = setTimeout(() => {
    diagnosticTimeouts.delete(uri);
    publishDiagnostics(uri);
  }, SCRIPT_DIAGNOSTICS_DEBOUNCE_MS);
  diagnosticTimeouts.set(uri, timeoutId);
}

function cancelScheduledDiagnostics(uri) {
  if (!diagnosticTimeouts.has(uri)) {
    return;
  }

  clearTimeout(diagnosticTimeouts.get(uri));
  diagnosticTimeouts.delete(uri);
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

function publishDiagnostics(uri) {
  const runId = beginDiagnosticRun(uri);
  const document = documents.get(uri);
  if (!document) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  const context = core.getDocumentContextByUri(uri);
  if (!context) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  const startedAt = process.hrtime.bigint();
  const diagnosticsProfile = {};
  const requestedVersion = document.version;
  const rawDiagnostics = context.service.getDiagnostics(context.filePath, document.getText(), {
    profile: diagnosticsProfile,
  });
  const elapsedMs = elapsedMilliseconds(startedAt);

  if (!isActiveDiagnosticRun(uri, runId) || isStaleDocumentVersion(uri, requestedVersion)) {
    connection.console.log(
      `updateDiagnostics stale: ${context.filePath} (version=${requestedVersion})`
    );
    return;
  }

  connection.console.log(`updateDiagnostics: ${context.filePath}`);
  connection.console.log(
    `  diagnostics: ${rawDiagnostics.length} (getDiagnostics=${elapsedMs.toFixed(1)}ms total=${elapsedMs.toFixed(1)}ms)${formatDiagnosticsProfile(diagnosticsProfile)}`
  );

  connection.sendDiagnostics({
    uri,
    diagnostics: rawDiagnostics.map((diagnostic) => ({
      range: toRange(document, diagnostic.start, diagnostic.end),
      severity: diagnosticSeverity(diagnostic.category),
      code: diagnostic.code,
      source: "pocketpages-server-script",
      message: diagnostic.message,
    })),
  });
}

function publishManagedDiagnostics() {
  for (const virtualCode of core.getManagedVirtualCodes()) {
    publishDiagnostics(virtualCode.uri);
  }
}

connection.onInitialize(() => ({
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
}));

documents.onDidOpen((event) => {
  core.openDocument({
    uri: event.document.uri,
    languageId: event.document.languageId,
    version: event.document.version,
    text: event.document.getText(),
  });
  publishDiagnostics(event.document.uri);
});

documents.onDidChangeContent((event) => {
  clearCachedCompletionItemsForUri(event.document.uri);
  core.updateDocument({
    uri: event.document.uri,
    languageId: event.document.languageId,
    version: event.document.version,
    text: event.document.getText(),
  });

  if (isScriptFilePath(uriToFilePath(event.document.uri))) {
    scheduleDiagnostics(event.document.uri);
  }
});

documents.onDidClose((event) => {
  clearCachedCompletionItemsForUri(event.document.uri);
  cancelScheduledDiagnostics(event.document.uri);
  diagnosticRunIds.delete(event.document.uri);
  core.closeDocument(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

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
    connection.console.log(
      `completion: ${relativePath} skipped trigger=${trigger} offset=${offset} reason=invoke-before-dot total=${elapsedMilliseconds(startedAt).toFixed(1)}ms`
    );
    return null;
  }

  const cacheKey = completionCacheKey(document.uri, document.version, offset);
  const cachedItems = getCachedCompletionItems(cacheKey);
  if (cachedItems !== undefined) {
    connection.console.log(
      `completion: ${relativePath} cache-hit count=${cachedItems ? cachedItems.items.length : 0} trigger=${trigger} offset=${offset} total=${elapsedMilliseconds(startedAt).toFixed(1)}ms`
    );
    return cachedItems;
  }

  const customStartedAt = process.hrtime.bigint();
  const customCompletionData = context.service.getCustomCompletionData(context.filePath, documentText, offset);
  const customElapsedMs = elapsedMilliseconds(customStartedAt);
  const isSchemaSupportOnlyDocument = isSchemaSupportOnlyHookScriptPath(context.filePath);

  if (shouldAbortDocumentRequest(document.uri, requestedVersion, token)) {
    connection.console.log(
      `completion: ${relativePath} aborted trigger=${trigger} offset=${offset} stage=custom total=${elapsedMilliseconds(startedAt).toFixed(1)}ms`
    );
    return null;
  }

  if (customCompletionData) {
    const customItems = isSchemaSupportOnlyDocument
      ? customCompletionData.items.filter(
          (entry) => entry.category === "collection-name" || entry.category === "record-field"
        )
      : customCompletionData.items;

    const result = {
      isIncomplete: false,
      items: customItems.map((entry) => ({
        label: entry.label,
        kind: customCompletionKind(entry.category),
        detail: entry.detail || "",
        documentation: entry.documentation ? { kind: MarkupKind.Markdown, value: String(entry.documentation) } : undefined,
        sortText: entry.sortText,
        insertText: entry.insertText || entry.label,
        insertTextFormat: InsertTextFormat.PlainText,
        textEdit: {
          range: toRange(document, customCompletionData.start, customCompletionData.end),
          newText: entry.insertText || entry.label,
        },
        data: {
          kind: "custom",
        },
      })),
    };
    setCachedCompletionItems(cacheKey, result);
    connection.console.log(
      `completion: ${relativePath} custom count=${result.items.length} trigger=${trigger} offset=${offset} (getCustom=${customElapsedMs.toFixed(1)}ms total=${elapsedMilliseconds(startedAt).toFixed(1)}ms)`
    );
    return result.items.length ? result : null;
  }

  if (isSchemaSupportOnlyDocument) {
    setCachedCompletionItems(cacheKey, null);
    return null;
  }

  const completionStartedAt = process.hrtime.bigint();
  const completionData = context.service.getCompletionData(context.filePath, documentText, offset);
  const completionElapsedMs = elapsedMilliseconds(completionStartedAt);
  if (shouldAbortDocumentRequest(document.uri, requestedVersion, token)) {
    connection.console.log(
      `completion: ${relativePath} aborted trigger=${trigger} offset=${offset} stage=ts total=${elapsedMilliseconds(startedAt).toFixed(1)}ms`
    );
    return null;
  }
  if (!completionData) {
    setCachedCompletionItems(cacheKey, null);
    connection.console.log(
      `completion: ${relativePath} none trigger=${trigger} offset=${offset} (getCustom=${customElapsedMs.toFixed(1)}ms getCompletion=${completionElapsedMs.toFixed(1)}ms total=${elapsedMilliseconds(startedAt).toFixed(1)}ms)`
    );
    return null;
  }

  const result = {
    isIncomplete: false,
    items: completionData.entries.map((entry) => ({
      label: entry.name,
      kind: COMPLETION_KIND_MAP[entry.kind] || CompletionItemKind.Text,
      sortText: entry.sortText,
      filterText: entry.insertText || entry.name,
      insertText: entry.insertText || entry.name,
      insertTextFormat: InsertTextFormat.PlainText,
      detail: entry.kindModifiers ? `${entry.kind} ${entry.kindModifiers}` : entry.kind,
      textEdit: completionData.replacementSpan
        ? {
            range: toRange(document, completionData.replacementSpan.start, completionData.replacementSpan.end),
            newText: entry.insertText || entry.name,
          }
        : undefined,
      data: {
        kind: "ts",
        filePath: context.filePath,
        virtualFileName: completionData.virtualFileName,
        virtualOffset: completionData.virtualOffset,
        name: entry.name,
        source: entry.source,
      },
    })),
  };
  setCachedCompletionItems(cacheKey, result);
  connection.console.log(
    `completion: ${relativePath} ts count=${result.items.length} trigger=${trigger} offset=${offset} (getCustom=${customElapsedMs.toFixed(1)}ms getCompletion=${completionElapsedMs.toFixed(1)}ms total=${elapsedMilliseconds(startedAt).toFixed(1)}ms)${formatCompletionProfile(completionData.profile)}`
  );
  return result;
});

connection.onCompletionResolve((item) => {
  if (!item || !item.data || item.data.kind !== "ts") {
    return item;
  }

  const context = core.getDocumentContextByFilePath(item.data.filePath);
  if (!context) {
    return item;
  }

  const details = context.service.getCompletionDetails(
    item.data.virtualFileName,
    item.data.virtualOffset,
    item.data.name,
    item.data.source
  );
  if (!details) {
    return item;
  }

  const signature = ts.displayPartsToString(details.displayParts || []);
  const documentation = ts.displayPartsToString(details.documentation || []);
  if (signature) {
    item.detail = signature;
  }
  if (signature || documentation) {
    item.documentation = toMarkupContent(signature, documentation);
  }
  return item;
});

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  const offset = document.offsetAt(params.position);
  const quickInfo = context.service.getQuickInfo(context.filePath, document.getText(), offset);
  const pathTargetInfo = context.service.getPathTargetInfo(context.filePath, document.getText(), offset);
  if ((!quickInfo || quickInfo.start === null || quickInfo.end === null) && !pathTargetInfo) {
    return null;
  }

  const parts = [];
  if (quickInfo && quickInfo.displayText) {
    parts.push("```ts");
    parts.push(quickInfo.displayText);
    parts.push("```");
  }
  if (quickInfo && quickInfo.documentation) {
    parts.push(quickInfo.documentation);
  }
  if (pathTargetInfo && pathTargetInfo.targetFilePath) {
    parts.push(`Target: \`${pathTargetInfo.targetFilePath.replace(/\\/g, "/")}\``);
    if (pathTargetInfo.kind === "route-path" && pathTargetInfo.value) {
      parts.push(`Route: \`${pathTargetInfo.value}\``);
    }
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: parts.join("\n\n"),
    },
    range:
      quickInfo && quickInfo.start !== null && quickInfo.end !== null
        ? toRange(document, quickInfo.start, quickInfo.end)
        : toRange(document, pathTargetInfo.start, pathTargetInfo.end),
  };
});

connection.onDefinition((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  return toLocation(
    context.service.getDefinitionTarget(
      context.filePath,
      document.getText(),
      document.offsetAt(params.position)
    )
  );
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

  const references = context.service.getReferenceTargets(
    context.filePath,
    document.getText(),
    document.offsetAt(params.position),
    { includeDeclaration: !!(params.context && params.context.includeDeclaration) }
  );
  if (!references || !references.length) {
    return null;
  }

  return references.map((reference) => {
    const targetUri = URI.file(reference.filePath).toString();
    const targetDocument = documents.get(targetUri) || TextDocument.create(targetUri, "javascript", 1, core.getDocumentTextForFile(reference.filePath));
    return {
      uri: targetUri,
      range: toRange(targetDocument, reference.start, reference.end),
    };
  });
});

connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  const actions = context.service.getCodeActions(context.filePath, document.getText(), {
    start: document.offsetAt(params.range.start),
    end: document.offsetAt(params.range.end),
  });
  if (!actions || !actions.length) {
    return null;
  }

  return actions.map((action) => ({
    title: action.title,
    kind: CodeActionKind.QuickFix,
    edit: toWorkspaceEdit(action.edits || []),
  }));
});

connection.onPrepareRename((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  const renameInfo = context.service.getRenameInfo(context.filePath, document.getText(), document.offsetAt(params.position));
  if (!renameInfo) {
    return null;
  }
  if (!renameInfo.canRename) {
    throw new Error(renameInfo.localizedErrorMessage || "Unable to rename this symbol.");
  }

  return {
    range: toRange(document, renameInfo.start, renameInfo.end),
    placeholder: renameInfo.placeholder,
  };
});

connection.onRenameRequest((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  const renameResult = context.service.getRenameEdits(
    context.filePath,
    document.getText(),
    document.offsetAt(params.position),
    params.newName
  );
  if (!renameResult) {
    return null;
  }
  if (!renameResult.canRename) {
    throw new Error(renameResult.localizedErrorMessage || "Unable to rename this symbol.");
  }

  return toWorkspaceEdit(renameResult.edits);
});

connection.onDocumentLinks((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  return context.service.getDocumentLinks(context.filePath, document.getText()).map((entry) => ({
    range: toRange(document, entry.start, entry.end),
    target: URI.file(entry.targetFilePath).toString(),
    tooltip:
      entry.kind === "resolve-path"
        ? `Open module target: ${entry.value}`
        : entry.kind === "include-path"
          ? `Open partial target: ${entry.value}`
          : `Open route target: ${entry.value}`,
  }));
});

connection.onSignatureHelp((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  return toSignatureHelp(
    context.service.getSignatureHelp(context.filePath, document.getText(), document.offsetAt(params.position), {
      triggerCharacter: params.context && params.context.triggerCharacter,
      isRetrigger: params.context && params.context.isRetrigger,
    })
  );
});

connection.languages.inlayHint.on((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  return context.service.getInlayHintEntries(context.filePath, document.getText(), {
    start: document.offsetAt(params.range.start),
    end: document.offsetAt(params.range.end),
  }).map((entry) => ({
    position: document.positionAt(entry.position),
    label: entry.label,
    paddingLeft: true,
    kind: entry.kind === "parameter" ? InlayHintKind.Parameter : InlayHintKind.Type,
    tooltip: entry.tooltip || undefined,
  }));
});

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }

  const filePath = uriToFilePath(params.textDocument.uri);
  if (!isEjsFilePath(filePath)) {
    return { data: [] };
  }

  return getSemanticTokens(document.getText(), document);
});

connection.onCodeLens((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }

  const context = core.getDocumentContextByUri(params.textDocument.uri);
  if (!context) {
    return null;
  }

  const boundaryEntries = isEjsFilePath(context.filePath)
    ? getServerTemplateBoundaryLineNumbers(document.getText(), {
        includeTopLevelPartialSetup: hasPrivatePagesSegment(context.filePath),
      }).map((lineIndex) => ({
        title: "Template",
        start: document.offsetAt({ line: lineIndex, character: 0 }),
        command: "pocketpagesServerScript.noopCodeLens",
      }))
    : [];

  const entries = [...boundaryEntries, ...(context.service.getCodeLensEntries(context.filePath, document.getText()) || [])];
  if (!entries.length) {
    return null;
  }

  return entries.map((entry) => {
    const range = typeof entry.start === "number"
      ? {
          start: document.positionAt(entry.start),
          end: document.positionAt(entry.start),
        }
      : {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        };

    let command = null;
    if (entry.command) {
      command = {
        title: entry.title,
        command: entry.command,
        arguments: [params.textDocument.uri],
      };
    } else if (entry.targetFilePath) {
      command = {
        title: entry.title,
        command: "vscode.open",
        arguments: [URI.file(entry.targetFilePath).toString()],
      };
    } else {
      command = {
        title: entry.title,
        command: "pocketpagesServerScript.noopCodeLens",
      };
    }

    return {
      range,
      command,
    };
  });
});

connection.onRequest(REQUESTS.probeCurrentFile, ({ uri }) => core.probeFile(uriToFilePath(uri)));
connection.onRequest(REQUESTS.refreshDiagnostics, ({ uri }) => {
  publishDiagnostics(uri);
  return { ok: true };
});
connection.onRequest(REQUESTS.reloadCaches, ({ uri }) => {
  const result = core.reloadCaches(uri ? uriToFilePath(uri) : null);
  publishManagedDiagnostics();
  return result;
});
connection.onRequest(REQUESTS.allFileReferences, ({ uri }) => core.getFileReferenceResult(uriToFilePath(uri)));
connection.onRequest(REQUESTS.fileRenameEdits, ({ oldUri, newUri }) =>
  core.getFileRenameEdits(uriToFilePath(oldUri), uriToFilePath(newUri))
);
connection.onNotification(NOTIFICATIONS.didManualSave, ({ uri }) => {
  publishDiagnostics(uri);
});

documents.listen(connection);
connection.listen();
