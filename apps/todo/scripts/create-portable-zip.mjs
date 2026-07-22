import { spawnSync } from 'node:child_process'
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(appDir, '..', '..')
const stagingDir = path.join(repoRoot, '.cache', 'todo-portable-staging')
const stagingRoot = path.join(stagingDir, 'todo-portable')
const outputPath = path.join(appDir, 'todo-portable.zip')
const unocssBin = path.join(repoRoot, 'node_modules', '@unocss', 'cli', 'bin', 'unocss.mjs')
const unocssConfig = path.join(repoRoot, 'unocss.config.js')
const includeData = process.argv.includes('--with-data')
const includeEnv = process.argv.includes('--with-env')
let runtimePackageNames = []

if (process.platform !== 'win32') {
  throw new Error('이 ZIP 스크립트는 Windows PowerShell 환경에서 실행해야 합니다.')
}

function assertInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`안전하지 않은 작업 경로입니다: ${targetPath}`)
  }
}

function copyPath(sourcePath, destinationPath, options = {}) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`필수 경로를 찾을 수 없습니다: ${sourcePath}`)
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    dereference: true,
    ...options,
  })
}

function copyOptionalPath(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) return
  copyPath(sourcePath, destinationPath)
}

function shouldCopyRuntimePackagePath(sourcePath) {
  const normalizedSegments = sourcePath
    .split(path.sep)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean)
  const name = normalizedSegments[normalizedSegments.length - 1] || ''

  if (name.endsWith('.d.ts') || name.endsWith('.map')) return false
  if (name === 'package-lock.json') return false
  if (normalizedSegments.includes('__tests__') || normalizedSegments.includes('tests') || normalizedSegments.includes('pbtest')) return false

  return true
}

function findRuntimePackageNames() {
  const nodeModulesDir = path.join(appDir, 'node_modules')
  const npmExecPath = String(process.env.npm_execpath || '').trim()

  if (!npmExecPath || !fs.existsSync(npmExecPath)) {
    throw new Error('npm run zip 명령으로 실행해야 합니다.')
  }

  const result = spawnSync(process.execPath, [npmExecPath, 'ls', '--omit=dev', '--all', '--parseable'], {
    cwd: appDir,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error((result.error && result.error.message) || result.stderr || result.stdout || '런타임 패키지 목록을 확인하지 못했습니다.')
  }

  const packageNames = new Set()
  const packagePaths = String(result.stdout || '').split(/\r?\n/)

  for (let index = 0; index < packagePaths.length; index += 1) {
    const packagePath = packagePaths[index].trim()
    const relative = path.relative(nodeModulesDir, packagePath)

    if (!packagePath || !relative || relative.startsWith('..') || path.isAbsolute(relative)) continue

    const segments = relative.split(path.sep)
    const packageName = segments[0].startsWith('@') ? segments.slice(0, 2).join(path.sep) : segments[0]

    if (packageName) packageNames.add(packageName)
  }

  return Array.from(packageNames).sort()
}

function copyRuntimeNodeModules() {
  const sourceRoot = path.join(appDir, 'node_modules')
  const destinationRoot = path.join(stagingRoot, 'todo', 'node_modules')

  runtimePackageNames = findRuntimePackageNames()

  for (let index = 0; index < runtimePackageNames.length; index += 1) {
    const packageName = runtimePackageNames[index]
    copyPath(path.join(sourceRoot, packageName), path.join(destinationRoot, packageName), { filter: shouldCopyRuntimePackagePath })
  }
}

function writeBundleReadme() {
  const lines = [
    'TODO portable bundle',
    '',
    '1. 반드시 todo 디렉터리로 이동한 뒤 pocketbase.exe serve를 실행합니다.',
    '   PowerShell: cd todo; .\\pocketbase.exe serve',
    '2. 실행에 필요한 운영 의존성만 node_modules에 포함되어 있습니다.',
    '3. 루트 node_modules와 packages는 실행에 필요하지 않아 포함하지 않습니다.',
    '4. scripts, __tests__, 타입 선언, Docker/개발 설정은 포함하지 않습니다.',
    '5. 기본 ZIP에는 .env와 pb_data가 포함되지 않습니다.',
    '6. 필요하면 npm run zip -- --with-env --with-data 명령으로 다시 생성합니다.',
    '',
    `createdAt=${new Date().toISOString()}`,
    `includesEnv=${includeEnv}`,
    `includesPbData=${includeData}`,
    `runtimePackages=${runtimePackageNames.join(',')}`,
  ]

  fs.writeFileSync(path.join(stagingRoot, 'TODO_PORTABLE_README.txt'), `${lines.join('\r\n')}\r\n`, 'utf8')
}

function buildProductionCss() {
  const servicePath = path.relative(repoRoot, appDir).split(path.sep).join('/')
  const outputFile = `${servicePath}/pb_hooks/pages/assets/uno.min.css`
  const result = spawnSync(
    process.execPath,
    [
      unocssBin,
      `${servicePath}/pb_hooks/pages/**/*.ejs`,
      `${servicePath}/pb_hooks/pages/_private/**/*.js`,
      `!${servicePath}/pb_hooks/pages/_private/vendor/**`,
      `${servicePath}/pb_hooks/pages/assets/**/*.js`,
      `!${servicePath}/pb_hooks/pages/assets/vendor/**`,
      '-c',
      unocssConfig,
      '-o',
      outputFile,
      '--minify',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  )

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'UnoCSS 생성에 실패했습니다.')
  }
}

assertInside(repoRoot, stagingDir)
assertInside(appDir, outputPath)

console.log('운영용 UnoCSS를 생성하는 중입니다.')
buildProductionCss()

console.log('TODO 이동용 파일을 모으는 중입니다.')
fs.rmSync(stagingDir, { recursive: true, force: true })
fs.mkdirSync(stagingRoot, { recursive: true })

try {
  const portableAppDir = path.join(stagingRoot, 'todo')

  copyPath(path.join(appDir, 'pocketbase.exe'), path.join(portableAppDir, 'pocketbase.exe'))
  copyPath(path.join(appDir, 'pb_hooks'), path.join(portableAppDir, 'pb_hooks'))
  copyOptionalPath(path.join(appDir, 'pb_public'), path.join(portableAppDir, 'pb_public'))
  copyOptionalPath(path.join(appDir, 'pb_migrations'), path.join(portableAppDir, 'pb_migrations'))
  copyRuntimeNodeModules()

  if (includeData) copyPath(path.join(appDir, 'pb_data'), path.join(portableAppDir, 'pb_data'))
  if (includeEnv) copyPath(path.join(appDir, '.env'), path.join(portableAppDir, '.env'))

  writeBundleReadme()
  fs.rmSync(outputPath, { force: true })

  console.log('ZIP 파일을 생성하는 중입니다.')
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:TODO_ZIP_SOURCE -DestinationPath $env:TODO_ZIP_DESTINATION -CompressionLevel Optimal -Force'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TODO_ZIP_DESTINATION: outputPath,
        TODO_ZIP_SOURCE: stagingRoot,
      },
    }
  )

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'ZIP 생성에 실패했습니다.')
  }

  const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)
  console.log(`완료: ${outputPath} (${sizeMb} MB)`)
  console.log(`포함: .env=${includeEnv ? '예' : '아니오'}, pb_data=${includeData ? '예' : '아니오'}`)
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true })
}
