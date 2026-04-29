"use strict";

const SCHEMA_COMPLETION_SIGNAL_WINDOW = 400;
const SCHEMA_COMPLETION_SOURCE_FILE_CACHE_LIMIT = 12;

function hasSchemaCompletionSignal(analysisText, analysisOffset) {
  const text = String(analysisText || "");
  const offset = Math.max(0, Math.min(Number(analysisOffset) || 0, text.length));
  const prefix = text.slice(Math.max(0, offset - SCHEMA_COMPLETION_SIGNAL_WINDOW), offset);
  return /\$app\./.test(prefix) || /\.(?:get|set)\s*\(/.test(prefix);
}

function createCompletionFeatureHandlers(deps) {
  const {
    createSourceFileForText,
    elapsedMilliseconds,
    getAnalysisContextAtOffset,
    getPathContextAtOffset,
    getScriptCollectionContext,
    getScriptFieldContext,
    getScriptSchemaContextAtOffset,
  } = deps;
  const schemaCompletionSourceFileCache = new Map();

  const getSchemaCompletionSourceFile = (filePath, analysisStart, analysisText) => {
    if (typeof createSourceFileForText !== "function") {
      return null;
    }

    const cacheKey = `${filePath}:${analysisStart}`;
    const cached = schemaCompletionSourceFileCache.get(cacheKey);
    if (cached && cached.analysisText === analysisText) {
      return cached.sourceFile;
    }

    const sourceFile = createSourceFileForText(`${filePath}.__schema_completion__.js`, analysisText);
    schemaCompletionSourceFileCache.set(cacheKey, {
      analysisText,
      sourceFile,
    });

    while (schemaCompletionSourceFileCache.size > SCHEMA_COMPLETION_SOURCE_FILE_CACHE_LIMIT) {
      const firstKey = schemaCompletionSourceFileCache.keys().next().value;
      schemaCompletionSourceFileCache.delete(firstKey);
    }

    return sourceFile;
  };

  return {
    getCompletionData(service, filePath, documentText, offset, options = {}) {
      const profile = options && options.profile ? options.profile : {};
      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset, {
        profile,
        requirePreparedVirtualState: options.requirePreparedVirtualState === true,
      });
      if (!virtualState) {
        return null;
      }

      const { virtual, virtualOffset } = virtualState;
      const completionsStartedAt = process.hrtime.bigint();
      const info = service.languageService.getCompletionsAtPosition(virtual.fileName, virtualOffset, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: false,
        triggerCharacter: options.triggerCharacter || undefined,
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
        isIncomplete: !!info.isIncomplete,
        replacementSpan,
        profile,
        virtualFileName: virtual.fileName,
        virtualOffset,
      };
    },

    getCustomCompletionData(service, filePath, documentText, offset) {
      const collectionMethodNames = service.projectIndex.getCollectionMethodNames();
      const pathContext = getPathContextAtOffset(documentText, offset, { filePath });
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
      if (!hasSchemaCompletionSignal(analysisText, analysisOffset)) {
        return null;
      }

      const schemaSourceFile = getSchemaCompletionSourceFile(filePath, analysisStart, analysisText);
      const schemaContext =
        typeof getScriptSchemaContextAtOffset === "function"
          ? getScriptSchemaContextAtOffset(analysisText, analysisOffset, {
              collectionMethodNames,
              sourceFile: schemaSourceFile,
            })
          : getScriptCollectionContext(analysisText, analysisOffset, { collectionMethodNames }) ||
            getScriptFieldContext(analysisText, analysisOffset);

      if (schemaContext && schemaContext.kind === "collection-name") {
        return {
          start: analysisStart + schemaContext.start,
          end: analysisStart + schemaContext.end,
          items: service.projectIndex.getCollectionNames().map((collectionName) => ({
            label: collectionName,
            insertText: collectionName,
            detail: "PocketBase collection",
            documentation: `Collection from ${service.projectIndex.getSchemaState().schemaPath}`,
            category: "collection-name",
          })),
        };
      }

      if (!schemaContext || schemaContext.kind !== "record-field") {
        return null;
      }

      const collectionReference = service.resolveSchemaFieldCollectionReference(
        filePath,
        documentText,
        schemaContext,
        {
          analysisText,
          analysisStart,
          analysisSourceFile: schemaSourceFile,
        }
      );
      if (!collectionReference) {
        return null;
      }

      const collectionName = collectionReference.collectionName;
      return {
        start: analysisStart + schemaContext.start,
        end: analysisStart + schemaContext.end,
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

    getQuickInfo(service, filePath, documentText, offset, options = {}) {
      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset, {
        requirePreparedVirtualState: options.requirePreparedVirtualState === true,
      });
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

      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset, {
        requirePreparedVirtualState: options.requirePreparedVirtualState === true,
      });
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
