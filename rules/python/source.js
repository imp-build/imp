// File-granular Python execution rules. `pythonSources()` is a deliberately
// shallow, graph-native expansion: every direct match under `root` becomes one
// keyed child exposing a `[RUN]` root. The child key is the file's
// workspace-relative path, so a script is selectable either explicitly
// (`//tools:scripts#tools/hello.py`) or by bare path (`imp run tools/hello.py`,
// resolved by the engine to the nearest enclosing expansion owner).
//
// A `[RUN]` root here describes its program rather than executing it: the
// descriptor task returns the argv/tools/env plus one merged digest to stage,
// and //rules/workflows/run owns the actual policy (sandboxed, impure,
// streamed, cwd at the real workspace). Nothing is published into the working
// tree to make a script runnable.

import { RUN } from "//rules/workflows/run";
import {
	digestOf,
	expand,
	files,
	glob,
	group,
	label,
	mergeDigests,
	output,
	paths,
	registerBuildRule,
	semantic,
	task,
} from "imp:core";
import {
	resolveUvToolchainVersion,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvTool,
} from "//rules/python/uv_toolchain";
import { pythonResolve, pythonResolveSyncArgs } from "//rules/python/resolve";

import { nativeToolSpec } from "//rules/imp/native-tool";

let default_python_toolchain = null;
let default_python_project = null;

export function __resetPythonSourceStateForTest() {
	default_python_toolchain = null;
	default_python_project = null;
}

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(
				`python source paths must stay within the workspace: ${path}`,
			);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function sandboxRootEnvExports(envEntries) {
	return envEntries.map((entry) => {
		const eq = entry.indexOf("=");
		return `export ${entry.slice(0, eq)}="$IMP_SANDBOX_ROOT/${entry.slice(eq + 1)}"`;
	});
}

function require_default_python_toolchain() {
	if (!default_python_toolchain) {
		throw new Error(
			"pythonSources() requires the Python rule default or an explicit pythonToolchain() override",
		);
	}
	return default_python_toolchain;
}

function require_default_uv_version() {
	const version = resolveUvToolchainVersion();
	if (!version) {
		throw new Error(
			"pythonSources() requires the uv rule default or an explicit uvToolchain() override",
		);
	}
	return version;
}

/**
 * Declare a pinned CPython runtime used by source-file runs.
 *
 * The interpreter is provisioned by uv into its existing shared cache; this
 * label intentionally models the selected version, not a second downloader.
 * A handleless label, like pythonResolve() — addressable, referenced by
 * `pythonSources()`-discovered children via `.data`, no goal handlers.
 */
export function pythonToolchain(version, { default: isDefault = false } = {}) {
	if (typeof version !== "string" || version === "") {
		throw new Error(
			"pythonToolchain(version) requires a non-empty version string",
		);
	}
	const handle = label({ data: { version } });
	if (isDefault) default_python_toolchain = handle;
	return handle;
}

export function defaultPythonToolchain() {
	return default_python_toolchain;
}

// Importing the Python rules provisions the CPython runtime used by source
// execution. A workspace can replace it with pythonToolchain(..., { default:
// true }) when it needs another interpreter version.
pythonToolchain("3.13.0", { default: true });

/**
 * Declare the optional workspace-default locked uv project used to supply
 * third-party dependencies for Python source runs.
 */
export function pythonProject({
	path = ".",
	flavors,
	default: isDefault = false,
} = {}) {
	const handle = pythonResolve({
		path: normalize_workspace_path(path),
		flavors,
	});
	if (isDefault) {
		if (default_python_project) {
			throw new Error("only one default pythonProject() may be declared");
		}
		default_python_project = handle;
	}
	return handle;
}

export function defaultPythonProject() {
	return default_python_project;
}

const PROJECT_SOURCES = ["pyproject.toml", "uv.lock"];

// One [RUN] root per discovered file. It runs nothing itself: it resolves the
// staged digest and assembles the program description //rules/workflows/run
// executes. `cache: false` keeps it out of the action cache — the described
// program is impure by definition, and re-describing it is cheap.
function sourceRunDescriptor(spec, file) {
	const projectSet = spec.resolve
		? files({ root: spec.resolve.path, include: PROJECT_SOURCES })
		: null;
	return task({
		display: `python run ${file}`,
		cache: false,
		inputs: {
			sources: files({ root: spec.root, include: spec.sources }),
			...(projectSet ? { project: projectSet } : {}),
			file,
			root: spec.root,
			pythonVersion: spec.pythonVersion,
			uvVersion: spec.uvVersion,
			mode: semantic.mode("python"),
		},
		outputs: { spec: output.value() },
		async run(_exec, input) {
			// Filesets already carry their merged tree digest (digestOf() only
			// exposes what _eval_fileset computed), so the input sets collapse
			// into the single digest the runner stages.
			const digests = [digestOf(input.sources.fileset)];
			if (input.project) digests.push(digestOf(input.project.fileset));
			const described = await pythonSourceRunSpec({
				file: input.file,
				root: input.root,
				resolve: spec.resolve,
				pythonVersion: input.pythonVersion,
				uvVersion: input.uvVersion,
				mode: input.mode,
				deps: spec.deps,
			});
			return {
				spec: {
					...described,
					digest: digests.length === 1 ? digests[0] : mergeDigests(digests),
				},
			};
		},
	});
}

