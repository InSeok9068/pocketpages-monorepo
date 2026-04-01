"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { buildTemplateVirtualText, extractTemplateCodeBlocks, getTemplateCodeBlockAtOffset } = require("./ejs-template");
const { extractServerBlocks, getServerBlockAtOffset } = require("./script-server");
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
} = require("./custom-context");
const { collectParamsFlowDiagnostics } = require("./flow-analysis");

const CACHE_ROOT = path.resolve(__dirname, "..", ".cache");
const COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: false,
  strict: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  allowSyntheticDefaultImports: true,
  useUnknownInCatchVariables: false,
  maxNodeModuleJsDepth: 2,
};

function normalizePath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
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

function isEjsFile(filePath) {
  return path.extname(String(filePath || "")).toLowerCase() === ".ejs";
}

function isScriptFile(filePath) {
  return [".js", ".cjs", ".mjs"].includes(path.extname(String(filePath || "")).toLowerCase());
}

function isPrivatePagesFile(filePath) {
  return normalizePath(filePath).includes("/pb_hooks/pages/_private/");
}

function stripKnownExtension(filePath, extensions) {
  for (const extension of extensions) {
    if (filePath.endsWith(extension)) {
      return filePath.slice(0, -extension.length);
    }
  }

  return filePath;
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

function collectStaticRequireCallContexts(documentText) {
  const contexts = [];
  const requireRe = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

  for (const match of documentText.matchAll(requireRe)) {
    const fullText = match[0];
    const quote = match[1];
    const value = match[2];
    const quoteOffset = fullText.indexOf(quote);
    const start = match.index + quoteOffset + 1;
    const end = start + value.length;

    contexts.push({
      kind: "require-path",
      value,
      start,
      end,
    });
  }

  return contexts;
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

function sanitizeFileName(filePath) {
  return filePath.replace(/[:\\/()[\]\s]+/g, "_");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  const spans = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "resolve"
    ) {
      spans.push({
        start: node.expression.getStart(sourceFile),
        end: node.expression.getEnd(),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return spans;
}

function collectResolveCallSpansFromTemplate(documentText) {
  const spans = [];
  const regex = /\bresolve\s*\(/g;
  let match = regex.exec(documentText);

  while (match) {
    spans.push({
      start: match.index,
      end: match.index + "resolve".length,
    });
    match = regex.exec(documentText);
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

function getPropertyAccessChain(node) {
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
    return projectIndex.getResolveCandidates(filePath);
  }

  if (context.kind === "include-path") {
    return projectIndex.getIncludeCandidates(filePath);
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
  const pathContexts = Array.isArray(options.pathContexts) ? options.pathContexts : collectPathContexts(documentText);

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
  const pathContexts = Array.isArray(options.pathContexts) ? options.pathContexts : collectPathContexts(documentText);
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

function buildSchemaFieldDiagnostic(projectIndex, context, analysisText, offsetBase = 0) {
  const reference = projectIndex.inferCollectionReference(
    context.receiverExpression,
    analysisText,
    context.start
  );

  if (!reference || projectIndex.hasField(reference.collectionName, context.value)) {
    return null;
  }

  if (reference.confidence === "low") {
    return null;
  }

  return {
    code: "pp-schema-field",
    category:
      reference.confidence === "high"
        ? ts.DiagnosticCategory.Warning
        : ts.DiagnosticCategory.Suggestion,
    message:
      reference.confidence === "high"
        ? `Unknown field "${context.value}" for collection "${reference.collectionName}".`
        : `Possible unknown field "${context.value}". Inferred collection: "${reference.collectionName}" (${reference.confidence} confidence).`,
    start: offsetBase + context.start,
    end: offsetBase + context.end,
  };
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

class ProjectLanguageService {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.projectIndex = new PocketPagesProjectIndex(appRoot);
    this.projectVersion = 0;
    this.staticFiles = new Map();
    this.virtualFiles = new Map();
    this.includePreludeStack = new Set();
    this.documentOverrides = new Map();
    this.includeContractCache = new Map();
    this.includeCallEntriesCache = new Map();

    this.languageService = ts.createLanguageService(this.createHost(), ts.createDocumentRegistry());
  }

  setDocumentOverride(filePath, text) {
    const normalizedFilePath = normalizePath(filePath);
    const currentText = typeof text === "string" ? text : "";
    const previousText = this.documentOverrides.get(normalizedFilePath);
    if (previousText === currentText) {
      return;
    }

    this.documentOverrides.set(normalizedFilePath, currentText);
    this.includeCallEntriesCache.delete(normalizedFilePath);
    this.includeContractCache.delete(normalizedFilePath);
    this.projectVersion += 1;
  }

  clearDocumentOverride(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (this.documentOverrides.delete(normalizedFilePath)) {
      this.includeCallEntriesCache.delete(normalizedFilePath);
      this.includeContractCache.delete(normalizedFilePath);
      this.projectVersion += 1;
    }
  }

  resetCaches() {
    this.includeContractCache.clear();
    this.includeCallEntriesCache.clear();
    this.includePreludeStack.clear();
    this.staticFiles.clear();
    this.virtualFiles.clear();
    this.projectIndex.resetCaches();
    this.projectVersion += 1;
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
    const overrides = {};

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const filePath = normalizePath(entry.filePath);
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
      getScriptFileNames: () => [...Array.from(this.staticFiles.keys()), ...Array.from(this.virtualFiles.keys())],
      getScriptVersion: (fileName) => this.getFileState(fileName)?.version || "0",
      getScriptSnapshot: (fileName) => {
        const state = this.getFileState(fileName);
        if (state) {
          return ts.ScriptSnapshot.fromString(state.text);
        }

        if (!ts.sys.fileExists(fileName)) {
          return undefined;
        }

        return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || "");
      },
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
    return this.virtualFiles.get(fileName) || this.staticFiles.get(fileName) || null;
  }

  hasFile(fileName) {
    return this.virtualFiles.has(fileName) || this.staticFiles.has(fileName) || ts.sys.fileExists(fileName);
  }

  readFile(fileName) {
    const state = this.getFileState(fileName);
    if (state) {
      return state.text;
    }

    return ts.sys.readFile(fileName);
  }

  ensureStaticFile(filePath) {
    const resolvedPath = normalizePath(filePath);

    if (!fileExists(resolvedPath)) {
      if (this.staticFiles.delete(resolvedPath)) {
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

    this.staticFiles.set(resolvedPath, {
      text,
      mtimeMs: stats.mtimeMs,
      version: previous ? String(Number(previous.version) + 1) : "1",
    });
    this.projectVersion += 1;
  }

  upsertStaticFileText(filePath, text) {
    const resolvedPath = normalizePath(filePath);
    const previous = this.staticFiles.get(resolvedPath);

    if (previous && previous.text === text) {
      return;
    }

    this.staticFiles.set(resolvedPath, {
      text,
      mtimeMs: previous ? previous.mtimeMs : 0,
      version: previous ? String(Number(previous.version) + 1) : "1",
    });
    this.projectVersion += 1;
  }

  refreshStaticFiles() {
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

    const recordGetPrelude = this.buildRecordGetTypePrelude(analysisText);
    if (recordGetPrelude) {
      parts.push(recordGetPrelude);
    }

    const includeLocalsPrelude = !options.skipIncludeLocals && isEjsFile(filePath) ? this.buildIncludeLocalsPrelude(filePath) : "";
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

    return `${parts.join("\n\n")}\n\n`;
  }

  buildRecordGetTypePrelude(analysisText) {
    if (!analysisText) {
      return "";
    }

    const fieldNames = [...new Set(
      collectSchemaContexts(analysisText, {
        collectionMethodNames: this.projectIndex.getCollectionMethodNames(),
      })
        .filter((context) => context.kind === "record-field" && context.accessMethod === "get")
        .map((context) => context.value)
        .filter(Boolean)
    )];
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
        return "";
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

      return bindingLines.join("\n");
    } finally {
      this.includePreludeStack.delete(normalizedFilePath);
    }
  }

  collectIncludeTargetCallSites(targetFilePath) {
    return this.projectIndex.getIncludeTargetCallSites(targetFilePath, {
      overrides: this.getPagesCodeOverrides(),
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
      const tempFilePath = normalizePath(path.join(CACHE_ROOT, `${sanitizeFileName(normalizedTargetFilePath)}__include_contract.ts`));
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

  upsertVirtualFile(filePath, block) {
    this.refreshStaticFiles();

    const resolvedPath = normalizePath(filePath);
    const relativePath = path.relative(this.appRoot, resolvedPath);
    const virtualDir = path.join(CACHE_ROOT, sanitizeFileName(this.appRoot));
    const virtualFileName = normalizePath(path.join(virtualDir, `${sanitizeFileName(relativePath)}__block_${block.index}.ts`));

    const prelude = this.buildPrelude(resolvedPath, block.content);
    const text = `${prelude}${block.content}`;
    const previous = this.virtualFiles.get(virtualFileName);

    if (!previous || previous.text !== text) {
      ensureDir(virtualDir);
      fs.writeFileSync(virtualFileName, text, "utf8");

      this.virtualFiles.set(virtualFileName, {
        text,
        version: previous ? String(Number(previous.version) + 1) : "1",
        filePath: resolvedPath,
        blockIndex: block.index,
        preludeLength: prelude.length,
        block,
      });
      this.projectVersion += 1;
    } else {
      previous.block = block;
      previous.preludeLength = prelude.length;
    }

    return {
      fileName: virtualFileName,
      preludeLength: prelude.length,
      block,
    };
  }

  upsertTemplateVirtualFile(filePath, documentText) {
    this.refreshStaticFiles();

    const resolvedPath = normalizePath(filePath);
    const relativePath = path.relative(this.appRoot, resolvedPath);
    const virtualDir = path.join(CACHE_ROOT, sanitizeFileName(this.appRoot));
    const virtualFileName = normalizePath(path.join(virtualDir, `${sanitizeFileName(relativePath)}__template.ts`));

    const templateVirtualText = buildTemplateVirtualText(documentText);
    const prelude = this.buildPrelude(resolvedPath, templateVirtualText);
    const text = `${prelude}${templateVirtualText}`;
    const previous = this.virtualFiles.get(virtualFileName);

    if (!previous || previous.text !== text) {
      ensureDir(virtualDir);
      fs.writeFileSync(virtualFileName, text, "utf8");

      this.virtualFiles.set(virtualFileName, {
        text,
        version: previous ? String(Number(previous.version) + 1) : "1",
        filePath: resolvedPath,
        preludeLength: prelude.length,
        kind: "template-document",
        documentLength: documentText.length,
      });
      this.projectVersion += 1;
    } else {
      previous.preludeLength = prelude.length;
      previous.documentLength = documentText.length;
    }

    return {
      fileName: virtualFileName,
      preludeLength: prelude.length,
    };
  }

  upsertScriptVirtualFile(filePath, documentText) {
    this.refreshStaticFiles();

    const resolvedPath = normalizePath(filePath);
    const relativePath = path.relative(this.appRoot, resolvedPath);
    const virtualDir = path.join(CACHE_ROOT, sanitizeFileName(this.appRoot));
    const virtualFileName = normalizePath(path.join(virtualDir, `${sanitizeFileName(relativePath)}__script.ts`));

    const prelude = this.buildPrelude(resolvedPath, documentText);
    const text = `${prelude}${documentText}`;
    const previous = this.virtualFiles.get(virtualFileName);

    if (!previous || previous.text !== text) {
      ensureDir(virtualDir);
      fs.writeFileSync(virtualFileName, text, "utf8");

      this.virtualFiles.set(virtualFileName, {
        text,
        version: previous ? String(Number(previous.version) + 1) : "1",
        filePath: resolvedPath,
        preludeLength: prelude.length,
        kind: "script-document",
        documentLength: documentText.length,
      });
      this.projectVersion += 1;
    } else {
      previous.preludeLength = prelude.length;
      previous.documentLength = documentText.length;
    }

    return {
      fileName: virtualFileName,
      preludeLength: prelude.length,
    };
  }

  mapVirtualOffsetToDocumentOffset(virtualFileName, offset) {
    const state = this.virtualFiles.get(virtualFileName);
    if (!state) {
      return null;
    }

    if (offset < state.preludeLength) {
      return null;
    }

    const relativeOffset = offset - state.preludeLength;
    if (state.kind === "template-document" || state.kind === "script-document") {
      if (relativeOffset < 0 || relativeOffset > state.documentLength) {
        return null;
      }

      return relativeOffset;
    }

    return state.block.contentStart + relativeOffset;
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

  getTypeScriptDefinitionTarget(filePath, documentText, offset) {
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset);
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
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset);
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

  getVirtualStateAtOffset(filePath, documentText, offset) {
    if (isScriptFile(filePath)) {
      const virtual = this.upsertScriptVirtualFile(filePath, documentText);

      return {
        block: null,
        virtual,
        virtualOffset: virtual.preludeLength + offset,
      };
    }

    const block = getServerBlockAtOffset(documentText, offset);
    const virtual = block
      ? this.upsertVirtualFile(filePath, block)
      : getTemplateCodeBlockAtOffset(documentText, offset)
        ? this.upsertTemplateVirtualFile(filePath, documentText)
        : null;

    if (!virtual) {
      return null;
    }

    return {
      block,
      virtual,
      virtualOffset: block ? virtual.preludeLength + (offset - block.contentStart) : virtual.preludeLength + offset,
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
    const pathContext = getPathContextAtOffset(documentText, offset);
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
    return this.getPathReferenceContext(filePath, documentText, offset);
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

    const routeEntry = this.projectIndex.getStaticRouteEntryByFilePath(normalizedFilePath);
    if (!routeEntry) {
      return null;
    }

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

  collectPathReferenceLocations(pathKind, targetFilePath, overrides = {}) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const uniqueLocations = new Map();

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const codeFilePath = normalizePath(entry.filePath);
      const documentText =
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : this.getDocumentText(codeFilePath);

      for (const pathContext of collectPathContexts(documentText)) {
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
      if (!isScriptFile(codeFilePath)) {
        continue;
      }

      const documentText =
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : this.getDocumentText(codeFilePath);

      for (const requireContext of collectStaticRequireCallContexts(documentText)) {
        const resolvedTargetFilePath = this.projectIndex.resolveRequireTarget(codeFilePath, requireContext.value);
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

    if (referenceQuery.kind === "route-file") {
      return this.collectPathReferenceLocations("route-path", referenceQuery.targetFilePath, overrides);
    }

    return null;
  }

  getFileRenameEdits(oldFilePath, newFilePath) {
    const referenceQuery = this.getFileReferenceQuery(oldFilePath);
    if (!referenceQuery || !isPrivatePagesFile(oldFilePath)) {
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

    return [...uniqueEdits.values()];
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
      const pathContexts = collectPathContexts(documentText);

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
      const pathContexts = collectPathContexts(documentText);

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
      if (!isScriptFile(filePath)) {
        continue;
      }

      const documentText = this.getCallerDocumentText(filePath, overrides);
      const requireContexts = collectStaticRequireCallContexts(documentText);

      for (const requireContext of requireContexts) {
        if (!this.isRequireRequestForTarget(filePath, requireContext.value, oldTargetFilePath)) {
          continue;
        }

        const newValue = this.buildUpdatedRequireRequestPath(filePath, requireContext.value, newTargetFilePath);
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
    const normalizedRequestPath = String(requestPath || "").trim().replace(/^\/+/, "");
    if (!normalizedRequestPath) {
      return false;
    }

    for (const privateRoot of this.projectIndex.getPrivateSearchRoots(filePath)) {
      const candidatePaths = [
        normalizePath(path.join(privateRoot, normalizedRequestPath)),
        ...[".js", ".cjs", ".mjs"].map((extension) => normalizePath(path.join(privateRoot, `${normalizedRequestPath}${extension}`))),
        ...[".js", ".cjs", ".mjs"].map((extension) =>
          normalizePath(path.join(privateRoot, normalizedRequestPath, `index${extension}`))
        ),
      ];

      if (candidatePaths.includes(normalizedTargetFilePath)) {
        return true;
      }
    }

    return false;
  }

  isRequireRequestForTarget(filePath, requestPath, targetFilePath) {
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const normalizedRequestPath = String(requestPath || "").trim();
    if (!normalizedRequestPath) {
      return false;
    }

    const currentDir = normalizePath(path.dirname(filePath));
    const basePath = normalizedRequestPath.startsWith("/")
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
    const normalizedTargetFilePath = normalizePath(targetFilePath);
    const normalizedRequestPath = String(requestPath || "").trim().replace(/^\/+/, "");
    if (!normalizedRequestPath) {
      return null;
    }

    for (const privateRoot of this.projectIndex.getPrivateSearchRoots(filePath)) {
      const candidatePaths = [
        normalizePath(path.join(privateRoot, normalizedRequestPath)),
        ...[".js", ".cjs", ".mjs"].map((extension) => normalizePath(path.join(privateRoot, `${normalizedRequestPath}${extension}`))),
        ...[".js", ".cjs", ".mjs"].map((extension) =>
          normalizePath(path.join(privateRoot, normalizedRequestPath, `index${extension}`))
        ),
      ];

      if (candidatePaths.includes(normalizedTargetFilePath)) {
        return privateRoot;
      }
    }

    return null;
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
    const leadingSlashPrefix = String(currentRequestPath || "").match(/^\/+/);
    const matchedPrivateRoot = this.getMatchingResolveRoot(filePath, currentRequestPath, oldTargetFilePath);
    const candidateRoots = [];

    if (matchedPrivateRoot && isSameOrChildPath(matchedPrivateRoot, newTargetFilePath)) {
      candidateRoots.push(matchedPrivateRoot);
    }

    for (const privateRoot of this.projectIndex.getPrivateSearchRoots(filePath)) {
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

      return `${leadingSlashPrefix ? leadingSlashPrefix[0] : ""}${requestPath}`;
    }

    return null;
  }

  buildUpdatedRequireRequestPath(filePath, currentRequestPath, newTargetFilePath) {
    const normalizedCurrentRequestPath = String(currentRequestPath || "").trim();
    const keepExtension = !!path.extname(normalizedCurrentRequestPath);

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

  getCompletionData(filePath, documentText, offset) {
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset);
    if (!virtualState) {
      return null;
    }

    const { virtual, virtualOffset } = virtualState;
    const info = this.languageService.getCompletionsAtPosition(virtual.fileName, virtualOffset, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForModuleExports: false,
    });

    if (!info) {
      return null;
    }

    let replacementSpan = null;
    if (info.optionalReplacementSpan) {
      const start = this.mapVirtualOffsetToDocumentOffset(virtual.fileName, info.optionalReplacementSpan.start);
      const end = this.mapVirtualOffsetToDocumentOffset(virtual.fileName, info.optionalReplacementSpan.start + info.optionalReplacementSpan.length);

      if (start !== null && end !== null) {
        replacementSpan = { start, end };
      }
    }

    return {
      entries: info.entries,
      replacementSpan,
      virtualFileName: virtual.fileName,
      virtualOffset,
    };
  }

  getCustomCompletionData(filePath, documentText, offset) {
    const collectionMethodNames = this.projectIndex.getCollectionMethodNames();
    const pathContext = getPathContextAtOffset(documentText, offset);
    if (pathContext && (pathContext.kind === "resolve-path" || pathContext.kind === "include-path" || pathContext.kind === "asset-path" || pathContext.kind === "route-path")) {
      const candidates =
        pathContext.kind === "resolve-path"
          ? this.projectIndex.getResolveCandidates(filePath)
          : pathContext.kind === "include-path"
            ? this.projectIndex.getIncludeCandidates(filePath)
            : pathContext.kind === "asset-path"
              ? this.projectIndex.getAssetCandidates(filePath)
            : this.projectIndex.getRouteCandidates({ routeSource: pathContext.routeSource });

      return {
        start: pathContext.start,
        end: pathContext.end,
        items: candidates.map((candidate) => ({
          label: candidate.value,
          insertText: candidate.value,
          detail: candidate.detail,
          documentation: candidate.filePath,
          targetFilePath: candidate.filePath,
          category: pathContext.kind,
        })),
      };
    }

    const includeLocalCompletion = this.getIncludeLocalCompletionData(filePath, documentText, offset);
    if (includeLocalCompletion) {
      return includeLocalCompletion;
    }

    const analysisContext = getAnalysisContextAtOffset(filePath, documentText, offset);
    if (!analysisContext) {
      return null;
    }

    const { analysisText, analysisOffset, analysisStart } = analysisContext;

    const collectionContext = getScriptCollectionContext(analysisText, analysisOffset, { collectionMethodNames });
    if (collectionContext) {
      return {
        start: analysisStart + collectionContext.start,
        end: analysisStart + collectionContext.end,
        items: this.projectIndex.getCollectionNames().map((collectionName) => ({
          label: collectionName,
          insertText: collectionName,
          detail: "PocketBase collection",
          documentation: `Collection from ${this.projectIndex.getSchemaState().schemaPath}`,
          category: "collection-name",
        })),
      };
    }

    const fieldContext = getScriptFieldContext(analysisText, analysisOffset);
    if (fieldContext) {
      const collectionName = this.projectIndex.inferCollectionName(
        fieldContext.receiverExpression,
        analysisText,
        fieldContext.start
      );

      if (!collectionName) {
        return null;
      }

      return {
        start: analysisStart + fieldContext.start,
        end: analysisStart + fieldContext.end,
        items: this.projectIndex.getFields(collectionName).map((field) => ({
          label: field.name,
          insertText: field.name,
          detail: `${collectionName}.${field.name}`,
          documentation: field.type ? `Field type: ${field.type}` : collectionName,
          category: "record-field",
        })),
      };
    }

    return null;
  }

  getCompletionDetails(virtualFileName, virtualOffset, name, source) {
    return this.languageService.getCompletionEntryDetails(virtualFileName, virtualOffset, name, {}, source, {});
  }

  getQuickInfo(filePath, documentText, offset) {
    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset);
    if (!virtualState) {
      return null;
    }

    const { virtual, virtualOffset } = virtualState;
    const quickInfo = this.languageService.getQuickInfoAtPosition(virtual.fileName, virtualOffset);

    if (!quickInfo) {
      return null;
    }

    const start = this.mapVirtualOffsetToDocumentOffset(virtual.fileName, quickInfo.textSpan.start);
    const end = this.mapVirtualOffsetToDocumentOffset(virtual.fileName, quickInfo.textSpan.start + quickInfo.textSpan.length);

    return {
      displayText: ts.displayPartsToString(quickInfo.displayParts || []),
      documentation: ts.displayPartsToString(quickInfo.documentation || []),
      start,
      end,
    };
  }

  getSignatureHelp(filePath, documentText, offset, options = {}) {
    const includeSignatureHelp = this.getIncludeSignatureHelp(filePath, documentText, offset);
    if (includeSignatureHelp) {
      return includeSignatureHelp;
    }

    const virtualState = this.getVirtualStateAtOffset(filePath, documentText, offset);
    if (!virtualState) {
      return null;
    }

    const signatureHelp = this.languageService.getSignatureHelpItems(virtualState.virtual.fileName, virtualState.virtualOffset, {
      triggerReason: {
        kind: options.isRetrigger ? "retrigger" : options.triggerCharacter ? "characterTyped" : "invoked",
        triggerCharacter: options.triggerCharacter,
      },
    });

    return signatureHelp || null;
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

    for (const pathContext of collectPathContexts(documentText)) {
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
    const sourceFile = ts.createSourceFile(filePath, analysisText, ts.ScriptTarget.Latest, true);
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

    for (const pathContext of collectPathContexts(documentText)) {
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

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "get" &&
        node.arguments.length &&
        readStringLiteralText(node.arguments[0])
      ) {
        const callStart = node.getStart(sourceFile);
        const callEnd = node.getEnd();
        const typeText = this.getTypeTextAtDocumentSpan(filePath, documentText, callStart, callEnd);
        if (typeText) {
          addEntry(callEnd, `: ${typeText}`, `Field type: ${typeText}`);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
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

  collectServerBlockDiagnostics(filePath, blocks, collectionMethodNames, documentAnalysis) {
    const diagnostics = [];

    for (const block of blocks) {
      const virtual = this.upsertVirtualFile(filePath, block);
      const relaxedBodyDiagnosticSpans = collectRelaxedBodyDiagnosticSpans(block.content, {
        sourceFile: documentAnalysis.getBlockSourceFile(block),
      });
      const rawDiagnostics = [
        ...this.languageService.getSyntacticDiagnostics(virtual.fileName),
        ...this.languageService.getSemanticDiagnostics(virtual.fileName),
      ];

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

      for (const context of collectSchemaContexts(block.content, { collectionMethodNames })) {
        if (context.kind === "collection-name" && !this.projectIndex.hasCollection(context.value)) {
          diagnostics.push(buildSchemaCollectionDiagnostic(context, block.contentStart));
        }

        if (context.kind === "record-field") {
          const fieldDiagnostic = buildSchemaFieldDiagnostic(
            this.projectIndex,
            context,
            block.content,
            block.contentStart
          );

          if (fieldDiagnostic) {
            diagnostics.push(fieldDiagnostic);
          }
        }
      }
    }

    return diagnostics;
  }

  collectTemplateDiagnostics(filePath, documentText, blocks, templateBlocks, collectionMethodNames, documentAnalysis) {
    if (!templateBlocks.length) {
      return [];
    }

    const diagnostics = [];
    const templateVirtual = this.upsertTemplateVirtualFile(filePath, documentText);
    const templateVirtualText = documentAnalysis.getTemplateVirtualText();
    const rawDiagnostics = [
      ...this.languageService.getSyntacticDiagnostics(templateVirtual.fileName),
      ...this.languageService.getSemanticDiagnostics(templateVirtual.fileName),
    ];
    const overlapsTemplateBlock = (start, end) =>
      templateBlocks.some((block) => end >= block.contentStart && start <= block.contentEnd);
    const overlapsServerBlock = (start, end) =>
      blocks.some((block) => end >= block.contentStart && start <= block.contentEnd);

    for (const diagnostic of rawDiagnostics) {
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

    for (const context of collectSchemaContexts(templateVirtualText, { collectionMethodNames })) {
      if (!overlapsTemplateBlock(context.start, context.end) || overlapsServerBlock(context.start, context.end)) {
        continue;
      }

      if (context.kind === "collection-name" && !this.projectIndex.hasCollection(context.value)) {
        diagnostics.push(buildSchemaCollectionDiagnostic(context));
      }

      if (context.kind === "record-field") {
        const fieldDiagnostic = buildSchemaFieldDiagnostic(
          this.projectIndex,
          context,
          templateVirtualText
        );

        if (fieldDiagnostic) {
          diagnostics.push(fieldDiagnostic);
        }
      }
    }

    return diagnostics;
  }

  collectProjectRuleDiagnostics(filePath, documentText, documentAnalysis) {
    const diagnostics = [];

    for (const diagnostic of collectAgentsRuleDiagnostics(this.projectIndex, filePath, documentText, {
      analysisText: documentAnalysis.getAnalysisText(),
      analysisSourceFile: documentAnalysis.getAnalysisSourceFile(),
      pathContexts: documentAnalysis.getPathContexts(),
    })) {
      diagnostics.push(diagnostic);
    }

    for (const diagnostic of this.getIncludeCallerDiagnostics(filePath, documentText)) {
      diagnostics.push(diagnostic);
    }

    return diagnostics;
  }

  getDiagnostics(filePath, documentText) {
    const documentAnalysis = createDocumentAnalysis({
      filePath,
      documentText,
      collectResolveCallSpansFromScript,
      collectResolveCallSpansFromTemplate,
      collectPathContexts,
    });
    const blocks = documentAnalysis.getBlocks();
    const templateBlocks = documentAnalysis.getTemplateBlocks();
    const collectionMethodNames = this.projectIndex.getCollectionMethodNames();
    const diagnostics = collectClientScriptSyntacticDiagnostics(documentText);

    diagnostics.push(...this.collectPrivateResolveDiagnostics(filePath, documentAnalysis));
    diagnostics.push(...this.collectServerBlockDiagnostics(filePath, blocks, collectionMethodNames, documentAnalysis));
    diagnostics.push(...this.collectTemplateDiagnostics(filePath, documentText, blocks, templateBlocks, collectionMethodNames, documentAnalysis));
    diagnostics.push(...this.collectProjectRuleDiagnostics(filePath, documentText, documentAnalysis));

    return dedupeDiagnostics(diagnostics);
  }

  getCodeActions(filePath, documentText, range) {
    if (!range || typeof range.start !== "number" || typeof range.end !== "number") {
      return [];
    }

    const actions = [];
    const actionKeys = new Set();

    for (const diagnostic of this.getDiagnostics(filePath, documentText)) {
      if (!Array.isArray(diagnostic.fixes) || !diagnostic.fixes.length) {
        continue;
      }

      if (!rangesOverlap(diagnostic.start, diagnostic.end, range.start, range.end)) {
        continue;
      }

      for (const fix of diagnostic.fixes) {
        const actionKey = `${diagnostic.code}:${diagnostic.start}:${diagnostic.end}:${fix.title}`;
        if (actionKeys.has(actionKey)) {
          continue;
        }

        actionKeys.add(actionKey);
        actions.push({
          title: fix.title,
          kind: "quickfix",
          diagnostic: {
            code: diagnostic.code,
            start: diagnostic.start,
            end: diagnostic.end,
            message: diagnostic.message,
          },
          edits: (fix.edits || []).map((edit) => ({
            filePath: normalizePath(edit.filePath || filePath),
            start: edit.start,
            end: edit.end,
            newText: edit.newText,
          })),
        });
      }
    }

    return actions;
  }

  getDefinitionTarget(filePath, documentText, offset) {
    const pathContext = getPathContextAtOffset(documentText, offset);
    if (pathContext) {
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
    }

    const resolvedModuleMemberContext = this.getResolvedModuleMemberContextForRename(filePath, documentText, offset);
    if (resolvedModuleMemberContext) {
      const moduleFilePath = this.projectIndex.resolveResolveTarget(filePath, resolvedModuleMemberContext.modulePath);
      return this.projectIndex.resolveResolvedModuleMemberTarget(
        filePath,
        resolvedModuleMemberContext.modulePath,
        resolvedModuleMemberContext.memberName,
        moduleFilePath ? this.getDocumentOverride(moduleFilePath) : null
      );
    }

    return this.getTypeScriptDefinitionTarget(filePath, documentText, offset);
  }

  getRenameInfo(filePath, documentText, offset) {
    const resolvedModuleMemberContext = this.getResolvedModuleMemberContextForRename(filePath, documentText, offset);
    if (!resolvedModuleMemberContext) {
      const moduleExportContext = this.getModuleExportRenameContext(filePath, documentText, offset);
      if (!moduleExportContext) {
        return null;
      }

      return {
        canRename: true,
        ...moduleExportContext,
      };
    }

    const moduleDefinitionInfo = this.projectIndex.getResolvedModuleMemberDefinitionInfo(
      filePath,
      resolvedModuleMemberContext.modulePath,
      resolvedModuleMemberContext.memberName,
      (() => {
        const moduleFilePath = this.projectIndex.resolveResolveTarget(filePath, resolvedModuleMemberContext.modulePath);
        return moduleFilePath ? this.getDocumentOverride(moduleFilePath) : null;
      })()
    );
    if (!moduleDefinitionInfo) {
      return null;
    }

    const moduleRename = this.getModuleRenameLocations(moduleDefinitionInfo, {
      [normalizePath(moduleDefinitionInfo.filePath)]: this.getDocumentOverride(moduleDefinitionInfo.filePath),
    });
    if (!moduleRename.canRename) {
      return {
        canRename: false,
        localizedErrorMessage: moduleRename.localizedErrorMessage || "Unable to rename this module member.",
        start: resolvedModuleMemberContext.start,
        end: resolvedModuleMemberContext.end,
        placeholder: resolvedModuleMemberContext.memberName,
      };
    }

    return {
      canRename: true,
      source: resolvedModuleMemberContext.source,
      start: resolvedModuleMemberContext.start,
      end: resolvedModuleMemberContext.end,
      placeholder: resolvedModuleMemberContext.memberName,
      moduleDefinitionInfo,
    };
  }

  getRenameEdits(filePath, documentText, offset, newName) {
    const renameInfo = this.getRenameInfo(filePath, documentText, offset);
    if (!renameInfo) {
      return null;
    }

    if (!renameInfo.canRename) {
      return {
        canRename: false,
        localizedErrorMessage: renameInfo.localizedErrorMessage || "Unable to rename this module member.",
        edits: [],
      };
    }

    if (!isValidIdentifierName(newName)) {
      return {
        canRename: false,
        localizedErrorMessage: `Invalid identifier name "${newName}".`,
        edits: [],
      };
    }

    const moduleRename = this.getModuleRenameLocations(renameInfo.moduleDefinitionInfo, this.getPagesCodeOverrides({
      [normalizePath(filePath)]: isScriptFile(filePath) ? documentText : undefined,
    }));
    if (!moduleRename.canRename) {
      return {
        canRename: false,
        localizedErrorMessage: moduleRename.localizedErrorMessage || "Unable to rename this module member.",
        edits: [],
      };
    }

    const uniqueEdits = new Map();

    if (renameInfo.source !== "module-export") {
      for (const location of moduleRename.locations) {
        const editKey = `${normalizePath(location.fileName)}:${location.textSpan.start}:${location.textSpan.start + location.textSpan.length}:${newName}`;
        if (!uniqueEdits.has(editKey)) {
          uniqueEdits.set(editKey, {
            filePath: normalizePath(location.fileName),
            start: location.textSpan.start,
            end: location.textSpan.start + location.textSpan.length,
            newText: `${location.prefixText || ""}${newName}${location.suffixText || ""}`,
          });
        }
      }
    }

    for (const edit of this.collectResolvedModuleMemberUsageEdits(
      renameInfo.moduleDefinitionInfo.filePath,
      renameInfo.placeholder,
      newName,
      this.getPagesCodeOverrides({ [normalizePath(filePath)]: documentText })
    )) {
      const editKey = `${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`;
      if (!uniqueEdits.has(editKey)) {
        uniqueEdits.set(editKey, edit);
      }
    }

    return {
      canRename: true,
      edits: [...uniqueEdits.values()],
    };
  }

  getReferenceTargets(filePath, documentText, offset, options = {}) {
    const pathReferenceContext = this.getPathReferenceContext(filePath, documentText, offset);
    if (pathReferenceContext) {
      return this.collectPathReferenceLocations(
        pathReferenceContext.kind,
        pathReferenceContext.targetFilePath,
        this.getPagesCodeOverrides({ [normalizePath(filePath)]: documentText })
      );
    }

    const renameInfo = this.getRenameInfo(filePath, documentText, offset);
    if (!renameInfo) {
      const typeScriptReferences = this.getTypeScriptReferenceTargets(filePath, documentText, offset, options);
      const fileReferenceContext = this.getPrivateIncludeReferenceContext(filePath);
      if (typeScriptReferences && typeScriptReferences.locations.length) {
        if (!fileReferenceContext || typeScriptReferences.hasMappedDefinition || typeScriptReferences.hasExternalReference) {
          return typeScriptReferences.locations;
        }
      }

      if (!fileReferenceContext) {
        return null;
      }

      return this.collectPathReferenceLocations(fileReferenceContext.kind, fileReferenceContext.targetFilePath, this.getPagesCodeOverrides({
        [normalizePath(filePath)]: documentText,
      }));
    }

    const moduleRename = this.getModuleRenameLocations(renameInfo.moduleDefinitionInfo, this.getPagesCodeOverrides({
      [normalizePath(filePath)]: isScriptFile(filePath) ? documentText : undefined,
    }));
    if (!moduleRename.canRename) {
      return [];
    }

    const uniqueLocations = new Map();
    const addLocation = (location) => {
      if (!location) {
        return;
      }

      const locationKey = `${normalizePath(location.filePath)}:${location.start}:${location.end}`;
      if (!uniqueLocations.has(locationKey)) {
        uniqueLocations.set(locationKey, {
          filePath: normalizePath(location.filePath),
          start: location.start,
          end: location.end,
        });
      }
    };

    for (const location of moduleRename.locations) {
      const start = location.textSpan.start;
      const end = location.textSpan.start + location.textSpan.length;
      if (
        !options.includeDeclaration &&
        normalizePath(location.fileName) === normalizePath(renameInfo.moduleDefinitionInfo.filePath) &&
        start === renameInfo.moduleDefinitionInfo.start &&
        end === renameInfo.moduleDefinitionInfo.end
      ) {
        continue;
      }

      addLocation({
        filePath: location.fileName,
        start,
        end,
      });
    }

    for (const location of this.collectResolvedModuleMemberUsageLocations(
      renameInfo.moduleDefinitionInfo.filePath,
      renameInfo.placeholder,
      this.getPagesCodeOverrides({ [normalizePath(filePath)]: documentText })
    )) {
      addLocation(location);
    }

    return [...uniqueLocations.values()];
  }

  getDocumentLinks(filePath, documentText) {
    const links = [];

    for (const pathContext of collectPathContexts(documentText)) {
      let targetFilePath = null;

      if (pathContext.kind === "resolve-path") {
        targetFilePath = this.projectIndex.resolveResolveTarget(filePath, pathContext.value);
      } else if (pathContext.kind === "include-path") {
        targetFilePath = this.projectIndex.resolveIncludeTarget(filePath, pathContext.value);
      } else if (pathContext.kind === "asset-path") {
        targetFilePath = this.projectIndex.resolveAssetTarget(filePath, pathContext.value);
      } else if (pathContext.kind === "route-path") {
        targetFilePath = this.projectIndex.resolveRouteTarget(filePath, pathContext.value, {
          routeSource: pathContext.routeSource,
        });
      }

      if (!targetFilePath) {
        continue;
      }

      links.push({
        start: pathContext.start,
        end: pathContext.end,
        targetFilePath,
        kind: pathContext.kind,
        value: pathContext.value,
      });
    }

    return links;
  }
}

class PocketPagesLanguageServiceManager {
  constructor() {
    this.services = new Map();
  }

  getServiceForFile(filePath) {
    const appRoot = findAppRoot(filePath);
    if (!appRoot) {
      return null;
    }

    if (!this.services.has(appRoot)) {
      this.services.set(appRoot, new ProjectLanguageService(appRoot));
    }

    return this.services.get(appRoot);
  }

  resetCachesForFile(filePath) {
    const service = this.getServiceForFile(filePath);
    if (!service) {
      return null;
    }

    service.resetCaches();
    return service;
  }

  resetAllCaches() {
    for (const service of this.services.values()) {
      service.resetCaches();
    }
  }
}

module.exports = {
  PocketPagesLanguageServiceManager,
  findAppRoot,
  ts,
};
