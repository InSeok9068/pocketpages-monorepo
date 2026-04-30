"use strict";

function createMaintenanceFeatureService(context) {
  const { core, helpers } = context;
  const {
    clearCachedCompletionItemsForUri,
    createRequestId,
    elapsedMilliseconds: helperElapsedMilliseconds,
    getPerformanceBucket,
    getRelativePathLabel,
    logServer,
    refreshPullDiagnostics,
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

  function countEditFiles(edits) {
    const files = new Set();
    for (const edit of Array.isArray(edits) ? edits : []) {
      if (edit && edit.filePath) {
        files.add(edit.filePath);
      }
    }
    return files.size;
  }

  return {
    provideProbeCurrentFile({ uri }) {
      const startedAt = process.hrtime.bigint();
      const req = requestId("probe");
      const filePath = uriToFilePath(uri);
      const result = core.probeFile(filePath);
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("info", "probe", "file", {
        req,
        case: result.hasAppRoot ? "app-root" : "no-app-root",
        file: getRelativePathLabel(filePath),
        hasAppRoot: result.hasAppRoot,
        diagnostics: result.diagnostics,
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("structure", totalMs),
      });
      return result;
    },

    provideRefreshDiagnostics({ uri }) {
      const startedAt = process.hrtime.bigint();
      const req = requestId("diagcmd");
      const filePath = uri ? uriToFilePath(uri) : null;
      refreshPullDiagnostics("command");
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("info", "diagnostics", "refresh-command", {
        req,
        case: "manual-command",
        file: filePath ? getRelativePathLabel(filePath) : null,
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("structure", totalMs),
      });
      return { ok: true };
    },

    provideReloadCaches({ uri }) {
      const req = requestId("cache");
      const scopedFilePath = uri ? uriToFilePath(uri) : null;
      const startedAt = process.hrtime.bigint();
      const result = core.reloadCaches(scopedFilePath);
      for (const affectedUri of result && Array.isArray(result.affectedUris) ? result.affectedUris : []) {
        clearCachedCompletionItemsForUri(affectedUri);
      }
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("info", "cache", "reload", {
        req,
        case: result.scoped ? "app-scoped" : "workspace",
        scoped: result.scoped,
        file: scopedFilePath ? getRelativePathLabel(scopedFilePath) : null,
        affectedOpenDocuments: Array.isArray(result.affectedUris) ? result.affectedUris.length : 0,
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("structure", totalMs),
      });
      return result;
    },

    provideAllFileReferences({ uri }) {
      const req = requestId("allref");
      const filePath = uriToFilePath(uri);
      const startedAt = process.hrtime.bigint();
      const result = core.getFileReferenceResult(filePath);
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "references", "all-file", {
        req,
        case: result ? "file-reference-graph" : "no-reference-query",
        file: getRelativePathLabel(filePath),
        referenceKind: result && result.referenceQuery ? result.referenceQuery.kind : null,
        references: result && Array.isArray(result.references) ? result.references.length : 0,
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("navigation", totalMs),
      });
      return result;
    },

    provideFileRenameEdits({ oldUri, newUri }) {
      const req = requestId("fren");
      const oldFilePath = uriToFilePath(oldUri);
      const newFilePath = uriToFilePath(newUri);
      const startedAt = process.hrtime.bigint();
      const result = core.getFileRenameEdits(oldFilePath, newFilePath);
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "rename", "edits", {
        req,
        case: "file-rename-edits",
        old: getRelativePathLabel(oldFilePath),
        next: getRelativePathLabel(newFilePath),
        files: countEditFiles(result),
        edits: Array.isArray(result) ? result.length : 0,
        totalMs: totalMs.toFixed(1),
        perf: performanceBucket("navigation", totalMs),
      });
      return result;
    },
  };
}

module.exports = {
  createMaintenanceFeatureService,
};
