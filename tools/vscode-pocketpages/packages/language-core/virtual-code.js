"use strict";

const path = require("path");
const { URI } = require("vscode-uri");
const { extractServerBlocks } = require("./script-server");
const { buildTemplateVirtualText, extractTemplateCodeBlocks } = require("./ejs-template");
const { collectPathContexts } = require("./custom-context");
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
  references: true,
  rename: true,
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

function hashText(text) {
  const value = String(text || "");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeVirtualIdPart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48) || "0";
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

function createPreviousServerBlockMatcher(previousEmbeddedCodes) {
  const previousServerCodes = (Array.isArray(previousEmbeddedCodes) ? previousEmbeddedCodes : [])
    .filter((embeddedCode) => embeddedCode && embeddedCode.kind === "server-script");
  const usedPreviousIds = new Set();
  const byContentHash = new Map();
  const byBlockIndex = new Map();

  for (const embeddedCode of previousServerCodes) {
    const metadata = embeddedCode.metadata || {};
    const contentHash = metadata.contentHash;
    if (contentHash) {
      if (!byContentHash.has(contentHash)) {
        byContentHash.set(contentHash, []);
      }
      byContentHash.get(contentHash).push(embeddedCode);
    }

    if (typeof metadata.blockIndex === "number") {
      byBlockIndex.set(metadata.blockIndex, embeddedCode);
    }
  }

  function takeCandidate(candidates, block) {
    const available = (candidates || []).filter((candidate) => !usedPreviousIds.has(candidate.id));
    if (!available.length) {
      return null;
    }

    available.sort((left, right) => {
      const leftDistance = Math.abs(((left.metadata || {}).sourceStart || 0) - block.contentStart);
      const rightDistance = Math.abs(((right.metadata || {}).sourceStart || 0) - block.contentStart);
      return leftDistance - rightDistance;
    });

    const selected = available[0];
    usedPreviousIds.add(selected.id);
    return selected;
  }

  return {
    matchByContent(block, contentHash) {
      return takeCandidate(byContentHash.get(contentHash), block);
    },
    matchByIndex(block) {
      return takeCandidate([byBlockIndex.get(block.index)].filter(Boolean), block);
    },
  };
}

function createPreviousTemplateBlockMatcher(previousTemplateCode) {
  const previousBlocks =
    previousTemplateCode &&
    previousTemplateCode.metadata &&
    Array.isArray(previousTemplateCode.metadata.templateRegionBlocks)
      ? previousTemplateCode.metadata.templateRegionBlocks
      : [];
  const usedPreviousIndexes = new Set();
  const byContentHash = new Map();
  const byBlockIndex = new Map();

  for (const block of previousBlocks) {
    if (block.contentHash) {
      if (!byContentHash.has(block.contentHash)) {
        byContentHash.set(block.contentHash, []);
      }
      byContentHash.get(block.contentHash).push(block);
    }

    if (typeof block.blockIndex === "number") {
      byBlockIndex.set(block.blockIndex, block);
    }
  }

  function takeCandidate(candidates, currentBlock) {
    const available = (candidates || []).filter((candidate) => !usedPreviousIndexes.has(candidate.blockIndex));
    if (!available.length) {
      return null;
    }

    available.sort((left, right) => {
      const leftDistance = Math.abs((left.sourceStart || 0) - currentBlock.contentStart);
      const rightDistance = Math.abs((right.sourceStart || 0) - currentBlock.contentStart);
      return leftDistance - rightDistance;
    });

    const selected = available[0];
    usedPreviousIndexes.add(selected.blockIndex);
    return selected;
  }

  return {
    matchByContent(block, contentHash) {
      return takeCandidate(byContentHash.get(contentHash), block);
    },
    matchByIndex(block) {
      return takeCandidate([byBlockIndex.get(block.index)].filter(Boolean), block);
    },
  };
}

function createEmptyRegionGraph(documentLength = 0) {
  return {
    documentLength,
    regions: [],
  };
}

