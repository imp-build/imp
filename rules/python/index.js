import {
	artifact,
	build as attachBuild,
	extensible,
	glob,
	label,
	labelAddress,
	logInfo,
	memo,
	output,
	output_path,
	packageGoal as attachPackage,
	registerBuildRule,
	run,
	writeWorkspace,
} from "imp:core";
import { toolSpec } from "//rules/imp/native-tool";
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
// PEX packaging model. Import for its label registrations.
import "//rules/python/source";

export {
	pythonProject,
	pythonSources,
	pythonToolchain,
	defaultPythonProject,
	defaultPythonToolchain,
} from "//rules/python/source";

export { pythonResolve, pythonResolveSyncArgs } from "//rules/python/resolve";

// Registers the "build" goal's artifact summary callback for consumers that
// import Python build rules without importing the workflows layer explicitly.
import "//rules/workflows/build";

// Registers the "test" goal handler (pythonTest / pytest) for consumers that
// import Python build rules without importing //rules/python/test explicitly
// — same reasoning as the build workflow import above. Side-effect only;
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
// Path helpers (same pattern as rules/rust/index.js, rules/c/cmake/index.js)
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

export function pythonAppAddress(handle) {
	try {
		if (handle && handle.__imp_label) return labelAddress(handle);
		if (handle && handle.label && handle.label.__imp_label) {
			return labelAddress(handle.label);
		}
		return null;
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = pythonAppAddress(handle);
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
// Action-handle shim — lets code written against `handle.attrs.*` (fmt/lint,
// pythonTest) keep working against a label's `.data` unchanged.
// ---------------------------------------------------------------------------

function package_handle(appLabel) {
	if (!appLabel || appLabel.__imp_label !== true) return appLabel;
	return {
		__id: appLabel.__id,
		label: appLabel,
		attrs: appLabel.attrs,
	};
}

export const pythonAppActionHandle = package_handle;

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
		handle = package_handle(handle);
		const root =
			handle.attrs.resolve?.data?.path ??
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
		handle = package_handle(handle);
		const root =
			handle.attrs.resolve?.data?.path ??
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

export const python_app_build = memo(
	async function python_app_build(handle) {
		handle = package_handle(handle);
		const srcPath =
			handle.attrs.resolve?.data?.path ??
			declared_path(handle, handle.attrs.src || ".");
		const inputFiles = await sources(handle);
		// attrs.uvVersion/pexVersion hold the *resolved version string* fixed at
		// construction time (see pythonApp's factory), never re-resolved against
		// defaultUvToolchain()/defaultPexToolchain() here, so the toolchain a
		// build uses can't drift from what was in effect when the label was
		// declared (same pattern as CmakeLib's attrs.toolchain in
		// rules/c/cmake/index.js).
		const uvToolSpec = await uvTool(handle.attrs.uvVersion);
		const pexToolSpec = await pexTool(handle.attrs.pexVersion);
		const uvCacheToolSpec = uvCacheDirTool();
		const pexRootToolSpec = pexRootTool();
		const depToolSpecs = await Promise.all(
			(handle.attrs.deps || []).map(toolSpec),
		);
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
			tools: [
				uvToolSpec,
				pexToolSpec,
				uvCacheToolSpec,
				pexRootToolSpec,
				...depToolSpecs,
			],
			inputs: [inputFiles],
			outputs: [output(output_path(pexOutPath))],
			materialize: false,
			display: `python-app build ${srcPath}`,
		});
		return { ...result, pexOutPath };
	},
	{ display: "build {0}", level: "info" },
);

export const python_app_package = memo(
	async function python_app_package(handle) {
		handle = package_handle(handle);
		const result = await python_app_build(handle);
		const pexOutDir = result.pexOutPath.slice(
			0,
			result.pexOutPath.lastIndexOf("/"),
		);
		return artifact(result.outputDigest, { from: pexOutDir });
	},
	{ display: "package {0}", level: "info" },
);

async function publishPythonAppPackage(appLabel) {
	const artifactResult = await python_app_package(appLabel);
	if (artifactResult == null) return null;
	const address = labelAddress(appLabel);
	const withoutSlashes = address.replace(/^\/\//, "");
	const [dir, name] = withoutSlashes.split(":");
	const destination = dir ? `dist/${dir}/${name}` : `dist/${name}`;
	writeWorkspace(destination, artifactResult.digest, {
		from: artifactResult.from,
	});
	logInfo(`${address}#package -> ${destination}`);
	return artifactResult;
}

// ---------------------------------------------------------------------------
// Label factory
// ---------------------------------------------------------------------------

/**
 * Declare a Python application packaged as a PEX file.
 *
 * @category label
 * @param {object} opts
 * @param {string} [opts.src="."] Workspace-relative Python project directory.
 * @param {string} [opts.entryPoint] PEX entry point.
 * @param {object|string} [opts.uvVersion] uv toolchain target handle or version string.
 * @param {object|string} [opts.pexVersion] PEX toolchain target handle or version string.
 * @param {string[]} [opts.extraPexArgs=[]] Extra arguments appended to PEX.
 * @param {object} [opts.resolve] Locked Python resolve supplying the project path; exclusive with `src`.
 * @param {Array} [opts.deps=[]] Extra tool providers made available on PATH
 *   inside the build/package sandbox: nativeTool() specifications or legacy
 *   target providers whose kind registers a `TOOL` product.
 * @returns {object} Label handle.
 */
export const pythonApp = extensible(function pythonApp({
	src,
	entryPoint,
	uvVersion,
	pexVersion,
	extraPexArgs = [],
	resolve,
	deps = [],
} = {}) {
	if (resolve && resolve.__imp_label !== true) {
		throw new Error("pythonApp({ resolve }) expects a pythonResolve() label");
	}
	const resolvePath = resolve?.data?.path;
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

	const appLabel = label({
		data: {
			src: projectSrc,
			...(resolve ? { resolve } : {}),
			...(entryPoint ? { entryPoint } : {}),
			...(resolvedUvVersion ? { uvVersion: resolvedUvVersion } : {}),
			...(uvToolchainTarget ? { uvToolchainTarget } : {}),
			...(resolvedPexVersion ? { pexVersion: resolvedPexVersion } : {}),
			...(pexToolchainTarget ? { pexToolchainTarget } : {}),
			...(extraPexArgs.length ? { extraPexArgs } : {}),
			deps,
		},
	});

	attachBuild(appLabel, async function buildPythonApp() {
		return python_app_build(appLabel);
	});
	attachPackage(appLabel, async function packagePythonApp() {
		return publishPythonAppPackage(appLabel);
	});

	return appLabel;
});
