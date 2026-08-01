// pytest test runner: a whole-suite label, same shape as cargoPackage's test
// handler (rules/rust/index.js) and odinTest (rules/odin/index.js) — one
// sandboxed `pytest` invocation covers the whole label's source tree, not a
// per-file fan-out like pythonSources' discovered run labels. No pex
// packaging step: unlike pythonApp, a test run never needs to be packaged
// first, so this syncs its own throwaway venv directly via uv, independent
// of pythonApp.

import { extensible, label, test as attachTest, run } from "imp:core";

import {
	declared_path,
	PYTHON_PROJECT_SOURCE_INCLUDES,
	pythonAppActionHandle,
	sandboxRootEnvExports,
	sources,
} from "//rules/python";
import { toolSpec } from "//rules/imp/native-tool";

import {
	defaultUvToolchain,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvTool,
} from "//rules/python/uv_toolchain";
import { pythonResolveSyncArgs } from "//rules/python/resolve";

function shellArg(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// No outputs/materialize on this final step: test results aren't
// user-addressable artifacts. impure: true so a re-run always executes
// pytest rather than replaying a cached pass/fail from the task cache —
// same choice cargoTest/odinTest/runCTest make.
export async function pythonTestRun(handle) {
	handle = pythonAppActionHandle(handle);
	const srcPath =
		handle.attrs.resolve?.data?.path ??
		declared_path(handle, handle.attrs.src || ".");
	const inputFiles = await sources(handle);
	const uvToolSpec = await uvTool(handle.attrs.uvVersion);
	const uvCacheToolSpec = uvCacheDirTool();
	const depToolSpecs = await Promise.all(
		(handle.attrs.deps || []).map(toolSpec),
	);
	const syncArgs = pythonResolveSyncArgs(handle.attrs.resolve)
		.map(shellArg)
		.join(" ");

	const venvPath = `${srcPath}/.venv`;
	const envExports = sandboxRootEnvExports(uvCacheDirEnv());
	const script =
		`src=$1; venv=$2; shift 2; ` +
		`imp_sandbox_root="$(pwd)" && ${envExports.join(" && ")} && ` +
		`uv sync --project "$src" --locked --no-progress${syncArgs ? ` ${syncArgs}` : ""} && ` +
		// Scope pytest's own collection to $src explicitly — the sandbox
		// root also holds tool mounts (.imp/tools/...) that pytest would
		// otherwise try to walk for test discovery.
		'"$venv/bin/python" -m pytest "$src" "$@"';

	return run({
		argv: [
			"sh",
			"-c",
			script,
			"python-test",
			srcPath,
			venvPath,
			...(handle.attrs.testArgs || []),
		],
		tools: [uvToolSpec, uvCacheToolSpec, ...depToolSpecs],
		inputs: [inputFiles],
		impure: true,
		display: `python test ${srcPath}`,
	});
}

/**
 * Declare a pytest test suite over a Python project directory.
 *
 * @category label
 * @param {object} opts
 * @param {string} [opts.src="."] Workspace-relative Python project directory.
 * @param {string[]} [opts.testArgs=[]] Extra arguments appended to pytest.
 * @param {object|string} [opts.uvVersion] uv toolchain target handle or version string.
 * @param {object} [opts.resolve] Locked Python resolve supplying the project path; exclusive with `src`.
 * @param {Array} [opts.deps=[]] Extra tool providers made available on PATH
 *   inside the test sandbox: nativeTool() specifications or legacy target
 *   providers whose kind registers a `TOOL` product.
 * @returns {object} Label handle.
 */
export const pythonTest = extensible(function pythonTest({
	src,
	testArgs = [],
	uvVersion,
	resolve,
	deps = [],
} = {}) {
	if (resolve && resolve.__imp_label !== true) {
		throw new Error("pythonTest({ resolve }) expects a pythonResolve() label");
	}
	const resolvePath = resolve?.data?.path;
	if (src !== undefined && resolvePath) {
		throw new Error("pythonTest accepts either src or resolve, not both");
	}
	const projectSrc = src ?? ".";
	const explicitUvTarget =
		uvVersion && uvVersion.__imp === true ? uvVersion : null;
	const explicitUvVersion =
		uvVersion && uvVersion.__imp !== true ? uvVersion : null;
	const uvToolchainTarget =
		explicitUvTarget || (!explicitUvVersion ? defaultUvToolchain() : null);
	const resolvedUvVersion =
		explicitUvVersion ||
		(uvToolchainTarget && uvToolchainTarget.attrs?.version);

	const testLabel = label({
		data: {
			src: projectSrc,
			...(resolve ? { resolve } : {}),
			...(testArgs.length ? { testArgs } : {}),
			...(resolvedUvVersion ? { uvVersion: resolvedUvVersion } : {}),
			...(uvToolchainTarget ? { uvToolchainTarget } : {}),
			deps,
		},
	});

	attachTest(testLabel, async function testPythonTest() {
		return pythonTestRun(testLabel);
	});

	return testLabel;
});
