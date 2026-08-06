import {
	Toolchain,
	product,
	namedCache,
	memo,
	run,
	output,
	output_path,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
	group,
	tool as graphTool,
	task,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering pex-driven products.
export const PEX_TOOL = toolName("pex");

const PEX_TOOLCHAIN_CACHE = "pex-toolchains";
const PEX_LOCKFILE = "//rules/python/pex-toolchain.lock";
// pex publishes one platform-independent artifact; its lock entries are
// keyed under this pseudo-platform (see LOCKFILE_SPEC.platforms below).
const PEX_LOCK_PLATFORM = { os: "any", arch: "any" };

// PEX's own PEX_ROOT (default ~/.pex): installed_wheels + venvs caches that
// back its "exact subset, no global venv" symlink/hardlink-from-cache
// behavior (see docs/notes in the plan this module implements). Must be a
// real, persistent, shared directory across sandboxes for that caching to
// ever pay off — left unpinned, every sandboxed pex invocation gets a fresh
// empty PEX_ROOT and re-extracts every wheel every time, the same failure
// mode ZIG_BUILD_CACHE's doc comment (rules/c/zig/index.js) describes
// for ZIG_GLOBAL_CACHE_DIR. Fixed "shared" key: PEX_ROOT's content is
// addressed by what it's caching (wheel hashes, venv fingerprints), not by
// which pex version is reading it.
const PEX_ROOT_CACHE = "pex-root";
const PEX_ROOT_KEY = "shared";

// PEX ships as a single pure-Python zipapp asset per version — unlike uv/zig,
// there are no per-OS/arch release variants, so the toolchain cache is keyed
// by version alone (a deliberate divergence from the sibling toolchains'
// "${version}/${os}-${arch}" key shape).
export function pexCacheKey(version) {
	return version;
}

/**
 * Return the pex zipapp download URL for a version.
 *
 * @param {string} version
 * @returns {string}
 */
export function pexDownloadUrl(version) {
	return `https://github.com/pantsbuild/pex/releases/download/v${version}/pex`;
}

// Bare coreutils the verified-download and install scripts need — even
// these must be declared tools, not resolved from an ambient PATH, since
// the sandbox is fully hermetic. No tar/extraction step (pex is a single
// file, not an archive).
function coreToolNames(plat) {
	const extra = plat.os === "windows" ? ["cp"] : ["cp", "chmod"];
	return [...new Set([...lockedDownloadTools(plat), ...extra])];
}

export class PexToolchain extends Toolchain {
	static kind = "pex-toolchain";
	static tool = PEX_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: PexToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return pexBin(this.attrs.version);
	}
}

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquirePexToolchain().
let coreToolHandles = null;
let graphToolchains = new Map();

export function __resetPexToolchainStateForTest() {
	PexToolchain.clearDefault();
	coreToolHandles = null;
	graphToolchains = new Map();
}

/**
 * Declare a pex toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this pex toolchain.
 * @category configuration
 */
export function pexToolchain(version, opts = {}) {
	namedCache({ name: PEX_TOOLCHAIN_CACHE, shared: true });
	namedCache({ name: PEX_ROOT_CACHE });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	new PexToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = pexGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/** Return the CAS-backed graph PEX tool. */
export function pexGraphTool(version) {
	const resolved = PexToolchain.requireVersion(version);
	const plat = platformInfo();
	const archive = downloadToolArtifact({
		lockfile: PEX_LOCKFILE,
		tool: "pex-toolchain",
		version: resolved,
		plat,
		lockPlat: PEX_LOCK_PLATFORM,
		url: pexDownloadUrl(resolved),
		output: `.imp/pex-downloads/${pexCacheKey(resolved)}/pex`,
		display: `download pex ${resolved}`,
		unverified: PexToolchain.resolveUnverified(resolved),
	});
	const shell = nativeTool("sh");
	const cp = nativeTool("cp");
	const mkdir = nativeTool("mkdir");
	const chmod = plat.os === "windows" ? null : nativeTool("chmod");
	const install = task({
		display: `install pex ${resolved}`,
		inputs: { archive, shell, cp, mkdir, ...(chmod ? { chmod } : {}) },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					plat.os === "windows"
						? 'mkdir -p "$2" && cp "$1" "$2/pex"'
						: 'mkdir -p "$2" && cp "$1" "$2/pex" && chmod +x "$2/pex"',
					"install-pex",
					exec.path(inputs.archive),
					"toolchain",
				],
				tools: [
					inputs.shell,
					inputs.cp,
					inputs.mkdir,
					...(inputs.chmod ? [inputs.chmod] : []),
				],
				outputs: { directory: output.directory("toolchain") },
			});
			return { directory: result.outputs.directory };
		},
	});
	return graphTool(install.outputs.directory, { binDirs: ["."] });
}

/**
 * Install a local pex zipapp into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the pex zipapp file.
 * @returns {string|null} Local path to the cached zipapp.
 */
