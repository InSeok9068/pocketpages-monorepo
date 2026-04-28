"use strict";

const fs = require("fs");
const { createScriptSnapshot } = require("../language-core/snapshot");

function defaultNormalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^[A-Z]:/, (value) => value.toLowerCase());
}

function readFileText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function createVersionedTextState(previousState, state) {
  const currentText = String(state && state.text ? state.text : "");
  return {
    ...state,
    text: currentText,
    version: previousState ? String(Number(previousState.version) + 1) : "1",
    snapshot: createScriptSnapshot(currentText, previousState ? previousState.snapshot : null),
  };
}

class DocumentSnapshotManager {
  constructor(options = {}) {
    this.normalizePath =
      typeof options.normalizePath === "function"
        ? options.normalizePath
        : defaultNormalizePath;

    this.sourceDocuments = new Map();
    this.preparedDocuments = new Map();
    this.staticFiles = new Map();
    this.virtualFiles = new Map();
    this.diskFiles = new Map();
    this.nextSourceSnapshotSequence = 1;
  }

  normalize(filePath) {
    return this.normalizePath(filePath);
  }

  upsertSourceDocument(filePath, text, options = {}) {
    const normalizedFilePath = this.normalize(filePath);
    const currentText = typeof text === "string" ? text : "";
    const previous = this.sourceDocuments.get(normalizedFilePath) || null;
    const now = Date.now();
    const lspVersion =
      options.version !== undefined && options.version !== null
        ? options.version
        : previous
          ? previous.lspVersion
          : null;

    if (previous && previous.text === currentText) {
      previous.lspVersion = lspVersion;
      previous.uri = options.uri || previous.uri || null;
      previous.updatedAt = now;
      if (options.opened === true) {
        previous.openedAt = now;
      }
      if (options.changed === true) {
        previous.changedAt = now;
      }
      return previous;
    }

    const sequence = this.nextSourceSnapshotSequence++;
    const state = {
      filePath: normalizedFilePath,
      uri: options.uri || (previous ? previous.uri : null),
      text: currentText,
      textLength: currentText.length,
      lspVersion,
      contentVersion: sequence,
      snapshotId: `document:${sequence}`,
      snapshot: createScriptSnapshot(currentText, previous ? previous.snapshot : null),
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
      openedAt: options.opened === true ? now : previous ? previous.openedAt : 0,
      changedAt: options.changed === true ? now : previous ? previous.changedAt : 0,
    };
    this.sourceDocuments.set(normalizedFilePath, state);
    return state;
  }

  getSourceDocument(filePath) {
    return this.sourceDocuments.get(this.normalize(filePath)) || null;
  }

  getSourceDocumentForText(filePath, text) {
    const snapshot = this.getSourceDocument(filePath);
    return snapshot && snapshot.text === String(text || "") ? snapshot : null;
  }

  getSourceDocumentIdentity(filePath, text = null) {
    const snapshot =
      text === null || text === undefined
        ? this.getSourceDocument(filePath)
        : this.getSourceDocumentForText(filePath, text);
    return snapshot ? snapshot.snapshotId : null;
  }

  deleteSourceDocument(filePath) {
    return this.sourceDocuments.delete(this.normalize(filePath));
  }

  clearSourceDocuments() {
    this.sourceDocuments.clear();
  }

  setPreparedDocumentState(filePath, preparedState) {
    const normalizedFilePath = this.normalize(filePath);
    if (!preparedState) {
      this.preparedDocuments.delete(normalizedFilePath);
      return;
    }

    this.preparedDocuments.set(normalizedFilePath, preparedState);
  }

  getPreparedDocumentState(filePath) {
    return this.preparedDocuments.get(this.normalize(filePath)) || null;
  }

  clearPreparedDocumentState(filePath) {
    return this.preparedDocuments.delete(this.normalize(filePath));
  }

  clearPreparedDocumentStates() {
    this.preparedDocuments.clear();
  }

