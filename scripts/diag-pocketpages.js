#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { PocketPagesLanguageServiceManager, ts } = require('../tools/vscode-pocketpages/src/language-service');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const DIAGNOSTIC_EXTENSIONS = new Set(['.ejs', '.js', '.cjs', '.mjs']);
const ISSUE_CATEGORY_ORDER = new Map([
  [ts.DiagnosticCategory.Error, 0],
  [ts.DiagnosticCategory.Warning, 1],
  [ts.DiagnosticCategory.Suggestion, 2],
  [ts.DiagnosticCategory.Message, 3],
]);

let blockingIssueCount = 0;
let advisoryIssueCount = 0;

/**
 * Git Bash 스타일 경로를 Windows 경로로 바꿉니다.
 * @param {string} value 서비스 경로 인자입니다.
 * @returns {string} 현재 런타임에서 읽을 수 있는 절대/상대 경로 문자열입니다.
 */
function fromMsysPath(value) {
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(value)) {
    return `${value[1]}:${value.slice(2)}`;
  }

  return value;
}

/**
 * 출력용 경로를 POSIX 스타일로 정리합니다.
 * @param {string} filePath 화면에 보여줄 파일 경로입니다.
 * @returns {string} 사람이 읽기 쉬운 경로 문자열입니다.
 */
function toDisplayPath(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');

  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(resolved)) {
    return `/${resolved[0].toLowerCase()}${resolved.slice(2)}`;
  }

  return resolved;
}

/**
 * 인자가 파일인지 서비스인지 판별합니다.
 * @param {string | undefined} rawArg 사용자가 넘긴 인자입니다.
 * @returns {{ mode: 'file', filePath: string } | { mode: 'service', serviceDirs: string[] }} 실행 모드 정보입니다.
 */
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

/**
 * 서비스 인자를 실제 서비스 디렉터리 목록으로 정리합니다.
 * @param {string | undefined} serviceArg 단일 서비스 경로 또는 이름입니다.
 * @returns {string[]} 검사할 서비스 디렉터리 목록입니다.
 */
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

/**
 * 서비스의 PocketPages 코드 파일을 순회합니다.
 * @param {string} serviceDir PocketPages 서비스 루트입니다.
 * @returns {string[]} 진단 대상 파일 목록입니다.
 */
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

/**
 * 파일 하나의 확장 진단을 계산합니다.
 * @param {string} filePath PocketPages 코드 파일 경로입니다.
 * @param {PocketPagesLanguageServiceManager} manager 확장 language service 매니저입니다.
 * @returns {{ filePath: string, totalMs: number, issues: Array<{ filePath: string, line: number, column: number, code: string | number, category: number, message: string }> }} 결과 요약입니다.
 */
function runFileDiagnostics(filePath, manager) {
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
  const diagnostics = service.getDiagnostics(filePath, text);
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
  };
}

/**
 * 텍스트에서 각 줄 시작 offset 배열을 만듭니다.
 * @param {string} text 파일 전체 텍스트입니다.
 * @returns {number[]} 줄 시작 offset 목록입니다.
 */
function buildLineStarts(text) {
  const starts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
}

/**
 * offset을 1-based line/column으로 바꿉니다.
 * @param {number[]} lineStarts 줄 시작 offset 목록입니다.
 * @param {number} offset 진단 시작 offset입니다.
 * @returns {{ line: number, column: number }} 1-based line/column입니다.
 */
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

/**
 * TypeScript 진단 카테고리를 짧은 레이블로 바꿉니다.
 * @param {number} category 진단 카테고리 값입니다.
 * @returns {string} 출력용 심각도 문자열입니다.
 */
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

/**
 * verify 실패를 유발하는 blocking 진단인지 판별합니다.
 * @param {number} category TypeScript 진단 카테고리입니다.
 * @returns {boolean} Error/Warning이면 true입니다.
 */
function isBlockingCategory(category) {
  return category === ts.DiagnosticCategory.Error || category === ts.DiagnosticCategory.Warning;
}

/**
 * 서비스 하나의 확장 진단을 계산합니다.
 * @param {string} serviceDir 서비스 루트입니다.
 * @param {PocketPagesLanguageServiceManager} manager 확장 language service 매니저입니다.
 * @returns {{ serviceName: string, fileCount: number, totalMs: number, issues: Array<{ filePath: string, line: number, column: number, code: string | number, category: number, message: string }> }} 결과 요약입니다.
 */
