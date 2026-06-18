"use strict";

const fs = require("fs");
const path = require("path");
const { URI } = require("vscode-uri");
const { PocketPagesLanguageServiceManager } = require("../language-service/language-service");
const { createPocketPagesLanguagePlugin } = require("./language-plugin");

function uriToFilePath(uri) {
  return URI.parse(uri).fsPath;
}

function isFileUri(uri) {
  return typeof uri === "string" && uri.startsWith("file:");
}

function readSnapshotText(snapshot) {
  if (!snapshot) {
    return "";
  }

  if (typeof snapshot.__pocketpagesText === "string") {
    return snapshot.__pocketpagesText;
  }

  if (typeof snapshot.getText === "function" && typeof snapshot.getLength === "function") {
    return snapshot.getText(0, snapshot.getLength());
  }

  return "";
}

function createGeneratedState(root, languagePlugin) {
  const embeddedCodes = new Map();
  for (const embeddedCode of root && typeof root.getEmbeddedCodes === "function" ? root.getEmbeddedCodes() : []) {
    embeddedCodes.set(embeddedCode.id, embeddedCode);
  }

  return {
    root,
    languagePlugin,
    embeddedCodes,
  };
}

function getMappingSegments(mapping) {
  if (
    !mapping ||
    !Array.isArray(mapping.sourceOffsets) ||
    !Array.isArray(mapping.generatedOffsets) ||
    !Array.isArray(mapping.lengths)
  ) {
    return [];
  }

  const segmentCount = Math.min(
    mapping.sourceOffsets.length,
    mapping.generatedOffsets.length,
    mapping.lengths.length
  );
  const segments = [];

  for (let index = 0; index < segmentCount; index += 1) {
    const sourceStart = Number(mapping.sourceOffsets[index]) || 0;
    const generatedStart = Number(mapping.generatedOffsets[index]) || 0;
    const length = Number(mapping.lengths[index]) || 0;
    if (length < 0) {
      continue;
    }

    segments.push({
      mapping,
      data: mapping.data || {},
      sourceStart,
      generatedStart,
      length,
      sourceEnd: sourceStart + length,
      generatedEnd: generatedStart + length,
    });
  }

  return segments;
}

function doesRangeOverlap(start, end, rangeStart, rangeEnd) {
  return start < rangeEnd && end > rangeStart;
}

function hasOtherSegmentStartingAtSourceOffset(segments, segment, sourceOffset) {
  return segments.some(
    (entry) => entry !== segment && entry.sourceStart === sourceOffset
  );
}

function isCapabilityEnabled(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value && typeof value === "object") {
    return true;
  }

  return false;
}

function getCapabilityValue(data, capabilityName) {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(data, capabilityName)) {
    return data[capabilityName];
  }

  switch (capabilityName) {
    case "hover":
      return data.semantic;
    case "definition":
      return data.navigation;
    case "references":
      return data.references !== undefined ? data.references : data.navigation;
    case "rename":
      return data.rename !== undefined ? data.rename : data.navigation;
    case "diagnostics":
      return data.verification;
    default:
      return undefined;
  }
}

