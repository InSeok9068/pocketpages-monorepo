"use strict";

const REQUESTS = {
  probeCurrentFile: "pocketpages/probeCurrentFile",
  refreshDiagnostics: "pocketpages/refreshDiagnostics",
  reloadCaches: "pocketpages/reloadCaches",
  allFileReferences: "pocketpages/allFileReferences",
  fileRenameEdits: "pocketpages/fileRenameEdits",
};

const NOTIFICATIONS = {
  didManualSave: "pocketpages/didManualSave",
};

module.exports = {
  REQUESTS,
  NOTIFICATIONS,
};
