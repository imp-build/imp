import {
	Toolchain,
	namedCache,
	platformInfo,
	cachePut,
	cacheGet,
	toolName,
	tool as graphTool,
} from "imp:core";

import { downloadToolArtifact } from "//rules/imp/lockfile";
import { extractArchive } from "//rules/imp/archive";
import { toolchainBin } from "//rules/imp/toolchain";
import {
	graphGenerateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering ruff-driven products.
export const RUFF_TOOL = toolName("ruff");

const RUFF_TOOLCHAIN_CACHE = "ruff-toolchains";
// The bundled lockfile ships with the rule library (it lives inside
// rules/**); a workspace overrides it with a file at the same address, or
// by declaring the toolchain with a `lockfile` address of its own.
const DEFAULT_LOCKFILE = "//rules/python/ruff-toolchain.lock";

// ruff's release target triples: https://github.com/astral-sh/ruff/releases.
// Same platform set as uv (rules/python/uv_toolchain.js) minus the musl/arm
// variants that toolchain doesn't publish either — this repo only builds for
// the standard glibc/msvc/darwin hosts.
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
			`unsupported ruff toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return triple;
}

/**
 * Return the ruff release archive filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function ruffArtifactName(version, plat) {
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `ruff-${targetTriple(plat)}.${ext}`;
}

/**
 * Return the ruff release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function ruffDownloadUrl(version, plat) {
	return `https://github.com/astral-sh/ruff/releases/download/${version}/${ruffArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a ruff toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function ruffCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

// The platforms this module acquires ruff for and publishes lockfile entries
// for (see TARGET_TRIPLES).
export function ruffSupportedPlatforms() {
	return Object.keys(TARGET_TRIPLES).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
}

export class RuffToolchain extends Toolchain {
	static kind = "ruff-toolchain";
	static tool = RUFF_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{ kind: RuffToolchain.kind, attrs: { version, lockfile, unverified } },
			opts,
		);
	}

	bin() {
		return ruffBin(this.attrs.version);
	}
}

// The lockfile/unverified settings ride the declared instance's attrs —
// the one that declared this exact version, else the default instance's.
function lockfileFor(version) {
	return (
		RuffToolchain.instanceForVersion(version)?.attrs.lockfile ??
		DEFAULT_LOCKFILE
	);
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetRuffToolchainStateForTest() {
	RuffToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? ruffGraphTool(version);
}

/**
 * Declare a ruff toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {string} [opts.lockfile] Lockfile address pinning download SHA-256s;
 *   defaults to the bundled `//rules/python/ruff-toolchain.lock`. Point this
 *   at your own lock (regenerate via `imp goal gen-lockfiles`) when pinning
 *   a non-default version.
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this ruff toolchain.
 * @category configuration
 */
export function ruffToolchain(version, opts = {}) {
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	const unverified = opts.unverified ?? false;
	new RuffToolchain(
		{ version, lockfile, unverified },
		{ default: opts.default },
	);
	const graph = ruffGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/**
 * The `[GEN_LOCKFILES]` root for a ruff toolchain version.
 *
 * This is a separate function from ruffToolchain(). ruffToolchain()
 * returns a frozen tool() handle. A frozen object cannot hold an extra
 * property.
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {string} [opts.lockfile] Use this lockfile address instead of the
 *   default. This matches ruffToolchain()'s own `opts.lockfile`.
 * @returns {object} `{ [GEN_LOCKFILES]: ... }`.
 */
export function ruffGenLockfiles(version, opts = {}) {
	const resolved = RuffToolchain.requireVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
			lockfile: opts.lockfile ?? DEFAULT_LOCKFILE,
		}),
	};
}

/** Return the CAS-backed graph Ruff tool. */
export function ruffGraphTool(version) {
	const resolved = RuffToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = ruffCacheKey(resolved, plat);
	namedCache({ name: RUFF_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(resolved),
		tool: "ruff-toolchain",
		version: resolved,
		plat,
		url: ruffDownloadUrl(resolved, plat),
		output: `.imp/ruff-downloads/${key}/${ruffArtifactName(resolved, plat)}`,
		display: `download ruff ${resolved} (${plat.os}/${plat.arch})`,
		unverified: RuffToolchain.resolveUnverified(resolved),
	});
	// ruff's tar.gz releases (Linux/macOS) extract a single top-level
	// ruff-<triple>/ directory containing the `ruff` binary — strip it so
	// the cache root holds the binary directly, the same shape uv uses. The
	// Windows zip release has no such wrapping directory; ruff.exe sits at
	// the archive root, so it must not be stripped.
	const directory = extractArchive({
		archive,
		dest: `.imp/ruff-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "tar.gz",
		stripComponents: plat.os === "windows" ? undefined : 1,
		namedCache: { name: RUFF_TOOLCHAIN_CACHE, key },
		display: `extract ruff ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Install a local ruff toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the directory containing the `ruff` binary.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installRuffToolchain(version, source) {
	namedCache({ name: RUFF_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = ruffCacheKey(version, plat);
	cachePut(RUFF_TOOLCHAIN_CACHE, key, source);
	return cacheGet(RUFF_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default ruff toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveRuffToolchainVersion(version) {
	return RuffToolchain.resolveVersion(version);
}

/**
 * Return the ruff executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function ruffBin(version) {
	const resolved = RuffToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: RUFF_TOOLCHAIN_CACHE,
		key: ruffCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "ruff.exe" : "ruff",
	});
}

/**
 * Return the currently configured default ruff toolchain version.
 *
 * @returns {string|null}
 */
export function defaultRuffToolchainVersion() {
	return RuffToolchain.defaultVersion();
}

/**
 * Return the currently configured default ruff toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultRuffToolchain() {
	const version = RuffToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another ruffToolchain(..., { default: true }).
ruffToolchain("0.15.21", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "ruff-toolchain",
		platforms: ruffSupportedPlatforms(),
		downloadUrl: ruffDownloadUrl,
		artifactName: ruffArtifactName,
		lockfile: DEFAULT_LOCKFILE,
	},
	["0.15.20", "0.15.21"],
);
