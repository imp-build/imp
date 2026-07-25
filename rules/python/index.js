import {
	Target,
	artifact,
	glob,
	memo,
	output,
	output_path,
	product,
	registerBuildRule,
	run,
	sourcesField,
	targetAddress,
	BUILD,
	PACKAGE,
} from "imp:core";
import { UV_TOOL } from "//rules/python/uv_toolchain";
import { PEX_TOOL } from "//rules/python/pex_toolchain";
import { pythonResolveSyncArgs } from "//rules/python/resolve";

import {
	defaultUvToolchain,
	uvCacheDirEnv,
	uvCacheDirTool,
	uvTool,
} from "//rules/python/uv_toolchain";

import {
	defaultPexToolchain,
	pexRootEnv,
	pexRootTool,
	pexTool,
} from "//rules/python/pex_toolchain";

// File-granular source execution is intentionally separate from pythonApp's
// PEX packaging model. Import for its target/product registrations.
import "//rules/python/source";

export {
	PythonProject,
	PythonSource,
	PythonSources,
	PythonToolchain,
	defaultPythonProject,
	defaultPythonToolchain,
	pythonProject,
	pythonSources,
	pythonToolchain,
} from "//rules/python/source";

export {
	PythonResolve,
	pythonResolve,
	pythonResolveSyncArgs,
} from "//rules/python/resolve";

// Registers the "build" goal's artifact summary callback for consumers that
// import Python build rules without importing the workflows layer explicitly.
import "//rules/workflows/build_workflow";

// Registers the "test" product (pythonTest / pytest) for consumers that
// import Python build rules without importing //rules/python/test explicitly
// — same reasoning as the build_workflow import above. Side-effect only;
// nothing exported from it is used in this file.
import "//rules/python/test";

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
	pexTool,
	pexToolchain,
	resolvePexToolchainVersion,
} from "//rules/python/pex_toolchain";

registerBuildRule({
	rule: "pythonApp",
	importFrom: "//rules/python",
});

