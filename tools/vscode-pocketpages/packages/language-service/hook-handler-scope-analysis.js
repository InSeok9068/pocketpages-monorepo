"use strict";

const ts = require("typescript");

const HANDLER_REGISTRATION_SIGNAL_RE = /\b(?:on[A-Z][A-Za-z0-9_]*|routerAdd|routerUse|cronAdd)\b/;

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

function collectBindingIdentifiers(nameNode, identifiers = []) {
  if (!nameNode) {
    return identifiers;
  }

  if (ts.isIdentifier(nameNode)) {
    identifiers.push(nameNode);
    return identifiers;
  }

  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (element && ts.isBindingElement(element)) {
        collectBindingIdentifiers(element.name, identifiers);
      }
    }
  }

  return identifiers;
}

function createScope(parent, kind, node) {
  return {
    parent,
    kind,
    node,
    bindings: new Map(),
  };
}

function getNearestFunctionScope(scope) {
  let current = scope;
  while (current && current.kind !== "function" && current.kind !== "source") {
    current = current.parent;
  }
  return current || scope;
}

function declareBinding(scope, identifier, declaration = identifier) {
  if (!scope || !identifier || !ts.isIdentifier(identifier)) {
    return;
  }

  scope.bindings.set(identifier.text, {
    declaration,
    identifier,
  });
}

function declareBindingPattern(scope, nameNode, declaration = nameNode) {
  for (const identifier of collectBindingIdentifiers(nameNode)) {
    declareBinding(scope, identifier, declaration);
  }
}

function resolveBinding(scope, name) {
  let current = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return current.bindings.get(name);
    }
    current = current.parent;
  }
  return null;
}

function isLexicalScopeNode(node) {
  return (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isSwitchStatement(node)
  );
}

function buildLexicalScopeModel(sourceFile) {
  const rootScope = createScope(null, "source", sourceFile);
  const nodeScopes = new WeakMap();
  nodeScopes.set(sourceFile, rootScope);

  const visit = (node, parentScope) => {
    let scope = parentScope;

    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        declareBinding(parentScope, node.name, node);
      }

      scope = createScope(parentScope, "function", node);
      nodeScopes.set(node, scope);

      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
        declareBinding(scope, node.name, node);
      }

      for (const parameter of node.parameters || []) {
        declareBindingPattern(scope, parameter.name, parameter);
        nodeScopes.set(parameter, scope);
        ts.forEachChild(parameter, (child) => visit(child, scope));
      }

      if (node.body) {
        visit(node.body, scope);
      }
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (ts.isClassDeclaration(node) && node.name) {
        declareBinding(parentScope, node.name, node);
      }

      scope = createScope(parentScope, "class", node);
      nodeScopes.set(node, scope);
      if (node.name) {
        declareBinding(scope, node.name, node);
      }
      ts.forEachChild(node, (child) => visit(child, scope));
      return;
    }

    if (node !== sourceFile && isLexicalScopeNode(node)) {
      scope = createScope(parentScope, "block", node);
    }
    nodeScopes.set(node, scope);

    if (ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent)) {
      const targetScope = (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
        ? getNearestFunctionScope(scope)
        : scope;
      declareBindingPattern(targetScope, node.name, node);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      declareBindingPattern(scope, node.variableDeclaration.name, node.variableDeclaration);
    } else if (ts.isImportClause(node) && node.name) {
      declareBinding(scope, node.name, node);
    } else if (ts.isImportSpecifier(node)) {
      declareBinding(scope, node.name, node);
    } else if (ts.isNamespaceImport(node)) {
      declareBinding(scope, node.name, node);
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  };

  ts.forEachChild(sourceFile, (child) => visit(child, rootScope));

  return {
    nodeScopes,
    resolveBinding(node, name) {
      return resolveBinding(nodeScopes.get(node) || rootScope, name);
    },
  };
}

function getRegistrationHandlerIndexes(callExpression, scopeModel) {
  const target = skipExpressionWrappers(callExpression.expression);
  if (!target || !ts.isIdentifier(target)) {
    return [];
  }

  if (scopeModel.resolveBinding(target, target.text)) {
    return [];
  }

  if (/^on[A-Z][A-Za-z0-9_]*$/.test(target.text)) {
    return [0];
  }

  if (target.text === "routerAdd") {
    return callExpression.arguments.map((_argument, index) => index).filter((index) => index >= 2);
  }

  if (target.text === "cronAdd") {
    return [2];
  }

  if (target.text === "routerUse") {
    return callExpression.arguments.map((_argument, index) => index);
  }

  return [];
}

