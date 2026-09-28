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
	mergeDigests,
	output,
	paths,
	registerBuildRule,
	task,
} from "imp:core";
import {
	resolveUvToolchainVersion,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvTool,
} from "//rules/python/uv_toolchain";
import {
	assertPythonProject,
	findPythonProject,
	pythonWorkspaceSources,
} from "//rules/python/project";
import { defaultPythonRuntimeVersion } from "//rules/python/runtime";

import { nativeToolSpec } from "//rules/imp/native-tool";

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

export function pythonSourceVersionOrDefault() {
	const version = defaultPythonRuntimeVersion();
	if (!version) throw new Error("no default python runtime version configured");
	return version;
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

// One [RUN] root per discovered file. It runs nothing itself: it resolves the
// staged digest and assembles the program description //rules/workflows/run
// executes. `cache: false` keeps it out of the action cache — the described
// program is impure by definition, and re-describing it is cheap.
function sourceRunDescriptor(spec, file) {
	const workspaceSet = spec.project
		? pythonWorkspaceSources(spec.project.workspace)
		: null;
	return task({
		display: `python run ${file}`,
		cache: false,
		inputs: {
			sources: files({ root: spec.root, include: spec.sources }),
			...(workspaceSet ? { workspace: workspaceSet } : {}),
			file,
			root: spec.root,
			pythonVersion: spec.pythonVersion,
			uvVersion: spec.uvVersion,
		},
		outputs: { spec: output.value() },
		async run(_exec, input) {
			// Filesets already carry their merged tree digest (digestOf() only
			// exposes what _eval_fileset computed), so the input sets collapse
			// into the single digest the runner stages.
			const digests = [digestOf(input.sources.fileset)];
			if (input.workspace) digests.push(digestOf(input.workspace.fileset));
			const described = await pythonSourceRunSpec({
				file: input.file,
				root: input.root,
				project: spec.project,
				pythonVersion: input.pythonVersion,
				uvVersion: input.uvVersion,
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
 * @param {object} [opts.project] Project supplying third-party dependencies.
 * @param {Array} [opts.deps=[]] Extra tool providers made available on PATH
 *   inside each source's run: nativeTool() specifications.
 * @returns {object} An exportable object whose `[RUN]` root expands to one
 *   selectable child per discovered file.
 * @category target
 */
export function pythonSources({
	root,
	sources = ["*.py"],
	project,
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
	const spec = {
		root: normalize_workspace_path(root),
		sources: [...sources],
		project: project
			? assertPythonProject(project, "pythonSources")
			: findPythonProject(normalize_workspace_path(root)),
		pythonVersion: pythonSourceVersionOrDefault(),
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
	{ file, root, project, pythonVersion, uvVersion, deps = [] },
	resolveUvTool = uvTool,
) {
	const workspace = project ? project.workspace.path : "";
	const venv = workspace ? `${workspace}/.venv` : "";
	const uvToolSpec = await resolveUvTool(uvVersion);
	const uvCacheToolSpec = uvCacheDirTool();
	const depToolSpecs = await group(deps.map(nativeToolSpec));
	const envExports = sandboxRootEnvExports(uvCacheDirEnv());
	const script =
		`file=$1; root=$2; workspace=$3; venv=$4; version=$5; shift 5; ` +
		`${envExports.join(" && ")} && ` +
		'export PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" && ' +
		'if [ -n "$workspace" ]; then ' +
		`uv sync --project "$workspace" --all-packages --locked --no-progress --no-install-workspace --managed-python --python "$version" && ` +
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
			workspace,
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
