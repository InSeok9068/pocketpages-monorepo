"use strict";

const ALWAYS_REPORTED_EJS_DIAGNOSTIC_CODES = new Set([
  "pp-manual-flash-query",
  "pp-unresolved-route-path",
]);

function createDiagnosticsFeatureService(context) {
  const {
    connection,
    helpers,
    state,
  } = context;
  const {
    SCRIPT_DIAGNOSTICS_DEBOUNCE_MS,
    SCRIPT_SEMANTIC_DIAGNOSTICS_IDLE_MS,
    LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT,
    LARGE_DOCUMENT_DIAGNOSTICS_IDLE_MS,
    diagnosticSeverity,
    elapsedMilliseconds,
    getDocumentByUri,
    getDocumentContextByUri,
    getDiagnosticsProfileFields,
    getRelativePathLabel,
    isActiveDiagnosticRun,
    isStaleDocumentVersion,
    logServer,
    toRange,
  } = helpers;

  function isSchemaDiagnosticCode(code) {
    return code === "pp-schema-collection" || code === "pp-schema-field";
  }

  function shouldReportDiagnostic(uri, documentContext, diagnostic) {
    if (!documentContext || !helpers.isEjsFilePath(documentContext.filePath)) {
      return true;
    }

    if (
      diagnostic &&
      ALWAYS_REPORTED_EJS_DIAGNOSTIC_CODES.has(String(diagnostic.code || ""))
    ) {
      return true;
    }

    if (!diagnostic || typeof diagnostic.start !== "number") {
      return true;
    }

    const start = Math.max(0, diagnostic.start);
    const end =
      typeof diagnostic.end === "number" && diagnostic.end > start
        ? diagnostic.end
        : start;

    return context.core.hasFeatureCoverageForRange(
      uri,
      start,
      end,
      "diagnostics"
    );
  }

  function filterReportedDiagnostics(uri, documentContext, diagnostics) {
    let filteredDiagnostics = (Array.isArray(diagnostics) ? diagnostics : []).filter((diagnostic) =>
      shouldReportDiagnostic(uri, documentContext, diagnostic)
    );

    if (
      documentContext &&
      helpers.isSchemaSupportOnlyHookScriptPath(documentContext.filePath)
    ) {
      filteredDiagnostics = filteredDiagnostics.filter((diagnostic) =>
        isSchemaDiagnosticCode(diagnostic && diagnostic.code)
      );
    }

    return filteredDiagnostics;
  }

  function isLargeEjsDocument(documentContext, document) {
    return (
      documentContext &&
      document &&
      helpers.isEjsFilePath(documentContext.filePath) &&
      document.getText().length >= LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT
    );
  }

  function scheduleDiagnostics(uri) {
    cancelScheduledDiagnostics(uri, { silent: true });

    const document = getDocumentByUri(uri);
    const documentContext = getDocumentContextByUri(uri);
    const isLargeDocument = isLargeEjsDocument(documentContext, document);
    const semanticTimeouts =
      state.semanticDiagnosticTimeouts instanceof Map
        ? state.semanticDiagnosticTimeouts
        : null;

    if (isLargeDocument && semanticTimeouts) {
      const timeoutId = setTimeout(() => {
        semanticTimeouts.delete(uri);
        publishDiagnostics(uri, {
          includeSemanticDiagnostics: true,
          reason: "large-idle",
        });
      }, LARGE_DOCUMENT_DIAGNOSTICS_IDLE_MS);
      semanticTimeouts.set(uri, timeoutId);

      if (document) {
        logServer("perf", "diagnostics", "schedule", {
          file: getRelativePathLabel(helpers.uriToFilePath(uri)),
          version: document.version,
          mode: "large-idle",
          delayMs: LARGE_DOCUMENT_DIAGNOSTICS_IDLE_MS,
        });
      }
      return;
    }

    const timeoutId = setTimeout(() => {
      state.diagnosticTimeouts.delete(uri);
      publishDiagnostics(uri, {
        includeSemanticDiagnostics: false,
        reason: "change",
      });
    }, SCRIPT_DIAGNOSTICS_DEBOUNCE_MS);
    state.diagnosticTimeouts.set(uri, timeoutId);

    if (semanticTimeouts) {
      const semanticTimeoutId = setTimeout(() => {
        semanticTimeouts.delete(uri);
        publishDiagnostics(uri, {
          includeSemanticDiagnostics: true,
          reason: "idle",
        });
      }, SCRIPT_SEMANTIC_DIAGNOSTICS_IDLE_MS);
      semanticTimeouts.set(uri, semanticTimeoutId);
    }

    if (document) {
      logServer("perf", "diagnostics", "schedule", {
        file: getRelativePathLabel(helpers.uriToFilePath(uri)),
        version: document.version,
        delayMs: SCRIPT_DIAGNOSTICS_DEBOUNCE_MS,
        semanticDelayMs: SCRIPT_SEMANTIC_DIAGNOSTICS_IDLE_MS,
      });
    }
  }

  function cancelScheduledDiagnostics(uri, options = {}) {
    let cancelled = false;

    if (state.diagnosticTimeouts.has(uri)) {
      clearTimeout(state.diagnosticTimeouts.get(uri));
      state.diagnosticTimeouts.delete(uri);
      cancelled = true;
    }

    if (
      state.semanticDiagnosticTimeouts instanceof Map &&
      state.semanticDiagnosticTimeouts.has(uri)
    ) {
      clearTimeout(state.semanticDiagnosticTimeouts.get(uri));
      state.semanticDiagnosticTimeouts.delete(uri);
      cancelled = true;
    }

    if (!cancelled || options.silent) {
      return;
    }

    logServer("info", "diagnostics", "cancel-scheduled", {
      file: getRelativePathLabel(helpers.uriToFilePath(uri)),
    });
  }

  function publishDiagnostics(uri, options = {}) {
    const includeSemanticDiagnostics =
      options.includeSemanticDiagnostics !== false;
    const runId = helpers.beginDiagnosticRun(uri);
    const document = getDocumentByUri(uri);
    if (!document) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }

    const documentContext = getDocumentContextByUri(uri);
    if (!documentContext) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }

    if (helpers.isExcludedPocketPagesScriptPath(documentContext.filePath)) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }

    if (options.reason === "open" && isLargeEjsDocument(documentContext, document)) {
      scheduleDiagnostics(uri);
      return;
    }

    const startedAt = process.hrtime.bigint();
    const diagnosticsProfile = {};
    const requestedVersion = document.version;
    const rawDiagnostics = documentContext.service.getDiagnostics(
      documentContext.filePath,
      document.getText(),
      {
        profile: diagnosticsProfile,
        includeSemanticDiagnostics,
      }
    );
    const reportedDiagnostics = filterReportedDiagnostics(
      uri,
      documentContext,
      rawDiagnostics
    );
    const elapsedMs = elapsedMilliseconds(startedAt);

    if (!isActiveDiagnosticRun(uri, runId) || isStaleDocumentVersion(uri, requestedVersion)) {
      logServer("warn", "diagnostics", "stale", {
        file: getRelativePathLabel(documentContext.filePath),
        version: requestedVersion,
      });
      return;
    }

    logServer("perf", "diagnostics", "publish", {
      file: getRelativePathLabel(documentContext.filePath),
      version: requestedVersion,
      count: reportedDiagnostics.length,
      rawCount: rawDiagnostics.length,
      mode: includeSemanticDiagnostics ? (options.reason || "full") : "fast",
      totalMs: elapsedMs.toFixed(1),
      ...getDiagnosticsProfileFields(diagnosticsProfile),
    });

    connection.sendDiagnostics({
      uri,
      diagnostics: reportedDiagnostics.map((diagnostic) => ({
        range: toRange(document, diagnostic.start, diagnostic.end),
        severity: diagnosticSeverity(diagnostic.category),
        code: diagnostic.code,
        source: "pocketpages-server-script",
        message: diagnostic.message,
      })),
    });
  }

  function publishManagedDiagnostics() {
    for (const virtualCode of context.core.getManagedVirtualCodes()) {
      publishDiagnostics(virtualCode.uri);
    }
  }

  function provideCodeActions(params) {
    const document = getDocumentByUri(params.textDocument.uri);
    if (!document) {
      return null;
    }

    const documentContext = getDocumentContextByUri(params.textDocument.uri);
    if (!documentContext) {
      return null;
    }

    const actions = documentContext.service.getCodeActions(
      documentContext.filePath,
      document.getText(),
      {
        start: document.offsetAt(params.range.start),
        end: document.offsetAt(params.range.end),
      }
    );
    if (!actions || !actions.length) {
      return null;
    }

    return actions.map((action) => ({
      title: action.title,
      kind: context.CodeActionKind.QuickFix,
      edit: helpers.toWorkspaceEdit(action.edits || []),
    }));
  }

  return {
    scheduleDiagnostics,
    cancelScheduledDiagnostics,
    publishDiagnostics,
    publishManagedDiagnostics,
    provideCodeActions,
  };
}

module.exports = {
  createDiagnosticsFeatureService,
};
