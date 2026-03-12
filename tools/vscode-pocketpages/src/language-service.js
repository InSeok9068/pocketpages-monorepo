"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { buildTemplateVirtualText, extractTemplateCodeBlocks, getTemplateCodeBlockAtOffset } = require("./ejs-template");
const { extractServerBlocks, getServerBlockAtOffset } = require("./script-server");
const { PocketPagesProjectIndex } = require("./project-index");
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

function collectRelaxedBodyDiagnosticSpans(scriptText) {
  const sourceFile = ts.createSourceFile("pocketpages-body-relaxation.ts", scriptText, ts.ScriptTarget.Latest, true);
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

function collectResolveCallSpansFromScript(scriptText) {
  const sourceFile = ts.createSourceFile("pocketpages-private-resolve.ts", scriptText, ts.ScriptTarget.Latest, true);
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

function collectParamsQueryDiagnostics(scriptText, allowedRouteParamNames) {
  const sourceFile = ts.createSourceFile("pocketpages-agents-params.ts", scriptText, ts.ScriptTarget.Latest, true);
  const diagnostics = [];
  const allowedNames = new Set((Array.isArray(allowedRouteParamNames) ? allowedRouteParamNames : []).filter(Boolean));

  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    ) {
      const chain = getPropertyAccessChain(node);
      if (chain.root && ts.isIdentifier(chain.root) && chain.root.text === "params") {
        const topPropertyName = chain.segments[0] || "";
        if (topPropertyName && topPropertyName !== "__flash" && !allowedNames.has(topPropertyName)) {
          diagnostics.push({
            code: "pp-query-via-params",
            category: ts.DiagnosticCategory.Warning,
            message: 'Use request.url.query for query string access. "params" is reserved for route params in this repo.',
            start: node.getStart(sourceFile),
            end: node.getEnd(),
            fixes: [
              {
                title: "Use request.url.query",
                edits: [
                  {
                    start: chain.root.getStart(sourceFile),
                    end: chain.root.getEnd(),
                    newText: "request.url.query",
                  },
                ],
              },
            ],
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
}

function collectIncludeContextDiagnostics(scriptText) {
  const sourceFile = ts.createSourceFile("pocketpages-agents-include.ts", scriptText, ts.ScriptTarget.Latest, true);
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
            message: "Do not pass PocketPages full context objects into partials. Pass only the values the partial needs.",
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

function collectAgentsRuleDiagnostics(projectIndex, filePath, documentText) {
  const diagnostics = [];
  const analysisText = isEjsFile(filePath) ? buildTemplateVirtualText(documentText) : documentText;
  const routeParamNames = projectIndex.getRouteParamEntries(filePath).map((entry) => entry.name);

  for (const diagnostic of collectParamsQueryDiagnostics(analysisText, routeParamNames)) {
    diagnostics.push(diagnostic);
  }

  for (const diagnostic of collectIncludeContextDiagnostics(analysisText)) {
    diagnostics.push(diagnostic);
  }

  for (const context of collectPathContexts(documentText)) {
    if (context.kind === "resolve-path" && /^\/?_private\//.test(context.value)) {
      diagnostics.push({
        code: "pp-resolve-private-prefix",
        category: ts.DiagnosticCategory.Warning,
        message: "resolve() paths must be written relative to _private. Remove the _private prefix.",
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
        message: "Do not build __flash query strings manually. Use redirect(path, { message }) instead.",
        start: context.start,
        end: context.end,
      });
    }
  }

  return diagnostics;
}

class ProjectLanguageService {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.projectIndex = new PocketPagesProjectIndex(appRoot);
    this.projectVersion = 0;
    this.staticFiles = new Map();
    this.virtualFiles = new Map();
    this.includePreludeStack = new Set();

    this.languageService = ts.createLanguageService(this.createHost(), ts.createDocumentRegistry());
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

  buildPrelude(filePath, analysisText = "") {
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

    const includeLocalsPrelude = isEjsFile(filePath) ? this.buildIncludeLocalsPrelude(filePath) : "";
    if (includeLocalsPrelude) {
      parts.push(includeLocalsPrelude);
    }

    // Force each extracted <script server> block into module scope so top-level
    // bindings from different EJS files do not collide in the shared TS project.
    parts.push("export {};");

    const resolveTypePrelude = this.buildResolveTypePrelude(filePath, analysisText);
    if (resolveTypePrelude) {
      parts.push(resolveTypePrelude);
    }

    return `${parts.join("\n\n")}\n\n`;
  }

  buildIncludeLocalsPrelude(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (!isEjsFile(normalizedFilePath)) {
      return "";
    }

    if (this.includePreludeStack.has(normalizedFilePath)) {
      return this.projectIndex.buildIncludeLocalsPrelude(normalizedFilePath);
    }

    this.includePreludeStack.add(normalizedFilePath);

    try {
      const callSites = this.projectIndex.getIncludeTargetCallSites(normalizedFilePath);
      if (!callSites.length) {
        return "";
      }

      const bindingsByName = new Map();

      for (const callSite of callSites) {
        const callerFilePath = normalizePath(callSite.callerFilePath);
        if (!fileExists(callerFilePath)) {
          continue;
        }

        const callerDocumentText = readFileText(callerFilePath);

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
          emptyMessage: "No include() references found for this partial.",
        };
      }

      if (isScriptFile(normalizedFilePath)) {
        return {
          kind: "private-module",
          targetFilePath: normalizedFilePath,
          command: "pocketpagesServerScript.allFileReferences",
          title: "PocketPages: All File References",
          emptyMessage: "No resolve() or require() references found for this private module.",
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
      emptyMessage: `No route references found for ${routeEntry.routePath}.`,
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
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : readFileText(codeFilePath);

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
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : readFileText(codeFilePath);

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

    const overrides = {
      [normalizePath(filePath)]: documentText,
    };

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

  collectResolvedModuleMemberUsageLocations(targetModuleFilePath, memberName, overrides = {}) {
    const normalizedTargetFilePath = normalizePath(targetModuleFilePath);
    const uniqueLocations = new Map();

    for (const entry of this.projectIndex.getPagesCodeFiles()) {
      const codeFilePath = normalizePath(entry.filePath);
      const documentText =
        Object.prototype.hasOwnProperty.call(overrides, codeFilePath) ? overrides[codeFilePath] : readFileText(codeFilePath);
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
    if (pathContext && (pathContext.kind === "resolve-path" || pathContext.kind === "include-path" || pathContext.kind === "route-path")) {
      const candidates =
        pathContext.kind === "resolve-path"
          ? this.projectIndex.getResolveCandidates(filePath)
          : pathContext.kind === "include-path"
            ? this.projectIndex.getIncludeCandidates(filePath)
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
          documentation: field.type ? `PocketBase field type: ${field.type}` : collectionName,
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

  getDiagnostics(filePath, documentText) {
    const blocks = extractServerBlocks(documentText);
    const templateBlocks = extractTemplateCodeBlocks(documentText);
    const collectionMethodNames = this.projectIndex.getCollectionMethodNames();
    const diagnostics = [];
    const privatePagesFile = isPrivatePagesFile(filePath);

    if (privatePagesFile) {
      const resolveCallSpans = isScriptFile(filePath)
        ? collectResolveCallSpansFromScript(documentText)
        : collectResolveCallSpansFromTemplate(documentText);

      for (const span of resolveCallSpans) {
        diagnostics.push({
          code: "pp-private-resolve",
          category: ts.DiagnosticCategory.Warning,
          message: "Avoid resolve() inside _private files. Compose private dependencies in the entry and pass them in.",
          start: span.start,
          end: span.end,
        });
      }
    }

    for (const block of blocks) {
      const virtual = this.upsertVirtualFile(filePath, block);
      const relaxedBodyDiagnosticSpans = collectRelaxedBodyDiagnosticSpans(block.content);
      const rawDiagnostics = [...this.languageService.getSyntacticDiagnostics(virtual.fileName), ...this.languageService.getSemanticDiagnostics(virtual.fileName)];

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
          diagnostics.push({
            code: "pp-schema-collection",
            category: ts.DiagnosticCategory.Warning,
            message: `Unknown PocketBase collection "${context.value}" in ${context.methodName}().`,
            start: block.contentStart + context.start,
            end: block.contentStart + context.end,
          });
        }

        if (context.kind === "record-field") {
          const collectionName = this.projectIndex.inferCollectionName(
            context.receiverExpression,
            block.content,
            context.start
          );

          if (collectionName && !this.projectIndex.hasField(collectionName, context.value)) {
            diagnostics.push({
              code: "pp-schema-field",
              category: ts.DiagnosticCategory.Warning,
              message: `Unknown field "${context.value}" for collection "${collectionName}".`,
              start: block.contentStart + context.start,
              end: block.contentStart + context.end,
            });
          }
        }
      }
    }

    if (templateBlocks.length) {
      const templateVirtual = this.upsertTemplateVirtualFile(filePath, documentText);
      const templateVirtualText = buildTemplateVirtualText(documentText);
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
          diagnostics.push({
            code: "pp-schema-collection",
            category: ts.DiagnosticCategory.Warning,
            message: `Unknown PocketBase collection "${context.value}" in ${context.methodName}().`,
            start: context.start,
            end: context.end,
          });
        }

        if (context.kind === "record-field") {
          const collectionName = this.projectIndex.inferCollectionName(
            context.receiverExpression,
            templateVirtualText,
            context.start
          );

          if (collectionName && !this.projectIndex.hasField(collectionName, context.value)) {
            diagnostics.push({
              code: "pp-schema-field",
              category: ts.DiagnosticCategory.Warning,
              message: `Unknown field "${context.value}" for collection "${collectionName}".`,
              start: context.start,
              end: context.end,
            });
          }
        }
      }
    }

    for (const diagnostic of collectAgentsRuleDiagnostics(this.projectIndex, filePath, documentText)) {
      diagnostics.push(diagnostic);
    }

    const uniqueDiagnostics = new Map();
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.code}:${diagnostic.category}:${diagnostic.start}:${diagnostic.end}:${diagnostic.message}`;
      if (!uniqueDiagnostics.has(key)) {
        uniqueDiagnostics.set(key, diagnostic);
      }
    }

    return [...uniqueDiagnostics.values()];
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
          edits: fix.edits.map((edit) => ({
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

      if (pathContext.kind === "route-path") {
        return this.projectIndex.resolveRouteTarget(filePath, pathContext.value, {
          routeSource: pathContext.routeSource,
        });
      }
    }

    const resolvedModuleMemberContext = this.getResolvedModuleMemberContextForRename(filePath, documentText, offset);
    if (resolvedModuleMemberContext) {
      return this.projectIndex.resolveResolvedModuleMemberTarget(
        filePath,
        resolvedModuleMemberContext.modulePath,
        resolvedModuleMemberContext.memberName
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
      resolvedModuleMemberContext.memberName
    );
    if (!moduleDefinitionInfo) {
      return null;
    }

    const moduleRename = this.getModuleRenameLocations(moduleDefinitionInfo);
    if (!moduleRename.canRename) {
      return {
        canRename: false,
        localizedErrorMessage: moduleRename.localizedErrorMessage || "Unable to rename resolved module member.",
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
        localizedErrorMessage: renameInfo.localizedErrorMessage || "Unable to rename resolved module member.",
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

    const moduleRename = this.getModuleRenameLocations(renameInfo.moduleDefinitionInfo, {
      [normalizePath(filePath)]: isScriptFile(filePath) ? documentText : undefined,
    });
    if (!moduleRename.canRename) {
      return {
        canRename: false,
        localizedErrorMessage: moduleRename.localizedErrorMessage || "Unable to rename resolved module member.",
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
      { [normalizePath(filePath)]: documentText }
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
    const pathReferenceContext =
      this.getPathReferenceContext(filePath, documentText, offset) || this.getPrivateIncludeReferenceContext(filePath);
    if (pathReferenceContext) {
      return this.collectPathReferenceLocations(pathReferenceContext.kind, pathReferenceContext.targetFilePath, {
        [normalizePath(filePath)]: documentText,
      });
    }

    const renameInfo = this.getRenameInfo(filePath, documentText, offset);
    if (!renameInfo) {
      return null;
    }

    const moduleRename = this.getModuleRenameLocations(renameInfo.moduleDefinitionInfo, {
      [normalizePath(filePath)]: isScriptFile(filePath) ? documentText : undefined,
    });
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
      { [normalizePath(filePath)]: documentText }
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
}

module.exports = {
  PocketPagesLanguageServiceManager,
  findAppRoot,
  ts,
};
