import {
	Toolchain,
	product,
	namedCache,
	memo,
	run,
	output,
	output_path,
	platformInfo,
	cachePut,
	cacheGet,
	cacheHas,
	toolName,
	group,
} from "imp:core";

import { nativeTool, nativeToolSpec } from "//rules/imp/native-tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering zig-driven products.
export const ZIG_TOOL = toolName("zig");

const ZIG_TOOLCHAIN_CACHE = "zig-toolchains";
const ZIG_LOCKFILE = "//rules/c/zig/zig.lock";
// Zig lazily JIT-compiles its own runtime support code (compiler-rt, libc
// start files, std for the `zig cc`/`zig c++` frontend) into
// $ZIG_GLOBAL_CACHE_DIR on first use per (version, target, flags) — content-
// addressed by what it's compiling, never by *our* source, so sharing it
// across sandboxes can only make builds faster or byte-identical, never
// wrong (verified: a real source change still forces a real recompile, and
// concurrent writers are safe — Zig's cache uses lock files). Left at its
// default ($HOME/.cache/zig), it instead rides the per-sandbox HOME every
// run() gets (see src/exec.rs's sandbox_home_tmp) — freshly empty each time
// — so every build both re-pays the ~12s compiler-rt build *and* bakes a
// different ephemeral sandbox path into that runtime code's own debug info,
// which is exactly the kind of non-reproducibility -ffile-prefix-map alone
// can't fix (it only covers paths in the translation unit imp itself asks
// Zig to compile, not Zig's own internal one-time builds). Pinning this to a
// named cache — the same mechanism CARGO_HOME already uses for cargo's own
// registry/build cache — makes it a stable, symlinked, real directory that's
// mounted (not copied) into every sandbox, so it's both reproducible and
// reused.
const ZIG_BUILD_CACHE = "zig-build-cache";

function requireSupportedPlatform(plat) {
	if (plat.os !== "linux" && plat.os !== "windows") {
		throw new Error(`unsupported Zig toolchain OS: ${plat.os}`);
	}
	if (plat.arch !== "x86_64" && plat.arch !== "aarch64") {
		throw new Error(`unsupported Zig toolchain architecture: ${plat.arch}`);
	}
}

// Zig release archives were named zig-<os>-<arch>-<version> through 0.14.0,
// then switched to zig-<arch>-<os>-<version> starting with 0.14.1. Anything
// that doesn't parse as a plain x.y.z release (e.g. a "master"/dev build
// string) is treated as current-naming.
function usesLegacyArtifactOrder(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const [, major, minor, patch] = match.map(Number);
	if (major !== 0) return false;
	return minor < 14 || (minor === 14 && patch === 0);
}

/**
 * Return the Zig release artifact filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zigArtifactName(version, plat) {
	requireSupportedPlatform(plat);
	const ext = plat.os === "windows" ? "zip" : "tar.xz";
	const [first, second] = usesLegacyArtifactOrder(version)
		? [plat.os, plat.arch]
		: [plat.arch, plat.os];
	return `zig-${first}-${second}-${version}.${ext}`;
}

/**
 * Return the Zig release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zigDownloadUrl(version, plat) {
	return `https://ziglang.org/download/${version}/${zigArtifactName(version, plat)}`;
}

// The platforms this module acquires Zig for (see requireSupportedPlatform):
// Linux and Windows on x86_64/aarch64. Zig ships macOS too, but that isn't
// wired here, so it stays out of the lockfile matrix.
const ZIG_SUPPORTED_PLATFORMS = [
	{ os: "linux", arch: "x86_64" },
	{ os: "linux", arch: "aarch64" },
	{ os: "windows", arch: "x86_64" },
	{ os: "windows", arch: "aarch64" },
];

/**
 * Return the platforms this module resolves Zig release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function zigSupportedPlatforms() {
	return ZIG_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

/**
 * Return the named-cache key for a Zig toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function zigCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

// Bare coreutils used by the download/extract scripts below. The sandbox is
// fully hermetic — even `mkdir`/`dirname`/`tar` must be declared tools, not
// resolved from an ambient or fixed-base PATH. GNU tar shells out to a
// separate `xz` process to decompress `.tar.xz` on Linux; Windows extracts
// the `.zip` release via `tar.exe` (bsdtar) directly. Bare `sh` only
// auto-resolves on unix (see BUILTIN_SHELL_CANDIDATES in src/exec.rs), so
// Windows needs `sh` (Git Bash) declared as a tool too.
function coreToolNames(plat) {
	return [
		...new Set([
			...lockedDownloadTools(plat),
			"tar",
			...(plat.os === "linux" ? ["xz", "chmod"] : []),
			...(plat.os === "windows" ? ["sh"] : []),
		]),
	];
}

function wrapperContent(plat, zigExe, subcommand) {
	return plat.os === "windows"
		? `@"%~dp0${zigExe}" ${subcommand} %*\r\n`
		: `#!/bin/sh\nexec "$(dirname "$0")/${zigExe}" ${subcommand} "$@"\n`;
}

/**
 * Return the CMAKE_AR / CMAKE_RANLIB wrapper script filenames for a
 * platform (unix: executable shell scripts; windows: .bat files, since
 * CMAKE_AR/CMAKE_RANLIB must each be a single executable — unlike
 * CMAKE_<LANG>_COMPILER, there is no "extra arg" mechanism for them).
 *
 * Also includes generically-named `clang`/`ar` wrappers (unix) or
 * `clang.bat`/`ar.bat` (windows) alongside the zig-prefixed ones — for
 * callers (e.g. Odin) that invoke a hardcoded program name rather than
 * accepting a configurable compiler/archiver path.
 *
 * @param {{ os: string }} plat
 * @returns {{ ar: string, ranlib: string, clang: string, genericAr: string }}
 */
