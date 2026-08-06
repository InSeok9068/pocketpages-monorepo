const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/**
 * Copy one patch file into the merged temp directory.
 * @param {string} sourcePath
 * @param {string} targetDir
 */
function copyPatchFile(sourcePath, targetDir) {
  const targetPath = path.join(targetDir, path.basename(sourcePath))
  fs.copyFileSync(sourcePath, targetPath)
}

/**
 * Resolve the app-local patch-package entry.
 * @param {string} cwd
 * @returns {string}
 */
function resolvePatchPackageEntry(cwd) {
  return require.resolve('patch-package/dist/index.js', { paths: [cwd] })
}

/**
 * Resolve the app-local patch filename parser.
 * @param {string} cwd
 * @returns {{ getPackageDetailsFromPatchFilename: (patchFilename: string) => { path: string, pathSpecifier: string } | null }}
 */
function resolvePackageDetailsModule(cwd) {
  const modulePath = require.resolve('patch-package/dist/PackageDetails.js', { paths: [cwd] })
  return require(modulePath)
}

/**
 * Return patch files that point to installed packages only.
 * @param {string} cwd
 * @param {string} patchesDir
 * @param {string} sourceName
 * @returns {string[]}
 */
function getApplicablePatchFiles(cwd, patchesDir, sourceName) {
  if (!fs.existsSync(patchesDir)) {
    return []
  }

  const { getPackageDetailsFromPatchFilename } = resolvePackageDetailsModule(cwd)
  const applicableFiles = []

  for (const fileName of fs.readdirSync(patchesDir).sort()) {
    if (!fileName.endsWith('.patch')) {
      continue
    }

    const patchDetails = getPackageDetailsFromPatchFilename(fileName)
    if (!patchDetails) {
      continue
    }

    const packagePath = path.join(cwd, patchDetails.path)
    if (!fs.existsSync(packagePath)) {
      console.log(`skip missing ${sourceName} package: ${patchDetails.pathSpecifier}`)
      continue
    }

    applicableFiles.push(path.join(patchesDir, fileName))
  }

  return applicableFiles
}

/**
 * Reject a package patched in both global and service scopes.
 * @param {string} cwd
 * @param {string[]} globalPatchFiles
 * @param {string[]} servicePatchFiles
 */
function assertNoDuplicateTargets(cwd, globalPatchFiles, servicePatchFiles) {
  const { getPackageDetailsFromPatchFilename } = resolvePackageDetailsModule(cwd)
  const globalTargets = new Map()

  for (const patchFile of globalPatchFiles) {
    const details = getPackageDetailsFromPatchFilename(path.basename(patchFile))
    globalTargets.set(details.path, details)
  }

  for (const patchFile of servicePatchFiles) {
    const details = getPackageDetailsFromPatchFilename(path.basename(patchFile))
    const globalDetails = globalTargets.get(details.path)

    if (globalDetails) {
      throw new Error(
        `Duplicate global/service patch target: ${details.pathSpecifier}. ` + 'Combine the changes into one scope.'
      )
    }
  }
}

/**
 * Apply one ordered patch scope.
 * @param {string} cwd
 * @param {string} patchPackageEntry
 * @param {string[]} patchFiles
 * @param {string} sourceName
 */
function applyPatchFiles(cwd, patchPackageEntry, patchFiles, sourceName) {
  if (patchFiles.length === 0) {
    return
  }

  const tempDirName = `.patch-package-temp-${sourceName}`
  const tempDir = path.join(cwd, tempDirName)

  console.log(`apply ${sourceName} patches`)

  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.mkdirSync(tempDir, { recursive: true })

    for (const patchFile of patchFiles) {
      copyPatchFile(patchFile, tempDir)
    }

    execFileSync(process.execPath, [patchPackageEntry, '--patch-dir', tempDirName], {
      cwd,
      stdio: 'inherit',
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

try {
  const cwd = process.cwd()
  const patchPackageEntry = resolvePatchPackageEntry(cwd)
  const globalPatchFiles = getApplicablePatchFiles(cwd, path.join(__dirname, 'patches'), 'global')
  const servicePatchFiles = getApplicablePatchFiles(cwd, path.join(cwd, 'patches'), 'service')

  if (globalPatchFiles.length === 0 && servicePatchFiles.length === 0) {
    console.log('no applicable patch files')
    process.exit(0)
  }

  assertNoDuplicateTargets(cwd, globalPatchFiles, servicePatchFiles)
  applyPatchFiles(cwd, patchPackageEntry, globalPatchFiles, 'global')
  applyPatchFiles(cwd, patchPackageEntry, servicePatchFiles, 'service')
} catch (error) {
  const message = error && error.message ? error.message : String(error)

  if (message.includes('patch-package')) {
    console.log('patch-package not installed, skip')
    process.exit(0)
  }

  throw error
}