function createMapper(mappings) {
  const normalizedMappings = Array.isArray(mappings) ? mappings : [];
  const segments = normalizedMappings
    .flatMap((mapping) => getMappingSegments(mapping))
    .sort((left, right) => {
      if (left.generatedStart !== right.generatedStart) {
        return left.generatedStart - right.generatedStart;
      }

      return left.sourceStart - right.sourceStart;
    });

  return {
    mappings: normalizedMappings,
    *toSourceRange(start, end, _fallbackToAnyMatch = false, filter) {
      for (const segment of segments) {
        if (!doesRangeOverlap(start, end, segment.generatedStart, segment.generatedEnd)) {
          continue;
        }

        if (filter && !filter(segment.data)) {
          continue;
        }

        const overlapStart = Math.max(start, segment.generatedStart);
        const overlapEnd = Math.min(end, segment.generatedEnd);
        yield [
          segment.sourceStart + (overlapStart - segment.generatedStart),
          segment.sourceStart + (overlapEnd - segment.generatedStart),
          segment.mapping,
          segment.mapping,
        ];
      }
    },
    *toGeneratedRange(start, end, _fallbackToAnyMatch = false, filter) {
      for (const segment of segments) {
        if (!doesRangeOverlap(start, end, segment.sourceStart, segment.sourceEnd)) {
          continue;
        }

        if (filter && !filter(segment.data)) {
          continue;
        }

        const overlapStart = Math.max(start, segment.sourceStart);
        const overlapEnd = Math.min(end, segment.sourceEnd);
        yield [
          segment.generatedStart + (overlapStart - segment.sourceStart),
          segment.generatedStart + (overlapEnd - segment.sourceStart),
          segment.mapping,
          segment.mapping,
        ];
      }
    },
    *toSourceLocation(generatedOffset, filter) {
      for (const segment of segments) {
        if (
          generatedOffset < segment.generatedStart ||
          generatedOffset >= segment.generatedEnd
        ) {
          continue;
        }

        if (filter && !filter(segment.data)) {
          continue;
        }

        yield [
          segment.sourceStart + (generatedOffset - segment.generatedStart),
          segment.mapping,
        ];
      }
    },
    *toGeneratedLocation(sourceOffset, filter) {
      for (const segment of segments) {
        const atSegmentEnd = sourceOffset === segment.sourceEnd;
        if (sourceOffset < segment.sourceStart || sourceOffset > segment.sourceEnd) {
          continue;
        }

        if (
          atSegmentEnd &&
          hasOtherSegmentStartingAtSourceOffset(segments, segment, sourceOffset)
        ) {
          continue;
        }

        if (!atSegmentEnd && sourceOffset >= segment.sourceEnd) {
          continue;
        }

        if (filter && !filter(segment.data)) {
          continue;
        }

        yield [
          segment.generatedStart + (sourceOffset - segment.sourceStart),
          segment.mapping,
        ];
      }
    },
  };
}

function createLinkedCodeMap(associatedScriptMappings) {
  const normalizedMappings =
    associatedScriptMappings instanceof Map ? associatedScriptMappings : new Map();

  return {
    get(targetId) {
      if (!normalizedMappings.has(targetId)) {
        return undefined;
      }

      return createMapper(normalizedMappings.get(targetId));
    },
    has(targetId) {
      return normalizedMappings.has(targetId);
    },
    keys() {
      return normalizedMappings.keys();
    },
    entries() {
      return [...normalizedMappings.entries()].map(([targetId, mappings]) => [
        targetId,
        createMapper(mappings),
      ]);
    },
  };
}

class PocketPagesLanguageCore {
  constructor(options = {}) {
    this.manager = options.manager || new PocketPagesLanguageServiceManager();
    this.logger = options.logger || null;
    this.plugins = options.plugins || [createPocketPagesLanguagePlugin()];
    this.sourceScripts = new Map();

    this.scripts = {
      get: (uri) => this.sourceScripts.get(uri),
      set: (uri, snapshot, languageId) => this.setSourceScript(uri, snapshot, languageId),
      delete: (uri) => this.deleteSourceScript(uri),
      fromVirtualCode: (virtualCode) =>
        [...this.sourceScripts.values()].find((sourceScript) => {
          if (!sourceScript.generated) {
            return false;
          }

          if (sourceScript.generated.root === virtualCode) {
            return true;
          }

          return (
            !!virtualCode &&
            sourceScript.generated.embeddedCodes.get(virtualCode.id) === virtualCode
          );
        }) || null,
    };
    this.maps = {
      get: (virtualCode) =>
        createMapper(
          Array.isArray(virtualCode && virtualCode.mappings) ? virtualCode.mappings : []
        ),
      forEach: function* (virtualCode) {
        const sourceScript = this.scripts.fromVirtualCode(virtualCode);
        if (!sourceScript) {
          return;
        }

        yield [
          sourceScript,
          this.maps.get(virtualCode, sourceScript),
        ];
      }.bind(this),
    };
    this.linkedCodeMaps = {
      get: (virtualCode) => {
        if (
          !virtualCode ||
          !(virtualCode.associatedScriptMappings instanceof Map) ||
          !virtualCode.associatedScriptMappings.size
        ) {
          return undefined;
        }

        return createLinkedCodeMap(virtualCode.associatedScriptMappings);
      },
    };
  }

