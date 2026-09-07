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
// consumed by rule modules registering cmake-driven products.
export const CMAKE_TOOL = toolName("cmake");

const CMAKE_TOOLCHAIN_CACHE = "cmake-toolchains";
const DEFAULT_LOCKFILE = "//rules/c/cmake/cmake.lock";

// CMake's Windows release archives use "arm64" rather than the "aarch64"
// naming used elsewhere in this project (and by CMake's own Linux archives).
const archNameByOs = {
	linux: { x86_64: "x86_64", aarch64: "aarch64" },
	windows: { x86_64: "x86_64", aarch64: "arm64" },
};

function requireSupportedPlatform(plat) {
	const archNames = archNameByOs[plat.os];
	if (!archNames) {
		throw new Error(`unsupported CMake toolchain OS: ${plat.os}`);
	}
	if (!archNames[plat.arch]) {
		throw new Error(`unsupported CMake toolchain architecture: ${plat.arch}`);
	}
}

/**
 * Return the CMake release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function cmakeArtifactName(version, plat) {
	requireSupportedPlatform(plat);
	const arch = archNameByOs[plat.os][plat.arch];
	const ext = plat.os === "windows" ? "zip" : "tar.gz";
	return `cmake-${version}-${plat.os}-${arch}.${ext}`;
}

/**
 * Return the CMake release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function cmakeDownloadUrl(version, plat) {
	return `https://github.com/Kitware/CMake/releases/download/v${version}/${cmakeArtifactName(version, plat)}`;
}

/**
 * Return the platforms CMake publishes release archives for, derived from the
 * os/arch matrix this module already supports.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function cmakeSupportedPlatforms() {
	return Object.entries(archNameByOs).flatMap(([os, archNames]) =>
		Object.keys(archNames).map((arch) => ({ os, arch })),
	);
}

/**
 * Return the named-cache key for a CMake toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function cmakeCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

export class CmakeToolchain extends Toolchain {
	static kind = "cmake-toolchain";
	static tool = CMAKE_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: CmakeToolchain.kind,
				attrs: { version, lockfile, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return cmakeBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetCmakeToolchainStateForTest() {
	CmakeToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? cmakeGraphTool(version);
}

/**
 * Declare a CMake toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {string} [opts.lockfile] Address of a workspace-owned lockfile
 *   to use instead of the shipped one.
 * @returns {object} Target handle for this CMake toolchain.
 * @category configuration
 */
