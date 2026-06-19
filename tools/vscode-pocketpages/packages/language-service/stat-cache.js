"use strict";

const fs = require("fs");

// Request-scoped statSync memoization: while an epoch is active, each distinct path
// is stat'd at most once and the result (including fileExists/isDirectory) is reused.
// Outside an epoch every call hits the real filesystem, so any code path that forgets
// to wrap itself degrades to the previous behavior (slower) rather than serving stale
// data. runStatEpoch always clears the cache in finally, so it never outlives one
// synchronous request.

let statCache = null;

function readStatEntry(filePath) {
  const key = String(filePath || "");
  try {
    const stats = fs.statSync(key);
    return {
      exists: true,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch (_error) {
    return {
      exists: false,
      isFile: false,
      isDirectory: false,
      mtimeMs: 0,
      size: 0,
    };
  }
}

function getStatEntry(filePath) {
  if (!statCache) {
    return readStatEntry(filePath);
  }

  const key = String(filePath || "");
  const cached = statCache.get(key);
  if (cached) {
    return cached;
  }

  const entry = readStatEntry(filePath);
  statCache.set(key, entry);
  return entry;
}

function statFileExists(filePath) {
  return getStatEntry(filePath).isFile;
}

function statDirectoryExists(dirPath) {
  return getStatEntry(dirPath).isDirectory;
}

// Returns a ts.Stats-like shape ({ mtimeMs, size, isFile, isDirectory }) for existing
// files. Missing files re-call fs.statSync so the throw behavior matches the previous
// callers exactly (the missing result is not cached).
function statSyncCached(filePath) {
  const entry = getStatEntry(filePath);
  if (!entry.exists) {
    return fs.statSync(filePath);
  }

  return {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    isFile: () => entry.isFile,
    isDirectory: () => entry.isDirectory,
  };
}

function runStatEpoch(fn) {
  // Reuse an already-open epoch so nested calls within one request share the cache.
  if (statCache) {
    return fn();
  }

  statCache = new Map();
  try {
    return fn();
  } finally {
    statCache = null;
  }
}

module.exports = {
  getStatEntry,
  statFileExists,
  statDirectoryExists,
  statSyncCached,
  runStatEpoch,
};
