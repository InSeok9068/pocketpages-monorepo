#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const {
  PocketPagesLanguageServiceManager,
  ts,
} = require('../tools/vscode-pocketpages/packages/language-service/language-service');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const DIAGNOSTIC_EXTENSIONS = new Set(['.ejs', '.js', '.cjs', '.mjs']);
const ISSUE_CATEGORY_ORDER = new Map([
  [ts.DiagnosticCategory.Error, 0],
  [ts.DiagnosticCategory.Warning, 1],
  [ts.DiagnosticCategory.Suggestion, 2],
  [ts.DiagnosticCategory.Message, 3],
]);

function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`;
  }

  return value;
}

function toDisplayPath(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');

  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(resolved)) {
    return `/${resolved[0].toLowerCase()}${resolved.slice(2)}`;
  }

  return resolved;
}

function getDiagIpcPath() {
  const hash = crypto.createHash('sha1').update(ROOT_DIR).digest('hex').slice(0, 12);

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pocketpages-diag-${hash}`;
  }

  return path.join(os.tmpdir(), `pocketpages-diag-${hash}.sock`);
}

function resolveTarget(rawArg) {
  if (!rawArg) {
    return {
      mode: 'service',
      serviceDirs: collectServiceDirs(''),
    };
  }

  const resolved = path.resolve(fromMsysPath(rawArg));
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return {
      mode: 'file',
      filePath: resolved,
    };
  }

  return {
    mode: 'service',
    serviceDirs: collectServiceDirs(rawArg),
  };
}