function resolveHandlerFunction(node, scopeModel, seenDeclarations = new Set()) {
  const target = skipExpressionWrappers(node);
  if (!target) {
    return null;
  }

  if (ts.isFunctionExpression(target) || ts.isArrowFunction(target) || ts.isFunctionDeclaration(target)) {
    return target;
  }

  if (
    ts.isNewExpression(target) &&
    ts.isIdentifier(skipExpressionWrappers(target.expression)) &&
    skipExpressionWrappers(target.expression).text === "Middleware" &&
    !scopeModel.resolveBinding(target.expression, "Middleware") &&
    target.arguments &&
    target.arguments.length
  ) {
    return resolveHandlerFunction(target.arguments[0], scopeModel, seenDeclarations);
  }

  if (!ts.isIdentifier(target)) {
    return null;
  }

  const binding = scopeModel.resolveBinding(target, target.text);
  const declaration = binding && binding.declaration;
  if (!declaration || seenDeclarations.has(declaration)) {
    return null;
  }
  seenDeclarations.add(declaration);

  if (ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }

  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return resolveHandlerFunction(declaration.initializer, scopeModel, seenDeclarations);
  }

  return null;
}

function isNodeInside(node, container) {
  let current = node;
  while (current) {
    if (current === container) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isIdentifierReference(node) {
  if (!node || !ts.isIdentifier(node) || !node.parent) {
    return false;
  }

  if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
    return true;
  }

  if (ts.isDeclarationName(node)) {
    return false;
  }

  if (ts.isPartOfTypeNode && ts.isPartOfTypeNode(node)) {
    return false;
  }

  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) && parent.propertyName === node)
  ) {
    return false;
  }

  return true;
}

function collectRegisteredHandlerFunctions(sourceFile, scopeModel) {
  const handlers = [];
  const seenHandlers = new Set();

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      for (const argumentIndex of getRegistrationHandlerIndexes(node, scopeModel)) {
        const handler = resolveHandlerFunction(node.arguments[argumentIndex], scopeModel);
        if (!handler) {
          continue;
        }

        const key = `${handler.pos}:${handler.end}`;
        if (!seenHandlers.has(key)) {
          seenHandlers.add(key);
          handlers.push(handler);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return handlers;
}

/**
 * PocketBase가 별도 프로그램으로 실행하는 handler의 외부 선언 캡처를 찾습니다.
 * @param {string} scriptText hook script 본문
 * @param {{ sourceFile?: import("typescript").SourceFile }} options 분석 옵션
 * @returns {Array<object>} 진단 목록
 */
function collectHookHandlerCaptureDiagnostics(scriptText, options = {}) {
  const sourceText = String(scriptText || "");
  if (!HANDLER_REGISTRATION_SIGNAL_RE.test(sourceText)) {
    return [];
  }

  const sourceFile = options.sourceFile || ts.createSourceFile(
    "pocketpages-hook-handler-scope.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const scopeModel = buildLexicalScopeModel(sourceFile);
  const diagnostics = [];

  for (const handler of collectRegisteredHandlerFunctions(sourceFile, scopeModel)) {
    const reportedNames = new Set();

    const visit = (node) => {
      if (isIdentifierReference(node) && !reportedNames.has(node.text)) {
        const binding = scopeModel.resolveBinding(node, node.text);
        if (binding && !isNodeInside(binding.identifier, handler)) {
          reportedNames.add(node.text);
          diagnostics.push({
            code: "pp-jsvm-handler-capture",
            category: ts.DiagnosticCategory.Error,
            message:
              `PocketBase runs this handler in an isolated scope, so outer declaration "${node.text}" is unavailable. ` +
              "Declare it inside the handler or load a module with require() inside the handler.",
            start: node.getStart(sourceFile),
            end: node.getEnd(),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(handler);
  }

  return diagnostics.sort((left, right) => left.start - right.start || left.end - right.end);
}

module.exports = {
  collectHookHandlerCaptureDiagnostics,
};
