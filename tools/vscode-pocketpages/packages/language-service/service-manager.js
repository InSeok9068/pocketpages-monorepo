"use strict";

const DEFAULT_IDLE_SERVICE_TTL_MS = 10 * 60 * 1000;

function getIdleServiceTtlMs(value, fallback) {
  if (value === Infinity) {
    return Infinity;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : fallback;
}

function createPocketPagesLanguageServiceManager(deps) {
  const {
    ProjectLanguageService,
    createDocumentRegistry,
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
    constructor(options = {}) {
      this.services = new Map();
      this.serviceLastUsedAt = new Map();
      this.openDocumentsByAppRoot = new Map();
      this.openDocumentAppRoots = new Map();
      this.idleServiceTtlMs = getIdleServiceTtlMs(
        options.idleServiceTtlMs,
        DEFAULT_IDLE_SERVICE_TTL_MS
      );
      this.now =
        typeof options.now === "function"
          ? options.now
          : () => Date.now();
      this.documentRegistry = createDocumentRegistry ? createDocumentRegistry() : null;
    }

    getCurrentTimeMs() {
      const currentTimeMs = Number(this.now());
      return Number.isFinite(currentTimeMs) ? currentTimeMs : Date.now();
    }

    touchService(appRoot) {
      if (typeof appRoot !== "string" || !appRoot) {
        return;
      }

      this.serviceLastUsedAt.set(normalizePath(appRoot), this.getCurrentTimeMs());
    }

    hasOpenDocumentsForAppRoot(appRoot) {
      if (typeof appRoot !== "string" || !appRoot) {
        return false;
      }

      const openDocuments = this.openDocumentsByAppRoot.get(normalizePath(appRoot));
      return !!openDocuments && openDocuments.size > 0;
    }

    registerOpenDocument(filePath) {
      const normalizedFilePath = normalizePath(filePath);
      const appRoot = findAppRoot(normalizedFilePath) || this.findManagedAppRootForFile(normalizedFilePath);
      if (!appRoot) {
        return null;
      }

      const normalizedAppRoot = normalizePath(appRoot);
      this.openDocumentAppRoots.set(normalizedFilePath, normalizedAppRoot);
      if (!this.openDocumentsByAppRoot.has(normalizedAppRoot)) {
        this.openDocumentsByAppRoot.set(normalizedAppRoot, new Set());
      }

      this.openDocumentsByAppRoot.get(normalizedAppRoot).add(normalizedFilePath);
      this.touchService(normalizedAppRoot);
      return normalizedAppRoot;
    }

    unregisterOpenDocument(filePath) {
      const normalizedFilePath = normalizePath(filePath);
      const appRoot =
        this.openDocumentAppRoots.get(normalizedFilePath) ||
        findAppRoot(normalizedFilePath) ||
        this.findManagedAppRootForFile(normalizedFilePath);
      this.openDocumentAppRoots.delete(normalizedFilePath);
      if (!appRoot) {
        return null;
      }

      const normalizedAppRoot = normalizePath(appRoot);
      const openDocuments = this.openDocumentsByAppRoot.get(normalizedAppRoot);
      if (openDocuments) {
        openDocuments.delete(normalizedFilePath);
        if (!openDocuments.size) {
          this.openDocumentsByAppRoot.delete(normalizedAppRoot);
        }
      }

      this.touchService(normalizedAppRoot);
      return normalizedAppRoot;
    }

    disposeServiceForAppRoot(appRoot) {
      if (typeof appRoot !== "string" || !appRoot) {
        return null;
      }

      const normalizedAppRoot = normalizePath(appRoot);
      if (this.hasOpenDocumentsForAppRoot(normalizedAppRoot)) {
        return null;
      }

      const service = this.services.get(normalizedAppRoot);
      if (!service) {
        return null;
      }

      if (typeof service.dispose === "function") {
        service.dispose();
      } else if (typeof service.resetCaches === "function") {
        service.resetCaches();
      }

      this.services.delete(normalizedAppRoot);
      this.serviceLastUsedAt.delete(normalizedAppRoot);
      return service;
    }

    pruneIdleServices(options = {}) {
      const ttlMs = getIdleServiceTtlMs(options.idleServiceTtlMs, this.idleServiceTtlMs);
      if (!Number.isFinite(ttlMs)) {
        return [];
      }

      const now =
        options.now !== undefined && options.now !== null
          ? Number(options.now)
          : this.getCurrentTimeMs();
      const currentTimeMs = Number.isFinite(now) ? now : this.getCurrentTimeMs();
      const evictedServices = [];

      for (const [appRoot, service] of this.services.entries()) {
        if (this.hasOpenDocumentsForAppRoot(appRoot)) {
          continue;
        }

        const lastUsedAt = this.serviceLastUsedAt.get(appRoot) || 0;
        if (currentTimeMs - lastUsedAt < ttlMs) {
          continue;
        }

        if (this.disposeServiceForAppRoot(appRoot)) {
          evictedServices.push({
            appRoot,
            service,
          });
        }
      }

      return evictedServices;
    }

    findManagedAppRootForFile(filePath) {
      const normalizedFilePath = normalizePath(filePath);
      const discoveredAppRoot = findAppRoot(normalizedFilePath);
      if (discoveredAppRoot) {
        return normalizePath(discoveredAppRoot);
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
      if (typeof appRoot !== "string" || !appRoot) {
        return null;
      }

      const normalizedAppRoot = normalizePath(appRoot);
      const service = this.services.get(normalizedAppRoot) || null;
      if (service) {
        this.touchService(normalizedAppRoot);
      }
      return service;
    }

    getAllServices() {
      this.pruneIdleServices();
      for (const appRoot of this.services.keys()) {
        this.touchService(appRoot);
      }
      return [...this.services.values()];
    }

    getServiceForFile(filePath) {
      this.pruneIdleServices();
      const appRoot = findAppRoot(filePath);
      if (!appRoot) {
        return null;
      }

      const normalizedAppRoot = normalizePath(appRoot);
      let service = this.services.get(normalizedAppRoot) || null;
      if (!service) {
        service = new ProjectLanguageService(normalizedAppRoot, {
          documentRegistry: this.documentRegistry,
        });
        this.services.set(normalizedAppRoot, service);
      }

      this.touchService(normalizedAppRoot);
      return service;
    }

    handleWatchedFileChanges(changes) {
      this.pruneIdleServices();
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
