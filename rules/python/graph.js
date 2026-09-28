import { BUILD } from "//rules/workflows/build";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import { files, output, packagePath, platformInfo, task } from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	assertPythonProject,
	inferPythonProject,
	pythonWorkspaceSources,
} from "//rules/python/project";
import {
	defaultPexToolchain,
	defaultPexToolchainVersion,
	pexGraphTool,
} from "//rules/python/pex_toolchain";
import { defaultPythonRuntimeVersion } from "//rules/python/runtime";
import {
	defaultUvToolchain,
	defaultUvToolchainVersion,
	uvGraphTool,
	uvTool,
} from "//rules/python/uv_toolchain";

export const PYTHON_SOURCE_INCLUDES = ["*.py"];

function sourcePatterns(value, api) {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`${api}({ sources }) requires source glob patterns`);
	if (value.some((pattern) => typeof pattern !== "string" || pattern === ""))
		throw new Error(`${api}({ sources }) expects non-empty glob patterns`);
	return [...value];
}

const appHooks = [];
const testHooks = [];

export function registerPythonAppHook(hook) {
	if (typeof hook !== "function")
		throw new Error("registerPythonAppHook(hook) expects a function");
	if (!appHooks.includes(hook)) appHooks.push(hook);
}

export function registerPythonTestHook(hook) {
	if (typeof hook !== "function")
		throw new Error("registerPythonTestHook(hook) expects a function");
	if (!testHooks.includes(hook)) testHooks.push(hook);
}

function projectSpec({ project, base, api }) {
	return project
		? assertPythonProject(project, api)
		: inferPythonProject(base, api);
}

// uv places the venv's Python interpreter at .venv/bin/python on
// Linux/macOS but .venv/Scripts/python.exe on Windows (uv follows the
// native venv layout for the host platform, regardless of which shell is
// driving it — confirmed by a real "No such file or directory" failure
// against a hardcoded Unix-only path).
function venvPythonRelPath() {
	return platformInfo().os === "windows"
		? ".venv/Scripts/python.exe"
		: ".venv/bin/python";
}

// PEX copies its -D directory into TMPDIR, and the sandbox TMPDIR is
// .imp/tmp under the sandbox root. For a project at the workspace root the
// project directory is the sandbox root, so -D "$src" copies into itself
// until the paths are too long. It also adds .venv and the staged tools.
// For this reason, the build copies only the declared sources into this
// directory and gives it to -D.
const PEX_SOURCES_DIR = ".imp-pex-sources";

function projectRelativePath(project, path) {
	if (project === ".") return path;
	if (!path.startsWith(`${project}/`))
		throw new Error(`python source ${path} is not below ${project}`);
	return path.slice(project.length + 1);
}

function appBuild(spec) {
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const dirname = nativeTool("dirname");
	const sources = files({ root: spec.project.path, include: spec.sources });
	const pythonSources = files({
		root: spec.project.path,
		include: spec.sources,
	});
	const workspaceSources = pythonWorkspaceSources(spec.project.workspace);
	const build = task({
		display: `python-app build ${spec.project.path}`,
		inputs: {
			sources,
			pythonSources,
			workspaceSources,
			uv: spec.uv,
			pex: spec.pex,
			shell,
			cp,
			mkdir,
			dirname,
			project: spec.project,
			pythonVersion: spec.pythonVersion,
			entryPoint: spec.entryPoint ?? null,
			extraPexArgs: spec.extraPexArgs,
			deps: spec.deps,
		},
		outputs: { artifact: output.artifact() },
		async run(exec, inputs) {
			for (const dep of inputs.deps) exec.path(dep);
			const outputPath = ".imp-out/app.pex";
			const sourcePaths = exec
				.paths(inputs.pythonSources)
				.map((path) => projectRelativePath(inputs.project.path, path));
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'project=$1; workspace=$2; uv=$3; pex=$4; out=$5; version=$6; entry=$7; pexargs=$8; venvpy=$9; stage=${10}; shift 10; "$uv" sync --project "$workspace" --all-packages --locked --no-dev --no-progress --managed-python --python "$version" && mkdir -p "$stage" && for path in "$@"; do mkdir -p "$stage/$(dirname -- "$path")" && cp "$project/$path" "$stage/$path" || exit 1; done && "$workspace/$venvpy" "$pex" --venv-repository="$workspace/.venv" --no-transitive --pre -o "$out" ${entry:+-e "$entry"} -D "$stage" $pexargs',
					"python-app-build",
					inputs.project.path,
					inputs.project.workspace.path,
					exec.tool(inputs.uv, "uv"),
					exec.tool(inputs.pex, "pex"),
					outputPath,
					inputs.pythonVersion,
					inputs.entryPoint || "",
					inputs.extraPexArgs.join(" "),
					venvPythonRelPath(),
					PEX_SOURCES_DIR,
					...sourcePaths,
				],
				inputs: [inputs.workspaceSources, inputs.sources],
				tools: [inputs.shell, inputs.cp, inputs.mkdir, inputs.dirname],
				outputs: { artifact: output.file(outputPath) },
			});
			return { artifact: result.outputs.artifact };
		},
	});
	// Describes the program rather than running it: //rules/workflows/run's
	// graphRunGoal is the one place that actually executes a [RUN] root, so it
	// alone owns sandboxing/streaming/CLI-tail policy. uvTool() resolves uv
	// into the legacy tool-spec shape run() consumes directly (a symlinked
	// PATH entry inside whatever sandbox graphRunGoal spawns), the same bridge
	// rules/rust/kache's kacheTool() uses.
	const run = task({
		display: `python run ${spec.project.path}`,
		inputs: {
			app: build.outputs.artifact,
			uv: spec.uv,
			pythonVersion: spec.pythonVersion,
		},
		outputs: { description: output.value() },
		async run(_exec, inputs) {
			const uv = await uvTool(spec.uvVersion);
			return {
				description: {
					argv: [
						"sh",
						"-c",
						'prog=$1; ver=$2; shift 2; exec uv run --no-project --managed-python --python "$ver" -- "$IMP_SANDBOX_ROOT/$prog" "$@"',
						"python-run",
						inputs.app.path,
						inputs.pythonVersion,
					],
					env: [`IMP_PYTHON_BUILD_VERSION=${inputs.pythonVersion}`],
					tools: [uv],
					digest: inputs.app.digest,
				},
			};
		},
	});
	return { build, run, sources, pythonSources };
}

