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
import { toolchainBin, toolchainToolSpec } from "//rules/imp/toolchain";
import {
	graphGenerateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for provider products this toolchain implements.
export const ZOLA_TOOL = toolName("zola");

const ZOLA_TOOLCHAIN_CACHE = "zola-toolchains";
const DEFAULT_LOCKFILE = "//rules/zola/zola.lock";

// Zola publishes prebuilt binaries for these targets; see
// https://github.com/getzola/zola/releases.
const TARGET_TRIPLES = {
	"linux-x86_64": "x86_64-unknown-linux-gnu",
	"linux-aarch64": "aarch64-unknown-linux-gnu",
	"macos-x86_64": "x86_64-apple-darwin",
	"macos-aarch64": "aarch64-apple-darwin",
	"windows-x86_64": "x86_64-pc-windows-msvc",
};

function targetTriple(plat) {
	const triple = TARGET_TRIPLES[`${plat.os}-${plat.arch}`];
	if (!triple) {
		throw new Error(
			`unsupported zola toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return triple;
}

/**
 * Return the zola release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaArtifactName(version, plat) {
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `zola-v${version}-${targetTriple(plat)}.${ext}`;
}

/**
 * Return the zola release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaDownloadUrl(version, plat) {
	return `https://github.com/getzola/zola/releases/download/v${version}/${zolaArtifactName(version, plat)}`;
}

/**
 * Return the platforms zola publishes release archives for, derived from the
 * module's TARGET_TRIPLES map (keyed "os-arch").
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function zolaSupportedPlatforms() {
	return Object.keys(TARGET_TRIPLES).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
}

/**
 * Return the named-cache key for a zola toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zolaCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

export class ZolaToolchain extends Toolchain {
	static kind = "zola-toolchain";
	static tool = ZOLA_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: ZolaToolchain.kind,
				attrs: { version, lockfile, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return zolaBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetZolaToolchainStateForTest() {
	ZolaToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? zolaGraphTool(version);
}

/**
 * Declare a zola toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {string} [opts.lockfile] Address of a workspace-owned lockfile
 *   to use instead of the shipped one.
 * @returns {object} Target handle for this zola toolchain.
 * @category configuration
 */
export function zolaToolchain(version, opts = {}) {
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	const toolchain = new ZolaToolchain(
		{ version, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	toolchain[GEN_LOCKFILES] = graphGenerateToolLockfile({
		version,
		...LOCKFILE_SPEC,
		lockfile,
	});
	graphToolchains.set(version, zolaGraphTool(version));
	return toolchain;
}

/**
 * Install a local zola toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZolaToolchain(version, source) {
	namedCache({ name: ZOLA_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = zolaCacheKey(version, plat);
	cachePut(ZOLA_TOOLCHAIN_CACHE, key, source);
	return cacheGet(ZOLA_TOOLCHAIN_CACHE, key);
}

/** Build zola from its verified release archive as a graph tool. */
export function zolaGraphTool(version) {
	const resolved = ZolaToolchain.requireVersion(version);
	const plat = platformInfo();
	namedCache({ name: ZOLA_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(ZolaToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "zola",
		version: resolved,
		plat,
		url: zolaDownloadUrl(resolved, plat),
		output: `zola-downloads/${zolaCacheKey(resolved, plat)}/${zolaArtifactName(resolved, plat)}`,
		display: `download zola ${resolved} (${plat.os}/${plat.arch})`,
		unverified: ZolaToolchain.resolveUnverified(resolved),
	});
	// Zola's release archive ships the `zola` binary at the archive root (no
	// wrapping directory), so no --strip-components is needed.
	const directory = extractArchive({
		archive,
		dest: "zola-toolchain",
		format: plat.os === "windows" ? "zip" : "tar.gz",
		namedCache: {
			name: ZOLA_TOOLCHAIN_CACHE,
			key: zolaCacheKey(resolved, plat),
		},
		display: `install zola ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Resolve an explicit or default zola toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZolaToolchainVersion(version) {
	return ZolaToolchain.resolveVersion(version);
}

/**
 * Return the zola executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function zolaBin(version) {
	const resolved = ZolaToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: ZOLA_TOOLCHAIN_CACHE,
		key: zolaCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "zola.exe" : "zola",
	});
}

/**
 * Return a named-cache-backed zola tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function zolaTool(version) {
	const resolved = ZolaToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainToolSpec(graphToolFor(resolved), {
		toolName: "zola",
		name: ZOLA_TOOLCHAIN_CACHE,
		key: zolaCacheKey(resolved, plat),
		binDirs: ["."],
	});
}

/**
 * Return the currently configured default zola toolchain version.
 *
 * @returns {string|null}
 */
export function defaultZolaToolchainVersion() {
	return ZolaToolchain.defaultVersion();
}

/**
 * Return the currently configured default zola toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultZolaToolchain() {
	return ZolaToolchain.default();
}

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "zola",
		platforms: zolaSupportedPlatforms(),
		downloadUrl: zolaDownloadUrl,
		artifactName: zolaArtifactName,
		lockfile: DEFAULT_LOCKFILE,
	},
	["0.22.1", "0.23.6"],
);

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another zolaToolchain(..., { default: true }).
zolaToolchain("0.23.6", { default: true });
