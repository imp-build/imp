import {
	Toolchain,
	namedCache,
	platformInfo,
	cachePut,
	cacheGet,
	toolName,
	tool as graphTool,
} from "imp:core";

import {
	downloadToolArtifact,
	lockfileAddressToPath,
	lockfileFor,
} from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";
import { toolchainBin } from "//rules/imp/toolchain";
import {
	graphGenerateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering pnpm-driven products.
export const PNPM_TOOL = toolName("pnpm");

const PNPM_TOOLCHAIN_CACHE = "pnpm-toolchains";
const DEFAULT_LOCKFILE = "//rules/js/pnpm/pnpm-toolchain.lock";

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

export class PnpmToolchain extends Toolchain {
	static kind = "pnpm-toolchain";
	static tool = PNPM_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: PnpmToolchain.kind,
				attrs: { version, lockfile, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return pnpmBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetPnpmToolchainStateForTest() {
	PnpmToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? pnpmGraphTool(version);
}

/**
 * Declare a pnpm toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {string} [opts.lockfile] Address of a workspace-owned lockfile
 *   to use instead of the shipped one.
 * @returns {object} Target handle for this pnpm toolchain.
 * @category configuration
 */
export function pnpmToolchain(version, opts = {}) {
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	namedCache({ name: PNPM_STORE_CACHE });
	new PnpmToolchain(
		{ version, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = pnpmGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/**
 * The `[GEN_LOCKFILES]` root for a pnpm toolchain version.
 *
 * This is a separate function from pnpmToolchain(). pnpmToolchain() returns a
 * frozen tool() handle. A frozen object cannot hold an extra
 * property.
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {string} [opts.lockfile] Address override for the generated lockfile.
 * @returns {object} `{ [GEN_LOCKFILES]: ... }`.
 */
export function pnpmGenLockfiles(version, opts = {}) {
	const resolved = PnpmToolchain.requireVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
			lockfile:
				opts.lockfile ?? lockfileFor(PnpmToolchain, resolved, DEFAULT_LOCKFILE),
		}),
	};
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
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: PNPM_TOOLCHAIN_CACHE,
		key: pnpmCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "pnpm.exe" : "pnpm",
	});
}

/** Return the CAS-backed graph tool used by graph-native JS rules. */
export function pnpmGraphTool(version) {
	const resolved = PnpmToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = pnpmCacheKey(resolved, plat);
	namedCache({ name: PNPM_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(PnpmToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "pnpm-toolchain",
		version: resolved,
		plat,
		url: pnpmDownloadUrl(resolved, plat),
		output: `.imp/pnpm-downloads/${key}/${pnpmArtifactName(resolved, plat)}`,
		display: `download pnpm ${resolved} (${plat.os}/${plat.arch})`,
		unverified: PnpmToolchain.resolveUnverified(resolved),
	});
	// pnpm's release archives are flat — a `pnpm` executable (plus its bundled
	// dist/ payload) sit at the archive root already, unlike node/uv/ruff's
	// single top-level `<name>-<triple>/` wrapper — so no stripComponents.
	const directory = extractArchive({
		archive,
		dest: `.imp/pnpm-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "tar.gz",
		namedCache: { name: PNPM_TOOLCHAIN_CACHE, key },
		display: `extract pnpm ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, {
		binDirs: ["."],
		mount: { name: "pnpm", cache: PNPM_TOOLCHAIN_CACHE, key },
	});
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
	const version = PnpmToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another pnpmToolchain(..., { default: true }).
pnpmToolchain("12.4.1", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "pnpm-toolchain",
		platforms: pnpmSupportedPlatforms(),
		downloadUrl: pnpmDownloadUrl,
		artifactName: pnpmArtifactName,
		lockfile: DEFAULT_LOCKFILE,
	},
	[
		"11.13.0",
		"11.14.0",
		"11.15.1",
		"11.16.0",
		"11.17.0",
		"11.18.0",
		"11.19.0",
		"11.20.0",
		"11.21.0",
		"11.22.0",
		"11.23.0",
		"11.24.0",
		"11.25.0",
		"11.26.0",
		"11.27.0",
		"12.0.0",
		"12.1.0",
		"12.2.1",
		"12.3.4",
		"12.4.1",
	],
);