export function cmakeToolchain(version, opts = {}) {
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	const toolchain = new CmakeToolchain(
		{ version, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	toolchain[GEN_LOCKFILES] = graphGenerateToolLockfile({
		version,
		...LOCKFILE_SPEC,
		lockfile,
	});
	graphToolchains.set(version, cmakeGraphTool(version));
	return toolchain;
}

/**
 * Install a local CMake toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installCmakeToolchain(version, source) {
	namedCache({ name: CMAKE_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = cmakeCacheKey(version, plat);
	cachePut(CMAKE_TOOLCHAIN_CACHE, key, source);
	return cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default CMake toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveCmakeToolchainVersion(version) {
	return CmakeToolchain.resolveVersion(version);
}

/**
 * Return the CMake executable for a toolchain version, or system "cmake" when
 * no CMake toolchain default has been declared.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function cmakeBin(version) {
	const resolved = resolveCmakeToolchainVersion(version);
	// No declared toolchain means "use whatever cmake is on PATH" — check this
	// first, so no install task is ever built for a workspace that opted out.
	if (!resolved) {
		return "cmake";
	}
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: CMAKE_TOOLCHAIN_CACHE,
		key: cmakeCacheKey(resolved, plat),
		subDir: "bin",
		exe: plat.os === "windows" ? "cmake.exe" : "cmake",
	});
}

// CMake's own configure step bakes its own invoked path into generated
// build.ninja text (e.g. a `add_custom_command(... COMMAND ${CMAKE_COMMAND}
// -E copy ...)` custom command resolves CMAKE_COMMAND to CMake's own
// absolute/sandbox-relative invocation path) — read back by a *later,
// separate* replay sandbox during graph_replay.js's own edge replay, exactly
// the same "baked path, different sandbox" problem gcc's CMAKE_C_COMPILER
// has (see gccGraphToolchainDir()'s docstring in //rules/c/gcc).
// rewriteToolInvocations() (ninja_graph.js) already rewrites any such path
// (real absolute, or imp's own sandbox-relative tool mount) back to a bare
// "cmake" name; resolving that bare name during replay needs a *freshly
// constructible* tool spec (a running task() body can't mint new resolved
// graph tool bindings — see cmakeGraphToolSpec() below), which requires a
// real named-cache key, not just a plain tool() artifact wrapper.
namedCache({ name: CMAKE_TOOLCHAIN_CACHE, shared: true });

/**
 * Build the managed CMake distribution as a graph-native tool (issue #31/#62,
 * PR D). Mirrors rules/c/gcc's gccGraphTool() — downloadToolArtifact()'s
 * graph form plus extractArchive() (no wrapper scripts needed for a plain
 * `cmake` binary, unlike gcc/zig's compiler-alias wrappers, so this is
 * simpler) — writing its result into CMAKE_TOOLCHAIN_CACHE so
 * cmakeGraphToolSpec() can address the same install by cache key.
 *
 * @param {string} [version]
 * @returns {object} A graph-native tool() handle.
 */
export function cmakeGraphTool(version) {
	const resolved = CmakeToolchain.requireVersion(version, "CMake");
	const plat = platformInfo();
	const cacheKey = cmakeCacheKey(resolved, plat);
	namedCache({ name: CMAKE_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(CmakeToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "cmake",
		version: resolved,
		plat,
		url: cmakeDownloadUrl(resolved, plat),
		output: `cmake-downloads/${cacheKey}/${cmakeArtifactName(resolved, plat)}`,
		display: `download cmake ${resolved} (${plat.os}/${plat.arch})`,
		unverified: CmakeToolchain.resolveUnverified(resolved),
	});
	// Extracted via the shared extractArchive() helper: "zip" (windows)
	// unpacks with unzip, not tar — see rules/imp/archive's own comment on
	// why a bare "tar" on Windows can't be trusted to resolve to a
	// zip-capable implementation.
	const format = plat.os === "windows" ? "zip" : "tar.gz";
	const directory = extractArchive({
		archive,
		dest: "cmake-toolchain",
		format,
		stripComponents: 1,
		namedCache: { name: CMAKE_TOOLCHAIN_CACHE, key: cacheKey },
		display: `install cmake ${resolved} (${plat.os}/${plat.arch})`,
	});
	return graphTool(directory, {
		binDirs: ["bin"],
		mount: { name: "cmake", cache: CMAKE_TOOLCHAIN_CACHE, key: cacheKey },
	});
}

/**
 * Graph-native CMake toolchain: cmakeGraphTool() wrapped with version
 * metadata, mirroring gccGraphToolchain()'s one-directory shape.
 *
 * @param {string} [version]
 * @returns {{ tool: object, version: string }}
 */
export function cmakeGraphToolchain(version) {
	const resolved = CmakeToolchain.requireVersion(version, "CMake");
	return Object.freeze({
		tool: cmakeGraphTool(resolved),
		version: resolved,
	});
}

/**
 * Return the currently configured default CMake toolchain as graph-native
 * handles, or null if none is declared.
 *
 * @returns {object|null}
 */
export function defaultCmakeGraphToolchain() {
	const version = CmakeToolchain.defaultVersion();
	return version ? cmakeGraphToolchain(version) : null;
}

/**
 * The real, absolute host directory (bin/ inside it) a resolved CMake graph
 * toolchain installed into, via the same named-cache `cacheGet()` real host
 * path cmakeGraphToolSpec() addresses — mirrors gcc's own
 * gccGraphToolchainDir() (//rules/c/gcc). Must be used (not exec.tool()'s
 * sandbox-mount-relative path) for CMake's own configure invocation: its
 * result gets baked as literal CMAKE_COMMAND text into build.ninja custom
 * commands (e.g. a POST_BUILD `${CMAKE_COMMAND} -E copy`), read back by a
 * *later, separate* replay sandbox — confirmed by a real replay failure
 * ("../../../../../directory/bin/cmake: not found") when this used
 * exec.tool()'s relative alias instead: rebasePath() only recognizes a real
 * absolute host path or a genuine sandboxRoot-absolute mount, not an
 * unresolved sandbox-relative one.
 *
 * @param {object} exec Task's exec (see task()'s run(exec, resolved) body).
 * @param {object} resolvedCmakeTool Resolved `cmakeGraphToolchain().tool` input.
 * @param {string} version `cmakeGraphToolchain().version`.
 * @returns {string}
 */
export function cmakeGraphToolchainDir(exec, resolvedCmakeTool, version) {
	exec.path(resolvedCmakeTool);
	const resolved = CmakeToolchain.requireVersion(version, "CMake");
	const plat = platformInfo();
	return cacheGet(CMAKE_TOOLCHAIN_CACHE, cmakeCacheKey(resolved, plat));
}

/**
 * A freshly-constructible, named-cache-backed legacy tool spec for a pinned
 * CMake install — the graph-native counterpart of gcc's gccGraphToolSpec(),
 * used to resolve a bare "cmake" name rewriteToolInvocations() recovers from
 * a replayed ninja edge's baked-in CMAKE_COMMAND path (see cmakeGraphTool()'s
 * own docstring). Unlike a resolved tool() binding, this can be constructed
 * at any time, including inside a running task() body.
 *
 * @param {string} [version]
 * @returns {object} `{kind:"tool", name:"cmake", cache, key, binDirs}`.
 */
export function cmakeGraphToolSpec(version) {
	const resolved = CmakeToolchain.requireVersion(version, "CMake");
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "cmake",
		cache: CMAKE_TOOLCHAIN_CACHE,
		key: cmakeCacheKey(resolved, plat),
		binDirs: ["bin"],
	};
}

/**
 * Return the currently configured default CMake toolchain version.
 *
 * @returns {string|null}
 */
export function defaultCmakeToolchainVersion() {
	return CmakeToolchain.defaultVersion();
}

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "cmake",
		platforms: cmakeSupportedPlatforms(),
		downloadUrl: cmakeDownloadUrl,
		artifactName: cmakeArtifactName,
		lockfile: DEFAULT_LOCKFILE,
	},
	["3.31.0"],
);

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another cmakeToolchain(..., { default: true }).
cmakeToolchain("3.31.0", { default: true });
