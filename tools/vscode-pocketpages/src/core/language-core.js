"use strict";

const fs = require("fs");
const path = require("path");
const { URI } = require("vscode-uri");
const { PocketPagesLanguageServiceManager } = require("../language-service");
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
      get: (virtualCode) => ({
        mappings: Array.isArray(virtualCode && virtualCode.mappings) ? virtualCode.mappings : [],
      }),
      forEach: function* (virtualCode) {
        const sourceScript = this.scripts.fromVirtualCode(virtualCode);
        if (!sourceScript) {
          return;
        }

        yield [
          sourceScript,
          {
            mappings: Array.isArray(virtualCode && virtualCode.mappings) ? virtualCode.mappings : [],
          },
        ];
      }.bind(this),
    };
    this.linkedCodeMaps = {
      get: () => undefined,
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

  setSourceScript(uri, snapshot, explicitLanguageId, documentVersion = null) {
    const existing = this.sourceScripts.get(uri);
    const languageId = this.resolveLanguageId(uri, explicitLanguageId || (existing && existing.languageId));
    const plugin =
      this.plugins.find((entry) => !entry.getLanguageId || entry.getLanguageId(uri) === languageId) ||
      this.plugins[0];

    if (!plugin || typeof plugin.createVirtualCode !== "function") {
      throw new Error("PocketPages language plugin is missing createVirtualCode().");
    }

    if (existing) {
      existing.languageId = languageId;
      existing.snapshot = snapshot;
      existing.version = documentVersion;
      if (existing.generated) {
        if (typeof plugin.updateVirtualCode === "function") {
          existing.generated = createGeneratedState(
            plugin.updateVirtualCode(uri, existing.generated.root, snapshot),
            plugin
          );
        } else {
          existing.generated = createGeneratedState(
            plugin.createVirtualCode(uri, languageId, snapshot),
            plugin
          );
        }
      } else {
        existing.generated = createGeneratedState(
          plugin.createVirtualCode(uri, languageId, snapshot),
          plugin
        );
      }

      return existing;
    }

    const sourceScript = {
      id: uri,
      languageId,
      snapshot,
      version: documentVersion,
      generated: createGeneratedState(
        plugin.createVirtualCode(uri, languageId, snapshot),
        plugin
      ),
    };
    this.sourceScripts.set(uri, sourceScript);
    return sourceScript;
  }

  deleteSourceScript(uri) {
    this.sourceScripts.delete(uri);
  }

  openDocument(document) {
    return this.upsertDocument(document);
  }

  updateDocument(document) {
    return this.upsertDocument(document);
  }

  upsertDocument(document) {
    const previousSourceScript = this.sourceScripts.get(document.uri);
    const snapshot = this.createSnapshot(document.text, previousSourceScript ? previousSourceScript.snapshot : null);
    const sourceScript = this.setSourceScript(document.uri, snapshot, document.languageId, document.version);
    this.syncDocumentOverride(sourceScript);
    return sourceScript.generated.root;
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

  getManagedVirtualCodes() {
    return [...this.sourceScripts.values()]
      .map((sourceScript) => sourceScript.generated && sourceScript.generated.root)
      .filter(Boolean);
  }

  syncDocumentOverride(sourceScript) {
    if (!sourceScript || !sourceScript.generated || !sourceScript.generated.root) {
      return;
    }

    const virtualCode = sourceScript.generated.root;
    const service = this.manager.getServiceForFile(virtualCode.filePath);
    if (!service) {
      return;
    }

    service.setDocumentOverride(virtualCode.filePath, virtualCode.getText());
    if (typeof service.syncPreparedDocumentVirtualCode === "function") {
      service.syncPreparedDocumentVirtualCode(
        virtualCode.filePath,
        virtualCode.getText(),
        virtualCode
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
    return {
      uri,
      filePath,
      service,
      sourceScript,
      virtualCode: sourceScript && sourceScript.generated ? sourceScript.generated.root : null,
      documentText: this.getDocumentTextForFile(filePath),
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

  reloadCaches(targetFilePath = null) {
    const targetService = targetFilePath ? this.manager.resetCachesForFile(targetFilePath) : null;
    if (!targetService) {
      this.manager.resetAllCaches();
    }

    for (const sourceScript of this.sourceScripts.values()) {
      const virtualCode = sourceScript.generated && sourceScript.generated.root;
      if (!virtualCode) {
        continue;
      }

      const service = this.manager.getServiceForFile(virtualCode.filePath);
      if (!service) {
        continue;
      }

      if (targetService && service !== targetService) {
        continue;
      }

      service.setDocumentOverride(virtualCode.filePath, virtualCode.getText());
      if (typeof service.syncPreparedDocumentVirtualCode === "function") {
        service.syncPreparedDocumentVirtualCode(
          virtualCode.filePath,
          virtualCode.getText(),
          virtualCode
        );
      }
    }

    return {
      targetFilePath,
      scoped: !!targetService,
      message: targetService
        ? "PocketPages caches reloaded for the current app."
        : "PocketPages caches reloaded.",
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
