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
const includeData = process.argv.includes('--with-data')
const includeEnv = process.argv.includes('--with-env')

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

function shouldCopyTodoPath(sourcePath) {
  const relative = path.relative(appDir, sourcePath)
  if (!relative) return true

  const firstSegment = relative.split(path.sep)[0]
  if (firstSegment === '.cache') return false
  if (firstSegment === 'todo-portable.zip') return false
  if (!includeData && firstSegment === 'pb_data') return false
  if (!includeEnv && firstSegment === '.env') return false

  return true
}

function writeBundleReadme() {
  const lines = [
    'TODO portable bundle',
    '',
    '1. 반드시 todo 디렉터리로 이동한 뒤 pocketbase.exe serve를 실행합니다.',
    '   PowerShell: cd todo; .\\pocketbase.exe serve',
    '2. 실행에 필요한 앱 로컬 node_modules는 이미 포함되어 있습니다.',
    '3. 루트 node_modules와 packages는 실행에 필요하지 않아 포함하지 않습니다.',
    '4. 기본 ZIP에는 .env와 pb_data가 포함되지 않습니다.',
    '5. 필요하면 npm run zip -- --with-env --with-data 명령으로 다시 생성합니다.',
    '',
    `createdAt=${new Date().toISOString()}`,
    `includesEnv=${includeEnv}`,
    `includesPbData=${includeData}`,
  ]

  fs.writeFileSync(path.join(stagingRoot, 'TODO_PORTABLE_README.txt'), `${lines.join('\r\n')}\r\n`, 'utf8')
}

assertInside(repoRoot, stagingDir)
assertInside(appDir, outputPath)

console.log('TODO 이동용 파일을 모으는 중입니다.')
fs.rmSync(stagingDir, { recursive: true, force: true })
fs.mkdirSync(stagingRoot, { recursive: true })

try {
  // 앱 안의 workspace junction도 실제 파일로 복사하므로 packages 원본은 필요 없다.
  copyPath(appDir, path.join(stagingRoot, 'todo'), { filter: shouldCopyTodoPath })

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