function wrapperNames(plat) {
	return plat.os === "windows"
		? {
				ar: "zigar.bat",
				ranlib: "zigranlib.bat",
				clang: "clang.bat",
				genericAr: "ar.bat",
			}
		: { ar: "zigar", ranlib: "zigranlib", clang: "clang", genericAr: "ar" };
}

export class ZigToolchain extends Toolchain {
	static kind = "zig-toolchain";
	static tool = ZIG_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: ZigToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return zigBin(this.attrs.version);
	}
}

// Declared lazily, once, the first time a toolchain is declared — target()
// addresses are only assigned at workspace-load time, so this must happen
// at BUILD.js top level rather than inside acquireToolchain() at execution time.
let coreToolHandles = null;

export function __resetZigToolchainStateForTest() {
	ZigToolchain.clearDefault();
	coreToolHandles = null;
}

/**
 * Declare a Zig toolchain version and optionally set it as the default.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this Zig toolchain.
 * @category configuration
 */
export function zigToolchain(version, opts = {}) {
	namedCache({ name: ZIG_TOOLCHAIN_CACHE, shared: true });
	namedCache({ name: ZIG_BUILD_CACHE });
	if (!coreToolHandles) {
		coreToolHandles = coreToolNames(platformInfo()).map((name) =>
			nativeTool(name),
		);
	}

	return new ZigToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
}

/**
 * Install a local Zig toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installZigToolchain(version, source) {
	namedCache({ name: ZIG_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = zigCacheKey(version, plat);
	cachePut(ZIG_TOOLCHAIN_CACHE, key, source);
	return cacheGet(ZIG_TOOLCHAIN_CACHE, key);
}

/**
 * Acquire a Zig toolchain, downloading and caching it if not already
 * installed in the named cache.
 *
 * @param {string} version
 * @returns {Promise<string>} Local path to the toolchain root.
 */
