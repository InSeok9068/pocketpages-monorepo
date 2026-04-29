"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { URI } = require("vscode-uri");
const { createVirtualCode } = require("../language-core/virtual-code");
const {
  buildTemplateVirtualText,
  extractTemplateCodeBlocks: _extractTemplateCodeBlocks,
  getTemplateCodeBlockAtOffset,
} = require("../language-core/ejs-template");
const { extractServerBlocks: _extractServerBlocks, getServerBlockAtOffset } = require("../language-core/script-server");
const { PocketPagesProjectIndex, POCKETPAGES_GLOBAL_NAMES, collectIncludeCallEntries } = require("./project-index");
const { createDocumentAnalysis, createSourceFileForText } = require("./document-analysis");
const {
  collectResolveRequestPaths,
  collectPathContexts,
  collectResolvedModuleMemberContexts,
  collectSchemaContexts,
  getPathContextAtOffset,
  getResolvedModuleMemberContext,
  getScriptCollectionContext,
  getScriptFieldContext,
  getScriptSchemaContextAtOffset,
} = require("../language-core/custom-context");
const { collectParamsFlowDiagnostics } = require("./flow-analysis");
const { createCompletionFeatureHandlers } = require("./features/completion-features");
const { createDiagnosticsFeatureHandlers } = require("./features/diagnostics-features");
const { createNavigationFeatureHandlers } = require("./features/navigation-features");
const { DocumentSnapshotManager } = require("./document-snapshot-manager");
const { createPocketPagesLanguageServiceManager } = require("./service-manager");

const COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: true,
  strict: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2015,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  allowSyntheticDefaultImports: true,
  useUnknownInCatchVariables: false,
  maxNodeModuleJsDepth: 2,
};

function normalizePath(filePath) {
  const normalizedPath = path.resolve(filePath).replace(/\\/g, "/");
  return normalizedPath.replace(/^[A-Z]:/, (value) => value.toLowerCase());
}

function toReferencePath(filePath) {
  return normalizePath(filePath).replace(/\\/g, "/");
}

function toPortablePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function readFileText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function hashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getMappingSegments(mappings) {
  if (!Array.isArray(mappings)) {
    return [];
  }

  const segments = [];
  for (const mapping of mappings) {
    if (
      !mapping ||
      !Array.isArray(mapping.sourceOffsets) ||
      !Array.isArray(mapping.generatedOffsets) ||
      !Array.isArray(mapping.lengths)
    ) {
      continue;
    }

    const segmentCount = Math.min(
      mapping.sourceOffsets.length,
      mapping.generatedOffsets.length,
      mapping.lengths.length
    );
    for (let index = 0; index < segmentCount; index += 1) {
      const sourceStart = Number(mapping.sourceOffsets[index]);
      const generatedStart = Number(mapping.generatedOffsets[index]);
      const length = Number(mapping.lengths[index]);
      if (!Number.isFinite(sourceStart) || !Number.isFinite(generatedStart) || !Number.isFinite(length) || length <= 0) {
        continue;
      }

      segments.push({
        sourceStart,
        sourceEnd: sourceStart + length,
        generatedStart,
        generatedEnd: generatedStart + length,
      });
    }
  }

  return segments.sort((left, right) => {
    if (left.generatedStart !== right.generatedStart) {
      return left.generatedStart - right.generatedStart;
    }

    return left.sourceStart - right.sourceStart;
  });
}

function mapGeneratedOffsetToSourceOffset(mappings, generatedOffset) {
  if (!Number.isFinite(generatedOffset) || generatedOffset < 0) {
    return null;
  }

  const segments = getMappingSegments(mappings);
  for (const segment of segments) {
    if (
      generatedOffset < segment.generatedStart ||
      generatedOffset > segment.generatedEnd
    ) {
      continue;
    }

    return segment.sourceStart + Math.min(generatedOffset - segment.generatedStart, segment.sourceEnd - segment.sourceStart);
  }

  return null;
}

function isEjsFile(filePath) {
  return path.extname(String(filePath || "")).toLowerCase() === ".ejs";
}

function isScriptFile(filePath) {
  return [".js", ".cjs", ".mjs"].includes(path.extname(String(filePath || "")).toLowerCase());
}

function isPrivatePagesFile(filePath) {
  const normalizedPath = normalizePath(filePath);
  const pagesMarker = "/pb_hooks/pages/";
  const markerIndex = normalizedPath.indexOf(pagesMarker);
  if (markerIndex === -1) {
    return false;
  }

  return normalizedPath
    .slice(markerIndex + pagesMarker.length)
    .split("/")
    .includes("_private");
}

function stripKnownExtension(filePath, extensions) {
  for (const extension of extensions) {
    if (filePath.endsWith(extension)) {
      return filePath.slice(0, -extension.length);
    }
  }

  return filePath;
}

function getScriptFileBasename(filePath) {
  return stripKnownExtension(path.basename(String(filePath || "")), [".js", ".cjs", ".mjs"]);
}

function isMiddlewareScriptFile(filePath) {
  return isScriptFile(filePath) && getScriptFileBasename(filePath) === "+middleware";
}

function isRedirectControlScriptFile(filePath) {
  if (!isScriptFile(filePath)) {
    return false;
  }

  const basename = getScriptFileBasename(filePath);
  return basename.startsWith("+") && basename !== "+config";
}

function isSameOrChildPath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toRelativeSpecifier(relativePath, options = {}) {
  const normalizedPath = toPortablePath(relativePath);
  if (!normalizedPath || normalizedPath === ".") {
    return options.leadingDot ? "./" : "";
  }

  if (options.leadingDot && !normalizedPath.startsWith(".")) {
    return `./${normalizedPath}`;
  }

  return normalizedPath;
}

function toRequirePathRangeFromStringLiteral(node, sourceFile, offsetBase = 0) {
  if (!ts.isStringLiteralLike(node)) {
    return null;
  }

  return {
    start: offsetBase + node.getStart(sourceFile) + 1,
    end: offsetBase + node.getEnd() - 1,
    value: node.text,
  };
}

function getHooksTemplateRequireContext(node, sourceFile, offsetBase = 0) {
  if (!ts.isTemplateExpression(node) || node.templateSpans.length !== 1) {
    return null;
  }
  if (node.head.text !== "") {
    return null;
  }

  const [templateSpan] = node.templateSpans;
  const expressionTarget = skipExpressionWrappers(templateSpan.expression);
  if (!expressionTarget || !ts.isIdentifier(expressionTarget) || expressionTarget.text !== "__hooks") {
    return null;
  }

  const nodeStart = node.getStart(sourceFile);
  const nodeEnd = node.getEnd();
  if (nodeEnd <= nodeStart + 1) {
    return null;
  }

  const nodeText = sourceFile.text.slice(nodeStart, nodeEnd);
  const closeBraceIndex = nodeText.indexOf("}");
  if (closeBraceIndex === -1) {
    return null;
  }

  const start = offsetBase + nodeStart + closeBraceIndex + 1;
  const end = offsetBase + nodeEnd - 1;
  return {
    kind: "require-path",
    value: sourceFile.text.slice(nodeStart + closeBraceIndex + 1, nodeEnd - 1),
    start,
    end,
    rootKind: "__hooks",
  };
}

function getHooksConcatRequireContext(node, sourceFile, offsetBase = 0) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
    return null;
  }

  const leftTarget = skipExpressionWrappers(node.left);
  const rightTarget = skipExpressionWrappers(node.right);
  if (!leftTarget || !ts.isIdentifier(leftTarget) || leftTarget.text !== "__hooks") {
    return null;
  }
  if (!rightTarget || !ts.isStringLiteralLike(rightTarget)) {
    return null;
  }

  const range = toRequirePathRangeFromStringLiteral(rightTarget, sourceFile, offsetBase);
  if (!range) {
    return null;
  }

  return {
    kind: "require-path",
    value: range.value,
    start: range.start,
    end: range.end,
    rootKind: "__hooks",
  };
}

function getStaticRequireContextFromArgument(argument, sourceFile, offsetBase = 0) {
  const target = skipExpressionWrappers(argument);
  if (!target) {
    return null;
  }

  if (ts.isStringLiteralLike(target)) {
    const range = toRequirePathRangeFromStringLiteral(target, sourceFile, offsetBase);
    return range
      ? {
          kind: "require-path",
          value: range.value,
          start: range.start,
          end: range.end,
        }
      : null;
  }

  return getHooksTemplateRequireContext(target, sourceFile, offsetBase)
    || getHooksConcatRequireContext(target, sourceFile, offsetBase);
}

function getStaticRequireSearchSegments(documentText, options = {}) {
  const text = String(documentText || "");
  const filePath = typeof options.filePath === "string" ? options.filePath : "";
  if (!filePath || !isEjsFile(filePath)) {
    return [{ text, offsetBase: 0 }];
  }

  return [..._extractServerBlocks(text), ..._extractTemplateCodeBlocks(text)]
    .map((block) => ({
      text: block.content,
      offsetBase: block.contentStart,
    }))
    .sort((left, right) => left.offsetBase - right.offsetBase);
}

