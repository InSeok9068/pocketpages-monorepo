"use strict";

function createDiagnosticsFeatureHandlers(deps) {
  const {
    collectClientScriptSyntacticDiagnostics,
    collectPathContexts,
    collectResolveCallSpansFromScript,
    collectResolveCallSpansFromTemplate,
    collectSchemaContexts,
    createDocumentAnalysis,
    dedupeDiagnostics,
    elapsedMilliseconds,
  } = deps;

  function isValidEditOffset(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  }

  function getCodeActionEditDocumentText(service, currentFilePath, currentDocumentText, editFilePath) {
    const normalizedCurrentFilePath = deps.normalizePath(currentFilePath);
    const normalizedEditFilePath = deps.normalizePath(editFilePath);
    if (normalizedEditFilePath === normalizedCurrentFilePath) {
      return currentDocumentText;
    }

    if (service && typeof service.getDocumentTextForTarget === "function") {
      const targetText = service.getDocumentTextForTarget(
        normalizedEditFilePath,
        normalizedCurrentFilePath,
        currentDocumentText
      );
      if (typeof targetText === "string") {
        return targetText;
      }
    }

    if (service && typeof service.readFile === "function") {
      const targetText = service.readFile(normalizedEditFilePath);
      if (typeof targetText === "string") {
        return targetText;
      }
    }

    return null;
  }

  function normalizeCodeActionEdit(service, currentFilePath, currentDocumentText, edit) {
    if (!edit || typeof edit !== "object") {
      return null;
    }

    const normalizedEditFilePath = deps.normalizePath(edit.filePath || currentFilePath);
    if (
      !isValidEditOffset(edit.start) ||
      !isValidEditOffset(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      typeof edit.newText !== "string"
    ) {
      return null;
    }

    const targetText = getCodeActionEditDocumentText(
      service,
      currentFilePath,
      currentDocumentText,
      normalizedEditFilePath
    );
    if (typeof targetText !== "string" || edit.end > targetText.length) {
      return null;
    }

    if (edit.start === edit.end && edit.newText.length === 0) {
      return null;
    }

    return {
      filePath: normalizedEditFilePath,
      start: edit.start,
      end: edit.end,
      newText: edit.newText,
    };
  }

  function normalizeCodeActionEdits(service, currentFilePath, currentDocumentText, rawEdits) {
    if (!Array.isArray(rawEdits) || !rawEdits.length) {
      return null;
    }

    const edits = [];
    for (const rawEdit of rawEdits) {
      const edit = normalizeCodeActionEdit(service, currentFilePath, currentDocumentText, rawEdit);
      if (!edit) {
        return null;
      }
      edits.push(edit);
    }

    const sortedEdits = edits.slice().sort((left, right) => {
      if (left.filePath !== right.filePath) {
        return left.filePath < right.filePath ? -1 : 1;
      }
      if (left.start !== right.start) {
        return left.start - right.start;
      }
      return left.end - right.end;
    });

    let previousEdit = null;
    for (const edit of sortedEdits) {
      if (
        previousEdit &&
        previousEdit.filePath === edit.filePath &&
        (edit.start < previousEdit.end || edit.start === previousEdit.start)
      ) {
        return null;
      }
      previousEdit = edit;
    }

    return edits;
  }

  return {
    getDiagnostics(service, filePath, documentText, options = {}) {
      const profile = options && options.profile ? options.profile : null;
      const includeSemanticDiagnostics = options.includeSemanticDiagnostics !== false;
      const includeTypeScriptDiagnostics = options.includeTypeScriptDiagnostics !== false;
      const includeProjectRuleDiagnostics = options.includeProjectRuleDiagnostics !== false;
      const includeScriptSchemaDiagnostics = options.includeScriptSchemaDiagnostics !== false;
      const includeServerBlockDiagnostics = options.includeServerBlockDiagnostics !== false;
      const includeTemplateDiagnostics = options.includeTemplateDiagnostics !== false;
      const requirePreparedVirtualState = options.requirePreparedVirtualState === true;
      const shouldCancel =
        options && typeof options.shouldCancel === "function"
          ? options.shouldCancel
          : null;
      const currentLaneResultIds =
        options && options.currentLaneResultIds && typeof options.currentLaneResultIds === "object"
          ? options.currentLaneResultIds
          : null;
      const previousLaneResultIds =
        options && options.previousLaneResultIds && typeof options.previousLaneResultIds === "object"
          ? options.previousLaneResultIds
          : null;
      const currentLaneMetadata =
        options && options.currentLaneMetadata && typeof options.currentLaneMetadata === "object"
          ? options.currentLaneMetadata
          : null;
      const previousLaneMetadata =
        options && options.previousLaneMetadata && typeof options.previousLaneMetadata === "object"
          ? options.previousLaneMetadata
          : null;
      const previousLaneDiagnostics =
        options && options.previousLaneDiagnostics && typeof options.previousLaneDiagnostics === "object"
          ? options.previousLaneDiagnostics
          : null;
      const laneDiagnosticsOut =
        options && options.laneDiagnosticsOut && typeof options.laneDiagnosticsOut === "object"
          ? options.laneDiagnosticsOut
          : null;
      const semanticBudget =
        options && options.semanticBudget && typeof options.semanticBudget === "object"
          ? options.semanticBudget
          : null;
      const totalStartedAt = profile ? process.hrtime.bigint() : null;
      if (profile) {
        profile.includeSemanticDiagnostics = includeSemanticDiagnostics;
        profile.includeTypeScriptDiagnostics = includeTypeScriptDiagnostics;
        profile.includeProjectRuleDiagnostics = includeProjectRuleDiagnostics;
        profile.includeScriptSchemaDiagnostics = includeScriptSchemaDiagnostics;
        profile.includeServerBlockDiagnostics = includeServerBlockDiagnostics;
        profile.includeTemplateDiagnostics = includeTemplateDiagnostics;
        profile.requirePreparedVirtualState = requirePreparedVirtualState;
      }

      function isCancelled(stage) {
        if (!shouldCancel || !shouldCancel(stage)) {
          return false;
        }

        if (profile) {
          profile.cancelled = true;
          profile.cancelledAt = stage;
          if (totalStartedAt) {
            profile.getDiagnosticsMs = elapsedMilliseconds(totalStartedAt);
          }
        }
        return true;
      }

      function getReusableLaneDiagnostics(lane) {
        if (
          !currentLaneResultIds ||
          !previousLaneResultIds ||
          !previousLaneDiagnostics ||
          previousLaneResultIds[lane] !== currentLaneResultIds[lane] ||
          !Array.isArray(previousLaneDiagnostics[lane])
        ) {
          return null;
        }

        if (profile) {
          if (!Array.isArray(profile.reusedDiagnosticLanes)) {
            profile.reusedDiagnosticLanes = [];
          }
          profile.reusedDiagnosticLanes.push(lane);
        }
        if (
          typeof service.remapReusableLaneDiagnostics === "function" &&
          currentLaneMetadata &&
          previousLaneMetadata
        ) {
          return service.remapReusableLaneDiagnostics(
            lane,
            previousLaneDiagnostics[lane],
            previousLaneMetadata[lane],
            currentLaneMetadata[lane]
          );
        }
        return previousLaneDiagnostics[lane].slice();
      }

      function pushLaneDiagnostics(lane, laneDiagnostics) {
        const normalizedDiagnostics = Array.isArray(laneDiagnostics) ? laneDiagnostics : [];
        if (laneDiagnosticsOut) {
          laneDiagnosticsOut[lane] = normalizedDiagnostics.slice();
        }
        diagnostics.push(...normalizedDiagnostics);
      }

      let stepStartedAt = profile ? process.hrtime.bigint() : null;
      const documentAnalysis = createDocumentAnalysis({
        filePath,
        documentText,
        collectResolveCallSpansFromScript,
        collectResolveCallSpansFromTemplate,
        collectPathContexts,
        collectSchemaContexts,
      });
      if (profile) {
        profile.createDocumentAnalysisMs = elapsedMilliseconds(stepStartedAt);
      }
      if (isCancelled("after-document-analysis")) {
        return [];
      }

      const blocks = documentAnalysis.getBlocks();
      const templateBlocks = documentAnalysis.getTemplateBlocks();
      const collectionMethodNames = service.projectIndex.getCollectionMethodNames();
      if (isCancelled("after-block-analysis")) {
        return [];
      }

      let preparedDocumentState = null;
      if (includeTypeScriptDiagnostics && typeof service.prepareDiagnosticsVirtualState === "function") {
        stepStartedAt = profile ? process.hrtime.bigint() : null;
        const preparedResult = service.prepareDiagnosticsVirtualState(filePath, documentText, {
          requirePreparedVirtualState,
        });
        preparedDocumentState = preparedResult && preparedResult.state ? preparedResult.state : null;
        if (profile) {
          profile.prepareDiagnosticsVirtualStateMs = elapsedMilliseconds(stepStartedAt);
          profile.preparedVirtualStateKind =
            preparedResult && preparedResult.kind ? preparedResult.kind : "unknown";
        }
      } else if (profile) {
        profile.prepareDiagnosticsVirtualStateMs = 0;
      }
      if (isCancelled("after-prepare-diagnostics-virtual-state")) {
        return [];
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      const diagnostics = [];
      const reusableClientSyntaxDiagnostics = getReusableLaneDiagnostics("client-syntax");
      if (reusableClientSyntaxDiagnostics) {
        pushLaneDiagnostics("client-syntax", reusableClientSyntaxDiagnostics);
      } else {
        pushLaneDiagnostics("client-syntax", collectClientScriptSyntacticDiagnostics(documentText));
      }
      if (profile) {
        profile.collectClientScriptSyntacticDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }
      if (isCancelled("after-client-script-diagnostics")) {
        return [];
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      const reusablePrivateResolveDiagnostics = getReusableLaneDiagnostics("private-resolve");
      if (reusablePrivateResolveDiagnostics) {
        pushLaneDiagnostics("private-resolve", reusablePrivateResolveDiagnostics);
      } else {
        pushLaneDiagnostics("private-resolve", service.collectPrivateResolveDiagnostics(filePath, documentAnalysis));
      }
      if (profile) {
        profile.collectPrivateResolveDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
      }
      if (isCancelled("after-private-resolve-diagnostics")) {
        return [];
      }

      if (includeServerBlockDiagnostics) {
        stepStartedAt = profile ? process.hrtime.bigint() : null;
        const reusableServerDiagnostics = getReusableLaneDiagnostics("server");
        if (reusableServerDiagnostics) {
          pushLaneDiagnostics("server", reusableServerDiagnostics);
        } else {
          pushLaneDiagnostics("server", service.collectServerBlockDiagnostics(
            filePath,
            documentText,
            blocks,
            collectionMethodNames,
            documentAnalysis,
            {
              includeSemanticDiagnostics,
              includeTypeScriptDiagnostics,
              preparedDocumentState,
              profile,
              regionCache: {
                currentMetadata: currentLaneMetadata && currentLaneMetadata.server,
                previousMetadata: previousLaneMetadata && previousLaneMetadata.server,
                previousDiagnostics: previousLaneDiagnostics && previousLaneDiagnostics.server,
              },
              semanticBudget,
              shouldCancel,
            }
          ));
        }
        if (profile) {
          profile.collectServerBlockDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
        }
        if (isCancelled("after-server-block-diagnostics")) {
          return [];
        }
      } else if (profile) {
        profile.collectServerBlockDiagnosticsMs = 0;
      }

      if (includeTemplateDiagnostics) {
        stepStartedAt = profile ? process.hrtime.bigint() : null;
        const reusableTemplateDiagnostics = getReusableLaneDiagnostics("template");
        if (reusableTemplateDiagnostics) {
          pushLaneDiagnostics("template", reusableTemplateDiagnostics);
        } else {
          pushLaneDiagnostics("template", service.collectTemplateDiagnostics(
            filePath,
            documentText,
            blocks,
            templateBlocks,
            collectionMethodNames,
            documentAnalysis,
            {
              includeSemanticDiagnostics,
              includeTypeScriptDiagnostics,
              preparedDocumentState,
              profile,
              regionCache: {
                currentMetadata: currentLaneMetadata && currentLaneMetadata.template,
                previousMetadata: previousLaneMetadata && previousLaneMetadata.template,
                previousDiagnostics: previousLaneDiagnostics && previousLaneDiagnostics.template,
              },
              semanticBudget,
              shouldCancel,
            }
          ));
        }
        if (profile) {
          profile.collectTemplateDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
        }
        if (isCancelled("after-template-diagnostics")) {
          return [];
        }
      } else if (profile) {
        profile.collectTemplateDiagnosticsMs = 0;
      }

      if (includeScriptSchemaDiagnostics) {
        stepStartedAt = profile ? process.hrtime.bigint() : null;
        const reusableScriptSchemaDiagnostics = getReusableLaneDiagnostics("script-schema");
        if (reusableScriptSchemaDiagnostics) {
          pushLaneDiagnostics("script-schema", reusableScriptSchemaDiagnostics);
        } else {
          pushLaneDiagnostics(
            "script-schema",
            service.collectScriptSchemaDiagnostics(filePath, documentText, collectionMethodNames, documentAnalysis)
          );
        }
        if (profile) {
          profile.collectScriptSchemaDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
        }
        if (isCancelled("after-script-schema-diagnostics")) {
          return [];
        }
      } else if (profile) {
        profile.collectScriptSchemaDiagnosticsMs = 0;
      }

      if (includeProjectRuleDiagnostics) {
        stepStartedAt = profile ? process.hrtime.bigint() : null;
        const projectRuleLaneDiagnostics = [];
        const projectRuleLanes = [
          "project-rule:agents",
          "project-rule:include-callers",
        ];
        const reusableProjectRuleDiagnostics = getReusableLaneDiagnostics("project-rule");
        if (reusableProjectRuleDiagnostics && !projectRuleLanes.some((lane) => currentLaneResultIds && currentLaneResultIds[lane])) {
          projectRuleLaneDiagnostics.push(...reusableProjectRuleDiagnostics);
        } else {
          const collectProjectRuleLane = (lane) => {
            if (typeof service.collectProjectRuleLaneDiagnostics === "function") {
              return service.collectProjectRuleLaneDiagnostics(
                lane,
                filePath,
                documentText,
                documentAnalysis
              );
            }

            const projectRuleCollectors =
              typeof service.collectProjectRuleDiagnosticsByLane === "function"
                ? service.collectProjectRuleDiagnosticsByLane(filePath, documentText, documentAnalysis)
                : {
                    "project-rule:agents": service.collectProjectRuleDiagnostics(filePath, documentText, documentAnalysis),
                    "project-rule:include-callers": [],
                  };
            return projectRuleCollectors[lane] || [];
          };

          for (const lane of projectRuleLanes) {
            const reusableLaneDiagnostics = getReusableLaneDiagnostics(lane);
            const laneDiagnostics = reusableLaneDiagnostics || collectProjectRuleLane(lane);
            pushLaneDiagnostics(lane, laneDiagnostics);
            projectRuleLaneDiagnostics.push(...laneDiagnostics);
          }
        }
        pushLaneDiagnostics("project-rule", projectRuleLaneDiagnostics);
        if (profile) {
          profile.collectProjectRuleDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
        }
        if (isCancelled("after-project-rule-diagnostics")) {
          return [];
        }
      } else if (profile) {
        profile.collectProjectRuleDiagnosticsMs = 0;
      }

      stepStartedAt = profile ? process.hrtime.bigint() : null;
      const dedupedDiagnostics = dedupeDiagnostics(diagnostics);
      if (profile) {
        profile.dedupeDiagnosticsMs = elapsedMilliseconds(stepStartedAt);
        profile.getDiagnosticsMs = elapsedMilliseconds(totalStartedAt);
      }

      return dedupedDiagnostics;
    },

    getCodeActions(service, filePath, documentText, range, options = {}) {
      if (!range || typeof range.start !== "number" || typeof range.end !== "number") {
        return [];
      }

      const actions = [];
      const actionKeys = new Set();
      const diagnostics = Array.isArray(options.diagnostics)
        ? options.diagnostics
        : service.getDiagnostics(filePath, documentText);

      for (const diagnostic of diagnostics) {
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

          const edits = normalizeCodeActionEdits(service, filePath, documentText, fix.edits || []);
          if (!edits) {
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
            edits,
          });
        }
      }

      const contextualActions =
        service && typeof service.getPocketPagesJSDocTypeCodeActions === "function"
          ? service.getPocketPagesJSDocTypeCodeActions(filePath, documentText, range)
          : [];
      for (const action of Array.isArray(contextualActions) ? contextualActions : []) {
        const actionKey = `context:${range.start}:${range.end}:${action.title}`;
        if (!action || !action.title || actionKeys.has(actionKey)) {
          continue;
        }

        const edits = normalizeCodeActionEdits(service, filePath, documentText, action.edits || []);
        if (!edits) {
          continue;
        }

        actionKeys.add(actionKey);
        actions.push({
          title: action.title,
          kind: action.kind || "quickfix",
          edits,
        });
      }

      return actions;
    },
  };
}

module.exports = {
  createDiagnosticsFeatureHandlers,
};
