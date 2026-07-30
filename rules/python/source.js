// File-granular Python execution rules. `pythonSources()` is a deliberately
// shallow discovery-backed label generator: each direct match under `root`
// becomes one selectable child label when a run selector needs it. The
// generated address uses the source file as its scope
// (`//tools/hello.py:python`), making `imp run tools/hello.py` work with
// the normal package-selector parser.

import {
	discoverLabels,
	file_set,
	glob,
	label,
	paths,
	productFor,
	registerBuildRule,
	registerLabel,
	runFromTemplate,
	runGoal,
	runTemplate,
} from "imp:core";

import {
	resolveUvToolchainVersion,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvTool,
} from "//rules/python/uv_toolchain";
import { pythonResolve, pythonResolveSyncArgs } from "//rules/python/resolve";

import { TOOL } from "//rules/imp/native_tool";

// Keep `run`'s single-program contract available to consumers that import
// Python rules without separately importing the workflows layer.
import "//rules/workflows/run";

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
	handle.attrs = handle.data;
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

/**
 * Declare a shallow Python source-set generator. Every matching file under
 * `root` becomes a separately selectable, discovery-backed `run` label
 * (`//<file>:python`), minted lazily the first time a selection needs it —
 * not eagerly at BUILD-load time.
 *
 * @param {object} opts
 * @param {string} opts.root Workspace-relative directory to scan (no recursion).
 * @param {string[]} [opts.sources=["*.py"]] Direct glob patterns matched under root.
 * @param {object} [opts.resolve] Locked Python resolve supplying third-party dependencies.
 * @param {object} [opts.project] Deprecated alias for `resolve`, kept for the
 *   previous single-default-project source-run API; exclusive with `resolve`.
 * @param {Array} [opts.deps=[]] Extra target handles made available on PATH
 *   inside each source's run — anything whose kind registers a `TOOL`
 *   product, e.g. `nativeTool()` handles for scripts that shell out to host
 *   programs (`git`, comparison-language interpreters, ...).
 * @returns {object} Label handle owning the discovered per-file run labels.
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
	const resolvedProject = resolve || project || default_python_project;
	const runtime = require_default_python_toolchain();
	const uvVersion = require_default_uv_version();
	const normalizedRoot = normalize_workspace_path(root);
	const owner = label({
		data: {
			root: normalizedRoot,
			sources,
			runtime,
			project: resolvedProject,
			uvVersion,
			deps,
		},
	});
	owner.attrs = owner.data;
	discoverLabels(
		owner,
		async function discoverPythonSourceLabels(sourceSet) {
			const sourceFiles = await paths(
				glob({
					root: sourceSet.data.root,
					include: sourceSet.data.sources,
					exclude: [],
				}),
			);
			for (const file of sourceFiles) {
				const child = label({
					data: {
						file,
						root: sourceSet.data.root,
						sourceFiles,
						runtime,
						pythonVersion: runtime.attrs.version,
						project: resolvedProject,
						...(resolvedProject
							? { projectPath: resolvedProject.data.path }
							: {}),
						uvVersion,
						deps,
					},
				});
				child.attrs = child.data;
				runGoal(child, async function runPythonSource(ctx) {
					const template = await buildPythonSourceRunTemplate(child);
					return runFromTemplate(template, {
						args: ctx.args,
						sandbox: true,
						workspaceCwd: true,
						impure: true,
						stream: true,
					});
				});
				registerLabel(child, `//${file}:python`);
			}
		},
		{ goals: ["run"] },
	);
	return owner;
}

export async function buildPythonSourceRunTemplate(
	handle,
	resolveUvTool = uvTool,
) {
	const file = handle.attrs.file;
	const root = handle.attrs.root;
	const project = handle.attrs.projectPath || "";
	const syncArgs = pythonResolveSyncArgs(handle.attrs.project)
		.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`)
		.join(" ");
	const venv = project ? `${project}/.venv` : "";
	const uvToolSpec = await resolveUvTool(handle.attrs.uvVersion);
	const uvCacheToolSpec = uvCacheDirTool();
	const depToolSpecs = await Promise.all(
		(handle.attrs.deps || []).map((dep) => productFor(dep, TOOL)),
	);
	const envExports = sandboxRootEnvExports(uvCacheDirEnv());
	const inputs = [file_set.literal(handle.attrs.sourceFiles)];
	if (project) {
		inputs.push(
			glob({ root: project, include: ["pyproject.toml", "uv.lock"] }),
		);
	}
	const script =
		`file=$1; root=$2; project=$3; venv=$4; version=$5; shift 5; ` +
		`${envExports.join(" && ")} && ` +
		'export PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" && ' +
		'if [ -n "$project" ]; then ' +
		`uv sync --project "$project" --locked --no-progress --no-install-project --managed-python --python "$version"${syncArgs ? ` ${syncArgs}` : ""} && ` +
		'"$venv/bin/python" "$file" "$@"; ' +
		'else uv run --no-project --managed-python --python "$version" -- "$file" "$@"; fi';

	return runTemplate({
		argv: [
			"sh",
			"-c",
			script,
			"python-source-run",
			file,
			root,
			project,
			venv,
			handle.attrs.pythonVersion,
		],
		tools: [uvToolSpec, uvCacheToolSpec, ...depToolSpecs],
		inputs,
		display: `python run ${file}`,
	});
}

registerBuildRule({
	rule: "pythonSources",
	importFrom: "//rules/python/source",
});
