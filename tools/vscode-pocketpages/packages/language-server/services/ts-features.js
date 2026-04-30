"use strict";

const {
  createStableCompletionTextEdit,
  getCompletionTriggerCharacter,
  isTypeScriptCompletionTriggerAllowed,
} = require("./completion-helpers");

function createTypeScriptFeatureService(context) {
  const { ts, helpers, InsertTextFormat, TextDocument, URI } = context;
  const {
    COMPLETION_KIND_MAP,
    getDocumentByUri,
    getDocumentContextByFilePath,
    getDocumentContextByUri,
    toMarkupContent,
    toRange,
    toSignatureHelp,
    toWorkspaceEdit,
    isExcludedPocketPagesScriptPath,
    isSchemaSupportOnlyHookScriptPath,
    shouldAbortDocumentRequest,
    getRelativePathLabel,
    getCompletionProfileFields,
    createRequestId,
    getPerformanceBucket,
    LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT,
    elapsedMilliseconds,
    formatCompletionTrigger,
    ensureDocumentPrepared,
    logServer,
  } = helpers;

  function getDocumentRequestContext(params) {
    const document = getDocumentByUri(params.textDocument.uri);
    if (!document) {
      return null;
    }

    const documentContext = getDocumentContextByUri(params.textDocument.uri);
    if (!documentContext) {
      return null;
    }

    return {
      document,
      documentContext,
      documentText: document.getText(),
      offset: document.offsetAt(params.position),
    };
  }

  function isMappedFeatureEnabled(documentContext, document, offset, capabilityName) {
    if (!helpers.isEjsFilePath(documentContext.filePath)) {
      return true;
    }

    return context.core.isFeatureEnabledAtOffset(
      document.uri.toString(),
      offset,
      capabilityName
    );
  }

  function isLargeEjsQuoteTrigger(documentContext, document, context) {
    if (!helpers.isEjsFilePath(documentContext.filePath)) {
      return false;
    }

    if (
      !context ||
      context.triggerKind !== 2 ||
      (context.triggerCharacter !== "\"" && context.triggerCharacter !== "'")
    ) {
      return false;
    }

    const limit = Number(LARGE_DOCUMENT_DIAGNOSTICS_CHAR_LIMIT);
    return (
      Number.isFinite(limit) &&
      typeof document.getText === "function" &&
      document.getText().length >= limit
    );
  }

  return {
    provideCompletionItems(params, token) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      const requestId =
        params.__pocketpagesRequestId ||
        (typeof createRequestId === "function" ? createRequestId("cmp") : null);
      if (
        isExcludedPocketPagesScriptPath(documentContext.filePath) ||
        isSchemaSupportOnlyHookScriptPath(documentContext.filePath)
      ) {
        return null;
      }

      if (!isMappedFeatureEnabled(documentContext, document, offset, "completion")) {
        return null;
      }

      if (isLargeEjsQuoteTrigger(documentContext, document, params.context)) {
        logServer("info", "completion", "skip", {
          req: requestId,
          case: "large-ejs-quote-trigger",
          file: getRelativePathLabel(documentContext.filePath),
          version: document.version,
          trigger: formatCompletionTrigger(params.context),
          offset,
          reason: "large-ejs-quote-trigger",
        });
        return null;
      }

      if (
        !isTypeScriptCompletionTriggerAllowed(params.context, {
          allowPathLikeTrigger: !helpers.isEjsFilePath(documentContext.filePath),
        })
      ) {
        logServer("info", "completion", "skip", {
          req: requestId,
          case: "unsupported-trigger",
          file: getRelativePathLabel(documentContext.filePath),
          version: document.version,
          trigger: formatCompletionTrigger(params.context),
          offset,
          reason: "ts-trigger",
        });
        return null;
      }

      const startedAt = process.hrtime.bigint();
      const requestedVersion = document.version;
      const relativePath = getRelativePathLabel(documentContext.filePath);
      const trigger = formatCompletionTrigger(params.context);
      const completionStartedAt = process.hrtime.bigint();
      const completionProfile = {};
      if (typeof ensureDocumentPrepared === "function") {
        const prepareStartedAt = process.hrtime.bigint();
        ensureDocumentPrepared(document.uri, {
          requestId,
          operation: "completion",
          preferredOffset: offset,
          skipUnrelatedRegions: true,
          skipStaticRefresh: true,
        });
        completionProfile.prepareMs = elapsedMilliseconds(prepareStartedAt);
      }
      const completionData = documentContext.service.getCompletionData(
        documentContext.filePath,
        documentText,
        offset,
        {
          profile: completionProfile,
          requirePreparedVirtualState: true,
          triggerCharacter: getCompletionTriggerCharacter(params.context),
        }
      );
      const completionElapsedMs = elapsedMilliseconds(completionStartedAt);

      if (shouldAbortDocumentRequest(document.uri, requestedVersion, token)) {
        logServer("warn", "completion", "abort", {
          req: requestId,
          case: "stale-or-cancelled",
          file: relativePath,
          version: requestedVersion,
          trigger,
          offset,
          stage: "ts",
          totalMs: elapsedMilliseconds(startedAt).toFixed(1),
        });
        return null;
      }

      if (!completionData) {
        const totalMs = elapsedMilliseconds(startedAt);
        logServer("perf", "completion", "none", {
          req: requestId,
          case: "ts-none",
          file: relativePath,
          version: requestedVersion,
          trigger,
          offset,
          getCompletionMs: completionElapsedMs.toFixed(1),
          totalMs: totalMs.toFixed(1),
          perf: typeof getPerformanceBucket === "function"
            ? getPerformanceBucket("completion", totalMs)
            : null,
          ...getCompletionProfileFields(completionProfile),
        });
        return null;
      }

      const result = {
        isIncomplete: !!completionData.isIncomplete,
        items: completionData.entries.map((entry) => {
          const insertText = entry.insertText || entry.name;
          const stableEdit = createStableCompletionTextEdit(
            document,
            documentText,
            offset,
            completionData.replacementSpan,
            insertText
          );
          return {
            label: entry.name,
            kind: COMPLETION_KIND_MAP[entry.kind] || context.CompletionItemKind.Text,
            sortText: entry.sortText,
            filterText: insertText,
            insertText,
            insertTextFormat: InsertTextFormat.PlainText,
            detail: entry.kindModifiers ? `${entry.kind} ${entry.kindModifiers}` : entry.kind,
            textEdit: stableEdit ? stableEdit.textEdit : undefined,
            additionalTextEdits: stableEdit ? stableEdit.additionalTextEdits : undefined,
            data: {
              kind: "ts",
              filePath: documentContext.filePath,
              virtualFileName: completionData.virtualFileName,
              virtualOffset: completionData.virtualOffset,
              name: entry.name,
              source: entry.source,
            },
          };
        }),
      };

      const totalMs = elapsedMilliseconds(startedAt);
      logServer("perf", "completion", "ts", {
        req: requestId,
        case: "ts-completion",
        file: relativePath,
        version: requestedVersion,
        trigger,
        offset,
        count: result.items.length,
        getCompletionMs: completionElapsedMs.toFixed(1),
        totalMs: totalMs.toFixed(1),
        perf: typeof getPerformanceBucket === "function"
          ? getPerformanceBucket("completion", totalMs)
          : null,
        ...getCompletionProfileFields(completionData.profile),
      });

      return result;
    },

    resolveCompletionItem(item) {
      if (!item || !item.data || item.data.kind !== "ts") {
        return item;
      }

      const documentContext = getDocumentContextByFilePath(item.data.filePath);
      if (!documentContext) {
        return item;
      }

      const details = documentContext.service.getCompletionDetails(
        item.data.virtualFileName,
        item.data.virtualOffset,
        item.data.name,
        item.data.source
      );
      if (!details) {
        return item;
      }

      const signature = ts.displayPartsToString(details.displayParts || []);
      const documentation = ts.displayPartsToString(details.documentation || []);
      if (signature) {
        item.detail = signature;
      }
      if (signature || documentation) {
        item.documentation = toMarkupContent(signature, documentation);
      }
      return item;
    },

    provideHover(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (!isMappedFeatureEnabled(documentContext, document, offset, "hover")) {
        return null;
      }

      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(document.uri, {
          operation: "hover",
          preferredOffset: offset,
          skipUnrelatedRegions: true,
          skipStaticRefresh: true,
        });
      }
      return documentContext.service.getQuickInfo(
        documentContext.filePath,
        documentText,
        offset,
        { requirePreparedVirtualState: true }
      );
    },

    provideDefinition(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      const requestId =
        params.__pocketpagesRequestId ||
        (typeof createRequestId === "function" ? createRequestId("def") : null);
      if (!isMappedFeatureEnabled(documentContext, document, offset, "definition")) {
        return null;
      }

      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(document.uri, {
          requestId,
          operation: "definition",
          preferredOffset: offset,
          skipUnrelatedRegions: true,
          skipStaticRefresh: true,
        });
      }
      return documentContext.service.getTypeScriptDefinitionTarget(
        documentContext.filePath,
        documentText,
        offset,
        { requirePreparedVirtualState: true }
      );
    },

    provideReferences(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (!isMappedFeatureEnabled(documentContext, document, offset, "references")) {
        return null;
      }

      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(document.uri);
      }
      const referenceResult = documentContext.service.getTypeScriptReferenceTargets(
        documentContext.filePath,
        documentText,
        offset,
        {
          includeDeclaration: !!(params.context && params.context.includeDeclaration),
          requirePreparedVirtualState: true,
        }
      );
      const references = referenceResult ? referenceResult.locations : null;
      if (!references || !references.length) {
        return null;
      }

      return references.map((reference) => {
        const targetUri = URI.file(reference.filePath).toString();
        const targetDocument =
          getDocumentByUri(targetUri) ||
          TextDocument.create(
            targetUri,
            "javascript",
            1,
            context.core.getDocumentTextForFile(reference.filePath)
          );
        return {
          uri: targetUri,
          range: toRange(targetDocument, reference.start, reference.end),
        };
      });
    },

    providePrepareRename(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (!isMappedFeatureEnabled(documentContext, document, offset, "rename")) {
        return null;
      }

      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(document.uri);
      }
      const renameInfo = documentContext.service.getTypeScriptRenameInfo(
        documentContext.filePath,
        documentText,
        offset,
        { requirePreparedVirtualState: true }
      );
      if (!renameInfo) {
        return null;
      }
      if (!renameInfo.canRename) {
        throw new Error(renameInfo.localizedErrorMessage || "Unable to rename this symbol.");
      }

      return {
        range: toRange(document, renameInfo.start, renameInfo.end),
        placeholder: renameInfo.placeholder,
      };
    },

    provideRename(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (!isMappedFeatureEnabled(documentContext, document, offset, "rename")) {
        return null;
      }

      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(document.uri);
      }
      const renameResult = documentContext.service.getTypeScriptRenameEdits(
        documentContext.filePath,
        documentText,
        offset,
        params.newName,
        { requirePreparedVirtualState: true }
      );
      if (!renameResult) {
        return null;
      }
      if (!renameResult.canRename) {
        throw new Error(
          renameResult.localizedErrorMessage || "Unable to rename this symbol."
        );
      }

      return toWorkspaceEdit(renameResult.edits);
    },

    provideSignatureHelp(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(requestContext.document.uri);
      }
      return toSignatureHelp(
        documentContext.service.getSignatureHelp(
          documentContext.filePath,
          documentText,
          offset,
          {
            triggerCharacter: params.context && params.context.triggerCharacter,
            isRetrigger: params.context && params.context.isRetrigger,
            requirePreparedVirtualState: true,
          }
        )
      );
    },

    provideInlayHints(params) {
      const document = getDocumentByUri(params.textDocument.uri);
      if (!document) {
        return null;
      }

      const documentContext = getDocumentContextByUri(params.textDocument.uri);
      if (!documentContext) {
        return null;
      }

      if (typeof ensureDocumentPrepared === "function") {
        ensureDocumentPrepared(document.uri);
      }
      return documentContext.service
        .getInlayHintEntries(documentContext.filePath, document.getText(), {
          start: document.offsetAt(params.range.start),
          end: document.offsetAt(params.range.end),
        })
        .map((entry) => ({
          position: document.positionAt(entry.position),
          label: entry.label,
          paddingLeft: true,
          kind:
            entry.kind === "parameter"
              ? context.InlayHintKind.Parameter
              : context.InlayHintKind.Type,
          tooltip: entry.tooltip || undefined,
        }));
    },
  };
}

module.exports = {
  createTypeScriptFeatureService,
};
