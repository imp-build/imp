import { registerBuildRule } from "imp:core";

// Keep direct source-file discovery separate until #8 can expose dynamic graph
// roots in the selector catalog.
export {
	pythonSources,
	pythonToolchain,
	defaultPythonToolchain,
} from "//rules/python/source";
export { pythonProject } from "//rules/python/project";
export { pythonWorkspace } from "//rules/python/workspace";
export {
	pythonApp,
	pythonTest,
	registerPythonAppHook,
	registerPythonTestHook,
} from "//rules/python/graph";
export {
	defaultPythonRuntimeVersion,
	pythonRuntime,
} from "//rules/python/runtime";

export {
	defaultUvToolchain,
	defaultUvToolchainVersion,
	installUvToolchain,
	resolveUvToolchainVersion,
	uvArtifactName,
	uvBin,
	uvCacheKey,
	uvDownloadUrl,
	uvGenLockfiles,
	uvGraphTool,
	uvSupportedPlatforms,
	uvTool,
	uvToolchain,
} from "//rules/python/uv_toolchain";
export {
	defaultPexToolchain,
	defaultPexToolchainVersion,
	installPexToolchain,
	pexBin,
	pexCacheKey,
	pexDownloadUrl,
	pexGenLockfiles,
	pexGraphTool,
	pexTool,
	pexToolchain,
	resolvePexToolchainVersion,
} from "//rules/python/pex_toolchain";

import "//rules/workflows/build";
import "//rules/workflows/run";

registerBuildRule({ rule: "pythonApp", importFrom: "//rules/python" });
registerBuildRule({ rule: "pythonTest", importFrom: "//rules/python" });
