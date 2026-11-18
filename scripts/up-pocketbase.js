#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { binaryName, readPinnedVersion, readBinaryVersion, preparePocketBase } = require('./pocketbase-binary')

const appsDir = path.resolve(__dirname, '../apps')

/** @returns {string[]} 현재 플랫폼의 바이너리가 설치된 서비스 경로입니다. */
function collectBinaries() {
  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => path.join(dir, binaryName))
    .filter((file) => fs.existsSync(file))
    .sort()
}

/**
 * 검증한 바이너리로 앱의 실행 파일을 교체합니다.
 * @param {string} source 검증된 배포본 경로입니다.
 * @param {string} target 앱에 설치된 바이너리 경로입니다.
 */
function replaceBinary(source, target) {
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(target), '.pocketbase-update-'))
  try {
    const stagingFile = path.join(stagingDir, binaryName)
    fs.copyFileSync(source, stagingFile)
    if (process.platform !== 'win32') fs.chmodSync(stagingFile, 0o755)
    fs.renameSync(stagingFile, target)
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ./task.sh update pocketbase')
    console.log('Sync installed app binaries to .pb.version without changing or backing up pb_data.')
    return
  }
  if (args.length)
    throw new Error('This command no longer accepts PocketBase update flags. Back up pb_data separately.')

  const version = readPinnedVersion()
  const binaries = collectBinaries()
  if (!binaries.length) throw new Error(`No installed ${binaryName} found under apps/`)

  const updates = []
  for (const target of binaries) {
    const service = path.basename(path.dirname(target))
    const current = readBinaryVersion(target)
    if (current === version) {
      console.log(`${service}: ${version} (already matches)`)
    } else {
      updates.push({ service, target, current })
    }
  }
  if (!updates.length) return

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketbase-update-'))
  try {
    const source = preparePocketBase(version, tempDir)
    for (const { service, target, current } of updates) {
      try {
        replaceBinary(source, target)
      } catch (error) {
        throw new Error(`${service}: cannot replace ${binaryName}. Stop the app before retrying.`, { cause: error })
      }
      console.log(`${service}: ${current} -> ${version}`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  if (error.cause) console.error(error.cause.message)
  process.exitCode = 1
}
