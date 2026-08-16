import {
	Toolchain,
	product,
	namedCache,
	platformInfo,
	toolName,
	tool as graphTool,
} from "imp:core";

import { downloadToolArtifact } from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";
import { toolchainBin, toolchainToolSpec } from "//rules/imp/toolchain";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering odin-driven products.
export const ODIN_TOOL = toolName("odin");

const ODIN_TOOLCHAIN_CACHE = "odin-toolchains";

const osMap = { linux: "linux", macos: "macos", windows: "windows" };
const archMap = { x86_64: "amd64", aarch64: "arm64" };

function requireSupportedPlatform(plat) {
	if (!osMap[plat.os]) {
		throw new Error(`unsupported Odin toolchain OS: ${plat.os}`);
	}
	if (!archMap[plat.arch]) {
		throw new Error(`unsupported Odin toolchain architecture: ${plat.arch}`);
	}
}

/**
 * Return the named-cache key for an Odin toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinCacheKey(version, plat) {
	requireSupportedPlatform(plat);
	return `${version}/${plat.os}-${plat.arch}`;
}

/**
 * Return the Odin release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinArtifactName(version, plat) {
	requireSupportedPlatform(plat);
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `odin-${osMap[plat.os]}-${archMap[plat.arch]}-${version}.${ext}`;
}

/**
 * Return the Odin release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinDownloadUrl(version, plat) {
	return `https://github.com/odin-lang/Odin/releases/download/${version}/${odinArtifactName(version, plat)}`;
}

// The platforms Odin publishes a release archive for. osMap × archMap would also
// admit windows/aarch64, which Odin does not ship — so the lockfile matrix is
// curated to what actually exists on the releases page.
const ODIN_SUPPORTED_PLATFORMS = [
	{ os: "linux", arch: "x86_64" },
	{ os: "linux", arch: "aarch64" },
	{ os: "macos", arch: "x86_64" },
	{ os: "macos", arch: "aarch64" },
	{ os: "windows", arch: "x86_64" },
];

/**
 * Return the platforms Odin publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function odinSupportedPlatforms() {
	return ODIN_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

export class OdinToolchain extends Toolchain {
	static kind = "odin-toolchain";
	static tool = ODIN_TOOL;
	constructor({ version, linker, unverified }, opts) {
		super(
			{
				kind: OdinToolchain.kind,
				attrs: {
					version,
					...(linker ? { linker } : {}),
					...(unverified ? { unverified } : {}),
				},
			},
			opts,
		);
	}

	bin() {
		return odinBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
// odinPackage/odinTestPackage also accept a bare version string with no
// toolchain target at all, so a lookup can still miss.
let graphToolchains = new Map();

function graphToolFor(version) {
	return graphToolchains.get(version) ?? odinGraphTool(version);
}

export function __resetOdinToolchainStateForTest() {
	OdinToolchain.clearDefault();
	graphToolchains = new Map();
}

/**
 * Declare an Odin toolchain version and optionally set it as the default.
 *
 * @category configuration
 * @param {string} version Odin release version (matches .odin-version).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default toolchain.
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {object} [opts.linker] Linker toolchain handle (e.g. moldToolchain())
 *   registering an "odin-linker" product. If omitted, Odin links with
 *   whatever `ld` the gcc toolchain's clang wrapper selects by default.
 * @returns {object} Target handle for this Odin toolchain.
 */
export function odinToolchain(version, opts = {}) {
	new OdinToolchain(
		{ version, linker: opts.linker, unverified: opts.unverified },
		{ default: opts.default },
	);
	const tool = odinGraphTool(version);
	graphToolchains.set(version, tool);
	return tool;
}

/** Build a verified Odin compiler as an ordinary graph tool. */
export function odinGraphTool(version) {
	const resolved = resolveOdinToolchainVersion(version);
	const plat = platformInfo();
	namedCache({ name: ODIN_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: "//rules/odin/odin.lock",
		tool: "odin",
		version: resolved,
		plat,
		url: odinDownloadUrl(resolved, plat),
		output: `odin-downloads/${odinCacheKey(resolved, plat)}/${odinArtifactName(resolved, plat)}`,
		display: `download odin ${resolved} (${plat.os}/${plat.arch})`,
		unverified: OdinToolchain.resolveUnverified(resolved),
	});
	// Odin's release archive wraps its contents in a single top-level
	// directory (e.g. "odin-linux-amd64-dev-2026-03/"), so strip it.
	const directory = extractArchive({
		archive,
		dest: "odin-toolchain",
		format: plat.os === "windows" ? "zip" : "tar.gz",
		stripComponents: 1,
		namedCache: {
			name: ODIN_TOOLCHAIN_CACHE,
			key: odinCacheKey(resolved, plat),
		},
		display: `install odin ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Resolve an explicit or default Odin toolchain version.
 *
 * @param {string} [version]
 * @returns {string}
 */
export function resolveOdinToolchainVersion(version) {
	const resolved = OdinToolchain.resolveVersion(version);
	if (!resolved) {
		throw new Error("no Odin toolchain version specified and no default set");
	}
	return resolved;
}

/**
 * Return the path to the Odin binary for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function odinBin(version) {
	const resolved = resolveOdinToolchainVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: ODIN_TOOLCHAIN_CACHE,
		key: odinCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "odin.exe" : "odin",
	});
}

/**
 * Return a named-cache-backed Odin tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function odinTool(version) {
	const resolved = resolveOdinToolchainVersion(version);
	const plat = platformInfo();
	return toolchainToolSpec(graphToolFor(resolved), {
		toolName: "odin",
		name: ODIN_TOOLCHAIN_CACHE,
		key: odinCacheKey(resolved, plat),
		binDirs: ["."],
	});
}

/**
 * Return the currently configured default Odin toolchain version.
 *
 * @returns {string|null}
 */
export function defaultOdinToolchainVersion() {
	return OdinToolchain.defaultVersion();
}

/**
 * Return the currently configured default Odin toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultOdinToolchain() {
	const version = OdinToolchain.defaultVersion();
	return version ? graphToolFor(version) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another odinToolchain(..., { default: true }).
odinToolchain("dev-2026-03", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "odin",
		platforms: odinSupportedPlatforms(),
		downloadUrl: odinDownloadUrl,
		artifactName: odinArtifactName,
		lockfile: "//rules/odin/odin.lock",
	},
	["dev-2026-03"],
);
product(
	OdinToolchain,
	GEN_LOCKFILES,
	ODIN_TOOL,
	function generateOdinLockfiles(handle) {
		return generateToolLockfile({ handle, ...LOCKFILE_SPEC });
	},
	{ display: "gen lockfiles {0}", level: "info" },
);
