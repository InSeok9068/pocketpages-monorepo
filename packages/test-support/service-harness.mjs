import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APPS_DIR = path.join(ROOT_DIR, 'apps')
const FIXTURES_DIR = path.join(ROOT_DIR, 'packages', 'test-support', 'fixtures')
const IMPORTER_DIR = path.join(ROOT_DIR, 'tools', 'pocketbase-importer')
const DEFAULT_HTTP_PORT = 8090

function parseEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    return {}
  }

  const source = readFileSync(envFilePath, 'utf8')
  const entries = {}

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')

    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()

    if (!key) {
      continue
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    entries[key] = value
  }

  return entries
}

function resolveServiceDir(serviceName) {
  if (!serviceName) {
    throw new Error('serviceName is required')
  }

  return path.join(APPS_DIR, serviceName)
}

function resolvePocketBase(serviceDir) {
  const windowsPocketBase = path.join(serviceDir, 'pocketbase.exe')
  const unixPocketBase = path.join(serviceDir, 'pocketbase')

  if (existsSync(windowsPocketBase)) {
    return windowsPocketBase
  }

  if (existsSync(unixPocketBase)) {
    return unixPocketBase
  }

  throw new Error(`pocketbase binary not found in ${serviceDir}`)
}

function createTempDataDir(serviceDir, serviceName) {
  const sourceDir = path.join(serviceDir, 'pb_data')
  const tempRootDir = mkdtempSync(path.join(os.tmpdir(), `pocketpages-${serviceName}-`))
  const tempDataDir = path.join(tempRootDir, 'pb_data')

  cpSync(sourceDir, tempDataDir, {
    recursive: true,
  })

  return {
    tempRootDir,
    tempDataDir,
  }
}

function resolveImporterPath() {
  const windowsImporter = path.join(IMPORTER_DIR, 'pocketbase-importer.exe')
  const unixImporter = path.join(IMPORTER_DIR, 'pocketbase-importer')

  if (existsSync(windowsImporter)) {
    return windowsImporter
  }

  if (existsSync(unixImporter)) {
    return unixImporter
  }

  throw new Error(`pocketbase-importer not found in ${IMPORTER_DIR}`)
}

