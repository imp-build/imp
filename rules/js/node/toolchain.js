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

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering node-driven products.
export const NODE_TOOL = toolName("node");

const NODE_TOOLCHAIN_CACHE = "node-toolchains";
const DEFAULT_LOCKFILE = "//rules/js/node/node-toolchain.lock";

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

export class NodeToolchain extends Toolchain {
	static kind = "node-toolchain";
	static tool = NODE_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: NodeToolchain.kind,
				attrs: { version, lockfile, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return nodeBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetNodeToolchainStateForTest() {
	NodeToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? nodeGraphTool(version);
}

/**
 * Declare a node toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {string} [opts.lockfile] Address of a workspace-owned lockfile
 *   to use instead of the shipped one.
 * @returns {object} Target handle for this node toolchain.
 * @category configuration
 */
export function nodeToolchain(version, opts = {}) {
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	new NodeToolchain(
		{ version, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	const graph = nodeGraphTool(version);
	graphToolchains.set(version, graph);
	return graph;
}

/**
 * The `[GEN_LOCKFILES]` root for a node toolchain version.
 *
 * This is a separate function from nodeToolchain(). nodeToolchain() returns a
 * frozen tool() handle. A frozen object cannot hold an extra
 * property.
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {string} [opts.lockfile] Address override for the generated lockfile.
 * @returns {object} `{ [GEN_LOCKFILES]: ... }`.
 */
export function nodeGenLockfiles(version, opts = {}) {
	const resolved = NodeToolchain.requireVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
			lockfile:
				opts.lockfile ?? lockfileFor(NodeToolchain, resolved, DEFAULT_LOCKFILE),
		}),
	};
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
 * Resolve an explicit or default node toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveNodeToolchainVersion(version) {
	return NodeToolchain.resolveVersion(version);
}

/**
 * Return the node executable path for a toolchain version, installing the
 * toolchain if necessary.
 *
 * Node's own release layout puts binaries under bin/ on unix but at the
 * archive root on windows.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function nodeBin(version) {
	const resolved = NodeToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: NODE_TOOLCHAIN_CACHE,
		key: nodeCacheKey(resolved, plat),
		subDir: plat.os === "windows" ? "." : "bin",
		exe: plat.os === "windows" ? "node.exe" : "node",
	});
}

/**
 * Return a named-cache-backed node tool descriptor for sandbox execution —
 * for legacy run() consumers, mirroring uvTool()/kacheTool(). Used by
 * appRun()'s [RUN] description (//rules/js/graph.js) so the run workflow
 * (//rules/workflows/run) can execute node directly rather than the app
 * task running it itself.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function nodeTool(version) {
	const resolved = NodeToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainToolSpec(graphToolFor(resolved), {
		toolName: "node",
		name: NODE_TOOLCHAIN_CACHE,
		key: nodeCacheKey(resolved, plat),
		binDirs: [plat.os === "windows" ? "." : "bin"],
	});
}

/** Return the CAS-backed graph tool used by graph-native JS rules. */
export function nodeGraphTool(version) {
	const resolved = NodeToolchain.requireVersion(version);
	const plat = platformInfo();
	const key = nodeCacheKey(resolved, plat);
	namedCache({ name: NODE_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(NodeToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "node-toolchain",
		version: resolved,
		plat,
		url: nodeDownloadUrl(resolved, plat),
		output: `.imp/node-downloads/${key}/${nodeArtifactName(resolved, plat)}`,
		display: `download node ${resolved} (${plat.os}/${plat.arch})`,
		unverified: NodeToolchain.resolveUnverified(resolved),
	});
	// Node's release archives extract a single top-level
	// node-v<version>-<os>-<arch>/ directory containing bin/node (and
	// bin/npm/bin/npx) — strip it so the cache root holds the binaries
	// directly, the same shape uv and ruff use.
	const directory = extractArchive({
		archive,
		dest: `.imp/node-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "tar.gz",
		stripComponents: 1,
		namedCache: { name: NODE_TOOLCHAIN_CACHE, key },
		display: `extract node ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, {
		binDirs: [plat.os === "windows" ? "." : "bin"],
		mount: { name: "node", cache: NODE_TOOLCHAIN_CACHE, key },
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
		lockfile: DEFAULT_LOCKFILE,
	},
	["22.11.0"],
);
