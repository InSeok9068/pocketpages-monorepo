"use strict";

function createMaintenanceFeatureService(context) {
  const { core, helpers } = context;
  const {
    clearCachedCompletionItemsForUri,
    createRequestId,
    elapsedMilliseconds: helperElapsedMilliseconds,
    getDocumentByUri,
    getDocumentContextByUri,
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

    provideExtractPartialEdits({ uri, range, partialName }) {
      const req = requestId("xpart");
      const document = uri && typeof getDocumentByUri === "function" ? getDocumentByUri(uri) : null;
      const documentContext = uri && typeof getDocumentContextByUri === "function" ? getDocumentContextByUri(uri) : null;
      const filePath = uriToFilePath(uri);
      const startedAt = process.hrtime.bigint();
      const sourceText = document && typeof document.getText === "function"
        ? document.getText()
        : core.getDocumentTextForFile(filePath);
      const result = documentContext && document && range && range.start && range.end
        ? documentContext.service.getExtractPartialEdits(
          documentContext.filePath,
          sourceText,
          {
            start: document.offsetAt(range.start),
            end: document.offsetAt(range.end),
          },
          partialName
        )
        : {
            ok: false,
            message: "Unable to read the active PocketPages document.",
          };
      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "refactor", "extract-partial", {
        req,
        case: result && result.ok ? "extract-partial-edits" : "extract-partial-unavailable",
        file: getRelativePathLabel(filePath),
        partial: result && result.partialFilePath ? getRelativePathLabel(result.partialFilePath) : null,
        edits: result && Array.isArray(result.edits) ? result.edits.length : 0,
        creates: result && Array.isArray(result.creates) ? result.creates.length : 0,
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
