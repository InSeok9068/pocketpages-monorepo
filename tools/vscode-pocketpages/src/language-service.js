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

    // Force each extracted <script server> block into module scope so top-level
    // bindings from different EJS files do not collide in the shared TS project.
    parts.push("export {};");

    const resolveTypePrelude = this.buildResolveTypePrelude(filePath, analysisText);
    if (resolveTypePrelude) {
      parts.push(resolveTypePrelude);
    }

    return `${parts.join("\n\n")}\n\n`;
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

  mapVirtualOffsetToDocumentOffset(virtualFileName, offset) {
    const state = this.virtualFiles.get(virtualFileName);
    if (!state) {
      return null;
    }

    if (offset < state.preludeLength) {
      return null;
    }

    const relativeOffset = offset - state.preludeLength;
    if (state.kind === "template-document") {
      if (relativeOffset < 0 || relativeOffset > state.documentLength) {
        return null;
      }

      return relativeOffset;
    }

    return state.block.contentStart + relativeOffset;
  }

  getVirtualStateAtOffset(filePath, documentText, offset) {
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

    const block = getServerBlockAtOffset(documentText, offset);
    const templateCodeBlock = getTemplateCodeBlockAtOffset(documentText, offset);
    if (!block && !templateCodeBlock) {
      return null;
    }

    const analysisText = block ? block.content : buildTemplateVirtualText(documentText);
    const analysisOffset = block ? offset - block.contentStart : offset;
    const analysisStart = block ? block.contentStart : 0;
    const collectionContext = getScriptCollectionContext(analysisText, analysisOffset);
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

    if (templateBlocks.length && !isPrivatePagesFile(filePath)) {
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

      for (const context of collectSchemaContexts(templateVirtualText)) {
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

    const uniqueDiagnostics = new Map();
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.code}:${diagnostic.category}:${diagnostic.start}:${diagnostic.end}:${diagnostic.message}`;
      if (!uniqueDiagnostics.has(key)) {
        uniqueDiagnostics.set(key, diagnostic);
      }
    }

    return [...uniqueDiagnostics.values()];
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

    return null;
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
    const pathReferenceContext = this.getPathReferenceContext(filePath, documentText, offset);
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
