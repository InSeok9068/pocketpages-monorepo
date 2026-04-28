"use strict";

const ALWAYS_REPORTED_EJS_DIAGNOSTIC_CODES = new Set([
  "pp-manual-flash-query",
  "pp-unresolved-route-path",
]);

function createDiagnosticsFeatureService(context) {
  const {
    connection,
    helpers,
  } = context;
  const {
    LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT,
    LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS,
    LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET,
    PULL_DIAGNOSTICS_INITIAL_YIELD_MS,
    diagnosticSeverity,
    elapsedMilliseconds,
    ensureDocumentPrepared,
    getCachedDiagnosticsResult,
    getDocumentByUri,
    getDocumentContextByUri,
    getDocumentRuntimeState,
    getDiagnosticsProfileFields,
    getPreferredDiagnosticOffset,
    getRelativePathLabel,
    isActiveDiagnosticRun,
    isStaleDocumentVersion,
    isPullDiagnosticRefreshSupported,
    logServer,
    scheduleDocumentRequest,
    setCachedDiagnosticsResult,
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

  function toLspDiagnostics(document, diagnostics) {
    return diagnostics.map((diagnostic) => ({
      range: toRange(document, diagnostic.start, diagnostic.end),
      severity: diagnosticSeverity(diagnostic.category),
      code: diagnostic.code,
      source: "pocketpages-server-script",
      message: diagnostic.message,
    }));
  }

  function toDiagnosticCodeValue(code) {
    if (code && typeof code === "object" && Object.prototype.hasOwnProperty.call(code, "value")) {
      return String(code.value);
    }

    return code === undefined || code === null ? "" : String(code);
  }

  function toCodeActionDiagnosticKey(code, start, end, message) {
    return [
      toDiagnosticCodeValue(code),
      Number.isFinite(start) ? start : -1,
      Number.isFinite(end) ? end : -1,
      String(message || ""),
    ].join(":");
  }

  function toLspDiagnosticKey(document, diagnostic) {
    if (
      !document ||
      !diagnostic ||
      !diagnostic.range ||
      !diagnostic.range.start ||
      !diagnostic.range.end
    ) {
      return null;
    }

    return toCodeActionDiagnosticKey(
      diagnostic.code,
      document.offsetAt(diagnostic.range.start),
      document.offsetAt(diagnostic.range.end),
      diagnostic.message
    );
  }

  function toRawDiagnosticKey(diagnostic) {
    if (
      !diagnostic ||
      typeof diagnostic.start !== "number" ||
      typeof diagnostic.end !== "number"
    ) {
      return null;
    }

    return toCodeActionDiagnosticKey(
      diagnostic.code,
      diagnostic.start,
      diagnostic.end,
      diagnostic.message
    );
  }

  function getCachedCodeActionDiagnostics(uri, document, params) {
    const cachedResult =
      typeof getCachedDiagnosticsResult === "function"
        ? getCachedDiagnosticsResult(uri, "pull")
        : null;
    if (
      !cachedResult ||
      cachedResult.documentVersion !== document.version ||
      !cachedResult.laneDiagnostics ||
      typeof cachedResult.laneDiagnostics !== "object"
    ) {
      return null;
    }

    const diagnosticsByKey = new Map();
    for (const laneDiagnostics of Object.values(cachedResult.laneDiagnostics)) {
      for (const diagnostic of Array.isArray(laneDiagnostics) ? laneDiagnostics : []) {
        const diagnosticKey = toRawDiagnosticKey(diagnostic);
        if (diagnosticKey && !diagnosticsByKey.has(diagnosticKey)) {
          diagnosticsByKey.set(diagnosticKey, diagnostic);
        }
      }
    }

    const cachedDiagnostics = [...diagnosticsByKey.values()];
    const contextDiagnostics =
      params &&
      params.context &&
      Array.isArray(params.context.diagnostics)
        ? params.context.diagnostics
        : [];
    if (!contextDiagnostics.length) {
      return cachedDiagnostics;
    }

    const contextDiagnosticKeys = new Set(
      contextDiagnostics
        .map((diagnostic) => toLspDiagnosticKey(document, diagnostic))
        .filter(Boolean)
    );
    return cachedDiagnostics.filter((diagnostic) =>
      contextDiagnosticKeys.has(toRawDiagnosticKey(diagnostic))
    );
  }

  function wait(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async function yieldBeforeHeavyDiagnostics(token, shouldCancel) {
    const delayMs = Number(PULL_DIAGNOSTICS_INITIAL_YIELD_MS);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await wait(delayMs);
    } else {
      await Promise.resolve();
    }

    return !!(token && token.isCancellationRequested) || shouldCancel("after-initial-yield");
  }

  function getDiagnosticsResultState(document, documentContext) {
    if (
      documentContext &&
      documentContext.service &&
      document &&
      typeof document.getText === "function" &&
      typeof documentContext.service.getDiagnosticsLaneResultIds === "function" &&
      typeof documentContext.service.getDiagnosticsResultId === "function"
    ) {
      const options = {
        includeSemanticDiagnostics: true,
        includeProjectRuleDiagnostics: true,
        includeTypeScriptDiagnostics: true,
        includeServerBlockDiagnostics: true,
        includeTemplateDiagnostics: true,
        includeScriptSchemaDiagnostics: true,
      };
      const laneMetadata =
        typeof documentContext.service.getDiagnosticsLaneMetadata === "function"
          ? documentContext.service.getDiagnosticsLaneMetadata(
              documentContext.filePath,
              document.getText(),
              options
            )
          : null;
      const laneResultIds = documentContext.service.getDiagnosticsLaneResultIds(
        documentContext.filePath,
        document.getText(),
        {
          ...options,
          laneMetadata,
        }
      );
      return {
        laneResultIds,
        laneMetadata,
        resultId: documentContext.service.getDiagnosticsResultId(
          documentContext.filePath,
          document.getText(),
          {
            ...options,
            laneResultIds,
          }
        ),
      };
    }

    return {
      laneResultIds: null,
      laneMetadata: null,
      resultId: [
        "pull",
        document ? document.version : "missing",
        documentContext && documentContext.service ? documentContext.service.projectVersion : "0",
      ].join(":"),
    };
  }

  function isLargeEjsDocument(documentContext, document) {
    const limit = Number(LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT);
    return (
      Number.isFinite(limit) &&
      limit > 0 &&
      documentContext &&
      document &&
      helpers.isEjsFilePath(documentContext.filePath) &&
      document.getText().length >= limit
    );
  }

  function getRecentChangeQuietDelayMs(uri) {
    const quietMs = Number(LARGE_DOCUMENT_DIAGNOSTICS_QUIET_MS);
    if (!Number.isFinite(quietMs) || quietMs <= 0) {
      return 0;
    }

    const runtimeState =
      typeof getDocumentRuntimeState === "function"
        ? getDocumentRuntimeState(uri)
        : null;
    const changedAt = runtimeState && Number(runtimeState.changedAt);
    if (!Number.isFinite(changedAt) || changedAt <= 0) {
      return 0;
    }

    const elapsedMs = Date.now() - changedAt;
    if (elapsedMs >= quietMs) {
      return 0;
    }

    return Math.max(1, quietMs - elapsedMs);
  }

  function createSemanticBudget(uri, documentContext, document, cachedResult) {
    if (!isLargeEjsDocument(documentContext, document)) {
      return null;
    }

    if (!cachedResult || cachedResult.budgetDeferred === true) {
      return null;
    }

    const maxSemanticRegions = Number(LARGE_DOCUMENT_SEMANTIC_REGION_BUDGET);
    if (!Number.isFinite(maxSemanticRegions) || maxSemanticRegions <= 0) {
      return null;
    }

    const preferredOffset =
      typeof getPreferredDiagnosticOffset === "function"
        ? getPreferredDiagnosticOffset(uri)
        : null;
    return {
      enabled: true,
      maxSemanticRegions,
      preferredOffset,
      deferred: false,
    };
  }

  function canRefreshPullDiagnostics() {
    return (
      typeof isPullDiagnosticRefreshSupported === "function" &&
      isPullDiagnosticRefreshSupported() &&
      connection.languages &&
      connection.languages.diagnostics &&
      typeof connection.languages.diagnostics.refresh === "function"
    );
  }

  function refreshPullDiagnostics(reason) {
    if (!canRefreshPullDiagnostics()) {
      return;
    }

    try {
      connection.languages.diagnostics.refresh();
      logServer("info", "diagnostics", "pull-refresh", {
        reason: reason || "refresh",
      });
    } catch (error) {
      logServer("warn", "diagnostics", "pull-refresh-failed", {
        reason: reason || "refresh",
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  function schedulePullDiagnosticsRefresh(reason, delayMs = 500) {
    if (!canRefreshPullDiagnostics()) {
      return null;
    }

    const run = () => refreshPullDiagnostics(reason);
    if (typeof scheduleDocumentRequest === "function") {
      return scheduleDocumentRequest(
        "workspace",
        "diagnostics:refresh",
        undefined,
        delayMs,
        run
      );
    }

    return setTimeout(run, delayMs);
  }

  function scheduleDiagnosticsRefreshForDocument(uri, options = {}) {
    const document = getDocumentByUri(uri);
    schedulePullDiagnosticsRefresh(options.reason || "schedule");

    if (document) {
      logServer("perf", "diagnostics", "schedule", {
        file: getRelativePathLabel(helpers.uriToFilePath(uri)),
        version: document.version,
        mode: "pull",
        reason: options.reason || "",
        refresh: true,
      });
    }
  }

  async function providePullDiagnostics(params, token) {
    const uri = params && params.textDocument ? params.textDocument.uri : null;
    if (!uri || (token && token.isCancellationRequested)) {
      return null;
    }

    const runId = helpers.beginDiagnosticRun(uri);
    const document = getDocumentByUri(uri);
    if (!document) {
      return { kind: "full", items: [] };
    }

    const documentContext = getDocumentContextByUri(uri);
    if (!documentContext || helpers.isExcludedPocketPagesScriptPath(documentContext.filePath)) {
      return { kind: "full", items: [] };
    }

    const cachedResult =
      typeof getCachedDiagnosticsResult === "function"
        ? getCachedDiagnosticsResult(uri, "pull")
        : null;
    const requestedVersion = document.version;
    const quietDelayMs = isLargeEjsDocument(documentContext, document)
      ? getRecentChangeQuietDelayMs(uri)
      : 0;
    if (quietDelayMs > 0) {
      schedulePullDiagnosticsRefresh("large-quiet", quietDelayMs + 100);
      if (
        params.previousResultId &&
        cachedResult &&
        cachedResult.resultId === params.previousResultId
      ) {
        logServer("perf", "diagnostics", "pull-deferred", {
          file: getRelativePathLabel(documentContext.filePath),
          version: requestedVersion,
          mode: "large-quiet",
          delayMs: quietDelayMs,
          result: "unchanged",
        });
        return {
          kind: "unchanged",
          resultId: params.previousResultId,
        };
      }

      if (
        cachedResult &&
        cachedResult.documentVersion === requestedVersion &&
        cachedResult.resultId
      ) {
        logServer("perf", "diagnostics", "pull-deferred", {
          file: getRelativePathLabel(documentContext.filePath),
          version: requestedVersion,
          mode: "large-quiet",
          delayMs: quietDelayMs,
          result: "cached-full",
        });
        return {
          kind: "full",
          resultId: cachedResult.resultId,
          items: Array.isArray(cachedResult.items) ? cachedResult.items : [],
        };
      }

      const quietResultId = [
        "quiet",
        requestedVersion,
        document.getText().length,
      ].join(":");
      logServer("perf", "diagnostics", "pull-deferred", {
        file: getRelativePathLabel(documentContext.filePath),
        version: requestedVersion,
        mode: "large-quiet",
        delayMs: quietDelayMs,
        result: "empty",
      });
      return {
        kind: "full",
        resultId: quietResultId,
        items: [],
      };
    }

    if (typeof ensureDocumentPrepared === "function") {
      ensureDocumentPrepared(uri);
    }
    const diagnosticsResultState = getDiagnosticsResultState(document, documentContext);
    const { resultId, laneResultIds, laneMetadata } = diagnosticsResultState;
    if (
      params.previousResultId &&
      params.previousResultId === resultId &&
      cachedResult &&
      cachedResult.resultId === resultId
    ) {
      logServer("perf", "diagnostics", "pull-unchanged", {
        file: getRelativePathLabel(documentContext.filePath),
        version: document.version,
        resultId,
      });
      return {
        kind: "unchanged",
        resultId,
      };
    }

    const startedAt = process.hrtime.bigint();
    const diagnosticsProfile = {};
    const shouldCancel = (stage) =>
      !isActiveDiagnosticRun(uri, runId) ||
      isStaleDocumentVersion(uri, requestedVersion) ||
      !!(token && token.isCancellationRequested);

    if (await yieldBeforeHeavyDiagnostics(token, shouldCancel)) {
      logServer("warn", "diagnostics", "cancelled", {
        file: getRelativePathLabel(documentContext.filePath),
        version: requestedVersion,
        lane: "pull",
        stage: "after-initial-yield",
      });
      return null;
    }

    const laneDiagnosticsOut = {};
    const semanticBudget = createSemanticBudget(
      uri,
      documentContext,
      document,
      cachedResult
    );
    const rawDiagnostics = documentContext.service.getDiagnostics(
      documentContext.filePath,
      document.getText(),
      {
        profile: diagnosticsProfile,
        includeSemanticDiagnostics: true,
        includeProjectRuleDiagnostics: true,
        includeTypeScriptDiagnostics: true,
        includeServerBlockDiagnostics: true,
        includeTemplateDiagnostics: true,
        includeScriptSchemaDiagnostics: true,
        requirePreparedVirtualState: true,
        currentLaneResultIds: laneResultIds,
        currentLaneMetadata: laneMetadata,
        previousLaneResultIds: cachedResult && cachedResult.laneResultIds,
        previousLaneMetadata: cachedResult && cachedResult.laneMetadata,
        previousLaneDiagnostics: cachedResult && cachedResult.laneDiagnostics,
        laneDiagnosticsOut,
        semanticBudget,
        shouldCancel,
      }
    );
    if (diagnosticsProfile.cancelled || shouldCancel("after-pull-diagnostics")) {
      logServer("warn", "diagnostics", "cancelled", {
        file: getRelativePathLabel(documentContext.filePath),
        version: requestedVersion,
        lane: "pull",
        stage: diagnosticsProfile.cancelledAt || "after-pull-diagnostics",
      });
      return null;
    }

    const reportedDiagnostics = filterReportedDiagnostics(
      uri,
      documentContext,
      rawDiagnostics
    );
    const elapsedMs = elapsedMilliseconds(startedAt);
    logServer("perf", "diagnostics", "pull", {
      file: getRelativePathLabel(documentContext.filePath),
      version: requestedVersion,
      count: reportedDiagnostics.length,
      rawCount: rawDiagnostics.length,
      mode: "pull",
      totalMs: elapsedMs.toFixed(1),
      ...getDiagnosticsProfileFields(diagnosticsProfile),
    });

    const budgetDeferred = !!(semanticBudget && semanticBudget.deferred);
    if (budgetDeferred) {
      schedulePullDiagnosticsRefresh("large-semantic-budget", 800);
    }

    const result = {
      kind: "full",
      resultId: budgetDeferred
        ? `${resultId}|budget:${requestedVersion}:${Date.now()}`
        : resultId,
      documentVersion: requestedVersion,
      budgetDeferred,
      finalResultId: budgetDeferred ? resultId : undefined,
      laneResultIds,
      laneMetadata,
      laneDiagnostics: laneDiagnosticsOut,
      items: toLspDiagnostics(document, reportedDiagnostics),
    };
    if (typeof setCachedDiagnosticsResult === "function") {
      setCachedDiagnosticsResult(uri, "pull", result);
    }

    return result;
  }

  function refreshManagedDiagnostics() {
    schedulePullDiagnosticsRefresh("managed");
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

    const cachedDiagnostics = getCachedCodeActionDiagnostics(
      params.textDocument.uri,
      document,
      params
    );
    if (cachedDiagnostics === null && typeof ensureDocumentPrepared === "function") {
      ensureDocumentPrepared(params.textDocument.uri);
    }
    const actions = documentContext.service.getCodeActions(
      documentContext.filePath,
      document.getText(),
      {
        start: document.offsetAt(params.range.start),
        end: document.offsetAt(params.range.end),
      },
      {
        diagnostics: cachedDiagnostics === null ? undefined : cachedDiagnostics,
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
    providePullDiagnostics,
    refreshPullDiagnostics,
    scheduleDiagnosticsRefreshForDocument,
    schedulePullDiagnosticsRefresh,
    refreshManagedDiagnostics,
    provideCodeActions,
  };
}

module.exports = {
  createDiagnosticsFeatureService,
};