  log(message) {
    if (this.logger && typeof this.logger.log === "function") {
      this.logger.log(message);
    }
  }

  resolveLanguageId(uri, explicitLanguageId) {
    if (explicitLanguageId) {
      return explicitLanguageId;
    }

    for (const plugin of this.plugins) {
      const languageId = plugin.getLanguageId && plugin.getLanguageId(uri);
      if (languageId) {
        return languageId;
      }
    }

    return "plaintext";
  }

  createSnapshot(text, previousSnapshot = null) {
    const plugin = this.plugins.find((entry) => typeof entry.createSnapshot === "function");
    if (!plugin) {
      throw new Error("PocketPages language plugin is missing createSnapshot().");
    }

    return plugin.createSnapshot(text, previousSnapshot);
  }

  getLanguagePlugin(uri, languageId) {
    return (
      this.plugins.find((entry) => !entry.getLanguageId || entry.getLanguageId(uri) === languageId) ||
      this.plugins[0]
    );
  }

  refreshGeneratedState(sourceScript, plugin = null) {
    if (!sourceScript) {
      return null;
    }

    const languagePlugin = plugin || sourceScript.languagePlugin || this.getLanguagePlugin(sourceScript.id, sourceScript.languageId);
    if (!languagePlugin || typeof languagePlugin.createVirtualCode !== "function") {
      throw new Error("PocketPages language plugin is missing createVirtualCode().");
    }

    if (
      sourceScript.generated &&
      sourceScript.generated.root &&
      typeof languagePlugin.updateVirtualCode === "function"
    ) {
      sourceScript.generated = createGeneratedState(
        languagePlugin.updateVirtualCode(sourceScript.id, sourceScript.generated.root, sourceScript.snapshot),
        languagePlugin
      );
    } else {
      sourceScript.generated = createGeneratedState(
        languagePlugin.createVirtualCode(sourceScript.id, sourceScript.languageId, sourceScript.snapshot),
        languagePlugin
      );
    }

    sourceScript.languagePlugin = languagePlugin;
    sourceScript.generatedStale = false;
    return sourceScript.generated;
  }

  ensureGeneratedState(sourceScript) {
    if (!sourceScript) {
      return null;
    }

    if (!sourceScript.generated || sourceScript.generatedStale === true) {
      return this.refreshGeneratedState(sourceScript);
    }

    return sourceScript.generated;
  }

  setSourceScript(uri, snapshot, explicitLanguageId, documentVersion = null, options = {}) {
    const existing = this.sourceScripts.get(uri);
    const languageId = this.resolveLanguageId(uri, explicitLanguageId || (existing && existing.languageId));
    const plugin = this.getLanguagePlugin(uri, languageId);

    if (!plugin || typeof plugin.createVirtualCode !== "function") {
      throw new Error("PocketPages language plugin is missing createVirtualCode().");
    }

    if (existing) {
      existing.languageId = languageId;
      existing.snapshot = snapshot;
      existing.version = documentVersion;
      existing.languagePlugin = plugin;

      if (options.updateGenerated === false && existing.generated) {
        if (options.markGeneratedStale === true) {
          existing.generatedStale = true;
        }
        return existing;
      }

      this.refreshGeneratedState(existing, plugin);
      return existing;
    }

    const sourceScript = {
      id: uri,
      languageId,
      snapshot,
      version: documentVersion,
      languagePlugin: plugin,
      generated: null,
      generatedStale: false,
    };
    this.refreshGeneratedState(sourceScript, plugin);
    this.sourceScripts.set(uri, sourceScript);
    return sourceScript;
  }

  deleteSourceScript(uri) {
    this.sourceScripts.delete(uri);
  }

  openDocument(document, options = {}) {
    return this.upsertDocument(document, {
      ...options,
      opened: true,
    });
  }

  updateDocument(document, options = {}) {
    return this.upsertDocument(document, {
      ...options,
      changed: true,
    });
  }

