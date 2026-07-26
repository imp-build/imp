// File-granular Python execution rules. `pythonSources()` is a deliberately
// shallow target generator: each direct match becomes one PythonSource leaf
// when a run selector needs it. The generated address uses the source file as
// its scope (`//tools/hello.py:python`), making `imp run tools/hello.py`
// work with the normal package-selector parser.

import {
	Target,
	expand,
	file_set,
	glob,
	paths,
	product,
	productFor,
	registerBuildRule,
	registerTarget,
	runTemplate,
	sourcesField,
	toolName,
	RUN,
} from "imp:core";

import {
	resolveUvToolchainVersion,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvTool,
	UV_TOOL,
} from "//rules/python/uv_toolchain";
import {
	PythonResolve,
	pythonResolve,
	pythonResolveSyncArgs,
} from "//rules/python/resolve";

import { TOOL } from "//rules/imp/native_tool";

// Keep `run`'s single-program contract available to consumers that import
// Python rules without separately importing the workflows layer.
import "//rules/workflows/run";
const PYTHON_TOOL = toolName("python");

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

export class PythonToolchain extends Target {
	static kind = "python-toolchain";
	constructor({ version }) {
		super({ kind: PythonToolchain.kind, attrs: { version } });
	}
}

/**
 * Declare a pinned CPython runtime used by source-file runs.
 *
 * The interpreter is provisioned by uv into its existing shared cache; this
 * target intentionally models the selected version, not a second downloader.
 */
export function pythonToolchain(version, { default: isDefault = false } = {}) {
	if (typeof version !== "string" || version === "") {
		throw new Error(
			"pythonToolchain(version) requires a non-empty version string",
		);
	}
	const handle = new PythonToolchain({ version });
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

// Compatibility aliases for the earlier source-run-only API. New code should
// use pythonResolve(), which is shared by source runs, tests, and PEX builds.
export const PythonProject = PythonResolve;

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

export class PythonSources extends Target {
	static kind = "python-sources";
	constructor({
		root,
		sources = ["*.py"],
		runtime,
		project,
		resolve,
		uvVersion,
		deps = [],
	}) {
		if (typeof root !== "string" || root === "") {
			throw new Error(
				"pythonSources({ root, ... }) requires a workspace-relative root",
			);
		}
		if (!Array.isArray(sources) || sources.length === 0) {
			throw new Error(
				"pythonSources({ sources }) requires at least one source pattern",
			);
		}
		if (
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
		if (
			resolvedProject &&
			(resolvedProject.__imp !== true ||
				resolvedProject.kind !== "python-resolve")
		) {
			throw new Error(
				"pythonSources({ resolve }) expects a pythonResolve() target",
			);
		}
		const normalizedRoot = normalize_workspace_path(root);
		super({
			kind: PythonSources.kind,
			attrs: {
				root: normalizedRoot,
				sources,
				runtime,
				uvVersion,
				deps,
				...(resolvedProject ? { project: resolvedProject } : {}),
			},
			sources: sourcesField({ root: `//${normalizedRoot}`, include: sources }),
			deps: [
				{ target: runtime, mode: "tool" },
				...deps.map((target) => ({ target })),
				...(resolvedProject ? [{ target: resolvedProject }] : []),
			],
		});
	}
}

/**
 * Declare a shallow Python source-set generator. Every matching file is made
 * into an internal `python-source` target when it is selected for `run`.
 *
 * @param {object} opts
 * @param {string} opts.root Workspace-relative directory to scan (no recursion).
 * @param {string[]} [opts.sources=["*.py"]] Direct glob patterns matched under root.
 * @param {object} [opts.resolve] Locked Python resolve supplying third-party dependencies.
 * @param {Array} [opts.deps=[]] Extra target handles made available on PATH
 *   inside each source's run — anything whose kind registers a `TOOL`
 *   product, e.g. `nativeTool()` handles for scripts that shell out to host
 *   programs (`git`, comparison-language interpreters, ...).
 */
export function pythonSources({ root, sources, project, resolve, deps } = {}) {
	return new PythonSources({
		root,
		sources,
		runtime: require_default_python_toolchain(),
		project,
		resolve,
		uvVersion: require_default_uv_version(),
		deps,
	});
}

export class PythonSource extends Target {
	static kind = "python-source";
	constructor({
		file,
		root,
		sourceFiles,
		runtime,
		project,
		uvVersion,
		deps = [],
	}) {
		super({
			kind: PythonSource.kind,
			attrs: {
				file,
				root,
				sourceFiles,
				pythonVersion: runtime.attrs.version,
				uvVersion,
				deps,
				...(project
					? { project: project, projectPath: project.attrs.path }
					: {}),
			},
			sources: sourcesField({ root: "//", include: [file] }),
			deps: [
				{ target: runtime, mode: "tool" },
				...deps.map((target) => ({ target })),
				...(project ? [{ target: project }] : []),
			],
		});
	}
}

// A source-set itself has no run product. It is only the declaration that
// establishes ownership and source-root metadata for the leaf targets.
export const expandPythonSources = expand(
	PythonSources,
	async function expandPythonSources(handle) {
		const root = handle.attrs.root;
		const sourceFiles = await paths(
			glob({ root, include: handle.attrs.sources, exclude: [] }),
		);
		for (const file of sourceFiles) {
			registerTarget(
				new PythonSource({
					file,
					root,
					sourceFiles,
					runtime: handle.attrs.runtime,
					project: handle.attrs.project,
					uvVersion: handle.attrs.uvVersion,
					deps: handle.attrs.deps,
				}),
				`//${file}:python`,
			);
		}
	},
	{
		goals: ["run"],
		display: "expand Python sources {0}",
		level: "info",
	},
);

export const pythonSourceRun = product(
	PythonSource,
	RUN,
	PYTHON_TOOL,
	async function pythonSourceRun(handle) {
		const file = handle.attrs.file;
		const root = handle.attrs.root;
		const project = handle.attrs.projectPath || "";
		const syncArgs = pythonResolveSyncArgs(handle.attrs.project)
			.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`)
			.join(" ");
		const venv = project ? `${project}/.venv` : "";
		const uvToolSpec = await uvTool(handle.attrs.uvVersion);
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
	},
	{ display: "run {0}", level: "info" },
);

registerBuildRule({
	rule: "pythonSources",
	importFrom: "//rules/python/source",
});
