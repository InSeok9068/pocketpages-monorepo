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

function hashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createTextIdentity(text) {
  const value = String(text || "");
  return `${value.length}:${hashText(value)}`;
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
  const TRACKED_APP_FILE_SCAN_INTERVAL_MS = 2000;
  const MAX_TRACKED_APP_FILES_PER_SCAN = 5000;
  const MAX_TRACKED_APP_DIRECTORY_ENTRIES_PER_SCAN = 20000;
  const TRACKED_PAGES_FILE_EXTENSIONS = new Set([".ejs", ".js", ".cjs", ".mjs", ".json"]);

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
      const baseGetScriptFileNames =
        typeof host.getScriptFileNames === "function" ? host.getScriptFileNames.bind(host) : null;
      const core = new PocketPagesLanguageCore({
        managerOptions: {
          idleServiceTtlMs: Infinity,
        },
      });
      const trackedAppState = new Map();
      const watchedAppRoots = new Map();
      const managedDocumentLru = new Map();
      const documentContextCache = new Map();
      let projectChangeGeneration = 0;
      let appWatchChangeGeneration = 0;
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

      function isTrackedPagesFile(fileName) {
        const normalizedFileName = normalizeTrackedPath(fileName).toLowerCase();
        if (normalizedFileName.endsWith(".d.ts")) {
          return true;
        }

        return TRACKED_PAGES_FILE_EXTENSIONS.has(path.extname(normalizedFileName));
      }

      function isPocketPagesSourceFile(fileName) {
        const appRoot = getAppRootForPocketPagesFile(fileName);
        if (!appRoot) {
          return false;
        }

        const normalizedFileName = normalizeTrackedPath(fileName);
        return (
          isUnderPagesRoot(normalizedFileName, appRoot) &&
          !isPagesAssetFile(normalizedFileName, appRoot) &&
          !isRouteExposedVendorOrMinifiedScript(normalizedFileName, appRoot) &&
          isTrackedPagesFile(normalizedFileName)
        );
      }

      function getPagesRoot(appRoot) {
        return normalizeTrackedPath(path.join(normalizeTrackedPath(appRoot), "pb_hooks", "pages"));
      }

      function isUnderPagesRoot(fileName, appRoot) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        return normalizedFileName.startsWith(`${getPagesRoot(appRoot)}/`);
      }

      function isPagesAssetFile(fileName, appRoot) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        const pagesRoot = getPagesRoot(appRoot);
        if (!normalizedFileName.startsWith(`${pagesRoot}/`)) {
          return false;
        }

        return normalizedFileName
          .slice(pagesRoot.length + 1)
          .split("/")
          .includes("assets");
      }

      function isRouteExposedVendorOrMinifiedScript(fileName, appRoot) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        const lowerFileName = normalizedFileName.toLowerCase();
        const pagesRoot = getPagesRoot(appRoot);
        if (!normalizedFileName.startsWith(`${pagesRoot}/`)) {
          return false;
        }

        const relativeSegments = normalizedFileName
          .slice(pagesRoot.length + 1)
          .split("/")
          .filter(Boolean);
        if (relativeSegments.includes("_private")) {
          return false;
        }

        return (
          relativeSegments.includes("vendor") ||
          lowerFileName.endsWith(".min.js") ||
          lowerFileName.endsWith(".min.cjs") ||
          lowerFileName.endsWith(".min.mjs")
        );
      }

      function isSameOrChildPath(parentPath, fileName) {
        const normalizedParent = normalizeTrackedPath(parentPath);
        const normalizedFileName = normalizeTrackedPath(fileName);
        return normalizedFileName === normalizedParent || normalizedFileName.startsWith(`${normalizedParent}/`);
      }

      function addAlwaysTrackedAppFiles(trackedFiles, appRoot) {
        const normalizedAppRoot = normalizeTrackedPath(appRoot);
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "pb_schema.json")));
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "pb_data", "types.d.ts")));
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "pocketpages-globals.d.ts")));
        trackedFiles.add(normalizeTrackedPath(path.join(normalizedAppRoot, "types.d.ts")));
      }

      function isAlwaysTrackedAppFile(fileName, appRoot) {
        const alwaysTrackedFiles = new Set();
        addAlwaysTrackedAppFiles(alwaysTrackedFiles, appRoot);
        return alwaysTrackedFiles.has(normalizeTrackedPath(fileName));
      }

      function addTrackedPagesFile(trackedFiles, appRoot, fileName) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        if (
          !isUnderPagesRoot(normalizedFileName, appRoot) ||
          isPagesAssetFile(normalizedFileName, appRoot) ||
          isRouteExposedVendorOrMinifiedScript(normalizedFileName, appRoot) ||
          !isTrackedPagesFile(normalizedFileName)
        ) {
          return false;
        }

        trackedFiles.add(normalizedFileName);
        return true;
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

      function readScriptVersionToken(fileName) {
        if (!baseGetScriptVersion) {
          return null;
        }

        const scriptVersion = baseGetScriptVersion(fileName);
        if (scriptVersion === undefined || scriptVersion === null || scriptVersion === "") {
          return null;
        }

        return String(scriptVersion);
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

      function clearDocumentContextCacheForAppRoot(appRoot) {
        const normalizedAppRoot = normalizeTrackedPath(appRoot);
        for (const [documentUri, cachedContext] of documentContextCache.entries()) {
          const filePath = cachedContext && cachedContext.context
            ? cachedContext.context.filePath
            : null;
          if (filePath && isSameOrChildPath(normalizedAppRoot, filePath)) {
            documentContextCache.delete(documentUri);
          }
        }
      }

      function markAppRootWatchedFileDirty(appRoot) {
        const normalizedAppRoot = normalizeTrackedPath(appRoot);
        const watchState = watchedAppRoots.get(normalizedAppRoot) || {
          generation: 0,
          initialized: false,
          watchers: [],
        };
        appWatchChangeGeneration += 1;
        watchState.generation = appWatchChangeGeneration;
        watchedAppRoots.set(normalizedAppRoot, watchState);
        clearDocumentContextCacheForAppRoot(normalizedAppRoot);
      }

      function getWatchHost() {
        const projectServiceHost =
          project &&
          project.projectService &&
          project.projectService.host;
        return projectServiceHost && typeof projectServiceHost.watchDirectory === "function"
          ? projectServiceHost
          : null;
      }

      function isWatchedAppFile(fileName, appRoot) {
        const normalizedFileName = normalizeTrackedPath(fileName);
        const normalizedAppRoot = normalizeTrackedPath(appRoot);
        if (isUnderPagesRoot(normalizedFileName, normalizedAppRoot)) {
          return (
            !isPagesAssetFile(normalizedFileName, normalizedAppRoot) &&
            !isRouteExposedVendorOrMinifiedScript(normalizedFileName, normalizedAppRoot) &&
            isTrackedPagesFile(normalizedFileName)
          );
        }

        return isAlwaysTrackedAppFile(normalizedFileName, normalizedAppRoot);
      }

      function addAppDirectoryWatcher(watchState, watchHost, appRoot, directory, recursive) {
        try {
          const watcher = watchHost.watchDirectory(
            directory,
            (fileName) => {
              if (isWatchedAppFile(fileName, appRoot)) {
                markAppRootWatchedFileDirty(appRoot);
              }
            },
            recursive
          );
          if (watcher && typeof watcher.close === "function") {
            watchState.watchers.push(watcher);
          }
        } catch (_error) {
          // Watchers are only dirty hints. The stat/scan fallback remains the source of truth.
        }
      }

      function ensureAppWatchers(appRoot) {
        const normalizedAppRoot = normalizeTrackedPath(appRoot);
        let watchState = watchedAppRoots.get(normalizedAppRoot);
        if (watchState && watchState.initialized) {
          return watchState;
        }

        if (!watchState) {
          watchState = {
            generation: 0,
            initialized: false,
            watchers: [],
          };
          watchedAppRoots.set(normalizedAppRoot, watchState);
        }

        watchState.initialized = true;
        const watchHost = getWatchHost();
        if (!watchHost) {
          return watchState;
        }

        addAppDirectoryWatcher(watchState, watchHost, normalizedAppRoot, getPagesRoot(normalizedAppRoot), true);
        addAppDirectoryWatcher(watchState, watchHost, normalizedAppRoot, normalizedAppRoot, false);
        addAppDirectoryWatcher(
          watchState,
          watchHost,
          normalizedAppRoot,
          normalizeTrackedPath(path.join(normalizedAppRoot, "pb_data")),
          false
        );
        return watchState;
      }

      function getAppWatchGeneration(appRoot) {
        const watchState = ensureAppWatchers(appRoot);
        return watchState ? watchState.generation || 0 : 0;
      }

      function disposeAppWatchers() {
        for (const watchState of watchedAppRoots.values()) {
          for (const watcher of watchState.watchers || []) {
            if (watcher && typeof watcher.close === "function") {
              watcher.close();
            }
          }
        }
        watchedAppRoots.clear();
      }

      function collectProjectTrackedAppFiles(appRoot) {
        const trackedFiles = new Set();
        if (!baseGetScriptFileNames) {
          return trackedFiles;
        }

        let scriptFileNames = [];
        try {
          scriptFileNames = baseGetScriptFileNames() || [];
        } catch (_error) {
          scriptFileNames = [];
        }

        if (!Array.isArray(scriptFileNames)) {
          return trackedFiles;
        }

        for (const scriptFileName of scriptFileNames) {
          addTrackedPagesFile(trackedFiles, appRoot, scriptFileName);
        }

        return trackedFiles;
      }

      function collectTrackedAppFilesFromDisk(appRoot) {
        const trackedFiles = new Set();
        const pagesRoot = getPagesRoot(appRoot);
        const pendingDirectories = [pagesRoot];
        let visitedEntries = 0;
        let complete = true;

        while (pendingDirectories.length) {
          if (
            trackedFiles.size >= MAX_TRACKED_APP_FILES_PER_SCAN ||
            visitedEntries >= MAX_TRACKED_APP_DIRECTORY_ENTRIES_PER_SCAN
          ) {
            complete = false;
            break;
          }

          const currentDir = pendingDirectories.pop();
          let entries = [];
          try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
          } catch (_error) {
            entries = [];
          }

          for (const entry of entries) {
            visitedEntries += 1;
            if (visitedEntries > MAX_TRACKED_APP_DIRECTORY_ENTRIES_PER_SCAN) {
              complete = false;
              break;
            }

            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
              pendingDirectories.push(absolutePath);
              continue;
            }

            if (!entry.isFile()) {
              continue;
            }

            addTrackedPagesFile(trackedFiles, appRoot, absolutePath);
            if (trackedFiles.size >= MAX_TRACKED_APP_FILES_PER_SCAN) {
              complete = false;
              break;
            }
          }
        }

        return {
          complete,
          trackedFiles,
        };
      }

      function shouldRefreshTrackedAppFileList(previousState, now) {
        if (!previousState || !previousState.trackedFiles) {
          return true;
        }

        const lastScanTime = previousState.trackedFileScanTime || 0;
        return now - lastScanTime >= TRACKED_APP_FILE_SCAN_INTERVAL_MS;
      }

      function collectTrackedAppFiles(appRoot, activeFilePath, previousState, options = {}) {
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const projectTrackedFiles = collectProjectTrackedAppFiles(appRoot);
        const shouldRefreshFileList =
          options.forceRefreshFileList === true ||
          shouldRefreshTrackedAppFileList(previousState, now);
        let trackedFiles = previousState && previousState.trackedFiles
          ? new Set(previousState.trackedFiles)
          : new Set();
        let trackedFileScanTime = previousState ? previousState.trackedFileScanTime || 0 : 0;
        let trackedFileScanComplete = previousState ? previousState.trackedFileScanComplete !== false : true;

        if (shouldRefreshFileList) {
          const diskTrackedFiles = collectTrackedAppFilesFromDisk(appRoot);
          trackedFiles =
            diskTrackedFiles.complete || !previousState || !previousState.trackedFiles
              ? new Set()
              : new Set(previousState.trackedFiles);

          for (const trackedFilePath of diskTrackedFiles.trackedFiles) {
            trackedFiles.add(trackedFilePath);
          }

          trackedFileScanTime = now;
          trackedFileScanComplete = diskTrackedFiles.complete;
        }

        for (const trackedFilePath of projectTrackedFiles) {
          trackedFiles.add(trackedFilePath);
        }

        trackedFiles.add(activeFilePath);
        addAlwaysTrackedAppFiles(trackedFiles, appRoot);

        return {
          trackedFiles,
          trackedFileScanTime,
          trackedFileScanComplete,
        };
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
        documentContextCache.delete(uri);
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
        if (!isPocketPagesSourceFile(fileName)) {
          return;
        }

        const activeFilePath = normalizeTrackedPath(fileName);
        const appRoot = getAppRootForPocketPagesFile(activeFilePath);
        if (!appRoot) {
          return;
        }

        markProjectVersionObserved();

        const now = Date.now();
        const appWatchGeneration = getAppWatchGeneration(appRoot);
        const previousState = trackedAppState.get(appRoot);
        const shouldRefreshFileList = shouldRefreshTrackedAppFileList(previousState, now);
        if (
          previousState &&
          previousState.projectChangeGeneration === projectChangeGeneration &&
          previousState.watchGeneration === appWatchGeneration &&
          !shouldRefreshFileList
        ) {
          return;
        }

        const trackedFilesState = collectTrackedAppFiles(appRoot, activeFilePath, previousState, {
          now,
          forceRefreshFileList: !!previousState && previousState.watchGeneration !== appWatchGeneration,
        });
        const nextTrackedFiles = trackedFilesState.trackedFiles;
        const nextTrackedVersions = new Map();
        const missingTrackedFiles = new Set();
        const alwaysTrackedFiles = new Set();
        addAlwaysTrackedAppFiles(alwaysTrackedFiles, appRoot);
        for (const trackedFilePath of nextTrackedFiles) {
          const trackedVersionToken = readTrackedFileVersionToken(trackedFilePath);
          nextTrackedVersions.set(trackedFilePath, trackedVersionToken);

          if (
            trackedVersionToken === "missing" &&
            trackedFilePath !== activeFilePath &&
            !alwaysTrackedFiles.has(trackedFilePath)
          ) {
            missingTrackedFiles.add(trackedFilePath);
          }
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

          const virtualFilePath = normalizeTrackedPath(virtualCode.filePath);
          if (!nextTrackedVersions.has(virtualFilePath) || missingTrackedFiles.has(virtualFilePath)) {
            closeManagedDocument(virtualCode.uri);
          }
        }

        if ([...changedFiles].some((trackedFilePath) => trackedFilePath !== activeFilePath)) {
          clearDocumentContextCacheForAppRoot(appRoot);
          core.reloadCachesForAppRoot(appRoot);
        }

        trackedAppState.set(appRoot, {
          projectChangeGeneration,
          watchGeneration: appWatchGeneration,
          fileVersions: nextTrackedVersions,
          trackedFiles: nextTrackedFiles,
          trackedFileScanTime: trackedFilesState.trackedFileScanTime,
          trackedFileScanComplete: trackedFilesState.trackedFileScanComplete,
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

      function cacheDocumentContext(documentUri, scriptVersionToken, textIdentity, documentContext) {
        const appRoot = documentContext && documentContext.filePath
          ? getAppRootForPocketPagesFile(documentContext.filePath)
          : null;
        const cachedContext = {
          scriptVersionToken,
          textIdentity,
          projectChangeGeneration,
          watchGeneration: appRoot ? getAppWatchGeneration(appRoot) : 0,
          context: documentContext,
        };
        documentContextCache.set(documentUri, cachedContext);
        return cachedContext.context;
      }

      function ensureEjsDocumentContext(fileName) {
        if (!isPocketPagesEjsFile(fileName)) {
          return null;
        }

        reconcileTrackedAppState(fileName);

        const documentUri = URI.file(fileName).toString();
        const scriptVersionToken = readScriptVersionToken(fileName);
        const cachedContext = documentContextCache.get(documentUri);
        const appRoot = getAppRootForPocketPagesFile(fileName);
        const appWatchGeneration = appRoot ? getAppWatchGeneration(appRoot) : 0;
        if (
          cachedContext &&
          scriptVersionToken !== null &&
          cachedContext.scriptVersionToken === scriptVersionToken &&
          cachedContext.projectChangeGeneration === projectChangeGeneration &&
          cachedContext.watchGeneration === appWatchGeneration
        ) {
          markManagedDocumentUsed(documentUri);
          return cachedContext.context;
        }

        const documentText = readOriginalDocumentText(fileName);
        if (!documentText) {
          documentContextCache.delete(documentUri);
          return null;
        }

        const textIdentity = scriptVersionToken === null ? createTextIdentity(documentText) : null;
        if (
          cachedContext &&
          scriptVersionToken === null &&
          cachedContext.textIdentity === textIdentity &&
          cachedContext.projectChangeGeneration === projectChangeGeneration &&
          cachedContext.watchGeneration === appWatchGeneration
        ) {
          markManagedDocumentUsed(documentUri);
          return cachedContext.context;
        }

        core.updateDocument({
          uri: documentUri,
          languageId: "ejs",
          version: scriptVersionToken || "0",
          text: documentText,
        });
        markManagedDocumentUsed(documentUri);

        const documentContext = core.getDocumentContextByFilePath(fileName);
        if (!documentContext) {
          documentContextCache.delete(documentUri);
          return null;
        }

        return cacheDocumentContext(documentUri, scriptVersionToken, textIdentity, {
          ...documentContext,
          documentText,
        });
      }

      function ensureScriptDocumentContext(fileName) {
        if (!isPocketPagesSourceFile(fileName) || isPocketPagesEjsFile(fileName)) {
          return null;
        }

        reconcileTrackedAppState(fileName);

        const documentText = readOriginalDocumentText(fileName);
        if (!documentText) {
          return null;
        }

        const documentContext = core.getDocumentContextByFilePath(fileName);
        if (!documentContext) {
          return null;
        }

        documentContext.service.setDocumentOverride(fileName, documentText, {
          uri: URI.file(fileName).toString(),
          version: readScriptVersionToken(fileName) || "0",
        });

        return {
          ...documentContext,
          documentText,
        };
      }

      function ensureDocumentContext(fileName) {
        return isPocketPagesEjsFile(fileName)
          ? ensureEjsDocumentContext(fileName)
          : ensureScriptDocumentContext(fileName);
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

      function getBaseLanguageServiceResult(methodName, args, fallbackValue) {
        const method = baseLanguageService && baseLanguageService[methodName];
        if (typeof method !== "function") {
          return fallbackValue;
        }

        return method.apply(baseLanguageService, args);
      }

      function isReferenceAllowedAtPosition(documentContext, position) {
        if (!documentContext) {
          return false;
        }

        if (!isPocketPagesEjsFile(documentContext.filePath)) {
          return true;
        }

        return isTsOwnedPosition(documentContext, position, "references") ||
          !!documentContext.service.getPathReferenceContext(
            documentContext.filePath,
            documentContext.documentText,
            position
          );
      }

      function isRenameAllowedAtPosition(documentContext, position) {
        if (!documentContext) {
          return false;
        }

        return !isPocketPagesEjsFile(documentContext.filePath) ||
          isTsOwnedPosition(documentContext, position, "rename");
      }

      function getLocationKey(fileName, start, length) {
        const safeStart = Math.max(0, Number(start) || 0);
        const safeLength = Math.max(0, Number(length) || 0);
        return `${normalizeTrackedPath(fileName)}:${safeStart}:${safeLength}`;
      }

      function getReferenceKey(reference) {
        if (!reference || !reference.fileName || !reference.textSpan) {
          return null;
        }

        return getLocationKey(
          reference.fileName,
          reference.textSpan.start,
          reference.textSpan.length
        );
      }

      function getRenameLocationKey(location) {
        if (!location || !location.fileName || !location.textSpan) {
          return null;
        }

        return getLocationKey(
          location.fileName,
          location.textSpan.start,
          location.textSpan.length
        );
      }

      function isRenameDefinitionLocation(documentContext, renameInfo, location) {
        if (!documentContext || !renameInfo || !location) {
          return false;
        }

        return (
          normalizeTrackedPath(location.filePath) === normalizeTrackedPath(documentContext.filePath) &&
          Number(location.start) === Number(renameInfo.start) &&
          Number(location.end) === Number(renameInfo.end)
        );
      }

      function toReferenceEntry(documentContext, renameInfo, location) {
        if (
          !location ||
          !location.filePath ||
          !Number.isFinite(Number(location.start)) ||
          !Number.isFinite(Number(location.end))
        ) {
          return null;
        }

        const start = Number(location.start);
        const end = Math.max(start, Number(location.end));
        return {
          fileName: location.filePath,
          textSpan: {
            start,
            length: end - start,
          },
          isWriteAccess: false,
          isDefinition: isRenameDefinitionLocation(documentContext, renameInfo, location),
        };
      }

      function toRenameLocation(location) {
        if (
          !location ||
          !location.filePath ||
          !Number.isFinite(Number(location.start)) ||
          !Number.isFinite(Number(location.end))
        ) {
          return null;
        }

        const start = Number(location.start);
        const end = Math.max(start, Number(location.end));
        return {
          fileName: location.filePath,
          textSpan: {
            start,
            length: end - start,
          },
        };
      }

      function mergeReferenceEntries(baseReferences, pocketPagesReferences) {
        const merged = new Map();
        for (const reference of Array.isArray(baseReferences) ? baseReferences : []) {
          const key = getReferenceKey(reference);
          if (key && !merged.has(key)) {
            merged.set(key, reference);
          }
        }

        for (const reference of Array.isArray(pocketPagesReferences) ? pocketPagesReferences : []) {
          const key = getReferenceKey(reference);
          if (key && !merged.has(key)) {
            merged.set(key, reference);
          }
        }

        return [...merged.values()];
      }

      function mergeRenameLocations(baseLocations, pocketPagesLocations) {
        const merged = new Map();
        for (const location of Array.isArray(baseLocations) ? baseLocations : []) {
          const key = getRenameLocationKey(location);
          if (key && !merged.has(key)) {
            merged.set(key, location);
          }
        }

        for (const location of Array.isArray(pocketPagesLocations) ? pocketPagesLocations : []) {
          const key = getRenameLocationKey(location);
          if (key && !merged.has(key)) {
            merged.set(key, location);
          }
        }

        return [...merged.values()];
      }

      function toTypeScriptRenameInfo(renameInfo) {
        if (!renameInfo) {
          return null;
        }

        if (!renameInfo.canRename) {
          return {
            canRename: false,
            localizedErrorMessage: renameInfo.localizedErrorMessage || "Unable to rename this symbol.",
          };
        }

        const start = Number(renameInfo.start);
        const end = Math.max(start, Number(renameInfo.end));
        const displayName = renameInfo.placeholder || "";
        return {
          canRename: true,
          displayName,
          fullDisplayName: displayName,
          kind: ts.ScriptElementKind.unknown,
          kindModifiers: "",
          triggerSpan: {
            start,
            length: end - start,
          },
        };
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

      proxy.getReferencesAtPosition = (fileName, position) => {
        const baseReferences = getBaseLanguageServiceResult(
          "getReferencesAtPosition",
          [fileName, position],
          undefined
        );
        const documentContext = ensureDocumentContext(fileName);
        if (!documentContext || !isReferenceAllowedAtPosition(documentContext, position)) {
          return baseReferences;
        }

        const renameInfo = documentContext.service.getRenameInfo(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        const referenceTargets = documentContext.service.getReferenceTargets(
          documentContext.filePath,
          documentContext.documentText,
          position,
          { includeDeclaration: true }
        );
        const pocketPagesReferences = (referenceTargets || [])
          .map((location) => toReferenceEntry(documentContext, renameInfo, location))
          .filter(Boolean);
        if (!pocketPagesReferences.length) {
          return baseReferences;
        }

        return mergeReferenceEntries(baseReferences, pocketPagesReferences);
      };

      proxy.getRenameInfo = (fileName, position, options) => {
        const baseRenameInfo = getBaseLanguageServiceResult(
          "getRenameInfo",
          [fileName, position, options],
          undefined
        );
        const documentContext = ensureDocumentContext(fileName);
        if (!documentContext || !isRenameAllowedAtPosition(documentContext, position)) {
          return baseRenameInfo;
        }

        const renameInfo = documentContext.service.getRenameInfo(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        if (!renameInfo) {
          return baseRenameInfo;
        }

        const typeScriptRenameInfo = toTypeScriptRenameInfo(renameInfo);
        if (!typeScriptRenameInfo) {
          return baseRenameInfo;
        }

        if (baseRenameInfo && baseRenameInfo.canRename && typeScriptRenameInfo.canRename) {
          return {
            ...baseRenameInfo,
            triggerSpan: typeScriptRenameInfo.triggerSpan || baseRenameInfo.triggerSpan,
          };
        }

        return typeScriptRenameInfo;
      };

      proxy.findRenameLocations = (
        fileName,
        position,
        findInStrings,
        findInComments,
        providePrefixAndSuffixTextForRename
      ) => {
        const baseLocations = getBaseLanguageServiceResult(
          "findRenameLocations",
          [fileName, position, findInStrings, findInComments, providePrefixAndSuffixTextForRename],
          undefined
        );
        const documentContext = ensureDocumentContext(fileName);
        if (!documentContext || !isRenameAllowedAtPosition(documentContext, position)) {
          return baseLocations;
        }

        const renameInfo = documentContext.service.getRenameInfo(
          documentContext.filePath,
          documentContext.documentText,
          position
        );
        if (!renameInfo || !renameInfo.canRename) {
          return baseLocations;
        }

        const referenceTargets = documentContext.service.getReferenceTargets(
          documentContext.filePath,
          documentContext.documentText,
          position,
          { includeDeclaration: true }
        );
        const pocketPagesLocations = (referenceTargets || [])
          .map((location) => toRenameLocation(location))
          .filter(Boolean);
        if (!pocketPagesLocations.length) {
          return baseLocations;
        }

        return mergeRenameLocations(baseLocations, pocketPagesLocations);
      };

      const baseDispose = typeof proxy.dispose === "function" ? proxy.dispose.bind(proxy) : null;
      proxy.dispose = () => {
        disposeAppWatchers();
        if (baseDispose) {
          return baseDispose();
        }
        return undefined;
      };

      return proxy;
    },

    getExternalFiles(project) {
      return collectExternalPocketPagesEjsFiles(ts, project);
    },
  };
}

module.exports = init;
