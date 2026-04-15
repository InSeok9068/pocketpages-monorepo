"use strict";

const path = require("path");
const { URI } = require("vscode-uri");
const { extractServerBlocks } = require("../script-server");
const { buildTemplateVirtualText, extractTemplateCodeBlocks } = require("../ejs-template");
const { createScriptSnapshot } = require("./snapshot");

function normalizeLanguageId(languageId, filePath) {
  if (languageId) {
    return languageId;
  }

  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".ejs") {
    return "ejs";
  }
  if (extension === ".cjs" || extension === ".js" || extension === ".mjs") {
    return "javascript";
  }

  return "plaintext";
}

function createIdentityMapping(length, data) {
  return length > 0
    ? [
        {
          sourceOffsets: [0],
          generatedOffsets: [0],
          lengths: [length],
          data,
        },
      ]
    : [];
}

function createEmbeddedCode({
  id,
  kind,
  languageId,
  text,
  previous,
  mappings,
  metadata,
}) {
  const snapshot = createScriptSnapshot(text, previous ? previous.snapshot : null);
  return {
    id,
    kind,
    languageId,
    snapshot,
    mappings,
    embeddedCodes: [],
    metadata,
  };
}

function buildEmbeddedCodes(filePath, languageId, text, previousEmbeddedCodeMap) {
  if (normalizeLanguageId(languageId, filePath) !== "ejs") {
    return [];
  }

  const embeddedCodes = [];
  const serverBlocks = extractServerBlocks(text);
  for (const block of serverBlocks) {
    const id = `server:${block.index}`;
    embeddedCodes.push(
      createEmbeddedCode({
        id,
        kind: "server-script",
        languageId: "typescript",
        text: block.content,
        previous: previousEmbeddedCodeMap.get(id),
        mappings: block.content.length
          ? [
              {
                sourceOffsets: [block.contentStart],
                generatedOffsets: [0],
                lengths: [block.content.length],
                data: {
                  verification: true,
                  completion: true,
                  semantic: true,
                  navigation: true,
                  structure: true,
                },
              },
            ]
          : [],
        metadata: {
          blockIndex: block.index,
          sourceStart: block.contentStart,
          sourceEnd: block.contentEnd,
          fullStart: block.fullStart,
          fullEnd: block.fullEnd,
        },
      })
    );
  }

  const templateBlocks = extractTemplateCodeBlocks(text);
  if (templateBlocks.length || serverBlocks.length) {
    const templateVirtualText = buildTemplateVirtualText(text);
    const templateLength = templateVirtualText.length;
    embeddedCodes.push(
      createEmbeddedCode({
        id: "template",
        kind: "template",
        languageId: "typescript",
        text: templateVirtualText,
        previous: previousEmbeddedCodeMap.get("template"),
        mappings: createIdentityMapping(templateLength, {
          verification: true,
          completion: true,
          semantic: true,
          navigation: true,
          structure: true,
        }),
        metadata: {
          templateBlocks,
          serverBlocks,
        },
      })
    );
  }

  return embeddedCodes;
}

class PocketPagesVirtualCode {
  constructor({ uri, languageId, version, text }) {
    this.id = "root";
    this.uri = uri;
    this.filePath = URI.parse(uri).fsPath;
    this.languageId = normalizeLanguageId(languageId, this.filePath);
    this.version = version;
    this.text = String(text || "");
    this.mappings = createIdentityMapping(this.text.length, {
      semantic: true,
      structure: true,
      format: true,
    });
    this.associatedScriptMappings = new Map();
    this.embeddedCodes = [];
    this.snapshot = createScriptSnapshot(this.text);
    this.updateEmbeddedCodes(null);
  }

  update({ version, text, languageId }) {
    const previousSnapshot = this.snapshot;
    const previousEmbeddedCodes = this.embeddedCodes;

    this.version = version;
    this.languageId = normalizeLanguageId(languageId || this.languageId, this.filePath);
    this.text = String(text || "");
    this.snapshot = createScriptSnapshot(this.text, previousSnapshot);
    this.mappings = createIdentityMapping(this.text.length, {
      semantic: true,
      structure: true,
      format: true,
    });
    this.updateEmbeddedCodes(previousEmbeddedCodes);
    return this;
  }

  updateEmbeddedCodes(previousEmbeddedCodes) {
    const previousEmbeddedCodeMap = new Map(
      (Array.isArray(previousEmbeddedCodes) ? previousEmbeddedCodes : []).map((embeddedCode) => [embeddedCode.id, embeddedCode])
    );
    this.embeddedCodes = buildEmbeddedCodes(this.filePath, this.languageId, this.text, previousEmbeddedCodeMap);
  }

  getText() {
    return this.text;
  }

  getSnapshot() {
    return this.snapshot;
  }

  getEmbeddedCodes() {
    return this.embeddedCodes.slice();
  }
}

function createVirtualCode(uri, languageId, version, text) {
  return new PocketPagesVirtualCode({ uri, languageId, version, text });
}

function updateVirtualCode(virtualCode, version, text, languageId) {
  return virtualCode.update({ version, text, languageId });
}

module.exports = {
  PocketPagesVirtualCode,
  createVirtualCode,
  updateVirtualCode,
};
