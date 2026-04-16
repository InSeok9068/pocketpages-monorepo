"use strict";

function createCompletionFeatureHandlers(deps) {
  const {
    elapsedMilliseconds,
    getAnalysisContextAtOffset,
    getPathContextAtOffset,
    getScriptCollectionContext,
    getScriptFieldContext,
  } = deps;

  return {
    getCompletionData(service, filePath, documentText, offset) {
      const profile = {};
      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset, { profile });
      if (!virtualState) {
        return null;
      }

      const { virtual, virtualOffset } = virtualState;
      const completionsStartedAt = process.hrtime.bigint();
      const info = service.languageService.getCompletionsAtPosition(virtual.fileName, virtualOffset, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: false,
      });
      profile.getCompletionsAtPositionMs = elapsedMilliseconds(completionsStartedAt);

      if (!info) {
        return null;
      }

      let replacementSpan = null;
      if (info.optionalReplacementSpan) {
        const start = service.mapVirtualOffsetToDocumentOffset(
          virtual.fileName,
          info.optionalReplacementSpan.start
        );
        const end = service.mapVirtualOffsetToDocumentOffset(
          virtual.fileName,
          info.optionalReplacementSpan.start + info.optionalReplacementSpan.length
        );

        if (start !== null && end !== null) {
          replacementSpan = { start, end };
        }
      }

      return {
        entries: info.entries,
        replacementSpan,
        profile,
        virtualFileName: virtual.fileName,
        virtualOffset,
      };
    },

    getCustomCompletionData(service, filePath, documentText, offset) {
      const collectionMethodNames = service.projectIndex.getCollectionMethodNames();
      const pathContext = getPathContextAtOffset(documentText, offset);
      if (
        pathContext &&
        (pathContext.kind === "resolve-path" ||
          pathContext.kind === "include-path" ||
          pathContext.kind === "asset-path" ||
          pathContext.kind === "route-path")
      ) {
        const candidates =
          pathContext.kind === "resolve-path"
            ? service.projectIndex.getResolveCandidates(filePath, pathContext.value)
            : pathContext.kind === "include-path"
              ? service.projectIndex.getIncludeCandidates(filePath, pathContext.value)
              : pathContext.kind === "asset-path"
                ? service.projectIndex.getAssetCandidates(filePath)
                : service.projectIndex.getRouteCandidates({ routeSource: pathContext.routeSource });

        return {
          start: pathContext.start,
          end: pathContext.end,
          items: candidates.map((candidate) => ({
            label: candidate.value,
            insertText: candidate.value,
            detail: candidate.detail,
            documentation: candidate.filePath,
            targetFilePath: candidate.filePath,
            category: pathContext.kind,
          })),
        };
      }

      const includeLocalCompletion = service.getIncludeLocalCompletionData(filePath, documentText, offset);
      if (includeLocalCompletion) {
        return includeLocalCompletion;
      }

      const analysisContext = getAnalysisContextAtOffset(filePath, documentText, offset);
      if (!analysisContext) {
        return null;
      }

      const { analysisText, analysisOffset, analysisStart } = analysisContext;
      const collectionContext = getScriptCollectionContext(analysisText, analysisOffset, {
        collectionMethodNames,
      });
      if (collectionContext) {
        return {
          start: analysisStart + collectionContext.start,
          end: analysisStart + collectionContext.end,
          items: service.projectIndex.getCollectionNames().map((collectionName) => ({
            label: collectionName,
            insertText: collectionName,
            detail: "PocketBase collection",
            documentation: `Collection from ${service.projectIndex.getSchemaState().schemaPath}`,
            category: "collection-name",
          })),
        };
      }

      const fieldContext = getScriptFieldContext(analysisText, analysisOffset);
      if (!fieldContext) {
        return null;
      }

      const collectionReference = service.resolveSchemaFieldCollectionReference(
        filePath,
        documentText,
        fieldContext,
        {
          analysisText,
          analysisStart,
        }
      );
      if (!collectionReference) {
        return null;
      }

      const collectionName = collectionReference.collectionName;
      return {
        start: analysisStart + fieldContext.start,
        end: analysisStart + fieldContext.end,
        items: service.projectIndex.getFields(collectionName).map((field) => ({
          label: field.name,
          insertText: field.name,
          detail: `${collectionName}.${field.name}`,
          documentation: field.type ? `Field type: ${field.type}` : collectionName,
          category: "record-field",
        })),
      };
    },

    getCompletionDetails(service, virtualFileName, virtualOffset, name, source) {
      return service.languageService.getCompletionEntryDetails(
        virtualFileName,
        virtualOffset,
        name,
        {},
        source,
        {}
      );
    },

    getQuickInfo(service, filePath, documentText, offset) {
      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset);
      if (!virtualState) {
        return null;
      }

      const { virtual, virtualOffset } = virtualState;
      const quickInfo = service.languageService.getQuickInfoAtPosition(virtual.fileName, virtualOffset);
      if (!quickInfo) {
        return null;
      }

      const start = service.mapVirtualOffsetToDocumentOffset(
        virtual.fileName,
        quickInfo.textSpan.start
      );
      const end = service.mapVirtualOffsetToDocumentOffset(
        virtual.fileName,
        quickInfo.textSpan.start + quickInfo.textSpan.length
      );

      return {
        displayText: deps.ts.displayPartsToString(quickInfo.displayParts || []),
        documentation: deps.ts.displayPartsToString(quickInfo.documentation || []),
        start,
        end,
      };
    },

    getSignatureHelp(service, filePath, documentText, offset, options = {}) {
      const includeSignatureHelp = service.getIncludeSignatureHelp(filePath, documentText, offset);
      if (includeSignatureHelp) {
        return includeSignatureHelp;
      }

      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset);
      if (!virtualState) {
        return null;
      }

      return (
        service.languageService.getSignatureHelpItems(
          virtualState.virtual.fileName,
          virtualState.virtualOffset,
          {
            triggerReason: {
              kind: options.isRetrigger
                ? "retrigger"
                : options.triggerCharacter
                  ? "characterTyped"
                  : "invoked",
              triggerCharacter: options.triggerCharacter,
            },
          }
        ) || null
      );
    },

    getCustomSignatureHelp(service, filePath, documentText, offset) {
      return service.getIncludeSignatureHelp(filePath, documentText, offset);
    },
  };
}

module.exports = {
  createCompletionFeatureHandlers,
};
