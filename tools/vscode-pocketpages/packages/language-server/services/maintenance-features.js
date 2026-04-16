"use strict";

function createMaintenanceFeatureService(context) {
  const { core, helpers } = context;
  const {
    clearCachedCompletionItemsForUri,
    elapsedMilliseconds,
    getRelativePathLabel,
    logServer,
    publishDiagnostics,
    uriToFilePath,
  } = helpers;

  return {
    provideProbeCurrentFile({ uri }) {
      const filePath = uriToFilePath(uri);
      const result = core.probeFile(filePath);
      logServer("info", "probe", "file", {
        file: getRelativePathLabel(filePath),
        hasAppRoot: result.hasAppRoot,
        diagnostics: result.diagnostics,
      });
      return result;
    },

    provideRefreshDiagnostics({ uri }) {
      publishDiagnostics(uri);
      return { ok: true };
    },

    provideReloadCaches({ uri }) {
      const scopedFilePath = uri ? uriToFilePath(uri) : null;
      const startedAt = process.hrtime.bigint();
      const result = core.reloadCaches(scopedFilePath);
      for (const affectedUri of result && Array.isArray(result.affectedUris) ? result.affectedUris : []) {
        clearCachedCompletionItemsForUri(affectedUri);
      }
      logServer("info", "cache", "reload", {
        scoped: result.scoped,
        file: scopedFilePath ? getRelativePathLabel(scopedFilePath) : null,
        totalMs: elapsedMilliseconds(startedAt).toFixed(1),
      });
      return result;
    },

    provideAllFileReferences({ uri }) {
      const filePath = uriToFilePath(uri);
      const startedAt = process.hrtime.bigint();
      const result = core.getFileReferenceResult(filePath);
      logServer("perf", "references", "all-file", {
        file: getRelativePathLabel(filePath),
        references: result && Array.isArray(result.references) ? result.references.length : 0,
        totalMs: elapsedMilliseconds(startedAt).toFixed(1),
      });
      return result;
    },

    provideFileRenameEdits({ oldUri, newUri }) {
      const oldFilePath = uriToFilePath(oldUri);
      const newFilePath = uriToFilePath(newUri);
      const startedAt = process.hrtime.bigint();
      const result = core.getFileRenameEdits(oldFilePath, newFilePath);
      logServer("perf", "rename", "edits", {
        old: getRelativePathLabel(oldFilePath),
        next: getRelativePathLabel(newFilePath),
        edits: Array.isArray(result) ? result.length : 0,
        totalMs: elapsedMilliseconds(startedAt).toFixed(1),
      });
      return result;
    },
  };
}

module.exports = {
  createMaintenanceFeatureService,
};