  isPreparedDocumentStateCurrent(preparedState, filePath, documentText) {
    if (!preparedState) {
      return false;
    }

    const currentText = String(documentText || "");
    const sourceDocument = this.getSourceDocumentForText(filePath, currentText);
    if (sourceDocument && preparedState.snapshotId) {
      return preparedState.snapshotId === sourceDocument.snapshotId;
    }

    return preparedState.documentText === currentText;
  }

  getManagedTsFileState(fileName) {
    const normalizedFileName = this.normalize(fileName);
    return this.virtualFiles.get(normalizedFileName) || this.staticFiles.get(normalizedFileName) || null;
  }

  getTsFileState(fileName) {
    return this.getManagedTsFileState(fileName) || this.getDiskFileState(fileName);
  }

  getTsFileNames() {
    return [...this.staticFiles.keys(), ...this.virtualFiles.keys()];
  }

  setStaticFileState(fileName, state) {
    const normalizedFileName = this.normalize(fileName);
    const previous = this.staticFiles.get(normalizedFileName);
    const next = createVersionedTextState(previous, state);
    this.staticFiles.set(normalizedFileName, next);
    this.diskFiles.delete(normalizedFileName);
    return next;
  }

  deleteStaticFileState(fileName) {
    return this.staticFiles.delete(this.normalize(fileName));
  }

  clearStaticFileStates() {
    this.staticFiles.clear();
  }

  setVirtualFileState(fileName, state) {
    const normalizedFileName = this.normalize(fileName);
    const previous = this.virtualFiles.get(normalizedFileName);
    const next = createVersionedTextState(previous, state);
    this.virtualFiles.set(normalizedFileName, next);
    this.diskFiles.delete(normalizedFileName);
    return next;
  }

  deleteVirtualFileState(fileName) {
    return this.virtualFiles.delete(this.normalize(fileName));
  }

  clearVirtualFileStates() {
    this.virtualFiles.clear();
  }

  deleteVirtualFileStatesForSource(filePath) {
    const normalizedFilePath = this.normalize(filePath);
    let changed = false;

    for (const [virtualFileName, state] of this.virtualFiles.entries()) {
      if (!state || this.normalize(state.filePath || "") !== normalizedFilePath) {
        continue;
      }

      this.virtualFiles.delete(virtualFileName);
      changed = true;
    }

    return changed;
  }

  getDiskFileState(fileName) {
    const normalizedFileName = this.normalize(fileName);
    if (!fileExists(normalizedFileName)) {
      this.diskFiles.delete(normalizedFileName);
      return null;
    }

    const stats = fs.statSync(normalizedFileName);
    const previous = this.diskFiles.get(normalizedFileName);
    if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
      return previous;
    }

    const text = readFileText(normalizedFileName);
    const next = createVersionedTextState(previous, {
      text,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      filePath: normalizedFileName,
      kind: "disk",
    });
    this.diskFiles.set(normalizedFileName, next);
    return next;
  }

  deleteDiskFileState(fileName) {
    return this.diskFiles.delete(this.normalize(fileName));
  }

  clearDiskFileStates() {
    this.diskFiles.clear();
  }

  clearTsFileStates() {
    this.staticFiles.clear();
    this.virtualFiles.clear();
    this.diskFiles.clear();
  }

  getScriptSnapshot(fileName) {
    const state = this.getTsFileState(fileName);
    return state ? state.snapshot : undefined;
  }

  getScriptVersion(fileName) {
    const state = this.getTsFileState(fileName);
    return state ? state.version : "0";
  }

  hasFile(fileName) {
    return !!this.getManagedTsFileState(fileName) || fileExists(this.normalize(fileName));
  }

  readFile(fileName) {
    const state = this.getTsFileState(fileName);
    return state ? state.text : undefined;
  }
}

module.exports = {
  DocumentSnapshotManager,
  createVersionedTextState,
};
