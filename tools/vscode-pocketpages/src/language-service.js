"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { extractServerBlocks, getServerBlockAtOffset } = require("./script-server");
const { PocketPagesProjectIndex } = require("./project-index");
const {
  collectPathContexts,
  collectSchemaContexts,
  getPathContextAtOffset,
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

class ProjectLanguageService {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.projectIndex = new PocketPagesProjectIndex(appRoot);
    this.projectVersion = 0;
    this.staticFiles = new Map();
    this.virtualFiles = new Map();

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

  refreshStaticFiles() {
    this.ensureStaticFile(path.join(this.appRoot, "pb_data", "types.d.ts"));
    this.ensureStaticFile(path.join(this.appRoot, "pocketpages-globals.d.ts"));
  }

  buildPrelude(filePath) {
    const references = [path.join(this.appRoot, "pb_data", "types.d.ts"), path.join(this.appRoot, "pocketpages-globals.d.ts")]
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

    // Force each extracted <script server> block into module scope so top-level
    // bindings from different EJS files do not collide in the shared TS project.
    parts.push("export {};");

    return `${parts.join("\n\n")}\n\n`;
  }

  upsertVirtualFile(filePath, block) {
    this.refreshStaticFiles();

    const resolvedPath = normalizePath(filePath);
    const relativePath = path.relative(this.appRoot, resolvedPath);
    const virtualDir = path.join(CACHE_ROOT, sanitizeFileName(this.appRoot));
    const virtualFileName = normalizePath(path.join(virtualDir, `${sanitizeFileName(relativePath)}__block_${block.index}.ts`));

    const prelude = this.buildPrelude(resolvedPath);
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

  mapVirtualOffsetToDocumentOffset(virtualFileName, offset) {
    const state = this.virtualFiles.get(virtualFileName);
    if (!state) {
      return null;
    }

    if (offset < state.preludeLength) {
      return null;
    }

    const relativeOffset = offset - state.preludeLength;
    return state.block.contentStart + relativeOffset;
  }

  getCompletionData(filePath, documentText, offset) {
    const block = getServerBlockAtOffset(documentText, offset);
    if (!block) {
      return null;
    }

    const virtual = this.upsertVirtualFile(filePath, block);
    const virtualOffset = virtual.preludeLength + (offset - block.contentStart);
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
    const pathContext = getPathContextAtOffset(documentText, offset);
    if (pathContext && (pathContext.kind === "resolve-path" || pathContext.kind === "include-path")) {
      const candidates =
        pathContext.kind === "resolve-path"
          ? this.projectIndex.getResolveCandidates(filePath)
          : this.projectIndex.getIncludeCandidates(filePath);

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

    const block = getServerBlockAtOffset(documentText, offset);
    if (!block) {
      return null;
    }

    const localOffset = offset - block.contentStart;
    const collectionContext = getScriptCollectionContext(block.content, localOffset);
    if (collectionContext) {
      return {
        start: block.contentStart + collectionContext.start,
        end: block.contentStart + collectionContext.end,
        items: this.projectIndex.getCollectionNames().map((collectionName) => ({
          label: collectionName,
          insertText: collectionName,
          detail: "PocketBase collection",
          documentation: `Collection from ${this.projectIndex.getSchemaState().schemaPath}`,
          category: "collection-name",
        })),
      };
    }

    const fieldContext = getScriptFieldContext(block.content, localOffset);
    if (fieldContext) {
      const collectionName = this.projectIndex.inferCollectionName(
        fieldContext.receiverExpression,
        block.content,
        fieldContext.start
      );

      if (!collectionName) {
        return null;
      }

      return {
        start: block.contentStart + fieldContext.start,
        end: block.contentStart + fieldContext.end,
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
    const block = getServerBlockAtOffset(documentText, offset);
    if (!block) {
      return null;
    }

    const virtual = this.upsertVirtualFile(filePath, block);
    const virtualOffset = virtual.preludeLength + (offset - block.contentStart);
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

  getDiagnostics(filePath, documentText) {
    const blocks = extractServerBlocks(documentText);
    if (!blocks.length) {
      return [];
    }

    const diagnostics = [];

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

      for (const context of collectSchemaContexts(block.content)) {
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

    return diagnostics;
  }

  getDefinitionTarget(filePath, documentText, offset) {
    const pathContext = getPathContextAtOffset(documentText, offset);
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
