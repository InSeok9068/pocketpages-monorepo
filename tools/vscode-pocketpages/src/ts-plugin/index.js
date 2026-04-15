"use strict";

const fs = require("fs");
const path = require("path");
const { URI } = require("vscode-uri");
const { PocketPagesLanguageCore } = requireExtensionModule([
  "../core/language-core",
  "../../../src/core/language-core",
]);
const {
  buildScriptServerMirrorText,
  collectExternalPocketPagesEjsFiles,
  getIdentifierTextSpan,
  isPocketPagesEjsFile,
  offsetAt,
  readSnapshotText,
} = require("./shared");

function requireExtensionModule(candidatePaths) {
  for (const candidatePath of candidatePaths) {
    try {
      return require(candidatePath);
    } catch (error) {
      if (error && error.code === "MODULE_NOT_FOUND") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Unable to resolve PocketPages extension module from ${__dirname}`);
}

function toDisplayParts(text) {
  return text ? [{ text: String(text), kind: "text" }] : [];
}

function getDefinitionTargetName(filePath) {
  return path.basename(String(filePath || ""));
}

function createCompletionInfo(filePath, completionData) {
  return {
    flags: 0,
    isGlobalCompletion: false,
    isMemberCompletion: true,
    isNewIdentifierLocation: false,
    optionalReplacementSpan: completionData.replacementSpan
      ? {
          start: completionData.replacementSpan.start,
          length: completionData.replacementSpan.end - completionData.replacementSpan.start,
        }
      : undefined,
    entries: (completionData.entries || []).map((entry) => ({
      ...entry,
      data: {
        __pocketpages: {
          kind: "ejs-server-completion",
          filePath,
          virtualFileName: completionData.virtualFileName,
          virtualOffset: completionData.virtualOffset,
          name: entry.name,
          source: entry.source,
        },
      },
    })),
  };
}

function init(modules) {
  const ts = modules.typescript;

  return {
    create(info) {
      const host = info.languageServiceHost;
      const baseLanguageService = info.languageService;
      const baseGetScriptSnapshot =
        typeof host.getScriptSnapshot === "function" ? host.getScriptSnapshot.bind(host) : null;
      const baseGetScriptKind =
        typeof host.getScriptKind === "function" ? host.getScriptKind.bind(host) : null;
      const baseGetScriptVersion =
        typeof host.getScriptVersion === "function" ? host.getScriptVersion.bind(host) : null;
      const core = new PocketPagesLanguageCore();

      function readOriginalDocumentText(fileName) {
        const snapshot = baseGetScriptSnapshot ? baseGetScriptSnapshot(fileName) : null;
        const snapshotText = readSnapshotText(snapshot);
        if (snapshotText) {
          return snapshotText;
        }

        return fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf8") : "";
      }

      function ensureDocumentContext(fileName) {
        if (!isPocketPagesEjsFile(fileName)) {
          return null;
        }

        const documentText = readOriginalDocumentText(fileName);
        if (!documentText) {
          return null;
        }

        core.updateDocument({
          uri: URI.file(fileName).toString(),
          languageId: "ejs",
          version: baseGetScriptVersion ? String(baseGetScriptVersion(fileName) || "0") : "0",
          text: documentText,
        });

        const documentContext = core.getDocumentContextByFilePath(fileName);
        if (!documentContext) {
          return null;
        }

        return {
          ...documentContext,
          documentText,
        };
      }

      function isTsOwnedPosition(documentContext, position, capabilityName) {
        if (!documentContext) {
          return false;
        }

        return core.isFeatureEnabledAtOffset(
          documentContext.uri,
          position,
          capabilityName
        );
      }

      function isCustomPocketPagesPosition(documentContext, position) {
        if (!documentContext) {
          return false;
        }

        return !!(
          documentContext.service.getPathTargetInfo(
            documentContext.filePath,
            documentContext.documentText,
            position
          ) ||
          documentContext.service.getCustomCompletionData(
            documentContext.filePath,
            documentContext.documentText,
            position
          ) ||
          documentContext.service.getCustomDefinitionTarget(
            documentContext.filePath,
            documentContext.documentText,
            position
          )
        );
      }

      function toDefinitionInfo(target) {
        if (!target || !target.filePath) {
          return [];
        }

        const targetText = core.getDocumentTextForFile(target.filePath);
        const start = offsetAt(targetText, target.line, target.character);
        return [
          {
            fileName: target.filePath,
            textSpan: {
              start,
              length: 0,
            },
            kind: ts.ScriptElementKind.unknown,
            name: getDefinitionTargetName(target.filePath),
            containerKind: "",
            containerName: "",
          },
        ];
      }

      host.getScriptKind = (fileName) => {
        if (isPocketPagesEjsFile(fileName)) {
          return ts.ScriptKind.JS;
        }

        return baseGetScriptKind ? baseGetScriptKind(fileName) : ts.ScriptKind.Unknown;
      };

      host.getScriptSnapshot = (fileName) => {
        if (!isPocketPagesEjsFile(fileName)) {
          return baseGetScriptSnapshot ? baseGetScriptSnapshot(fileName) : undefined;
        }

        const documentText = readOriginalDocumentText(fileName);
        if (!documentText) {
          return baseGetScriptSnapshot ? baseGetScriptSnapshot(fileName) : undefined;
        }

        return ts.ScriptSnapshot.fromString(buildScriptServerMirrorText(documentText));
      };

      const proxy = Object.create(null);
      for (const key of Object.keys(baseLanguageService)) {
        const value = baseLanguageService[key];
        proxy[key] = typeof value === "function" ? value.bind(baseLanguageService) : value;
      }

      proxy.getCompletionsAtPosition = (fileName, position, options) => {
        const documentContext = ensureDocumentContext(fileName);
        if (
          !documentContext ||
          isCustomPocketPagesPosition(documentContext, position) ||
          !isTsOwnedPosition(documentContext, position, "completion")
        ) {
          return baseLanguageService.getCompletionsAtPosition(fileName, position, options);
        }

        const completionData = documentContext.service.getCompletionData(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        if (!completionData) {
          return baseLanguageService.getCompletionsAtPosition(fileName, position, options);
        }

        return createCompletionInfo(fileName, completionData);
      };

      proxy.getCompletionEntryDetails = (
        fileName,
        position,
        entryName,
        formatOptions,
        source,
        preferences,
        data
      ) => {
        const pluginData = data && data.__pocketpages;
        if (!pluginData || pluginData.kind !== "ejs-server-completion") {
          return baseLanguageService.getCompletionEntryDetails(
            fileName,
            position,
            entryName,
            formatOptions,
            source,
            preferences,
            data
          );
        }

        const documentContext = ensureDocumentContext(pluginData.filePath);
        if (!documentContext) {
          return baseLanguageService.getCompletionEntryDetails(
            fileName,
            position,
            entryName,
            formatOptions,
            source,
            preferences,
            data
          );
        }

        const details = documentContext.service.getCompletionDetails(
          pluginData.virtualFileName,
          pluginData.virtualOffset,
          pluginData.name,
          pluginData.source
        );
        if (!details) {
          return baseLanguageService.getCompletionEntryDetails(
            fileName,
            position,
            entryName,
            formatOptions,
            source,
            preferences,
            data
          );
        }

        return details;
      };

      proxy.getQuickInfoAtPosition = (fileName, position) => {
        const documentContext = ensureDocumentContext(fileName);
        if (
          !documentContext ||
          isCustomPocketPagesPosition(documentContext, position) ||
          !isTsOwnedPosition(documentContext, position, "hover")
        ) {
          return baseLanguageService.getQuickInfoAtPosition(fileName, position);
        }

        const quickInfo = documentContext.service.getQuickInfo(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        if (!quickInfo || quickInfo.start === null || quickInfo.end === null) {
          return baseLanguageService.getQuickInfoAtPosition(fileName, position);
        }

        return {
          kind: ts.ScriptElementKind.unknown,
          kindModifiers: "",
          textSpan: {
            start: quickInfo.start,
            length: Math.max(0, quickInfo.end - quickInfo.start),
          },
          displayParts: toDisplayParts(quickInfo.displayText),
          documentation: toDisplayParts(quickInfo.documentation),
        };
      };

      proxy.getDefinitionAtPosition = (fileName, position) => {
        const documentContext = ensureDocumentContext(fileName);
        if (
          !documentContext ||
          isCustomPocketPagesPosition(documentContext, position) ||
          !isTsOwnedPosition(documentContext, position, "definition")
        ) {
          return baseLanguageService.getDefinitionAtPosition(fileName, position);
        }

        const target = documentContext.service.getTypeScriptDefinitionTarget(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        if (!target) {
          return baseLanguageService.getDefinitionAtPosition(fileName, position);
        }

        return toDefinitionInfo(target);
      };

      proxy.getDefinitionAndBoundSpan = (fileName, position) => {
        const documentContext = ensureDocumentContext(fileName);
        if (
          !documentContext ||
          isCustomPocketPagesPosition(documentContext, position) ||
          !isTsOwnedPosition(documentContext, position, "definition")
        ) {
          return baseLanguageService.getDefinitionAndBoundSpan(fileName, position);
        }

        const target = documentContext.service.getTypeScriptDefinitionTarget(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        if (!target) {
          return baseLanguageService.getDefinitionAndBoundSpan(fileName, position);
        }

        const quickInfo = documentContext.service.getQuickInfo(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        const textSpan =
          quickInfo && quickInfo.start !== null && quickInfo.end !== null
            ? {
                start: quickInfo.start,
                length: Math.max(0, quickInfo.end - quickInfo.start),
              }
            : getIdentifierTextSpan(documentContext.documentText, position);

        return {
          textSpan,
          definitions: toDefinitionInfo(target),
        };
      };

      return proxy;
    },

    getExternalFiles(project) {
      return collectExternalPocketPagesEjsFiles(ts, project);
    },
  };
}

module.exports = init;
