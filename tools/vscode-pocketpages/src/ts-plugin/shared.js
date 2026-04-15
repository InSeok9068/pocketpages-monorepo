"use strict";

const fs = require("fs");
const path = require("path");
const { extractServerBlocks } = require("../script-server");

function normalizeFilePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function isPocketPagesEjsFile(fileName) {
  const normalizedFileName = normalizeFilePath(fileName).toLowerCase();
  return normalizedFileName.endsWith(".ejs") && normalizedFileName.includes("/pb_hooks/pages/");
}

function buildScriptServerMirrorText(documentText) {
  const sourceText = String(documentText || "");
  if (!sourceText) {
    return "";
  }

  const mirrored = Array.from(sourceText, (character) =>
    character === "\n" || character === "\r" ? character : " "
  );

  for (const block of extractServerBlocks(sourceText)) {
    const blockText = sourceText.slice(block.contentStart, block.contentEnd);
    for (let index = 0; index < blockText.length; index += 1) {
      mirrored[block.contentStart + index] = blockText[index];
    }
  }

  return mirrored.join("");
}

function getProjectSearchRoot(project) {
  if (!project) {
    return process.cwd();
  }

  if (typeof project.getProjectName === "function") {
    const projectName = String(project.getProjectName() || "");
    if (projectName) {
      if (path.extname(projectName).toLowerCase() === ".json") {
        return path.dirname(projectName);
      }

      if (fs.existsSync(projectName) && fs.statSync(projectName).isDirectory()) {
        return projectName;
      }
    }
  }

  if (typeof project.getCurrentDirectory === "function") {
    return String(project.getCurrentDirectory() || process.cwd());
  }

  return process.cwd();
}

function collectExternalPocketPagesEjsFiles(ts, project) {
  if (!ts || !ts.sys || typeof ts.sys.readDirectory !== "function") {
    return [];
  }

  const projectRoot = getProjectSearchRoot(project);
  return ts.sys.readDirectory(projectRoot, [".ejs"], undefined, ["**/pb_hooks/pages/**/*.ejs"]);
}

function readSnapshotText(snapshot) {
  if (!snapshot || typeof snapshot.getText !== "function" || typeof snapshot.getLength !== "function") {
    return "";
  }

  return snapshot.getText(0, snapshot.getLength());
}

function offsetAt(text, line, character) {
  const sourceText = String(text || "");
  const targetLine = Math.max(0, Number(line) || 0);
  const targetCharacter = Math.max(0, Number(character) || 0);
  let offset = 0;
  let currentLine = 0;

  while (currentLine < targetLine && offset < sourceText.length) {
    const characterAtOffset = sourceText[offset];
    offset += 1;
    if (characterAtOffset === "\n") {
      currentLine += 1;
    }
  }

  return Math.min(sourceText.length, offset + targetCharacter);
}

function getIdentifierTextSpan(text, position) {
  const sourceText = String(text || "");
  const clampedPosition = Math.max(0, Math.min(sourceText.length, Number(position) || 0));
  const isIdentifierCharacter = (character) => /[A-Za-z0-9_$]/.test(character || "");
  let start = clampedPosition;
  let end = clampedPosition;

  while (start > 0 && isIdentifierCharacter(sourceText[start - 1])) {
    start -= 1;
  }

  while (end < sourceText.length && isIdentifierCharacter(sourceText[end])) {
    end += 1;
  }

  return {
    start,
    length: Math.max(0, end - start),
  };
}

module.exports = {
  buildScriptServerMirrorText,
  collectExternalPocketPagesEjsFiles,
  getIdentifierTextSpan,
  isPocketPagesEjsFile,
  offsetAt,
  readSnapshotText,
};
