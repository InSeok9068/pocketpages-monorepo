"use strict";

const REQUESTS = {
  probeCurrentFile: "pocketpages/probeCurrentFile",
  refreshDiagnostics: "pocketpages/refreshDiagnostics",
  reloadCaches: "pocketpages/reloadCaches",
  allFileReferences: "pocketpages/allFileReferences",
  explainCurrentRoute: "pocketpages/explainCurrentRoute",
  fileRenameEdits: "pocketpages/fileRenameEdits",
  extractPartialEdits: "pocketpages/extractPartialEdits",
};

const NOTIFICATIONS = {
  didManualSave: "pocketpages/didManualSave",
};

module.exports = {
  REQUESTS,
  NOTIFICATIONS,
};
