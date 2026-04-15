"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function main() {
  const packageRoot = path.resolve(__dirname, "..");
  const sourcePackageDir = path.join(packageRoot, "src", "ts-plugin", "package");
  const sourcePluginFile = path.join(packageRoot, "src", "ts-plugin", "index.js");
  const sourceSharedFile = path.join(packageRoot, "src", "ts-plugin", "shared.js");
  const targetPackageDir = path.join(
    packageRoot,
    "node_modules",
    "@dlstj-local",
    "pocketpages-typescript-plugin"
  );

  fs.rmSync(targetPackageDir, { recursive: true, force: true });
  ensureDir(targetPackageDir);
  copyFile(path.join(sourcePackageDir, "package.json"), path.join(targetPackageDir, "package.json"));
  copyFile(sourcePluginFile, path.join(targetPackageDir, "index.js"));
  copyFile(sourceSharedFile, path.join(targetPackageDir, "shared.js"));
}

main();
