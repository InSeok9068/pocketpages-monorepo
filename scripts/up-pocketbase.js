#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const HELP_ARGS = new Set(['-h', '--help']);

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
    .filter((appDir) => resolvePocketBaseBinary(appDir))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 서비스 이름을 구합니다.
 * @param {string} appDir 앱 루트 절대 경로입니다.
 * @returns {string} 앱 디렉터리 이름입니다.
 */
function toAppName(appDir) {
  return path.basename(appDir);
}

/**
 * 앱 디렉터리의 pocketbase 실행 파일을 찾습니다.
 * @param {string} appDir 앱 루트 절대 경로입니다.
 * @returns {string | null} 실행 파일 절대 경로입니다.
 */
function resolvePocketBaseBinary(appDir) {
  const windowsBinary = path.join(appDir, 'pocketbase.exe');
  const unixBinary = path.join(appDir, 'pocketbase');

  if (fs.existsSync(windowsBinary)) {
    return windowsBinary;
  }

  if (fs.existsSync(unixBinary)) {
    return unixBinary;
  }

  return null;
}

/**
 * pocketbase update 인자를 정리합니다.
 * 기본은 바이너리만 올리도록 pb_data 백업을 끕니다.
 * @param {string[]} extraArgs 사용자가 추가로 넘긴 인자입니다.
 * @returns {string[]} pocketbase 실행 인자 목록입니다.
 */
function buildUpdateArgs(extraArgs) {
  const hasHelpArg = extraArgs.some((arg) => HELP_ARGS.has(arg));
  const hasBackupArg = extraArgs.some((arg) => arg === '--backup' || arg.startsWith('--backup='));
  const args = ['update'];

  if (!hasHelpArg && !hasBackupArg) {
    args.push('--backup=false');
  }

  return [...args, ...extraArgs];
}

/**
 * 정리 대상 pocketbase 백업 파일인지 확인합니다.
 * @param {string} fileName 앱 루트에 있는 파일 이름입니다.
 * @returns {boolean} 삭제해도 되는 임시/백업 파일 여부입니다.
 */
function isPocketBaseBackupFile(fileName) {
  const lowerName = fileName.toLowerCase();

  if (lowerName === 'pocketbase.exe' || lowerName === 'pocketbase') {
    return false;
  }

  if (!lowerName.startsWith('pocketbase')) {
    return false;
  }

  return (
    lowerName.includes('.old') ||
    lowerName.includes('.bak') ||
    lowerName.includes('.backup')
  );
}

/**
 * 앱 루트에 남은 pocketbase 백업 파일을 지웁니다.
 * @param {string} appDir 앱 루트 절대 경로입니다.
 * @returns {string[]} 삭제한 파일 이름 목록입니다.
 */
function cleanupBackupFiles(appDir) {
  const removedFileNames = [];
  const entries = fs.readdirSync(appDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!isPocketBaseBackupFile(entry.name)) {
      continue;
    }

    fs.unlinkSync(path.join(appDir, entry.name));
    removedFileNames.push(entry.name);
  }

  return removedFileNames.sort((left, right) => left.localeCompare(right));
}

/**
 * 도움말을 출력합니다.
 */
function printHelp() {
  console.log('Usage: node scripts/up-pocketbase.js [pocketbase update args...]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/up-pocketbase.js');
  console.log('  node scripts/up-pocketbase.js --backup');
  console.log('  node scripts/up-pocketbase.js --help');
  console.log('');
  console.log('Defaults:');
  console.log('  - Runs pocketbase update in each app directory');
  console.log('  - Uses --backup=false unless you pass --backup or --backup=<value>');
  console.log('  - Removes pocketbase*.old/.bak/.backup files after a successful update');
}

/**
 * 한 앱의 pocketbase 바이너리를 업데이트합니다.
 * @param {string} appDir 앱 루트 절대 경로입니다.
 * @param {string[]} extraArgs pocketbase update 뒤에 붙일 추가 인자입니다.
 */
function runPocketBaseUpdate(appDir, extraArgs) {
  const appName = toAppName(appDir);
  const binaryPath = resolvePocketBaseBinary(appDir);

  if (!binaryPath) {
    throw new Error(`PocketBase binary not found in ${appDir}`);
  }

  console.log(`\n==> ${appName}`);

  const result = spawnSync(binaryPath, buildUpdateArgs(extraArgs), {
    cwd: appDir,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (extraArgs.some((arg) => HELP_ARGS.has(arg))) {
    return;
  }

  const removedFileNames = cleanupBackupFiles(appDir);

  if (removedFileNames.length === 0) {
    console.log('No PocketBase backup file to clean up.');
    return;
  }

  console.log(`Removed backup files: ${removedFileNames.join(', ')}`);
}

function main() {
  const extraArgs = process.argv.slice(2);

  if (extraArgs.includes('--help') || extraArgs.includes('-h')) {
    printHelp();
    return;
  }

  const appDirs = collectAppDirs();

  if (appDirs.length === 0) {
    console.error('apps 아래에 pocketbase 실행 파일이 있는 앱이 없습니다.');
    process.exit(1);
  }

  console.log(`Updating PocketBase in ${appDirs.length} app(s) from ${APPS_DIR}`);

  for (const appDir of appDirs) {
    runPocketBaseUpdate(appDir, extraArgs);
  }
}

main();
