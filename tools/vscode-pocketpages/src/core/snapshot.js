"use strict";

function clampOffset(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function createNoopChangeRange(length) {
  return {
    span: {
      start: clampOffset(length, 0, length),
      length: 0,
    },
    newLength: 0,
  };
}

function getChangeRange(oldText, newText) {
  if (oldText === newText) {
    return createNoopChangeRange(newText.length);
  }

  const oldLength = oldText.length;
  const newLength = newText.length;
  const limit = Math.min(oldLength, newLength);

  let start = 0;
  while (start < limit && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start += 1;
  }

  let oldEnd = oldLength;
  let newEnd = newLength;
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return {
    span: {
      start,
      length: oldEnd - start,
    },
    newLength: newEnd - start,
  };
}

function createScriptSnapshot(text, previousSnapshot = null) {
  const currentText = String(text || "");
  const previousText = readSnapshotText(previousSnapshot);
  const fallbackChangeRange = previousSnapshot ? getChangeRange(previousText, currentText) : undefined;

  const snapshot = {
    __pocketpagesText: currentText,
    getText(start, end) {
      return currentText.slice(start, end);
    },
    getLength() {
      return currentText.length;
    },
    getChangeRange(oldSnapshot) {
      if (!oldSnapshot) {
        return undefined;
      }

      if (oldSnapshot === snapshot) {
        return createNoopChangeRange(currentText.length);
      }

      if (oldSnapshot === previousSnapshot && fallbackChangeRange) {
        return fallbackChangeRange;
      }

      const oldText = readSnapshotText(oldSnapshot);
      return getChangeRange(oldText, currentText);
    },
  };

  return snapshot;
}

module.exports = {
  createScriptSnapshot,
  getChangeRange,
  readSnapshotText,
};
