"use strict";

function createCustomFeatureService(context) {
  const { URI, helpers } = context;
  const {
    customCompletionKind,
    getDocumentByUri,
    getDocumentContextByUri,
    toRange,
    toSignatureHelp,
    toWorkspaceEdit,
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

  function isSchemaSupportOnlyDocument(documentContext) {
    return !!(
      documentContext &&
      helpers.isSchemaSupportOnlyHookScriptPath(documentContext.filePath)
    );
  }

  return {
    provideCompletionItems(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      const customCompletionData = documentContext.service.getCustomCompletionData(
        documentContext.filePath,
        documentText,
        offset
      );

      if (!customCompletionData) {
        return null;
      }

      const isSchemaSupportOnlyDocument = helpers.isSchemaSupportOnlyHookScriptPath(
        documentContext.filePath
      );
      const customItems = isSchemaSupportOnlyDocument
        ? customCompletionData.items.filter(
            (entry) =>
              entry.category === "collection-name" || entry.category === "record-field"
          )
        : customCompletionData.items;

      return {
        isIncomplete: false,
        items: customItems.map((entry) => ({
          label: entry.label,
          kind: customCompletionKind(entry.category),
          detail: entry.detail || "",
          documentation: entry.documentation
            ? { kind: context.MarkupKind.Markdown, value: String(entry.documentation) }
            : undefined,
          sortText: entry.sortText,
          insertText: entry.insertText || entry.label,
          insertTextFormat: context.InsertTextFormat.PlainText,
          textEdit: {
            range: toRange(document, customCompletionData.start, customCompletionData.end),
            newText: entry.insertText || entry.label,
          },
          data: {
            kind: "custom",
          },
        })),
      };
    },

    provideHover(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      return (
        documentContext.service.getPathTargetInfo(
          documentContext.filePath,
          documentText,
          offset
        ) || null
      );
    },

    provideDefinition(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      return documentContext.service.getCustomDefinitionTarget(
        documentContext.filePath,
        documentText,
        offset
      );
    },

    provideDocumentLinks(params) {
      const document = getDocumentByUri(params.textDocument.uri);
      if (!document) {
        return null;
      }

      const documentContext = getDocumentContextByUri(params.textDocument.uri);
      if (!documentContext) {
        return null;
      }

      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      return documentContext.service
        .getDocumentLinks(documentContext.filePath, document.getText())
        .map((entry) => ({
          range: toRange(document, entry.start, entry.end),
          target: URI.file(entry.targetFilePath).toString(),
          tooltip:
            entry.kind === "resolve-path"
              ? `Open module target: ${entry.value}`
              : entry.kind === "include-path"
                ? `Open partial target: ${entry.value}`
                : entry.kind === "asset-path"
                  ? `Open asset target: ${entry.value}`
                  : `Open route target: ${entry.value}`,
        }));
    },

    provideSignatureHelp(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      const signatureHelp = documentContext.service.getCustomSignatureHelp(
        documentContext.filePath,
        documentText,
        offset
      );

      return toSignatureHelp(signatureHelp);
    },

    provideReferences(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      return documentContext.service.getCustomReferenceTargets(
        documentContext.filePath,
        documentText,
        offset,
        { includeDeclaration: !!(params.context && params.context.includeDeclaration) }
      );
    },

    providePrepareRename(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      const renameInfo = documentContext.service.getCustomRenameInfo(
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
      if (isSchemaSupportOnlyDocument(documentContext)) {
        return null;
      }

      const renameResult = documentContext.service.getCustomRenameEdits(
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
  };
}

module.exports = {
  createCustomFeatureService,
};
