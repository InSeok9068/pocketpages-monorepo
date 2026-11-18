'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '..')
const binaryName = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'

/** @returns {string} 저장소에 고정된 PocketBase 버전입니다. */
function readPinnedVersion() {
  const version = fs.readFileSync(path.join(rootDir, '.pb.version'), 'utf8').replace(/\r?\n$/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version) || /\s/.test(version)) {
    throw new Error('Invalid .pb.version: expected a single x.y.z version')
  }
  return version
}

/** @param {string} binaryPath 확인할 실행 파일 경로입니다. */
function readBinaryVersion(binaryPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketbase-version-'))
  try {
    // PocketBase registers hooks and migrations even when printing its version.
    const output = execFileSync(
      binaryPath,
      ['--version', `--dir=${dir}`, `--hooksDir=${dir}`, `--migrationsDir=${dir}`],
      {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true,
      }
    )
    const match = output.match(/^pocketbase(?:\.exe)? version (\S+)\s*$/im)
    if (!match) throw new Error(`Cannot read PocketBase version: ${binaryPath}`)
    return match[1]
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 고정 버전의 공식 바이너리를 준비합니다.
 * @param {string} version 목표 버전입니다.
 * @param {string} tempDir 다운로드와 압축 해제에 사용할 임시 디렉터리입니다.
 * @returns {string} 확인된 바이너리 경로입니다.
 */
function preparePocketBase(version, tempDir) {
  const bundled = path.join(rootDir, '.download', binaryName)
  if (fs.existsSync(bundled) && readBinaryVersion(bundled) === version) return bundled

  const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
  if (!platform || !arch) throw new Error(`Unsupported PocketBase platform: ${process.platform}/${process.arch}`)

  const url = `https://ganigeorgiev.com/meta/pocketbase/pocketbase/download/v${version}/pocketbase_${version}_${platform}_${arch}.zip`
  const options = { cwd: tempDir, stdio: 'inherit', windowsHide: true }
  const archive = 'pocketbase.zip'
  console.log(`Downloading PocketBase ${version} (${platform}/${arch})`)
  execFileSync(
    'curl',
    ['-fsSL', '--retry', '5', '--connect-timeout', '15', '--max-time', '120', '-o', archive, url],
    options
  )
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(tar, ['-xf', archive, binaryName], options)
  } else {
    execFileSync('unzip', ['-q', archive, binaryName], options)
  }

  const binaryPath = path.join(tempDir, binaryName)
  if (process.platform !== 'win32') fs.chmodSync(binaryPath, 0o755)
  const actual = readBinaryVersion(binaryPath)
  if (actual !== version) throw new Error(`Expected PocketBase ${version}, downloaded ${actual}`)
  return binaryPath
}

module.exports = { binaryName, readPinnedVersion, readBinaryVersion, preparePocketBase }
