"use strict";

const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function main() {
  const packageRoot = path.resolve(__dirname, "..");
  const packageLockPath = path.join(packageRoot, "package-lock.json");
  const sourcePackageDir = path.join(packageRoot, "packages", "typescript-plugin");
  const sourcePluginFile = path.join(sourcePackageDir, "index.js");
  const sourceSharedFile = path.join(sourcePackageDir, "shared.js");
  const targetPackageDir = path.join(
    packageRoot,
    "node_modules",
    "@dlstj-local",
    "pocketpages-typescript-plugin"
  );

  const packageLock = fs.existsSync(packageLockPath) ? readJson(packageLockPath) : null;
  const targetPackageState =
    packageLock &&
    packageLock.packages &&
    packageLock.packages["node_modules/@dlstj-local/pocketpages-typescript-plugin"];

  if (targetPackageState && targetPackageState.link) {
    console.log(
      "sync:ts-plugin skipped: the PocketPages TypeScript plugin is installed as an npm link target."
    );
    return;
  }

  fs.rmSync(targetPackageDir, { recursive: true, force: true });
  ensureDir(targetPackageDir);
  copyFile(path.join(sourcePackageDir, "package.json"), path.join(targetPackageDir, "package.json"));
  copyFile(sourcePluginFile, path.join(targetPackageDir, "index.js"));
  copyFile(sourceSharedFile, path.join(targetPackageDir, "shared.js"));
}

main();
