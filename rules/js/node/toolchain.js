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
	tool as graphTool,
	group,
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
// consumed by rule modules registering node-driven products.
export const NODE_TOOL = toolName("node");

const NODE_TOOLCHAIN_CACHE = "node-toolchains";
const NODE_LOCKFILE = "//rules/js/node/node-toolchain.lock";

// nodejs.org's own os/arch tokens (https://nodejs.org/dist/), distinct from
// both imp's plat.os/plat.arch vocabulary and every other toolchain's
// target-triple vocabulary — "darwin" not "macos", "win" not "windows",
// "x64"/"arm64" not "x86_64"/"aarch64". Same platform set as uv/ruff
// (rules/python/uv_toolchain.js, ruff_toolchain.js): this repo only builds
// for the standard glibc/msvc/darwin hosts.
const NODE_PLATFORM_TOKENS = {
	"linux-x86_64": { os: "linux", arch: "x64" },
	"linux-aarch64": { os: "linux", arch: "arm64" },
	"macos-x86_64": { os: "darwin", arch: "x64" },
	"macos-aarch64": { os: "darwin", arch: "arm64" },
	"windows-x86_64": { os: "win", arch: "x64" },
};

function nodePlatformTokens(plat) {
	const tokens = NODE_PLATFORM_TOKENS[`${plat.os}-${plat.arch}`];
	if (!tokens) {
		throw new Error(
			`unsupported node toolchain platform: ${plat.os}/${plat.arch}`,
		);
	}
	return tokens;
}

/**
 * Return the Node.js release archive filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function nodeArtifactName(version, plat) {
	const { os, arch } = nodePlatformTokens(plat);
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `node-v${version}-${os}-${arch}.${ext}`;
}

/**
 * Return the Node.js release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function nodeDownloadUrl(version, plat) {
	return `https://nodejs.org/dist/v${version}/${nodeArtifactName(version, plat)}`;
}

/**
 * Return the named-cache key for a node toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function nodeCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

// The platforms this module acquires node for and publishes lockfile entries
// for (see NODE_PLATFORM_TOKENS).
export function nodeSupportedPlatforms() {
	return Object.keys(NODE_PLATFORM_TOKENS).map((key) => {
		const sep = key.indexOf("-");
		return { os: key.slice(0, sep), arch: key.slice(sep + 1) };
	});
}

// Bare coreutils the download/extract scripts need — same reasoning as
// coreToolNames in uv_toolchain.js/ruff_toolchain.js: the sandbox is fully
// hermetic, so even these must be declared tools, not resolved from an
// ambient PATH.
function coreToolNames(plat) {
	const extract = plat.os === "windows" ? ["tar"] : ["tar", "gzip"];
	return [...new Set([...lockedDownloadTools(plat), ...extract])];
}

export class NodeToolchain extends Toolchain {
	static kind = "node-toolchain";
	static tool = NODE_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: NodeToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return nodeBin(this.attrs.version);
	}
}

// Declared lazily, once — target() addresses are only assigned at
// workspace-load time, so tool handles must be created when a toolchain is
// declared at BUILD.js top level, not inside acquireNodeToolchain().
let coreToolHandles = null;
let graphToolchains = new Map();

export function __resetNodeToolchainStateForTest() {
	NodeToolchain.clearDefault();
	coreToolHandles = null;
	graphToolchains = new Map();
}

/**
 * Declare a node toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this node toolchain.
 * @category configuration
 */