// Groups pytest's `-rA` "short test summary info" lines (`OUTCOME
// path/to/file.py::test_name ...`) by file — the execution-unit granularity
// //rules/workflows/test's contract wants for Python, matching the shipped
// test binary/package granularity Rust/CMake/Odin already report at.
function pytestFilesByOutcome(stdout) {
	const seenFiles = new Set();
	const failedFiles = new Set();
	for (const match of stdout.matchAll(/^(PASSED|FAILED|ERROR)\s+(\S+)/gm)) {
		const [, outcome, nodeId] = match;
		const file = nodeId.split("::")[0];
		seenFiles.add(file);
		if (outcome !== "PASSED") failedFiles.add(file);
	}
	return { seenFiles, failedFiles };
}

function testRoot(spec) {
	const shell = nativeTool("sh");
	const sources = files({ root: spec.project.path, include: spec.sources });
	const workspaceSources = pythonWorkspaceSources(spec.project.workspace);
	return task({
		display: `python test ${spec.project.path}`,
		inputs: {
			sources,
			workspaceSources,
			uv: spec.uv,
			shell,
			project: spec.project,
			pythonVersion: spec.pythonVersion,
			testArgs: spec.testArgs,
			deps: spec.deps,
		},
		outputs: { units: output.value() },
		async run(exec, inputs) {
			for (const dep of inputs.deps) exec.path(dep);
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'project=$1; workspace=$2; uv=$3; testargs=$4; version=$5; venvpy=$6; "$uv" sync --project "$workspace" --all-packages --locked --no-progress --managed-python --python "$version" && "$workspace/$venvpy" -m pytest "$project" -rA $testargs',
					"python-test",
					inputs.project.path,
					inputs.project.workspace.path,
					exec.tool(inputs.uv, "uv"),
					inputs.testArgs.join(" "),
					inputs.pythonVersion,
					venvPythonRelPath(),
				],
				inputs: [inputs.workspaceSources, inputs.sources],
				tools: [inputs.shell],
				allowFailure: true,
			});
			const combinedOutput = [result.stdout, result.stderr]
				.filter(Boolean)
				.join("\n");
			const { seenFiles, failedFiles } = pytestFilesByOutcome(result.stdout);
			if (seenFiles.size === 0) {
				// Nothing pytest itself reported per-file — either a clean run
				// with zero collected tests, or a failure before collection
				// (uv sync, a collection error). Report the whole invocation as
				// one unit rather than silently dropping a failure.
				return {
					units:
						result.exitCode === 0
							? []
							: [
									{
										name: inputs.project.path,
										ok: false,
										output: combinedOutput,
									},
								],
				};
			}
			return {
				units: Array.from(seenFiles)
					.sort()
					.map((file) => ({
						name: file,
						ok: !failedFiles.has(file),
						...(failedFiles.has(file) ? { output: combinedOutput } : {}),
					})),
			};
		},
	});
}

function graphTool(value, tool, defaultTool, defaultVersion, name) {
	if (value?.__imp_graph_handle === true) return value;
	const selected = typeof value === "string" ? value : defaultVersion();
	if (!selected || !defaultTool())
		throw new Error(`no default ${name} toolchain configured`);
	return tool(selected);
}

