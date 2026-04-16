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
    SymbolKind,
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

  function toDocumentRange(document, start, end) {
    const safeStart = Math.max(0, Number(start) || 0);
    const safeEnd = Math.max(safeStart, Number(end) || safeStart);

    return {
      start: document.positionAt(safeStart),
      end: document.positionAt(safeEnd),
    };
  }

  function toSymbolKind(kind) {
    switch (String(kind || "")) {
      case "file":
        return SymbolKind.File;
      case "module":
        return SymbolKind.Module;
      case "namespace":
        return SymbolKind.Namespace;
      case "string":
        return SymbolKind.String;
      default:
        return SymbolKind.Object;
    }
  }

  function toDocumentSymbol(document, entry) {
    return {
      name: entry.name,
      detail: entry.detail || "",
      kind: toSymbolKind(entry.kind),
      range: toDocumentRange(document, entry.start, entry.end),
      selectionRange: toDocumentRange(document, entry.selectionStart, entry.selectionEnd),
      children: Array.isArray(entry.children)
        ? entry.children.map((child) => toDocumentSymbol(document, child))
        : [],
    };
  }

  function provideDocumentSymbols(params) {
    const document = getDocumentByUri(params.textDocument.uri);
    if (!document) {
      return [];
    }

    const documentContext = getDocumentContextByUri(params.textDocument.uri);
    if (!documentContext || !documentContext.service) {
      return [];
    }

    const entries = documentContext.service.getDocumentSymbolEntries(
      documentContext.filePath,
      document.getText()
    );
    if (!Array.isArray(entries) || !entries.length) {
      return [];
    }

    return entries.map((entry) => toDocumentSymbol(document, entry));
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

  function provideWorkspaceSymbols(params) {
    const query = params && typeof params.query === "string" ? params.query : "";
    const services =
      context.core &&
      context.core.manager &&
      typeof context.core.manager.getAllServices === "function"
        ? context.core.manager.getAllServices()
        : [];
    const symbolEntries = [];
    const seenEntries = new Set();

    for (const service of services) {
      const entries =
        service && typeof service.getWorkspaceSymbolEntries === "function"
          ? service.getWorkspaceSymbolEntries(query)
          : [];
      for (const entry of entries || []) {
        const entryKey = [
          entry.filePath,
          entry.name,
          entry.start,
          entry.end,
          entry.containerName,
        ].join(":");
        if (seenEntries.has(entryKey)) {
          continue;
        }

        seenEntries.add(entryKey);
        const document = getDocumentForFile(entry.filePath);
        symbolEntries.push({
          name: entry.name,
          kind: toSymbolKind(entry.kind),
          location: {
            uri: URI.file(entry.filePath).toString(),
            range: toDocumentRange(document, entry.start, entry.end),
          },
          containerName: entry.containerName || undefined,
        });
      }
    }

    return symbolEntries;
  }

  return {
    provideSemanticTokens,
    provideCodeLens,
    provideDocumentSymbols,
    provideWorkspaceSymbols,
    getDocumentForFile,
  };
}

module.exports = {
  createStructureFeatureService,
};
