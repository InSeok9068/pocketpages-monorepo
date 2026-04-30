"use strict";

function createDocumentRuntimeState(uri) {
  return {
    uri,
    version: null,
    textLength: 0,
    openedAt: 0,
    changedAt: 0,
    savedAt: 0,
    updatedAt: 0,
    diagnostics: new Map(),
  };
}

function createDocumentRuntimeStateRegistry() {
  const states = new Map();

  function getOrCreate(uri) {
    const key = String(uri || "");
    let state = states.get(key);
    if (!state) {
      state = createDocumentRuntimeState(key);
      states.set(key, state);
    }
    return state;
  }

  function updateDocument(uri, documentInfo = {}) {
    const state = getOrCreate(uri);
    const now = Date.now();
    state.version =
      documentInfo.version === undefined ? state.version : documentInfo.version;
    state.textLength =
      documentInfo.textLength === undefined ? state.textLength : documentInfo.textLength;
    state.updatedAt = now;
    if (documentInfo.opened === true) {
      state.openedAt = now;
    }
    if (documentInfo.changed === true) {
      state.changedAt = now;
    }
    if (documentInfo.saved === true) {
      state.savedAt = now;
      state.changedAt = 0;
    }
    return state;
  }

  function getDocument(uri) {
    return states.get(String(uri || "")) || null;
  }

  function getDiagnostics(uri, key) {
    const state = states.get(String(uri || "")) || null;
    if (!state || !(state.diagnostics instanceof Map)) {
      return null;
    }

    return state.diagnostics.get(String(key || "default")) || null;
  }

  function setDiagnostics(uri, key, value) {
    const state = getOrCreate(uri);
    if (!(state.diagnostics instanceof Map)) {
      state.diagnostics = new Map();
    }
    state.diagnostics.set(String(key || "default"), value);
    return value;
  }

  function deleteDocument(uri) {
    states.delete(String(uri || ""));
  }

  function isStaleVersion(uri, version) {
    const state = states.get(String(uri || "")) || null;
    return !state || state.version !== version;
  }

  return {
    updateDocument,
    getDocument,
    getDiagnostics,
    setDiagnostics,
    deleteDocument,
    isStaleVersion,
  };
}

module.exports = {
  createDocumentRuntimeStateRegistry,
};
