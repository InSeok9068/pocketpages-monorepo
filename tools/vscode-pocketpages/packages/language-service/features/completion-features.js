"use strict";

const SCHEMA_COMPLETION_SIGNAL_WINDOW = 400;
const SCHEMA_COMPLETION_SOURCE_FILE_CACHE_LIMIT = 12;
const SCHEMA_COMPLETION_VALUE_PREVIEW_LIMIT = 5;

function hasSchemaCompletionSignal(analysisText, analysisOffset) {
  const text = String(analysisText || "");
  const offset = Math.max(0, Math.min(Number(analysisOffset) || 0, text.length));
  const prefix = text.slice(Math.max(0, offset - SCHEMA_COMPLETION_SIGNAL_WINDOW), offset);
  return (
    /\$app\./.test(prefix) ||
    /\.(?:get|set)\s*\(/.test(prefix) ||
    /\.(?:find[A-Z][\w$]*|countRecords|recordQuery|isCollectionNameUnique)\s*\(/.test(prefix)
  );
}

function formatInlineCode(value) {
  const text = String(value || "");
  return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
}

function formatSchemaValueList(values, limit = SCHEMA_COMPLETION_VALUE_PREVIEW_LIMIT) {
  const stringValues = (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string");
  if (!stringValues.length) {
    return "";
  }

  const visibleValues = stringValues.slice(0, limit).map(formatInlineCode);
  const suffix = stringValues.length > limit ? `, +${stringValues.length - limit} more` : "";
  return `${visibleValues.join(", ")}${suffix}`;
}

function formatSchemaFieldDocumentation(service, collectionName, field) {
  const typeText = service.projectIndex.getFieldTypeText(collectionName, field.name) || "any";
  const parts = [
    `Field: ${formatInlineCode(`${collectionName}.${field.name}`)}`,
    `Schema type: ${formatInlineCode(field.type || "system")}`,
    `TypeScript type: ${formatInlineCode(typeText)}`,
  ];

  if (typeof field.required === "boolean") {
    parts.push(`Required: ${formatInlineCode(field.required ? "yes" : "no")}`);
  }
  if (field.relationCollectionName) {
    parts.push(`Relation: ${formatInlineCode(field.relationCollectionName)}`);
  }
  const valueList = formatSchemaValueList(field.values);
  if (valueList) {
    parts.push(`Values: ${valueList}`);
  }
  if (typeof field.maxSelect === "number" && field.maxSelect > 1) {
    parts.push(`Max select: ${formatInlineCode(field.maxSelect)}`);
  }
  if (field.isSystem) {
    parts.push("System field");
  }

  return parts.join("\n\n");
}

function createSchemaFieldCompletionItem(service, collectionName, field, category) {
  const typeText = service.projectIndex.getFieldTypeText(collectionName, field.name) || "any";
  return {
    label: field.name,
    insertText: field.name,
    detail: `${collectionName}.${field.name}: ${typeText}`,
    documentation: formatSchemaFieldDocumentation(service, collectionName, field),
    category,
  };
}

function formatSchemaCollectionDocumentation(service, collectionName) {
  const fields = service.projectIndex.getFields(collectionName);
  const schemaPath = service.projectIndex.getSchemaState().schemaPath;
  return [
    `Collection: ${formatInlineCode(collectionName)}`,
    `Fields: ${formatInlineCode(fields.length)}`,
    schemaPath ? `Schema: ${formatInlineCode(schemaPath)}` : "",
  ].filter(Boolean).join("\n\n");
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

      const collectionMethodNames = service.projectIndex.getCollectionMethodNames();
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
        if (
          typeof service.isSchemaAppReceiverContext === "function" &&
          !service.isSchemaAppReceiverContext(filePath, documentText, schemaContext, {
            analysisStart,
          })
        ) {
          return null;
        }

        return {
          start: analysisStart + schemaContext.start,
          end: analysisStart + schemaContext.end,
          items: service.projectIndex.getCollectionNames().map((collectionName) => ({
            label: collectionName,
            insertText: collectionName,
            detail: "PocketBase collection",
            documentation: formatSchemaCollectionDocumentation(service, collectionName),
            category: "collection-name",
          })),
        };
      }

      if (schemaContext && (schemaContext.kind === "filter-field" || schemaContext.kind === "sort-field")) {
        if (typeof service.resolveSchemaCollectionArgumentReference !== "function") {
          return null;
        }

        const collectionReference = service.resolveSchemaCollectionArgumentReference(
          filePath,
          documentText,
          schemaContext,
          {
            analysisText,
            analysisStart,
            analysisSourceFile: schemaSourceFile,
          }
        );
        if (!collectionReference || collectionReference.confidence !== "high") {
          return null;
        }

        const collectionName = collectionReference.collectionName;
        return {
          start: analysisStart + schemaContext.start,
          end: analysisStart + schemaContext.end,
          items: service.projectIndex.getFields(collectionName).map((field) =>
            createSchemaFieldCompletionItem(service, collectionName, field, schemaContext.kind)
          ),
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
        items: service.projectIndex.getFields(collectionName).map((field) =>
          createSchemaFieldCompletionItem(service, collectionName, field, "record-field")
        ),
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