function collectServiceDirs(serviceArg) {
  if (serviceArg) {
    const resolved = path.resolve(fromMsysPath(serviceArg));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Unknown service path: ${serviceArg}`);
    }

    return [resolved];
  }

  if (!fs.existsSync(APPS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(APPS_DIR, entry.name))
    .filter((serviceDir) => fs.existsSync(path.join(serviceDir, 'pb_hooks', 'pages')))
    .sort((left, right) => left.localeCompare(right));
}

function collectPagesCodeFiles(serviceDir) {
  const pagesRoot = path.join(serviceDir, 'pb_hooks', 'pages');
  if (!fs.existsSync(pagesRoot)) {
    return [];
  }

  const results = [];
  const queue = [pagesRoot];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'assets') {
          continue;
        }

        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!DIAGNOSTIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      results.push(path.resolve(absolutePath));
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function collectManagedWatchedFiles(serviceDir) {
  const ambientFiles = [
    path.join(serviceDir, 'pb_schema.json'),
    path.join(serviceDir, 'pb_data', 'types.d.ts'),
    path.join(serviceDir, 'pocketpages-globals.d.ts'),
    path.join(serviceDir, 'types.d.ts'),
  ]
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
    .map((filePath) => path.resolve(filePath));

  return [...collectPagesCodeFiles(serviceDir), ...ambientFiles].sort((left, right) => left.localeCompare(right));
}

function readFileToken(filePath) {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return 'missing';
  }

  const stats = fs.statSync(resolved);
  return `${stats.mtimeMs}:${stats.size}`;
}

function buildLineStarts(text) {
  const starts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
}

function getLineAndColumn(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle];
    const nextLineStart = middle + 1 < lineStarts.length ? lineStarts[middle + 1] : Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
      continue;
    }

    if (offset >= nextLineStart) {
      low = middle + 1;
      continue;
    }

    return {
      line: middle + 1,
      column: offset - lineStart + 1,
    };
  }

  return {
    line: 1,
    column: 1,
  };
}

function toSeverityLabel(category) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 'ERROR';
    case ts.DiagnosticCategory.Warning:
      return 'WARN';
    case ts.DiagnosticCategory.Suggestion:
      return 'HINT';
    case ts.DiagnosticCategory.Message:
    default:
      return 'INFO';
  }
}

function isBlockingCategory(category) {
  return category === ts.DiagnosticCategory.Error || category === ts.DiagnosticCategory.Warning;
}

function formatProfileBreakdown(profile) {
  const orderedKeys = [
    'createDocumentAnalysisMs',
    'collectClientScriptSyntacticDiagnosticsMs',
    'collectPrivateResolveDiagnosticsMs',
    'collectServerBlockDiagnosticsMs',
    'collectTemplateDiagnosticsMs',
    'collectScriptSchemaDiagnosticsMs',
    'collectProjectRuleDiagnosticsMs',
    'dedupeDiagnosticsMs',
  ];

  return orderedKeys
    .filter((key) => Number(profile[key]) > 0)
    .map((key) => `${key.replace(/Ms$/, '')}=${Number(profile[key]).toFixed(1)}ms`)
    .join(', ');
}

function runFileDiagnostics(filePath, manager, options = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (!DIAGNOSTIC_EXTENSIONS.has(extension)) {
    throw new Error(`PocketPages VSCode diagnostics currently support only ${Array.from(DIAGNOSTIC_EXTENSIONS).join(', ')} files: ${filePath}`);
  }

  const service = manager.getServiceForFile(filePath);
  if (!service) {
    throw new Error(`PocketPages app root not found for file: ${filePath}`);
  }

  const startedAt = performance.now();
  const text = fs.readFileSync(filePath, 'utf8');
  const lineStarts = buildLineStarts(text);
  const profile = options.profile ? {} : null;
  const diagnostics = service.getDiagnostics(filePath, text, profile ? { profile } : {});
  const issues = diagnostics.map((diagnostic) => {
    const position = getLineAndColumn(lineStarts, typeof diagnostic.start === 'number' ? diagnostic.start : 0);
    return {
      filePath,
      line: position.line,
      column: position.column,
      code: diagnostic.code,
      category: diagnostic.category,
      message: String(diagnostic.message || ''),
    };
  });

  issues.sort((left, right) => {
    const leftRank = ISSUE_CATEGORY_ORDER.has(left.category) ? ISSUE_CATEGORY_ORDER.get(left.category) : 99;
    const rightRank = ISSUE_CATEGORY_ORDER.has(right.category) ? ISSUE_CATEGORY_ORDER.get(right.category) : 99;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    if (left.line !== right.line) {
      return left.line - right.line;
    }

    if (left.column !== right.column) {
      return left.column - right.column;
    }

    return String(left.code).localeCompare(String(right.code));
  });

  return {
    filePath,
    totalMs: performance.now() - startedAt,
    issues,
    profile,
  };
}

function runServiceDiagnostics(serviceDir, manager, options = {}) {
  const serviceName = path.basename(serviceDir);
  const filePaths = collectPagesCodeFiles(serviceDir);
  const startedAt = performance.now();
  const issues = [];
  const fileProfiles = [];

  for (const filePath of filePaths) {
    const service = manager.getServiceForFile(filePath);
    if (!service) {
      continue;
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const lineStarts = buildLineStarts(text);
    const profile = options.profile ? {} : null;
    const diagnostics = service.getDiagnostics(filePath, text, profile ? { profile } : {});

    if (profile) {
      fileProfiles.push({
        filePath,
        getDiagnosticsMs: Number(profile.getDiagnosticsMs) || 0,
        breakdown: formatProfileBreakdown(profile),
      });
    }

    for (const diagnostic of diagnostics) {
      const position = getLineAndColumn(lineStarts, typeof diagnostic.start === 'number' ? diagnostic.start : 0);
      issues.push({
        filePath,
        line: position.line,
        column: position.column,
        code: diagnostic.code,
        category: diagnostic.category,
        message: String(diagnostic.message || ''),
      });
    }
  }

  issues.sort((left, right) => {
    const leftRank = ISSUE_CATEGORY_ORDER.has(left.category) ? ISSUE_CATEGORY_ORDER.get(left.category) : 99;
    const rightRank = ISSUE_CATEGORY_ORDER.has(right.category) ? ISSUE_CATEGORY_ORDER.get(right.category) : 99;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }

    if (left.line !== right.line) {
      return left.line - right.line;
    }

    if (left.column !== right.column) {
      return left.column - right.column;
    }

    return String(left.code).localeCompare(String(right.code));
  });

  fileProfiles.sort((left, right) => right.getDiagnosticsMs - left.getDiagnosticsMs);

  return {
    serviceName,
    fileCount: filePaths.length,
    totalMs: performance.now() - startedAt,
    issues,
    fileProfiles,
  };
}

function appendProfileLines(lines, profiles, totalMs) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return;
  }

  lines.push(`Profile: total ${(totalMs / 1000).toFixed(2)}s`);
  for (const entry of profiles.slice(0, 5)) {
    const displayPath = toDisplayPath(entry.filePath);
    const breakdown = entry.breakdown ? ` (${entry.breakdown})` : '';
    lines.push(`  slow: ${displayPath} ${entry.getDiagnosticsMs.toFixed(1)}ms${breakdown}`);
  }
}

function printServiceResult(lines, result, options = {}) {
  lines.push(`Checking service: ${result.serviceName} (${result.fileCount} files)`);

  if (result.issues.length === 0) {
    lines.push(`PocketPages editor diagnostics passed in ${(result.totalMs / 1000).toFixed(2)}s.`);
    if (options.profile) {
      appendProfileLines(lines, result.fileProfiles, result.totalMs);
    }
    return {
      blockingIssueCount: 0,
      advisoryIssueCount: 0,
    };
  }

  const blockingIssues = result.issues.filter((issue) => isBlockingCategory(issue.category));

  if (blockingIssues.length > 0) {
    lines.push(`[FAIL][${result.serviceName}] PocketPages editor diagnostics`);
  } else {
    lines.push(`[WARN][${result.serviceName}] PocketPages editor diagnostics advisory issues`);
  }

  for (const issue of result.issues) {
    const displayPath = toDisplayPath(issue.filePath);
    lines.push(`  ${displayPath}:${issue.line}:${issue.column} [${toSeverityLabel(issue.category)}][${String(issue.code)}] ${issue.message}`);
  }

  lines.push(
    `${blockingIssues.length > 0 ? 'Found' : 'Found advisory'} ${result.issues.length} issue(s) in ${(result.totalMs / 1000).toFixed(2)}s.`
  );

  if (options.profile) {
    appendProfileLines(lines, result.fileProfiles, result.totalMs);
  }

  return {
    blockingIssueCount: blockingIssues.length,
    advisoryIssueCount: blockingIssues.length > 0 ? 0 : result.issues.length,
  };
}

function printFileResult(lines, result, options = {}) {
  lines.push(`Checking file: ${toDisplayPath(result.filePath)}`);

  if (result.issues.length === 0) {
    lines.push(`PocketPages editor diagnostics passed in ${(result.totalMs / 1000).toFixed(2)}s.`);
    if (options.profile && result.profile) {
      lines.push(`Profile: ${formatProfileBreakdown(result.profile)}`);
    }
    return {
      blockingIssueCount: 0,
      advisoryIssueCount: 0,
    };
  }

  const blockingIssues = result.issues.filter((issue) => isBlockingCategory(issue.category));

  if (blockingIssues.length > 0) {
    lines.push('[FAIL] PocketPages editor diagnostics');
  } else {
    lines.push('[WARN] PocketPages editor diagnostics advisory issues');
  }

  for (const issue of result.issues) {
    const displayPath = toDisplayPath(issue.filePath);
    lines.push(`  ${displayPath}:${issue.line}:${issue.column} [${toSeverityLabel(issue.category)}][${String(issue.code)}] ${issue.message}`);
  }

  lines.push(
    `${blockingIssues.length > 0 ? 'Found' : 'Found advisory'} ${result.issues.length} issue(s) in ${(result.totalMs / 1000).toFixed(2)}s.`
  );

  if (options.profile && result.profile) {
    lines.push(`Profile: ${formatProfileBreakdown(result.profile)}`);
  }

  return {
    blockingIssueCount: blockingIssues.length,
    advisoryIssueCount: blockingIssues.length > 0 ? 0 : result.issues.length,
  };
}

function runDiagnostics(rawArg, options = {}) {
  const manager = options.manager || new PocketPagesLanguageServiceManager();
  const profile = !!options.profile;
  const lines = ['Running PocketPages editor diagnostics...'];
  let blockingIssueCount = 0;
  let advisoryIssueCount = 0;

  const target = resolveTarget(rawArg);

  if (target.mode === 'file') {
    const result = runFileDiagnostics(target.filePath, manager, { profile });
    const counts = printFileResult(lines, result, { profile });
    blockingIssueCount += counts.blockingIssueCount;
    advisoryIssueCount += counts.advisoryIssueCount;
  } else {
    if (target.serviceDirs.length === 0) {
      lines.push('No services found.');
      return {
        output: lines.join('\n'),
        exitCode: 0,
        blockingIssueCount: 0,
        advisoryIssueCount: 0,
        serviceDirs: [],
      };
    }

    for (const serviceDir of target.serviceDirs) {
      const result = runServiceDiagnostics(serviceDir, manager, { profile });
      const counts = printServiceResult(lines, result, { profile });
      blockingIssueCount += counts.blockingIssueCount;
      advisoryIssueCount += counts.advisoryIssueCount;
    }
  }

  if (blockingIssueCount > 0) {
    lines.push('');
    lines.push(`PocketPages editor diagnostics failed with ${blockingIssueCount} blocking issue(s).`);
  } else if (advisoryIssueCount > 0) {
    lines.push('');
    lines.push(`PocketPages editor diagnostics passed with ${advisoryIssueCount} advisory issue(s).`);
  } else {
    lines.push('PocketPages editor diagnostics passed.');
  }

  return {
    output: lines.join('\n'),
    exitCode: blockingIssueCount > 0 ? 1 : 0,
    blockingIssueCount,
    advisoryIssueCount,
    serviceDirs: target.mode === 'service' ? target.serviceDirs : [],
  };
}

module.exports = {
  ROOT_DIR,
  collectManagedWatchedFiles,
  collectPagesCodeFiles,
  getDiagIpcPath,
  readFileToken,
  resolveTarget,
  runDiagnostics,
};
