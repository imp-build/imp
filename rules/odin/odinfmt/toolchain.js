import {
	Toolchain,
	product,
	namedCache,
	memo,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
} from "imp:core";

import {
	odinSupportedPlatforms,
	resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import { extractArchive, extractArchiveTools } from "//rules/imp/archive";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering odinfmt-driven products.
export const ODINFMT_TOOL = toolName("odinfmt");

const ODINFMT_CACHE = "odinfmt-toolchains";
const ODINFMT_LOCKFILE = "//rules/odin/odinfmt/odinfmt.lock";

// odinfmt ships inside the OLS release zips, whose tags track Odin's monthly dev
// versions, so it is pinned to the same version as the Odin toolchain.
const olsTripleMap = {
	"linux/x86_64": "x86_64-unknown-linux-gnu",
	"linux/aarch64": "arm64-unknown-linux-gnu",
	"macos/x86_64": "x86_64-darwin",
	"macos/aarch64": "arm64-darwin",
	"windows/x86_64": "x86_64-pc-windows-msvc",
};

function declareOdinfmtCache() {
	namedCache({ name: ODINFMT_CACHE, shared: true });
}

function odinfmtCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

function odinfmtCommandName(plat) {
	const triple = olsTriple(plat);
	return `odinfmt-${triple}${plat.os === "windows" ? ".exe" : ""}`;
}

/**
 * Return the OLS release triple for a platform.
 *
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function olsTriple(plat) {
	const triple = olsTripleMap[`${plat.os}/${plat.arch}`];
	if (!triple) {
		throw new Error(`no odinfmt build for ${plat.os}/${plat.arch}`);
	}
	return triple;
}

/**
 * Return the OLS release artifact filename bundling odinfmt for a version
 * and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinfmtArtifactName(version, plat) {
	return `ols-${olsTriple(plat)}.zip`;
}

/**
 * Return the OLS release download URL bundling odinfmt for a version and
 * platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function odinfmtDownloadUrl(version, plat) {
	return `https://github.com/DanielGavin/ols/releases/download/${version}/${odinfmtArtifactName(version, plat)}`;
}

// Bare coreutils the verified-download and extract scripts need. The sandbox
// is fully hermetic — even `mkdir`/`tar` must be declared tools, not resolved
// from an ambient PATH.
function coreToolNames(plat) {
	return [
		...new Set([
			...lockedDownloadTools(plat),
			...extractArchiveTools(plat.os === "windows" ? "zip" : "zip-unix"),
		]),
	];
}

let coreToolHandles = null;

function ensureCoreTools() {
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}
}

/**
 * Return a named-cache-backed odinfmt tool descriptor plus the on-disk binary
 * name to invoke it with. Downloads and caches the OLS release on first use.
 *
 * @param {string} [version]
 * @returns {Promise<{ tool: object, command: string }>}
 */
export async function odinfmtTool(version) {
	const resolved = resolveOdinToolchainVersion(version);
	await acquireOdinfmt(resolved);
	const plat = platformInfo();
	return {
		tool: {
			kind: "tool",
			name: "odinfmt",
			cache: ODINFMT_CACHE,
			key: odinfmtCacheKey(resolved, plat),
			binDirs: ["."],
		},
		// The OLS zip stores the binary under its triple-suffixed name at the
		// archive root; invoke it by that name (JS has no rename primitive).
		command: odinfmtCommandName(plat),
	};
}

/**
 * Return the path to the odinfmt binary for an Odin toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function odinfmtBin(version) {
	const resolved = resolveOdinToolchainVersion(version);
	const dir = await acquireOdinfmt(resolved);
	return `${dir}/${odinfmtCommandName(platformInfo())}`;
}

/**
 * Acquire (download, verify, and extract) odinfmt for a version and return
 * its cache path.
 *
 * @param {string} version
 * @returns {Promise<string>}
 */
export const acquireOdinfmt = memo(async function acquireOdinfmt(version) {
	declareOdinfmtCache();
	ensureCoreTools();
	const plat = platformInfo();
	const key = odinfmtCacheKey(version, plat);

	if (cacheHas(ODINFMT_CACHE, key)) {
		return cacheGet(ODINFMT_CACHE, key);
	}

	const coreTools = await Promise.all(
		coreToolHandles.map((handle) => nativeToolSpec(handle)),
	);

	const downloadPath = `.imp/odinfmt-downloads/${key}/${odinfmtArtifactName(version, plat)}`;
	await downloadToolArtifact({
		lockfile: ODINFMT_LOCKFILE,
		tool: "odinfmt",
		version,
		plat,
		url: odinfmtDownloadUrl(version, plat),
		downloadPath,
		tools: coreTools,
		display: `download odinfmt ${version} (${plat.os}/${plat.arch})`,
		unverified: OdinfmtToolchain.resolveUnverified(version),
	});

	await extractArchive({
		archive: downloadPath,
		dest: `.imp/odinfmt-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "zip-unix",
		tools: coreTools,
		namedCache: { name: ODINFMT_CACHE, key },
		display: `install odinfmt ${version} (${plat.os}/${plat.arch})`,
	});

	return cacheGet(ODINFMT_CACHE, key);
});

export class OdinfmtToolchain extends Toolchain {
	static kind = "odinfmt-toolchain";
	static tool = ODINFMT_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: OdinfmtToolchain.kind,
				attrs: {
					version: version ?? null,
					...(unverified ? { unverified } : {}),
				},
			},
			opts,
		);
	}

	bin() {
		return odinfmtBin(this.attrs.version);
	}
}

/**
 * Declare an odinfmt toolchain, pinned to an Odin toolchain version. Omit
 * `version` to track the workspace's default Odin toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @param {object} [opts]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this odinfmt toolchain.
 */
export function odinfmtToolchain(version, opts = {}) {
	return new OdinfmtToolchain({ version, unverified: opts.unverified });
}

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "odinfmt",
		platforms: odinSupportedPlatforms(),
		downloadUrl: odinfmtDownloadUrl,
		artifactName: odinfmtArtifactName,
		lockfile: ODINFMT_LOCKFILE,
	},
	["dev-2026-03"],
);
// odinfmt's version tracks the workspace's default Odin toolchain when
// declared without one of its own (the common case), so the handle's raw
// attrs.version — possibly null — must be resolved before locking.
product(OdinfmtToolchain, GEN_LOCKFILES, ODINFMT_TOOL, (handle) =>
	generateToolLockfile({
		handle: {
			attrs: { version: resolveOdinToolchainVersion(handle.attrs.version) },
		},
		...LOCKFILE_SPEC,
	}),
);
