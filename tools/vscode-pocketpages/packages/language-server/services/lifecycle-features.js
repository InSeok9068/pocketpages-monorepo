"use strict";

function createLifecycleFeatureService(context) {
  const { core, documents, helpers } = context;
  const {
    clearCachedCompletionItemsForUri,
    cancelScheduledDocumentRequests,
    clearDocumentRuntimeState,
    cancelFirstRequestWarmup,
    createRequestId,
    elapsedMilliseconds: helperElapsedMilliseconds,
    getPerformanceBucket,
    getRelativePathLabel,
    isEjsFilePath,
    isExcludedPocketPagesScriptPath,
    isScriptFilePath,
    logServer,
    rememberInteractiveOffset,
    refreshPullDiagnostics,
    scheduleDiagnosticsRefreshForDocument,
    scheduleFirstRequestWarmup,
    updateDocumentRuntimeState,
    uriToFilePath,
  } = helpers;

  function requestId(prefix) {
    return typeof createRequestId === "function" ? createRequestId(prefix) : null;
  }

  function elapsedMilliseconds(startTime) {
    return typeof helperElapsedMilliseconds === "function"
      ? helperElapsedMilliseconds(startTime)
      : Number(process.hrtime.bigint() - startTime) / 1e6;
  }

  function performanceBucket(kind, elapsedMs) {
    return typeof getPerformanceBucket === "function"
      ? getPerformanceBucket(kind, elapsedMs)
      : null;
  }

  function shouldRunDiagnosticsForFile(filePath) {
    return (
      (isEjsFilePath(filePath) || isScriptFilePath(filePath)) &&
      !isExcludedPocketPagesScriptPath(filePath)
    );
  }

  function toWatchedFileChangeKind(type) {
    switch (type) {
      case context.FileChangeType.Created:
        return "create";
      case context.FileChangeType.Deleted:
        return "delete";
      case context.FileChangeType.Changed:
      default:
        return "change";
    }
  }

  function getPreferredChangeOffset(document, contentChanges) {
    if (!document || typeof document.offsetAt !== "function") {
      return null;
    }

    const changes = Array.isArray(contentChanges) ? contentChanges : [];
    for (const change of changes) {
      if (change && change.range && change.range.start) {
        return document.offsetAt(change.range.start);
      }
    }

    return null;
  }

  function applyWatchedFileChanges(changes) {
    const result = core.handleWatchedFileChanges(changes);
    let scheduledDiagnostics = 0;

    for (const uri of result.affectedUris) {
      clearCachedCompletionItemsForUri(uri);
      const filePath = uriToFilePath(uri);
      if (shouldRunDiagnosticsForFile(filePath)) {
        scheduleDiagnosticsRefreshForDocument(uri, { reason: "file-watch" });
        scheduledDiagnostics += 1;
      }
    }

    for (const appResult of result.appResults) {
      logServer("info", "cache", "reload-app", {
        app: getRelativePathLabel(appResult.appRoot),
        openDocuments: appResult.affectedUris.length,
        reason: "file-watch",
        files: appResult.changes.map((change) => getRelativePathLabel(change.filePath)),
        changeKinds: [...new Set(appResult.changes.map((change) => change.type))],
      });
    }

    return {
      ...result,
      scheduledDiagnostics,
    };
  }

  return {
    handleDidOpen(event) {
      core.openDocument({
        uri: event.document.uri,
        languageId: event.document.languageId,
        version: event.document.version,
        text: event.document.getText(),
      });
      if (typeof updateDocumentRuntimeState === "function") {
        updateDocumentRuntimeState(event.document.uri, event.document, {
          opened: true,
        });
      }
      logServer("info", "document", "open", {
        file: getRelativePathLabel(uriToFilePath(event.document.uri)),
        languageId: event.document.languageId,
        version: event.document.version,
      });
      const filePath = uriToFilePath(event.document.uri);
      if (shouldRunDiagnosticsForFile(filePath) && typeof scheduleFirstRequestWarmup === "function") {
        scheduleFirstRequestWarmup(event.document.uri, { reason: "open" });
      }
    },

    handleDidChangeContent(event) {
      const filePath = uriToFilePath(event.document.uri);
      const hasContentChanges = Array.isArray(event.contentChanges) && event.contentChanges.length > 0;
      const preferredChangeOffset = getPreferredChangeOffset(event.document, event.contentChanges);
      let rememberedOffset = false;
      if (hasContentChanges) {
        clearCachedCompletionItemsForUri(event.document.uri);
      }
      if (
        shouldRunDiagnosticsForFile(filePath) &&
        preferredChangeOffset !== null &&
        preferredChangeOffset !== undefined &&
        preferredChangeOffset !== "" &&
        Number.isFinite(Number(preferredChangeOffset)) &&
        typeof rememberInteractiveOffset === "function"
      ) {
        rememberInteractiveOffset(event.document.uri, preferredChangeOffset, "edit");
        rememberedOffset = true;
      }
      if (hasContentChanges) {
        core.updateDocument({
          uri: event.document.uri,
          languageId: event.document.languageId,
          version: event.document.version,
          text: event.document.getText(),
        }, {
          prepareVirtualCode: false,
        });
      }
      if (typeof updateDocumentRuntimeState === "function") {
        updateDocumentRuntimeState(event.document.uri, event.document, {
          changed: hasContentChanges,
        });
      }
      logServer("perf", "document", "change", {
        file: getRelativePathLabel(filePath),
        version: event.document.version,
        changes: Array.isArray(event.contentChanges) ? event.contentChanges.length : 0,
        changeSource: hasContentChanges ? "lsp-content-change" : "document-sync",
        preferredOffset: rememberedOffset ? preferredChangeOffset : null,
        diagnosticsQuiet: shouldRunDiagnosticsForFile(filePath) && hasContentChanges,
        prepared: hasContentChanges ? "deferred" : "unchanged",
      });
    },

    handleDidClose(event) {
      clearCachedCompletionItemsForUri(event.document.uri);
      if (typeof cancelScheduledDocumentRequests === "function") {
        cancelScheduledDocumentRequests(event.document.uri);
      }
      if (typeof cancelFirstRequestWarmup === "function") {
        cancelFirstRequestWarmup(event.document.uri);
      }
      if (typeof clearDocumentRuntimeState === "function") {
        clearDocumentRuntimeState(event.document.uri);
      }
      if (context.state.diagnosticRunIds instanceof Map) {
        context.state.diagnosticRunIds.delete(event.document.uri);
      }
      core.closeDocument(event.document.uri);
      logServer("info", "document", "close", {
        file: getRelativePathLabel(uriToFilePath(event.document.uri)),
      });
    },

    handleDidChangeWatchedFiles(event) {
      const startedAt = process.hrtime.bigint();
      const req = requestId("watch");
      const changes = [];
      let ignoredOpenDocumentChanges = 0;

      for (const change of event.changes || []) {
        if (change.type === context.FileChangeType.Changed && documents.get(change.uri)) {
          ignoredOpenDocumentChanges += 1;
          continue;
        }

        changes.push({
          filePath: uriToFilePath(change.uri),
          type: toWatchedFileChangeKind(change.type),
        });
      }

      if (!changes.length) {
        const totalMs = elapsedMilliseconds(startedAt);
        logServer("perf", "watch", "files", {
          req,
          case: "ignored-open-documents",
          incoming: Array.isArray(event.changes) ? event.changes.length : 0,
          ignoredOpenDocuments: ignoredOpenDocumentChanges,
          processed: 0,
          totalMs: totalMs.toFixed(1),
          perf: performanceBucket("structure", totalMs),
        });
        return;
      }

      const result = applyWatchedFileChanges(changes);
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "watch", "files", {
        req,
        case: "workspace-file-changes",
        incoming: Array.isArray(event.changes) ? event.changes.length : 0,
        ignoredOpenDocuments: ignoredOpenDocumentChanges,
        processed: changes.length,
        apps: result.appResults.length,
        affectedOpenDocuments: result.affectedUris.length,
        diagnosticsRefreshes: result.scheduledDiagnostics,
        changeKinds: [...new Set(changes.map((change) => change.type))],
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("structure", totalMs),
      });
    },

    handleDidManualSave({ uri }) {
      const startedAt = process.hrtime.bigint();
      const req = requestId("save");
      const document = documents.get(uri);
      logServer("info", "diagnostics", "manual-save", {
        req,
        case: "manual-save-refresh",
        file: getRelativePathLabel(uriToFilePath(uri)),
        version: document ? document.version : null,
      });
      if (typeof updateDocumentRuntimeState === "function") {
        updateDocumentRuntimeState(uri, document, {
          saved: true,
        });
      }
      refreshPullDiagnostics("manual-save");
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "diagnostics", "manual-save-refresh", {
        req,
        case: "manual-save-refresh",
        file: getRelativePathLabel(uriToFilePath(uri)),
        version: document ? document.version : null,
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("structure", totalMs),
      });
    },
  };
}

module.exports = {
  createLifecycleFeatureService,
};