function buildEmbeddedCodes(filePath, languageId, text, previousEmbeddedCodes) {
  if (normalizeLanguageId(languageId, filePath) !== "ejs") {
    return {
      embeddedCodes: [],
      regionGraph: createEmptyRegionGraph(String(text || "").length),
    };
  }

  const embeddedCodes = [];
  const regions = [];
  const previousEmbeddedCodeMap = new Map(
    (Array.isArray(previousEmbeddedCodes) ? previousEmbeddedCodes : []).map((embeddedCode) => [embeddedCode.id, embeddedCode])
  );
  const previousServerBlockMatcher = createPreviousServerBlockMatcher(previousEmbeddedCodes);
  const serverBlocks = extractServerBlocks(text);
  const serverBlockEntries = serverBlocks.map((block) => {
    const contentHash = hashText(block.content);
    return {
      block,
      contentHash,
      previousServerCode: previousServerBlockMatcher.matchByContent(block, contentHash),
    };
  });
  for (const entry of serverBlockEntries) {
    if (!entry.previousServerCode) {
      entry.previousServerCode = previousServerBlockMatcher.matchByIndex(entry.block);
    }
  }
  for (const { block, contentHash, previousServerCode } of serverBlockEntries) {
    const stableId = sanitizeVirtualIdPart(
      previousServerCode && previousServerCode.metadata && previousServerCode.metadata.stableId
        ? previousServerCode.metadata.stableId
        : `${contentHash}_${block.index}`
    );
    const id = `server:${stableId}`;
    const previousContentHash =
      previousServerCode && previousServerCode.metadata
        ? previousServerCode.metadata.contentHash
        : null;
    const dirty = previousContentHash !== contentHash;
    regions.push({
      kind: "server-script",
      id,
      stableId,
      blockIndex: block.index,
      contentHash,
      dirty,
      sourceStart: block.contentStart,
      sourceEnd: block.contentEnd,
      fullStart: block.fullStart,
      fullEnd: block.fullEnd,
    });
    embeddedCodes.push(
      createEmbeddedCode({
        id,
        kind: "server-script",
        languageId: "typescript",
        text: block.content,
        previous: previousEmbeddedCodeMap.get(id) || previousServerCode,
        mappings: createSegmentMappings({
          sourceBaseOffset: block.contentStart,
          generatedBaseOffset: 0,
          length: block.content.length,
          defaultData: SERVER_SCRIPT_CODE_INFORMATION,
          specialRanges: toPathLiteralRanges(block.content),
        }),
        metadata: {
          blockIndex: block.index,
          stableId,
          contentHash,
          sourceStart: block.contentStart,
          sourceEnd: block.contentEnd,
          fullStart: block.fullStart,
          fullEnd: block.fullEnd,
          regionKind: "server-script",
          regionId: id,
          dirty,
        },
      })
    );
  }

  const templateBlocks = extractTemplateCodeBlocks(text);
  if (templateBlocks.length || serverBlocks.length) {
    const templateVirtualText = buildTemplateVirtualText(text);
    const templateVirtualTextHash = hashText(templateVirtualText);
    const previousTemplateCode = previousEmbeddedCodeMap.get("template");
    const previousTemplateMetadata = previousTemplateCode && previousTemplateCode.metadata
      ? previousTemplateCode.metadata
      : null;
    const previousTemplateBlockMatcher = createPreviousTemplateBlockMatcher(previousTemplateCode);
    const templateRegionBlockEntries = templateBlocks.map((block) => {
      const contentHash = hashText(block.content);
      return {
        block,
        contentHash,
        previousTemplateBlock: previousTemplateBlockMatcher.matchByContent(block, contentHash),
      };
    });
    for (const entry of templateRegionBlockEntries) {
      if (!entry.previousTemplateBlock) {
        entry.previousTemplateBlock = previousTemplateBlockMatcher.matchByIndex(entry.block);
      }
    }
    const templateRegionBlocks = [];
    const templateDirty =
      !previousTemplateMetadata ||
      previousTemplateMetadata.virtualTextHash !== templateVirtualTextHash ||
      previousTemplateMetadata.documentLength !== text.length;
    const templateMappings = [];
    for (const { block, contentHash, previousTemplateBlock } of templateRegionBlockEntries) {
      const stableId = sanitizeVirtualIdPart(
        previousTemplateBlock && previousTemplateBlock.stableId
          ? previousTemplateBlock.stableId
          : `${contentHash}_${block.index}`
      );
      const previousContentHash = previousTemplateBlock
        ? previousTemplateBlock.contentHash
        : null;
      const dirty = previousContentHash !== contentHash;
      const templateRegionBlock = {
        kind: "template-block",
        id: `template:${stableId}`,
        parentId: "template",
        stableId,
        blockIndex: block.index,
        contentHash,
        dirty,
        sourceStart: block.contentStart,
        sourceEnd: block.contentEnd,
        fullStart: block.fullStart,
        fullEnd: block.fullEnd,
      };
      templateRegionBlocks.push(templateRegionBlock);
      regions.push(templateRegionBlock);
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

    regions.push({
      kind: "template",
      id: "template",
      virtualTextHash: templateVirtualTextHash,
      dirty: templateDirty,
      documentLength: text.length,
      templateBlockCount: templateBlocks.length,
      serverBlockCount: serverBlocks.length,
    });

    embeddedCodes.push(
      createEmbeddedCode({
        id: "template",
        kind: "template",
        languageId: "typescript",
        text: templateVirtualText,
        previous: previousTemplateCode,
        mappings: templateMappings,
        metadata: {
          templateBlocks,
          serverBlocks,
          templateRegionBlocks,
          virtualTextHash: templateVirtualTextHash,
          documentLength: text.length,
          regionKind: "template",
          regionId: "template",
          dirty: templateDirty,
        },
      })
    );
  }

  return {
    embeddedCodes,
    regionGraph: {
      documentLength: text.length,
      regions,
    },
  };
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
    this.regionGraph = createEmptyRegionGraph(this.text.length);
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
    const result = buildEmbeddedCodes(this.filePath, this.languageId, this.text, previousEmbeddedCodes);
    this.embeddedCodes = result.embeddedCodes;
    this.regionGraph = result.regionGraph || createEmptyRegionGraph(this.text.length);
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

  getRegionGraph() {
    return {
      documentLength: this.regionGraph.documentLength,
      regions: this.regionGraph.regions.slice(),
    };
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
