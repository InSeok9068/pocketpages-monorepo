"use strict";

const path = require("path");
const { URI } = require("vscode-uri");
const { extractServerBlocks } = require("../script-server");
const { buildTemplateVirtualText, extractTemplateCodeBlocks } = require("../ejs-template");
const { collectPathContexts } = require("../custom-context");
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

function createCodeInformation(overrides = {}) {
  return {
    verification: false,
    completion: false,
    semantic: false,
    navigation: false,
    structure: false,
    format: false,
    references: false,
    rename: false,
    hover: false,
    ...overrides,
  };
}

const ROOT_CODE_INFORMATION = createCodeInformation({
  semantic: true,
  structure: true,
  format: true,
});

const SERVER_SCRIPT_CODE_INFORMATION = createCodeInformation({
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
  references: true,
  rename: true,
  hover: true,
});

const TEMPLATE_CODE_INFORMATION = createCodeInformation({
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
  hover: true,
});

const PATH_LITERAL_CODE_INFORMATION = createCodeInformation({
  verification: true,
  completion: false,
  semantic: false,
  navigation: false,
  structure: false,
  format: false,
  references: false,
  rename: false,
  hover: false,
});

function compareRanges(left, right) {
  if (left.start !== right.start) {
    return left.start - right.start;
  }

  return left.end - right.end;
}

function clampRangeToBounds(range, lowerBound, upperBound) {
  const start = Math.max(lowerBound, Math.min(upperBound, range.start));
  const end = Math.max(lowerBound, Math.min(upperBound, range.end));
  if (end <= start) {
    return null;
  }

  return {
    start,
    end,
  };
}

function mergeRanges(ranges) {
  const sortedRanges = ranges
    .map((range) => ({
      start: Number(range.start) || 0,
      end: Number(range.end) || 0,
    }))
    .filter((range) => range.end > range.start)
    .sort(compareRanges);

  const mergedRanges = [];
  for (const range of sortedRanges) {
    const previousRange = mergedRanges[mergedRanges.length - 1];
    if (!previousRange || range.start > previousRange.end) {
      mergedRanges.push({ ...range });
      continue;
    }

    previousRange.end = Math.max(previousRange.end, range.end);
  }

  return mergedRanges;
}

function subtractRanges(start, end, exclusions) {
  if (end <= start) {
    return [];
  }

  const segments = [];
  let cursor = start;

  for (const exclusion of mergeRanges(exclusions)) {
    const boundedExclusion = clampRangeToBounds(exclusion, start, end);
    if (!boundedExclusion) {
      continue;
    }

    if (cursor < boundedExclusion.start) {
      segments.push({
        start: cursor,
        end: boundedExclusion.start,
      });
    }

    cursor = Math.max(cursor, boundedExclusion.end);
  }

  if (cursor < end) {
    segments.push({
      start: cursor,
      end,
    });
  }

  return segments;
}

function toPathLiteralRanges(text, rangeOffset = 0) {
  return collectPathContexts(String(text || ""))
    .map((context) => ({
      start: rangeOffset + context.start,
      end: rangeOffset + context.end,
    }))
    .filter((range) => range.end > range.start);
}

function createSegmentMappings({
  sourceBaseOffset,
  generatedBaseOffset,
  length,
  defaultData,
  specialRanges = [],
}) {
  if (length <= 0) {
    return [];
  }

  const mappings = [];
  const normalizedSpecialRanges = specialRanges
    .map((range) => clampRangeToBounds(range, 0, length))
    .filter(Boolean);

  for (const segment of subtractRanges(0, length, normalizedSpecialRanges)) {
    mappings.push({
      sourceOffsets: [sourceBaseOffset + segment.start],
      generatedOffsets: [generatedBaseOffset + segment.start],
      lengths: [segment.end - segment.start],
      data: defaultData,
    });
  }

  for (const range of mergeRanges(normalizedSpecialRanges)) {
    mappings.push({
      sourceOffsets: [sourceBaseOffset + range.start],
      generatedOffsets: [generatedBaseOffset + range.start],
      lengths: [range.end - range.start],
      data: PATH_LITERAL_CODE_INFORMATION,
    });
  }

  return mappings.sort(
    (left, right) => left.generatedOffsets[0] - right.generatedOffsets[0]
  );
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
    associatedScriptMappings: new Map(),
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
        mappings: createSegmentMappings({
          sourceBaseOffset: block.contentStart,
          generatedBaseOffset: 0,
          length: block.content.length,
          defaultData: SERVER_SCRIPT_CODE_INFORMATION,
          specialRanges: toPathLiteralRanges(block.content),
        }),
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
    const templateMappings = [];
    for (const block of templateBlocks) {
      templateMappings.push(
        ...createSegmentMappings({
          sourceBaseOffset: block.contentStart,
          generatedBaseOffset: block.contentStart,
          length: block.content.length,
          defaultData: TEMPLATE_CODE_INFORMATION,
          specialRanges: toPathLiteralRanges(block.content),
        })
      );
    }

    embeddedCodes.push(
      createEmbeddedCode({
        id: "template",
        kind: "template",
        languageId: "typescript",
        text: templateVirtualText,
        previous: previousEmbeddedCodeMap.get("template"),
        mappings: templateMappings,
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
    this.mappings = createIdentityMapping(this.text.length, ROOT_CODE_INFORMATION);
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
    this.mappings = createIdentityMapping(this.text.length, ROOT_CODE_INFORMATION);
    this.updateEmbeddedCodes(previousEmbeddedCodes);
    return this;
  }

  updateEmbeddedCodes(previousEmbeddedCodes) {
    const previousEmbeddedCodeMap = new Map(
      (Array.isArray(previousEmbeddedCodes) ? previousEmbeddedCodes : []).map((embeddedCode) => [embeddedCode.id, embeddedCode])
    );
    this.embeddedCodes = buildEmbeddedCodes(this.filePath, this.languageId, this.text, previousEmbeddedCodeMap);
    this.associatedScriptMappings = new Map();

    for (const embeddedCode of this.embeddedCodes) {
      const linkedMappings = Array.isArray(embeddedCode.mappings)
        ? embeddedCode.mappings
        : [];
      if (!linkedMappings.length) {
        continue;
      }

      this.associatedScriptMappings.set(embeddedCode.id, linkedMappings);
      if (!(embeddedCode.associatedScriptMappings instanceof Map)) {
        embeddedCode.associatedScriptMappings = new Map();
      }
      embeddedCode.associatedScriptMappings.set("root", linkedMappings);
    }
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