  upsertDocument(document, options = {}) {
    const previousSourceScript = this.sourceScripts.get(document.uri);
    const currentText = String(document.text || "");
    const previousText = previousSourceScript ? readSnapshotText(previousSourceScript.snapshot) : null;
    const canReuseGenerated =
      !!previousSourceScript &&
      previousSourceScript.generated &&
      previousSourceScript.generatedStale !== true &&
      previousText === currentText;
    const snapshot = previousText === currentText
      ? previousSourceScript.snapshot
      : this.createSnapshot(currentText, previousSourceScript ? previousSourceScript.snapshot : null);
    const shouldPrepareVirtualCode = options.prepareVirtualCode !== false;
    const sourceScript = this.setSourceScript(document.uri, snapshot, document.languageId, document.version, {
      updateGenerated: shouldPrepareVirtualCode && !canReuseGenerated,
      markGeneratedStale: !shouldPrepareVirtualCode && !canReuseGenerated,
    });
    this.syncDocumentOverride(sourceScript, {
      prepareVirtualCode: shouldPrepareVirtualCode,
      opened: options.opened === true,
      changed: options.changed === true,
    });
    return sourceScript.generated && sourceScript.generated.root ? sourceScript.generated.root : null;
  }

  prepareDocument(uri, options = {}) {
    const sourceScript = this.sourceScripts.get(uri);
    if (!sourceScript) {
      return null;
    }

    this.ensureGeneratedState(sourceScript);
    this.syncDocumentOverride(sourceScript, {
      ...options,
      prepareVirtualCode: true,
    });
    return sourceScript.generated && sourceScript.generated.root
      ? sourceScript.generated.root
      : null;
  }

  closeDocument(uri) {
    const sourceScript = this.sourceScripts.get(uri);
    this.deleteSourceScript(uri);

    if (!sourceScript || !sourceScript.generated || !sourceScript.generated.root) {
      return;
    }

    const service = this.manager.getServiceForFile(sourceScript.generated.root.filePath);
    if (service) {
      service.clearDocumentOverride(sourceScript.generated.root.filePath);
      if (typeof service.clearPreparedDocumentState === "function") {
        service.clearPreparedDocumentState(sourceScript.generated.root.filePath);
      }
    }
  }

  getVirtualCode(uri) {
    const sourceScript = this.sourceScripts.get(uri);
    return sourceScript && sourceScript.generated ? sourceScript.generated.root : null;
  }

  getSourceScript(uri) {
    return this.sourceScripts.get(uri) || null;
  }

  getFeatureOwnersAtOffset(uri, offset, capabilityName, options = {}) {
    const sourceScript = this.getSourceScript(uri);
    if (!sourceScript || !this.ensureGeneratedState(sourceScript)) {
      return [];
    }

    const owners = [];
    const embeddedCodes = sourceScript.generated.embeddedCodes
      ? [...sourceScript.generated.embeddedCodes.values()]
      : [];

    for (const embeddedCode of embeddedCodes) {
      if (options.kind && embeddedCode.kind !== options.kind) {
        continue;
      }

      if (options.id && embeddedCode.id !== options.id) {
        continue;
      }

      const mapper = this.maps.get(embeddedCode, sourceScript);
      for (const [generatedOffset, mapping] of mapper.toGeneratedLocation(offset, (data) =>
        isCapabilityEnabled(getCapabilityValue(data, capabilityName))
      )) {
        owners.push({
          embeddedCode,
          generatedOffset,
          mapping,
        });
      }
    }

    return owners;
  }

  isFeatureEnabledAtOffset(uri, offset, capabilityName, options = {}) {
    return this.getFeatureOwnersAtOffset(uri, offset, capabilityName, options).length > 0;
  }

  hasFeatureCoverageForRange(uri, start, end, capabilityName, options = {}) {
    const sourceScript = this.getSourceScript(uri);
    if (!sourceScript || !this.ensureGeneratedState(sourceScript)) {
      return false;
    }

    const rangeStart = Math.max(0, Number(start) || 0);
    const rangeEnd = Math.max(rangeStart, Number.isFinite(end) ? Number(end) : rangeStart);
    if (rangeEnd <= rangeStart) {
      return this.isFeatureEnabledAtOffset(uri, rangeStart, capabilityName, options);
    }

    const embeddedCodes = sourceScript.generated.embeddedCodes
      ? [...sourceScript.generated.embeddedCodes.values()]
      : [];

    for (const embeddedCode of embeddedCodes) {
      if (options.kind && embeddedCode.kind !== options.kind) {
        continue;
      }

      if (options.id && embeddedCode.id !== options.id) {
        continue;
      }

      const mapper = this.maps.get(embeddedCode, sourceScript);
      for (const _match of mapper.toGeneratedRange(rangeStart, rangeEnd, false, (data) =>
        isCapabilityEnabled(getCapabilityValue(data, capabilityName))
      )) {
        return true;
      }
    }

    return false;
  }

