"use strict";

function createDiagnosticsFeatureHandlers(deps) {
  const {
    collectClientScriptSyntacticDiagnostics,
    collectPathContexts,
    collectResolveCallSpansFromScript,
    collectResolveCallSpansFromTemplate,
    createDocumentAnalysis,
    dedupeDiagnostics,
    elapsedMilliseconds,
  } = deps;

  return {
    getDiagnostics(service, filePath, documentText, options = {}) {
      const profile = options && options.profile ? options.profile : null;
      const includeSemanticDiagnostics = options.includeSemanticDiagnostics !== false;
      const totalStartedAt = profile ? process.hrtime.bigint() : null;
      if (profile) {
        profile.includeSemanticDiagnostics = includeSemanticDiagnostics;
      }

      let stepStartedAt = profile ? process.hrtime.bigint() : null;
      const documentAnalysis = createDocumentAnalysis({
        filePath,
        documentText,
        collectResolveCallSpansFromScript,
        collectResolveCallSpansFromTemplate,
        collectPathContexts,
      });
      if (profile) {
        profile.createDocumentAnalysisMs = elapsedMilliseconds(stepStartedAt);
      }

      const blocks = documentAnalysis.getBlocks();
      const templateBlocks = documentAnalysis.getTemplateBlocks();
      const collectionMethodNames = service.projectIndex.getCollectionMethodNames();

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      const diagnostics = collectClientScriptSyntacticDiagnostics(documentText);
      if (profile) {
        profile.collectClientScriptSyntacticDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      diagnostics.push(...service.collectPrivateResolveDiagnostics(filePath, documentAnalysis));
      if (profile) {
        profile.collectPrivateResolveDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      diagnostics.push(
        ...service.collectServerBlockDiagnostics(
          filePath,
          documentText,
          blocks,
          collectionMethodNames,
          documentAnalysis,
          { includeSemanticDiagnostics }
        )
      );
      if (profile) {
        profile.collectServerBlockDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      diagnostics.push(
        ...service.collectTemplateDiagnostics(
          filePath,
          documentText,
          blocks,
          templateBlocks,
          collectionMethodNames,
          documentAnalysis,
          { includeSemanticDiagnostics }
        )
      );
      if (profile) {
        profile.collectTemplateDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      diagnostics.push(
        ...service.collectScriptSchemaDiagnostics(filePath, documentText, collectionMethodNames)
      );
      if (profile) {
        profile.collectScriptSchemaDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      diagnostics.push(...service.collectProjectRuleDiagnostics(filePath, documentText, documentAnalysis));
      if (profile) {
        profile.collectProjectRuleDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      const dedupedDiagnostics = dedupeDiagnostics(diagnostics);
      if (profile) {
        profile.dedupeDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
        profile.getDiagnosticsMs = elapsedMilliseconds(totalStartedAt);
      }

      return dedupedDiagnostics;
    },

    getCodeActions(service, filePath, documentText, range) {
      if (!range || typeof range.start !== "number" || typeof range.end !== "number") {
        return [];
      }

      const actions = [];
      const actionKeys = new Set();

      for (const diagnostic of service.getDiagnostics(filePath, documentText)) {
        if (!Array.isArray(diagnostic.fixes) || !diagnostic.fixes.length) {
          continue;
        }

        if (!deps.rangesOverlap(diagnostic.start, diagnostic.end, range.start, range.end)) {
          continue;
        }

        for (const fix of diagnostic.fixes) {
          const actionKey = `${diagnostic.code}:${diagnostic.start}:${diagnostic.end}:${fix.title}`;
          if (actionKeys.has(actionKey)) {
            continue;
          }

          actionKeys.add(actionKey);
          actions.push({
            title: fix.title,
            kind: "quickfix",
            diagnostic: {
              code: diagnostic.code,
              start: diagnostic.start,
              end: diagnostic.end,
              message: diagnostic.message,
            },
            edits: (fix.edits || []).map((edit) => ({
              filePath: deps.normalizePath(edit.filePath || filePath),
              start: edit.start,
              end: edit.end,
              newText: edit.newText,
            })),
          });
        }
      }

      return actions;
    },
  };
}

module.exports = {
  createDiagnosticsFeatureHandlers,
};
