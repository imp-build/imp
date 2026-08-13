import {
	Toolchain,
	product,
	namedCache,
	output,
	platformInfo,
	cachePut,
	cacheGet,
	toolName,
	task,
	tool as graphTool,
} from "imp:core";

import { nativeTool } from "//rules/imp/native-tool";
import {
	downloadToolArtifact,
	lockedDownloadTools,
} from "//rules/imp/lockfile";
import { toolchainBin } from "//rules/imp/toolchain";
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

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetZigToolchainStateForTest() {
	ZigToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? zigGraphTool(version);
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
	const toolchain = new ZigToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	graphToolchains.set(version, zigGraphTool(version));
	return toolchain;
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
 * Build the managed Zig distribution as a graph-native tool, writing the
 * ar/ranlib/clang wrapper scripts alongside it (see wrapperNames()/
 * wrapperContent() above for the exact set and content).
 */
export function zigGraphTool(version) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	const plat = platformInfo();
	namedCache({ name: ZIG_TOOLCHAIN_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: ZIG_LOCKFILE,
		tool: "zig",
		version: resolved,
		plat,
		url: zigDownloadUrl(resolved, plat),
		output: `zig-downloads/${zigCacheKey(resolved, plat)}/${zigArtifactName(resolved, plat)}`,
		display: `download zig ${resolved} (${plat.os}/${plat.arch})`,
		unverified: ZigToolchain.resolveUnverified(resolved),
	});
	const zigExe = plat.os === "windows" ? "zig.exe" : "zig";
	const { ar, ranlib, clang, genericAr } = wrapperNames(plat);
	const wrappers = [
		[wrapperContent(plat, zigExe, "ar"), ar],
		[wrapperContent(plat, zigExe, "ranlib"), ranlib],
		[wrapperContent(plat, zigExe, "cc"), clang],
		[wrapperContent(plat, zigExe, "ar"), genericAr],
	];
	const wrapperArgs = wrappers.flat();
	// Shell positional params past $9 need brace syntax ($10, not $10 which
	// parses as ${1}0).
	const pos = (n) => (n >= 10 ? `\${${n}}` : `$${n}`);
	const writeCmds = wrappers.map(
		(_, i) => `printf %s "${pos(3 + i * 2)}" > "$2/${pos(4 + i * 2)}"`,
	);
	const chmodCmd =
		plat.os === "windows"
			? ""
			: ` && ${wrappers.map((_, i) => `chmod +x "$2/${pos(4 + i * 2)}"`).join(" && ")}`;
	// tar can't sniff compression from a pipe, so -J (xz) must be explicit on
	// the tar.xz (unix) release; the windows .zip release isn't a filter
	// format, so plain -xf works.
	const tarFlags = plat.os === "windows" ? "-xf" : "-xJf";
	const installScript = `mkdir -p "$2" && tar ${tarFlags} "$1" -C "$2" --strip-components=1 && ${writeCmds.join(" && ")}${chmodCmd}`;

	const toolNames = coreToolNames(plat);
	const inputs = { archive };
	for (const [index, name] of toolNames.entries()) {
		inputs[`tool${index}`] = nativeTool(name);
	}
	const directory = task({
		display: `install zig ${resolved} (${plat.os}/${plat.arch})`,
		inputs,
		outputs: { directory: output.artifact() },
		async run(exec, resolvedInputs) {
			const tools = toolNames.map((_, index) => resolvedInputs[`tool${index}`]);
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					installScript,
					"install-zig",
					exec.path(resolvedInputs.archive),
					"zig-toolchain",
					...wrapperArgs,
				],
				tools,
				outputs: {
					directory: output.directory("zig-toolchain", {
						namedCache: {
							name: ZIG_TOOLCHAIN_CACHE,
							key: zigCacheKey(resolved, plat),
						},
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	}).outputs.directory;
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Build the prewarmed Zig runtime build-cache directory as a graph-native
 * tool, given an already-built zigGraphTool() handle. Not put on PATH
 * (binDirs empty) — pair with zigGraphCacheEnv() to point
 * $ZIG_GLOBAL_CACHE_DIR at its mount.
 *
 * Zig lazily JIT-compiles its own runtime support code (compiler-rt, libc
 * start files, std for the `zig cc`/`zig c++` frontend) into
 * $ZIG_GLOBAL_CACHE_DIR on first use per (version, target, flags) — content-
 * addressed by what it is compiling, never by *our* source, so sharing it
 * across sandboxes can only make builds faster or byte-identical, never
 * wrong (verified: a real source change still forces a real recompile, and
 * concurrent writers are safe — Zig's cache uses lock files). Left at its
 * default ($HOME/.cache/zig), it instead rides the per-sandbox HOME every
 * action gets (see sandbox_home_tmp in crates/imp-execution/src/exec.rs) —
 * freshly empty each time — so every build both re-pays the ~12s compiler-rt
 * build *and* bakes a different ephemeral sandbox path into that runtime
 * code's own debug info, which is exactly the kind of non-reproducibility
 * -ffile-prefix-map alone cannot fix (it only covers paths in the translation
 * unit imp itself asks Zig to compile, not Zig's own internal one-time
 * builds). Building it as a task output makes it a stable, content-addressed
 * directory mounted into every sandbox, so it is both reproducible and
 * reused.
 */
function zigGraphBuildCacheTool(version, zigTool) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	const plat = platformInfo();
	const mkdir = nativeTool("mkdir");
	const directory = task({
		display: `prewarm zig build cache ${resolved} (${plat.os}/${plat.arch})`,
		inputs: { zigTool, mkdir },
		outputs: { directory: output.artifact() },
		async run(exec, resolvedInputs) {
			// zigTool is a produced tool() binding (zigGraphTool()'s own
			// install task output) — it can't be listed in exec.action()'s
			// `tools:` array (only native tool bindings/legacy tool specs can;
			// see gccRustLinkDriverEnv()'s docstring in //rules/c/gcc for the
			// same constraint and a confirmed real-build failure). exec.tool()
			// resolves its absolute path instead, used directly in place of a
			// bare "zig" the script would otherwise need PATH to find.
			const zigExe = exec.tool(resolvedInputs.zigTool, "zig");
			// srcDir/srcfile are fixed literals (not derived from user input),
			// so the script can avoid needing a `dirname` tool mounted at all.
			const srcDir = "zig-build-cache-prewarm";
			const srcfile = `${srcDir}/prewarm.c`;
			const prewarmScript =
				"srcdir=$1; srcfile=$2; cachedir=$3; body=$4; zig=$5; " +
				'mkdir -p "$srcdir" "$cachedir" && ' +
				'printf %s "$body" > "$srcfile" && ' +
				'ZIG_GLOBAL_CACHE_DIR="$cachedir" "$zig" cc -g -shared -fPIC -o "$srcdir/prewarm.out" "$srcfile"';
			const prewarmBody =
				"int imp_zig_build_cache_prewarm(int a, int b) { return a + b; }\n";
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					prewarmScript,
					"zig-build-cache-prewarm",
					srcDir,
					srcfile,
					"zig-build-cache",
					prewarmBody,
					zigExe,
				],
				tools: [resolvedInputs.mkdir],
				outputs: { directory: output.directory("zig-build-cache") },
			});
			return { directory: result.outputs.directory };
		},
	}).outputs.directory;
	return graphTool(directory, { binDirs: [] });
}

/**
 * Graph-native Zig toolchain: zigGraphTool() plus its prewarmed build-cache
 * tool, mirroring rustGraphToolchain()'s two-directory shape (//rules/rust/
 * toolchain) — Zig, like Rust, needs a second directory beyond the compiler
 * install itself. Has no Rust-facing role (unlike gcc/mold): this exists to
 * support raw C/C++ consumption of Zig directly.
 *
 * @param {string} [version]
 * @returns {{ tool: object, buildCacheTool: object, version: string }}
 */
export function zigGraphToolchain(version) {
	const resolved = ZigToolchain.requireVersion(version, "Zig");
	const tool = zigGraphTool(resolved);
	return Object.freeze({
		tool,
		buildCacheTool: zigGraphBuildCacheTool(resolved, tool),
		version: resolved,
	});
}

/**
 * Return the currently configured default Zig toolchain as graph-native
 * handles, or null if none is declared.
 *
 * @returns {object|null}
 */
export function defaultZigGraphToolchain() {
	const version = ZigToolchain.defaultVersion();
	return version ? zigGraphToolchain(version) : null;
}

/**
 * Graph-native sibling of zigGlobalCacheEnv(): given a task's `exec` and its
 * already-declared, resolved `zigGraphToolchain().buildCacheTool` input,
 * resolve the $ZIG_GLOBAL_CACHE_DIR env entry pointing Zig at its shared
 * build-cache tool mount.
 *
 * @param {object} exec Task's exec (see task()'s run(exec, resolved) body).
 * @param {object} resolvedBuildCacheTool Resolved `zigGraphToolchain().buildCacheTool` input.
 * @returns {string[]}
 */
export function zigGraphCacheEnv(exec, resolvedBuildCacheTool) {
	return [`ZIG_GLOBAL_CACHE_DIR=${exec.path(resolvedBuildCacheTool)}`];
}

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
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: ZIG_TOOLCHAIN_CACHE,
		key: zigCacheKey(resolved, plat),
		exe: plat.os === "windows" ? "zig.exe" : "zig",
	});
}

/**
 * Return the currently configured default Zig toolchain version.
 *
 * @returns {string|null}
 */
export function defaultZigToolchainVersion() {
	return ZigToolchain.defaultVersion();
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
