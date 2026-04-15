"use strict";

const ts = require("typescript");

const PARAMS_BINDING = { kind: "params" };
const BLOCKED_BINDING = { kind: "blocked" };

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

function readPropertyName(node) {
  const target = skipExpressionWrappers(node);
  if (!target) {
    return null;
  }

  if (ts.isIdentifier(target) || ts.isStringLiteralLike(target) || ts.isNumericLiteral(target)) {
    return String(target.text);
  }

  return null;
}

function collectBoundIdentifierNames(nameNode, names) {
  if (!nameNode) {
    return;
  }

  if (ts.isIdentifier(nameNode)) {
    names.push(nameNode.text);
    return;
  }

  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      collectBoundIdentifierNames(element.name, names);
    }
  }
}

function blockBindingNames(bindings, nameNode) {
  const names = [];
  collectBoundIdentifierNames(nameNode, names);

  for (const name of names) {
    bindings.set(name, BLOCKED_BINDING);
  }
}

function readParamsSource(node, bindings) {
  const target = skipExpressionWrappers(node);
  if (!target || !ts.isIdentifier(target)) {
    return null;
  }

  if (target.text === "params") {
    return bindings.get("params") === BLOCKED_BINDING ? null : PARAMS_BINDING;
  }

  const binding = bindings.get(target.text);
  return binding && binding !== BLOCKED_BINDING ? binding : null;
}

function getDirectParamsFixRange(node, bindings, sourceFile) {
  const target = skipExpressionWrappers(node);
  if (
    !target ||
    !ts.isIdentifier(target) ||
    target.text !== "params" ||
    bindings.get("params") === BLOCKED_BINDING
  ) {
    return null;
  }

  return {
    start: target.getStart(sourceFile),
    end: target.getEnd(),
  };
}

function shouldWarnForParamsProperty(propertyName, allowedNames) {
  return !!propertyName && propertyName !== "__flash" && !allowedNames.has(propertyName);
}

function createParamsQueryDiagnostic(start, end, fixRange) {
  const diagnostic = {
    code: "pp-query-via-params",
    category: ts.DiagnosticCategory.Warning,
    message: "Query strings should use request.url.query. params is for route params.",
    start,
    end,
  };

  if (fixRange) {
    diagnostic.fixes = [
      {
        title: "Replace with request.url.query",
        edits: [
          {
            start: fixRange.start,
            end: fixRange.end,
            newText: "request.url.query",
          },
        ],
      },
    ];
  }

  return diagnostic;
}

function collectParamsBindingPatternDiagnostics(bindingPattern, allowedNames, sourceFile, diagnostics, fixRange) {
  for (const element of bindingPattern.elements) {
    const propertyNode = element.propertyName || (ts.isIdentifier(element.name) ? element.name : null);
    const propertyName = readPropertyName(propertyNode);
    if (!shouldWarnForParamsProperty(propertyName, allowedNames)) {
      continue;
    }

    const targetNode = propertyNode || element.name;
    diagnostics.push(
      createParamsQueryDiagnostic(targetNode.getStart(sourceFile), targetNode.getEnd(), fixRange)
    );
  }
}

function collectParamsFlowDiagnostics(scriptText, allowedRouteParamNames, options = {}) {
  const sourceFile = options.sourceFile || ts.createSourceFile("pocketpages-agents-params-flow.ts", scriptText, ts.ScriptTarget.Latest, true);
  const diagnostics = [];
  const allowedNames = new Set(
    (Array.isArray(allowedRouteParamNames) ? allowedRouteParamNames : []).filter(Boolean)
  );

  function visit(node, bindings) {
    if (
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      const scopedBindings = new Map(bindings);
      ts.forEachChild(node, (child) => visit(child, scopedBindings));
      return;
    }

    if (ts.isCatchClause(node)) {
      const scopedBindings = new Map(bindings);
      if (node.variableDeclaration) {
        blockBindingNames(scopedBindings, node.variableDeclaration.name);
      }

      if (node.block) {
        visit(node.block, scopedBindings);
      }
      return;
    }

    if (ts.isFunctionLike(node)) {
      const scopedBindings = new Map(bindings);
      if (node.name && ts.isIdentifier(node.name)) {
        scopedBindings.set(node.name.text, BLOCKED_BINDING);
      }

      for (const parameter of node.parameters) {
        blockBindingNames(scopedBindings, parameter.name);
      }

      if (node.body) {
        visit(node.body, scopedBindings);
      }
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      blockBindingNames(bindings, node.name);

      if (node.initializer) {
        const paramsSource = readParamsSource(node.initializer, bindings);
        if (paramsSource && ts.isIdentifier(node.name)) {
          bindings.set(node.name.text, PARAMS_BINDING);
        } else if (paramsSource && ts.isObjectBindingPattern(node.name)) {
          const fixRange = getDirectParamsFixRange(node.initializer, bindings, sourceFile);
          collectParamsBindingPatternDiagnostics(node.name, allowedNames, sourceFile, diagnostics, fixRange);
        }
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const paramsSource = readParamsSource(node.right, bindings);
      if (paramsSource) {
        bindings.set(node.left.text, PARAMS_BINDING);
      } else if (bindings.has(node.left.text)) {
        bindings.set(node.left.text, BLOCKED_BINDING);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    ) {
      const chain = getPropertyAccessChain(node);
      if (readParamsSource(chain.root, bindings)) {
        const topPropertyName = chain.segments[0] || "";
        if (shouldWarnForParamsProperty(topPropertyName, allowedNames)) {
          diagnostics.push(
            createParamsQueryDiagnostic(
              node.getStart(sourceFile),
              node.getEnd(),
              getDirectParamsFixRange(chain.root, bindings, sourceFile)
            )
          );
        }
      }
    }

    if (ts.isElementAccessExpression(node) && readParamsSource(node.expression, bindings)) {
      const propertyName = readPropertyName(node.argumentExpression);
      if (shouldWarnForParamsProperty(propertyName, allowedNames)) {
        diagnostics.push(
          createParamsQueryDiagnostic(
            node.getStart(sourceFile),
            node.getEnd(),
            getDirectParamsFixRange(node.expression, bindings, sourceFile)
          )
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, bindings));
  }

  visit(sourceFile, new Map());
  return diagnostics;
}

module.exports = {
  collectParamsFlowDiagnostics,
};
