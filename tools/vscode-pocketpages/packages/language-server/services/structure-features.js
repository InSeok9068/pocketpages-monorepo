"use strict";

function createStructureFeatureService(context) {
  const {
    URI,
    TextDocument,
    helpers,
    getServerTemplateBoundaryLineNumbers,
    collectEjsSemanticTokenEntries,
    getTokenTypeIndex,
    SemanticTokensBuilder,
  } = context;
  const {
    getDocumentByUri,
    getDocumentContextByUri,
    hasPrivatePagesSegment,
    isEjsFilePath,
  } = helpers;

  function getSemanticTokens(documentText, document) {
    const builder = new SemanticTokensBuilder();
    const entries = collectEjsSemanticTokenEntries(documentText);
    for (const entry of entries) {
      const tokenTypeIndex = getTokenTypeIndex(entry.tokenType);
      if (tokenTypeIndex === null) {
        continue;
      }

      let currentOffset = entry.start;
      const endOffset = entry.start + entry.length;
      while (currentOffset < endOffset) {
        const start = document.positionAt(currentOffset);
        let lineEndOffset = documentText.indexOf("\n", currentOffset);
        if (lineEndOffset === -1 || lineEndOffset > endOffset) {
          lineEndOffset = endOffset;
        }

        builder.push(
          start.line,
          start.character,
          lineEndOffset - currentOffset,
          tokenTypeIndex,
          0
        );
        currentOffset = lineEndOffset + 1;
      }
    }

    return builder.build();
  }

  function provideSemanticTokens(params) {
    const document = getDocumentByUri(params.textDocument.uri);
    if (!document) {
      return { data: [] };
    }

    const filePath = helpers.uriToFilePath(params.textDocument.uri);
    if (!isEjsFilePath(filePath)) {
      return { data: [] };
    }

    return getSemanticTokens(document.getText(), document);
  }

  function provideCodeLens(params) {
    const document = getDocumentByUri(params.textDocument.uri);
    if (!document) {
      return null;
    }

    const documentContext = getDocumentContextByUri(params.textDocument.uri);
    if (!documentContext) {
      return null;
    }

    const boundaryEntries = isEjsFilePath(documentContext.filePath)
      ? getServerTemplateBoundaryLineNumbers(document.getText(), {
          includeTopLevelPartialSetup: hasPrivatePagesSegment(documentContext.filePath),
        }).map((lineIndex) => ({
          title: "Template",
          start: document.offsetAt({ line: lineIndex, character: 0 }),
          command: "pocketpagesServerScript.noopCodeLens",
        }))
      : [];

    const entries = [
      ...boundaryEntries,
      ...(documentContext.service.getCodeLensEntries(
        documentContext.filePath,
        document.getText()
      ) || []),
    ];
    if (!entries.length) {
      return null;
    }

    return entries.map((entry) => {
      const range =
        typeof entry.start === "number"
          ? {
              start: document.positionAt(entry.start),
              end: document.positionAt(entry.start),
            }
          : {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            };

      let command = null;
      if (entry.command) {
        command = {
          title: entry.title,
          command: entry.command,
          arguments: Array.isArray(entry.arguments)
            ? entry.arguments
            : [params.textDocument.uri],
        };
      } else if (entry.targetFilePath) {
        command = {
          title: entry.title,
          command: "pocketpagesServerScript.openCodeLensTarget",
          arguments: [URI.file(entry.targetFilePath).toString()],
        };
      } else {
        command = {
          title: entry.title,
          command: "pocketpagesServerScript.noopCodeLens",
        };
      }

      return {
        range,
        command,
      };
    });
  }

  function getDocumentForFile(targetFilePath) {
    const targetUri = URI.file(targetFilePath).toString();
    return (
      getDocumentByUri(targetUri) ||
      TextDocument.create(
        targetUri,
        "javascript",
        1,
        context.core.getDocumentTextForFile(targetFilePath)
      )
    );
  }

  return {
    provideSemanticTokens,
    provideCodeLens,
    getDocumentForFile,
  };
}

module.exports = {
  createStructureFeatureService,
};
