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

  function isExcludedPocketPagesDocument(documentContext) {
    return !!(
      documentContext &&
      helpers.isExcludedPocketPagesScriptPath(documentContext.filePath)
    );
  }

  function isCustomFeatureBlockedDocument(documentContext) {
    return (
      isSchemaSupportOnlyDocument(documentContext) ||
      isExcludedPocketPagesDocument(documentContext)
    );
  }

  function getRequirePathTargetInfoForSchemaOnly(documentContext, documentText, offset) {
    if (!isSchemaSupportOnlyDocument(documentContext)) {
      return null;
    }

    const pathTargetInfo = documentContext.service.getRequirePathTargetInfo(
      documentContext.filePath,
      documentText,
      offset
    );
    return pathTargetInfo && pathTargetInfo.kind === "require-path"
      ? pathTargetInfo
      : null;
  }

  return {
    provideCompletionItems(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (isExcludedPocketPagesDocument(documentContext)) {
        return null;
      }

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
              entry.category === "collection-name" ||
              entry.category === "record-field" ||
              entry.category === "filter-field" ||
              entry.category === "sort-field"
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
      const schemaOnlyRequireTarget = getRequirePathTargetInfoForSchemaOnly(
        documentContext,
        documentText,
        offset
      );
      if (schemaOnlyRequireTarget) {
        return schemaOnlyRequireTarget;
      }

      if (isCustomFeatureBlockedDocument(documentContext)) {
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
      const schemaOnlyRequireTarget = getRequirePathTargetInfoForSchemaOnly(
        documentContext,
        documentText,
        offset
      );
      if (schemaOnlyRequireTarget) {
        return schemaOnlyRequireTarget.targetFilePath;
      }

      if (isCustomFeatureBlockedDocument(documentContext)) {
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

      const requireOnly = isSchemaSupportOnlyDocument(documentContext);
      if (isExcludedPocketPagesDocument(documentContext)) {
        return null;
      }

      const links = documentContext.service
        .getDocumentLinks(documentContext.filePath, document.getText())
        .filter((entry) => !requireOnly || entry.kind === "require-path");
      if (requireOnly && !links.length) {
        return null;
      }

      return links.map((entry) => ({
        range: toRange(document, entry.start, entry.end),
        target: URI.file(entry.targetFilePath).toString(),
        tooltip:
          entry.kind === "resolve-path"
            ? `Open module target: ${entry.value}`
            : entry.kind === "include-path"
              ? `Open partial target: ${entry.value}`
              : entry.kind === "asset-path"
                ? `Open asset target: ${entry.value}`
                : entry.kind === "require-path"
                  ? `Open require target: ${entry.value}`
                : `Open route target: ${entry.value}`,
      }));
    },

    provideSignatureHelp(params) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (isCustomFeatureBlockedDocument(documentContext)) {
        return null;
      }

      const signatureHelp = documentContext.service.getCustomSignatureHelp(
        documentContext.filePath,
        documentText,
        offset
      );

      return toSignatureHelp(signatureHelp);
    },

    provideReferences(params, options = {}) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      const schemaOnlyRequireTarget = getRequirePathTargetInfoForSchemaOnly(
        documentContext,
        documentText,
        offset
      );
      if (schemaOnlyRequireTarget) {
        return documentContext.service.collectRequireReferenceLocations(
          schemaOnlyRequireTarget.targetFilePath,
          {
            [documentContext.filePath]: documentText,
          },
          options
        );
      }

      if (isCustomFeatureBlockedDocument(documentContext)) {
        return null;
      }

      return documentContext.service.getCustomReferenceTargets(
        documentContext.filePath,
        documentText,
        offset,
        {
          includeDeclaration: !!(params.context && params.context.includeDeclaration),
          shouldCancel: options.shouldCancel,
        }
      );
    },

    providePrepareRename(params, options = {}) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { document, documentContext, documentText, offset } = requestContext;
      if (isCustomFeatureBlockedDocument(documentContext)) {
        return null;
      }

      const renameInfo = documentContext.service.getCustomRenameInfo(
        documentContext.filePath,
        documentText,
        offset,
        options
      );
      if (options && typeof options.shouldCancel === "function" && options.shouldCancel()) {
        return null;
      }
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

    provideRename(params, options = {}) {
      const requestContext = getDocumentRequestContext(params);
      if (!requestContext) {
        return null;
      }

      const { documentContext, documentText, offset } = requestContext;
      if (isCustomFeatureBlockedDocument(documentContext)) {
        return null;
      }

      const renameResult = documentContext.service.getCustomRenameEdits(
        documentContext.filePath,
        documentText,
        offset,
        params.newName,
        options
      );
      if (options && typeof options.shouldCancel === "function" && options.shouldCancel()) {
        return null;
      }
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
