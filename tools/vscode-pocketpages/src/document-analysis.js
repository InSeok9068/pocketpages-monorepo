"use strict";

const path = require("path");
const ts = require("typescript");
const { buildTemplateVirtualText, extractTemplateCodeBlocks } = require("./ejs-template");
const { extractServerBlocks } = require("./script-server");

function normalizePath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function isEjsFile(filePath) {
  return path.extname(String(filePath || "")).toLowerCase() === ".ejs";
}

function isScriptFile(filePath) {
  return [".js", ".cjs", ".mjs"].includes(path.extname(String(filePath || "")).toLowerCase());
}

function createSourceFileForText(fileName, text) {
  return ts.createSourceFile(fileName, String(text || ""), ts.ScriptTarget.Latest, true);
}

/**
 * 한 문서 진단 호출에서 반복 사용하는 파생 분석 결과를 모아둔다.
 * @param {{ filePath: string, documentText: string, collectResolveCallSpansFromScript: (text: string, options?: object) => Array<object>, collectResolveCallSpansFromTemplate: (text: string) => Array<object>, collectPathContexts: (text: string) => Array<object> }} options
 * @returns {{
 *   getBlocks: () => Array<object>,
 *   getTemplateBlocks: () => Array<object>,
 *   getTemplateVirtualText: () => string,
 *   getPathContexts: () => Array<object>,
 *   getAnalysisText: () => string,
 *   getDocumentSourceFile: () => ts.SourceFile,
 *   getAnalysisSourceFile: () => ts.SourceFile,
 *   getBlockSourceFile: (block: { content: string, contentStart: number, contentEnd: number }) => ts.SourceFile,
 *   getPrivateResolveCallSpans: () => Array<object>,
 * }}
 */
function createDocumentAnalysis(options) {
  const normalizedFilePath = normalizePath(options.filePath);
  const currentText = String(options.documentText || "");
  const sourceFilesByKey = new Map();
  let blocks = null;
  let templateBlocks = null;
  let templateVirtualText = null;
  let pathContexts = null;
  let analysisText = null;
  let analysisSourceFile = null;
  let documentSourceFile = null;
  let privateResolveCallSpans = null;

  const getCachedSourceFile = (cacheKey, textValue, fileName) => {
    if (sourceFilesByKey.has(cacheKey)) {
      return sourceFilesByKey.get(cacheKey);
    }

    const sourceFile = createSourceFileForText(fileName, textValue);
    sourceFilesByKey.set(cacheKey, sourceFile);
    return sourceFile;
  };

  return {
    getBlocks() {
      if (!blocks) {
        blocks = extractServerBlocks(currentText);
      }

      return blocks;
    },

    getTemplateBlocks() {
      if (!templateBlocks) {
        templateBlocks = extractTemplateCodeBlocks(currentText);
      }

      return templateBlocks;
    },

    getTemplateVirtualText() {
      if (templateVirtualText === null) {
        templateVirtualText = buildTemplateVirtualText(currentText);
      }

      return templateVirtualText;
    },

    getPathContexts() {
      if (!pathContexts) {
        pathContexts = options.collectPathContexts(currentText);
      }

      return pathContexts;
    },

    getAnalysisText() {
      if (analysisText === null) {
        analysisText = isEjsFile(normalizedFilePath) ? this.getTemplateVirtualText() : currentText;
      }

      return analysisText;
    },

    getDocumentSourceFile() {
      if (!documentSourceFile) {
        documentSourceFile = getCachedSourceFile("document", currentText, normalizedFilePath);
      }

      return documentSourceFile;
    },

    getAnalysisSourceFile() {
      const currentAnalysisText = this.getAnalysisText();
      if (currentAnalysisText === currentText) {
        return this.getDocumentSourceFile();
      }

      if (!analysisSourceFile) {
        analysisSourceFile = getCachedSourceFile("analysis", currentAnalysisText, `${normalizedFilePath}.__analysis__.ts`);
      }

      return analysisSourceFile;
    },

    getBlockSourceFile(block) {
      return getCachedSourceFile(
        `block:${block.contentStart}:${block.contentEnd}`,
        block.content,
        `${normalizedFilePath}.__block_${block.contentStart}.ts`
      );
    },

    getPrivateResolveCallSpans() {
      if (!privateResolveCallSpans) {
        privateResolveCallSpans = isScriptFile(normalizedFilePath)
          ? options.collectResolveCallSpansFromScript(currentText, { sourceFile: this.getDocumentSourceFile() })
          : options.collectResolveCallSpansFromTemplate(currentText);
      }

      return privateResolveCallSpans;
    },
  };
}

module.exports = {
  createDocumentAnalysis,
  createSourceFileForText,
};
