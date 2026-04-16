"use strict";

function createNavigationFeatureHandlers(deps) {
  const {
    collectPathContexts,
    collectStaticRequireCallContexts,
    getPathContextAtOffset,
    getRequirePathContextAtOffset,
    isScriptFile,
    normalizePath,
  } = deps;

  return {
    getDefinitionTarget(service, filePath, documentText, offset) {
      const customDefinitionTarget = service.getCustomDefinitionTarget(filePath, documentText, offset);
      if (customDefinitionTarget) {
        return customDefinitionTarget;
      }

      return service.getTypeScriptDefinitionTarget(filePath, documentText, offset);
    },

    getCustomDefinitionTarget(service, filePath, documentText, offset) {
      const pathContext = getPathContextAtOffset(documentText, offset);
      if (pathContext) {
        if (pathContext.kind === "resolve-path") {
          return service.projectIndex.resolveResolveTarget(filePath, pathContext.value);
        }

        if (pathContext.kind === "include-path") {
          return service.projectIndex.resolveIncludeTarget(filePath, pathContext.value);
        }

        if (pathContext.kind === "asset-path") {
          return service.projectIndex.resolveAssetTarget(filePath, pathContext.value);
        }

        if (pathContext.kind === "route-path") {
          return service.projectIndex.resolveRouteTarget(filePath, pathContext.value, {
            routeSource: pathContext.routeSource,
          });
        }
      }

      const requireContext = getRequirePathContextAtOffset(documentText, offset);
      if (requireContext) {
        return service.projectIndex.resolveRequireTarget(filePath, requireContext.value, requireContext);
      }

      const resolvedModuleMemberContext = service.getResolvedModuleMemberContextForRename(
        filePath,
        documentText,
        offset
      );
      if (!resolvedModuleMemberContext) {
        return null;
      }

      const moduleFilePath = service.projectIndex.resolveResolveTarget(
        filePath,
        resolvedModuleMemberContext.modulePath
      );
      return service.projectIndex.resolveResolvedModuleMemberTarget(
        filePath,
        resolvedModuleMemberContext.modulePath,
        resolvedModuleMemberContext.memberName,
        moduleFilePath ? service.getDocumentOverride(moduleFilePath) : null
      );
    },

    getRenameInfo(service, filePath, documentText, offset) {
      const customRenameInfo = service.getCustomRenameInfo(filePath, documentText, offset);
      if (customRenameInfo) {
        return customRenameInfo;
      }

      return service.getTypeScriptRenameInfo(filePath, documentText, offset);
    },

    getCustomRenameInfo(service, filePath, documentText, offset) {
      const resolvedModuleMemberContext = service.getResolvedModuleMemberContextForRename(
        filePath,
        documentText,
        offset
      );
      if (!resolvedModuleMemberContext) {
        const moduleExportContext = service.getModuleExportRenameContext(filePath, documentText, offset);
        return moduleExportContext
          ? {
              canRename: true,
              ...moduleExportContext,
            }
          : null;
      }

      const moduleDefinitionInfo = service.projectIndex.getResolvedModuleMemberDefinitionInfo(
        filePath,
        resolvedModuleMemberContext.modulePath,
        resolvedModuleMemberContext.memberName,
        (() => {
          const moduleFilePath = service.projectIndex.resolveResolveTarget(
            filePath,
            resolvedModuleMemberContext.modulePath
          );
          return moduleFilePath ? service.getDocumentOverride(moduleFilePath) : null;
        })()
      );
      if (!moduleDefinitionInfo) {
        return null;
      }

      const moduleRename = service.getModuleRenameLocations(moduleDefinitionInfo, {
        [normalizePath(moduleDefinitionInfo.filePath)]: service.getDocumentOverride(
          moduleDefinitionInfo.filePath
        ),
      });
      if (!moduleRename.canRename) {
        return {
          canRename: false,
          localizedErrorMessage:
            moduleRename.localizedErrorMessage || "Unable to rename this module member.",
          start: resolvedModuleMemberContext.start,
          end: resolvedModuleMemberContext.end,
          placeholder: resolvedModuleMemberContext.memberName,
        };
      }

      return {
        canRename: true,
        source: resolvedModuleMemberContext.source,
        start: resolvedModuleMemberContext.start,
        end: resolvedModuleMemberContext.end,
        placeholder: resolvedModuleMemberContext.memberName,
        moduleDefinitionInfo,
      };
    },

    getTypeScriptRenameInfo(service, filePath, documentText, offset) {
      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset);
      if (!virtualState) {
        return null;
      }

      const renameInfo = service.languageService.getRenameInfo(
        virtualState.virtual.fileName,
        virtualState.virtualOffset,
        {
          allowRenameOfImportPath: false,
        }
      );
      if (!renameInfo) {
        return null;
      }

      const start = service.mapVirtualOffsetToDocumentOffset(
        virtualState.virtual.fileName,
        renameInfo.triggerSpan.start
      );
      const end = service.mapVirtualOffsetToDocumentOffset(
        virtualState.virtual.fileName,
        renameInfo.triggerSpan.start + renameInfo.triggerSpan.length
      );
      if (start === null || end === null) {
        return null;
      }

      return {
        canRename: renameInfo.canRename,
        localizedErrorMessage: renameInfo.localizedErrorMessage,
        start,
        end,
        placeholder: documentText.slice(start, end),
        source: "typescript",
      };
    },

    getRenameEdits(service, filePath, documentText, offset, newName) {
      const customRenameInfo = service.getCustomRenameInfo(filePath, documentText, offset);
      if (customRenameInfo) {
        return service.getCustomRenameEdits(filePath, documentText, offset, newName);
      }

      return service.getTypeScriptRenameEdits(filePath, documentText, offset, newName);
    },

    getCustomRenameEdits(service, filePath, documentText, offset, newName) {
      const renameInfo = service.getCustomRenameInfo(filePath, documentText, offset);
      if (!renameInfo) {
        return null;
      }

      if (!renameInfo.canRename) {
        return {
          canRename: false,
          localizedErrorMessage:
            renameInfo.localizedErrorMessage || "Unable to rename this module member.",
          edits: [],
        };
      }

      if (!deps.isValidIdentifierName(newName)) {
        return {
          canRename: false,
          localizedErrorMessage: `Invalid identifier name "${newName}".`,
          edits: [],
        };
      }

      const moduleRename = service.getModuleRenameLocations(renameInfo.moduleDefinitionInfo, service.getPagesCodeOverrides({
        [normalizePath(filePath)]: isScriptFile(filePath) ? documentText : undefined,
      }));
      if (!moduleRename.canRename) {
        return {
          canRename: false,
          localizedErrorMessage:
            moduleRename.localizedErrorMessage || "Unable to rename this module member.",
          edits: [],
        };
      }

      const uniqueEdits = new Map();

      if (renameInfo.source !== "module-export") {
        for (const location of moduleRename.locations) {
          const editKey = `${normalizePath(location.fileName)}:${location.textSpan.start}:${location.textSpan.start + location.textSpan.length}:${newName}`;
          if (!uniqueEdits.has(editKey)) {
            uniqueEdits.set(editKey, {
              filePath: normalizePath(location.fileName),
              start: location.textSpan.start,
              end: location.textSpan.start + location.textSpan.length,
              newText: `${location.prefixText || ""}${newName}${location.suffixText || ""}`,
            });
          }
        }
      }

      for (const edit of service.collectResolvedModuleMemberUsageEdits(
        renameInfo.moduleDefinitionInfo.filePath,
        renameInfo.placeholder,
        newName,
        service.getPagesCodeOverrides({ [normalizePath(filePath)]: documentText })
      )) {
        const editKey = `${edit.filePath}:${edit.start}:${edit.end}:${edit.newText}`;
        if (!uniqueEdits.has(editKey)) {
          uniqueEdits.set(editKey, edit);
        }
      }

      return {
        canRename: true,
        edits: [...uniqueEdits.values()],
      };
    },

    getTypeScriptRenameEdits(service, filePath, documentText, offset, newName) {
      const renameInfo = service.getTypeScriptRenameInfo(filePath, documentText, offset);
      if (!renameInfo) {
        return null;
      }

      if (!renameInfo.canRename) {
        return {
          canRename: false,
          localizedErrorMessage: renameInfo.localizedErrorMessage || "Unable to rename this symbol.",
          edits: [],
        };
      }

      if (!deps.isValidIdentifierName(newName)) {
        return {
          canRename: false,
          localizedErrorMessage: `Invalid identifier name "${newName}".`,
          edits: [],
        };
      }

      const virtualState = service.getVirtualStateAtOffset(filePath, documentText, offset);
      if (!virtualState) {
        return null;
      }

      const renameLocations = service.languageService.findRenameLocations(
        virtualState.virtual.fileName,
        virtualState.virtualOffset,
        false,
        false,
        {}
      ) || [];

      const uniqueEdits = new Map();
      for (const location of renameLocations) {
        const mappedLocation = service.mapTypeScriptReferenceToLocation(location, false);
        if (!mappedLocation) {
          continue;
        }

        const editKey = `${mappedLocation.filePath}:${mappedLocation.start}:${mappedLocation.end}:${newName}`;
        if (!uniqueEdits.has(editKey)) {
          uniqueEdits.set(editKey, {
            filePath: mappedLocation.filePath,
            start: mappedLocation.start,
            end: mappedLocation.end,
            newText: newName,
          });
        }
      }

      return {
        canRename: true,
        edits: [...uniqueEdits.values()],
      };
    },

    getReferenceTargets(service, filePath, documentText, offset, options = {}) {
      const customReferenceTargets = service.getCustomReferenceTargets(
        filePath,
        documentText,
        offset,
        options
      );
      if (customReferenceTargets) {
        return customReferenceTargets;
      }

      const typeScriptReferences = service.getTypeScriptReferenceTargets(
        filePath,
        documentText,
        offset,
        options
      );
      const fileReferenceContext = service.getPrivateIncludeReferenceContext(filePath);
      if (typeScriptReferences && typeScriptReferences.locations.length) {
        if (
          !fileReferenceContext ||
          typeScriptReferences.hasMappedDefinition ||
          typeScriptReferences.hasExternalReference
        ) {
          return typeScriptReferences.locations;
        }
      }

      if (!fileReferenceContext) {
        return null;
      }

      return service.collectPathReferenceLocations(
        fileReferenceContext.kind,
        fileReferenceContext.targetFilePath,
        service.getPagesCodeOverrides({
          [normalizePath(filePath)]: documentText,
        })
      );
    },

    getCustomReferenceTargets(service, filePath, documentText, offset, options = {}) {
      const pathReferenceContext = service.getPathReferenceContext(filePath, documentText, offset);
      if (pathReferenceContext) {
        return service.collectPathReferenceLocations(
          pathReferenceContext.kind,
          pathReferenceContext.targetFilePath,
          service.getPagesCodeOverrides({ [normalizePath(filePath)]: documentText })
        );
      }

      const renameInfo = service.getCustomRenameInfo(filePath, documentText, offset);
      if (!renameInfo) {
        return null;
      }

      const moduleRename = service.getModuleRenameLocations(renameInfo.moduleDefinitionInfo, service.getPagesCodeOverrides({
        [normalizePath(filePath)]: isScriptFile(filePath) ? documentText : undefined,
      }));
      if (!moduleRename.canRename) {
        return [];
      }

      const uniqueLocations = new Map();
      const addLocation = (location) => {
        if (!location) {
          return;
        }

        const locationKey = `${normalizePath(location.filePath)}:${location.start}:${location.end}`;
        if (!uniqueLocations.has(locationKey)) {
          uniqueLocations.set(locationKey, {
            filePath: normalizePath(location.filePath),
            start: location.start,
            end: location.end,
          });
        }
      };

      for (const location of moduleRename.locations) {
        const start = location.textSpan.start;
        const end = location.textSpan.start + location.textSpan.length;
        if (
          !options.includeDeclaration &&
          normalizePath(location.fileName) === normalizePath(renameInfo.moduleDefinitionInfo.filePath) &&
          start === renameInfo.moduleDefinitionInfo.start &&
          end === renameInfo.moduleDefinitionInfo.end
        ) {
          continue;
        }

        addLocation({
          filePath: location.fileName,
          start,
          end,
        });
      }

      for (const location of service.collectResolvedModuleMemberUsageLocations(
        renameInfo.moduleDefinitionInfo.filePath,
        renameInfo.placeholder,
        service.getPagesCodeOverrides({ [normalizePath(filePath)]: documentText })
      )) {
        addLocation(location);
      }

      return [...uniqueLocations.values()];
    },

    getDocumentLinks(service, filePath, documentText) {
      const links = [];

      for (const pathContext of collectPathContexts(documentText)) {
        let targetFilePath = null;

        if (pathContext.kind === "resolve-path") {
          targetFilePath = service.projectIndex.resolveResolveTarget(filePath, pathContext.value);
        } else if (pathContext.kind === "include-path") {
          targetFilePath = service.projectIndex.resolveIncludeTarget(filePath, pathContext.value);
        } else if (pathContext.kind === "asset-path") {
          targetFilePath = service.projectIndex.resolveAssetTarget(filePath, pathContext.value);
        } else if (pathContext.kind === "route-path") {
          targetFilePath = service.projectIndex.resolveRouteTarget(filePath, pathContext.value, {
            routeSource: pathContext.routeSource,
          });
        }

        if (!targetFilePath) {
          continue;
        }

        links.push({
          start: pathContext.start,
          end: pathContext.end,
          targetFilePath,
          kind: pathContext.kind,
          value: pathContext.value,
        });
      }

      for (const requireContext of collectStaticRequireCallContexts(documentText)) {
        const targetFilePath = service.projectIndex.resolveRequireTarget(
          filePath,
          requireContext.value,
          requireContext
        );
        if (!targetFilePath) {
          continue;
        }

        links.push({
          start: requireContext.start,
          end: requireContext.end,
          targetFilePath,
          kind: requireContext.kind,
          value: requireContext.value,
        });
      }

      return links;
    },
  };
}

module.exports = {
  createNavigationFeatureHandlers,
};
