import { registerBuildRule } from "imp:core";

// Keep direct source-file discovery separate until #8 can expose dynamic graph
// roots in the selector catalog.
export {
	pythonProject,
	pythonSources,
	pythonToolchain,
	defaultPythonProject,
	defaultPythonToolchain,
} from "//rules/python/source";
export { pythonResolve, pythonResolveSyncArgs } from "//rules/python/resolve";
export {
	pythonApp,
	pythonTest,
	registerPythonAppHook,
} from "//rules/python/graph";

export {
	acquireUvToolchain,
	defaultUvToolchain,
	defaultUvToolchainVersion,
	installUvToolchain,
	resolveUvToolchainVersion,
	uvArtifactName,
	uvBin,
	uvCacheKey,
	uvDownloadUrl,
	uvGraphTool,
	uvSupportedPlatforms,
	uvTool,
	uvToolchain,
} from "//rules/python/uv_toolchain";
export {
	acquirePexToolchain,
	defaultPexToolchain,
	defaultPexToolchainVersion,
	installPexToolchain,
	pexBin,
	pexCacheKey,
	pexDownloadUrl,
	pexGraphTool,
	pexTool,
	pexToolchain,
	resolvePexToolchainVersion,
} from "//rules/python/pex_toolchain";

import "//rules/workflows/build";
import "//rules/workflows/run";

registerBuildRule({ rule: "pythonApp", importFrom: "//rules/python" });
registerBuildRule({ rule: "pythonTest", importFrom: "//rules/python" });
