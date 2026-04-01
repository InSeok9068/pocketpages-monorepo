#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT_DIR, 'apps');

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
 * 업데이트 대상 서비스 디렉터리를 찾습니다.
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
 * 화면 출력용 앱 이름을 만듭니다.
 * @param {string} appDir 앱 루트 절대 경로입니다.
 * @returns {string} 앱 디렉터리 이름입니다.
 */
function toAppName(appDir) {
  return path.basename(appDir);
}

/**
 * 도움말을 출력합니다.
 */
function printHelp() {
  console.log('Usage: npm run up:apps [-- <npm up args>]');
  console.log('');
  console.log('Examples:');
  console.log('  npm run up:apps');
  console.log('  npm run up:apps -- --save');
  console.log('  npm run up:apps -- --dry-run');
}

/**
 * 한 앱 디렉터리에서 npm up을 실행합니다.
 * @param {string} appDir 앱 루트 절대 경로입니다.
 * @param {string[]} extraArgs npm up 뒤에 전달할 추가 인자입니다.
 */
function runUpdate(appDir, extraArgs) {
  const appName = toAppName(appDir);
  const npmRunner = resolveNpmRunner();

  console.log(`\n==> ${appName}`);

  const result = spawnSync(npmRunner.command, [...npmRunner.baseArgs, 'up', ...extraArgs], {
    cwd: appDir,
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
  const extraArgs = process.argv.slice(2);

  if (extraArgs.includes('--help') || extraArgs.includes('-h')) {
    printHelp();
    return;
  }

  const appDirs = collectAppDirs();

  if (appDirs.length === 0) {
    console.error('apps 아래에 package.json이 있는 앱이 없습니다.');
    process.exit(1);
  }

  console.log(`Updating ${appDirs.length} app(s) from ${APPS_DIR}`);

  for (const appDir of appDirs) {
    runUpdate(appDir, extraArgs);
  }
}

main();