export function nodeToolchain(version, opts = {}) {
	namedCache({ name: NODE_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	new NodeToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = nodeGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/**
 * Install a local node toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installNodeToolchain(version, source) {
	namedCache({ name: NODE_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = nodeCacheKey(version, plat);
	cachePut(NODE_TOOLCHAIN_CACHE, key, source);
	return cacheGet(NODE_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a node toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export const acquireNodeToolchain = memo(
	async function acquireNodeToolchain(version) {
		const plat = platformInfo();
		const key = nodeCacheKey(version, plat);

		if (!coreToolHandles) {
			throw new Error(
				"no node toolchain declared via nodeToolchain(); nothing to acquire",
			);
		}
		const coreTools = await group(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		if (!cacheHas(NODE_TOOLCHAIN_CACHE, key)) {
			const downloadPath = `.imp/node-downloads/${key}/${nodeArtifactName(version, plat)}`;
			await downloadToolArtifact({
				lockfile: NODE_LOCKFILE,
				tool: "node-toolchain",
				version,
				plat,
				url: nodeDownloadUrl(version, plat),
				downloadPath,
				tools: coreTools,
				display: `download node ${version} (${plat.os}/${plat.arch})`,
				unverified: NodeToolchain.resolveUnverified(version),
			});

			// Node's release archives extract a single top-level
			// node-v<version>-<os>-<arch>/ directory containing bin/node (and
			// bin/npm/bin/npx) — strip it so the cache root holds the binaries
			// directly, same shape acquireUvToolchain/acquireRuffToolchain use.
			await extractArchive({
				archive: downloadPath,
				dest: `.imp/node-toolchains/${key}`,
				format: plat.os === "windows" ? "zip" : "tar.gz",
				stripComponents: 1,
				tools: coreTools,
				namedCache: { name: NODE_TOOLCHAIN_CACHE, key },
				display: `extract node ${version} (${plat.os}/${plat.arch})`,
			});
		}

		return cacheGet(NODE_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Node Toolchain {0}", level: "info" },
);

/**
 * Resolve an explicit or default node toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveNodeToolchainVersion(version) {
	return NodeToolchain.resolveVersion(version);
}

/**
 * Return the node executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function nodeBin(version) {
	const resolved = NodeToolchain.requireVersion(version);
	const dir = await acquireNodeToolchain(resolved);
	const exe = platformInfo().os === "windows" ? "node.exe" : "bin/node";
	return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed node tool descriptor for sandbox execution.
 * Node's own release layout puts binaries under bin/ on unix but at the
 * archive root on windows — binDirs reflects that so run()'s PATH wiring
 * finds `node`/`npm`/`npx` on both.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function nodeTool(version) {
	const resolved = NodeToolchain.requireVersion(version);
	await acquireNodeToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "node",
		cache: NODE_TOOLCHAIN_CACHE,
		key: nodeCacheKey(resolved, plat),
		binDirs: [plat.os === "windows" ? "." : "bin"],
	};
}

/** Return the CAS-backed graph tool used by graph-native JS rules. */
export function nodeGraphTool(version) {
	const resolved = NodeToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = nodeCacheKey(resolved, plat);
	const archive = downloadToolArtifact({
		lockfile: NODE_LOCKFILE,
		tool: "node-toolchain",
		version: resolved,
		plat,
		url: nodeDownloadUrl(resolved, plat),
		output: `.imp/node-downloads/${key}/${nodeArtifactName(resolved, plat)}`,
		display: `download node ${resolved} (${plat.os}/${plat.arch})`,
		unverified: NodeToolchain.resolveUnverified(resolved),
	});
	const directory = extractArchive({
		archive,
		dest: `.imp/node-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "tar.gz",
		stripComponents: 1,
		display: `extract node ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, {
		binDirs: [plat.os === "windows" ? "." : "bin"],
	});
}

/**
 * Return the currently configured default node toolchain version.
 *
 * @returns {string|null}
 */
export function defaultNodeToolchainVersion() {
	return NodeToolchain.defaultVersion();
}

/**
 * Return the currently configured default node toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultNodeToolchain() {
	const version = NodeToolchain.defaultVersion();
	return version ? (graphToolchains.get(version) ?? null) : null;
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another nodeToolchain(..., { default: true }).
nodeToolchain("22.11.0", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "node-toolchain",
		platforms: nodeSupportedPlatforms(),
		downloadUrl: nodeDownloadUrl,
		artifactName: nodeArtifactName,
		lockfile: NODE_LOCKFILE,
	},
	["22.11.0"],
);
product(
	NodeToolchain,
	GEN_LOCKFILES,
	NODE_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