function collectStaticRequireCallContexts(documentText, options = {}) {
  const contexts = [];
  const seen = new Set();

  for (const segment of getStaticRequireSearchSegments(documentText, options)) {
    const sourceFile = createSourceFileForText("pocketpages-static-require.js", segment.text);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isIdentifier(skipExpressionWrappers(node.expression)) &&
        skipExpressionWrappers(node.expression).text === "require"
      ) {
        const context = getStaticRequireContextFromArgument(node.arguments[0], sourceFile, segment.offsetBase);
        if (context) {
          const contextKey = `${context.start}:${context.end}:${context.rootKind || ""}:${context.value}`;
          if (!seen.has(contextKey)) {
            seen.add(contextKey);
            contexts.push(context);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return contexts;
}

function getRequirePathContextAtOffset(documentText, offset, options = {}) {
  for (const context of collectStaticRequireCallContexts(documentText, options)) {
    if (offset >= context.start && offset <= context.end) {
      return context;
    }
  }

  return null;
}

function getAppAmbientTypeFiles(appRoot) {
  return [
    path.join(appRoot, "pb_data", "types.d.ts"),
    path.join(appRoot, "pocketpages-globals.d.ts"),
    path.join(appRoot, "types.d.ts"),
  ];
}

function toAnalysisText(filePath, documentText) {
  return isEjsFile(filePath) ? buildTemplateVirtualText(documentText) : documentText;
}

function getAnalysisContextAtOffset(filePath, documentText, offset) {
  let analysisText = documentText;
  let analysisOffset = offset;
  let analysisStart = 0;

  if (!isScriptFile(filePath)) {
    const block = getServerBlockAtOffset(documentText, offset);
    const templateCodeBlock = getTemplateCodeBlockAtOffset(documentText, offset);
    if (!block && !templateCodeBlock) {
      return null;
    }

    analysisText = block ? block.content : buildTemplateVirtualText(documentText);
    analysisOffset = block ? offset - block.contentStart : offset;
    analysisStart = block ? block.contentStart : 0;
  }

  return {
    analysisText,
    analysisOffset,
    analysisStart,
  };
}

function isValidIdentifierName(value) {
  return ts.isIdentifierText(String(value || ""), ts.ScriptTarget.Latest, ts.LanguageVariant.Standard);
}

function findAppRoot(filePath) {
  let currentDir = path.dirname(normalizePath(filePath));

  while (true) {
    const hasPages = directoryExists(path.join(currentDir, "pb_hooks", "pages"));
    if (hasPages) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function getSourceAdjacentVirtualFilePath(filePath, suffix) {
  return normalizePath(`${normalizePath(filePath)}.__${suffix}.ts`);
}

function toTypedRequireImportSpecifier(context) {
  if (!context || context.kind !== "require-path" || context.rootKind) {
    return null;
  }

  return context.value ? String(context.value) : null;
}

function flattenDiagnosticMessage(messageText) {
  if (typeof messageText === "string") {
    return messageText;
  }

  const parts = [];
  let current = messageText;

  while (current) {
    parts.push(current.messageText);
    current = current.next || null;
  }

  return parts.join("\n");
}

function elapsedMilliseconds(startTime) {
  return Number(process.hrtime.bigint() - startTime) / 1e6;
}

const EJS_IN_SCRIPT_RE = /<%(?![%#])[_=-]?[\s\S]*?[-_]?%>/g;
const JAVASCRIPT_MIME_TYPES = new Set([
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

function isHtmlNameChar(char) {
  return /[A-Za-z0-9:_-]/.test(String(char || ""));
}

function skipEjsTag(text, startIndex) {
  const closeIndex = String(text || "").indexOf("%>", startIndex + 2);
  if (closeIndex === -1) {
    return text.length;
  }

  return closeIndex + 2;
}

function findScriptOpenTagEnd(text, startIndex) {
  let quote = "";
  let cursor = startIndex + "<script".length;

  while (cursor < text.length) {
    const currentChar = text.charAt(cursor);

    if (quote) {
      if (currentChar === quote) {
        quote = "";
      }
      cursor += 1;
      continue;
    }

    if (currentChar === '"' || currentChar === "'") {
      quote = currentChar;
      cursor += 1;
      continue;
    }

    if (currentChar === "<" && text.slice(cursor, cursor + 2) === "<%") {
      cursor = skipEjsTag(text, cursor);
      continue;
    }

    if (currentChar === ">") {
      return cursor;
    }

    cursor += 1;
  }

  return -1;
}

function findScriptCloseTag(text, startIndex) {
  const lowerText = String(text || "").toLowerCase();
  let cursor = startIndex;

  while (cursor < text.length) {
    const closeStart = lowerText.indexOf("</script", cursor);
    if (closeStart === -1) {
      return null;
    }

    const nextChar = text.charAt(closeStart + "</script".length);
    if (nextChar && isHtmlNameChar(nextChar)) {
      cursor = closeStart + "</script".length;
      continue;
    }

    const closeTagEnd = text.indexOf(">", closeStart + "</script".length);
    if (closeTagEnd === -1) {
      return null;
    }

    return {
      start: closeStart,
      end: closeTagEnd + 1,
    };
  }

  return null;
}

function extractClientScriptBlocks(text) {
  const sourceText = String(text || "");
  const lowerText = sourceText.toLowerCase();
  const blocks = [];
  let cursor = 0;

  while (cursor < sourceText.length) {
    const scriptStart = lowerText.indexOf("<script", cursor);
    let openTagEnd = -1;
    let closeTag = null;
    let attributesText = "";
    let contentStart = 0;
    let contentEnd = 0;
    let nextChar = "";

    if (scriptStart === -1) {
      break;
    }

    nextChar = sourceText.charAt(scriptStart + "<script".length);
    if (nextChar && isHtmlNameChar(nextChar)) {
      cursor = scriptStart + "<script".length;
      continue;
    }

    openTagEnd = findScriptOpenTagEnd(sourceText, scriptStart);
    if (openTagEnd === -1) {
      break;
    }

    attributesText = sourceText.slice(scriptStart + "<script".length, openTagEnd);
    contentStart = openTagEnd + 1;
    closeTag = findScriptCloseTag(sourceText, contentStart);

    if (!closeTag) {
      break;
    }

    contentEnd = closeTag.start;

    if (shouldCheckClientScriptBlock(attributesText)) {
      blocks.push({
        index: blocks.length,
        fullStart: scriptStart,
        fullEnd: closeTag.end,
        contentStart,
        contentEnd,
        content: sourceText.slice(contentStart, contentEnd),
      });
    }

    cursor = closeTag.end;
  }

  return blocks;
}

function shouldCheckClientScriptBlock(attributesText) {
  const attributes = String(attributesText || "");
  const srcMatch = attributes.match(/\bsrc\s*=\s*(['"])([\s\S]*?)\1/i);
  if (srcMatch && String(srcMatch[2] || "").trim()) {
    return false;
  }

  const typeMatch = attributes.match(/\btype\s*=\s*(['"])([\s\S]*?)\1/i);
  if (!typeMatch) {
    return true;
  }

  const typeValue = String(typeMatch[2] || "").trim().toLowerCase();
  return typeValue === "module" || JAVASCRIPT_MIME_TYPES.has(typeValue);
}

function sanitizeClientScriptContent(scriptText) {
  return String(scriptText || "").replace(EJS_IN_SCRIPT_RE, (match) =>
    match.replace(/[^\r\n]/g, " ")
  );
}

function collectClientScriptSyntacticDiagnostics(documentText) {
  const diagnostics = [];

  for (const block of extractClientScriptBlocks(documentText)) {
    const sanitizedText = sanitizeClientScriptContent(block.content);
    const sourceFile = ts.createSourceFile(
      "pocketpages-client-script.js",
      sanitizedText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );

    for (const diagnostic of sourceFile.parseDiagnostics || []) {
      if (typeof diagnostic.start !== "number" || typeof diagnostic.length !== "number") {
        continue;
      }

      diagnostics.push({
        code: diagnostic.code,
        category: diagnostic.category,
        message: flattenDiagnosticMessage(diagnostic.messageText),
        start: block.contentStart + diagnostic.start,
        end: block.contentStart + diagnostic.start + diagnostic.length,
      });
    }
  }

  return diagnostics;
}

function toDisplayParts(text, kind = "text") {
  return [{ text: String(text || ""), kind }];
}

function stripUndefinedFromTypeText(typeText) {
  return String(typeText || "")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part && part !== "undefined")
    .join(" | ") || "any";
}

function mergeTypeTexts(typeTexts) {
  const uniqueTypes = [...new Set((Array.isArray(typeTexts) ? typeTexts : []).filter(Boolean))];
  if (!uniqueTypes.length) {
    return "any";
  }

  if (uniqueTypes.includes("any")) {
    return "any";
  }

  return uniqueTypes.sort().join(" | ");
}

function getLineAndCharacterFromText(text, offset) {
  const sourceFile = ts.createSourceFile("pocketpages-offset-map.ts", String(text || ""), ts.ScriptTarget.Latest, true);
  return sourceFile.getLineAndCharacterOfPosition(offset);
}

function findNarrowestNodeAtOffset(node, offset) {
  if (!node || offset < node.getFullStart() || offset > node.getEnd()) {
    return null;
  }

  let best = node;
  node.forEachChild((child) => {
    const candidate = findNarrowestNodeAtOffset(child, offset);
    if (candidate) {
      best = candidate;
    }
  });

  return best;
}

function findNarrowestNodeForSpan(node, sourceFile, start, end) {
  if (!node || start < node.getFullStart() || end > node.getEnd()) {
    return null;
  }

  let best = null;
  node.forEachChild((child) => {
    const candidate = findNarrowestNodeForSpan(child, sourceFile, start, end);
    if (candidate) {
      best = candidate;
    }
  });

  if (best) {
    return best;
  }

  return node.getStart(sourceFile) === start && node.getEnd() === end ? node : null;
}

function skipParenthesizedExpression(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isBodyLikeCallExpression(node) {
  const target = skipParenthesizedExpression(node);
  return (
    !!target &&
    ts.isCallExpression(target) &&
    target.arguments.length === 0 &&
    ts.isIdentifier(target.expression) &&
    (target.expression.text === "body" || target.expression.text === "formData")
  );
}

function collectBindingPatternSpans(bindingPattern, sourceFile, spans) {
  for (const element of bindingPattern.elements) {
    if (ts.isIdentifier(element.name)) {
      spans.push({
        start: element.name.getStart(sourceFile),
        end: element.name.getEnd(),
      });
      continue;
    }

    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      collectBindingPatternSpans(element.name, sourceFile, spans);
    }
  }
}

function collectRelaxedBodyDiagnosticSpans(scriptText, options = {}) {
  const sourceFile = options.sourceFile || createSourceFileForText("pocketpages-body-relaxation.ts", scriptText);
  const aliasNames = new Set();
  const spans = [];

  const isRelaxedBodySource = (node) => {
    const target = skipParenthesizedExpression(node);
    return (
      isBodyLikeCallExpression(target) ||
      (!!target && ts.isIdentifier(target) && aliasNames.has(target.text))
    );
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isRelaxedBodySource(node.initializer)) {
        aliasNames.add(node.name.text);
      }

      if (
        (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) &&
        isRelaxedBodySource(node.initializer)
      ) {
        collectBindingPatternSpans(node.name, sourceFile, spans);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isRelaxedBodySource(node.right)
    ) {
      aliasNames.add(node.left.text);
    }

    if (ts.isPropertyAccessExpression(node) && isRelaxedBodySource(node.expression)) {
      spans.push({
        start: node.name.getStart(sourceFile),
        end: node.name.getEnd(),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return spans;
}

function shouldSuppressDiagnosticForRelaxedBodyAccess(diagnostic, block, relaxedSpans) {
  if (!diagnostic || diagnostic.code !== 2339 || typeof diagnostic.start !== "number" || typeof diagnostic.length !== "number") {
    return false;
  }

  const diagnosticStartInBlock = diagnostic.start - block.preludeLength;
  const diagnosticEndInBlock = diagnosticStartInBlock + diagnostic.length;

  if (diagnosticStartInBlock < 0) {
    return false;
  }

  return relaxedSpans.some((span) => diagnosticStartInBlock >= span.start && diagnosticEndInBlock <= span.end);
}

function collectResolveCallSpansFromScript(scriptText, options = {}) {
  const sourceFile = options.sourceFile || createSourceFileForText("pocketpages-private-resolve.ts", scriptText);
  const offsetBase = Number(options.offsetBase) || 0;
  const spans = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "resolve"
    ) {
      spans.push({
        start: offsetBase + node.expression.getStart(sourceFile),
        end: offsetBase + node.expression.getEnd(),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return spans;
}

function collectResolveCallSpansFromTemplate(documentText) {
  const spans = [];
  const text = String(documentText || "");
  const serverBlocks = _extractServerBlocks(text);
  const templateBlocks = _extractTemplateCodeBlocks(text)
    .filter((block) =>
      !serverBlocks.some((serverBlock) =>
        block.fullStart >= serverBlock.fullStart &&
        block.fullEnd <= serverBlock.fullEnd
      )
    );

  for (const block of [...serverBlocks, ...templateBlocks]) {
    spans.push(...collectResolveCallSpansFromScript(block.content, {
      offsetBase: block.contentStart,
    }));
  }

  return spans;
}

function skipExpressionWrappers(node) {
  let current = node;
  while (current) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }

    if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }

    break;
  }

  return current;
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftEnd >= rightStart && leftStart <= rightEnd;
}

function _getPropertyAccessChain(node) {
  const segments = [];
  let current = node;

  while (current && ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = skipExpressionWrappers(current.expression);
  }

  return {
    root: current,
    segments,
  };
}

function getObjectPropertyNameNode(property) {
  if (!property) {
    return null;
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }

  if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
    return property.name || null;
  }

  return null;
}

function readObjectPropertyName(property) {
  const nameNode = getObjectPropertyNameNode(property);
  if (!nameNode) {
    return null;
  }

  if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) {
    return String(nameNode.text);
  }

  return null;
}

function readStringLiteralText(node) {
  const target = skipExpressionWrappers(node);
  return target && ts.isStringLiteralLike(target) ? target.text : null;
}

function isModuleExportsTarget(node) {
  const target = skipExpressionWrappers(node);
  if (!target || !ts.isPropertyAccessExpression(target) || target.name.text !== "exports") {
    return false;
  }

  const root = skipExpressionWrappers(target.expression);
  return !!root && ts.isIdentifier(root) && root.text === "module";
}

function getTopLevelDeclarationsByName(sourceFile) {
  const declarations = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        declarations.set(declaration.name.text, declaration);
      }
    }
  }

  return declarations;
}

function resolveFunctionLikeNode(node, declarationsByName, seenNames = new Set()) {
  const target = skipExpressionWrappers(node);
  if (!target) {
    return null;
  }

  if (ts.isFunctionExpression(target) || ts.isArrowFunction(target) || ts.isFunctionDeclaration(target)) {
    return target;
  }

  if (!ts.isIdentifier(target) || seenNames.has(target.text)) {
    return null;
  }

  const declaration = declarationsByName.get(target.text);
  if (!declaration) {
    return null;
  }

  seenNames.add(target.text);

  if (ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }

  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return resolveFunctionLikeNode(declaration.initializer, declarationsByName, seenNames);
  }

  return null;
}

function getPrimaryExportedFunction(sourceFile) {
  const declarationsByName = getTopLevelDeclarationsByName(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) {
      continue;
    }

    const expression = skipExpressionWrappers(statement.expression);
    if (
      !expression ||
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !isModuleExportsTarget(expression.left)
    ) {
      continue;
    }

    const handlerFunction = resolveFunctionLikeNode(expression.right, declarationsByName);
    if (handlerFunction) {
      return handlerFunction;
    }
  }

  return null;
}

function walkFunctionLikeBody(functionNode, visit) {
  if (!functionNode || !functionNode.body) {
    return;
  }

  walkStatementContainer(functionNode.body, visit);
}

function walkStatementContainer(containerNode, visit) {
  if (!containerNode) {
    return;
  }

  const walk = (node) => {
    if (!node) {
      return;
    }

    if (node !== containerNode && ts.isFunctionLike(node)) {
      return;
    }

    visit(node);
    ts.forEachChild(node, walk);
  };

  walk(containerNode);
}

function getNextSiblingStatement(statement) {
  if (!statement || !statement.parent || !Array.isArray(statement.parent.statements)) {
    return null;
  }

  const statements = statement.parent.statements;
  const statementIndex = statements.indexOf(statement);
  if (statementIndex === -1) {
    return null;
  }

  for (let index = statementIndex + 1; index < statements.length; index += 1) {
    const candidate = statements[index];
    if (!candidate || ts.isEmptyStatement(candidate)) {
      continue;
    }

    return candidate;
  }

  return null;
}

function isRedirectCallExpression(node) {
  const target = skipExpressionWrappers(node);
  if (!target || !ts.isCallExpression(target)) {
    return false;
  }

  const callee = skipExpressionWrappers(target.expression);
  if (callee && ts.isIdentifier(callee)) {
    return callee.text === "redirect";
  }

  if (!callee || !ts.isPropertyAccessExpression(callee) || callee.name.text !== "redirect") {
    return false;
  }

  const root = skipExpressionWrappers(callee.expression);
  return !!root && ts.isIdentifier(root) && root.text === "api";
}

function isIdentifierCallExpression(node, identifierName) {
  const target = skipExpressionWrappers(node);
  return (
    !!target &&
    ts.isCallExpression(target) &&
    ts.isIdentifier(skipExpressionWrappers(target.expression)) &&
    skipExpressionWrappers(target.expression).text === identifierName
  );
}

function isEmptyObjectLiteralExpression(node) {
  const target = skipExpressionWrappers(node);
  return !!target && ts.isObjectLiteralExpression(target) && target.properties.length === 0;
}

function getRedirectControlStatementContainer(filePath, sourceFile, options = {}) {
  if (options.useTopLevelStatements) {
    return sourceFile;
  }

  if (!isRedirectControlScriptFile(filePath)) {
    return null;
  }

  const handlerFunction = getPrimaryExportedFunction(sourceFile);
  return handlerFunction ? handlerFunction.body : null;
}

function collectRedirectReturnDiagnostics(filePath, scriptText, options = {}) {
  const sourceFile = options.sourceFile || createSourceFileForText("pocketpages-redirect-control.ts", scriptText);
  const statementContainer = getRedirectControlStatementContainer(filePath, sourceFile, options);
  if (!statementContainer) {
    return [];
  }

  const offsetBase = typeof options.offsetBase === "number" ? options.offsetBase : 0;
  const diagnostics = [];
  walkStatementContainer(statementContainer, (node) => {
    if (!ts.isExpressionStatement(node) || !isRedirectCallExpression(node.expression)) {
      return;
    }

    const nextStatement = getNextSiblingStatement(node);
    if (nextStatement && ts.isReturnStatement(nextStatement)) {
      return;
    }

    diagnostics.push({
      code: "pp-redirect-missing-return",
      category: ts.DiagnosticCategory.Warning,
      message: "Return after redirect() so execution stops explicitly.",
      start: offsetBase + node.expression.getStart(sourceFile),
      end: offsetBase + node.expression.getEnd(),
    });
  });

  return diagnostics;
}

function collectMiddlewareNextDiagnostics(filePath, scriptText, options = {}) {
  if (!isMiddlewareScriptFile(filePath)) {
    return [];
  }

  const sourceFile = options.sourceFile || createSourceFileForText("pocketpages-middleware-next.ts", scriptText);
  const handlerFunction = getPrimaryExportedFunction(sourceFile);
  if (!handlerFunction || handlerFunction.parameters.length < 2 || !ts.isIdentifier(handlerFunction.parameters[1].name)) {
    return [];
  }

  const nextParameter = handlerFunction.parameters[1].name;
  const nextName = nextParameter.text;
  let hasNextCall = false;
  const diagnostics = [];

  walkFunctionLikeBody(handlerFunction, (node) => {
    if (isIdentifierCallExpression(node, nextName)) {
      hasNextCall = true;
    }

    if (!ts.isReturnStatement(node)) {
      return;
    }

    if (!node.expression) {
      diagnostics.push({
        code: "pp-middleware-next-bare-return",
        category: ts.DiagnosticCategory.Warning,
        message: "This +middleware.js branch returns before next() and does not send a response.",
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
      return;
    }

    if (!isEmptyObjectLiteralExpression(node.expression)) {
      return;
    }

    diagnostics.push({
      code: "pp-middleware-next-empty-return",
      category: ts.DiagnosticCategory.Warning,
      message: "Returning {} from +middleware.js with next stops the chain without sending a response.",
      start: node.getStart(sourceFile),
      end: node.getEnd(),
    });
  });

  if (!hasNextCall) {
    diagnostics.push({
      code: "pp-middleware-next-missing-call",
      category: ts.DiagnosticCategory.Warning,
      message: "+middleware.js declares next but never calls next(). Call next() to continue, or remove the next parameter.",
      start: nextParameter.getStart(sourceFile),
      end: nextParameter.getEnd(),
    });
  }

  return diagnostics;
}

function collectIncludeContextDiagnostics(scriptText, options = {}) {
  const sourceFile = options.sourceFile || createSourceFileForText("pocketpages-agents-include.ts", scriptText);
  const diagnostics = [];
  const forbiddenNames = new Set(["api", "request", "response", "resolve", "params", "data"]);

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "include" &&
      node.arguments.length > 1
    ) {
      const localsArgument = skipExpressionWrappers(node.arguments[1]);
      if (localsArgument && ts.isObjectLiteralExpression(localsArgument)) {
        for (const property of localsArgument.properties) {
          const propertyName = readObjectPropertyName(property);
          if (!propertyName || !forbiddenNames.has(propertyName)) {
            continue;
          }

          const nameNode = getObjectPropertyNameNode(property) || property;
          diagnostics.push({
            code: "pp-partial-full-context",
            category: ts.DiagnosticCategory.Warning,
            message: "Do not pass full PocketPages context to partials. Pass only the values the partial uses.",
            start: nameNode.getStart(sourceFile),
            end: nameNode.getEnd(),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
}

function normalizeRouteRequestPath(routePath) {
  let value = String(routePath || "").trim();
  if (!value || !value.startsWith("/")) {
    return null;
  }

  if (value.startsWith("//")) {
    return null;
  }

  const markerIndex = value.search(/[?#]/);
  if (markerIndex !== -1) {
    value = value.slice(0, markerIndex);
  }

  value = value.replace(/\/+/g, "/");
  if (value.length > 1) {
    value = value.replace(/\/+$/, "");
  }

  return value || "/";
}

function splitRoutePathSuffix(routePath) {
  const value = String(routePath || "");
  const markerIndex = value.search(/[?#]/);
  if (markerIndex === -1) {
    return {
      basePath: value,
      suffix: "",
    };
  }

  return {
    basePath: value.slice(0, markerIndex),
    suffix: value.slice(markerIndex),
  };
}

function isDynamicRoutePatternSegment(segment) {
  return /^\[(\.\.\.)?[^\]]+\]$/.test(String(segment || ""));
}

function isCatchAllDynamicRoutePatternSegment(segment) {
  return /^\[\.\.\.[^\]]+\]$/.test(String(segment || ""));
}

function splitNormalizedRouteRequestPath(routePath) {
  const normalizedRoutePath = normalizeRouteRequestPath(routePath);
  if (!normalizedRoutePath || normalizedRoutePath === "/") {
    return [];
  }

  return normalizedRoutePath.slice(1).split("/").filter(Boolean);
}

function getRouteRequestMatchState(routeSegments, requestSegments) {
  const normalizedRouteSegments = Array.isArray(routeSegments) ? routeSegments.filter(Boolean) : [];
  const normalizedRequestSegments = Array.isArray(requestSegments) ? requestSegments.filter(Boolean) : [];
  const dynamicValueGroups = [];
  let requestIndex = 0;
  let dynamicSegmentCount = 0;

  for (let routeIndex = 0; routeIndex < normalizedRouteSegments.length; routeIndex += 1) {
    const routeSegment = normalizedRouteSegments[routeIndex];

    if (isCatchAllDynamicRoutePatternSegment(routeSegment)) {
      if (routeIndex !== normalizedRouteSegments.length - 1) {
        return null;
      }

      dynamicSegmentCount += 1;
      dynamicValueGroups.push(normalizedRequestSegments.slice(requestIndex));
      requestIndex = normalizedRequestSegments.length;
      return {
        dynamicSegmentCount,
        dynamicValueGroups,
        segmentCount: normalizedRouteSegments.length,
      };
    }

    if (requestIndex >= normalizedRequestSegments.length) {
      return null;
    }

    const requestSegment = normalizedRequestSegments[requestIndex];
    if (isDynamicRoutePatternSegment(routeSegment)) {
      dynamicSegmentCount += 1;
      dynamicValueGroups.push([requestSegment]);
    } else if (routeSegment !== requestSegment) {
      return null;
    }

    requestIndex += 1;
  }

  if (requestIndex !== normalizedRequestSegments.length) {
    return null;
  }

  return {
    dynamicSegmentCount,
    dynamicValueGroups,
    segmentCount: normalizedRouteSegments.length,
  };
}

function buildConcreteRoutePathFromSegments(routeSegments, dynamicValueGroups) {
  const normalizedRouteSegments = Array.isArray(routeSegments) ? routeSegments.filter(Boolean) : [];
  const normalizedDynamicValueGroups = Array.isArray(dynamicValueGroups) ? dynamicValueGroups : [];
  const concreteSegments = [];
  let dynamicValueIndex = 0;

  for (const routeSegment of normalizedRouteSegments) {
    if (isCatchAllDynamicRoutePatternSegment(routeSegment)) {
      const valueGroup = normalizedDynamicValueGroups[dynamicValueIndex];
      if (!Array.isArray(valueGroup)) {
        return null;
      }

      for (const segment of valueGroup) {
        if (!segment) {
          continue;
        }
        concreteSegments.push(segment);
      }
      dynamicValueIndex += 1;
      continue;
    }

    if (isDynamicRoutePatternSegment(routeSegment)) {
      const valueGroup = normalizedDynamicValueGroups[dynamicValueIndex];
      if (!Array.isArray(valueGroup) || valueGroup.length !== 1 || !valueGroup[0]) {
        return null;
      }

      concreteSegments.push(valueGroup[0]);
      dynamicValueIndex += 1;
      continue;
    }

    concreteSegments.push(routeSegment);
  }

  if (dynamicValueIndex !== normalizedDynamicValueGroups.length) {
    return null;
  }

  return concreteSegments.length ? `/${concreteSegments.join("/")}` : "/";
}

function getPreferredRouteMethods(routeSource) {
  switch (String(routeSource || "").toLowerCase()) {
    case "action":
    case "hx-post":
      return ["POST", "GET"];
    case "hx-put":
      return ["PUT", "GET"];
    case "hx-delete":
      return ["DELETE", "GET"];
    case "hx-patch":
      return ["PATCH", "GET"];
    case "href":
    case "redirect":
    case "hx-get":
    default:
      return ["PAGE"];
  }
}

function normalizeRouteMethod(method) {
  const normalizedMethod = String(method || "PAGE").toUpperCase();
  return normalizedMethod || "PAGE";
}

function getPathContextLabel(context) {
  if (!context) {
    return "PocketPages path";
  }

  if (context.kind === "resolve-path") {
    return "resolve() path";
  }

  if (context.kind === "include-path") {
    return "include() path";
  }

  if (context.kind === "asset-path") {
    return "asset() path";
  }

  if (context.kind === "route-path") {
    return context.routeSource ? `${context.routeSource} path` : "route path";
  }

  return "PocketPages path";
}

function getComparablePathValue(context) {
  if (!context) {
    return "";
  }

  if (context.kind === "route-path") {
    return normalizeRouteRequestPath(context.value) || String(context.value || "").trim();
  }

  if (context.kind === "resolve-path") {
    return String(context.value || "").trim().replace(/^\/+/, "");
  }

  return String(context.value || "").trim();
}

function getPathContextCandidates(projectIndex, filePath, context) {
  if (!context) {
    return [];
  }

  if (context.kind === "resolve-path") {
    return projectIndex.getResolveCandidates(filePath, context.value);
  }

  if (context.kind === "include-path") {
    return projectIndex.getIncludeCandidates(filePath, context.value);
  }

  if (context.kind === "asset-path") {
    return projectIndex.getAssetCandidates(filePath);
  }

  if (context.kind === "route-path") {
    return projectIndex.getRouteCandidates({
      routeSource: context.routeSource,
    });
  }

  return [];
}

function computeLevenshteinDistance(leftText, rightText) {
  const left = String(leftText || "");
  const right = String(rightText || "");
  if (left === right) {
    return 0;
  }

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  const previous = new Array(right.length + 1);
  const current = new Array(right.length + 1);

  for (let index = 0; index <= right.length; index += 1) {
    previous[index] = index;
  }

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }

    for (let index = 0; index <= right.length; index += 1) {
      previous[index] = current[index];
    }
  }

  return previous[right.length];
}

function getBasenameLike(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

function getSuggestedPathCandidates(context, candidates, limit = 3) {
  const requestValue = getComparablePathValue(context);
  const normalizedRequest = requestValue.toLowerCase();
  if (!normalizedRequest) {
    return [];
  }

  const requestBaseName = getBasenameLike(normalizedRequest);
  const threshold = Math.max(2, Math.ceil(normalizedRequest.length * 0.2));

  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const candidateValue = context.kind === "route-path"
        ? normalizeRouteRequestPath(candidate.value) || String(candidate.value || "").trim()
        : String(candidate.value || "").trim();
      const normalizedCandidate = candidateValue.toLowerCase();
      const candidateBaseName = getBasenameLike(normalizedCandidate);
      let score = computeLevenshteinDistance(normalizedRequest, normalizedCandidate);

      if (candidateBaseName && candidateBaseName === requestBaseName) {
        score -= 2;
      }
      if (normalizedCandidate.includes(normalizedRequest) || normalizedRequest.includes(normalizedCandidate)) {
        score -= 1;
      }

      return {
        ...candidate,
        value: candidateValue,
        score,
      };
    })
    .filter((candidate) => {
      const normalizedCandidate = String(candidate.value || "").toLowerCase();
      const candidateBaseName = getBasenameLike(normalizedCandidate);
      const sharesLeadingCharacter = normalizedCandidate[0] === normalizedRequest[0];
      return (
        (candidate.score <= threshold && sharesLeadingCharacter) ||
        normalizedCandidate.startsWith(normalizedRequest) ||
        normalizedRequest.startsWith(normalizedCandidate) ||
        (candidateBaseName && candidateBaseName === requestBaseName)
      );
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.value.length !== right.value.length) {
        return left.value.length - right.value.length;
      }

      return String(left.value || "").localeCompare(String(right.value || ""));
    })
    .slice(0, limit);
}

/**
 * include() local 이름 오타 후보를 고른다.
 * @param {string} requestedName
 * @param {string[]} candidateNames
 * @param {number} [limit]
 * @returns {string[]}
 */
function getSuggestedIdentifierCandidates(requestedName, candidateNames, limit = 3) {
  const normalizedRequestedName = String(requestedName || "").trim().toLowerCase();
  if (!normalizedRequestedName) {
    return [];
  }

  const threshold = Math.max(1, Math.ceil(normalizedRequestedName.length * 0.34));

  return [...new Set(Array.isArray(candidateNames) ? candidateNames.filter(Boolean) : [])]
    .map((candidateName) => {
      const normalizedCandidateName = String(candidateName || "").trim().toLowerCase();
      let score = computeLevenshteinDistance(normalizedRequestedName, normalizedCandidateName);

      if (
        normalizedCandidateName.startsWith(normalizedRequestedName) ||
        normalizedRequestedName.startsWith(normalizedCandidateName)
      ) {
        score -= 1;
      }

      return {
        candidateName: String(candidateName),
        normalizedCandidateName,
        score,
      };
    })
    .filter((candidate) => {
      if (!candidate.normalizedCandidateName) {
        return false;
      }

      return (
        candidate.score <= threshold &&
        candidate.normalizedCandidateName[0] === normalizedRequestedName[0]
      ) || candidate.normalizedCandidateName.startsWith(normalizedRequestedName);
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.candidateName.length !== right.candidateName.length) {
        return left.candidateName.length - right.candidateName.length;
      }

      return left.candidateName.localeCompare(right.candidateName);
    })
    .slice(0, limit)
    .map((candidate) => candidate.candidateName);
}

function buildSuggestedReplacementValue(context, candidateValue) {
  if (!context) {
    return candidateValue;
  }

  if (context.kind === "route-path") {
    const { suffix } = splitRoutePathSuffix(context.value);
    return `${candidateValue}${suffix}`;
  }

  return candidateValue;
}

/**
 * null/undefined 비교에서 검사하는 식별자 이름을 읽는다.
 * @param {ts.Node | undefined | null} node
 * @returns {string | null}
 */
function getOptionalGuardIdentifierName(node) {
  const target = skipExpressionWrappers(node);
  if (!target) {
    return null;
  }

  if (ts.isIdentifier(target)) {
    return target.text;
  }

  if (ts.isTypeOfExpression(target)) {
    const expressionTarget = skipExpressionWrappers(target.expression);
    return expressionTarget && ts.isIdentifier(expressionTarget) ? expressionTarget.text : null;
  }

  return null;
}

/**
 * optional local guard에 쓰인 이름을 수집한다.
 * @param {ts.SourceFile} sourceFile
 * @returns {Set<string>}
 */
function collectOptionalGuardNames(sourceFile) {
  const names = new Set();

  const isNullishLiteral = (node) => {
    const target = skipExpressionWrappers(node);
    return (
      !!target &&
      ((ts.isIdentifier(target) && target.text === "undefined") || target.kind === ts.SyntaxKind.NullKeyword)
    );
  };

  const rememberGuardedIdentifiers = (node) => {
    const target = skipExpressionWrappers(node);
    if (!target) {
      return;
    }

    if (ts.isIdentifier(target)) {
      names.add(target.text);
      return;
    }

    if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.ExclamationToken) {
      rememberGuardedIdentifiers(target.operand);
      return;
    }

    if (ts.isBinaryExpression(target)) {
      if (
        target.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        rememberGuardedIdentifiers(target.left);
        rememberGuardedIdentifiers(target.right);
      }
    }
  };

  const visit = (node) => {
    if (ts.isTypeOfExpression(node)) {
      const guardedName = getOptionalGuardIdentifierName(node.expression);
      if (guardedName) {
        names.add(guardedName);
      }
    }

    if (ts.isBinaryExpression(node)) {
      const leftName = getOptionalGuardIdentifierName(node.left);
      const rightName = getOptionalGuardIdentifierName(node.right);

      if (leftName && isNullishLiteral(node.right)) {
        names.add(leftName);
      }

      if (rightName && isNullishLiteral(node.left)) {
        names.add(rightName);
      }
    }

    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      rememberGuardedIdentifiers(node.expression);
    }

    if (ts.isForStatement(node) && node.condition) {
      rememberGuardedIdentifiers(node.condition);
    }

    if (ts.isConditionalExpression(node)) {
      rememberGuardedIdentifiers(node.condition);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

function resolvePathContextTargetWithIndex(projectIndex, filePath, context) {
  if (!context) {
    return null;
  }

  if (context.kind === "resolve-path") {
    return projectIndex.resolveResolveTarget(filePath, context.value);
  }

  if (context.kind === "include-path") {
    return projectIndex.resolveIncludeTarget(filePath, context.value);
  }

  if (context.kind === "asset-path") {
    return projectIndex.resolveAssetTarget(filePath, context.value);
  }

  if (context.kind === "route-path") {
    return projectIndex.resolveRouteTarget(filePath, context.value, {
      routeSource: context.routeSource,
    });
  }

  return null;
}

function collectUnresolvedPathDiagnostics(projectIndex, filePath, documentText, options = {}) {
  const diagnostics = [];
  const pathContexts = Array.isArray(options.pathContexts) ? options.pathContexts : collectPathContexts(documentText, { filePath });

  for (const context of pathContexts) {
    if (context.kind === "resolve-path" && /^\/?_private\//.test(context.value)) {
      continue;
    }

    if (context.kind === "route-path" && context.isDynamic) {
      continue;
    }

    const targetFilePath = resolvePathContextTargetWithIndex(projectIndex, filePath, context);
    if (targetFilePath) {
      continue;
    }

    const candidates = getPathContextCandidates(projectIndex, filePath, context);
    const suggestedCandidates = getSuggestedPathCandidates(context, candidates);
    const fixes = suggestedCandidates.map((candidate) => ({
      title: `Replace with "${candidate.value}"`,
      edits: [
        {
          start: context.start,
          end: context.end,
          newText: buildSuggestedReplacementValue(context, candidate.value),
        },
      ],
    }));

    const label = getPathContextLabel(context);
    const message = suggestedCandidates.length
      ? `${label} "${context.value}" was not found. Did you mean "${suggestedCandidates[0].value}"?`
      : `${label} "${context.value}" was not found.`;

    diagnostics.push({
      code:
        context.kind === "resolve-path"
          ? "pp-unresolved-resolve-path"
          : context.kind === "include-path"
            ? "pp-unresolved-include-path"
            : context.kind === "asset-path"
              ? "pp-unresolved-asset-path"
            : "pp-unresolved-route-path",
      category: ts.DiagnosticCategory.Warning,
      message,
      start: context.start,
      end: context.end,
      fixes,
    });
  }

  return diagnostics;
}

function collectAgentsRuleDiagnostics(projectIndex, filePath, documentText, options = {}) {
  const diagnostics = [];
  const analysisText = typeof options.analysisText === "string"
    ? options.analysisText
    : isEjsFile(filePath)
      ? buildTemplateVirtualText(documentText)
      : documentText;
  const analysisSourceFile = options.analysisSourceFile || null;
  const pathContexts = Array.isArray(options.pathContexts) ? options.pathContexts : collectPathContexts(documentText, { filePath });
  const routeParamNames = projectIndex.getRouteParamEntries(filePath).map((entry) => entry.name);

  for (const diagnostic of collectParamsFlowDiagnostics(analysisText, routeParamNames, { sourceFile: analysisSourceFile })) {
    diagnostics.push(diagnostic);
  }

  for (const diagnostic of collectIncludeContextDiagnostics(analysisText, { sourceFile: analysisSourceFile })) {
    diagnostics.push(diagnostic);
  }

  for (const diagnostic of collectUnresolvedPathDiagnostics(projectIndex, filePath, documentText, { pathContexts })) {
    diagnostics.push(diagnostic);
  }

  for (const diagnostic of collectRedirectReturnDiagnostics(filePath, analysisText, { sourceFile: analysisSourceFile })) {
    diagnostics.push(diagnostic);
  }

  for (const diagnostic of collectMiddlewareNextDiagnostics(filePath, analysisText, { sourceFile: analysisSourceFile })) {
    diagnostics.push(diagnostic);
  }

  for (const context of pathContexts) {
    if (context.kind === "resolve-path" && /^\/?_private\//.test(context.value)) {
      diagnostics.push({
        code: "pp-resolve-private-prefix",
        category: ts.DiagnosticCategory.Warning,
        message: "resolve() paths should be relative to _private. Remove the _private prefix.",
        start: context.start,
        end: context.end,
        fixes: [
          {
            title: "Remove _private prefix",
            edits: [
              {
                start: context.start,
                end: context.end,
                newText: context.value.replace(/^\/?_private\//, ""),
              },
            ],
          },
        ],
      });
    }

    if (context.kind === "route-path" && /(?:\?|&)__flash=/.test(context.value)) {
      diagnostics.push({
        code: "pp-manual-flash-query",
        category: ts.DiagnosticCategory.Warning,
        message: "Do not build __flash in the URL. Use redirect(path, { message }).",
        start: context.start,
        end: context.end,
      });
    }
  }

  return diagnostics;
}

function buildSchemaFieldDiagnostic(projectIndex, filePathOrContext, contextOrAnalysisText, analysisTextOrOffsetBase, offsetBase = 0) {
  const hasExplicitFilePath = typeof filePathOrContext === "string";
  const filePath = hasExplicitFilePath ? filePathOrContext : "";
  const context = hasExplicitFilePath ? contextOrAnalysisText : filePathOrContext;
  const analysisText = hasExplicitFilePath ? analysisTextOrOffsetBase : contextOrAnalysisText;
  const effectiveOffsetBase = hasExplicitFilePath
    ? offsetBase
    : typeof analysisTextOrOffsetBase === "number"
      ? analysisTextOrOffsetBase
      : 0;

  if (!context || typeof analysisText !== "string") {
    return null;
  }

  const reference = projectIndex.inferCollectionReference(
    context.receiverExpression,
    analysisText,
    context.start,
    { filePath }
  );

  if (!reference || projectIndex.hasField(reference.collectionName, context.value)) {
    return null;
  }

  // Schema field diagnostics should stay conservative. Medium-confidence
  // collection guesses are useful for completion, but too noisy for editor
  // warnings on generic names like row/item/entry.
  if (reference.confidence !== "high") {
    return null;
  }

  return {
    code: "pp-schema-field",
    category: ts.DiagnosticCategory.Warning,
    message: `Unknown field "${context.value}" for collection "${reference.collectionName}".`,
    start: effectiveOffsetBase + context.start,
    end: effectiveOffsetBase + context.end,
  };
}

function extractTypedCollectionName(typeText, typeName) {
  if (!typeText || !typeName) {
    return null;
  }

  const escapedTypeName = String(typeName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(typeText).match(new RegExp(`\\b${escapedTypeName}<"([^"]+)"`));
  return match ? match[1] : null;
}

function buildSchemaCollectionDiagnostic(context, offsetBase = 0) {
  return {
    code: "pp-schema-collection",
    category: ts.DiagnosticCategory.Warning,
    message: `Unknown PocketBase collection "${context.value}" in ${context.methodName}().`,
    start: offsetBase + context.start,
    end: offsetBase + context.end,
  };
}

function dedupeDiagnostics(diagnostics) {
  const uniqueDiagnostics = new Map();

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.category}:${diagnostic.start}:${diagnostic.end}:${diagnostic.message}`;
    if (!uniqueDiagnostics.has(key)) {
      uniqueDiagnostics.set(key, diagnostic);
    }
  }

  return [...uniqueDiagnostics.values()];
}

function toDiagnosticRegion(region) {
  if (!region || typeof region !== "object") {
    return null;
  }

  const sourceStart = Number(region.sourceStart);
  const sourceEnd = Number(region.sourceEnd);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd < sourceStart) {
    return null;
  }

  return {
    id: String(region.id || `${region.kind || "region"}:${sourceStart}:${sourceEnd}`),
    kind: String(region.kind || "region"),
    contentHash: String(region.contentHash || region.virtualTextHash || ""),
    dirty: region.dirty === true,
    sourceStart,
    sourceEnd,
    fullStart: Number.isFinite(Number(region.fullStart)) ? Number(region.fullStart) : sourceStart,
    fullEnd: Number.isFinite(Number(region.fullEnd)) ? Number(region.fullEnd) : sourceEnd,
  };
}

function createRegionSetIdentity(regions, options = {}) {
  const includeOffsets = options.includeOffsets === true;
  return (Array.isArray(regions) ? regions : [])
    .map(toDiagnosticRegion)
    .filter(Boolean)
    .map((region) => [
      region.kind,
      region.id,
      region.contentHash,
      includeOffsets ? `${region.sourceStart}-${region.sourceEnd}` : "",
    ].join(":"))
    .join("|") || "none";
}

function findContainingRegion(regions, start, end) {
  return (Array.isArray(regions) ? regions : [])
    .map(toDiagnosticRegion)
    .filter(Boolean)
    .find((region) => start >= region.sourceStart && end <= region.sourceEnd) || null;
}

function remapDiagnosticRangeByRegions(diagnostic, previousRegions, currentRegions) {
  if (
    !diagnostic ||
    typeof diagnostic.start !== "number" ||
    typeof diagnostic.end !== "number"
  ) {
    return diagnostic;
  }

  const previousRegion = findContainingRegion(previousRegions, diagnostic.start, diagnostic.end);
  if (!previousRegion) {
    return diagnostic;
  }

  const currentRegion = (Array.isArray(currentRegions) ? currentRegions : [])
    .map(toDiagnosticRegion)
    .filter(Boolean)
    .find((region) =>
      region.id === previousRegion.id &&
      region.contentHash === previousRegion.contentHash
    );
  if (!currentRegion) {
    return diagnostic;
  }

  const delta = currentRegion.sourceStart - previousRegion.sourceStart;
  if (!delta) {
    return diagnostic;
  }

  const remapEdit = (edit) => {
    if (
      !edit ||
      typeof edit.start !== "number" ||
      typeof edit.end !== "number" ||
      edit.start < previousRegion.sourceStart ||
      edit.end > previousRegion.sourceEnd
    ) {
      return edit;
    }

    return {
      ...edit,
      start: edit.start + delta,
      end: edit.end + delta,
    };
  };

  return {
    ...diagnostic,
    start: diagnostic.start + delta,
    end: diagnostic.end + delta,
    fixes: Array.isArray(diagnostic.fixes)
      ? diagnostic.fixes.map((fix) => ({
          ...fix,
          edits: Array.isArray(fix.edits) ? fix.edits.map(remapEdit) : fix.edits,
        }))
      : diagnostic.fixes,
  };
}

const completionFeatureHandlers = createCompletionFeatureHandlers({
  createSourceFileForText,
  elapsedMilliseconds,
  getAnalysisContextAtOffset,
  getPathContextAtOffset,
  getScriptCollectionContext,
  getScriptFieldContext,
  getScriptSchemaContextAtOffset,
  ts,
});
const diagnosticsFeatureHandlers = createDiagnosticsFeatureHandlers({
  collectClientScriptSyntacticDiagnostics,
  collectPathContexts,
  collectResolveCallSpansFromScript,
  collectResolveCallSpansFromTemplate,
  collectSchemaContexts,
  createDocumentAnalysis,
  dedupeDiagnostics,
  elapsedMilliseconds,
  normalizePath,
  rangesOverlap,
});
const navigationFeatureHandlers = createNavigationFeatureHandlers({
  collectPathContexts,
  collectStaticRequireCallContexts,
  getPathContextAtOffset,
  getRequirePathContextAtOffset,
  isScriptFile,
  isValidIdentifierName,
  normalizePath,
});

class ProjectLanguageService {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.projectIndex = new PocketPagesProjectIndex(appRoot);
    this.projectVersion = 0;
    this.documentSnapshotManager = new DocumentSnapshotManager({ normalizePath });
    this.staticFiles = this.documentSnapshotManager.staticFiles;
    this.virtualFiles = this.documentSnapshotManager.virtualFiles;
    this.documentSnapshots = this.documentSnapshotManager.sourceDocuments;
    this.preparedDocumentStates = this.documentSnapshotManager.preparedDocuments;
    this.includePreludeStack = new Set();
    this.documentOverrides = new Map();
    this.includeContractCache = new Map();
    this.includeCallEntriesCache = new Map();
    this.includePreludeCache = new Map();
    this.schemaTypePreludeCache = null;
    this.scriptSchemaDiagnosticsCache = new Map();

    this.languageService = ts.createLanguageService(this.createHost(), ts.createDocumentRegistry());
  }

  upsertDocumentSnapshot(filePath, text, options = {}) {
    return this.documentSnapshotManager.upsertSourceDocument(filePath, text, options);
  }

  getDocumentSnapshot(filePath) {
    return this.documentSnapshotManager.getSourceDocument(filePath);
  }

  getDocumentSnapshotForText(filePath, text) {
    return this.documentSnapshotManager.getSourceDocumentForText(filePath, text);
  }

  getDocumentSnapshotId(filePath, text = null) {
    return this.documentSnapshotManager.getSourceDocumentIdentity(filePath, text);
  }

  getDocumentSnapshotIdentity(filePath, text = null) {
    return this.getDocumentSnapshotId(filePath, text);
  }

  isPreparedDocumentStateCurrent(preparedState, filePath, documentText) {
    if (!preparedState) {
      return false;
    }

    return this.documentSnapshotManager.isPreparedDocumentStateCurrent(preparedState, filePath, documentText);
  }

  setDocumentOverride(filePath, text, options = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const currentText = typeof text === "string" ? text : "";
    this.upsertDocumentSnapshot(normalizedFilePath, currentText, options);
    const previousText = this.documentOverrides.get(normalizedFilePath);
    if (previousText === currentText) {
      return;
    }

    this.documentOverrides.set(normalizedFilePath, currentText);
    this.projectIndex.invalidateContentForFile(normalizedFilePath);
    this.includeCallEntriesCache.delete(normalizedFilePath);
    this.includeContractCache.delete(normalizedFilePath);
    this.projectVersion += 1;
  }

  clearDocumentOverride(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (this.documentOverrides.delete(normalizedFilePath)) {
      this.documentSnapshotManager.deleteSourceDocument(normalizedFilePath);
      this.projectIndex.invalidateContentForFile(normalizedFilePath);
      this.includeCallEntriesCache.delete(normalizedFilePath);
      this.includeContractCache.delete(normalizedFilePath);
      this.documentSnapshotManager.clearPreparedDocumentState(normalizedFilePath);
      this.projectVersion += 1;
    }
  }

  resetCaches() {
    this.includeContractCache.clear();
    this.includeCallEntriesCache.clear();
    this.includePreludeCache.clear();
    this.includePreludeStack.clear();
    this.schemaTypePreludeCache = null;
    this.scriptSchemaDiagnosticsCache.clear();
    this.documentSnapshotManager.clearTsFileStates();
    this.documentSnapshotManager.clearSourceDocuments();
    this.documentSnapshotManager.clearPreparedDocumentStates();
    this.projectIndex.resetCaches();
    this.projectVersion += 1;
  }

  clearVirtualFilesForSource(filePath) {
    return this.documentSnapshotManager.deleteVirtualFileStatesForSource(filePath);
  }

  invalidateManagedFile(filePath, options = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const changeType = typeof options.type === "string" ? options.type : "change";
    const pagesRootPath = normalizePath(path.join(this.appRoot, "pb_hooks", "pages"));
    const schemaPath = normalizePath(path.join(this.appRoot, "pb_schema.json"));
    const pbTypesPath = normalizePath(path.join(this.appRoot, "pb_data", "types.d.ts"));
    const globalsPath = normalizePath(path.join(this.appRoot, "pocketpages-globals.d.ts"));
    const serviceTypesPath = normalizePath(path.join(this.appRoot, "types.d.ts"));

    if (
      normalizedFilePath === schemaPath ||
      normalizedFilePath === pbTypesPath ||
      normalizedFilePath === globalsPath ||
      normalizedFilePath === serviceTypesPath ||
      changeType === "create" ||
      changeType === "delete"
    ) {
      this.resetCaches();
      return "reset";
    }

    let changed =
      normalizedFilePath === pagesRootPath ||
      normalizedFilePath.startsWith(`${pagesRootPath}/`);

    this.projectIndex.invalidateContentForFile(normalizedFilePath);

    if (this.documentSnapshotManager.deleteSourceDocument(normalizedFilePath)) {
      changed = true;
    }

    if (this.documentSnapshotManager.clearPreparedDocumentState(normalizedFilePath)) {
      changed = true;
    }

    this.documentSnapshotManager.deleteDiskFileState(normalizedFilePath);

    if (this.clearVirtualFilesForSource(normalizedFilePath)) {
      changed = true;
    }

    if (this.scriptSchemaDiagnosticsCache.delete(normalizedFilePath)) {
      changed = true;
    }

    if (
      this.includeContractCache.size > 0 ||
      this.includeCallEntriesCache.size > 0 ||
      this.includePreludeCache.size > 0
    ) {
      this.includeContractCache.clear();
      this.includeCallEntriesCache.clear();
      this.includePreludeCache.clear();
      changed = true;
    }

    if (changed) {
      this.projectVersion += 1;
    }

    return changed ? "partial" : "noop";
  }

  getDocumentOverride(filePath) {
    return this.documentOverrides.get(normalizePath(filePath));
  }

  getDocumentText(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (this.documentOverrides.has(normalizedFilePath)) {
      return this.documentOverrides.get(normalizedFilePath);
    }

    return readFileText(normalizedFilePath);
  }

  getPagesCodeOverrides(extraOverrides = {}) {
    return this.getPagesCodeOverridesExcluding([], extraOverrides);
  }

  getPagesCodeOverridesExcluding(excludedFilePaths = [], extraOverrides = {}) {
    const overrides = {};
    const excludedFilePathSet = new Set(
      (Array.isArray(excludedFilePaths) ? excludedFilePaths : [excludedFilePaths])
        .filter(Boolean)
        .map((filePath) => normalizePath(filePath))
    );

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
      if (excludedFilePathSet.has(filePath)) {
        continue;
      }
      if (this.documentOverrides.has(filePath)) {
        overrides[filePath] = this.documentOverrides.get(filePath);
      }
    }

    for (const [filePath, text] of Object.entries(extraOverrides || {})) {
      if (typeof text === "string") {
        overrides[normalizePath(filePath)] = text;
      }
    }

    return overrides;
  }

  getDocumentSnapshotToken(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (this.documentOverrides.has(normalizedFilePath)) {
      const documentSnapshot = this.getDocumentSnapshot(normalizedFilePath);
      return documentSnapshot && documentSnapshot.snapshotId
        ? documentSnapshot.snapshotId
        : "override:unknown";
    }

    if (!fileExists(normalizedFilePath)) {
      return "missing";
    }

    const stats = fs.statSync(normalizedFilePath);
    return `disk:${stats.mtimeMs}:${stats.size}`;
  }

  getDocumentTextIdentity(filePath, documentText) {
    return (
      this.getDocumentSnapshotIdentity(filePath, documentText) ||
      `text:${String(documentText || "").length}:${hashText(documentText)}`
    );
  }

  getVirtualFileIdentity(fileName) {
    const normalizedFileName = normalizePath(fileName);
    const state = this.getFileState(normalizedFileName);
    return state ? `${normalizedFileName}@${state.version}` : `${normalizedFileName}@missing`;
  }

  getPreparedVirtualLaneIdentity(filePath, documentText, lane) {
    const preparedState = this.getPreparedDocumentState(filePath);
    if (!this.isPreparedDocumentStateCurrent(preparedState, filePath, documentText)) {
      return "prepared:missing";
    }

    if (preparedState.kind === "script" && lane === "server") {
      return preparedState.script && preparedState.script.fileName
        ? this.getVirtualFileIdentity(preparedState.script.fileName)
        : "script:missing";
    }

    if (preparedState.kind !== "ejs") {
      return "prepared:not-ejs";
    }

    if (lane === "server") {
      const serverBlocks = Array.isArray(preparedState.serverBlocks)
        ? preparedState.serverBlocks
        : [];
      return serverBlocks.length
        ? serverBlocks.map((block) => this.getVirtualFileIdentity(block.fileName)).join("|")
        : "server:none";
    }

    if (lane === "template") {
      return preparedState.template && preparedState.template.fileName
        ? this.getVirtualFileIdentity(preparedState.template.fileName)
        : "template:missing";
    }

    return "prepared:unknown";
  }

  getPreparedRegionGraph(filePath, documentText) {
    const preparedState = this.getPreparedDocumentState(filePath);
    if (!this.isPreparedDocumentStateCurrent(preparedState, filePath, documentText)) {
      return null;
    }

    return preparedState && preparedState.regionGraph
      ? preparedState.regionGraph
      : null;
  }

  getDiagnosticsLaneMetadata(filePath, documentText, options = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const graph = this.getPreparedRegionGraph(normalizedFilePath, documentText);
    const regions = graph && Array.isArray(graph.regions) ? graph.regions : [];
    const serverRegions = regions.filter((region) => region && region.kind === "server-script");
    const templateRegions = regions.filter((region) => region && region.kind === "template-block");
    const pathRegions = [];
    const semanticMode = options.includeSemanticDiagnostics === false ? "syntactic" : "semantic";
    const typeScriptMode = options.includeTypeScriptDiagnostics === false ? "no-ts" : "ts";
    const tsDependencyIdentity = [
      typeScriptMode,
      semanticMode,
      `schema-type:${this.getSchemaTypeIdentity()}`,
      `structure:${this.projectIndex.pagesStructureVersion}`,
      `ambient:${this.getAmbientSnapshotKey()}`,
    ].join("|");

    if (options.includeProjectRuleDiagnostics !== false) {
      for (const context of collectPathContexts(documentText, { filePath: normalizedFilePath })) {
        pathRegions.push({
          id: `path:${context.kind}:${context.start}:${context.value}`,
          kind: `path:${context.kind}`,
          contentHash: hashText(`${context.kind}:${context.value}:${context.routeSource || ""}`),
          sourceStart: context.start,
          sourceEnd: context.end,
          fullStart: context.start,
          fullEnd: context.end,
        });
      }
    }

    return {
      server: {
        regions: serverRegions.map(toDiagnosticRegion).filter(Boolean),
        dependencyIdentity: tsDependencyIdentity,
      },
      template: {
        regions: templateRegions.map(toDiagnosticRegion).filter(Boolean),
        dependencyRegions: serverRegions.map(toDiagnosticRegion).filter(Boolean),
        dependencyIdentity: tsDependencyIdentity,
      },
      "project-rule:agents": {
        regions: [
          ...serverRegions.map(toDiagnosticRegion).filter(Boolean),
          ...templateRegions.map(toDiagnosticRegion).filter(Boolean),
          ...pathRegions.map(toDiagnosticRegion).filter(Boolean),
        ],
      },
      "project-rule:include-callers": {
        regions: pathRegions
          .filter((region) => region.kind === "path:include-path")
          .map(toDiagnosticRegion)
          .filter(Boolean),
      },
    };
  }

  getDiagnosticsRegionLaneIdentity(metadata, options = {}) {
    if (!metadata || typeof metadata !== "object") {
      return "regions:none";
    }

    const regionIdentity = createRegionSetIdentity(metadata.regions, {
      includeOffsets: options.includeOffsets === true,
    });
    const dependencyIdentity = createRegionSetIdentity(metadata.dependencyRegions, {
      includeOffsets: false,
    });
    return `regions:${regionIdentity}|deps:${dependencyIdentity}`;
  }

  remapReusableLaneDiagnostics(lane, diagnostics, previousMetadata, currentMetadata) {
    const previousRegions = previousMetadata && Array.isArray(previousMetadata.regions)
      ? previousMetadata.regions
      : [];
    const currentRegions = currentMetadata && Array.isArray(currentMetadata.regions)
      ? currentMetadata.regions
      : [];

    if (!previousRegions.length || !currentRegions.length) {
      return Array.isArray(diagnostics) ? diagnostics.slice() : [];
    }

    return (Array.isArray(diagnostics) ? diagnostics : [])
      .map((diagnostic) => remapDiagnosticRangeByRegions(diagnostic, previousRegions, currentRegions));
  }

  getReusableRegionDiagnostics(_lane, currentRegion, previousDiagnostics, previousMetadata, currentMetadata) {
    const normalizedCurrentRegion = toDiagnosticRegion(currentRegion);
    if (!normalizedCurrentRegion) {
      return null;
    }

    if (
      !previousMetadata ||
      !currentMetadata ||
      previousMetadata.dependencyIdentity !== currentMetadata.dependencyIdentity
    ) {
      return null;
    }

    const previousRegions = Array.isArray(previousMetadata.regions)
      ? previousMetadata.regions.map(toDiagnosticRegion).filter(Boolean)
      : [];
    const previousRegion = previousRegions.find((region) =>
      region.id === normalizedCurrentRegion.id &&
      region.contentHash === normalizedCurrentRegion.contentHash
    );
    if (!previousRegion) {
      return null;
    }

    const containedDiagnostics = (Array.isArray(previousDiagnostics) ? previousDiagnostics : [])
      .filter((diagnostic) =>
        findContainingRegion([previousRegion], diagnostic && diagnostic.start, diagnostic && diagnostic.end)
      );
    return containedDiagnostics.map((diagnostic) =>
      remapDiagnosticRangeByRegions(diagnostic, [previousRegion], [normalizedCurrentRegion])
    );
  }

  getSchemaDiagnosticsIdentity() {
    const schemaState = this.projectIndex.getSchemaState();
    return [
      "schema",
      schemaState && schemaState.schemaPath ? normalizePath(schemaState.schemaPath) : "missing",
      schemaState && schemaState.mtimeMs !== undefined ? schemaState.mtimeMs : "0",
      schemaState && schemaState.size !== undefined ? schemaState.size : "0",
      `content:${this.projectIndex.pagesContentVersion}`,
    ].join(":");
  }

  getSchemaTypeIdentity() {
    const schemaState = this.projectIndex.getSchemaState();
    return [
      "schema",
      schemaState && schemaState.schemaPath ? normalizePath(schemaState.schemaPath) : "missing",
      schemaState && schemaState.mtimeMs !== undefined ? schemaState.mtimeMs : "0",
      schemaState && schemaState.size !== undefined ? schemaState.size : "0",
    ].join(":");
  }

  getDiagnosticsLaneResultIds(filePath, documentText, options = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const sourceIdentity = this.getDocumentTextIdentity(normalizedFilePath, documentText);
    const semanticMode = options.includeSemanticDiagnostics === false ? "syntactic" : "semantic";
    const typeScriptMode = options.includeTypeScriptDiagnostics === false ? "no-ts" : "ts";
    const laneMetadata =
      options.laneMetadata && typeof options.laneMetadata === "object"
        ? options.laneMetadata
        : this.getDiagnosticsLaneMetadata(normalizedFilePath, documentText, options);
    const sourceLane = `source:${sourceIdentity}`;
    const schemaIdentity = this.getSchemaDiagnosticsIdentity();
    const schemaTypeIdentity = this.getSchemaTypeIdentity();
    const schemaLane = `${sourceLane}|${schemaIdentity}`;
    const ambientLane = `ambient:${this.getAmbientSnapshotKey()}`;
    const structureLane = `structure:${this.projectIndex.pagesStructureVersion}`;
    const pagesContentLane = `pages:${this.projectIndex.pagesContentVersion}`;
    const serverRegionLane = this.getDiagnosticsRegionLaneIdentity(laneMetadata.server);
    const templateRegionLane = this.getDiagnosticsRegionLaneIdentity(laneMetadata.template);
    const projectRuleAgentsLane = this.getDiagnosticsRegionLaneIdentity(laneMetadata["project-rule:agents"]);
    const projectRuleIncludeCallersLane = this.getDiagnosticsRegionLaneIdentity(laneMetadata["project-rule:include-callers"]);

    return {
      "client-syntax": sourceLane,
      "private-resolve": `${sourceLane}|${pagesContentLane}`,
      server:
        options.includeServerBlockDiagnostics === false
          ? "disabled"
          : [
              "server",
              typeScriptMode,
              semanticMode,
              serverRegionLane,
              schemaTypeIdentity,
              structureLane,
              ambientLane,
            ].join("|"),
      template:
        options.includeTemplateDiagnostics === false
          ? "disabled"
          : [
              "template",
              typeScriptMode,
              semanticMode,
              templateRegionLane,
              schemaTypeIdentity,
              structureLane,
              ambientLane,
            ].join("|"),
      "script-schema":
        options.includeScriptSchemaDiagnostics === false
          ? "disabled"
          : schemaLane,
      "project-rule:agents":
        options.includeProjectRuleDiagnostics === false
          ? "disabled"
          : `${projectRuleAgentsLane}|${structureLane}|${schemaIdentity}`,
      "project-rule:include-callers":
        options.includeProjectRuleDiagnostics === false
          ? "disabled"
          : `${projectRuleIncludeCallersLane}|${pagesContentLane}`,
      "project-rule":
        options.includeProjectRuleDiagnostics === false
          ? "disabled"
          : [
              "project-rule",
              projectRuleAgentsLane,
              projectRuleIncludeCallersLane,
              structureLane,
              pagesContentLane,
              schemaIdentity,
            ].join("|"),
    };
  }

  getDiagnosticsResultId(filePath, documentText, options = {}) {
    const laneResultIds =
      options.laneResultIds && typeof options.laneResultIds === "object"
        ? options.laneResultIds
        : this.getDiagnosticsLaneResultIds(filePath, documentText, options);
    return JSON.stringify(laneResultIds);
  }

  getAmbientSnapshotKey() {
    const filePaths = [
      ...getAppAmbientTypeFiles(this.appRoot),
      this.projectIndex.getSchemaState().schemaPath,
    ].filter((filePath, index, items) => filePath && items.indexOf(filePath) === index);

    return filePaths
      .map((filePath) => {
        const normalizedFilePath = normalizePath(filePath);
        if (!fileExists(normalizedFilePath)) {
          return `${normalizedFilePath}:missing`;
        }

        const stats = fs.statSync(normalizedFilePath);
        return `${normalizedFilePath}:${stats.mtimeMs}:${stats.size}`;
      })
      .join("|");
  }

  getPreludeSnapshotKey(filePath, analysisText = "", options = {}) {
    const currentAnalysisText = String(analysisText || "");
    const normalizedFilePath = normalizePath(filePath);
    const includeLocalsIdentity =
      !options.skipIncludeLocals && isEjsFile(normalizedFilePath) && isPrivatePagesFile(normalizedFilePath)
        ? `include-locals:content:${this.projectIndex.pagesContentVersion}`
        : options.skipIncludeLocals
          ? "include-locals:skip"
          : "include-locals:none";
    return [
      "prelude",
      normalizedFilePath,
      `analysis:${currentAnalysisText.length}:${hashText(currentAnalysisText)}`,
      `ambient:${this.getAmbientSnapshotKey()}`,
      `structure:${this.projectIndex.pagesStructureVersion}`,
      includeLocalsIdentity,
      options.skipResolveTypePrelude ? "resolve-types:skip" : "resolve-types:on",
    ].join("|");
  }

  getTemplatePreludeSnapshotKey(filePath, metadata = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const serverRegions = (Array.isArray(metadata.serverBlocks) ? metadata.serverBlocks : [])
      .map((block) => `server:${block.index}:${hashText(block.content)}`);
    const templateRegions = (Array.isArray(metadata.templateRegionBlocks) ? metadata.templateRegionBlocks : [])
      .map((region) => `${region.id}:${region.contentHash}`);
    return [
      "template-prelude",
      normalizedFilePath,
      `code:${serverRegions.join("|")}`,
      `template:${templateRegions.join("|")}`,
      `ambient:${this.getAmbientSnapshotKey()}`,
      `structure:${this.projectIndex.pagesStructureVersion}`,
      "resolve-types:on",
    ].join("|");
  }

  getIncludeCallEntries(filePath, analysisText) {
    const normalizedFilePath = normalizePath(filePath);
    const cachedEntry = this.includeCallEntriesCache.get(normalizedFilePath);
    if (cachedEntry && cachedEntry.analysisText === analysisText) {
      return cachedEntry.entries;
    }

    const entries = collectIncludeCallEntries(filePath, analysisText);
    this.includeCallEntriesCache.set(normalizedFilePath, {
      analysisText,
      entries,
    });
    return entries;
  }

  getCachedIncludeLocalBindingMap(targetFilePath) {
    if (!this.projectIndex.includeLocalsCache) {
      return null;
    }

    const targetState = this.projectIndex.includeLocalsCache.byTargetFile.get(normalizePath(targetFilePath));
    if (!targetState) {
      return null;
    }

    const localsByName = new Map();
    const callSiteCount = targetState.callSites.length;
    for (const callSite of targetState.callSites) {
      for (const local of callSite.locals || []) {
        let state = localsByName.get(local.name);
        if (!state) {
          state = {
            presenceCount: 0,
            typeTexts: new Set(),
          };
          localsByName.set(local.name, state);
        }

        state.presenceCount += 1;
        state.typeTexts.add(local.typeText || "any");
      }
    }

    const bindingMap = new Map();
    for (const [name, state] of localsByName.entries()) {
      let typeText = mergeTypeTexts([...state.typeTexts]);
      if (state.presenceCount < callSiteCount) {
        typeText = mergeTypeTexts([typeText, "undefined"]);
      }

      bindingMap.set(name, typeText);
    }

    return bindingMap;
  }

  createHost() {
    return {
      getCompilationSettings: () => COMPILER_OPTIONS,
      getScriptFileNames: () => this.documentSnapshotManager.getTsFileNames(),
      getScriptVersion: (fileName) => this.documentSnapshotManager.getScriptVersion(fileName),
      getScriptSnapshot: (fileName) => this.documentSnapshotManager.getScriptSnapshot(fileName),
      getCurrentDirectory: () => this.appRoot,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) => this.hasFile(fileName),
      readFile: (fileName) => this.readFile(fileName),
      directoryExists: (dirPath) => ts.sys.directoryExists(dirPath),
      getDirectories: (dirPath) => ts.sys.getDirectories(dirPath),
      readDirectory: (dirPath, extensions, exclude, include, depth) => ts.sys.readDirectory(dirPath, extensions, exclude, include, depth),
      realpath: (fileName) => (ts.sys.realpath ? ts.sys.realpath(fileName) : fileName),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
      getProjectVersion: () => String(this.projectVersion),
    };
  }

  getFileState(fileName) {
    return this.documentSnapshotManager.getManagedTsFileState(fileName);
  }

  hasFile(fileName) {
    return this.documentSnapshotManager.hasFile(fileName);
  }

  readFile(fileName) {
    return this.documentSnapshotManager.readFile(fileName);
  }

  ensureStaticFile(filePath) {
    const resolvedPath = normalizePath(filePath);

    if (!fileExists(resolvedPath)) {
      if (this.documentSnapshotManager.deleteStaticFileState(resolvedPath)) {
        this.projectVersion += 1;
      }
      return;
    }

    const stats = fs.statSync(resolvedPath);
    const text = fs.readFileSync(resolvedPath, "utf8");
    const previous = this.staticFiles.get(resolvedPath);

    if (previous && previous.mtimeMs === stats.mtimeMs && previous.text === text) {
      return;
    }

    this.documentSnapshotManager.setStaticFileState(resolvedPath, {
      text,
      mtimeMs: stats.mtimeMs,
    });
    this.projectVersion += 1;
  }

  upsertStaticFileText(filePath, text) {
    const resolvedPath = normalizePath(filePath);
    const previous = this.staticFiles.get(resolvedPath);

    if (previous && previous.text === text) {
      return;
    }

    this.documentSnapshotManager.setStaticFileState(resolvedPath, {
      text,
      mtimeMs: previous ? previous.mtimeMs : 0,
    });
    this.projectVersion += 1;
  }

  refreshStaticFiles(options = {}) {
    if (options.skipStaticRefresh === true) {
      return;
    }

    for (const filePath of getAppAmbientTypeFiles(this.appRoot)) {
      this.ensureStaticFile(filePath);
    }
  }

  buildPrelude(filePath, analysisText = "", options = {}) {
    const references = getAppAmbientTypeFiles(this.appRoot)
      .filter((filePath) => fileExists(filePath))
      .map((filePath) => `/// <reference path="${toReferencePath(filePath)}" />`);

    const routeParams = this.projectIndex.getRouteParamEntries(filePath);
    const routeParamLines = routeParams.length
      ? [
          "declare global {",
          "interface PocketPagesRouteParams {",
          ...routeParams.map((entry) => `  ${JSON.stringify(entry.name)}: ${entry.type};`),
          "}",
          "}",
        ]
      : [];

    const parts = [];
    if (references.length) {
      parts.push(references.join("\n"));
    }
    if (routeParamLines.length) {
      parts.push(routeParamLines.join("\n"));
    }

    // PocketPages-specific path and caller analysis stays in custom code.
    // Once those semantics are resolved, we hand ambient declarations to TS so
    // hover/completion/definition/rename/diagnostics come from one type engine.
    const schemaTypePrelude = this.buildSchemaTypePrelude();
    if (schemaTypePrelude) {
      parts.push(schemaTypePrelude);
    }

    const recordGetPrelude = this.buildRecordGetTypePrelude(filePath, analysisText);
    if (recordGetPrelude) {
      parts.push(recordGetPrelude);
    }

    const includeLocalsPrelude =
      !options.skipIncludeLocals && isEjsFile(filePath) && isPrivatePagesFile(filePath)
        ? this.buildIncludeLocalsPrelude(filePath)
        : "";
    if (includeLocalsPrelude) {
      parts.push(includeLocalsPrelude);
    }

    // Force each extracted <script server> block into module scope so top-level
    // bindings from different EJS files do not collide in the shared TS project.
    parts.push("export {};");

    const resolveTypePrelude = options.skipResolveTypePrelude ? "" : this.buildResolveTypePrelude(filePath, analysisText);
    if (resolveTypePrelude) {
      parts.push(resolveTypePrelude);
    }

    const requireTypePrelude = this.buildRequireTypePrelude(analysisText);
    if (requireTypePrelude) {
      parts.push(requireTypePrelude);
    }

    return `${parts.join("\n\n")}\n\n`;
  }

  buildSchemaTypePrelude() {
    const schemaState = this.projectIndex.getSchemaState();
    const snapshotKey = `${normalizePath(schemaState.schemaPath)}:${schemaState.mtimeMs}:${schemaState.size}`;
    if (this.schemaTypePreludeCache && this.schemaTypePreludeCache.snapshotKey === snapshotKey) {
      return this.schemaTypePreludeCache.preludeText;
    }

    const collectionNames = this.projectIndex.getCollectionNames();
    if (!collectionNames.length) {
      this.schemaTypePreludeCache = {
        snapshotKey,
        preludeText: "",
      };
      return "";
    }

    const collectionUnion = collectionNames.map((collectionName) => JSON.stringify(collectionName)).join(" | ");
    const schemaLines = [
      `type PocketPagesCollectionName = ${collectionUnion};`,
      "interface PocketPagesSchemaByCollection {",
    ];

    for (const collectionName of collectionNames) {
      schemaLines.push(`  ${JSON.stringify(collectionName)}: {`);
      const fields = this.projectIndex.getFields(collectionName);
      for (const field of fields) {
        const typeText = this.projectIndex.getFieldTypeText(collectionName, field.name) || "any";
        schemaLines.push(`    ${JSON.stringify(field.name)}: ${typeText};`);
      }
      schemaLines.push("  };");
    }

    schemaLines.push("}");
    schemaLines.push("type PocketPagesCollectionModel<C extends PocketPagesCollectionName> = Omit<pocketbase.Collection, \"name\"> & { name: C };");
    schemaLines.push("type PocketPagesCollectionRef<C extends PocketPagesCollectionName> = C | PocketPagesCollectionModel<C>;");
    schemaLines.push("type PocketPagesRecordInitData = { [key: string]: any };");
    schemaLines.push("type PocketPagesFieldMap<C extends PocketPagesCollectionName> = PocketPagesSchemaByCollection[C];");
    schemaLines.push("type PocketPagesFieldName<C extends PocketPagesCollectionName> = Extract<keyof PocketPagesFieldMap<C>, string>;");
    schemaLines.push("type PocketPagesFieldValue<C extends PocketPagesCollectionName, K extends PocketPagesFieldName<C>> = PocketPagesFieldMap<C>[K];");
    schemaLines.push(
      "type PocketPagesTypedRecord<C extends PocketPagesCollectionName> = Omit<core.Record, \"get\" | \"set\" | \"tableName\" | \"collection\"> & {"
    );
    schemaLines.push("  get<K extends PocketPagesFieldName<C>>(name: K): PocketPagesFieldValue<C, K>;");
    schemaLines.push("  get(name: string): any;");
    schemaLines.push("  set<K extends PocketPagesFieldName<C>>(name: K, value: PocketPagesFieldValue<C, K>): void;");
    schemaLines.push("  set(name: string, value: any): void;");
    schemaLines.push("  tableName(): C;");
    schemaLines.push("  collection(): PocketPagesCollectionModel<C>;");
    schemaLines.push("};");
    schemaLines.push("type PocketPagesTypedRecordConstructor = {");
    schemaLines.push("  new<C extends PocketPagesCollectionName>(collection?: PocketPagesCollectionModel<C>, data?: PocketPagesRecordInitData): PocketPagesTypedRecord<C>;");
    schemaLines.push("  new(collection?: pocketbase.Collection, data?: PocketPagesRecordInitData): core.Record;");
    schemaLines.push("};");
    schemaLines.push("declare global {");
    schemaLines.push("  namespace pocketbase {");
    schemaLines.push("    interface PocketBase {");
    schemaLines.push("      findCollectionByNameOrId<C extends PocketPagesCollectionName>(nameOrId: C): PocketPagesCollectionModel<C>;");
    schemaLines.push("      findCachedCollectionByNameOrId<C extends PocketPagesCollectionName>(nameOrId: C): PocketPagesCollectionModel<C>;");
    schemaLines.push("      findRecordById<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>, recordId: string): PocketPagesTypedRecord<C>;");
    schemaLines.push("      findRecordsByIds<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>, recordIds: string[]): Array<PocketPagesTypedRecord<C>>;");
    schemaLines.push("      findAllRecords<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>): Array<PocketPagesTypedRecord<C>>;");
    schemaLines.push("      findFirstRecordByData<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>, key: string, value: any): PocketPagesTypedRecord<C>;");
    schemaLines.push("      findRecordsByFilter<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>, filter?: string, sort?: string, limit?: number, offset?: number, params?: Record<string, any>): Array<PocketPagesTypedRecord<C>>;");
    schemaLines.push("      findFirstRecordByFilter<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>, filter: string, params?: Record<string, any>): PocketPagesTypedRecord<C>;");
    schemaLines.push("      findAuthRecordByEmail<C extends PocketPagesCollectionName>(collectionModelOrIdentifier: PocketPagesCollectionRef<C>, email: string): PocketPagesTypedRecord<C>;");
    schemaLines.push("      findRecordByViewFile<C extends PocketPagesCollectionName>(viewCollectionModelOrIdentifier: PocketPagesCollectionRef<C>, fileKey: string): PocketPagesTypedRecord<C>;");
    schemaLines.push("    }");
    schemaLines.push("  }");
    schemaLines.push("}");
    schemaLines.push("const Record: PocketPagesTypedRecordConstructor = (globalThis as any).Record as PocketPagesTypedRecordConstructor;");

    const preludeText = schemaLines.join("\n");
    this.schemaTypePreludeCache = {
      snapshotKey,
      preludeText,
    };
    return preludeText;
  }

  buildRequireTypePrelude(analysisText) {
    const importSpecifiers = [...new Set(
      collectStaticRequireCallContexts(analysisText)
        .map((context) => toTypedRequireImportSpecifier(context))
        .filter(Boolean)
    )];

    if (!importSpecifiers.length) {
      return "";
    }

    const overloadLines = importSpecifiers.map(
      (importSpecifier) => `  (requestPath: ${JSON.stringify(importSpecifier)}): typeof import(${JSON.stringify(importSpecifier)});`
    );

    return [
      "declare const require: ((requestPath: string) => any) & {",
      ...overloadLines,
      "};",
    ].join("\n");
  }

  buildRecordGetTypePrelude(filePath, analysisText) {
    if (!analysisText) {
      return "";
    }

    const collectRecordGetFieldNames = (schemaAnalysisText) => [...new Set(
      collectSchemaContexts(schemaAnalysisText, {
        collectionMethodNames: this.projectIndex.getCollectionMethodNames(),
      })
        .filter((context) => context.kind === "record-field" && context.accessMethod === "get")
        .map((context) => context.value)
        .filter(Boolean)
    )];
    let fieldNames = collectRecordGetFieldNames(analysisText);
    if (!fieldNames.length && isEjsFile(filePath) && /<%|<script\b/i.test(String(analysisText || ""))) {
      fieldNames = collectRecordGetFieldNames(buildTemplateVirtualText(analysisText));
    }
    const overloadLines = fieldNames
      .map((fieldName) => {
        const typeText = this.projectIndex.getRecordFieldTypeText(fieldName);
        return typeText ? `      get(name: ${JSON.stringify(fieldName)}): ${typeText};` : null;
      })
      .filter(Boolean);

    if (!overloadLines.length) {
      return "";
    }

    return [
      "declare global {",
      "  namespace core {",
      "    interface Record {",
      ...overloadLines,
      "    }",
      "  }",
      "}",
    ].join("\n");
  }

  buildIncludeLocalsPrelude(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (!isEjsFile(normalizedFilePath)) {
      return "";
    }

    if (this.includePreludeStack.has(normalizedFilePath)) {
      return "";
    }

    this.includePreludeStack.add(normalizedFilePath);

    try {
      const callSites = this.collectIncludeTargetCallSites(normalizedFilePath);
      if (!callSites.length) {
        this.includePreludeCache.set(normalizedFilePath, {
          snapshotKey: `${this.getAmbientSnapshotKey()}|empty`,
          preludeText: "",
        });
        return "";
      }

      const snapshotKey = [
        this.getAmbientSnapshotKey(),
        ...callSites.map((callSite) => {
          const callerFilePath = normalizePath(callSite.callerFilePath);
          return `${callerFilePath}:${this.getDocumentSnapshotToken(callerFilePath)}`;
        }),
      ].join("|");
      const cachedEntry = this.includePreludeCache.get(normalizedFilePath);
      if (cachedEntry && cachedEntry.snapshotKey === snapshotKey) {
        return cachedEntry.preludeText;
      }

      const bindingsByName = new Map();

      for (const callSite of callSites) {
        const callerFilePath = normalizePath(callSite.callerFilePath);
        if (!fileExists(callerFilePath)) {
          continue;
        }

        const callerDocumentText = this.getDocumentText(callerFilePath);

        for (const local of callSite.locals || []) {
          let bindingState = bindingsByName.get(local.name);
          if (!bindingState) {
            bindingState = {
              presenceCount: 0,
              typeTexts: new Set(),
            };
            bindingsByName.set(local.name, bindingState);
          }

          bindingState.presenceCount += 1;
          bindingState.typeTexts.add(this.getIncludeLocalTypeText(callerFilePath, callerDocumentText, local));
        }
      }

      const bindingLines = [];
      const callSiteCount = callSites.length;

      for (const [name, bindingState] of [...bindingsByName.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        const typeTexts = [...bindingState.typeTexts].filter(Boolean);
        let typeText = typeTexts.length ? [...new Set(typeTexts)].sort().join(" | ") : "any";
        if (typeTexts.includes("any")) {
          typeText = "any";
        }

        if (bindingState.presenceCount < callSiteCount) {
          typeText = typeText === "any" ? "any" : `${typeText} | undefined`;
        }

        bindingLines.push(`declare const ${name}: ${typeText};`);
      }

      const preludeText = bindingLines.join("\n");
      this.includePreludeCache.set(normalizedFilePath, {
        snapshotKey,
        preludeText,
      });
      return preludeText;
    } finally {
      this.includePreludeStack.delete(normalizedFilePath);
    }
  }

  collectIncludeTargetCallSites(targetFilePath) {
    return this.projectIndex.getIncludeTargetCallSites(targetFilePath, {
      overrides: this.getPagesCodeOverridesExcluding([targetFilePath]),
      readFileText: (filePath) => this.getDocumentText(filePath),
    });
  }

  getIncludeLocalTypeText(filePath, documentText, local) {
    if (!local || local.typeStrategy !== "ts-expression") {
      return local && local.typeText ? local.typeText : "any";
    }

    if (typeof local.expressionStart !== "number" || local.expressionStart < 0) {
      return local.typeText || "any";
    }

    const inferredTypeText = this.getTypeTextAtDocumentSpan(
      filePath,
      documentText,
      local.expressionStart,
      typeof local.expressionEnd === "number" ? local.expressionEnd : null
    );
    return inferredTypeText || local.typeText || "any";
  }

  getTypeTextAtDocumentSpan(filePath, documentText, startOffset, endOffset = null) {
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, startOffset);
    if (!virtualState) {
      return null;
    }

    const program = this.languageService.getProgram();
    if (!program) {
      return null;
    }

    const sourceFile = program.getSourceFile(virtualState.virtual.fileName);
    if (!sourceFile) {
      return null;
    }

    let targetNode = null;
    if (typeof endOffset === "number" && endOffset > startOffset) {
      targetNode = findNarrowestNodeForSpan(
        sourceFile,
        sourceFile,
        virtualState.virtualOffset,
        virtualState.virtualOffset + (endOffset - startOffset)
      );
    }

    if (!targetNode) {
      targetNode = findNarrowestNodeAtOffset(sourceFile, virtualState.virtualOffset);
    }
    if (!targetNode) {
      return null;
    }

    const checker = program.getTypeChecker();
    const targetType = checker.getTypeAtLocation(targetNode);
    if (!targetType) {
      return null;
    }

    return checker.typeToString(targetType, targetNode, ts.TypeFormatFlags.NoTruncation);
  }

  resolveSchemaFieldCollectionReference(filePath, documentText, context, options = {}) {
    if (!context || !context.receiverExpression) {
      return null;
    }

    const normalizedFilePath = normalizePath(filePath);
    const analysisText = typeof options.analysisText === "string" ? options.analysisText : documentText;
    const analysisStart = typeof options.analysisStart === "number" ? options.analysisStart : 0;
    const analysisSourceFile = options.analysisSourceFile || options.sourceFile || null;

    if (typeof context.receiverStart === "number") {
      const receiverStart = analysisStart + context.receiverStart;
      const receiverEnd =
        analysisStart +
        (typeof context.receiverEnd === "number"
          ? context.receiverEnd
          : context.receiverStart + String(context.receiverExpression || "").length);
      const receiverTypeText = this.getTypeTextAtDocumentSpan(
        normalizedFilePath,
        documentText,
        receiverStart,
        receiverEnd
      );
      const typedCollectionName = extractTypedCollectionName(receiverTypeText, "PocketPagesTypedRecord");
      if (typedCollectionName && this.projectIndex.hasCollection(typedCollectionName)) {
        return {
          collectionName: typedCollectionName,
          confidence: "high",
          strategy: "typed-record",
        };
      }
    }

    return this.projectIndex.inferCollectionReference(
      context.receiverExpression,
      analysisText,
      context.start,
      {
        filePath: normalizedFilePath,
        sourceFile: analysisSourceFile,
      }
    );
  }

  buildDocumentSchemaFieldDiagnostic(filePath, documentText, context, options = {}) {
    const analysisText = typeof options.analysisText === "string" ? options.analysisText : documentText;
    const analysisStart = typeof options.analysisStart === "number" ? options.analysisStart : 0;
    const reference = this.resolveSchemaFieldCollectionReference(filePath, documentText, context, {
      analysisText,
      analysisStart,
      analysisSourceFile: options.analysisSourceFile || options.sourceFile || null,
    });

    if (!reference || this.projectIndex.hasField(reference.collectionName, context.value)) {
      return null;
    }

    if (reference.confidence !== "high") {
      return null;
    }

    return {
      code: "pp-schema-field",
      category: ts.DiagnosticCategory.Warning,
      message: `Unknown field "${context.value}" for collection "${reference.collectionName}".`,
      start: analysisStart + context.start,
      end: analysisStart + context.end,
    };
  }

  getIncludeContractLocals(targetFilePath, options = {}) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    if (!isEjsFile(normalizedTargetFilePath) || !fileExists(normalizedTargetFilePath)) {
      return [];
    }

    const documentText = this.getDocumentText(normalizedTargetFilePath);
    const analysisText = buildTemplateVirtualText(documentText);
    if (!analysisText.trim()) {
      return [];
    }

    const ambientSnapshotKey = this.getAmbientSnapshotKey();
    const cachedEntry = this.includeContractCache.get(normalizedTargetFilePath);
    let baseLocals = null;
    if (cachedEntry && cachedEntry.documentText === documentText && cachedEntry.ambientSnapshotKey === ambientSnapshotKey) {
      baseLocals = cachedEntry.locals;
    }

    if (!baseLocals) {
      const preludeText = this.buildPrelude(normalizedTargetFilePath, analysisText, {
        skipIncludeLocals: true,
        skipResolveTypePrelude: true,
      });
      const tempText = `${preludeText}${analysisText}`;
      const tempFilePath = getSourceAdjacentVirtualFilePath(normalizedTargetFilePath, "include_contract");
      const ambientFiles = getAppAmbientTypeFiles(this.appRoot).filter((filePath) => fileExists(filePath)).map((filePath) => normalizePath(filePath));
      const compilerHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
      const defaultReadFile = compilerHost.readFile.bind(compilerHost);
      const defaultFileExists = compilerHost.fileExists.bind(compilerHost);
      const defaultGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);

      compilerHost.readFile = (fileName) => {
        const normalizedFileName = normalizePath(fileName);
        if (normalizedFileName === tempFilePath) {
          return tempText;
        }

        return defaultReadFile(fileName);
      };

      compilerHost.fileExists = (fileName) => {
        const normalizedFileName = normalizePath(fileName);
        if (normalizedFileName === tempFilePath) {
          return true;
        }

        return defaultFileExists(fileName);
      };

      compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        const normalizedFileName = normalizePath(fileName);
        if (normalizedFileName === tempFilePath) {
          return ts.createSourceFile(fileName, tempText, languageVersion, true);
        }

        return defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      };

      const program = ts.createProgram([...ambientFiles, tempFilePath], COMPILER_OPTIONS, compilerHost);
      const tempSourceFile = program.getSourceFile(tempFilePath);
      if (!tempSourceFile) {
        return [];
      }

      const optionalGuardNames = collectOptionalGuardNames(tempSourceFile);
      const expectedNames = new Set();
      const diagnostics = [
        ...program.getSyntacticDiagnostics(tempSourceFile),
        ...program.getSemanticDiagnostics(tempSourceFile),
      ];

      for (const diagnostic of diagnostics) {
        if (![2304, 2552].includes(diagnostic.code)) {
          continue;
        }

        if (typeof diagnostic.start !== "number" || typeof diagnostic.length !== "number" || diagnostic.length <= 0) {
          continue;
        }

        if (diagnostic.start < preludeText.length) {
          continue;
        }

        const identifierName = tempText.slice(diagnostic.start, diagnostic.start + diagnostic.length);
        if (!isValidIdentifierName(identifierName) || identifierName === "undefined") {
          continue;
        }

        expectedNames.add(identifierName);
      }

      baseLocals = [...expectedNames]
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({
          name,
          optional: optionalGuardNames.has(name),
        }));
      this.includeContractCache.set(normalizedTargetFilePath, {
        ambientSnapshotKey,
        documentText,
        locals: baseLocals,
      });
    }

    if (!options.includeBindingTypes) {
      return baseLocals.map((local) => ({
        ...local,
        typeText: "any",
      }));
    }

    const bindingByName = this.getCachedIncludeLocalBindingMap(normalizedTargetFilePath);
    return baseLocals.map((local) => {
      const bindingTypeText = bindingByName ? bindingByName.get(local.name) : null;
      return {
        ...local,
        typeText: local.optional
          ? bindingTypeText || "any"
          : stripUndefinedFromTypeText(bindingTypeText || "any"),
      };
    });
  }

  getIncludeCallContextAtOffset(filePath, documentText, offset) {
    const analysisContext = getAnalysisContextAtOffset(filePath, documentText, offset);
    if (!analysisContext) {
      return null;
    }

    const includeCall = this.getIncludeCallEntries(filePath, analysisContext.analysisText).find(
      (entry) => analysisContext.analysisOffset >= entry.callStart && analysisContext.analysisOffset <= entry.callEnd
    );
    if (!includeCall) {
      return null;
    }

    const targetFilePath = this.projectIndex.resolveIncludeTarget(filePath, includeCall.requestPath);
    if (!targetFilePath) {
      return null;
    }

    return {
      ...analysisContext,
      includeCall,
      targetFilePath,
    };
  }

  getIncludeLocalCompletionData(filePath, documentText, offset) {
    const includeContext = this.getIncludeCallContextAtOffset(filePath, documentText, offset);
    if (!includeContext || includeContext.includeCall.localsMode !== "object") {
      return null;
    }

    const { analysisStart, analysisOffset, includeCall } = includeContext;
    if (
      typeof includeCall.localsObjectStart !== "number" ||
      typeof includeCall.localsObjectEnd !== "number" ||
      analysisOffset < includeCall.localsObjectStart ||
      analysisOffset > includeCall.localsObjectEnd
    ) {
      return null;
    }

    let activeLocal = null;
    for (const local of includeCall.locals || []) {
      if (typeof local.nameStart === "number" && typeof local.nameEnd === "number") {
        if (analysisOffset >= local.nameStart && analysisOffset <= local.nameEnd) {
          activeLocal = local;
          break;
        }
      }
    }

    const isShorthandLikeInsertionPoint =
      !activeLocal &&
      /\b[A-Za-z_$][\w$]*$/.test(includeContext.analysisText.slice(includeCall.localsObjectStart, analysisOffset));

    if (!activeLocal && !isShorthandLikeInsertionPoint) {
      for (const local of includeCall.locals || []) {
        if (
          typeof local.propertyStart === "number" &&
          typeof local.propertyEnd === "number" &&
          analysisOffset >= local.propertyStart &&
          analysisOffset <= local.propertyEnd
        ) {
          return null;
        }
      }
    }

    const contractLocals = this.getIncludeContractLocals(includeContext.targetFilePath, {
      includeBindingTypes: true,
    });
    if (!contractLocals.length) {
      return null;
    }

    const providedNames = new Set(
      (includeCall.locals || [])
        .map((local) => local.name)
        .filter((name) => name && (!activeLocal || name !== activeLocal.name))
    );
    const items = contractLocals
      .filter((local) => !providedNames.has(local.name) || (activeLocal && local.name === activeLocal.name))
      .map((local, index) => ({
        label: local.name,
        insertText: activeLocal ? local.name : `${local.name}: `,
        detail: local.optional ? "Optional include local" : "Required include local",
        documentation: [
          `Partial: ${toPortablePath(path.relative(this.appRoot, includeContext.targetFilePath))}`,
          `Type: ${local.typeText || "any"}`,
        ].join("\n"),
        category: "include-local",
        sortText: `${local.optional ? "1" : "0"}-${String(index).padStart(4, "0")}-${local.name}`,
      }));

    if (!items.length) {
      return null;
    }

    return {
      start: analysisStart + (activeLocal ? activeLocal.nameStart : analysisOffset),
      end: analysisStart + (activeLocal ? activeLocal.nameEnd : analysisOffset),
      items,
    };
  }

  getIncludeSignatureHelp(filePath, documentText, offset) {
    const includeContext = this.getIncludeCallContextAtOffset(filePath, documentText, offset);
    if (!includeContext) {
      return null;
    }

    const contractLocals = this.getIncludeContractLocals(includeContext.targetFilePath, {
      includeBindingTypes: true,
    });
    if (!contractLocals.length) {
      return null;
    }

    const { analysisOffset, includeCall } = includeContext;
    const localsLabel = contractLocals.length
      ? contractLocals
          .map((local) => `${local.name}${local.optional ? "?" : ""}: ${local.typeText || "any"}`)
          .join("; ")
      : "Record<string, any>";
    const activeParameter =
      typeof includeCall.localsStart === "number"
        ? analysisOffset >= includeCall.localsStart
          ? 1
          : 0
        : analysisOffset > includeCall.requestEnd + 1
          ? 1
          : 0;

    return {
      selectedItemIndex: 0,
      argumentIndex: activeParameter,
      items: [
        {
          prefixDisplayParts: toDisplayParts("include("),
          separatorDisplayParts: toDisplayParts(", "),
          suffixDisplayParts: toDisplayParts(")"),
          documentation: toDisplayParts(
            `Partial ${toPortablePath(path.relative(this.appRoot, includeContext.targetFilePath))}`
          ),
          parameters: [
            {
              displayParts: toDisplayParts(`path: ${JSON.stringify(includeCall.requestPath)}`),
              documentation: toDisplayParts("include() target partial path"),
            },
            {
              displayParts: toDisplayParts(`locals: { ${localsLabel} }`),
              documentation: toDisplayParts(
                contractLocals.length
                  ? `Required: ${contractLocals.filter((local) => !local.optional).map((local) => local.name).join(", ") || "none"}\nOptional: ${contractLocals
                      .filter((local) => local.optional)
                      .map((local) => local.name)
                      .join(", ") || "none"}`
                  : "No include locals inferred."
              ),
            },
          ],
        },
      ],
    };
  }

  buildIncludeMissingLocalFix(includeCall, missingNames, documentText) {
    if (!Array.isArray(missingNames) || !missingNames.length || includeCall.hasDynamicLocals) {
      return null;
    }

    const stubText = missingNames.map((name) => `${name}: undefined`).join(", ");
    if (
      includeCall.localsMode === "object" &&
      typeof includeCall.localsObjectEnd === "number"
    ) {
      const objectBodyText = String(documentText || "").slice(includeCall.localsObjectStart, includeCall.localsObjectEnd);
      const hasTrailingComma = /,\s*$/.test(objectBodyText);
      return {
        title: missingNames.length === 1 ? `Add local "${missingNames[0]}"` : "Add missing locals",
        edits: [
          {
            start: includeCall.localsObjectEnd,
            end: includeCall.localsObjectEnd,
            newText:
              includeCall.locals && includeCall.locals.length
                ? `${hasTrailingComma ? " " : ", "}${stubText}`
                : stubText,
          },
        ],
      };
    }

    if (includeCall.localsMode === "none") {
      return {
        title: missingNames.length === 1 ? `Add local "${missingNames[0]}"` : "Add missing locals",
        edits: [
          {
            start: includeCall.callEnd - 1,
            end: includeCall.callEnd - 1,
            newText: `, { ${stubText} }`,
          },
        ],
      };
    }

    return null;
  }

  getIncludeCallerDiagnostics(filePath, documentText) {
    const analysisText = toAnalysisText(filePath, documentText);
    const includeCalls = this.getIncludeCallEntries(filePath, analysisText);
    if (!includeCalls.length) {
      return [];
    }

    const diagnostics = [];
    const contractCache = new Map();

    for (const includeCall of includeCalls) {
      const targetFilePath = this.projectIndex.resolveIncludeTarget(filePath, includeCall.requestPath);
      if (!targetFilePath) {
        continue;
      }

      let contractLocals = contractCache.get(targetFilePath);
      if (!contractLocals) {
        contractLocals = this.getIncludeContractLocals(targetFilePath);
        contractCache.set(targetFilePath, contractLocals);
      }

      if (!contractLocals.length) {
        continue;
      }

      const expectedNames = contractLocals.map((entry) => entry.name);
      const expectedNameSet = new Set(expectedNames);
      const coveredMissingNames = new Set();

      if (includeCall.localsMode === "object") {
        for (const local of includeCall.locals || []) {
          if (POCKETPAGES_GLOBAL_NAMES.has(local.name)) {
            continue;
          }

          if (expectedNameSet.has(local.name)) {
            continue;
          }

          const suggestions = getSuggestedIdentifierCandidates(local.name, expectedNames);
          if (suggestions.length) {
            coveredMissingNames.add(suggestions[0]);
          }

          diagnostics.push({
            code: "pp-include-unknown-local",
            category: ts.DiagnosticCategory.Warning,
            message: suggestions.length
              ? `Unknown local "${local.name}" in include("${includeCall.requestPath}"). Did you mean "${suggestions[0]}"?`
              : `Unknown local "${local.name}" in include("${includeCall.requestPath}").`,
            start: typeof local.nameStart === "number" ? local.nameStart : includeCall.requestStart,
            end: typeof local.nameEnd === "number" ? local.nameEnd : includeCall.requestEnd,
            fixes: suggestions.map((candidateName) => ({
              title: `Rename to "${candidateName}"`,
              edits: [
                {
                  start: typeof local.nameStart === "number" ? local.nameStart : includeCall.requestStart,
                  end: typeof local.nameEnd === "number" ? local.nameEnd : includeCall.requestEnd,
                  newText: candidateName,
                },
              ],
            })),
          });
        }
      }

      if (includeCall.localsMode === "dynamic" || includeCall.hasDynamicLocals) {
        continue;
      }

      const providedNames = new Set((includeCall.locals || []).map((local) => local.name));
      const missingNames = contractLocals
        .filter((entry) => !entry.optional && !providedNames.has(entry.name) && !coveredMissingNames.has(entry.name))
        .map((entry) => entry.name);

      if (!missingNames.length) {
        continue;
      }

      const missingLocalFix = this.buildIncludeMissingLocalFix(includeCall, missingNames, documentText);
      diagnostics.push({
        code: "pp-include-missing-local",
        category: ts.DiagnosticCategory.Warning,
        message:
          missingNames.length === 1
            ? `Missing local "${missingNames[0]}" in include("${includeCall.requestPath}").`
            : `Missing locals in include("${includeCall.requestPath}"): ${missingNames.join(", ")}.`,
        start: includeCall.requestStart,
        end: includeCall.requestEnd,
        fixes: missingLocalFix ? [missingLocalFix] : undefined,
      });
    }

    return diagnostics;
  }

  buildResolveTypePrelude(filePath, analysisText) {
    if (!analysisText) {
      return "";
    }

    const overloadLines = [];

    for (const requestPath of collectResolveRequestPaths(analysisText)) {
      const targetFilePath = this.projectIndex.resolveResolveTarget(filePath, requestPath);
      if (!targetFilePath || !isScriptFile(targetFilePath)) {
        continue;
      }

      overloadLines.push(
        `  (requestPath: ${JSON.stringify(requestPath)}, ...args: any[]): typeof import(${JSON.stringify(normalizePath(targetFilePath))});`
      );
    }

    if (!overloadLines.length) {
      return "";
    }

    return [
      "declare const resolve: ((requestPath: string, ...args: any[]) => any) & {",
      ...overloadLines,
      "};",
    ].join("\n");
  }

  setPreparedDocumentState(filePath, preparedState) {
    this.documentSnapshotManager.setPreparedDocumentState(filePath, preparedState);
  }

  clearPreparedDocumentState(filePath) {
    return this.documentSnapshotManager.clearPreparedDocumentState(filePath);
  }

  getPreparedDocumentState(filePath) {
    return this.documentSnapshotManager.getPreparedDocumentState(filePath);
  }

  upsertVirtualFile(filePath, block, options = {}) {
    this.refreshStaticFiles(options);

    const resolvedPath = normalizePath(filePath);
    const virtualBlockId =
      block && block.stableId !== undefined && block.stableId !== null
        ? String(block.stableId).replace(/[^a-zA-Z0-9_-]/g, "_")
        : String(block.index);
    const virtualFileName = getSourceAdjacentVirtualFilePath(resolvedPath, `block_${virtualBlockId}`);
    const previous = this.virtualFiles.get(virtualFileName);
    const preludeSnapshotKey = this.getPreludeSnapshotKey(resolvedPath, block.content);

    if (
      options.dirty === false &&
      previous &&
      previous.preludeSnapshotKey === preludeSnapshotKey
    ) {
      previous.block = block;
      previous.mappings = Array.isArray(options.mappings)
        ? options.mappings
        : previous.mappings;
      previous.associatedScriptMappings =
        options.associatedScriptMappings instanceof Map
          ? options.associatedScriptMappings
          : previous.associatedScriptMappings instanceof Map
            ? previous.associatedScriptMappings
            : new Map();
      return {
        fileName: virtualFileName,
        preludeLength: previous.preludeLength,
        block,
        reused: true,
      };
    }

    const prelude = this.buildPrelude(resolvedPath, block.content);
    const text = `${prelude}${block.content}`;

    if (!previous || previous.text !== text) {
      this.documentSnapshotManager.setVirtualFileState(virtualFileName, {
        text,
        filePath: resolvedPath,
        blockIndex: block.index,
        preludeLength: prelude.length,
        preludeSnapshotKey,
        block,
        mappings: Array.isArray(options.mappings)
          ? options.mappings
          : [
              {
                sourceOffsets: [block.contentStart],
                generatedOffsets: [0],
                lengths: [block.content.length],
              },
            ],
        associatedScriptMappings:
          options.associatedScriptMappings instanceof Map ? options.associatedScriptMappings : new Map(),
      });
      this.projectVersion += 1;
    } else {
      previous.block = block;
      previous.preludeLength = prelude.length;
      previous.preludeSnapshotKey = preludeSnapshotKey;
      previous.mappings = Array.isArray(options.mappings)
        ? options.mappings
        : previous.mappings;
      previous.associatedScriptMappings =
        options.associatedScriptMappings instanceof Map
          ? options.associatedScriptMappings
          : previous.associatedScriptMappings instanceof Map
            ? previous.associatedScriptMappings
            : new Map();
    }

    return {
      fileName: virtualFileName,
      preludeLength: prelude.length,
      block,
    };
  }

  upsertTemplateVirtualFileState(filePath, templateVirtualText, documentLength, options = {}) {
    this.refreshStaticFiles(options);

    const resolvedPath = normalizePath(filePath);
    const virtualFileName = getSourceAdjacentVirtualFilePath(resolvedPath, "template");
    const previous = this.virtualFiles.get(virtualFileName);
    const preludeSnapshotKey =
      typeof options.preludeSnapshotKey === "string"
        ? options.preludeSnapshotKey
        : this.getPreludeSnapshotKey(resolvedPath, templateVirtualText);

    if (
      options.dirty === false &&
      previous &&
      previous.preludeSnapshotKey === preludeSnapshotKey
    ) {
      previous.documentLength = documentLength;
      previous.mappings = Array.isArray(options.mappings)
        ? options.mappings
        : previous.mappings;
      previous.associatedScriptMappings =
        options.associatedScriptMappings instanceof Map
          ? options.associatedScriptMappings
          : previous.associatedScriptMappings instanceof Map
            ? previous.associatedScriptMappings
            : new Map();
      return {
        fileName: virtualFileName,
        preludeLength: previous.preludeLength,
        reused: true,
      };
    }

    const prelude =
      previous && previous.preludeSnapshotKey === preludeSnapshotKey
        ? previous.text.slice(0, previous.preludeLength)
        : this.buildPrelude(resolvedPath, templateVirtualText);
    const text = `${prelude}${templateVirtualText}`;

    if (!previous || previous.text !== text) {
      this.documentSnapshotManager.setVirtualFileState(virtualFileName, {
        text,
        filePath: resolvedPath,
        preludeLength: prelude.length,
        preludeSnapshotKey,
        templateRegionBlocks: Array.isArray(options.templateRegionBlocks)
          ? options.templateRegionBlocks
          : [],
        kind: "template-document",
        documentLength,
        mappings: Array.isArray(options.mappings)
          ? options.mappings
          : [
              {
                sourceOffsets: [0],
                generatedOffsets: [0],
                lengths: [documentLength],
              },
            ],
        associatedScriptMappings:
          options.associatedScriptMappings instanceof Map ? options.associatedScriptMappings : new Map(),
      });
      this.projectVersion += 1;
    } else {
      previous.preludeLength = prelude.length;
      previous.preludeSnapshotKey = preludeSnapshotKey;
      previous.templateRegionBlocks = Array.isArray(options.templateRegionBlocks)
        ? options.templateRegionBlocks
        : previous.templateRegionBlocks;
      previous.documentLength = documentLength;
      previous.mappings = Array.isArray(options.mappings)
        ? options.mappings
        : previous.mappings;
      previous.associatedScriptMappings =
        options.associatedScriptMappings instanceof Map
          ? options.associatedScriptMappings
          : previous.associatedScriptMappings instanceof Map
            ? previous.associatedScriptMappings
            : new Map();
    }

    return {
      fileName: virtualFileName,
      preludeLength: prelude.length,
    };
  }

  upsertTemplateVirtualFile(filePath, documentText, options = {}) {
    const templateVirtualText = buildTemplateVirtualText(documentText);
    return this.upsertTemplateVirtualFileState(
      filePath,
      templateVirtualText,
      documentText.length,
      options
    );
  }

  upsertScriptVirtualFile(filePath, documentText, options = {}) {
    this.refreshStaticFiles(options);

    const resolvedPath = normalizePath(filePath);
    const virtualFileName = getSourceAdjacentVirtualFilePath(resolvedPath, "script");

    const prelude = this.buildPrelude(resolvedPath, documentText);
    const text = `${prelude}${documentText}`;
    const previous = this.virtualFiles.get(virtualFileName);

    if (!previous || previous.text !== text) {
      this.documentSnapshotManager.setVirtualFileState(virtualFileName, {
        text,
        filePath: resolvedPath,
        preludeLength: prelude.length,
        kind: "script-document",
        documentLength: documentText.length,
        mappings: Array.isArray(options.mappings)
          ? options.mappings
          : [
              {
                sourceOffsets: [0],
                generatedOffsets: [0],
                lengths: [documentText.length],
              },
            ],
        associatedScriptMappings:
          options.associatedScriptMappings instanceof Map ? options.associatedScriptMappings : new Map(),
      });
      this.projectVersion += 1;
    } else {
      previous.preludeLength = prelude.length;
      previous.documentLength = documentText.length;
      previous.mappings = Array.isArray(options.mappings)
        ? options.mappings
        : previous.mappings;
      previous.associatedScriptMappings =
        options.associatedScriptMappings instanceof Map
          ? options.associatedScriptMappings
          : previous.associatedScriptMappings instanceof Map
            ? previous.associatedScriptMappings
            : new Map();
    }

    return {
      fileName: virtualFileName,
      preludeLength: prelude.length,
    };
  }

  syncPreparedDocumentVirtualCode(filePath, documentText, virtualCode, options = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const currentDocumentText = String(documentText || "");
    if (!virtualCode || typeof virtualCode.getEmbeddedCodes !== "function") {
      this.clearPreparedDocumentState(normalizedFilePath);
      return null;
    }

    const documentSnapshot = this.upsertDocumentSnapshot(normalizedFilePath, currentDocumentText, options);
    const snapshotFields = {
      snapshotId: documentSnapshot.snapshotId,
      contentVersion: documentSnapshot.contentVersion,
      lspVersion: documentSnapshot.lspVersion,
    };

    if (isScriptFile(normalizedFilePath)) {
      const scriptVirtual = this.upsertScriptVirtualFile(normalizedFilePath, currentDocumentText, {
        skipStaticRefresh: options.skipStaticRefresh === true,
        mappings: Array.isArray(virtualCode.mappings) ? virtualCode.mappings : undefined,
        associatedScriptMappings:
          virtualCode.associatedScriptMappings instanceof Map
            ? virtualCode.associatedScriptMappings
            : undefined,
      });
      const preparedState = {
        kind: "script",
        filePath: normalizedFilePath,
        ...snapshotFields,
        documentText: currentDocumentText,
        documentLength: currentDocumentText.length,
        script: {
          fileName: scriptVirtual.fileName,
          preludeLength: scriptVirtual.preludeLength,
        },
      };
      this.setPreparedDocumentState(normalizedFilePath, preparedState);
      return preparedState;
    }

    if (!isEjsFile(normalizedFilePath)) {
      this.clearPreparedDocumentState(normalizedFilePath);
      return null;
    }

    const preparedState = {
      kind: "ejs",
      filePath: normalizedFilePath,
      ...snapshotFields,
      documentText: currentDocumentText,
      documentLength: currentDocumentText.length,
      partial: Number.isFinite(Number(options.preferredOffset)) && options.skipUnrelatedRegions === true,
      operation: options.operation || null,
      regionGraph:
        virtualCode && typeof virtualCode.getRegionGraph === "function"
          ? virtualCode.getRegionGraph()
          : null,
      serverBlocks: [],
      template: null,
    };
    const preferredOffset = Number(options.preferredOffset);
    const shouldSkipUnrelatedRegions =
      Number.isFinite(preferredOffset) && options.skipUnrelatedRegions === true;
    const isOffsetInsideBlock = (block) =>
      block &&
      Number.isFinite(block.contentStart) &&
      Number.isFinite(block.contentEnd) &&
      preferredOffset >= block.contentStart &&
      preferredOffset <= block.contentEnd;
    const shouldPrepareEmbeddedCode = (embeddedCode) => {
      if (!shouldSkipUnrelatedRegions) {
        return true;
      }

      const metadata = embeddedCode && embeddedCode.metadata ? embeddedCode.metadata : {};
      if (embeddedCode.kind === "server-script") {
        return (
          Number.isFinite(metadata.sourceStart) &&
          Number.isFinite(metadata.sourceEnd) &&
          preferredOffset >= metadata.sourceStart &&
          preferredOffset <= metadata.sourceEnd
        );
      }

      if (embeddedCode.kind === "template") {
        const templateBlocks = Array.isArray(metadata.templateBlocks)
          ? metadata.templateBlocks
          : [];
        const serverBlocks = options.preferTemplateDocument && Array.isArray(metadata.serverBlocks)
          ? metadata.serverBlocks
          : [];
        return [...templateBlocks, ...serverBlocks].some(isOffsetInsideBlock);
      }

      return true;
    };

    for (const embeddedCode of virtualCode.getEmbeddedCodes()) {
      if (!embeddedCode || !embeddedCode.metadata) {
        continue;
      }
      if (!shouldPrepareEmbeddedCode(embeddedCode)) {
        continue;
      }

      const embeddedText = embeddedCode.snapshot.getText(0, embeddedCode.snapshot.getLength());
      if (embeddedCode.kind === "server-script") {
        const block = {
          index:
            typeof embeddedCode.metadata.blockIndex === "number"
              ? embeddedCode.metadata.blockIndex
              : preparedState.serverBlocks.length,
          fullStart: embeddedCode.metadata.fullStart,
          fullEnd: embeddedCode.metadata.fullEnd,
          contentStart: embeddedCode.metadata.sourceStart,
          contentEnd: embeddedCode.metadata.sourceEnd,
          content: embeddedText,
          stableId: embeddedCode.metadata.stableId,
        };
        const serverVirtual = this.upsertVirtualFile(normalizedFilePath, block, {
          dirty: embeddedCode.metadata.dirty,
          skipStaticRefresh: options.skipStaticRefresh === true,
          mappings: Array.isArray(embeddedCode.mappings) ? embeddedCode.mappings : undefined,
          associatedScriptMappings:
            embeddedCode.associatedScriptMappings instanceof Map
              ? embeddedCode.associatedScriptMappings
              : undefined,
        });
        preparedState.serverBlocks.push({
          index: block.index,
          contentStart: block.contentStart,
          contentEnd: block.contentEnd,
          fileName: serverVirtual.fileName,
          preludeLength: serverVirtual.preludeLength,
        });
        continue;
      }

      if (embeddedCode.kind === "template") {
        const templateVirtual = this.upsertTemplateVirtualFileState(
          normalizedFilePath,
          embeddedText,
          currentDocumentText.length,
          {
            dirty: embeddedCode.metadata.dirty,
            preludeSnapshotKey: this.getTemplatePreludeSnapshotKey(
              normalizedFilePath,
              embeddedCode.metadata
            ),
            templateRegionBlocks: Array.isArray(embeddedCode.metadata.templateRegionBlocks)
              ? embeddedCode.metadata.templateRegionBlocks
              : [],
            skipStaticRefresh: options.skipStaticRefresh === true,
            mappings: Array.isArray(embeddedCode.mappings) ? embeddedCode.mappings : undefined,
            associatedScriptMappings:
              embeddedCode.associatedScriptMappings instanceof Map
                ? embeddedCode.associatedScriptMappings
                : undefined,
          }
        );
        preparedState.template = {
          fileName: templateVirtual.fileName,
          preludeLength: templateVirtual.preludeLength,
          blocks: Array.isArray(embeddedCode.metadata.templateBlocks) ? embeddedCode.metadata.templateBlocks : [],
          regionBlocks: Array.isArray(embeddedCode.metadata.templateRegionBlocks)
            ? embeddedCode.metadata.templateRegionBlocks
            : [],
        };
      }
    }

    this.setPreparedDocumentState(normalizedFilePath, preparedState);
    return preparedState;
  }

  prepareDiagnosticsVirtualState(filePath, documentText, options = {}) {
    const normalizedFilePath = normalizePath(filePath);
    const currentDocumentText = String(documentText || "");
    const preparedState = this.getPreparedDocumentState(normalizedFilePath);

    if (this.isPreparedDocumentStateCurrent(preparedState, normalizedFilePath, currentDocumentText)) {
      return {
        kind: "prepared",
        state: preparedState,
      };
    }

    if (options.requirePreparedVirtualState === true) {
      return {
        kind: preparedState ? "stale-prepared" : "missing-prepared",
        state: null,
      };
    }

    if (!isEjsFile(normalizedFilePath) && !isScriptFile(normalizedFilePath)) {
      return {
        kind: "not-applicable",
        state: null,
      };
    }

    const virtualCode = createVirtualCode(
      URI.file(normalizedFilePath).toString(),
      isEjsFile(normalizedFilePath) ? "ejs" : "javascript",
      1,
      currentDocumentText
    );
    const state = this.syncPreparedDocumentVirtualCode(
      normalizedFilePath,
      currentDocumentText,
      virtualCode,
      options
    );

    return {
      kind: state ? "fallback-prepared" : "missing-prepared",
      state,
    };
  }

  getPreparedServerBlockVirtual(filePath, documentText, block, preparedState = null) {
    if (!block) {
      return null;
    }

    const state = preparedState || this.getPreparedDocumentState(filePath);
    if (
      !state ||
      state.kind !== "ejs" ||
      !this.isPreparedDocumentStateCurrent(state, filePath, documentText)
    ) {
      return null;
    }

    const preparedBlock = (state.serverBlocks || []).find((entry) =>
      entry &&
      entry.index === block.index &&
      entry.contentStart === block.contentStart &&
      entry.contentEnd === block.contentEnd
    );
    if (!preparedBlock || !preparedBlock.fileName) {
      return null;
    }

    if (!this.virtualFiles.has(preparedBlock.fileName)) {
      return null;
    }

    return {
      fileName: preparedBlock.fileName,
      preludeLength: preparedBlock.preludeLength,
      block,
    };
  }

  getPreparedTemplateVirtual(filePath, documentText, preparedState = null) {
    const state = preparedState || this.getPreparedDocumentState(filePath);
    if (
      !state ||
      state.kind !== "ejs" ||
      !this.isPreparedDocumentStateCurrent(state, filePath, documentText) ||
      !state.template ||
      !state.template.fileName
    ) {
      return null;
    }

    if (!this.virtualFiles.has(state.template.fileName)) {
      return null;
    }

    return {
      fileName: state.template.fileName,
      preludeLength: state.template.preludeLength,
    };
  }

  getPreparedVirtualStateAtOffset(filePath, documentText, offset, options = {}) {
    const preparedState = this.getPreparedDocumentState(filePath);
    if (!preparedState) {
      return null;
    }

    if (!this.isPreparedDocumentStateCurrent(preparedState, filePath, documentText)) {
      return null;
    }

    const preferTemplateDocument = !!(options && options.preferTemplateDocument);

    if (preparedState.kind === "script" && preparedState.script) {
      return {
        block: null,
        virtual: {
          fileName: preparedState.script.fileName,
          preludeLength: preparedState.script.preludeLength,
        },
        virtualOffset: preparedState.script.preludeLength + offset,
      };
    }

    if (preparedState.kind !== "ejs") {
      return null;
    }

    const isServerOffset = (preparedState.serverBlocks || []).some(
      (block) => offset >= block.contentStart && offset <= block.contentEnd
    );
    const isTemplateOffset =
      !!preparedState.template &&
      (preparedState.template.blocks || []).some(
        (block) => offset >= block.contentStart && offset <= block.contentEnd
      );

    if (preferTemplateDocument && preparedState.template && (isServerOffset || isTemplateOffset)) {
      return {
        block: null,
        virtual: {
          fileName: preparedState.template.fileName,
          preludeLength: preparedState.template.preludeLength,
        },
        virtualOffset: preparedState.template.preludeLength + offset,
      };
    }

    for (const block of preparedState.serverBlocks || []) {
      if (offset >= block.contentStart && offset <= block.contentEnd) {
        return {
          block,
          virtual: {
            fileName: block.fileName,
            preludeLength: block.preludeLength,
          },
          virtualOffset: block.preludeLength + (offset - block.contentStart),
        };
      }
    }

    if (
      preparedState.template &&
      (preparedState.template.blocks || []).some((block) => offset >= block.contentStart && offset <= block.contentEnd)
    ) {
      return {
        block: null,
        virtual: {
          fileName: preparedState.template.fileName,
          preludeLength: preparedState.template.preludeLength,
        },
        virtualOffset: preparedState.template.preludeLength + offset,
      };
    }

    return null;
  }

  mapVirtualStateOffsetToDocumentOffset(state, offset) {
    if (!state || typeof offset !== "number") {
      return null;
    }

    if (offset < state.preludeLength) {
      return null;
    }

    const relativeOffset = offset - state.preludeLength;
    const linkedMappings =
      state.associatedScriptMappings instanceof Map
        ? state.associatedScriptMappings.get("root")
        : null;
    const mappedLinkedOffset = mapGeneratedOffsetToSourceOffset(linkedMappings, relativeOffset);
    if (mappedLinkedOffset !== null) {
      return mappedLinkedOffset;
    }

    const mappedOffset = mapGeneratedOffsetToSourceOffset(state.mappings, relativeOffset);
    if (mappedOffset !== null) {
      return mappedOffset;
    }

    if (state.kind === "template-document" || state.kind === "script-document") {
      if (relativeOffset < 0 || relativeOffset > state.documentLength) {
        return null;
      }

      return relativeOffset;
    }

    return state.block.contentStart + relativeOffset;
  }

  mapVirtualOffsetToDocumentOffset(virtualFileName, offset) {
    const state = this.virtualFiles.get(virtualFileName);
    if (!state) {
      return null;
    }

    return this.mapVirtualStateOffsetToDocumentOffset(state, offset);
  }

  getDocumentTextForTarget(filePath, currentFilePath, currentDocumentText) {
    if (normalizePath(filePath) === normalizePath(currentFilePath)) {
      return currentDocumentText;
    }

    const text = this.readFile(filePath);
    return typeof text === "string" ? text : null;
  }

  toOffsetDefinitionTarget(filePath, documentText, offset) {
    if (typeof documentText !== "string" || typeof offset !== "number" || offset < 0) {
      return null;
    }

    const { line, character } = getLineAndCharacterFromText(documentText, offset);
    return {
      filePath: normalizePath(filePath),
      line,
      character,
    };
  }

  mapTypeScriptDefinitionToTarget(currentFilePath, currentDocumentText, definitionInfo) {
    if (!definitionInfo || !definitionInfo.fileName || !definitionInfo.textSpan) {
      return null;
    }

    const definitionFileName = normalizePath(definitionInfo.fileName);
    const virtualState = this.virtualFiles.get(definitionFileName);

    if (virtualState) {
      const targetOffset = this.mapVirtualOffsetToDocumentOffset(definitionFileName, definitionInfo.textSpan.start);
      if (targetOffset === null) {
        return null;
      }

      const targetDocumentText = this.getDocumentTextForTarget(
        virtualState.filePath,
        currentFilePath,
        currentDocumentText
      );
      if (targetDocumentText === null) {
        return null;
      }

      return this.toOffsetDefinitionTarget(virtualState.filePath, targetDocumentText, targetOffset);
    }

    const targetDocumentText = this.getDocumentTextForTarget(definitionFileName, currentFilePath, currentDocumentText);
    if (targetDocumentText === null) {
      return null;
    }

    return this.toOffsetDefinitionTarget(definitionFileName, targetDocumentText, definitionInfo.textSpan.start);
  }

  getTypeScriptDefinitionTarget(filePath, documentText, offset, options = {}) {
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset, {
      preferTemplateDocument: true,
      requirePreparedVirtualState: options.requirePreparedVirtualState === true,
    });
    if (!virtualState) {
      return null;
    }

    const definitions =
      this.languageService.getDefinitionAtPosition(virtualState.virtual.fileName, virtualState.virtualOffset) || [];

    if (!definitions.length) {
      return null;
    }

    const currentFilePath = normalizePath(filePath);
    const rankedDefinitions = definitions.slice().sort((left, right) => {
      const leftIsCurrent = normalizePath(left.fileName) === currentFilePath ? 0 : 1;
      const rightIsCurrent = normalizePath(right.fileName) === currentFilePath ? 0 : 1;

      if (leftIsCurrent !== rightIsCurrent) {
        return leftIsCurrent - rightIsCurrent;
      }

      return left.textSpan.start - right.textSpan.start;
    });

    for (const definition of rankedDefinitions) {
      const target = this.mapTypeScriptDefinitionToTarget(filePath, documentText, definition);
      if (target) {
        return target;
      }
    }

    return null;
  }

  mapTypeScriptReferenceToLocation(referenceEntry, isDefinition = false) {
    if (!referenceEntry || !referenceEntry.fileName || !referenceEntry.textSpan) {
      return null;
    }

    const referenceFileName = normalizePath(referenceEntry.fileName);
    const virtualState = this.virtualFiles.get(referenceFileName);
    if (virtualState) {
      const start = this.mapVirtualOffsetToDocumentOffset(referenceFileName, referenceEntry.textSpan.start);
      const end = this.mapVirtualOffsetToDocumentOffset(
        referenceFileName,
        referenceEntry.textSpan.start + referenceEntry.textSpan.length
      );
      if (start === null || end === null) {
        return null;
      }

      return {
        filePath: normalizePath(virtualState.filePath),
        start,
        end,
        isDefinition,
      };
    }

    return {
      filePath: referenceFileName,
      start: referenceEntry.textSpan.start,
      end: referenceEntry.textSpan.start + referenceEntry.textSpan.length,
      isDefinition,
    };
  }

  getTypeScriptReferenceTargets(filePath, documentText, offset, options = {}) {
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset, {
      preferTemplateDocument: true,
      requirePreparedVirtualState: options.requirePreparedVirtualState === true,
    });
    if (!virtualState) {
      return null;
    }

    const referencedSymbols = this.languageService.findReferences(virtualState.virtual.fileName, virtualState.virtualOffset) || [];
    if (!referencedSymbols.length) {
      return null;
    }

    const uniqueLocations = new Map();
    let hasMappedDefinition = false;
    let hasExternalReference = false;
    for (const referencedSymbol of referencedSymbols) {
      const definition = this.mapTypeScriptReferenceToLocation(referencedSymbol.definition, true);
      const definitionKey = definition ? `${definition.filePath}:${definition.start}:${definition.end}` : null;
      if (definition) {
        hasMappedDefinition = true;
        if (normalizePath(definition.filePath) !== normalizePath(filePath)) {
          hasExternalReference = true;
        }

        if (options.includeDeclaration && !uniqueLocations.has(definitionKey)) {
          uniqueLocations.set(definitionKey, {
            filePath: definition.filePath,
            start: definition.start,
            end: definition.end,
          });
        }
      }

      for (const reference of referencedSymbol.references || []) {
        const location = this.mapTypeScriptReferenceToLocation(reference, false);
        if (!location) {
          continue;
        }

        if (normalizePath(location.filePath) !== normalizePath(filePath)) {
          hasExternalReference = true;
        }

        const locationKey = `${location.filePath}:${location.start}:${location.end}`;
        if (locationKey === definitionKey && !options.includeDeclaration) {
          continue;
        }

        if (!uniqueLocations.has(locationKey)) {
          uniqueLocations.set(locationKey, {
            filePath: location.filePath,
            start: location.start,
            end: location.end,
          });
        }
      }
    }

    return {
      locations: [...uniqueLocations.values()],
      hasMappedDefinition,
      hasExternalReference,
    };
  }

  getVirtualStateAtOffset(filePath, documentText, offset, options = {}) {
    const profile = options && typeof options === "object" ? options.profile : null;
    const preferTemplateDocument = !!(options && options.preferTemplateDocument);
    const startedAt = profile ? process.hrtime.bigint() : null;
    const preparedVirtualState = this.getPreparedVirtualStateAtOffset(filePath, documentText, offset, options);
    if (preparedVirtualState) {
      if (profile && startedAt) {
        profile.upsertKind =
          preparedVirtualState.block && typeof preparedVirtualState.block.index === "number"
            ? "server-block-prepared"
            : isScriptFile(filePath)
              ? "script-prepared"
              : "template-prepared";
        profile.upsertMs = 0;
        profile.getVirtualStateAtOffsetMs = elapsedMilliseconds(startedAt);
      }

      return preparedVirtualState;
    }

    if (options.requirePreparedVirtualState === true) {
      if (profile && startedAt) {
        profile.upsertKind = "missing-prepared";
        profile.upsertMs = 0;
        profile.getVirtualStateAtOffsetMs = elapsedMilliseconds(startedAt);
      }

      return null;
    }

    if (isScriptFile(filePath)) {
      const upsertStartedAt = profile ? process.hrtime.bigint() : null;
      const virtual = this.upsertScriptVirtualFile(filePath, documentText);
      if (profile && upsertStartedAt) {
        profile.upsertKind = "script";
        profile.upsertMs = elapsedMilliseconds(upsertStartedAt);
        profile.getVirtualStateAtOffsetMs = elapsedMilliseconds(startedAt);
      }

      return {
        block: null,
        virtual,
        virtualOffset: virtual.preludeLength + offset,
      };
    }

    const block = getServerBlockAtOffset(documentText, offset);
    const templateCodeBlock = getTemplateCodeBlockAtOffset(documentText, offset);
    const upsertStartedAt = profile ? process.hrtime.bigint() : null;
    const shouldUseTemplateVirtual = preferTemplateDocument && (block || templateCodeBlock);
    const virtual = shouldUseTemplateVirtual
      ? this.upsertTemplateVirtualFile(filePath, documentText)
      : block
        ? this.upsertVirtualFile(filePath, block)
        : templateCodeBlock
          ? this.upsertTemplateVirtualFile(filePath, documentText)
          : null;

    if (!virtual) {
      if (profile && startedAt) {
        profile.upsertKind = "none";
        profile.upsertMs = upsertStartedAt ? elapsedMilliseconds(upsertStartedAt) : 0;
        profile.getVirtualStateAtOffsetMs = elapsedMilliseconds(startedAt);
      }
      return null;
    }

    if (profile && startedAt) {
      profile.upsertKind = shouldUseTemplateVirtual ? "template" : block ? "server-block" : "template";
      profile.upsertMs = upsertStartedAt ? elapsedMilliseconds(upsertStartedAt) : 0;
      profile.getVirtualStateAtOffsetMs = elapsedMilliseconds(startedAt);
    }

    return {
      block: shouldUseTemplateVirtual ? null : block,
      virtual,
      virtualOffset:
        shouldUseTemplateVirtual || !block
          ? virtual.preludeLength + offset
          : virtual.preludeLength + (offset - block.contentStart),
    };
  }

  getResolvedModuleMemberContextForRename(filePath, documentText, offset) {
    if (isEjsFile(filePath)) {
      const block = getServerBlockAtOffset(documentText, offset);
      const templateCodeBlock = getTemplateCodeBlockAtOffset(documentText, offset);
      if (!block && !templateCodeBlock) {
        return null;
      }

      const analysisText = block ? block.content : buildTemplateVirtualText(documentText);
      const analysisOffset = block ? offset - block.contentStart : offset;
      const resolvedModuleMemberContext = getResolvedModuleMemberContext(analysisText, analysisOffset);
      if (!resolvedModuleMemberContext) {
        return null;
      }

      return {
        ...resolvedModuleMemberContext,
        source: "resolved-module-member",
        start: block ? block.contentStart + resolvedModuleMemberContext.start : resolvedModuleMemberContext.start,
        end: block ? block.contentStart + resolvedModuleMemberContext.end : resolvedModuleMemberContext.end,
      };
    }

    if (!isScriptFile(filePath)) {
      return null;
    }

    const resolvedModuleMemberContext = getResolvedModuleMemberContext(documentText, offset);
    if (!resolvedModuleMemberContext) {
      return null;
    }

    return {
      ...resolvedModuleMemberContext,
      source: "resolved-module-member",
    };
  }

  getModuleExportRenameContext(filePath, documentText, offset) {
    if (!isScriptFile(filePath)) {
      return null;
    }

    const exportedMembers = this.projectIndex.getModuleExportedMembers(filePath, documentText);
    if (!exportedMembers.length) {
      return null;
    }

    for (const exportedMember of exportedMembers) {
      if (offset >= exportedMember.start && offset <= exportedMember.end) {
        return {
          source: "module-export",
          start: exportedMember.start,
          end: exportedMember.end,
          placeholder: exportedMember.memberName,
          moduleDefinitionInfo: exportedMember,
        };
      }
    }

    this.upsertStaticFileText(filePath, documentText);

    const renameInfo = this.languageService.getRenameInfo(filePath, offset, {
      allowRenameOfImportPath: false,
    });
    if (!renameInfo || !renameInfo.canRename) {
      return null;
    }

    const locations = this.languageService.findRenameLocations(filePath, offset, false, false, {}) || [];
    for (const exportedMember of exportedMembers) {
      const hasDefinitionLocation = locations.some(
        (location) =>
          normalizePath(location.fileName) === normalizePath(filePath) &&
          location.textSpan.start <= exportedMember.start &&
          location.textSpan.start + location.textSpan.length >= exportedMember.end
      );

      if (hasDefinitionLocation) {
        return {
          source: "module-export",
          start: exportedMember.start,
          end: exportedMember.end,
          placeholder: exportedMember.memberName,
          moduleDefinitionInfo: exportedMember,
        };
      }
    }

    return null;
  }

  getModuleRenameLocations(moduleDefinitionInfo, overrides = {}) {
    const overrideText = overrides[normalizePath(moduleDefinitionInfo.filePath)];
    if (typeof overrideText === "string") {
      this.upsertStaticFileText(moduleDefinitionInfo.filePath, overrideText);
    } else {
      this.ensureStaticFile(moduleDefinitionInfo.filePath);
    }

    const renameInfo = this.languageService.getRenameInfo(moduleDefinitionInfo.filePath, moduleDefinitionInfo.start, {
      allowRenameOfImportPath: false,
    });
    if (!renameInfo || !renameInfo.canRename) {
      return {
        canRename: false,
        localizedErrorMessage: renameInfo && renameInfo.localizedErrorMessage,
        locations: [],
      };
    }

    const locations =
      this.languageService.findRenameLocations(
        moduleDefinitionInfo.filePath,
        moduleDefinitionInfo.start,
        false,
        false,
        {}
      ) || [];

    return {
      canRename: true,
      locations,
    };
  }

  resolvePathContextTarget(filePath, pathContext) {
    if (!pathContext) {
      return null;
    }

    if (pathContext.kind === "resolve-path") {
      return this.projectIndex.resolveResolveTarget(filePath, pathContext.value);
    }

    if (pathContext.kind === "include-path") {
      return this.projectIndex.resolveIncludeTarget(filePath, pathContext.value);
    }

    if (pathContext.kind === "asset-path") {
      return this.projectIndex.resolveAssetTarget(filePath, pathContext.value);
    }

    if (pathContext.kind === "route-path") {
      return this.projectIndex.resolveRouteTarget(filePath, pathContext.value, {
        routeSource: pathContext.routeSource,
      });
    }

    return null;
  }

  getPathReferenceContext(filePath, documentText, offset) {
    const pathContext = getPathContextAtOffset(documentText, offset, { filePath });
    if (!pathContext) {
      return null;
    }

    const targetFilePath = this.resolvePathContextTarget(filePath, pathContext);
    if (!targetFilePath) {
      return null;
    }

    return {
      ...pathContext,
      targetFilePath: normalizePath(targetFilePath),
    };
  }

  getPathTargetInfo(filePath, documentText, offset) {
    const pathReferenceContext = this.getPathReferenceContext(filePath, documentText, offset);
    if (pathReferenceContext) {
      return pathReferenceContext;
    }

    const requireContext = getRequirePathContextAtOffset(documentText, offset, { filePath });
    if (!requireContext) {
      return null;
    }

    const targetFilePath = this.projectIndex.resolveRequireTarget(filePath, requireContext.value, requireContext);
    if (!targetFilePath) {
      return null;
    }

    return {
      ...requireContext,
      targetFilePath: normalizePath(targetFilePath),
    };
  }

  getPrivateIncludeReferenceContext(filePath) {
    if (!isEjsFile(filePath) || !isPrivatePagesFile(filePath)) {
      return null;
    }

    return {
      kind: "include-path",
      targetFilePath: normalizePath(filePath),
    };
  }

  getFileReferenceQuery(filePath) {
    const normalizedFilePath = normalizePath(filePath);

    if (isPrivatePagesFile(normalizedFilePath)) {
      if (isEjsFile(normalizedFilePath)) {
        return {
          kind: "private-partial",
          targetFilePath: normalizedFilePath,
          command: "pocketpagesServerScript.allFileReferences",
          title: "PocketPages: All File References",
          emptyMessage: "No include() callers found for this partial.",
        };
      }

      if (isScriptFile(normalizedFilePath)) {
        return {
          kind: "private-module",
          targetFilePath: normalizedFilePath,
          command: "pocketpagesServerScript.allFileReferences",
          title: "PocketPages: All File References",
          emptyMessage: "No resolve() or require() callers found for this module.",
        };
      }
    }

    const assetDescriptor = this.projectIndex.getAssetDescriptorByFilePath(normalizedFilePath);
    if (assetDescriptor) {
      return {
        kind: "asset-file",
        targetFilePath: normalizedFilePath,
        command: "pocketpagesServerScript.allFileReferences",
        title: "PocketPages: All File References",
        emptyMessage: `No asset() callers found for ${assetDescriptor.relativePath}.`,
        assetPath: `/${assetDescriptor.relativePath}`,
      };
    }

    const routeEntry = this.projectIndex.getStaticRouteEntryByFilePath(normalizedFilePath);
    if (routeEntry) {
      return {
        kind: "route-file",
        targetFilePath: normalizedFilePath,
        command: "pocketpagesServerScript.allFileReferences",
        title: "PocketPages: All File References",
        emptyMessage: `No callers found for route ${routeEntry.routePath}.`,
        routePath: routeEntry.routePath,
        routeMethod: routeEntry.method || "PAGE",
      };
    }

    const routeDescriptor = this.projectIndex.describeRouteFilePath(normalizedFilePath);
    if (!routeDescriptor) {
      return null;
    }

    return {
      kind: "route-file",
      targetFilePath: normalizedFilePath,
      command: "pocketpagesServerScript.allFileReferences",
      title: "PocketPages: All File References",
      emptyMessage: `No callers found for route ${routeDescriptor.routePath}.`,
      routePath: routeDescriptor.routePath,
      routeMethod: routeDescriptor.method || "PAGE",
    };
  }

  collectPathReferenceLocations(pathKind, targetFilePath, overrides = {}) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const uniqueLocations = new Map();

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const codeFilePath = normalizePath(entry.filePath);
      const documentText =
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : this.getDocumentText(codeFilePath);

      for (const pathContext of collectPathContexts(documentText, { filePath: codeFilePath })) {
        if (pathContext.kind !== pathKind) {
          continue;
        }

        const resolvedTargetFilePath = this.resolvePathContextTarget(codeFilePath, pathContext);
        if (!resolvedTargetFilePath || normalizePath(resolvedTargetFilePath) !== normalizedTargetFilePath) {
          continue;
        }

        const locationKey = `${codeFilePath}:${pathContext.start}:${pathContext.end}`;
        if (!uniqueLocations.has(locationKey)) {
          uniqueLocations.set(locationKey, {
            filePath: codeFilePath,
            start: pathContext.start,
            end: pathContext.end,
          });
        }
      }
    }

    return [...uniqueLocations.values()];
  }

  collectRequireReferenceLocations(targetFilePath, overrides = {}) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const uniqueLocations = new Map();

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const codeFilePath = normalizePath(entry.filePath);
      const documentText =
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : this.getDocumentText(codeFilePath);

      for (const requireContext of collectStaticRequireCallContexts(documentText, { filePath: codeFilePath })) {
        const resolvedTargetFilePath = this.projectIndex.resolveRequireTarget(codeFilePath, requireContext.value, requireContext);
        if (!resolvedTargetFilePath || normalizePath(resolvedTargetFilePath) !== normalizedTargetFilePath) {
          continue;
        }

        const locationKey = `${codeFilePath}:${requireContext.start}:${requireContext.end}`;
        if (!uniqueLocations.has(locationKey)) {
          uniqueLocations.set(locationKey, {
            filePath: codeFilePath,
            start: requireContext.start,
            end: requireContext.end,
          });
        }
      }
    }

    return [...uniqueLocations.values()];
  }

  mergeReferenceLocations(...referenceGroups) {
    const uniqueLocations = new Map();

    for (const group of referenceGroups) {
      for (const location of group || []) {
        const locationKey = `${normalizePath(location.filePath)}:${location.start}:${location.end}`;
        if (!uniqueLocations.has(locationKey)) {
          uniqueLocations.set(locationKey, {
            filePath: normalizePath(location.filePath),
            start: location.start,
            end: location.end,
          });
        }
      }
    }

    return [...uniqueLocations.values()];
  }

  getFileReferenceTargets(filePath, documentText, _options = {}) {
    const referenceQuery = this.getFileReferenceQuery(filePath);
    if (!referenceQuery) {
      return null;
    }

    const overrides = this.getPagesCodeOverrides({
      [normalizePath(filePath)]: documentText,
    });

    if (referenceQuery.kind === "private-partial") {
      return this.collectPathReferenceLocations("include-path", referenceQuery.targetFilePath, overrides);
    }

    if (referenceQuery.kind === "private-module") {
      return this.mergeReferenceLocations(
        this.collectPathReferenceLocations("resolve-path", referenceQuery.targetFilePath, overrides),
        this.collectRequireReferenceLocations(referenceQuery.targetFilePath, overrides)
      );
    }

    if (referenceQuery.kind === "asset-file") {
      return this.collectPathReferenceLocations("asset-path", referenceQuery.targetFilePath, overrides);
    }

    if (referenceQuery.kind === "route-file") {
      return this.collectPathReferenceLocations("route-path", referenceQuery.targetFilePath, overrides);
    }

    return null;
  }

  getFileRenameEdits(oldFilePath, newFilePath) {
    const referenceQuery = this.getFileReferenceQuery(oldFilePath);
    if (!referenceQuery) {
      return [];
    }

    const normalizedOldFilePath = normalizePath(oldFilePath);
    const normalizedNewFilePath = normalizePath(newFilePath);
    const overrides = this.getPagesCodeOverrides();
    const uniqueEdits = new Map();

    if (referenceQuery.kind === "private-partial") {
      for (const edit of this.getIncludeFileRenameEdits(normalizedOldFilePath, normalizedNewFilePath, overrides)) {
        uniqueEdits.set(`${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`, edit);
      }
    }

    if (referenceQuery.kind === "private-module") {
      for (const edit of this.getResolveFileRenameEdits(normalizedOldFilePath, normalizedNewFilePath, overrides)) {
        uniqueEdits.set(`${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`, edit);
      }

      for (const edit of this.getRequireFileRenameEdits(normalizedOldFilePath, normalizedNewFilePath, overrides)) {
        uniqueEdits.set(`${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`, edit);
      }
    }

    if (referenceQuery.kind === "asset-file") {
      for (const edit of this.getAssetFileRenameEdits(normalizedOldFilePath, normalizedNewFilePath, overrides)) {
        uniqueEdits.set(`${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`, edit);
      }
    }

    if (referenceQuery.kind === "route-file") {
      const oldRouteDescriptor = this.projectIndex.describeRouteFilePath(normalizedOldFilePath);
      const newRouteDescriptor = this.projectIndex.describeRouteFilePath(normalizedNewFilePath);
      const oldRouteMethod = normalizeRouteMethod(referenceQuery.routeMethod);
      if (
        oldRouteDescriptor &&
        newRouteDescriptor &&
        normalizeRouteMethod(oldRouteDescriptor.method) === oldRouteMethod &&
        normalizeRouteMethod(newRouteDescriptor.method) === oldRouteMethod
      ) {
        for (const edit of this.getRouteFileRenameEdits({
          oldFilePath: normalizedOldFilePath,
          oldRouteDescriptor,
          oldRoutePath: referenceQuery.routePath,
          oldRouteMethod,
          newRouteDescriptor,
          newRoutePath: newRouteDescriptor.routePath,
        }, overrides)) {
          uniqueEdits.set(`${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`, edit);
        }
      }
    }

    this.projectIndex.invalidateStructureForFile(normalizedOldFilePath);
    this.projectIndex.invalidateStructureForFile(normalizedNewFilePath);

    return [...uniqueEdits.values()];
  }

  getFileSymbolMetadata(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    const appRelativePath = toPortablePath(path.relative(this.appRoot, normalizedFilePath));
    const routeDescriptor = this.projectIndex.getRouteDescriptorByFilePath(normalizedFilePath);
    if (routeDescriptor) {
      return {
        containerName: "Routes",
        detail: appRelativePath,
        kind: "file",
        name:
          routeDescriptor.method && routeDescriptor.method !== "PAGE"
            ? `Route ${routeDescriptor.method} ${routeDescriptor.routePath}`
            : `Route ${routeDescriptor.routePath}`,
      };
    }

    const assetDescriptor = this.projectIndex.getAssetDescriptorByFilePath(normalizedFilePath);
    if (assetDescriptor) {
      return {
        containerName: "Assets",
        detail: assetDescriptor.relativePath,
        kind: "file",
        name: `Asset /${assetDescriptor.relativePath}`,
      };
    }

    if (isPrivatePagesFile(normalizedFilePath)) {
      const baseName = path.basename(normalizedFilePath);
      return {
        containerName: isEjsFile(normalizedFilePath) ? "Partials" : "Modules",
        detail: appRelativePath,
        kind: isEjsFile(normalizedFilePath) ? "file" : "module",
        name: isEjsFile(normalizedFilePath)
          ? `Partial ${baseName}`
          : `Module ${baseName}`,
      };
    }

    if (isScriptFile(normalizedFilePath) && path.basename(normalizedFilePath).startsWith("+")) {
      return {
        containerName: "Hooks",
        detail: appRelativePath,
        kind: "module",
        name: `Hook ${path.basename(normalizedFilePath)}`,
      };
    }

    return null;
  }

  getTemplateDocumentSymbolEntry(documentText, serverBlocks = []) {
    const exclusionRanges = (Array.isArray(serverBlocks) ? serverBlocks : [])
      .map((block) => ({
        start: Math.max(0, Number(block && block.fullStart) || 0),
        end: Math.max(0, Number(block && block.fullEnd) || 0),
      }))
      .filter((range) => range.end > range.start)
      .sort((left, right) => left.start - right.start);
    const sourceText = String(documentText || "");
    let exclusionIndex = 0;
    let templateStart = null;
    let templateEnd = null;

    for (let index = 0; index < sourceText.length; index += 1) {
      while (
        exclusionIndex < exclusionRanges.length &&
        index >= exclusionRanges[exclusionIndex].end
      ) {
        exclusionIndex += 1;
      }

      if (
        exclusionIndex < exclusionRanges.length &&
        index >= exclusionRanges[exclusionIndex].start &&
        index < exclusionRanges[exclusionIndex].end
      ) {
        continue;
      }

      if (!/\S/.test(sourceText[index])) {
        continue;
      }

      if (templateStart === null) {
        templateStart = index;
      }
      templateEnd = index + 1;
    }

    if (templateStart === null || templateEnd === null) {
      return null;
    }

    return {
      children: [],
      detail: "HTML / EJS template",
      end: templateEnd,
      kind: "namespace",
      name: "Template",
      selectionEnd: templateStart + 1,
      selectionStart: templateStart,
      start: templateStart,
    };
  }

  getDocumentSymbolEntries(filePath, documentText) {
    if (!isEjsFile(filePath)) {
      return [];
    }

    const symbolMetadata = this.getFileSymbolMetadata(filePath) || {
      containerName: "Documents",
      detail: toPortablePath(path.relative(this.appRoot, filePath)),
      kind: "file",
      name: path.basename(filePath),
    };
    const sourceText = String(documentText || "");
    const serverBlocks = _extractServerBlocks(sourceText);
    const childSymbols = [];

    for (const block of serverBlocks) {
      const contentSelectionStart =
        typeof block.contentStart === "number" && block.contentStart < sourceText.length
          ? block.contentStart
          : Math.max(0, Number(block.fullStart) || 0);
      childSymbols.push({
        children: [],
        detail: "<script server>",
        end: Math.max(contentSelectionStart + 1, Number(block.fullEnd) || contentSelectionStart + 1),
        kind: "namespace",
        name: serverBlocks.length > 1 ? `Server ${block.index + 1}` : "Server",
        selectionEnd: contentSelectionStart + 1,
        selectionStart: contentSelectionStart,
        start: Math.max(0, Number(block.fullStart) || 0),
      });
    }

    const templateSymbolEntry = this.getTemplateDocumentSymbolEntry(sourceText, serverBlocks);
    if (templateSymbolEntry) {
      childSymbols.push(templateSymbolEntry);
    }

    for (const pathContext of collectPathContexts(sourceText, { filePath })) {
      if (pathContext.kind !== "include-path") {
        continue;
      }

      const targetFilePath = this.projectIndex.resolveIncludeTarget(filePath, pathContext.value);
      childSymbols.push({
        children: [],
        detail: targetFilePath
          ? toPortablePath(path.relative(this.appRoot, targetFilePath))
          : pathContext.value,
        end: pathContext.end,
        kind: "string",
        name: `Include ${path.basename(pathContext.value) || pathContext.value}`,
        selectionEnd: pathContext.end,
        selectionStart: pathContext.start,
        start: pathContext.start,
      });
    }

    childSymbols.sort((left, right) => {
      if (left.start !== right.start) {
        return left.start - right.start;
      }

      return left.end - right.end;
    });

    return [
      {
        children: childSymbols,
        detail: symbolMetadata.detail,
        end: Math.max(sourceText.length, 1),
        kind: symbolMetadata.kind,
        name: symbolMetadata.name,
        selectionEnd: Math.min(Math.max(sourceText.length, 1), 1),
        selectionStart: 0,
        start: 0,
      },
    ];
  }

  getWorkspaceSymbolEntries(query = "") {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const uniqueEntries = new Map();

    for (const entry of this.projectIndex.getPagesGraphState().allFiles) {
      const symbolMetadata = this.getFileSymbolMetadata(entry.filePath);
      if (!symbolMetadata) {
        continue;
      }

      const searchableText = [
        symbolMetadata.name,
        symbolMetadata.detail,
        symbolMetadata.containerName,
        toPortablePath(path.relative(this.appRoot, entry.filePath)),
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (normalizedQuery && !searchableText.includes(normalizedQuery)) {
        continue;
      }

      const entryKey = `${normalizePath(entry.filePath)}:${symbolMetadata.name}`;
      if (uniqueEntries.has(entryKey)) {
        continue;
      }

      uniqueEntries.set(entryKey, {
        containerName: symbolMetadata.containerName,
        detail: symbolMetadata.detail,
        end: 0,
        filePath: normalizePath(entry.filePath),
        kind: symbolMetadata.kind,
        name: symbolMetadata.name,
        selectionEnd: 0,
        selectionStart: 0,
        start: 0,
      });
    }

    return [...uniqueEntries.values()].sort((left, right) => {
      if (left.name !== right.name) {
        return left.name.localeCompare(right.name);
      }

      return left.filePath.localeCompare(right.filePath);
    });
  }

  getCallerDocumentText(filePath, overrides = {}) {
    const normalizedFilePath = normalizePath(filePath);
    if (Object.prototype.hasOwnProperty.call(overrides, normalizedFilePath)) {
      return overrides[normalizedFilePath];
    }

    const documentText = this.getDocumentText(normalizedFilePath);
    overrides[normalizedFilePath] = documentText;
    return documentText;
  }

  getIncludeFileRenameEdits(oldTargetFilePath, newTargetFilePath, overrides = {}) {
    const edits = [];
    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
      const documentText = this.getCallerDocumentText(filePath, overrides);
      const pathContexts = collectPathContexts(documentText, { filePath });

      for (const pathContext of pathContexts) {
        if (pathContext.kind !== "include-path") {
          continue;
        }

        if (!this.isIncludeRequestForTarget(filePath, pathContext.value, oldTargetFilePath)) {
          continue;
        }

        const newValue = this.buildUpdatedIncludeRequestPath(filePath, pathContext.value, oldTargetFilePath, newTargetFilePath);
        if (!newValue || newValue === pathContext.value) {
          continue;
        }

        edits.push({
          filePath,
          start: pathContext.start,
          end: pathContext.end,
          newText: newValue,
        });
      }
    }

    return edits;
  }

  getResolveFileRenameEdits(oldTargetFilePath, newTargetFilePath, overrides = {}) {
    const edits = [];
    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
      const documentText = this.getCallerDocumentText(filePath, overrides);
      const pathContexts = collectPathContexts(documentText, { filePath });

      for (const pathContext of pathContexts) {
        if (pathContext.kind !== "resolve-path") {
          continue;
        }

        if (!this.isResolveRequestForTarget(filePath, pathContext.value, oldTargetFilePath)) {
          continue;
        }

        const newValue = this.buildUpdatedResolveRequestPath(filePath, pathContext.value, oldTargetFilePath, newTargetFilePath);
        if (!newValue || newValue === pathContext.value) {
          continue;
        }

        edits.push({
          filePath,
          start: pathContext.start,
          end: pathContext.end,
          newText: newValue,
        });
      }
    }

    return edits;
  }

  getRequireFileRenameEdits(oldTargetFilePath, newTargetFilePath, overrides = {}) {
    const edits = [];
    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
      const documentText = this.getCallerDocumentText(filePath, overrides);
      const requireContexts = collectStaticRequireCallContexts(documentText, { filePath });

      for (const requireContext of requireContexts) {
        if (!this.isRequireRequestForTarget(filePath, requireContext.value, oldTargetFilePath, requireContext)) {
          continue;
        }

        const newValue = this.buildUpdatedRequireRequestPath(filePath, requireContext.value, newTargetFilePath, requireContext);
        if (!newValue || newValue === requireContext.value) {
          continue;
        }

        edits.push({
          filePath,
          start: requireContext.start,
          end: requireContext.end,
          newText: newValue,
        });
      }
    }

    return edits;
  }

  isAssetRequestForTarget(filePath, requestPath, targetFilePath) {
    const resolvedTargetFilePath = this.projectIndex.resolveAssetTarget(filePath, requestPath);
    return !!resolvedTargetFilePath && normalizePath(resolvedTargetFilePath) === normalizePath(targetFilePath);
  }

  buildUpdatedAssetRequestPath(filePath, currentRequestPath, _oldTargetFilePath, newTargetFilePath) {
    const normalizedCurrentRequestPath = String(currentRequestPath || "").trim();
    const currentDir = normalizePath(path.dirname(filePath));
    const assetDescriptor = this.projectIndex.getAssetDescriptorByFilePath(newTargetFilePath);
    if (!assetDescriptor) {
      return null;
    }

    if (normalizedCurrentRequestPath.startsWith("/")) {
      return `/${assetDescriptor.relativePath}`;
    }

    if (
      normalizedCurrentRequestPath.startsWith("./") ||
      normalizedCurrentRequestPath.startsWith("../")
    ) {
      return toRelativeSpecifier(path.relative(currentDir, assetDescriptor.filePath), {
        leadingDot: true,
      });
    }

    return toRelativeSpecifier(path.relative(currentDir, assetDescriptor.filePath));
  }

  getAssetFileRenameEdits(oldTargetFilePath, newTargetFilePath, overrides = {}) {
    const edits = [];
    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
      const documentText = this.getCallerDocumentText(filePath, overrides);
      const pathContexts = collectPathContexts(documentText, { filePath });

      for (const pathContext of pathContexts) {
        if (pathContext.kind !== "asset-path") {
          continue;
        }

        if (!this.isAssetRequestForTarget(filePath, pathContext.value, oldTargetFilePath)) {
          continue;
        }

        const newValue = this.buildUpdatedAssetRequestPath(
          filePath,
          pathContext.value,
          oldTargetFilePath,
          newTargetFilePath
        );
        if (!newValue || newValue === pathContext.value) {
          continue;
        }

        edits.push({
          filePath,
          start: pathContext.start,
          end: pathContext.end,
          newText: newValue,
        });
      }
    }

    return edits;
  }

  getBestRouteDescriptorForRequestPath(requestPath, routeSource, options = {}) {
    const normalizedRequestPath = normalizeRouteRequestPath(requestPath);
    if (!normalizedRequestPath) {
      return null;
    }

    const preferredMethods = getPreferredRouteMethods(routeSource);
    const requestSegments = splitNormalizedRouteRequestPath(normalizedRequestPath);
    const excludedFilePath = options.excludeFilePath ? normalizePath(options.excludeFilePath) : "";
    const matchingEntries = [];

    for (const descriptor of this.projectIndex.getRouteState().descriptors) {
      if (excludedFilePath && normalizePath(descriptor.filePath) === excludedFilePath) {
        continue;
      }

      const matchState = getRouteRequestMatchState(descriptor.routeSegments, requestSegments);
      if (!matchState) {
        continue;
      }

      matchingEntries.push({
        ...descriptor,
        ...matchState,
      });
    }

    const syntheticDescriptor = options.syntheticDescriptor || null;
    if (
      syntheticDescriptor &&
      (!excludedFilePath || normalizePath(syntheticDescriptor.filePath) !== excludedFilePath)
    ) {
      const matchState = getRouteRequestMatchState(
        syntheticDescriptor.routeSegments,
        requestSegments
      );
      if (matchState) {
        const normalizedSyntheticFilePath = normalizePath(syntheticDescriptor.filePath);
        const hasMatchingEntry = matchingEntries.some(
          (entry) =>
            normalizePath(entry.filePath) === normalizedSyntheticFilePath &&
            normalizeRouteMethod(entry.method) ===
              normalizeRouteMethod(syntheticDescriptor.method)
        );
        if (!hasMatchingEntry) {
          matchingEntries.push({
            ...syntheticDescriptor,
            filePath: normalizedSyntheticFilePath,
            ...matchState,
          });
        }
      }
    }

    if (!matchingEntries.length) {
      return null;
    }

    matchingEntries.sort((left, right) => {
      const leftRank = this.projectIndex.getRouteEntryRank(left, preferredMethods);
      const rightRank = this.projectIndex.getRouteEntryRank(right, preferredMethods);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      if (left.dynamicSegmentCount !== right.dynamicSegmentCount) {
        return left.dynamicSegmentCount - right.dynamicSegmentCount;
      }

      if (left.segmentCount !== right.segmentCount) {
        return right.segmentCount - left.segmentCount;
      }

      return left.filePath.localeCompare(right.filePath);
    });

    const bestEntry = matchingEntries[0];
    return Number.isFinite(this.projectIndex.getRouteEntryRank(bestEntry, preferredMethods))
      ? bestEntry
      : null;
  }

  getBestStaticRouteEntryForPath(routePath, routeSource, options = {}) {
    const normalizedRoutePath = normalizeRouteRequestPath(routePath);
    if (!normalizedRoutePath) {
      return null;
    }

    const excludedFilePath = options.excludeFilePath ? normalizePath(options.excludeFilePath) : "";
    const preferredMethods = getPreferredRouteMethods(routeSource);
    const entries = [];

    for (const entry of this.projectIndex.getStaticRouteEntries()) {
      if (entry.routePath !== normalizedRoutePath) {
        continue;
      }

      if (excludedFilePath && normalizePath(entry.filePath) === excludedFilePath) {
        continue;
      }

      entries.push(entry);
    }

    const syntheticEntry = options.syntheticEntry || null;
    if (syntheticEntry && syntheticEntry.routePath === normalizedRoutePath) {
      const normalizedSyntheticFilePath = normalizePath(syntheticEntry.filePath);
      if (!excludedFilePath || normalizedSyntheticFilePath !== excludedFilePath) {
        const alreadyIncluded = entries.some(
          (entry) =>
            normalizePath(entry.filePath) === normalizedSyntheticFilePath &&
            normalizeRouteMethod(entry.method) === normalizeRouteMethod(syntheticEntry.method)
        );
        if (!alreadyIncluded) {
          entries.push({
            filePath: normalizedSyntheticFilePath,
            method: normalizeRouteMethod(syntheticEntry.method) === "PAGE" ? null : normalizeRouteMethod(syntheticEntry.method),
            routePath: normalizedRoutePath,
          });
        }
      }
    }

    if (!entries.length) {
      return null;
    }

    entries.sort((left, right) => {
      const leftRank = this.projectIndex.getRouteEntryRank(left, preferredMethods);
      const rightRank = this.projectIndex.getRouteEntryRank(right, preferredMethods);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.filePath.localeCompare(right.filePath);
    });

    const bestEntry = entries[0];
    return Number.isFinite(this.projectIndex.getRouteEntryRank(bestEntry, preferredMethods))
      ? bestEntry
      : null;
  }

  shouldRenameRoutePathContext(pathContext, routeRenameContext) {
    if (!pathContext || pathContext.kind !== "route-path" || pathContext.isDynamic) {
      return false;
    }

    const normalizedCurrentRequestPath = normalizeRouteRequestPath(
      splitRoutePathSuffix(pathContext.value).basePath
    );
    if (!normalizedCurrentRequestPath) {
      return false;
    }

    const bestEntryWithOld = this.getBestRouteDescriptorForRequestPath(
      normalizedCurrentRequestPath,
      pathContext.routeSource,
      {
        syntheticDescriptor: routeRenameContext.oldRouteDescriptor,
      }
    );
    if (!bestEntryWithOld || normalizePath(bestEntryWithOld.filePath) !== routeRenameContext.oldFilePath) {
      return false;
    }

    const bestEntryWithoutOld = this.getBestRouteDescriptorForRequestPath(
      normalizedCurrentRequestPath,
      pathContext.routeSource,
      { excludeFilePath: routeRenameContext.oldFilePath }
    );
    return !bestEntryWithoutOld;
  }

  getRouteFileRenameEdits(routeRenameContext, overrides = {}) {
    const edits = [];
    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
      const documentText = this.getCallerDocumentText(filePath, overrides);
      const pathContexts = collectPathContexts(documentText, { filePath });

      for (const pathContext of pathContexts) {
        if (!this.shouldRenameRoutePathContext(pathContext, routeRenameContext)) {
          continue;
        }

        const newValue = this.buildUpdatedRouteRequestPath(
          pathContext.value,
          routeRenameContext
        );
        if (!newValue || newValue === pathContext.value) {
          continue;
        }

        edits.push({
          filePath,
          start: pathContext.start,
          end: pathContext.end,
          newText: newValue,
        });
      }
    }

    return edits;
  }

  isIncludeRequestForTarget(filePath, requestPath, targetFilePath) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const normalizedRequestPath = String(requestPath || "").trim();
    const currentDir = normalizePath(path.dirname(filePath));

    if (normalizedRequestPath.startsWith("./") || normalizedRequestPath.startsWith("../")) {
      return normalizePath(path.join(currentDir, normalizedRequestPath)) === normalizedTargetFilePath;
    }

    if (normalizePath(path.join(currentDir, normalizedRequestPath)) === normalizedTargetFilePath) {
      return true;
    }

    if (normalizePath(path.join(this.projectIndex.pagesRoot, normalizedRequestPath)) === normalizedTargetFilePath) {
      return true;
    }

    for (const privateRoot of this.projectIndex.getPrivateSearchRoots(filePath)) {
      if (normalizePath(path.join(privateRoot, normalizedRequestPath)) === normalizedTargetFilePath) {
        return true;
      }
    }

    return false;
  }

  isResolveRequestForTarget(filePath, requestPath, targetFilePath) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    return this.projectIndex.getResolveCandidatePaths(filePath, requestPath).includes(normalizedTargetFilePath);
  }

  isRequireRequestForTarget(filePath, requestPath, targetFilePath, options = {}) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const normalizedRequestPath = String(requestPath || "").trim();
    if (!normalizedRequestPath) {
      return false;
    }

    const rootKind = String(options.rootKind || "");
    const currentDir = normalizePath(path.dirname(filePath));
    const basePath = rootKind === "__hooks"
      ? normalizePath(path.join(this.projectIndex.appRoot, "pb_hooks", normalizedRequestPath.replace(/^\/+/, "")))
      : normalizedRequestPath.startsWith("/")
        ? normalizePath(path.join(this.projectIndex.appRoot, normalizedRequestPath))
        : normalizePath(path.join(currentDir, normalizedRequestPath));
    const candidatePaths = [
      basePath,
      ...[".js", ".cjs", ".mjs", ".json"].map((extension) => normalizePath(`${basePath}${extension}`)),
      ...[".js", ".cjs", ".mjs", ".json"].map((extension) => normalizePath(path.join(basePath, `index${extension}`))),
    ];

    return candidatePaths.includes(normalizedTargetFilePath);
  }

  getMatchingIncludeRoot(filePath, requestPath, targetFilePath) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const normalizedRequestPath = String(requestPath || "").trim();

    for (const privateRoot of this.projectIndex.getPrivateSearchRoots(filePath)) {
      if (normalizePath(path.join(privateRoot, normalizedRequestPath)) === normalizedTargetFilePath) {
        return privateRoot;
      }
    }

    return null;
  }

  getMatchingResolveRoot(filePath, requestPath, targetFilePath) {
    return this.projectIndex.getResolveMatchingRoot(filePath, requestPath, targetFilePath);
  }

  buildUpdatedIncludeRequestPath(filePath, currentRequestPath, oldTargetFilePath, newTargetFilePath) {
    const normalizedCurrentRequestPath = String(currentRequestPath || "").trim();
    const currentDir = normalizePath(path.dirname(filePath));

    if (normalizedCurrentRequestPath.startsWith("./") || normalizedCurrentRequestPath.startsWith("../")) {
      return toRelativeSpecifier(path.relative(currentDir, newTargetFilePath), { leadingDot: true });
    }

    if (normalizePath(path.join(currentDir, normalizedCurrentRequestPath)) === normalizePath(oldTargetFilePath)) {
      return toRelativeSpecifier(path.relative(currentDir, newTargetFilePath));
    }

    if (normalizePath(path.join(this.projectIndex.pagesRoot, normalizedCurrentRequestPath)) === normalizePath(oldTargetFilePath)) {
      return toPortablePath(path.relative(this.projectIndex.pagesRoot, newTargetFilePath));
    }

    const matchedPrivateRoot = this.getMatchingIncludeRoot(filePath, normalizedCurrentRequestPath, oldTargetFilePath);
    if (matchedPrivateRoot && isSameOrChildPath(matchedPrivateRoot, newTargetFilePath)) {
      return toPortablePath(path.relative(matchedPrivateRoot, newTargetFilePath));
    }

    for (const privateRoot of this.projectIndex.getPrivateSearchRoots(filePath)) {
      if (isSameOrChildPath(privateRoot, newTargetFilePath)) {
        return toPortablePath(path.relative(privateRoot, newTargetFilePath));
      }
    }

    return null;
  }

  buildUpdatedResolveRequestPath(filePath, currentRequestPath, oldTargetFilePath, newTargetFilePath) {
    const normalizedCurrentRequestPath = String(currentRequestPath || "").trim();
    const leadingSlashPrefix = normalizedCurrentRequestPath.match(/^\/+/);
    const isExplicitRelativeRequest =
      normalizedCurrentRequestPath.startsWith("./") || normalizedCurrentRequestPath.startsWith("../");
    const relativePrefix = normalizedCurrentRequestPath.startsWith("./")
      ? "./"
      : isExplicitRelativeRequest
        ? "../".repeat((normalizedCurrentRequestPath.match(/\.\.\//g) || []).length)
        : "";
    const matchedPrivateRoot = this.getMatchingResolveRoot(filePath, currentRequestPath, oldTargetFilePath);
    const candidateRoots = [];

    if (matchedPrivateRoot && isSameOrChildPath(matchedPrivateRoot, newTargetFilePath)) {
      candidateRoots.push(matchedPrivateRoot);
    }

    for (const privateRoot of this.projectIndex.getResolveSearchRoots(filePath, currentRequestPath)) {
      if (!isSameOrChildPath(privateRoot, newTargetFilePath)) {
        continue;
      }

      if (!candidateRoots.includes(privateRoot)) {
        candidateRoots.push(privateRoot);
      }
    }

    for (const privateRoot of candidateRoots) {
      let requestPath = toPortablePath(path.relative(privateRoot, newTargetFilePath));
      requestPath = stripKnownExtension(requestPath, [".js", ".cjs", ".mjs"]);
      if (requestPath.endsWith("/index")) {
        requestPath = requestPath.slice(0, -"/index".length);
      }

      if (!requestPath) {
        continue;
      }

      if (leadingSlashPrefix) {
        return `${leadingSlashPrefix[0]}${requestPath}`;
      }

      if (isExplicitRelativeRequest) {
        return `${relativePrefix}${requestPath}`;
      }

      return requestPath;
    }

    return null;
  }

  buildUpdatedRouteRequestPath(currentRequestPath, oldRoutePath, newRoutePath) {
    const routeRenameContext =
      oldRoutePath && typeof oldRoutePath === "object"
        ? oldRoutePath
        : {
            oldRoutePath,
            newRoutePath,
          };
    const normalizedOldRoutePath = normalizeRouteRequestPath(routeRenameContext.oldRoutePath);
    const normalizedNewRoutePath = normalizeRouteRequestPath(routeRenameContext.newRoutePath);
    if (!normalizedOldRoutePath || !normalizedNewRoutePath) {
      return null;
    }

    const { basePath, suffix } = splitRoutePathSuffix(currentRequestPath);
    const normalizedBasePath = normalizeRouteRequestPath(basePath);
    if (!normalizedBasePath) {
      return null;
    }

    if (normalizedBasePath === normalizedOldRoutePath) {
      return `${normalizedNewRoutePath}${suffix}`;
    }

    const oldRouteDescriptor =
      routeRenameContext.oldRouteDescriptor ||
      this.projectIndex.describeRouteFilePath(routeRenameContext.oldFilePath || "");
    const newRouteDescriptor =
      routeRenameContext.newRouteDescriptor ||
      this.projectIndex.describeRouteFilePath(routeRenameContext.newFilePath || "");
    if (!oldRouteDescriptor || !newRouteDescriptor) {
      return null;
    }

    const matchState = getRouteRequestMatchState(
      oldRouteDescriptor.routeSegments,
      splitNormalizedRouteRequestPath(normalizedBasePath)
    );
    if (!matchState) {
      return null;
    }

    const rewrittenBasePath = buildConcreteRoutePathFromSegments(
      newRouteDescriptor.routeSegments,
      matchState.dynamicValueGroups
    );
    if (!rewrittenBasePath) {
      return null;
    }

    return `${rewrittenBasePath}${suffix}`;
  }

  buildUpdatedRequireRequestPath(filePath, currentRequestPath, newTargetFilePath, options = {}) {
    const normalizedCurrentRequestPath = String(currentRequestPath || "").trim();
    const keepExtension = !!path.extname(normalizedCurrentRequestPath);
    const rootKind = String(options.rootKind || "");

    if (rootKind === "__hooks") {
      const hooksRoot = normalizePath(path.join(this.projectIndex.appRoot, "pb_hooks"));
      if (!isSameOrChildPath(hooksRoot, newTargetFilePath)) {
        return null;
      }

      let requestPath = toPortablePath(path.relative(hooksRoot, newTargetFilePath));
      if (!keepExtension) {
        requestPath = stripKnownExtension(requestPath, [".js", ".cjs", ".mjs", ".json"]);
      }

      return `/${requestPath}`;
    }

    if (normalizedCurrentRequestPath.startsWith("/")) {
      let requestPath = toPortablePath(path.relative(this.projectIndex.appRoot, newTargetFilePath));
      if (!keepExtension) {
        requestPath = stripKnownExtension(requestPath, [".js", ".cjs", ".mjs", ".json"]);
      }

      return `/${requestPath}`;
    }

    let requestPath = toRelativeSpecifier(path.relative(path.dirname(filePath), newTargetFilePath), { leadingDot: true });
    if (!keepExtension) {
      requestPath = stripKnownExtension(requestPath, [".js", ".cjs", ".mjs", ".json"]);
    }

    return requestPath;
  }

  collectResolvedModuleMemberUsageLocations(targetModuleFilePath, memberName, overrides = {}) {
    const normalizedTargetFilePath = normalizePath(targetModuleFilePath);
    const uniqueLocations = new Map();

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const codeFilePath = normalizePath(entry.filePath);
      const documentText =
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : this.getDocumentText(codeFilePath);
      const analysisText = toAnalysisText(codeFilePath, documentText);
      const contexts = collectResolvedModuleMemberContexts(analysisText);

      for (const context of contexts) {
        if (context.memberName !== memberName) {
          continue;
        }

        const resolvedModuleFilePath = this.projectIndex.resolveResolveTarget(codeFilePath, context.modulePath);
        if (!resolvedModuleFilePath || normalizePath(resolvedModuleFilePath) !== normalizedTargetFilePath) {
          continue;
        }

        const locationKey = `${codeFilePath}:${context.start}:${context.end}`;
        if (!uniqueLocations.has(locationKey)) {
          uniqueLocations.set(locationKey, {
            filePath: codeFilePath,
            start: context.start,
            end: context.end,
          });
        }
      }
    }

    return [...uniqueLocations.values()];
  }

  collectResolvedModuleMemberUsageEdits(targetModuleFilePath, memberName, newName, overrides = {}) {
    return this.collectResolvedModuleMemberUsageLocations(targetModuleFilePath, memberName, overrides).map((location) => ({
      ...location,
      newText: newName,
    }));
  }

  getCompletionData(filePath, documentText, offset, options = {}) {
    return completionFeatureHandlers.getCompletionData(this, filePath, documentText, offset, options);
  }

  getCustomCompletionData(filePath, documentText, offset) {
    return completionFeatureHandlers.getCustomCompletionData(this, filePath, documentText, offset);
  }

  getCompletionDetails(virtualFileName, virtualOffset, name, source) {
    return completionFeatureHandlers.getCompletionDetails(
      this,
      virtualFileName,
      virtualOffset,
      name,
      source
    );
  }

  getQuickInfo(filePath, documentText, offset, options = {}) {
    return completionFeatureHandlers.getQuickInfo(this, filePath, documentText, offset, options);
  }

  getSignatureHelp(filePath, documentText, offset, options = {}) {
    return completionFeatureHandlers.getSignatureHelp(
      this,
      filePath,
      documentText,
      offset,
      options
    );
  }

  getCustomSignatureHelp(filePath, documentText, offset) {
    return completionFeatureHandlers.getCustomSignatureHelp(this, filePath, documentText, offset);
  }

  getCodeLensEntries(filePath, documentText) {
    const entries = [];
    const routeDescriptor = this.projectIndex.getRouteDescriptorByFilePath(filePath);
    if (routeDescriptor) {
      entries.push({
        title:
          routeDescriptor.method && routeDescriptor.method !== "PAGE"
            ? `Route: ${routeDescriptor.method} ${routeDescriptor.routePath}`
            : `Route: ${routeDescriptor.routePath}`,
        start: 0,
      });
    }

    for (const pathContext of collectPathContexts(documentText, { filePath })) {
      if (pathContext.kind !== "include-path") {
        continue;
      }

      const targetFilePath = this.projectIndex.resolveIncludeTarget(filePath, pathContext.value);
      if (!targetFilePath) {
        continue;
      }

      entries.push({
        title: `-> ${toPortablePath(path.relative(this.appRoot, targetFilePath))}`,
        start: pathContext.start,
        targetFilePath: normalizePath(targetFilePath),
      });
    }

    const referenceQuery = this.getFileReferenceQuery(filePath);
    if (!referenceQuery) {
      return entries;
    }

    const references = this.getFileReferenceTargets(filePath, documentText, {
      includeDeclaration: false,
    });
    const referenceCount = references ? references.length : 0;
    const summaryTitle =
      referenceQuery.kind === "private-partial"
        ? `Partial callers: ${referenceCount}`
        : referenceQuery.kind === "private-module"
          ? `Module callers: ${referenceCount}`
          : referenceQuery.kind === "asset-file"
            ? `Asset callers: ${referenceCount}`
            : `Route callers: ${referenceCount}`;

    entries.push({
      title: summaryTitle,
      command: "pocketpagesServerScript.allFileReferences",
      start: 0,
    });
    entries.push({
      title: `All File References (${referenceCount})`,
      command: "pocketpagesServerScript.allFileReferences",
      start: 0,
    });

    return entries;
  }

  getInlayHintEntries(filePath, documentText, range = {}) {
    const startOffset = typeof range.start === "number" ? range.start : 0;
    const endOffset = typeof range.end === "number" ? range.end : documentText.length;
    const entries = [];
    const seen = new Set();
    const analysisText = toAnalysisText(filePath, documentText);
    const sourceFile = createSourceFileForText(`${filePath}.__inlay__.js`, analysisText);
    const addEntry = (position, label, tooltip, kind = "type") => {
      if (typeof position !== "number" || position < startOffset || position > endOffset) {
        return;
      }

      const key = `${position}:${label}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      entries.push({
        position,
        label,
        tooltip,
        kind,
      });
    };

    for (const pathContext of collectPathContexts(documentText, { filePath })) {
      if (pathContext.kind !== "resolve-path") {
        continue;
      }

      const targetFilePath = this.resolvePathContextTarget(filePath, pathContext);
      if (!targetFilePath) {
        continue;
      }

      addEntry(
        pathContext.end,
        ` -> ${toPortablePath(path.relative(this.appRoot, targetFilePath))}`,
        `Target: ${toPortablePath(path.relative(this.appRoot, targetFilePath))}`,
        "parameter"
      );
    }

    const schemaContexts = collectSchemaContexts(analysisText, {
      collectionMethodNames: this.projectIndex.getCollectionMethodNames(),
      sourceFile,
    });
    for (const context of schemaContexts) {
      if (context.kind !== "record-field" || context.accessMethod !== "get") {
        continue;
      }

      const collectionReference = this.resolveSchemaFieldCollectionReference(filePath, documentText, context, {
        analysisText,
        analysisStart: 0,
        analysisSourceFile: sourceFile,
      });
      if (!collectionReference || collectionReference.confidence !== "high") {
        continue;
      }

      const typeText = this.projectIndex.getFieldTypeText(collectionReference.collectionName, context.value);
      if (typeText && typeof context.callEnd === "number") {
        addEntry(context.callEnd, `: ${typeText}`, `Field type: ${typeText}`);
      }
    }

    return entries;
  }

  collectPrivateResolveDiagnostics(filePath, documentAnalysis) {
    if (!isPrivatePagesFile(filePath)) {
      return [];
    }

    return documentAnalysis.getPrivateResolveCallSpans().map((span) => ({
      code: "pp-private-resolve",
      category: ts.DiagnosticCategory.Warning,
      message: "Do not use resolve() inside _private files. Resolve dependencies in the entry and pass them in.",
      start: span.start,
      end: span.end,
    }));
  }

  collectServerBlockDiagnostics(filePath, documentText, blocks, collectionMethodNames, documentAnalysis, options = {}) {
    const includeSemanticDiagnostics = options.includeSemanticDiagnostics !== false;
    const includeTypeScriptDiagnostics = options.includeTypeScriptDiagnostics !== false;
    const preparedDocumentState = options.preparedDocumentState || null;
    const profile = options.profile || null;
    const shouldCancel =
      options && typeof options.shouldCancel === "function"
        ? options.shouldCancel
        : null;
    const regionCache =
      options && options.regionCache && typeof options.regionCache === "object"
        ? options.regionCache
        : null;
    const semanticBudget =
      options && options.semanticBudget && typeof options.semanticBudget === "object"
        ? options.semanticBudget
        : null;
    const serverRegions =
      regionCache &&
      regionCache.currentMetadata &&
      Array.isArray(regionCache.currentMetadata.regions)
        ? regionCache.currentMetadata.regions
        : [];
    const canUseRegionCache =
      !!(
        regionCache &&
        regionCache.previousMetadata &&
        regionCache.currentMetadata &&
        Array.isArray(regionCache.previousDiagnostics)
      );
    const semanticBudgetEnabled =
      !!(
        semanticBudget &&
        semanticBudget.enabled === true &&
        canUseRegionCache &&
        includeSemanticDiagnostics &&
        includeTypeScriptDiagnostics
      );
    const semanticBudgetMaxValue = Number(semanticBudget && semanticBudget.maxSemanticRegions);
    const semanticBudgetMax = Math.max(
      0,
      Number.isFinite(semanticBudgetMaxValue) ? semanticBudgetMaxValue : 0
    );
    const preferredOffset = Number(semanticBudget && semanticBudget.preferredOffset);
    let semanticBudgetUsed = 0;
    const diagnostics = [];
    const getCurrentRegionForBlock = (block) =>
      serverRegions.find((region) =>
        region &&
        region.sourceStart === block.contentStart &&
        region.sourceEnd === block.contentEnd
      ) || null;
    const hasPreferredOffset = (region) =>
      Number.isFinite(preferredOffset) &&
      region &&
      preferredOffset >= region.sourceStart &&
      preferredOffset <= region.sourceEnd;
    const shouldRunSemanticForRegion = (region) => {
      if (!semanticBudgetEnabled) {
        return includeSemanticDiagnostics;
      }

      if (hasPreferredOffset(region)) {
        semanticBudgetUsed += 1;
        return true;
      }

      if (semanticBudgetUsed < semanticBudgetMax) {
        semanticBudgetUsed += 1;
        return true;
      }

      if (profile) {
        profile.deferredServerSemanticRegions =
          (profile.deferredServerSemanticRegions || 0) + 1;
      }
      if (semanticBudget) {
        semanticBudget.deferred = true;
      }
      return false;
    };
    const pushCachedRegionDiagnostics = (region) => {
      if (!canUseRegionCache || !region || region.dirty === true) {
        return false;
      }

      const cachedDiagnostics = this.getReusableRegionDiagnostics(
        "server",
        region,
        regionCache.previousDiagnostics,
        regionCache.previousMetadata,
        regionCache.currentMetadata
      );
      if (!cachedDiagnostics) {
        return false;
      }

      diagnostics.push(...cachedDiagnostics);
      if (profile) {
        if (!Array.isArray(profile.reusedDiagnosticRegions)) {
          profile.reusedDiagnosticRegions = [];
        }
        profile.reusedDiagnosticRegions.push(region.id);
      }
      return true;
    };

    for (const block of blocks) {
      if (shouldCancel && shouldCancel("before-server-block-diagnostics")) {
        return diagnostics;
      }

      const currentRegion = getCurrentRegionForBlock(block);
      if (pushCachedRegionDiagnostics(currentRegion)) {
        continue;
      }

      if (includeTypeScriptDiagnostics) {
        const virtual = this.getPreparedServerBlockVirtual(
          filePath,
          documentText,
          block,
          preparedDocumentState
        );
        if (!virtual) {
          if (profile) {
            profile.skippedUnpreparedServerBlockDiagnostics =
              (profile.skippedUnpreparedServerBlockDiagnostics || 0) + 1;
          }
        } else {
          const relaxedBodyDiagnosticSpans = collectRelaxedBodyDiagnosticSpans(block.content, {
            sourceFile: documentAnalysis.getBlockSourceFile(block),
          });
          const rawDiagnostics = this.languageService.getSyntacticDiagnostics(virtual.fileName);
          const runSemanticDiagnostics = shouldRunSemanticForRegion(currentRegion);
          if (runSemanticDiagnostics) {
            rawDiagnostics.push(...this.languageService.getSemanticDiagnostics(virtual.fileName));
          }

          for (const diagnostic of rawDiagnostics) {
            if (diagnostic && diagnostic.code === 1108) {
              continue;
            }

            if (shouldSuppressDiagnosticForRelaxedBodyAccess(diagnostic, virtual, relaxedBodyDiagnosticSpans)) {
              continue;
            }

            if (typeof diagnostic.start !== "number" || typeof diagnostic.length !== "number") {
              continue;
            }

            const start = this.mapVirtualOffsetToDocumentOffset(virtual.fileName, diagnostic.start);
            const end = this.mapVirtualOffsetToDocumentOffset(virtual.fileName, diagnostic.start + diagnostic.length);

            if (start === null || end === null) {
              continue;
            }

            diagnostics.push({
              code: diagnostic.code,
              category: diagnostic.category,
              message: flattenDiagnosticMessage(diagnostic.messageText),
              start,
              end,
            });
          }
        }
      }

      const schemaContexts =
        documentAnalysis && typeof documentAnalysis.getBlockSchemaContexts === "function"
          ? documentAnalysis.getBlockSchemaContexts(block, collectionMethodNames)
          : collectSchemaContexts(block.content, {
              collectionMethodNames,
              sourceFile:
                documentAnalysis && typeof documentAnalysis.getBlockSourceFile === "function"
                  ? documentAnalysis.getBlockSourceFile(block)
                  : undefined,
            });

      for (const context of schemaContexts) {
        if (context.kind === "collection-name" && !this.projectIndex.hasCollection(context.value)) {
          diagnostics.push(buildSchemaCollectionDiagnostic(context, block.contentStart));
        }

        if (context.kind === "record-field") {
          const fieldDiagnostic = this.buildDocumentSchemaFieldDiagnostic(
            filePath,
            documentText,
            context,
            {
              analysisText: block.content,
              analysisStart: block.contentStart,
              analysisSourceFile:
                documentAnalysis && typeof documentAnalysis.getBlockSourceFile === "function"
                  ? documentAnalysis.getBlockSourceFile(block)
                  : null,
            }
          );

          if (fieldDiagnostic) {
            diagnostics.push(fieldDiagnostic);
          }
        }
      }

      diagnostics.push(...collectRedirectReturnDiagnostics(filePath, block.content, {
        sourceFile: documentAnalysis.getBlockSourceFile(block),
        useTopLevelStatements: true,
        offsetBase: block.contentStart,
      }));

      if (shouldCancel && shouldCancel("after-server-block-diagnostics")) {
        return diagnostics;
      }
    }

    return diagnostics;
  }

  collectTemplateDiagnostics(filePath, documentText, blocks, templateBlocks, collectionMethodNames, documentAnalysis, options = {}) {
    if (!templateBlocks.length) {
      return [];
    }

    const includeSemanticDiagnostics = options.includeSemanticDiagnostics !== false;
    const includeTypeScriptDiagnostics = options.includeTypeScriptDiagnostics !== false;
    const preparedDocumentState = options.preparedDocumentState || null;
    const profile = options.profile || null;
    const shouldCancel =
      options && typeof options.shouldCancel === "function"
        ? options.shouldCancel
        : null;
    const regionCache =
      options && options.regionCache && typeof options.regionCache === "object"
        ? options.regionCache
        : null;
    const semanticBudget =
      options && options.semanticBudget && typeof options.semanticBudget === "object"
        ? options.semanticBudget
        : null;
    const canUseRegionCache =
      !!(
        regionCache &&
        regionCache.previousMetadata &&
        regionCache.currentMetadata &&
        Array.isArray(regionCache.previousDiagnostics)
      );
    const semanticBudgetEnabled =
      !!(
        semanticBudget &&
        semanticBudget.enabled === true &&
        canUseRegionCache &&
        includeSemanticDiagnostics &&
        includeTypeScriptDiagnostics
      );
    const diagnostics = [];
    const templateVirtualText = documentAnalysis.getTemplateVirtualText();
    const overlapsTemplateBlock = (start, end) =>
      templateBlocks.some((block) => end >= block.contentStart && start <= block.contentEnd);
    const overlapsServerBlock = (start, end) =>
      blocks.some((block) => end >= block.contentStart && start <= block.contentEnd);
    const cachedTemplateRegionIds = new Set();

    if (semanticBudgetEnabled) {
      const currentRegions =
        regionCache.currentMetadata && Array.isArray(regionCache.currentMetadata.regions)
          ? regionCache.currentMetadata.regions
          : [];
      for (const region of currentRegions) {
        if (!region || region.dirty === true) {
          continue;
        }

        const cachedDiagnostics = this.getReusableRegionDiagnostics(
          "template",
          region,
          regionCache.previousDiagnostics,
          regionCache.previousMetadata,
          regionCache.currentMetadata
        );
        if (!cachedDiagnostics) {
          continue;
        }

        diagnostics.push(...cachedDiagnostics);
        cachedTemplateRegionIds.add(region.id);
      }

      const deferredRegionCount = currentRegions.filter((region) =>
        region && !cachedTemplateRegionIds.has(region.id)
      ).length;
      if (deferredRegionCount > 0) {
        if (profile) {
          profile.deferredTemplateSemanticRegions =
            (profile.deferredTemplateSemanticRegions || 0) + deferredRegionCount;
        }
        if (semanticBudget) {
          semanticBudget.deferred = true;
        }
      }
      if (cachedTemplateRegionIds.size && profile) {
        if (!Array.isArray(profile.reusedDiagnosticRegions)) {
          profile.reusedDiagnosticRegions = [];
        }
        for (const regionId of cachedTemplateRegionIds) {
          profile.reusedDiagnosticRegions.push(regionId);
        }
      }
    }

    if (includeTypeScriptDiagnostics && !semanticBudgetEnabled) {
      const templateVirtual = this.getPreparedTemplateVirtual(
        filePath,
        documentText,
        preparedDocumentState
      );
      if (!templateVirtual) {
        if (profile) {
          profile.skippedUnpreparedTemplateDiagnostics =
            (profile.skippedUnpreparedTemplateDiagnostics || 0) + 1;
        }
      } else {
        const rawDiagnostics = this.languageService.getSyntacticDiagnostics(templateVirtual.fileName);
        if (includeSemanticDiagnostics) {
          rawDiagnostics.push(...this.languageService.getSemanticDiagnostics(templateVirtual.fileName));
        }

        for (const diagnostic of rawDiagnostics) {
          if (shouldCancel && shouldCancel("before-template-diagnostics")) {
            return diagnostics;
          }

          if (typeof diagnostic.start !== "number" || typeof diagnostic.length !== "number") {
            continue;
          }

          const start = this.mapVirtualOffsetToDocumentOffset(templateVirtual.fileName, diagnostic.start);
          const end = this.mapVirtualOffsetToDocumentOffset(templateVirtual.fileName, diagnostic.start + diagnostic.length);

          if (start === null || end === null) {
            continue;
          }

          if (!overlapsTemplateBlock(start, end) || overlapsServerBlock(start, end)) {
            continue;
          }

          diagnostics.push({
            code: diagnostic.code,
            category: diagnostic.category,
            message: flattenDiagnosticMessage(diagnostic.messageText),
            start,
            end,
          });
        }
      }
    }

    const schemaContexts =
      documentAnalysis && typeof documentAnalysis.getAnalysisSchemaContexts === "function"
        ? documentAnalysis.getAnalysisSchemaContexts(collectionMethodNames)
        : collectSchemaContexts(templateVirtualText, {
            collectionMethodNames,
            sourceFile:
              documentAnalysis && typeof documentAnalysis.getAnalysisSourceFile === "function"
                ? documentAnalysis.getAnalysisSourceFile()
                : undefined,
          });

    for (const context of schemaContexts) {
      if (shouldCancel && shouldCancel("before-template-schema-diagnostics")) {
        return diagnostics;
      }

      if (!overlapsTemplateBlock(context.start, context.end) || overlapsServerBlock(context.start, context.end)) {
        continue;
      }

      if (context.kind === "collection-name" && !this.projectIndex.hasCollection(context.value)) {
        diagnostics.push(buildSchemaCollectionDiagnostic(context));
      }

      if (context.kind === "record-field") {
        const fieldDiagnostic = this.buildDocumentSchemaFieldDiagnostic(
          filePath,
          documentText,
          context,
          {
            analysisText: templateVirtualText,
            analysisSourceFile:
              documentAnalysis && typeof documentAnalysis.getAnalysisSourceFile === "function"
                ? documentAnalysis.getAnalysisSourceFile()
                : null,
          }
        );

        if (fieldDiagnostic) {
          diagnostics.push(fieldDiagnostic);
        }
      }
    }

    return diagnostics;
  }

  getWarmupOffset(filePath, documentText, options = {}) {
    const preferredOffset = Number(options.preferredOffset);
    if (Number.isFinite(preferredOffset) && preferredOffset >= 0 && preferredOffset <= String(documentText || "").length) {
      return preferredOffset;
    }

    if (isScriptFile(filePath)) {
      return 0;
    }

    if (!isEjsFile(filePath)) {
      return null;
    }

    const blocks = _extractServerBlocks(documentText);
    if (blocks.length) {
      return blocks[0].contentStart;
    }

    const templateBlocks = _extractTemplateCodeBlocks(documentText);
    if (templateBlocks.length) {
      return templateBlocks[0].contentStart;
    }

    return null;
  }

  warmupDocument(filePath, documentText, options = {}) {
    const offset = this.getWarmupOffset(filePath, documentText, options);
    if (offset === null) {
      return {
        warmed: false,
        reason: "no-virtual-region",
      };
    }

    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset, {
      preferTemplateDocument: true,
    });
    if (!virtualState) {
      return {
        warmed: false,
        reason: "no-virtual-state",
      };
    }

    this.languageService.getSyntacticDiagnostics(virtualState.virtual.fileName);
    return {
      warmed: true,
      fileName: virtualState.virtual.fileName,
      offset,
    };
  }

  collectScriptSchemaDiagnostics(filePath, documentText, collectionMethodNames, documentAnalysis = null) {
    if (!isScriptFile(filePath)) {
      return [];
    }

    const normalizedFilePath = normalizePath(filePath);
    const ambientSnapshotKey = this.getAmbientSnapshotKey();
    const collectionMethodKey = Array.isArray(collectionMethodNames)
      ? [...collectionMethodNames].join("|")
      : "";
    const pagesContentVersion = this.projectIndex.pagesContentVersion;
    const cachedEntry = this.scriptSchemaDiagnosticsCache.get(normalizedFilePath);
    if (
      cachedEntry &&
      cachedEntry.documentText === documentText &&
      cachedEntry.ambientSnapshotKey === ambientSnapshotKey &&
      cachedEntry.collectionMethodKey === collectionMethodKey &&
      cachedEntry.pagesContentVersion === pagesContentVersion
    ) {
      return cachedEntry.diagnostics.slice();
    }

    const diagnostics = [];

    const schemaContexts =
      documentAnalysis && typeof documentAnalysis.getDocumentSchemaContexts === "function"
        ? documentAnalysis.getDocumentSchemaContexts(collectionMethodNames)
        : collectSchemaContexts(documentText, {
            collectionMethodNames,
            sourceFile:
              documentAnalysis && typeof documentAnalysis.getDocumentSourceFile === "function"
                ? documentAnalysis.getDocumentSourceFile()
                : undefined,
          });

    for (const context of schemaContexts) {
      if (context.kind === "collection-name" && !this.projectIndex.hasCollection(context.value)) {
        diagnostics.push(buildSchemaCollectionDiagnostic(context));
      }

      if (context.kind === "record-field") {
        const fieldDiagnostic = this.buildDocumentSchemaFieldDiagnostic(
          filePath,
          documentText,
          context,
          {
            analysisText: documentText,
            analysisSourceFile:
              documentAnalysis && typeof documentAnalysis.getDocumentSourceFile === "function"
                ? documentAnalysis.getDocumentSourceFile()
                : null,
          }
        );

        if (fieldDiagnostic) {
          diagnostics.push(fieldDiagnostic);
        }
      }
    }

    this.scriptSchemaDiagnosticsCache.set(normalizedFilePath, {
      documentText,
      ambientSnapshotKey,
      collectionMethodKey,
      pagesContentVersion,
      diagnostics: diagnostics.slice(),
    });

    return diagnostics;
  }

  collectProjectRuleDiagnostics(filePath, documentText, documentAnalysis) {
    const laneDiagnostics = this.collectProjectRuleDiagnosticsByLane(
      filePath,
      documentText,
      documentAnalysis
    );
    return [
      ...laneDiagnostics["project-rule:agents"],
      ...laneDiagnostics["project-rule:include-callers"],
    ];
  }

  collectProjectRuleLaneDiagnostics(lane, filePath, documentText, documentAnalysis) {
    if (lane === "project-rule:agents") {
      return this.collectProjectRuleAgentsDiagnostics(filePath, documentText, documentAnalysis);
    }

    if (lane === "project-rule:include-callers") {
      return this.collectProjectRuleIncludeCallerDiagnostics(filePath, documentText);
    }

    return this.collectProjectRuleDiagnostics(filePath, documentText, documentAnalysis);
  }

  collectProjectRuleDiagnosticsByLane(filePath, documentText, documentAnalysis) {
    return {
      "project-rule:agents": this.collectProjectRuleAgentsDiagnostics(filePath, documentText, documentAnalysis),
      "project-rule:include-callers": this.collectProjectRuleIncludeCallerDiagnostics(filePath, documentText),
    };
  }

  collectProjectRuleAgentsDiagnostics(filePath, documentText, documentAnalysis) {
    return collectAgentsRuleDiagnostics(this.projectIndex, filePath, documentText, {
      analysisText: documentAnalysis.getAnalysisText(),
      analysisSourceFile: documentAnalysis.getAnalysisSourceFile(),
      pathContexts: documentAnalysis.getPathContexts(),
    });
  }

  collectProjectRuleIncludeCallerDiagnostics(filePath, documentText) {
    return this.getIncludeCallerDiagnostics(filePath, documentText);
  }

  getDiagnostics(filePath, documentText, options = {}) {
    return diagnosticsFeatureHandlers.getDiagnostics(this, filePath, documentText, options);
  }

  getCodeActions(filePath, documentText, range, options = {}) {
    return diagnosticsFeatureHandlers.getCodeActions(this, filePath, documentText, range, options);
  }

  getDefinitionTarget(filePath, documentText, offset) {
    return navigationFeatureHandlers.getDefinitionTarget(this, filePath, documentText, offset);
  }

  getCustomDefinitionTarget(filePath, documentText, offset) {
    return navigationFeatureHandlers.getCustomDefinitionTarget(this, filePath, documentText, offset);
  }

  getRenameInfo(filePath, documentText, offset) {
    return navigationFeatureHandlers.getRenameInfo(this, filePath, documentText, offset);
  }

  getCustomRenameInfo(filePath, documentText, offset) {
    return navigationFeatureHandlers.getCustomRenameInfo(this, filePath, documentText, offset);
  }

  getTypeScriptRenameInfo(filePath, documentText, offset, options = {}) {
    return navigationFeatureHandlers.getTypeScriptRenameInfo(this, filePath, documentText, offset, options);
  }

  getRenameEdits(filePath, documentText, offset, newName) {
    return navigationFeatureHandlers.getRenameEdits(
      this,
      filePath,
      documentText,
      offset,
      newName
    );
  }

  getCustomRenameEdits(filePath, documentText, offset, newName) {
    return navigationFeatureHandlers.getCustomRenameEdits(
      this,
      filePath,
      documentText,
      offset,
      newName
    );
  }

  getTypeScriptRenameEdits(filePath, documentText, offset, newName, options = {}) {
    return navigationFeatureHandlers.getTypeScriptRenameEdits(
      this,
      filePath,
      documentText,
      offset,
      newName,
      options
    );
  }

  getReferenceTargets(filePath, documentText, offset, options = {}) {
    return navigationFeatureHandlers.getReferenceTargets(
      this,
      filePath,
      documentText,
      offset,
      options
    );
  }

  getCustomReferenceTargets(filePath, documentText, offset, options = {}) {
    return navigationFeatureHandlers.getCustomReferenceTargets(
      this,
      filePath,
      documentText,
      offset,
      options
    );
  }

  getDocumentLinks(filePath, documentText) {
    return navigationFeatureHandlers.getDocumentLinks(this, filePath, documentText);
  }
}

const PocketPagesLanguageServiceManager = createPocketPagesLanguageServiceManager({
  ProjectLanguageService,
  findAppRoot,
  isSameOrChildPath,
  normalizePath,
});

module.exports = {
  PocketPagesLanguageServiceManager,
  buildSchemaFieldDiagnostic,
  collectRedirectReturnDiagnostics,
  findAppRoot,
  ts,
};