/**
 * Declare a shallow Python source-set generator. Every matching file under
 * `root` becomes a separately selectable `run` root, discovered when the
 * expansion resolves rather than enumerated in BUILD.js.
 *
 * @param {object} opts
 * @param {string} opts.root Workspace-relative directory to scan (no recursion).
 * @param {string[]} [opts.sources=["*.py"]] Direct glob patterns matched under root.
 * @param {object} [opts.resolve] Locked Python resolve supplying third-party dependencies.
 * @param {object} [opts.project] Deprecated alias for `resolve`, kept for the
 *   previous single-default-project source-run API; exclusive with `resolve`.
 * @param {Array} [opts.deps=[]] Extra tool providers made available on PATH
 *   inside each source's run: nativeTool() specifications.
 * @returns {object} An exportable object whose `[RUN]` root expands to one
 *   selectable child per discovered file.
 */
export function pythonSources({
	root,
	sources = ["*.py"],
	project,
	resolve,
	deps = [],
} = {}) {
	if (typeof root !== "string" || root === "") {
		throw new Error(
			"pythonSources({ root, ... }) requires a workspace-relative root",
		);
	}
	if (
		!Array.isArray(sources) ||
		sources.length === 0 ||
		sources.some(
			(pattern) => typeof pattern !== "string" || pattern.includes("**"),
		)
	) {
		throw new Error("pythonSources source patterns must be direct (no '**')");
	}
	if (project && resolve) {
		throw new Error(
			"pythonSources accepts either project or resolve, not both",
		);
	}
	const spec = {
		root: normalize_workspace_path(root),
		sources: [...sources],
		resolve: resolve || project || default_python_project,
		pythonVersion: require_default_python_toolchain().attrs.version,
		uvVersion: require_default_uv_version(),
		deps: [...deps],
	};

	const expansion = expand({
		display: `expand python sources ${spec.root}`,
		inputs: { sources: files({ root: spec.root, include: spec.sources }) },
		// paths() is synchronous — discovery here is a glob, not a task — so
		// this reconstructs live child handles cheaply on every invocation
		// instead of persisting them, the same contract rules/odin's own
		// expansion documents.
		create() {
			const children = {};
			for (const file of paths(
				glob({ root: spec.root, include: spec.sources, exclude: [] }),
			)) {
				children[file] = {
					[RUN]: sourceRunDescriptor(spec, file).outputs.spec,
				};
			}
			return children;
		},
	});

	// expansion.all() (not a per-file .get()) is what makes the children
	// synthetic roots the engine discovers by walking this one export. Unlike
	// CMake's named targets, a glob's matches are not knowable to the BUILD.js
	// author, so they must not have to be enumerated there.
	return Object.freeze({ root: spec.root, [RUN]: expansion.all(RUN) });
}

/**
 * Assemble the program description for one Python source file: everything
 * //rules/workflows/run needs except the digest to stage.
 *
 * @returns {Promise<{argv: string[], env: string[], tools: object[], display: string}>}
 */
export async function pythonSourceRunSpec(
	{ file, root, resolve, pythonVersion, uvVersion, mode, deps = [] },
	resolveUvTool = uvTool,
) {
	const project = resolve ? resolve.path : "";
	const syncArgs = pythonResolveSyncArgs(resolve, mode)
		.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`)
		.join(" ");
	const venv = project ? `${project}/.venv` : "";
	const uvToolSpec = await resolveUvTool(uvVersion);
	const uvCacheToolSpec = uvCacheDirTool();
	const depToolSpecs = await group(deps.map(nativeToolSpec));
	const envExports = sandboxRootEnvExports(uvCacheDirEnv());
	const script =
		`file=$1; root=$2; project=$3; venv=$4; version=$5; shift 5; ` +
		`${envExports.join(" && ")} && ` +
		'export PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" && ' +
		'if [ -n "$project" ]; then ' +
		`uv sync --project "$project" --locked --no-progress --no-install-project --managed-python --python "$version"${syncArgs ? ` ${syncArgs}` : ""} && ` +
		'"$venv/bin/python" "$file" "$@"; ' +
		'else uv run --no-project --managed-python --python "$version" -- "$file" "$@"; fi';

	return {
		argv: [
			"sh",
			"-c",
			script,
			"python-source-run",
			file,
			root,
			project,
			venv,
			pythonVersion,
		],
		env: [],
		tools: [uvToolSpec, uvCacheToolSpec, ...depToolSpecs],
		display: `python run ${file}`,
	};
}

registerBuildRule({
	rule: "pythonSources",
	importFrom: "//rules/python/source",
});