export function installPexToolchain(version, source) {
	namedCache({ name: PEX_TOOLCHAIN_CACHE, shared: true });
	const key = pexCacheKey(version);
	cachePut(PEX_TOOLCHAIN_CACHE, key, source);
	return cacheGet(PEX_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a pex toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain directory (containing `pex`).
 */
export const acquirePexToolchain = memo(
	async function acquirePexToolchain(version) {
		const plat = platformInfo();
		const key = pexCacheKey(version);

		if (!coreToolHandles) {
			throw new Error(
				"no pex toolchain declared via pexToolchain(); nothing to acquire",
			);
		}
		const coreTools = await group(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		if (!cacheHas(PEX_TOOLCHAIN_CACHE, key)) {
			// No archive to extract — the verified download lands the single
			// `pex` file straight into the named-cache directory, then a small
			// install run marks it executable.
			const dir = `.imp/pex-toolchains/${key}`;
			const downloadPath = `.imp/pex-downloads/${key}/pex`;
			await downloadToolArtifact({
				lockfile: PEX_LOCKFILE,
				tool: "pex-toolchain",
				version,
				plat,
				lockPlat: PEX_LOCK_PLATFORM,
				url: pexDownloadUrl(version),
				downloadPath,
				tools: coreTools,
				display: `download pex ${version}`,
				unverified: PexToolchain.resolveUnverified(version),
			});

			const script =
				plat.os === "windows"
					? 'mkdir -p "$2" && cp "$1" "$2/pex"'
					: 'mkdir -p "$2" && cp "$1" "$2/pex" && chmod +x "$2/pex"';
			await run({
				argv: ["sh", "-c", script, "install-pex", downloadPath, dir],
				tools: coreTools,
				inputs: [{ kind: "file", path: downloadPath }],
				outputs: [
					output(output_path(dir), {
						kind: "directory",
						namedCache: { name: PEX_TOOLCHAIN_CACHE, key },
					}),
				],
				materialize: true,
				display: `install pex ${version}`,
			});
		}

		// A named-cache "tool" mount (see pexRootTool) requires its cache path
		// to already exist as a real directory — materialize_tools_into_sandbox
		// in src/exec.rs bails otherwise — so seed it with an empty directory
		// here, guarded independently of the toolchain cacheHas() above since
		// this cache is keyed "shared", not per-version (same independent-guard
		// pattern as ZIG_BUILD_CACHE's seeding in rules/c/zig/index.js).
		if (!cacheHas(PEX_ROOT_CACHE, PEX_ROOT_KEY)) {
			const seedPath = ".imp/pex-root-seed";
			await run({
				argv: ["sh", "-c", 'mkdir -p "$1"', "seed-pex-root", seedPath],
				tools: coreTools,
				outputs: [
					output(output_path(seedPath), {
						kind: "directory",
						namedCache: { name: PEX_ROOT_CACHE, key: PEX_ROOT_KEY },
					}),
				],
				materialize: true,
				display: "seed pex root",
			});
		}

		return cacheGet(PEX_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Pex Toolchain {0}", level: "info" },
);

/**
 * Resolve an explicit or default pex toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolvePexToolchainVersion(version) {
	return PexToolchain.resolveVersion(version);
}

/**
 * Return the pex zipapp path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function pexBin(version) {
	const resolved = PexToolchain.requireVersion(version);
	const dir = await acquirePexToolchain(resolved);
	return `${dir}/pex`;
}

/**
 * Return a named-cache-backed pex tool descriptor for sandbox execution.
 * The mounted "binary" is a pure-Python zipapp, not directly exec'able on
 * every platform — invoke it as `<python> <toolDir>/pex ...` using an
 * interpreter from a synced uv venv (see rules/python/index.js), not via
 * PATH-exec.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function pexTool(version) {
	const resolved = PexToolchain.requireVersion(version);
	await acquirePexToolchain(resolved);
	return {
		kind: "tool",
		name: "pex",
		cache: PEX_TOOLCHAIN_CACHE,
		key: pexCacheKey(resolved),
		binDirs: ["."],
	};
}

/**
 * Return a named-cache-backed tool descriptor mounting PEX's shared
 * PEX_ROOT cache at a stable path, read-write across every sandbox. Not put
 * on PATH (binDirs empty) — pair with pexRootEnv() to point $PEX_ROOT at its
 * mount path.
 *
 * @returns {object}
 */
export function pexRootTool() {
	return {
		kind: "tool",
		name: PEX_ROOT_CACHE,
		cache: PEX_ROOT_CACHE,
		key: PEX_ROOT_KEY,
		binDirs: [],
	};
}

/**
 * Return the `run()` env entries pointing pex at its shared PEX_ROOT tool
 * mount (see pexRootTool). Any run() using this must also include that
 * tool, or the path won't exist in the sandbox. Values are relative to the
 * sandbox root — callers must export them as absolute paths (capturing
 * `$(pwd)` before any `cd`) rather than passing them via run()'s own `env:`,
 * exactly as zigGlobalCacheEnv()'s doc comment in rules/c/zig/index.js
 * explains for ZIG_GLOBAL_CACHE_DIR.
 *
 * @returns {string[]}
 */
export function pexRootEnv() {
	return [`PEX_ROOT=.imp/tools/${PEX_ROOT_CACHE}`];
}

/**
 * Return the currently configured default pex toolchain version.
 *
 * @returns {string|null}
 */
export function defaultPexToolchainVersion() {
	return PexToolchain.defaultVersion();
}

/**
 * Return the currently configured default pex toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultPexToolchain() {
	const version = PexToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another pexToolchain(..., { default: true }).
pexToolchain("2.97.1", { default: true });

// pex has exactly one artifact for all platforms, so generateToolLockfile
// (which expects a per-platform downloadUrl/artifactName) is given a single
// degenerate platform entry; downloadUrl/artifactName below ignore their
// `plat` argument. This reuses generateToolLockfile unmodified rather than
// forking it for a single-artifact case.
const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "pex-toolchain",
		platforms: [{ os: "any", arch: "any" }],
		downloadUrl: (version) => pexDownloadUrl(version),
		artifactName: () => "pex",
		lockfile: PEX_LOCKFILE,
	},
	["2.97.1"],
);
product(
	PexToolchain,
	GEN_LOCKFILES,
	PEX_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
