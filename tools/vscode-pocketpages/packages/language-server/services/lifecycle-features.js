"use strict";

function createLifecycleFeatureService(context) {
  const { core, documents, helpers } = context;
  const {
    clearCachedCompletionItemsForUri,
    cancelScheduledDiagnostics,
    getRelativePathLabel,
    isEjsFilePath,
    isScriptFilePath,
    logServer,
    publishDiagnostics,
    scheduleDiagnostics,
    uriToFilePath,
  } = helpers;

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

  function applyWatchedFileChanges(changes) {
    const result = core.handleWatchedFileChanges(changes);

    for (const uri of result.affectedUris) {
      clearCachedCompletionItemsForUri(uri);
      const filePath = uriToFilePath(uri);
      if (isEjsFilePath(filePath) || isScriptFilePath(filePath)) {
        scheduleDiagnostics(uri);
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
      logServer("info", "document", "open", {
        file: getRelativePathLabel(uriToFilePath(event.document.uri)),
        languageId: event.document.languageId,
        version: event.document.version,
      });
      publishDiagnostics(event.document.uri);
    },

    handleDidChangeContent(event) {
      clearCachedCompletionItemsForUri(event.document.uri);
      core.updateDocument({
        uri: event.document.uri,
        languageId: event.document.languageId,
        version: event.document.version,
        text: event.document.getText(),
      });
      logServer("perf", "document", "change", {
        file: getRelativePathLabel(uriToFilePath(event.document.uri)),
        version: event.document.version,
        changes: Array.isArray(event.contentChanges) ? event.contentChanges.length : 0,
      });

      const filePath = uriToFilePath(event.document.uri);
      if (isEjsFilePath(filePath) || isScriptFilePath(filePath)) {
        scheduleDiagnostics(event.document.uri);
      }
    },

    handleDidClose(event) {
      clearCachedCompletionItemsForUri(event.document.uri);
      cancelScheduledDiagnostics(event.document.uri);
      context.state.diagnosticRunIds.delete(event.document.uri);
      core.closeDocument(event.document.uri);
      logServer("info", "document", "close", {
        file: getRelativePathLabel(uriToFilePath(event.document.uri)),
      });
      context.connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
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
      publishDiagnostics(uri);
    },
  };
}

module.exports = {
  createLifecycleFeatureService,
};