function pythonVersionOrDefault(value) {
	const selected =
		typeof value === "string" ? value : defaultPythonRuntimeVersion();
	if (!selected)
		throw new Error("no default python runtime version configured");
	return selected;
}

/**
 * Declare a Python application and its PEX build and run roots.
 *
 * @category target
 * @param {object} opts Project, toolchain, and dependency options.
 * @param {string[]} [opts.sources=["*.py"]] Source patterns relative to the project directory.
 * @param {string} [opts.entryPoint] Application entry point.
 * @param {string} [opts.uvVersion] uv version override.
 * @param {string} [opts.pexVersion] PEX version override.
 * @param {string} [opts.pythonVersion] CPython version override.
 * @param {string[]} [opts.extraPexArgs=[]] Extra PEX arguments.
 * @param {object} [opts.project] Project handle. Inferred from the target path when omitted.
 * @param {object[]} [opts.deps=[]] Extra native tools.
 * @param {string} [opts.base=packagePath()] Workspace-relative base directory.
 * @returns {object} Frozen build, package, run, and source handles.
 */
export function pythonApp({
	sources: sourceGlobs = PYTHON_SOURCE_INCLUDES,
	entryPoint,
	uvVersion,
	pexVersion,
	pythonVersion,
	extraPexArgs = [],
	project,
	deps = [],
	base = packagePath(),
} = {}) {
	const spec = {
		project: projectSpec({ project, base, api: "pythonApp" }),
		sources: sourcePatterns(sourceGlobs, "pythonApp"),
		entryPoint,
		extraPexArgs: [...extraPexArgs],
		deps: [...deps],
		pythonVersion: pythonVersionOrDefault(pythonVersion),
		uv: graphTool(
			uvVersion,
			uvGraphTool,
			defaultUvToolchain,
			defaultUvToolchainVersion,
			"uv",
		),
		// Kept alongside the resolved `uv` handle above (not derivable from it):
		// the [RUN] task resolves uv into a legacy tool spec via uvTool(), which
		// re-resolves by version string against the same toolchain registry
		// graphTool() already consulted, rather than reusing the handle itself.
		uvVersion,
		pex: graphTool(
			pexVersion,
			pexGraphTool,
			defaultPexToolchain,
			defaultPexToolchainVersion,
			"PEX",
		),
	};
	const { build, run, sources, pythonSources } = appBuild(spec);
	const value = {
		sources,
		pythonSources,
		root: spec.project.path,
		[BUILD]: build.outputs.artifact,
		[PACKAGE]: build.outputs.artifact,
		[RUN]: run.outputs.description,
	};
	// Hooks also get the source glob patterns, so a hook can find files that
	// sit beside the sources (for example Ruff config files). The patterns are
	// not part of the target.
	for (const hook of appHooks)
		Object.assign(
			value,
			hook(Object.freeze({ ...value, sourcePatterns: spec.sources })),
		);
	return Object.freeze(value);
}

/**
 * Declare a Python test suite backed by its project's uv workspace.
 *
 * @category target
 * @param {object} opts Project, toolchain, and dependency options.
 * @param {string[]} [opts.sources=["*.py"]] Source patterns relative to the project directory.
 * @param {string[]} [opts.testArgs=[]] Arguments passed to pytest.
 * @param {string} [opts.uvVersion] uv version override.
 * @param {string} [opts.pythonVersion] CPython version override.
 * @param {object} [opts.project] Project handle. Inferred from the target path when omitted.
 * @param {object[]} [opts.deps=[]] Extra native tools.
 * @param {string} [opts.base=packagePath()] Workspace-relative base directory.
 * @returns {object} Frozen test root.
 */
export function pythonTest({
	sources: sourceGlobs = PYTHON_SOURCE_INCLUDES,
	testArgs = [],
	uvVersion,
	pythonVersion,
	project,
	deps = [],
	base = packagePath(),
} = {}) {
	const spec = {
		project: projectSpec({ project, base, api: "pythonTest" }),
		sources: sourcePatterns(sourceGlobs, "pythonTest"),
		testArgs: [...testArgs],
		deps: [...deps],
		pythonVersion: pythonVersionOrDefault(pythonVersion),
		uv: graphTool(
			uvVersion,
			uvGraphTool,
			defaultUvToolchain,
			defaultUvToolchainVersion,
			"uv",
		),
	};
	const pythonSources = files({
		root: spec.project.path,
		include: spec.sources,
	});
	const value = {
		root: spec.project.path,
		[TEST]: testRoot(spec).outputs.units,
	};
	for (const hook of testHooks)
		Object.assign(
			value,
			hook(
				Object.freeze({
					...value,
					pythonSources,
					sourcePatterns: spec.sources,
				}),
			),
		);
	return Object.freeze(value);
}