registerBuildRule({
	rule: "pythonTest",
	importFrom: "//rules/python/test",
});

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/odin/index.js and rules/c/cmake/index.js)
// ---------------------------------------------------------------------------

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`python paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
	if (!handle || handle.__imp !== true) return null;
	try {
		return targetAddress(handle);
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = safe_target_address(handle);
	if (!address || !address.startsWith("//")) return ".";
	const scope = address.slice(2).split(":")[0];
	return scope.length === 0 ? "." : scope;
}

export function declared_path(handle, path = ".") {
	const base = declaring_directory(handle);
	const local = path || ".";
	if (base === ".") return normalize_workspace_path(local);
	if (local === ".") return base;
	return normalize_workspace_path(`${base}/${local}`);
}

// ---------------------------------------------------------------------------
// Memo/product functions
// ---------------------------------------------------------------------------

export const PYTHON_PROJECT_SOURCE_INCLUDES = [
	"pyproject.toml",
	"uv.lock",
	"**/*.py",
];

export const sources = memo(
	async function sources(handle) {
		const root =
			handle.attrs.resolve?.attrs?.path ??
			declared_path(handle, handle.attrs.src || ".");
		return glob({ root, include: PYTHON_PROJECT_SOURCE_INCLUDES });
	},
	{ display: "sources {0}", level: "debug" },
);

// Just the .py files a formatter rewrites, scoped to this target's own
// directory — narrower than sources() above, which also pulls in
// pyproject.toml/uv.lock as build-time sandbox inputs. Same split as
// rust_file_sources vs sources() in rules/rust/index.js.
export const python_file_sources = memo(
	async function python_file_sources(handle) {
		const root =
			handle.attrs.resolve?.attrs?.path ??
			declared_path(handle, handle.attrs.src || ".");
		return glob({ root, include: ["**/*.py"] });
	},
	{ display: "python file sources {0}", level: "debug" },
);

// Both uv sync and pex build need $UV_CACHE_DIR/$PEX_ROOT exported as
// absolute paths — their values point at tool mounts under the sandbox
// root, but a plain relative env value would be reinterpreted relative to
// whatever cwd is active when the value is actually read, silently missing
// the shared mount. Same idiom as zigEnvExportStmts in
// rules/c/cmake/index.js; capture `imp_sandbox_root="$(pwd)"` before using
// this, even though these scripts never `cd` themselves (uv/pex are pointed
// at project paths explicitly), in case uv or pex ever change directory
// internally.
export function sandboxRootEnvExports(envEntries) {
	return envEntries.map((entry) => {
		const eq = entry.indexOf("=");
		return `export ${entry.slice(0, eq)}="$imp_sandbox_root/${entry.slice(eq + 1)}"`;
	});
}

function shellArg(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class PythonApp extends Target {
	static kind = "python-app";
	constructor({
		src,
		entryPoint,
		uvVersion,
		pexVersion,
		extraPexArgs = [],
		resolve,
		deps = [],
	}) {
		if (resolve && resolve.__imp !== true) {
			throw new Error(
				"pythonApp({ resolve }) expects a pythonResolve() target",
			);
		}
		const resolvePath = resolve?.attrs?.path;
		if (resolve && resolve.kind !== "python-resolve") {
			throw new Error(
				"pythonApp({ resolve }) expects a pythonResolve() target",
			);
		}
		if (src !== undefined && resolvePath) {
			throw new Error("pythonApp accepts either src or resolve, not both");
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

		const explicitPexTarget =
			pexVersion && pexVersion.__imp === true ? pexVersion : null;
		const explicitPexVersion =
			pexVersion && pexVersion.__imp !== true ? pexVersion : null;
		const pexToolchainTarget =
			explicitPexTarget || (!explicitPexVersion ? defaultPexToolchain() : null);
		const resolvedPexVersion =
			explicitPexVersion ||
			(pexToolchainTarget && pexToolchainTarget.attrs?.version);

		const allDeps = [
			...(resolve ? [{ target: resolve }] : []),
			...(uvToolchainTarget
				? [{ target: uvToolchainTarget, mode: "tool" }]
				: []),
			...(pexToolchainTarget
				? [{ target: pexToolchainTarget, mode: "tool" }]
				: []),
			...deps,
		];

		super({
			kind: PythonApp.kind,
			attrs: {
				src: projectSrc,
				...(resolve ? { resolve } : {}),
				...(entryPoint ? { entryPoint } : {}),
				...(resolvedUvVersion ? { uvVersion: resolvedUvVersion } : {}),
				...(uvToolchainTarget ? { uvToolchainTarget } : {}),
				...(resolvedPexVersion ? { pexVersion: resolvedPexVersion } : {}),
				...(pexToolchainTarget ? { pexToolchainTarget } : {}),
				...(extraPexArgs.length ? { extraPexArgs } : {}),
				...(allDeps.length
					? { deps: allDeps.map((dep) => dep.target || dep) }
					: {}),
			},
			sources: sourcesField({
				root: resolvePath ?? projectSrc,
				include: PYTHON_PROJECT_SOURCE_INCLUDES,
			}),
			deps: allDeps,
		});
	}
}

export const python_app_build = product(
	PythonApp,
	BUILD,
	UV_TOOL,
	async function python_app_build(handle) {
		const srcPath =
			handle.attrs.resolve?.attrs?.path ??
			declared_path(handle, handle.attrs.src || ".");
		const inputFiles = await sources(handle);
		// attrs.uvVersion/pexVersion hold the *resolved version string* fixed at
		// construction time (see PythonApp's constructor) — never re-resolved
		// against defaultUvToolchain()/defaultPexToolchain() here, so the
		// toolchain a build uses can't drift from what was in effect when the
		// target was declared (same pattern as CmakeLib's attrs.toolchain in
		// rules/c/cmake/index.js).
		const uvToolSpec = await uvTool(handle.attrs.uvVersion);
		const pexToolSpec = await pexTool(handle.attrs.pexVersion);
		const uvCacheToolSpec = uvCacheDirTool();
		const pexRootToolSpec = pexRootTool();
		const syncArgs = pythonResolveSyncArgs(handle.attrs.resolve)
			.map(shellArg)
			.join(" ");

		const venvPath = `${srcPath}/.venv`;
		const pexOutPath = `${srcPath}/.imp-out/app.pex`;

		// `uv sync` and `pex build` run as a *single* sandboxed step, not two
		// separate cacheable run()s — a uv-created venv bakes absolute,
		// sandbox-root-prefixed paths into itself in more places than just its
		// bin/python symlink (pyvenv.cfg's `home` line, and — since our project
		// is installed into its own venv as an editable self-dependency —
		// installed-package metadata like direct_url.json all encode the
		// sandbox root too). Each of those would need its own CMake-ctest-style
		// old-root/new-root rewrite to survive being produced in one sandbox and
		// consumed in another; simpler and more robust to just never cross that
		// boundary; the venv exists only within this one run()'s sandbox, never
		// materialized as its own build output. This does mean an unchanged
		// uv.lock can't skip re-running `uv sync` when only source files
		// change — an accepted cost for correctness here.
		//
		// `uv sync --locked` fails rather than silently re-resolving if uv.lock
		// is stale relative to pyproject.toml: a build must never mutate the
		// lock as a side effect. pex then packs directly from the synced venv
		// via --venv-repository (--no-transitive: no resolution of its own, no
		// lossy requirements.txt bridge, no network access needed for it) using
		// the venv's own interpreter — no ambient nativeTool("python3")
		// dependency needed.
		const pexArgs = [
			`--venv-repository=${venvPath}`,
			"--no-transitive",
			"--pre",
			"-o",
			pexOutPath,
			...(handle.attrs.entryPoint ? ["-e", handle.attrs.entryPoint] : []),
			"-D",
			srcPath,
			...(handle.attrs.extraPexArgs || []),
		];
		const envExports = sandboxRootEnvExports([
			...uvCacheDirEnv(),
			...pexRootEnv(),
		]);
		const script =
			`src=$1; venv=$2; python=$3; pex=$4; shift 4; ` +
			`imp_sandbox_root="$(pwd)" && ${envExports.join(" && ")} && ` +
			`uv sync --project "$src" --locked --no-progress${syncArgs ? ` ${syncArgs}` : ""} && ` +
			'"$venv/bin/python" "$pex" "$@"';

		const result = await run({
			argv: [
				"sh",
				"-c",
				script,
				"python-app-build",
				srcPath,
				venvPath,
				`${venvPath}/bin/python`,
				".imp/tools/pex/pex",
				...pexArgs,
			],
			tools: [uvToolSpec, pexToolSpec, uvCacheToolSpec, pexRootToolSpec],
			inputs: [inputFiles],
			outputs: [output(output_path(pexOutPath))],
			materialize: false,
			display: `python-app build ${srcPath}`,
		});
		return { ...result, pexOutPath };
	},
	{ display: "build {0}", level: "info" },
);

export const python_app_package = product(
	PythonApp,
	PACKAGE,
	PEX_TOOL,
	async function python_app_package(handle) {
		const result = await python_app_build(handle);
		const pexOutDir = result.pexOutPath.slice(
			0,
			result.pexOutPath.lastIndexOf("/"),
		);
		return artifact(result.outputDigest, { from: pexOutDir });
	},
	{ display: "package {0}", level: "info" },
);

// ---------------------------------------------------------------------------
// Target constructor
// ---------------------------------------------------------------------------

/**
 * Declare a Python application packaged as a PEX file.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.src="."] Workspace-relative Python project directory.
 * @param {string} [opts.entryPoint] PEX entry point.
 * @param {object|string} [opts.uvVersion] uv toolchain target handle or version string.
 * @param {object|string} [opts.pexVersion] PEX toolchain target handle or version string.
 * @param {string[]} [opts.extraPexArgs=[]] Extra arguments appended to PEX.
 * @param {object} [opts.resolve] Locked Python resolve supplying the project path; exclusive with `src`.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Target handle.
 */
export function pythonApp({
	src,
	entryPoint,
	uvVersion,
	pexVersion,
	extraPexArgs,
	resolve,
	deps,
}) {
	return new PythonApp({
		src,
		entryPoint,
		uvVersion,
		pexVersion,
		extraPexArgs,
		resolve,
		deps,
	});
}