  getManagedVirtualCodes() {
    return [...this.sourceScripts.values()]
      .map((sourceScript) => sourceScript.generated && sourceScript.generated.root)
      .filter(Boolean);
  }

  syncDocumentOverride(sourceScript, options = {}) {
    if (!sourceScript || !sourceScript.generated || !sourceScript.generated.root) {
      return;
    }

    if (options.prepareVirtualCode !== false) {
      this.ensureGeneratedState(sourceScript);
    }

    const virtualCode = sourceScript.generated.root;
    const service = this.manager.getServiceForFile(virtualCode.filePath);
    if (!service) {
      return;
    }

    const syncOptions = {
      uri: sourceScript.id,
      version: sourceScript.version,
      opened: options.opened === true,
      changed: options.changed === true,
      operation: options.operation,
      preferredOffset: options.preferredOffset,
      skipUnrelatedRegions: options.skipUnrelatedRegions === true,
      skipStaticRefresh: options.skipStaticRefresh === true,
    };
    const documentText = readSnapshotText(sourceScript.snapshot);
    service.setDocumentOverride(virtualCode.filePath, documentText, syncOptions);
    if (options.prepareVirtualCode === false) {
      if (typeof service.clearPreparedDocumentState === "function") {
        service.clearPreparedDocumentState(virtualCode.filePath);
      }
      return;
    }

    if (typeof service.syncPreparedDocumentVirtualCode === "function") {
      service.syncPreparedDocumentVirtualCode(
        virtualCode.filePath,
        documentText,
        virtualCode,
        syncOptions
      );
    }
  }

  getServiceForFile(filePath) {
    return this.manager.getServiceForFile(filePath);
  }

  getDocumentTextForFile(filePath) {
    const normalizedFilePath = path.resolve(String(filePath || ""));
    for (const sourceScript of this.sourceScripts.values()) {
      const virtualCode = sourceScript.generated && sourceScript.generated.root;
      if (virtualCode && path.resolve(virtualCode.filePath) === normalizedFilePath) {
        return readSnapshotText(sourceScript.snapshot);
      }
    }

    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }

