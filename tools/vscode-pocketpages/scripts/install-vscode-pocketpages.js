'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const VSIX_PATH = path.resolve(__dirname, '..', 'dist', 'vscode-pocketpages.vsix')
const EXTENSION_ID = 'dlstj-local.vscode-pocketpages'
const LEGACY_EXTENSION_IDS = ['dlstj-local.vscode-pocketpages-ejs-poc']
const INSTALL_TARGETS = [
  {
    label: 'VSCode',
    candidates: [
      'code.cmd',
      'C:\\Users\\dlstj\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
    ],
  },
  {
    label: 'Antigravity',
    candidates: [
      'antigravity.cmd',
      'C:\\Users\\dlstj\\AppData\\Local\\Programs\\Antigravity\\bin\\antigravity.cmd',
    ],
  },
]

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch (_error) {
    return false
  }
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('\\')) {
      if (fileExists(candidate)) {
        return candidate
      }

      continue
    }

    const whereResult = spawnSync('where.exe', [candidate], {
      encoding: 'utf8',
      stdio: 'pipe',
    })

    if (whereResult.status === 0) {
      const firstMatch = whereResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)

      if (firstMatch) {
        return firstMatch
      }
    }
  }

  return null
}

function runEditorCommand(executable, args) {
  const escapedArgs = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(' ')
  const commandLine = `& '${executable.replace(/'/g, "''")}' ${escapedArgs}`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', commandLine], {
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
  })

  return result.status || 0
}

function installIntoTarget(target) {
  const executable = findExecutable(target.candidates)
  if (!executable) {
    console.log(`Skipping ${target.label}: CLI not found.`)
    return false
  }

  console.log(`Installing into ${target.label}`)
  console.log(`Using ${executable}`)

  for (const legacyId of LEGACY_EXTENSION_IDS) {
    runEditorCommand(executable, ['--uninstall-extension', legacyId])
  }

  const installStatus = runEditorCommand(executable, ['--install-extension', VSIX_PATH, '--force'])
  if (installStatus !== 0) {
    process.exit(installStatus)
  }

  console.log(`${target.label} install completed. Reload the window to activate ${EXTENSION_ID}.`)
  return true
}

function main() {
  if (!fileExists(VSIX_PATH)) {
    throw new Error(`VSIX not found: ${VSIX_PATH}`)
  }

  let installedAny = false
  for (const target of INSTALL_TARGETS) {
    installedAny = installIntoTarget(target) || installedAny
  }

  if (!installedAny) {
    throw new Error('No supported editor CLI found. Install VSCode or Antigravity, or add its CLI to PATH.')
  }
}

main()
