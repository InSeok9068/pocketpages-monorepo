"use strict";

const fs = require("fs");
const path = require("path");
const { URI } = require("vscode-uri");
const { PocketPagesLanguageCore } = requireExtensionModule([
  "../language-core/language-core",
  "../../../packages/language-core/language-core",
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
  const MAX_MANAGED_EJS_DOCUMENTS = 40;

  return {
    create(info) {
      const host = info.languageServiceHost;
      const project = info.project;
      const baseLanguageService = info.languageService;
      const baseGetScriptSnapshot =
        typeof host.getScriptSnapshot === "function" ? host.getScriptSnapshot.bind(host) : null;
      const baseGetScriptKind =
        typeof host.getScriptKind === "function" ? host.getScriptKind.bind(host) : null;
      const baseGetScriptVersion =
        typeof host.getScriptVersion === "function" ? host.getScriptVersion.bind(host) : null;
      const baseGetProjectVersion =
        typeof host.getProjectVersion === "function" ? host.getProjectVersion.bind(host) : null;
      const core = new PocketPagesLanguageCore();
      const trackedAppState = new Map();
      const managedDocumentLru = new Map();
      let projectChangeGeneration = 0;
      let lastObservedProjectVersionToken = null;

      function normalizeTrackedPath(fileName) {
        const normalizedFileName = path.resolve(String(fileName || "")).replace(/\\/g, "/");
        return normalizedFileName.replace(/^[A-Z]:/, (value) => value.toLowerCase());
      }

      function getAppRootForPocketPagesFile(fileName) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        const pagesMarker = "/pb_hooks/pages/";
        const markerIndex = normalizedFileName.indexOf(pagesMarker);
        if (markerIndex === -1) {
          return null;
        }

        return normalizedFileName.slice(0, markerIndex);
      }

      function readProjectVersionToken() {
        if (baseGetProjectVersion) {
          const projectVersion = baseGetProjectVersion();
          if (projectVersion !== undefined && projectVersion !== null) {
            return `host:${String(projectVersion)}`;
          }
        }

        if (project && typeof project.getProjectVersion === "function") {
          const projectVersion = project.getProjectVersion();
          if (projectVersion !== undefined && projectVersion !== null) {
            return `project:${String(projectVersion)}`;
          }
        }

        return null;
      }

      function markProjectVersionObserved() {
        const nextProjectVersionToken = readProjectVersionToken();
        if (nextProjectVersionToken === null) {
          projectChangeGeneration += 1;
          return;
        }

        if (lastObservedProjectVersionToken !== nextProjectVersionToken) {
          lastObservedProjectVersionToken = nextProjectVersionToken;
          projectChangeGeneration += 1;
        }
      }

      function collectTrackedAppFiles(appRoot) {
        const trackedFiles = new Set();
        const normalizedAppRoot = normalizeTrackedPath(appRoot);
        const pagesRoot = path.join(normalizedAppRoot, "pb_hooks", "pages");
        const pendingDirectories = [pagesRoot];

        while (pendingDirectories.length) {
          const currentDir = pendingDirectories.pop();
          if (!fs.existsSync(currentDir)) {
            continue;
          }

          let entries = [];
          try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
          } catch (_error) {
            entries = [];
          }

          for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
              pendingDirectories.push(absolutePath);
              continue;
            }

            if (!entry.isFile()) {
              continue;
            }

            trackedFiles.add(normalizeTrackedPath(absolutePath));
          }
        }

        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "pb_schema.json")));
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "pb_data", "types.d.ts")));
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "pocketpages-globals.d.ts")));
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "types.d.ts")));

        return trackedFiles;
      }

      function readTrackedFileVersionToken(fileName) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        const hostFileName = path.resolve(String(fileName || ""));
        const scriptVersion = baseGetScriptVersion ? baseGetScriptVersion(hostFileName) : undefined;
        if (scriptVersion !== undefined && scriptVersion !== null && scriptVersion !== "") {
          return `script:${String(scriptVersion)}`;
        }

        try {
          const stats = fs.statSync(normalizedFileName);
          return `fs:${stats.mtimeMs}:${stats.size}`;
        } catch (_error) {
          return "missing";
        }
      }

      function closeManagedDocument(uri) {
        managedDocumentLru.delete(uri);
        core.closeDocument(uri);
      }

      function evictLeastRecentlyUsedDocument(currentUri) {
        while (managedDocumentLru.size > MAX_MANAGED_EJS_DOCUMENTS) {
          let oldestEvictableUri = null;
          for (const candidateUri of managedDocumentLru.keys()) {
            if (candidateUri !== currentUri) {
              oldestEvictableUri = candidateUri;
              break;
            }
          }

          if (!oldestEvictableUri) {
            return;
          }

          closeManagedDocument(oldestEvictableUri);
        }
      }

      function markManagedDocumentUsed(uri) {
        managedDocumentLru.delete(uri);
        managedDocumentLru.set(uri, true);
        evictLeastRecentlyUsedDocument(uri);
      }

      function reconcileTrackedAppState(fileName) {
        if (!isPocketPagesEjsFile(fileName)) {
          return;
        }

        const activeFilePath = normalizeTrackedPath(fileName);
        const appRoot = getAppRootForPocketPagesFile(activeFilePath);
        if (!appRoot) {
          return;
        }

        markProjectVersionObserved();

        const previousState = trackedAppState.get(appRoot);
        if (
          previousState &&
          previousState.projectChangeGeneration === projectChangeGeneration
        ) {
          return;
        }

        const nextTrackedFiles = collectTrackedAppFiles(appRoot);
        nextTrackedFiles.add(activeFilePath);
        const nextTrackedVersions = new Map();
        for (const trackedFilePath of nextTrackedFiles) {
          nextTrackedVersions.set(
            trackedFilePath,
            readTrackedFileVersionToken(trackedFilePath)
          );
        }

        const changedFiles = new Set();
        if (previousState) {
          for (const [trackedFilePath, trackedVersion] of previousState.fileVersions.entries()) {
            if (nextTrackedVersions.get(trackedFilePath) !== trackedVersion) {
              changedFiles.add(trackedFilePath);
            }
          }

          for (const trackedFilePath of nextTrackedVersions.keys()) {
            if (!previousState.fileVersions.has(trackedFilePath)) {
              changedFiles.add(trackedFilePath);
            }
          }
        }

        for (const virtualCode of core.getManagedVirtualCodes()) {
          if (getAppRootForPocketPagesFile(virtualCode.filePath) !== appRoot) {
            continue;
          }

          if (!nextTrackedVersions.has(normalizeTrackedPath(virtualCode.filePath))) {
            closeManagedDocument(virtualCode.uri);
          }
        }

        if ([...changedFiles].some((trackedFilePath) => trackedFilePath !== activeFilePath)) {
          core.reloadCachesForAppRoot(appRoot);
        }

        trackedAppState.set(appRoot, {
          projectChangeGeneration,
          fileVersions: nextTrackedVersions,
        });
      }

      function readOriginalDocumentText(fileName) {
        const snapshot = baseGetScriptSnapshot ? baseGetScriptSnapshot(fileName) : null;
        const snapshotText = readSnapshotText(snapshot);
        if (snapshot) {
          return snapshotText;
        }

        return fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf8") : "";
      }

      function ensureDocumentContext(fileName) {
        if (!isPocketPagesEjsFile(fileName)) {
          return null;
        }

        reconcileTrackedAppState(fileName);

        const documentText = readOriginalDocumentText(fileName);
        if (!documentText) {
          return null;
        }

        const documentUri = URI.file(fileName).toString();
        core.updateDocument({
          uri: documentUri,
          languageId: "ejs",
          version: baseGetScriptVersion ? String(baseGetScriptVersion(fileName) || "0") : "0",
          text: documentText,
        });
        markManagedDocumentUsed(documentUri);

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
