#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const ROOT_PACKAGE_JSON = path.join(ROOT_DIR, 'package.json');
const SUPPORTED_NPM_COMMANDS = new Set(['up', 'install']);

/**
 * 현재 런타임에서 npm 실행 정보를 구합니다.
 * Windows에서는 npm.cmd 직접 실행이 EINVAL로 실패할 수 있어 npm-cli.js를 직접 호출합니다.
 * @returns {{ command: string, baseArgs: string[] }} spawnSync에 넘길 명령 정보입니다.
 */
function resolveNpmRunner() {
  if (process.platform === 'win32') {
    const npmCliPath = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    );

    if (!fs.existsSync(npmCliPath)) {
      throw new Error(`npm-cli.js not found: ${npmCliPath}`);
    }

    return {
      command: process.execPath,
      baseArgs: [npmCliPath],
    };
  }

  return {
    command: 'npm',
    baseArgs: [],
  };
}

/**
 * npm 작업 대상 앱 디렉터리를 찾습니다.
 * @returns {string[]} apps 아래 package.json이 있는 서비스 디렉터리 목록입니다.
 */
function collectAppDirs() {
  if (!fs.existsSync(APPS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(APPS_DIR, entry.name))
    .filter((appDir) => fs.existsSync(path.join(appDir, 'package.json')))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 루트와 앱을 포함한 전체 npm 작업 대상 디렉터리를 찾습니다.
 * @returns {string[]} 루트와 apps 아래 package.json이 있는 디렉터리 목록입니다.
 */
function collectPackageDirs() {
  const packageDirs = [];

  if (fs.existsSync(ROOT_PACKAGE_JSON)) {
    packageDirs.push(ROOT_DIR);
  }

  return packageDirs.concat(collectAppDirs());
}

/**
 * 화면 출력용 대상 이름을 만듭니다.
 * @param {string} targetDir npm 작업 대상 절대 경로입니다.
 * @returns {string} 루트면 root, 앱이면 디렉터리 이름입니다.
 */
function toTargetName(targetDir) {
  if (targetDir === ROOT_DIR) {
    return 'root';
  }

  return path.basename(targetDir);
}

/**
 * 실행할 npm 명령과 추가 인자를 나눕니다.
 * @param {string[]} args CLI 인자입니다.
 * @returns {{ npmCommand: string, extraArgs: string[] }} npm 명령과 전달 인자입니다.
 */
function parseArgs(args) {
  const extraArgs = args.slice();
  let npmCommand = 'up';

  if (extraArgs[0] === '--npm-command') {
    npmCommand = extraArgs[1] || '';
    extraArgs.splice(0, 2);
  } else if (extraArgs[0] && extraArgs[0].startsWith('--npm-command=')) {
    npmCommand = extraArgs[0].slice('--npm-command='.length);
    extraArgs.shift();
  }

  if (!SUPPORTED_NPM_COMMANDS.has(npmCommand)) {
    console.error(`Unknown npm command: ${npmCommand}`);
    console.error('Usage: node scripts/up-apps.js [--npm-command <up|install>] [npm args...]');
    process.exit(1);
  }

  return { npmCommand, extraArgs };
}

/**
 * 도움말을 출력합니다.
 */
function printHelp() {
  console.log('Usage: node scripts/up-apps.js [--npm-command <up|install>] [npm args...]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/up-apps.js');
  console.log('  node scripts/up-apps.js --save');
  console.log('  node scripts/up-apps.js --dry-run');
  console.log('  node scripts/up-apps.js --npm-command install');
  console.log('  node scripts/up-apps.js --npm-command install --package-lock-only');
}

/**
 * 한 대상 디렉터리에서 npm 명령을 실행합니다.
 * @param {string} targetDir npm 작업 대상 절대 경로입니다.
 * @param {string} npmCommand 실행할 npm 명령입니다.
 * @param {string[]} extraArgs npm 명령 뒤에 전달할 추가 인자입니다.
 */
function runNpmCommand(targetDir, npmCommand, extraArgs) {
  const targetName = toTargetName(targetDir);
  const npmRunner = resolveNpmRunner();

  console.log(`\n==> ${targetName}`);

  const result = spawnSync(npmRunner.command, [...npmRunner.baseArgs, npmCommand, ...extraArgs], {
    cwd: targetDir,
    stdio: 'inherit',
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    throw result.error;
  }
}

function main() {
  const { npmCommand, extraArgs } = parseArgs(process.argv.slice(2));

  if (extraArgs.includes('--help') || extraArgs.includes('-h')) {
    printHelp();
    return;
  }

  const packageDirs = collectPackageDirs();
  const hasRoot = packageDirs.includes(ROOT_DIR);
  const appCount = packageDirs.filter((targetDir) => targetDir !== ROOT_DIR).length;
  const actionLabel = npmCommand === 'install' ? 'Installing' : 'Updating';

  if (packageDirs.length === 0) {
    console.error('루트와 apps 아래에 package.json이 있는 npm 작업 대상이 없습니다.');
    process.exit(1);
  }

  if (hasRoot) {
    console.log(`${actionLabel} root and ${appCount} app(s) from ${APPS_DIR}`);
  } else {
    console.log(`${actionLabel} ${appCount} app(s) from ${APPS_DIR}`);
  }

  for (const targetDir of packageDirs) {
    runNpmCommand(targetDir, npmCommand, extraArgs);
  }
}

main();
