const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Copy one patch file into the merged temp directory.
 * @param {string} sourcePath
 * @param {string} targetDir
 */
function copyPatchFile(sourcePath, targetDir) {
  const targetPath = path.join(targetDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, targetPath);
}

/**
 * Resolve the app-local patch-package entry.
 * @param {string} cwd
 * @returns {string}
 */
function resolvePatchPackageEntry(cwd) {
  return require.resolve('patch-package/dist/index.js', { paths: [cwd] });
}

/**
 * Resolve the app-local patch filename parser.
 * @param {string} cwd
 * @returns {{ getPackageDetailsFromPatchFilename: (patchFilename: string) => { path: string, pathSpecifier: string } | null }}
 */
function resolvePackageDetailsModule(cwd) {
  const modulePath = require.resolve('patch-package/dist/PackageDetails.js', { paths: [cwd] });
  return require(modulePath);
}

/**
 * Return patch files that point to installed packages only.
 * @param {string} cwd
 * @returns {string[]}
 */
function getApplicablePatchFiles(cwd) {
  const patchesDir = path.join(__dirname, 'patches');
  const { getPackageDetailsFromPatchFilename } = resolvePackageDetailsModule(cwd);
  const applicableFiles = [];

  for (const fileName of fs.readdirSync(patchesDir)) {
    if (!fileName.endsWith('.patch')) {
      continue;
    }

    const patchDetails = getPackageDetailsFromPatchFilename(fileName);
    if (!patchDetails) {
      continue;
    }

    const packagePath = path.join(cwd, patchDetails.path);
    if (!fs.existsSync(packagePath)) {
      console.log(`skip missing package: ${patchDetails.pathSpecifier}`);
      continue;
    }

    applicableFiles.push(path.join(patchesDir, fileName));
  }

  return applicableFiles;
}

try {
  const cwd = process.cwd();
  const patchPackageEntry = resolvePatchPackageEntry(cwd);
  const patchFiles = getApplicablePatchFiles(cwd);
  const mergedDir = path.join(cwd, '.patch-package-temp');

  if (patchFiles.length === 0) {
    console.log('no applicable patch files');
    process.exit(0);
  }

  try {
    fs.rmSync(mergedDir, { recursive: true, force: true });
    fs.mkdirSync(mergedDir, { recursive: true });

    for (const patchFile of patchFiles) {
      copyPatchFile(patchFile, mergedDir);
    }

    execFileSync(process.execPath, [patchPackageEntry, '--patch-dir', '.patch-package-temp'], {
      cwd,
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(mergedDir, { recursive: true, force: true });
  }
} catch (error) {
  const message = error && error.message ? error.message : String(error);

  if (message.includes('patch-package')) {
    console.log('patch-package not installed, skip');
    process.exit(0);
  }

  throw error;
}
