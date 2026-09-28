import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import { packagePath } from "imp:core";
import { defaultPythonRuntimeVersion } from "//rules/python/runtime";
import { pythonWorkspaceLock } from "//rules/python/lock";
import {
	defaultUvToolchain,
	defaultUvToolchainVersion,
	uvGraphTool,
} from "//rules/python/uv_toolchain";
import {
	pythonWorkspaceRef,
	pythonWorkspaceSources,
} from "//rules/python/project";

/**
 * Declare the uv workspace that owns Python project locks and dependencies.
 * Workspace membership comes from the root pyproject.toml.
 *
 * @category configuration
 * @param {object} [opts]
 * @param {string} [opts.path] Workspace-relative directory containing pyproject.toml. Defaults to the current BUILD.js package.
 * @param {string} [opts.uvVersion] uv version override.
 * @param {string} [opts.pythonVersion] CPython version used to lock the workspace.
 * @returns {object} A frozen workspace handle with a gen-lockfiles root.
 */
export function pythonWorkspace({
	path = packagePath(),
	uvVersion,
	pythonVersion,
} = {}) {
	const workspace = pythonWorkspaceRef(path);
	const version =
		typeof uvVersion === "string" ? uvVersion : defaultUvToolchainVersion();
	if (!version || !defaultUvToolchain()) {
		throw new Error("pythonWorkspace() requires a uv toolchain");
	}
	const uv = uvGraphTool(version);
	const lockfiles = pythonWorkspaceLock({
		workspace: workspace.path,
		sources: pythonWorkspaceSources(workspace),
		uv,
		pythonVersion: pythonVersion ?? defaultPythonRuntimeVersion(),
	});
	return Object.freeze({ ...workspace, [GEN_LOCKFILES]: lockfiles });
}
