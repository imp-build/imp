import {
	Toolchain,
	namedCache,
	platformInfo,
	toolName,
	tool as graphTool,
} from "imp:core";

import {
	odinSupportedPlatforms,
	resolveOdinToolchainVersion,
} from "//rules/odin/toolchain";
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

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering odinfmt-driven products.
export const ODINFMT_TOOL = toolName("odinfmt");

const ODINFMT_CACHE = "odinfmt-toolchains";
// The bundled lockfile ships with the rule library (it lives inside
// rules/**); a workspace overrides it with a file at the same address, or
// by declaring the toolchain with a `lockfile` address of its own.
const DEFAULT_LOCKFILE = "//rules/odin/odinfmt/odinfmt.lock";

// odinfmt ships inside the OLS release zips, whose tags track Odin's monthly dev
// versions, so it is pinned to the same version as the Odin toolchain.
const olsTripleMap = {
	"linux/x86_64": "x86_64-unknown-linux-gnu",
	"linux/aarch64": "arm64-unknown-linux-gnu",
	"macos/x86_64": "x86_64-darwin",
	"macos/aarch64": "arm64-darwin",
	"windows/x86_64": "x86_64-pc-windows-msvc",
};

function odinfmtCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

export function odinfmtCommandName(plat) {
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

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

function graphToolFor(version) {
	return graphToolchains.get(version) ?? odinfmtGraphTool(version);
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
	const plat = platformInfo();
	return {
		tool: await toolchainToolSpec(graphToolFor(resolved), {
			toolName: "odinfmt",
			name: ODINFMT_CACHE,
			key: odinfmtCacheKey(resolved, plat),
			binDirs: ["."],
		}),
		// The OLS zip stores the binary under its triple-suffixed name at the
		// archive root; invoke it by that name (JS has no rename primitive).
		command: odinfmtCommandName(plat),
	};
}

/** Build odinfmt from its verified OLS archive as a graph tool. */
export function odinfmtGraphTool(version) {
	const resolved = resolveOdinToolchainVersion(version);
	const plat = platformInfo();
	namedCache({ name: ODINFMT_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(OdinfmtToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "odinfmt",
		version: resolved,
		plat,
		url: odinfmtDownloadUrl(resolved, plat),
		output: `odinfmt-downloads/${odinfmtCacheKey(resolved, plat)}/${odinfmtArtifactName(resolved, plat)}`,
		display: `download odinfmt ${resolved} (${plat.os}/${plat.arch})`,
		unverified: OdinfmtToolchain.resolveUnverified(resolved),
	});
	const directory = extractArchive({
		archive,
		dest: "odinfmt-toolchain",
		format: plat.os === "windows" ? "zip" : "zip-unix",
		namedCache: {
			name: ODINFMT_CACHE,
			key: odinfmtCacheKey(resolved, plat),
		},
		display: `install odinfmt ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Return the path to the odinfmt binary for an Odin toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function odinfmtBin(version) {
	const resolved = resolveOdinToolchainVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: ODINFMT_CACHE,
		key: odinfmtCacheKey(resolved, plat),
		exe: odinfmtCommandName(plat),
	});
}

export class OdinfmtToolchain extends Toolchain {
	static kind = "odinfmt-toolchain";
	static tool = ODINFMT_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: OdinfmtToolchain.kind,
				attrs: {
					version: version ?? null,
					lockfile,
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

export function __resetOdinfmtToolchainStateForTest() {
	OdinfmtToolchain.clearDefault();
	graphToolchains = new Map();
}

/**
 * Declare an odinfmt toolchain, pinned to an Odin toolchain version. Omit
 * `version` to track the workspace's default Odin toolchain version.
 *
 * @category configuration
 * @param {string} [version]
 * @param {object} [opts]
 * @param {boolean} [opts.default=false] Set as the default odinfmt target.
 * @param {string} [opts.lockfile] Lockfile address pinning download SHA-256s;
 *   defaults to the bundled `//rules/odin/odinfmt/odinfmt.lock`. Point this
 *   at your own lock (regenerate via `imp goal gen-lockfiles`) when pinning a
 *   version the bundled lock does not know.
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this odinfmt toolchain.
 */
export function odinfmtToolchain(version, opts = {}) {
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	new OdinfmtToolchain(
		{ version, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	const resolved = resolveOdinToolchainVersion(version);
	const tool = odinfmtGraphTool(resolved);
	graphToolchains.set(resolved, tool);
	return tool;
}

/**
 * The `[GEN_LOCKFILES]` root for an odinfmt toolchain version.
 *
 * This is a separate function from odinfmtToolchain(). odinfmtToolchain()
 * returns a frozen tool() handle. A frozen object cannot hold an extra
 * property. If you omit `version`, this function uses the workspace's
 * default Odin toolchain version, same as odinfmtToolchain() does.
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {string} [opts.lockfile] Write this lockfile address instead of the
 *   one declared on the toolchain. Defaults to the address
 *   odinfmtToolchain(version, { lockfile }) declared, so a workspace states
 *   it once.
 * @returns {object} `{ [GEN_LOCKFILES]: ... }`.
 */
export function odinfmtGenLockfiles(version, opts = {}) {
	const resolved = resolveOdinToolchainVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
			lockfile:
				opts.lockfile ??
				lockfileFor(OdinfmtToolchain, resolved, DEFAULT_LOCKFILE),
		}),
	};
}

/**
 * Return the currently configured default odinfmt toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultOdinfmtToolchain() {
	const version = OdinfmtToolchain.defaultVersion();
	const resolved = version ? resolveOdinToolchainVersion(version) : null;
	return resolved ? graphToolFor(resolved) : null;
}

// Odinfmt follows the default Odin compiler version when no explicit version
// is provided. A workspace can replace this target with an explicit
// odinfmtToolchain(..., { default: true }) declaration.
odinfmtToolchain(undefined, { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "odinfmt",
		platforms: odinSupportedPlatforms(),
		downloadUrl: odinfmtDownloadUrl,
		artifactName: odinfmtArtifactName,
		lockfile: DEFAULT_LOCKFILE,
	},
	["dev-2026-03"],
);