    return "";
  }

  getDocumentContextByUri(uri) {
    if (!isFileUri(uri)) {
      return null;
    }

    const filePath = uriToFilePath(uri);
    const service = this.manager.getServiceForFile(filePath);
    if (!service) {
      return null;
    }

    const sourceScript = this.sourceScripts.get(uri) || null;
    const documentText = sourceScript
      ? readSnapshotText(sourceScript.snapshot)
      : this.getDocumentTextForFile(filePath);
    return {
      uri,
      filePath,
      service,
      sourceScript,
      virtualCode: sourceScript && sourceScript.generated ? sourceScript.generated.root : null,
      documentText,
    };
  }

  getDocumentContextByFilePath(filePath) {
    const service = this.manager.getServiceForFile(filePath);
    if (!service) {
      return null;
    }

    const sourceScript =
      [...this.sourceScripts.values()].find((entry) => entry.generated && entry.generated.root.filePath === filePath) || null;
    return {
      uri: sourceScript ? sourceScript.id : URI.file(filePath).toString(),
      filePath,
      service,
      sourceScript,
      virtualCode: sourceScript && sourceScript.generated ? sourceScript.generated.root : null,
      documentText: this.getDocumentTextForFile(filePath),
    };
  }

  resyncManagedDocumentsForService(targetService = null) {
    const affectedUris = [];

    for (const sourceScript of this.sourceScripts.values()) {
      const currentVirtualCode = sourceScript.generated && sourceScript.generated.root;
      if (!currentVirtualCode) {
        continue;
      }

      let service = this.manager.getServiceForFile(currentVirtualCode.filePath);
      if (!service || (targetService && service !== targetService)) {
        continue;
      }

      const generated = this.ensureGeneratedState(sourceScript);
      const virtualCode = generated && generated.root;
      if (!virtualCode) {
        continue;
      }

      service = this.manager.getServiceForFile(virtualCode.filePath);
      if (!service || (targetService && service !== targetService)) {
        continue;
      }

      const syncOptions = {
        uri: sourceScript.id,
        version: sourceScript.version,
      };
      const documentText = readSnapshotText(sourceScript.snapshot);
      service.setDocumentOverride(virtualCode.filePath, documentText, syncOptions);
      if (typeof service.syncPreparedDocumentVirtualCode === "function") {
        service.syncPreparedDocumentVirtualCode(
          virtualCode.filePath,
          documentText,
          virtualCode,
          syncOptions
        );
      }
      affectedUris.push(sourceScript.id);
    }

    return affectedUris;
  }

  reloadCaches(targetFilePath = null) {
    const targetService = targetFilePath ? this.manager.resetCachesForFile(targetFilePath) : null;
    if (!targetService) {
      this.manager.resetAllCaches();
    }

    const affectedUris = this.resyncManagedDocumentsForService(targetService);

    return {
      targetFilePath,
      scoped: !!targetService,
      affectedUris,
      message: targetService
        ? "PocketPages caches reloaded for the current app."
        : "PocketPages caches reloaded.",
    };
  }

  reloadCachesForAppRoot(appRoot) {
    const targetService = appRoot ? this.manager.resetCachesForAppRoot(appRoot) : null;
    const affectedUris = this.resyncManagedDocumentsForService(targetService);
    return {
      appRoot,
      scoped: !!targetService,
      affectedUris,
      message: targetService
        ? "PocketPages caches reloaded for the current app."
        : "PocketPages caches reloaded.",
    };
  }

  handleWatchedFileChanges(changes) {
    const appResults = [];
    const affectedUris = [];
    const seenUris = new Set();

    for (const result of this.manager.handleWatchedFileChanges(changes)) {
      const serviceAffectedUris = this.resyncManagedDocumentsForService(result.service);
      for (const uri of serviceAffectedUris) {
        if (seenUris.has(uri)) {
          continue;
        }

        seenUris.add(uri);
        affectedUris.push(uri);
      }

      appResults.push({
        appRoot: result.appRoot,
        changes: result.changes,
        affectedUris: serviceAffectedUris,
      });
    }

    return {
      appResults,
      affectedUris,
    };
  }

  probeFile(filePath) {
    const context = this.getDocumentContextByFilePath(filePath);
    if (!context) {
      return {
        filePath,
        hasAppRoot: false,
        diagnostics: 0,
      };
    }

    const diagnostics = context.service.getDiagnostics(filePath, context.documentText);
    return {
      filePath,
      hasAppRoot: true,
      diagnostics: diagnostics.length,
    };
  }

  getFileReferenceResult(filePath) {
    const context = this.getDocumentContextByFilePath(filePath);
    if (!context) {
      return null;
    }

    const referenceQuery = context.service.getFileReferenceQuery(filePath);
    if (!referenceQuery) {
      return null;
    }

    const references =
      context.service.getFileReferenceTargets(filePath, context.documentText, {
        includeDeclaration: false,
      }) || [];

    return {
      referenceQuery,
      references,
    };
  }

  getCurrentRouteExplanation(filePath) {
    const context = this.getDocumentContextByFilePath(filePath);
    if (!context || !context.service || typeof context.service.getCurrentRouteExplanation !== "function") {
      return null;
    }

    return context.service.getCurrentRouteExplanation(filePath, context.documentText);
  }

  getFileRenameEdits(oldFilePath, newFilePath) {
    const service = this.manager.getServiceForFile(oldFilePath) || this.manager.getServiceForFile(newFilePath);
    if (!service) {
      return [];
    }

    return service.getFileRenameEdits(oldFilePath, newFilePath) || [];
  }
}

module.exports = {
  PocketPagesLanguageCore,
  uriToFilePath,
};