export const acquireZigToolchain = memo(
	async function acquireZigToolchain(version) {
		const plat = platformInfo();
		const key = zigCacheKey(version, plat);

		// Both caches must be present, not just the toolchain download — mirrors
		// acquireRustToolchain's RUSTUP_HOME_CACHE/CARGO_HOME_CACHE pairing, and
		// means a toolchain seeded via installZigToolchain() (which only ever
		// populates ZIG_TOOLCHAIN_CACHE) still gets ZIG_BUILD_CACHE backfilled
		// by the prewarm step below on first real use, rather than leaving
		// zigBuildCacheTool() pointed at a directory that was never created.
		if (cacheHas(ZIG_TOOLCHAIN_CACHE, key) && cacheHas(ZIG_BUILD_CACHE, key)) {
			return cacheGet(ZIG_TOOLCHAIN_CACHE, key);
		}
		if (!coreToolHandles) {
			throw new Error(
				"no Zig toolchain declared via zigToolchain(); nothing to acquire",
			);
		}

		const coreTools = await group(
			coreToolHandles.map((handle) => nativeToolSpec(handle)),
		);

		if (!cacheHas(ZIG_TOOLCHAIN_CACHE, key)) {
			const downloadPath = `.imp/zig-downloads/${key}/${zigArtifactName(version, plat)}`;
			await downloadToolArtifact({
				lockfile: ZIG_LOCKFILE,
				tool: "zig",
				version,
				plat,
				url: zigDownloadUrl(version, plat),
				downloadPath,
				tools: coreTools,
				display: `download zig ${version} (${plat.os}/${plat.arch})`,
				unverified: ZigToolchain.resolveUnverified(version),
			});

			const extractPath = `.imp/zig-toolchains/${key}`;
			const zigExe = plat.os === "windows" ? "zig.exe" : "zig";
			const { ar, ranlib, clang, genericAr } = wrapperNames(plat);
			// Wrapper content rides in argv (positional $N) so it keys the task
			// cache without any shell interpolation touching it, same pattern as
			// odinGenRun's generated-file writes. Each wrapper is a
			// (content, filename) positional pair after $1 (archive)/$2 (extractPath).
			const wrappers = [
				[wrapperContent(plat, zigExe, "ar"), ar],
				[wrapperContent(plat, zigExe, "ranlib"), ranlib],
				[wrapperContent(plat, zigExe, "cc"), clang],
				[wrapperContent(plat, zigExe, "ar"), genericAr],
			];
			const wrapperArgs = wrappers.flat();
			// Shell positional params past $9 need brace syntax ($10, not $10
			// which parses as ${1}0).
			const pos = (n) => (n >= 10 ? `\${${n}}` : `$${n}`);
			const writeCmds = wrappers.map(
				(_, i) => `printf %s "${pos(3 + i * 2)}" > "$2/${pos(4 + i * 2)}"`,
			);
			const chmodCmd =
				plat.os === "windows"
					? ""
					: ` && ${wrappers.map((_, i) => `chmod +x "$2/${pos(4 + i * 2)}"`).join(" && ")}`;
			// tar can't sniff compression from a pipe, so -J (xz) must be
			// explicit on the tar.xz (unix) release; the windows .zip release
			// isn't a filter format, so plain -xf works.
			const tarFlags = plat.os === "windows" ? "-xf" : "-xJf";
			const installScript = `mkdir -p "$2" && tar ${tarFlags} "$1" -C "$2" --strip-components=1 && ${writeCmds.join(" && ")}${chmodCmd}`;

			await run({
				argv: [
					"sh",
					"-c",
					installScript,
					"install-zig",
					downloadPath,
					extractPath,
					...wrapperArgs,
				],
				tools: coreTools,
				inputs: [{ kind: "file", path: downloadPath }],
				outputs: [
					output(output_path(extractPath), {
						kind: "directory",
						namedCache: { name: ZIG_TOOLCHAIN_CACHE, key },
					}),
				],
				materialize: false,
				display: `install zig ${version} (${plat.os}/${plat.arch})`,
			});
		}

		// Seed ZIG_BUILD_CACHE with a real, populated directory: a "tool" mount
		// (see zigBuildCacheTool below) requires its named-cache path to already
		// exist as a directory (materialize_tools_into_sandbox in src/exec.rs
		// bails otherwise), and this repo's own real cmakeLib usage always
		// compiles with `-g -shared -fPIC`, so link a throwaway shared library
		// with those exact flags to force Zig to build and cache compiler-rt/
		// libc-start objects right now — turning the ~12s first-ever cost every
		// zig-cc build would otherwise separately pay (once per sandbox, since
		// sandboxes don't share state) into a one-time toolchain-acquisition
		// cost instead. Guarded independently of the early cacheHas() return
		// above so upgrading an existing zig-toolchains cache that predates this
		// still backfills zig-build-cache.
		if (!cacheHas(ZIG_BUILD_CACHE, key)) {
			const zigToolForPrewarm = {
				kind: "tool",
				name: "zig",
				cache: ZIG_TOOLCHAIN_CACHE,
				key,
				binDirs: ["."],
			};
			const buildCacheSeedDir = `.imp/zig-build-cache/${key}`;
			const prewarmSrcPath = `.imp/zig-build-cache-prewarm/${key}/prewarm.c`;
			const prewarmScript =
				"srcfile=$1; cachedir=$2; body=$3; " +
				'mkdir -p "$(dirname "$srcfile")" "$cachedir" && ' +
				'printf %s "$body" > "$srcfile" && ' +
				'ZIG_GLOBAL_CACHE_DIR="$cachedir" zig cc -g -shared -fPIC -o "$(dirname "$srcfile")/prewarm.out" "$srcfile"';
			const prewarmBody =
				"int imp_zig_build_cache_prewarm(int a, int b) { return a + b; }\n";

			await run({
				argv: [
					"sh",
					"-c",
					prewarmScript,
					"zig-build-cache-prewarm",
					prewarmSrcPath,
					buildCacheSeedDir,
					prewarmBody,
				],
				tools: [...coreTools, zigToolForPrewarm],
				outputs: [
					output(output_path(buildCacheSeedDir), {
						kind: "directory",
						namedCache: { name: ZIG_BUILD_CACHE, key },
					}),
				],
				materialize: false,
				display: `prewarm zig build cache ${version} (${plat.os}/${plat.arch})`,
			});
		}

		return cacheGet(ZIG_TOOLCHAIN_CACHE, key);
	},
	{ display: "acquire Zig Toolchain {0}", level: "info" },
);

