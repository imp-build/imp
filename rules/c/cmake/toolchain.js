import {
	Toolchain,
	product,
	namedCache,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
} from "imp:core";

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
// consumed by rule modules registering cmake-driven products.
export const CMAKE_TOOL = toolName("cmake");

const CMAKE_TOOLCHAIN_CACHE = "cmake-toolchains";
const CMAKE_LOCKFILE = "//rules/c/cmake/cmake.lock";

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

/**
 * Build a CMake toolchain API. Tests can pass a fake host implementation, and
 * the install/acquire path can grow here without touching the CMake build rule.
 *
 * @param {object} [host]
 * @returns {object}
 */
// Bare coreutils used by the install script below. The sandbox is fully
// hermetic — even `mkdir`/`tar` must be declared tools, not resolved from an
// ambient or fixed-base PATH. Bare `sh` only auto-resolves on unix (see
// BUILTIN_SHELL_CANDIDATES in src/exec.rs), so Windows needs `sh` (Git Bash)
// declared as a tool too.
function coreToolNames(plat) {
	return [
		...new Set([
			...lockedDownloadTools(plat),
			...extractArchiveTools(plat.os === "windows" ? "zip" : "tar.gz"),
		]),
	];
}

export class CmakeToolchain extends Toolchain {
	static kind = "cmake-toolchain";
	static tool = CMAKE_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: CmakeToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return cmakeBin(this.attrs.version);
	}
}

// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetCmakeToolchainStateForTest() {
	CmakeToolchain.clearDefault();
	coreToolHandles = null;
}

/**
 * Declare a CMake toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this CMake toolchain.
 * @category configuration
 */
export function cmakeToolchain(version, opts = {}) {
	namedCache({ name: CMAKE_TOOLCHAIN_CACHE, shared: true });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new CmakeToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
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
 * Acquire a CMake toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export async function acquireCmakeToolchain(version) {
	const plat = platformInfo();
	const key = cmakeCacheKey(version, plat);

	if (cacheHas(CMAKE_TOOLCHAIN_CACHE, key)) {
		return cacheGet(CMAKE_TOOLCHAIN_CACHE, key);
	}
	if (!coreToolHandles) {
		throw new Error(
			"no CMake toolchain declared via cmakeToolchain(); nothing to acquire",
		);
	}

	const coreTools = await Promise.all(
		coreToolHandles.map((handle) => nativeToolSpec(handle)),
	);

	const downloadPath = `.imp/cmake-downloads/${key}/${cmakeArtifactName(version, plat)}`;
	await downloadToolArtifact({
		lockfile: CMAKE_LOCKFILE,
		tool: "cmake",
		version,
		plat,
		url: cmakeDownloadUrl(version, plat),
		downloadPath,
		tools: coreTools,
		display: `download cmake ${version} (${plat.os}/${plat.arch})`,
		unverified: CmakeToolchain.resolveUnverified(version),
	});

	await extractArchive({
		archive: downloadPath,
		dest: `.imp/cmake-toolchains/${key}`,
		format: plat.os === "windows" ? "zip" : "tar.gz",
		stripComponents: 1,
		tools: coreTools,
		namedCache: { name: CMAKE_TOOLCHAIN_CACHE, key },
		display: `install cmake ${version} (${plat.os}/${plat.arch})`,
	});

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
	if (!resolved) {
		return "cmake";
	}
	const dir = await acquireCmakeToolchain(resolved);
	const exe = platformInfo().os === "windows" ? "cmake.exe" : "cmake";
	return `${dir}/bin/${exe}`;
}

/**
 * Return a named-cache-backed CMake tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function cmakeTool(version) {
	const resolved = CmakeToolchain.requireVersion(version, "CMake");
	await acquireCmakeToolchain(resolved);
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

/**
 * Return the currently configured default CMake toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultCmakeToolchain() {
	return CmakeToolchain.default();
}

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "cmake",
		platforms: cmakeSupportedPlatforms(),
		downloadUrl: cmakeDownloadUrl,
		artifactName: cmakeArtifactName,
		lockfile: CMAKE_LOCKFILE,
	},
	["3.31.0"],
);
product(CmakeToolchain, GEN_LOCKFILES, CMAKE_TOOL, (handle) =>
	generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
);
