'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const VSIX_PATH = path.resolve(__dirname, '..', 'dist', 'vscode-pocketpages.vsix')
const EXTENSION_ID = 'dlstj-local.vscode-pocketpages'
const LEGACY_EXTENSION_IDS = ['dlstj-local.vscode-pocketpages-ejs-poc']
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
const INSTALL_TARGETS = [
  {
    label: 'VSCode',
    candidates: [
      'code.cmd',
      path.join(LOCAL_APPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    ],
  },
  {
    label: 'Antigravity',
    candidates: [
      'antigravity.cmd',
      path.join(LOCAL_APPDATA, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd'),
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
    stdio: 'pipe',
    shell: false,
  })

  if (result.stdout) {
    process.stdout.write(result.stdout)
  }

  if (result.stderr) {
    process.stderr.write(result.stderr)
  }

  return {
    status: result.status || 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  }
}

function isSuccessfulInstallResult(result) {
  if (!result) {
    return false
  }

  if (result.status === 0) {
    return true
  }

  return /successfully installed/i.test(result.output)
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

  const installResult = runEditorCommand(executable, ['--install-extension', VSIX_PATH, '--force'])
  if (!isSuccessfulInstallResult(installResult)) {
    process.exit(installResult.status || 1)
  }

  if (installResult.status !== 0) {
    console.warn(`${target.label} install reported a non-zero exit code after a successful install message. Continuing.`)
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