/**
 * Resolve an explicit or default Zig toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveZigToolchainVersion(version) {
	return ZigToolchain.resolveVersion(version);
}

/**
 * Return the zig executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function zigBin(version) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	const dir = await acquireZigToolchain(resolved);
	const exe = platformInfo().os === "windows" ? "zig.exe" : "zig";
	return `${dir}/${exe}`;
}

/**
 * Return a named-cache-backed Zig tool descriptor for sandbox execution.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function zigTool(version) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	await acquireZigToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: "zig",
		cache: ZIG_TOOLCHAIN_CACHE,
		key: zigCacheKey(resolved, plat),
		binDirs: ["."],
	};
}

/**
 * Return a named-cache-backed tool descriptor mounting Zig's own runtime
 * build cache (compiler-rt, libc start objects, etc. — see ZIG_BUILD_CACHE's
 * doc comment) at a stable path, shared read-write across every sandbox for
 * this Zig version/platform. Not put on PATH (binDirs empty) — pair with
 * zigGlobalCacheEnv() to point $ZIG_GLOBAL_CACHE_DIR at its mount path.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function zigBuildCacheTool(version) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	await acquireZigToolchain(resolved);
	const plat = platformInfo();
	return {
		kind: "tool",
		name: ZIG_BUILD_CACHE,
		cache: ZIG_BUILD_CACHE,
		key: zigCacheKey(resolved, plat),
		binDirs: [],
	};
}

/**
 * Return the `run()` env entries pointing Zig at its shared build-cache tool
 * mount (see zigBuildCacheTool). Any run() using this must also include that
 * tool, or the path won't exist in the sandbox.
 *
 * @returns {string[]}
 */
export function zigGlobalCacheEnv() {
	return [`ZIG_GLOBAL_CACHE_DIR=.imp/tools/${ZIG_BUILD_CACHE}`];
}

/**
 * Return the CMake -D flags to configure this Zig toolchain as the C/C++
 * compiler and archiver.
 *
 * @param {string} [version]
 * @returns {Promise<string[]>}
 */
export async function zigCMakeArgs(version) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	await acquireZigToolchain(resolved);
	const plat = platformInfo();
	const exe = plat.os === "windows" ? "zig.exe" : "zig";
	const { ar, ranlib } = wrapperNames(plat);
	const toolDir = ".imp/tools/zig";
	return [
		`-DCMAKE_C_COMPILER=${exe}`,
		"-DCMAKE_C_COMPILER_ARG1=cc",
		`-DCMAKE_CXX_COMPILER=${exe}`,
		"-DCMAKE_CXX_COMPILER_ARG1=c++",
		`-DCMAKE_AR=${toolDir}/${ar}`,
		`-DCMAKE_RANLIB=${toolDir}/${ranlib}`,
	];
}

/**
 * Return the currently configured default Zig toolchain version.
 *
 * @returns {string|null}
 */
export function defaultZigToolchainVersion() {
	return ZigToolchain.defaultVersion();
}

/**
 * Return the currently configured default Zig toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultZigToolchain() {
	return ZigToolchain.default();
}

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another zigToolchain(..., { default: true }).
zigToolchain("0.16.0", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "zig",
		platforms: zigSupportedPlatforms(),
		downloadUrl: zigDownloadUrl,
		artifactName: zigArtifactName,
		lockfile: ZIG_LOCKFILE,
	},
	["0.16.0"],
);
product(
	ZigToolchain,
	GEN_LOCKFILES,
	ZIG_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
);
