import { BUILD } from "//rules/workflows/build";
import { FMT } from "//rules/workflows/fmt";
import { LINT } from "//rules/workflows/lint";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import {
	files,
	output,
	packagePath,
	platformInfo,
	semantic,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
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

export const PYTHON_PROJECT_SOURCE_INCLUDES = [
	"pyproject.toml",
	"uv.lock",
	"**/*.py",
];

const appHooks = [];

export function registerPythonAppHook(hook) {
	if (typeof hook !== "function")
		throw new Error("registerPythonAppHook(hook) expects a function");
	if (!appHooks.includes(hook)) appHooks.push(hook);
}

function workspacePath(base, path) {
	if (typeof path !== "string") throw new Error("python path must be a string");
	const parts = [...base.split("/"), ...path.split("/")].filter(
		(part) => part && part !== ".",
	);
	if (parts.includes(".."))
		throw new Error(`python paths must stay within the workspace: ${path}`);
	return parts.join("/") || ".";
}

function resolveSpec({ src, resolve, base }) {
	if (resolve && resolve.__python_resolve !== true)
		throw new Error("Python targets expect resolve: pythonResolve(...)");
	if (src !== undefined && resolve)
		throw new Error("Python targets accept either src or resolve, not both");
	return (
		resolve ||
		Object.freeze({
			__python_resolve: true,
			path: workspacePath(base, src ?? "."),
			flavors: { default: {} },
		})
	);
}

function resolveArgs(resolve, mode) {
	const flavors = resolve.flavors;
	const name =
		Object.keys(flavors).length === 1 ? "default" : mode || "default";
	const flavor = flavors[name];
	if (!flavor)
		throw new Error(
			`python resolve at '${resolve.path}' does not define flavor '${name}' (available: ${Object.keys(flavors).join(", ")})`,
		);
	return flavor.extra ? ["--extra", flavor.extra] : [];
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

function appBuild(spec) {
	const shell = nativeTool("sh");
	const sources = files({
		root: spec.resolve.path,
		include: PYTHON_PROJECT_SOURCE_INCLUDES,
	});
	const pythonSources = files({
		root: spec.resolve.path,
		include: ["**/*.py"],
	});
	const build = task({
		display: `python-app build ${spec.resolve.path}`,
		inputs: {
			sources,
			uv: spec.uv,
			pex: spec.pex,
			shell,
			resolve: spec.resolve,
			mode: semantic.mode("python"),
			entryPoint: spec.entryPoint ?? null,
			extraPexArgs: spec.extraPexArgs,
			deps: spec.deps,
		},
		outputs: { artifact: output.artifact() },
		async run(exec, inputs) {
			for (const dep of inputs.deps) exec.path(dep);
			const syncArgs = resolveArgs(inputs.resolve, inputs.mode);
			const outputPath = ".imp-out/app.pex";
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'src=$1; uv=$2; pex=$3; out=$4; sync=$5; entry=$6; pexargs=$7; venvpy=$8; "$uv" sync --project "$src" --locked --no-progress $sync && "$src/$venvpy" "$pex" --venv-repository="$src/.venv" --no-transitive --pre -o "$out" ${entry:+-e "$entry"} -D "$src" $pexargs',
					"python-app-build",
					inputs.resolve.path,
					exec.tool(inputs.uv, "uv"),
					exec.tool(inputs.pex, "pex"),
					outputPath,
					syncArgs.join(" "),
					inputs.entryPoint || "",
					inputs.extraPexArgs.join(" "),
					venvPythonRelPath(),
				],
				inputs: [inputs.sources],
				tools: [inputs.shell],
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
		display: `python run ${spec.resolve.path}`,
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
	const sources = files({
		root: spec.resolve.path,
		include: PYTHON_PROJECT_SOURCE_INCLUDES,
	});
	return task({
		display: `python test ${spec.resolve.path}`,
		inputs: {
			sources,
			uv: spec.uv,
			shell,
			resolve: spec.resolve,
			mode: semantic.mode("python"),
			testArgs: spec.testArgs,
			deps: spec.deps,
		},
		outputs: { units: output.value() },
		async run(exec, inputs) {
			for (const dep of inputs.deps) exec.path(dep);
			const syncArgs = resolveArgs(inputs.resolve, inputs.mode);
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'src=$1; uv=$2; sync=$3; testargs=$4; venvpy=$5; "$uv" sync --project "$src" --locked --no-progress $sync && "$src/$venvpy" -m pytest "$src" -rA $testargs',
					"python-test",
					inputs.resolve.path,
					exec.tool(inputs.uv, "uv"),
					syncArgs.join(" "),
					inputs.testArgs.join(" "),
					venvPythonRelPath(),
				],
				inputs: [inputs.sources],
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
										name: inputs.resolve.path,
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

export function pythonApp({
	src,
	entryPoint,
	uvVersion,
	pexVersion,
	pythonVersion,
	extraPexArgs = [],
	resolve,
	deps = [],
	base = packagePath(),
} = {}) {
	const spec = {
		resolve: resolveSpec({ src, resolve, base }),
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
		root: spec.resolve.path,
		[BUILD]: build.outputs.artifact,
		[PACKAGE]: build.outputs.artifact,
		[RUN]: run.outputs.description,
	};
	for (const hook of appHooks)
		Object.assign(value, hook(Object.freeze({ ...value })));
	return Object.freeze(value);
}

export function pythonTest({
	src,
	testArgs = [],
	uvVersion,
	resolve,
	deps = [],
	base = packagePath(),
} = {}) {
	const spec = {
		resolve: resolveSpec({ src, resolve, base }),
		testArgs: [...testArgs],
		deps: [...deps],
		uv: graphTool(
			uvVersion,
			uvGraphTool,
			defaultUvToolchain,
			defaultUvToolchainVersion,
			"uv",
		),
	};
	return Object.freeze({
		root: spec.resolve.path,
		[TEST]: testRoot(spec).outputs.units,
	});
}
