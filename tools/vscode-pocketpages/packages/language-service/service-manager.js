"use strict";

function createPocketPagesLanguageServiceManager(deps) {
  const {
    ProjectLanguageService,
    findAppRoot,
    isSameOrChildPath,
    normalizePath,
  } = deps;

  function isManagedWatchedFilePath(filePath) {
    return (
      filePath.includes("/pb_hooks/pages/") ||
      filePath.endsWith("/pb_schema.json") ||
      filePath.endsWith("/pb_data/types.d.ts") ||
      filePath.endsWith("/pocketpages-globals.d.ts") ||
      filePath.endsWith("/types.d.ts")
    );
  }

  return class PocketPagesLanguageServiceManager {
    constructor() {
      this.services = new Map();
    }

    findManagedAppRootForFile(filePath) {
      const normalizedFilePath = normalizePath(filePath);
      const discoveredAppRoot = findAppRoot(normalizedFilePath);
      if (discoveredAppRoot) {
        return discoveredAppRoot;
      }

      let matchedAppRoot = null;
      for (const appRoot of this.services.keys()) {
        if (!isSameOrChildPath(appRoot, normalizedFilePath)) {
          continue;
        }

        if (!matchedAppRoot || appRoot.length > matchedAppRoot.length) {
          matchedAppRoot = appRoot;
        }
      }

      return matchedAppRoot;
    }

    getServiceForAppRoot(appRoot) {
      return this.services.get(appRoot) || null;
    }

    getAllServices() {
      return [...this.services.values()];
    }

    getServiceForFile(filePath) {
      const appRoot = findAppRoot(filePath);
      if (!appRoot) {
        return null;
      }

      let service = this.getServiceForAppRoot(appRoot);
      if (!service) {
        service = new ProjectLanguageService(appRoot);
        this.services.set(appRoot, service);
      }

      return service;
    }

    handleWatchedFileChanges(changes) {
      const changesByAppRoot = new Map();

      for (const change of Array.isArray(changes) ? changes : []) {
        const rawFilePath = change && typeof change.filePath === "string" ? change.filePath : "";
        if (!rawFilePath) {
          continue;
        }

        const normalizedFilePath = normalizePath(rawFilePath);
        if (!isManagedWatchedFilePath(normalizedFilePath)) {
          continue;
        }

        const appRoot = this.findManagedAppRootForFile(normalizedFilePath);
        if (!appRoot) {
          continue;
        }

        if (!changesByAppRoot.has(appRoot)) {
          changesByAppRoot.set(appRoot, []);
        }

        changesByAppRoot.get(appRoot).push({
          type: change && typeof change.type === "string" ? change.type : "change",
          filePath: normalizedFilePath,
        });
      }

      const results = [];
      for (const [appRoot, appChanges] of changesByAppRoot.entries()) {
        const service = this.getServiceForAppRoot(appRoot);
        if (!service) {
          continue;
        }

        const invalidationKinds = [];
        for (const change of appChanges) {
          invalidationKinds.push(service.invalidateManagedFile(change.filePath, {
            type: change.type,
          }));
        }
        if (!invalidationKinds.some((kind) => kind && kind !== "noop")) {
          continue;
        }

        results.push({
          appRoot,
          service,
          changes: appChanges,
          invalidationKinds,
        });
      }

      return results;
    }

    resetCachesForFile(filePath) {
      const service = this.getServiceForFile(filePath);
      if (!service) {
        return null;
      }

      service.resetCaches();
      return service;
    }

    resetCachesForAppRoot(appRoot) {
      const service = this.getServiceForAppRoot(appRoot);
      if (!service) {
        return null;
      }

      service.resetCaches();
      return service;
    }

    resetAllCaches() {
      for (const service of this.services.values()) {
        service.resetCaches();
      }
    }
  };
}

module.exports = {
  createPocketPagesLanguageServiceManager,
};
