"use strict";

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
    elapsedMilliseconds,
    formatCompletionTrigger,
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

  return {
    provideCompletionItems(params, token) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (
        isExcludedPocketPagesScriptPath(documentContext.filePath) ||
        isSchemaSupportOnlyHookScriptPath(documentContext.filePath)
      ) {
        return null;
      }

      const startedAt = process.hrtime.bigint();
      const requestedVersion = document.version;
      const relativePath = getRelativePathLabel(documentContext.filePath);
      const trigger = formatCompletionTrigger(params.context);
      const completionStartedAt = process.hrtime.bigint();
      const completionData = documentContext.service.getCompletionData(
        documentContext.filePath,
        documentText,
        offset
      );
      const completionElapsedMs = elapsedMilliseconds(completionStartedAt);

      if (shouldAbortDocumentRequest(document.uri, requestedVersion, token)) {
        logServer("warn", "completion", "abort", {
          file: relativePath,
          trigger,
          offset,
          stage: "ts",
          totalMs: elapsedMilliseconds(startedAt).toFixed(1),
        });
        return null;
      }

      if (!completionData) {
        logServer("perf", "completion", "none", {
          file: relativePath,
          trigger,
          offset,
          getCompletionMs: completionElapsedMs.toFixed(1),
          totalMs: elapsedMilliseconds(startedAt).toFixed(1),
        });
        return null;
      }

      const result = {
        isIncomplete: false,
        items: completionData.entries.map((entry) => ({
          label: entry.name,
          kind: COMPLETION_KIND_MAP[entry.kind] || context.CompletionItemKind.Text,
          sortText: entry.sortText,
          filterText: entry.insertText || entry.name,
          insertText: entry.insertText || entry.name,
          insertTextFormat: InsertTextFormat.PlainText,
          detail: entry.kindModifiers ? `${entry.kind} ${entry.kindModifiers}` : entry.kind,
          textEdit: completionData.replacementSpan
            ? {
                range: toRange(
                  document,
                  completionData.replacementSpan.start,
                  completionData.replacementSpan.end
                ),
                newText: entry.insertText || entry.name,
              }
            : undefined,
          data: {
            kind: "ts",
            filePath: documentContext.filePath,
            virtualFileName: completionData.virtualFileName,
            virtualOffset: completionData.virtualOffset,
            name: entry.name,
            source: entry.source,
          },
        })),
      };

      logServer("perf", "completion", "ts", {
        file: relativePath,
        trigger,
        offset,
        count: result.items.length,
        getCompletionMs: completionElapsedMs.toFixed(1),
        totalMs: elapsedMilliseconds(startedAt).toFixed(1),
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

      const { documentContext, documentText, offset } = requestContext;
      return documentContext.service.getQuickInfo(
        documentContext.filePath,
        documentText,
        offset
      );
    },

    provideDefinition(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      return documentContext.service.getTypeScriptDefinitionTarget(
        documentContext.filePath,
        documentText,
        offset
      );
    },

    provideReferences(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      const referenceResult = documentContext.service.getTypeScriptReferenceTargets(
        documentContext.filePath,
        documentText,
        offset,
        { includeDeclaration: !!(params.context && params.context.includeDeclaration) }
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
      const renameInfo = documentContext.service.getTypeScriptRenameInfo(
        documentContext.filePath,
        documentText,
        offset
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

      const { documentContext, documentText, offset } = requestContext;
      const renameResult = documentContext.service.getTypeScriptRenameEdits(
        documentContext.filePath,
        documentText,
        offset,
        params.newName
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
      return toSignatureHelp(
        documentContext.service.getSignatureHelp(
          documentContext.filePath,
          documentText,
          offset,
          {
            triggerCharacter: params.context && params.context.triggerCharacter,
            isRetrigger: params.context && params.context.isRetrigger,
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
