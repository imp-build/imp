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
	group,
	tool as graphTool,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";
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

// Bare coreutils the download/extract scripts need — same reasoning as
// coreToolNames in uv_toolchain.js: the sandbox is fully hermetic, so even
// these must be declared tools, not resolved from an ambient PATH.
function coreToolNames(plat) {
	const extract = plat.os === "windows" ? ["tar"] : ["tar", "gzip"];
	return [...new Set([...lockedDownloadTools(plat), ...extract])];
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

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireRuffToolchain().
let coreToolHandles = null;
let graphToolchains = new Map();

export function __resetRuffToolchainStateForTest() {
	RuffToolchain.clearDefault();
	coreToolHandles = null;
	graphToolchains = new Map();
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
	namedCache({ name: RUFF_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

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

/** Return the CAS-backed graph Ruff tool. */
export function ruffGraphTool(version) {
	const resolved = RuffToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = ruffCacheKey(resolved, plat);
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
	const directory = extractArchive({
		archive,
		dest: `.imp/ruff-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "tar.gz",
		stripComponents: 1,
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
 * Acquire a ruff toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export const acquireRuffToolchain = memo(
	async function acquireRuffToolchain(version) {
		const plat = platformInfo();
		const key = ruffCacheKey(version, plat);

		if (!coreToolHandles) {
			throw new Error(
				"no ruff toolchain declared via ruffToolchain(); nothing to acquire",
			);
		}
		const coreTools = await group(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		if (!cacheHas(RUFF_TOOLCHAIN_CACHE, key)) {
			// Verification only runs on this cold path — warm named-cache
			// contents were verified when inserted, or seeded deliberately via
			// installRuffToolchain.
			const downloadPath = `.imp/ruff-downloads/${key}/${ruffArtifactName(version, plat)}`;
			await downloadToolArtifact({
				lockfile: lockfileFor(version),
				tool: "ruff-toolchain",
				version,
				plat,
				url: ruffDownloadUrl(version, plat),
				downloadPath,
				tools: coreTools,
				display: `download ruff ${version} (${plat.os}/${plat.arch})`,
				unverified: RuffToolchain.resolveUnverified(version),
			});

			// ruff's release archives extract a single top-level
			// ruff-<triple>/ directory containing the `ruff` binary — strip it
			// so the cache root holds the binary directly, same shape
			// acquireUvToolchain uses.
			await extractArchive({
				archive: downloadPath,
				dest: `.imp/ruff-toolchains/${key}`,
				format: plat.os === "windows" ? "zip" : "tar.gz",
				stripComponents: 1,
				tools: coreTools,
				namedCache: { name: RUFF_TOOLCHAIN_CACHE, key },
				display: `extract ruff ${version} (${plat.os}/${plat.arch})`,
			});
		}

		return cacheGet(RUFF_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Ruff Toolchain {0}", level: "info" },
);

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
	const dir = await acquireRuffToolchain(resolved);
	const exe = platformInfo().os === "windows" ? "ruff.exe" : "ruff";
	return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed ruff tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function ruffTool(version) {
	const resolved = RuffToolchain.requireVersion(version);
	await acquireRuffToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "ruff",
		cache: RUFF_TOOLCHAIN_CACHE,
		key: ruffCacheKey(resolved, plat),
		binDirs: ["."],
	};
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
product(
	RuffToolchain,
	GEN_LOCKFILES,
	RUFF_TOOL,
	(handle) =>
		generateToolLockfile({
			handle,
			...LOCKFILE_SPEC,
			lockfile: handle.attrs.lockfile ?? DEFAULT_LOCKFILE,
		}),
	{ display: "gen lockfiles {0}", level: "info" },
);