function runServiceDiagnostics(serviceDir, manager) {
  const serviceName = path.basename(serviceDir);
  const filePaths = collectPagesCodeFiles(serviceDir);
  const startedAt = performance.now();
  const issues = [];

  for (const filePath of filePaths) {
    const service = manager.getServiceForFile(filePath);
    if (!service) {
      continue;
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const lineStarts = buildLineStarts(text);
    const diagnostics = service.getDiagnostics(filePath, text);

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

  return {
    serviceName,
    fileCount: filePaths.length,
    totalMs: performance.now() - startedAt,
    issues,
  };
}

/**
 * 서비스 결과를 사람이 읽기 쉬운 텍스트로 출력합니다.
 * @param {{ serviceName: string, fileCount: number, totalMs: number, issues: Array<{ filePath: string, line: number, column: number, code: string | number, category: number, message: string }> }} result 서비스 진단 결과입니다.
 */
function printServiceResult(result) {
  console.log(`Checking service: ${result.serviceName} (${result.fileCount} files)`);

  if (result.issues.length === 0) {
    console.log(`PocketPages editor diagnostics passed in ${(result.totalMs / 1000).toFixed(2)}s.`);
    return;
  }

  const blockingIssues = result.issues.filter((issue) => isBlockingCategory(issue.category));

  if (blockingIssues.length > 0) {
    blockingIssueCount += blockingIssues.length;
    console.log(`[FAIL][${result.serviceName}] PocketPages editor diagnostics`);
  } else {
    advisoryIssueCount += result.issues.length;
    console.log(`[WARN][${result.serviceName}] PocketPages editor diagnostics advisory issues`);
  }

  for (const issue of result.issues) {
    const displayPath = toDisplayPath(issue.filePath);
    console.log(`  ${displayPath}:${issue.line}:${issue.column} [${toSeverityLabel(issue.category)}][${String(issue.code)}] ${issue.message}`);
  }

  console.log(
    `${blockingIssues.length > 0 ? "Found" : "Found advisory"} ${result.issues.length} issue(s) in ${(result.totalMs / 1000).toFixed(2)}s.`
  );
}

/**
 * 파일 진단 결과를 사람이 읽기 쉬운 텍스트로 출력합니다.
 * @param {{ filePath: string, totalMs: number, issues: Array<{ filePath: string, line: number, column: number, code: string | number, category: number, message: string }> }} result 파일 진단 결과입니다.
 */
function printFileResult(result) {
  console.log(`Checking file: ${toDisplayPath(result.filePath)}`);

  if (result.issues.length === 0) {
    console.log(`PocketPages editor diagnostics passed in ${(result.totalMs / 1000).toFixed(2)}s.`);
    return;
  }

  const blockingIssues = result.issues.filter((issue) => isBlockingCategory(issue.category));

  if (blockingIssues.length > 0) {
    blockingIssueCount += blockingIssues.length;
    console.log("[FAIL] PocketPages editor diagnostics");
  } else {
    advisoryIssueCount += result.issues.length;
    console.log("[WARN] PocketPages editor diagnostics advisory issues");
  }

  for (const issue of result.issues) {
    const displayPath = toDisplayPath(issue.filePath);
    console.log(`  ${displayPath}:${issue.line}:${issue.column} [${toSeverityLabel(issue.category)}][${String(issue.code)}] ${issue.message}`);
  }

  console.log(
    `${blockingIssues.length > 0 ? "Found" : "Found advisory"} ${result.issues.length} issue(s) in ${(result.totalMs / 1000).toFixed(2)}s.`
  );
}

function main() {
  console.log('Running PocketPages editor diagnostics...');

  let target = null;
  try {
    target = resolveTarget(process.argv[2]);
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }

  const manager = new PocketPagesLanguageServiceManager();

  if (target.mode === 'file') {
    try {
      const result = runFileDiagnostics(target.filePath, manager);
      printFileResult(result);
    } catch (error) {
      console.error(String(error.message || error));
      process.exit(1);
    }
  } else {
    if (target.serviceDirs.length === 0) {
      console.log('No services found.');
      process.exit(0);
    }

    for (const serviceDir of target.serviceDirs) {
      const result = runServiceDiagnostics(serviceDir, manager);
      printServiceResult(result);
    }
  }

  if (blockingIssueCount > 0) {
    console.log();
    console.log(`PocketPages editor diagnostics failed with ${blockingIssueCount} blocking issue(s).`);
    process.exit(1);
  }

  if (advisoryIssueCount > 0) {
    console.log();
    console.log(`PocketPages editor diagnostics passed with ${advisoryIssueCount} advisory issue(s).`);
    process.exit(0);
  }

  console.log('PocketPages editor diagnostics passed.');
}

main();
