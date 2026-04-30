"use strict";

function createLifecycleFeatureService(context) {
  const { core, documents, helpers } = context;
  const {
    clearCachedCompletionItemsForUri,
    cancelScheduledDocumentRequests,
    clearDocumentRuntimeState,
    cancelFirstRequestWarmup,
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

    return changes.length ? 0 : null;
  }

  function applyWatchedFileChanges(changes) {
    const result = core.handleWatchedFileChanges(changes);

    for (const uri of result.affectedUris) {
      clearCachedCompletionItemsForUri(uri);
      const filePath = uriToFilePath(uri);
      if (shouldRunDiagnosticsForFile(filePath)) {
        scheduleDiagnosticsRefreshForDocument(uri, { reason: "file-watch" });
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

    return result;
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
      clearCachedCompletionItemsForUri(event.document.uri);
      const filePath = uriToFilePath(event.document.uri);
      const preferredChangeOffset = getPreferredChangeOffset(event.document, event.contentChanges);
      if (
        shouldRunDiagnosticsForFile(filePath) &&
        Number.isFinite(Number(preferredChangeOffset)) &&
        typeof rememberInteractiveOffset === "function"
      ) {
        rememberInteractiveOffset(event.document.uri, preferredChangeOffset, "edit");
      }
      core.updateDocument({
        uri: event.document.uri,
        languageId: event.document.languageId,
        version: event.document.version,
        text: event.document.getText(),
      }, {
        prepareVirtualCode: false,
      });
      if (typeof updateDocumentRuntimeState === "function") {
        updateDocumentRuntimeState(event.document.uri, event.document, {
          changed: true,
        });
      }
      logServer("perf", "document", "change", {
        file: getRelativePathLabel(filePath),
        version: event.document.version,
        changes: Array.isArray(event.contentChanges) ? event.contentChanges.length : 0,
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
      const changes = [];

      for (const change of event.changes || []) {
        if (change.type === context.FileChangeType.Changed && documents.get(change.uri)) {
          continue;
        }

        changes.push({
          filePath: uriToFilePath(change.uri),
          type: toWatchedFileChangeKind(change.type),
        });
      }

      if (!changes.length) {
        return;
      }

      applyWatchedFileChanges(changes);
    },

    handleDidManualSave({ uri }) {
      logServer("info", "diagnostics", "manual-save", {
        file: getRelativePathLabel(uriToFilePath(uri)),
      });
      if (typeof updateDocumentRuntimeState === "function") {
        updateDocumentRuntimeState(uri, documents.get(uri), {
          saved: true,
        });
      }
      refreshPullDiagnostics("manual-save");
    },
  };
}

module.exports = {
  createLifecycleFeatureService,
};
