import {
	Toolchain,
	product,
	namedCache,
	run,
	output,
	output_path,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering pnpm-driven products.
export const PNPM_TOOL = toolName("pnpm");

const PNPM_TOOLCHAIN_CACHE = "pnpm-toolchains";
const PNPM_LOCKFILE = "//rules/js/pnpm-toolchain.lock";

// pnpm's own content-addressed package store — internally addressed by
// package identity, never by sandbox identity, so sharing one directory
// across every sandbox and pnpm version is safe (same reasoning as
// UV_CACHE_DIR_CACHE in rules/python/uv_toolchain.js). Left unpinned, pnpm
// would default the store under the sandbox's fresh-every-run HOME, paying
// a full re-download on every build. Fixed "shared" key: content is
// addressed by what pnpm is storing, not by which pnpm version reads it.
const PNPM_STORE_CACHE = "pnpm-store";
const PNPM_STORE_KEY = "shared";

// pnpm's standalone-binary release assets (github.com/pnpm/pnpm/releases),
// verified against the v11.13.0 release manifest. Notably narrower than
// every other toolchain's platform matrix in this repo: pnpm dropped Intel
// macOS (darwin-x64) standalone builds as of the v11 rewrite — only
// darwin-arm64 is published — while gaining a windows-arm64 build older
// releases didn't have. There is no workaround artifact for darwin-x64
// (older pnpm majors published one, under a different naming scheme
// entirely — "pnpm-macos-x64" with no extension — but pinning an old major
// just to cover that one platform isn't worth the divergence). If Intel
// macOS support becomes a real requirement, pnpm can still run there via a
// plain `npm install -g pnpm` against a node toolchain instead of this
// standalone-binary path.
const PNPM_PLATFORM_TOKENS = {
	"linux-x86_64": { os: "linux", arch: "x64" },
	"linux-aarch64": { os: "linux", arch: "arm64" },
	"macos-aarch64": { os: "darwin", arch: "arm64" },
	"windows-x86_64": { os: "win32", arch: "x64" },
	"windows-aarch64": { os: "win32", arch: "arm64" },
};

function pnpmPlatformTokens(plat) {
	const tokens = PNPM_PLATFORM_TOKENS[`${plat.os}-${plat.arch}`];
	if (!tokens) {
		throw new Error(
			`unsupported pnpm toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return tokens;
}

/**
 * Return the pnpm release archive filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function pnpmArtifactName(version, plat) {
	const { os, arch } = pnpmPlatformTokens(plat);
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `pnpm-${os}-${arch}.${ext}`;
}

/**
 * Return the pnpm release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function pnpmDownloadUrl(version, plat) {
	return `https://github.com/pnpm/pnpm/releases/download/v${version}/${pnpmArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a pnpm toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function pnpmCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

// The platforms this module acquires pnpm for and publishes lockfile
// entries for (see PNPM_PLATFORM_TOKENS).
export function pnpmSupportedPlatforms() {
	return Object.keys(PNPM_PLATFORM_TOKENS).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
}

// Bare coreutils the download/extract scripts need — same reasoning as
// coreToolNames in uv_toolchain.js/node_toolchain.js: the sandbox is fully
// hermetic, so even these must be declared tools, not resolved from an
// ambient PATH.
function coreToolNames(plat) {
	const extract = plat.os === "windows" ? ["tar"] : ["tar", "gzip"];
	return [...new Set([...lockedDownloadTools(plat), ...extract])];
}

export class PnpmToolchain extends Toolchain {
	static kind = "pnpm-toolchain";
	static tool = PNPM_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: PnpmToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return pnpmBin(this.attrs.version);
	}
}

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquirePnpmToolchain().
let coreToolHandles = null;

export function __resetPnpmToolchainStateForTest() {
	PnpmToolchain.clearDefault();
	coreToolHandles = null;
}

/**
 * Declare a pnpm toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this pnpm toolchain.
 * @category configuration
 */
export function pnpmToolchain(version, opts = {}) {
	namedCache({ name: PNPM_TOOLCHAIN_CACHE, shared: true });
	namedCache({ name: PNPM_STORE_CACHE });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new PnpmToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
}

/**
 * Install a local pnpm toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the directory containing the `pnpm` binary.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installPnpmToolchain(version, source) {
	namedCache({ name: PNPM_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = pnpmCacheKey(version, plat);
	cachePut(PNPM_TOOLCHAIN_CACHE, key, source);
	return cacheGet(PNPM_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a pnpm toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquirePnpmToolchain(version) {
	const plat = platformInfo();
	const key = pnpmCacheKey(version, plat);

	if (!coreToolHandles) {
		throw new Error(
			"no pnpm toolchain declared via pnpmToolchain(); nothing to acquire",
		);
	}
	const coreTools = await Promise.all(
		coreToolHandles.map((handle) => nativeToolSpec(handle)),
	);

	if (!cacheHas(PNPM_TOOLCHAIN_CACHE, key)) {
		const downloadPath = `.imp/pnpm-downloads/${key}/${pnpmArtifactName(version, plat)}`;
		await downloadToolArtifact({
			lockfile: PNPM_LOCKFILE,
			tool: "pnpm-toolchain",
			version,
			plat,
			url: pnpmDownloadUrl(version, plat),
			downloadPath,
			tools: coreTools,
			display: `download pnpm ${version} (${plat.os}/${plat.arch})`,
			unverified: PnpmToolchain.resolveUnverified(version),
		});

		// pnpm's release archives are flat — a `pnpm` executable (plus its
		// bundled dist/ payload) sit at the archive root already, unlike
		// node/uv/ruff's single top-level `<name>-<triple>/` wrapper — so no
		// stripComponents here.
		await extractArchive({
			archive: downloadPath,
			dest: `.imp/pnpm-toolchains/${key}`,
			format: plat.os === "windows" ? "zip" : "tar.gz",
			tools: coreTools,
			namedCache: { name: PNPM_TOOLCHAIN_CACHE, key },
			display: `extract pnpm ${version} (${plat.os}/${plat.arch})`,
		});
	}

	// A named-cache "tool" mount (see pnpmStoreDirTool) requires its cache
	// path to already exist as a real directory — materialize_tools_into_
	// sandbox in src/exec.rs bails otherwise — so seed it with an empty
	// directory here, guarded independently of the toolchain cacheHas()
	// above since this cache is keyed "shared", not per-version (same
	// independent-guard pattern as UV_CACHE_DIR_CACHE's seeding in
	// rules/python/uv_toolchain.js).
	if (!cacheHas(PNPM_STORE_CACHE, PNPM_STORE_KEY)) {
		const seedPath = ".imp/pnpm-store-seed";
		await run({
			argv: ["sh", "-c", 'mkdir -p "$1"', "seed-pnpm-store", seedPath],
			tools: coreTools,
			outputs: [
				output(output_path(seedPath), {
					kind: "directory",
					namedCache: { name: PNPM_STORE_CACHE, key: PNPM_STORE_KEY },
				}),
			],
			materialize: true,
			display: "seed pnpm store",
		});
	}

	return cacheGet(PNPM_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default pnpm toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolvePnpmToolchainVersion(version) {
	return PnpmToolchain.resolveVersion(version);
}

/**
 * Return the pnpm executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function pnpmBin(version) {
	const resolved = PnpmToolchain.requireVersion(version);
	const dir = await acquirePnpmToolchain(resolved);
	const exe = platformInfo().os === "windows" ? "pnpm.exe" : "pnpm";
	return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed pnpm tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function pnpmTool(version) {
	const resolved = PnpmToolchain.requireVersion(version);
	await acquirePnpmToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "pnpm",
		cache: PNPM_TOOLCHAIN_CACHE,
		key: pnpmCacheKey(resolved, plat),
		binDirs: ["."],
	};
}

/**
 * Return a named-cache-backed tool descriptor mounting pnpm's shared
 * content-addressed store at a stable path, read-write across every
 * sandbox. Not put on PATH (binDirs empty) — pair with pnpmStoreDirEnv() to
 * point pnpm's store-dir config at its mount path.
 *
 * @returns {object}
 */
export function pnpmStoreDirTool() {
	return {
		kind: "tool",
		name: PNPM_STORE_CACHE,
		cache: PNPM_STORE_CACHE,
		key: PNPM_STORE_KEY,
		binDirs: [],
	};
}

/**
 * Return the `run()` env entries pointing pnpm at its shared store tool
 * mount (see pnpmStoreDirTool). Any run() using this must also include that
 * tool, or the path won't exist in the sandbox. pnpm has no dedicated
 * PNPM_STORE_DIR variable — like every npm-config-derived tool, its
 * `store-dir` setting is overridden via the `npm_config_<key>` environment
 * convention. Values are relative to the sandbox root — callers must export
 * them as absolute paths (capturing `$(pwd)` before any `cd`) rather than
 * passing them via run()'s own `env:`, exactly as uvCacheDirEnv()'s doc
 * comment in rules/python/uv_toolchain.js explains for UV_CACHE_DIR.
 *
 * @returns {string[]}
 */
export function pnpmStoreDirEnv() {
	return [`npm_config_store_dir=.imp/tools/${PNPM_STORE_CACHE}`];
}

/**
 * Return the currently configured default pnpm toolchain version.
 *
 * @returns {string|null}
 */
export function defaultPnpmToolchainVersion() {
	return PnpmToolchain.defaultVersion();
}

/**
 * Return the currently configured default pnpm toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultPnpmToolchain() {
	return PnpmToolchain.default();
}

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "pnpm-toolchain",
		platforms: pnpmSupportedPlatforms(),
		downloadUrl: pnpmDownloadUrl,
		artifactName: pnpmArtifactName,
		lockfile: PNPM_LOCKFILE,
	},
	["11.13.0"],
);
product(PnpmToolchain, GEN_LOCKFILES, PNPM_TOOL, (handle) =>
	generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
);
