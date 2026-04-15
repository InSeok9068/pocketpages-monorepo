"use strict";

const path = require("path");
const { createVirtualCode, updateVirtualCode } = require("./virtual-code");
const { createScriptSnapshot } = require("./snapshot");

function getLanguageId(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension === ".ejs") {
    return "ejs";
  }
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return "javascript";
  }

  return undefined;
}

function createPocketPagesLanguagePlugin() {
  return {
    getLanguageId,
    createVirtualCode(uri, languageId, snapshot) {
      return createVirtualCode(uri, languageId, 1, snapshot.getText(0, snapshot.getLength()));
    },
    updateVirtualCode(uri, virtualCode, snapshot) {
      return updateVirtualCode(
        virtualCode,
        typeof virtualCode.version === "number" ? virtualCode.version + 1 : 1,
        snapshot.getText(0, snapshot.getLength()),
        getLanguageId(uri)
      );
    },
    createSnapshot(text, previousSnapshot = null) {
      return createScriptSnapshot(text, previousSnapshot);
    },
  };
}

module.exports = {
  createPocketPagesLanguagePlugin,
  getLanguageId,
};