function resolveFixtureFile(baseDir, fixturePath, label) {
  const inputPath = String(fixturePath || '').trim()

  if (!inputPath) {
    return ''
  }

  if (path.isAbsolute(inputPath)) {
    throw new Error(`${label} must be relative`)
  }

  const resolvedPath = path.resolve(baseDir, inputPath)
  const relativePath = path.relative(baseDir, resolvedPath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside ${baseDir}`)
  }

  return resolvedPath
}

function resolveFixturePath(fixturePath) {
  return resolveFixtureFile(FIXTURES_DIR, fixturePath, 'fixture')
}

function resolveServiceFixturePath(serviceDir, serviceFixturePath) {
  return resolveFixtureFile(path.join(serviceDir, '__tests__', 'fixtures'), serviceFixturePath, 'serviceFixture')
}

function resolveImportInputPath(serviceDir, importOptions) {
  const fixturePath = String(importOptions.fixture || '').trim()
  const serviceFixturePath = String(importOptions.serviceFixture || '').trim()

  if (fixturePath && serviceFixturePath) {
    throw new Error('import entry must use either fixture or serviceFixture, not both')
  }

  if (fixturePath) {
    return resolveFixturePath(fixturePath)
  }

  if (serviceFixturePath) {
    return resolveServiceFixturePath(serviceDir, serviceFixturePath)
  }

  throw new Error('import entry requires fixture or serviceFixture')
}

function createImportArgs(tempDataDir, importOptions, inputPath) {
  const args = ['-dataDir', tempDataDir, '-collection', importOptions.collection, '-i', inputPath]

  if (importOptions.delimiter) {
    args.push('-delimiter', String(importOptions.delimiter))
  }

  if (importOptions.goroutines) {
    args.push('-goroutines', String(importOptions.goroutines))
  }

  if (importOptions.printDelay) {
    args.push('-printDelay', String(importOptions.printDelay))
  }

  if (importOptions.validate === false) {
    args.push('-validate=false')
  }

  return args
}

function runDataImports(serviceDir, tempDataDir, imports, serviceName) {
  if (!imports) {
    return
  }

  if (!Array.isArray(imports)) {
    throw new Error('imports must be an array')
  }

  if (imports.length === 0) {
    return
  }

  const importerPath = resolveImporterPath()

  for (const importOptions of imports) {
    const collection = String(importOptions && importOptions.collection ? importOptions.collection : '').trim()

    if (!collection) {
      throw new Error('import entry requires collection')
    }

    const inputPath = resolveImportInputPath(serviceDir, importOptions || {})

    if (!existsSync(inputPath)) {
      throw new Error(`import file not found: ${inputPath}`)
    }

    const result = spawnSync(importerPath, createImportArgs(tempDataDir, { ...importOptions, collection }, inputPath), {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (result.error) {
      throw result.error
    }

    if (result.status !== 0) {
      throw new Error(
        `[${serviceName}] import failed for ${collection} from ${inputPath} (exitCode=${result.status})\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`
      )
    }
  }
}

async function waitForServer(getBaseUrl, child, timeoutMs) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`service exited before readiness check completed (exitCode=${child.exitCode})`)
    }

    const baseUrl = getBaseUrl()

    if (!baseUrl) {
      await delay(250)
      continue
    }

    try {
      const response = await fetch(baseUrl, { redirect: 'manual' })

      if (response.status >= 200 && response.status < 500) {
        return
      }
    } catch (error) {
      if (error.name !== 'TypeError') {
        throw error
      }
    }

    await delay(250)
  }

  throw new Error(`timed out waiting for ${getBaseUrl()}`)
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve()
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    return delay(300)
  }

  child.kill('SIGTERM')
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })
}

function removeTempDir(tempRootDir) {
  if (!tempRootDir || !existsSync(tempRootDir)) {
    return
  }

  rmSync(tempRootDir, {
    force: true,
    recursive: true,
  })
}

/**
 * 테스트용 PocketPages 서비스를 띄우고 종료 함수를 돌려준다.
 * @param {object} options 서비스 시작 옵션입니다.
 * @param {string} options.serviceName 서비스 이름입니다.
 * @param {number} [options.timeoutMs] readiness 대기 시간입니다.
 * @param {Array<object>} [options.imports] 서비스 시작 전 temp pb_data에 넣을 CSV 목록입니다.
 * @param {string} options.imports[].collection 대상 컬렉션 이름입니다.
 * @param {string} [options.imports[].fixture] test-support fixtures 기준 CSV 경로입니다.
 * @param {string} [options.imports[].serviceFixture] service __tests__/fixtures 기준 CSV 경로입니다.
 * @param {string} [options.imports[].delimiter] CSV 구분자입니다.
 * @param {number} [options.imports[].goroutines] importer 동시 실행 수입니다.
 * @param {string} [options.imports[].printDelay] importer 진행 출력 주기입니다.
 * @param {boolean} [options.imports[].validate] PocketBase validation 실행 여부입니다.
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void> }>}
 */
export async function startService(options) {
  const serviceName = options.serviceName
  const timeoutMs = options.timeoutMs || 20000
  const serviceDir = resolveServiceDir(serviceName)
  const pocketBasePath = resolvePocketBase(serviceDir)
  const tempData = createTempDataDir(serviceDir, serviceName)
  const envFilePath = path.join(serviceDir, '.env')
  const httpPort = DEFAULT_HTTP_PORT
  const baseUrl = `http://127.0.0.1:${httpPort}`
  const childEnv = {
    ...process.env,
    ...parseEnvFile(envFilePath),
  }

  try {
    runDataImports(serviceDir, tempData.tempDataDir, options.imports, serviceName)
  } catch (error) {
    removeTempDir(tempData.tempRootDir)
    throw error
  }

  const args = [
    'serve',
    '--dev',
    '--dir',
    tempData.tempDataDir,
    '--hooksDir',
    path.join(serviceDir, 'pb_hooks'),
    '--http',
    `127.0.0.1:${httpPort}`,
  ]

  if (existsSync(path.join(serviceDir, 'pb_public'))) {
    args.push('--publicDir', path.join(serviceDir, 'pb_public'))
  }

  const child = spawn(pocketBasePath, args, {
    cwd: serviceDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()

    stdout += text
  })

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    await waitForServer(() => baseUrl, child, timeoutMs)
  } catch (error) {
    await stopProcessTree(child)
    removeTempDir(tempData.tempRootDir)
    error.message = `[${serviceName}] ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    throw error
  }

  return {
    baseUrl,
    async stop() {
      await stopProcessTree(child)
      removeTempDir(tempData.tempRootDir)
    },
  }
}
