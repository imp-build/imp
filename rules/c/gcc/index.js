import {
	Toolchain,
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
import { downloadToolArtifact } from "//rules/imp/lockfile";
import { toolchainBin, toolchainToolSpec } from "//rules/imp/toolchain";
import {
	graphGenerateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering gcc-driven products.
export const GCC_TOOL = toolName("gcc");

const GCC_TOOLCHAIN_CACHE = "gcc-toolchains";
const GCC_LOCKFILE = "//rules/c/gcc/gcc.lock";
const GCC_WINDOWS_LOCKFILE = "//rules/c/gcc/gcc-windows.lock";

// Linux downloads a Bootlin cross-toolchain; Windows downloads a WinLibs
// mingw-w64 build (see winlibsDownloadUrl() below) — two unrelated vendors
// with unrelated version-tag schemes, not a single formula across OSes.
function requireSupportedPlatform(plat) {
	if (plat.os !== "linux" && plat.os !== "windows") {
		throw new Error(`unsupported gcc toolchain OS: ${plat.os}`);
	}
	if (plat.arch !== "x86_64") {
		throw new Error(`unsupported gcc toolchain architecture: ${plat.arch}`);
	}
}

// Bootlin's own arch naming (e.g. "x86-64", not "x86_64"), the short prefix
// used by the toolchain's own convenience aliases (e.g. "x86_64-linux-gcc"),
// and the full buildroot prefix used by its real binutils binaries (which
// aren't given a short alias, e.g. "x86_64-buildroot-linux-gnu-ar").
const BOOTLIN_ARCH = { x86_64: "x86-64" };
const GCC_EXE_PREFIX = { x86_64: "x86_64-linux" };
const BINUTILS_PREFIX = { x86_64: "x86_64-buildroot-linux-gnu" };

// WinLibs (winlibs.com) publishes prebuilt, self-contained mingw-w64 GCC
// builds for native Windows use — UCRT runtime, POSIX threading, SEH
// exceptions, x86_64 only — as GitHub release assets. Its release tag
// doubles as both the GitHub Releases URL path segment and (after a fixed
// rewrite) the archive filename, e.g. tag "16.1.0posix-14.0.0-ucrt-r4"
// downloads "winlibs-x86_64-posix-seh-gcc-16.1.0-mingw-w64ucrt-14.0.0-r4.zip".
// Unlike Bootlin's version string, this tag packs three independent version
// numbers (GCC, the mingw-w64 runtime, and WinLibs' own build revision) with
// no formula linking it to a bare GCC version — so a Windows gcc toolchain
// "version" is this tag, verbatim, not a plain GCC release number.
const WINLIBS_TAG_RE = /^(\d+\.\d+\.\d+)posix-(\d+\.\d+\.\d+)-ucrt-r(\d+)$/;

function winlibsArtifactName(version) {
	const match = WINLIBS_TAG_RE.exec(version);
	if (!match) {
		throw new Error(
			`gcc toolchain version '${version}' doesn't look like a WinLibs release tag (expected e.g. "16.1.0posix-14.0.0-ucrt-r4")`,
		);
	}
	const [, gccVersion, mingwVersion, rev] = match;
	return `winlibs-x86_64-posix-seh-gcc-${gccVersion}-mingw-w64ucrt-${mingwVersion}-r${rev}.zip`;
}

function winlibsDownloadUrl(version) {
	return `https://github.com/brechtsanders/winlibs_mingw/releases/download/${version}/${winlibsArtifactName(version)}`;
}

/**
 * Return the toolchain archive filename for a version and platform: a
 * Bootlin tarball name on Linux, a WinLibs zip name on Windows.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccArtifactName(version, plat) {
	requireSupportedPlatform(plat);
	if (plat.os === "windows") {
		return winlibsArtifactName(version);
	}
	return `${BOOTLIN_ARCH[plat.arch]}--glibc--stable-${version}.tar.xz`;
}

/**
 * Return the toolchain download URL for a version and platform: Bootlin on
 * Linux, WinLibs on Windows.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccDownloadUrl(version, plat) {
	requireSupportedPlatform(plat);
	if (plat.os === "windows") {
		return winlibsDownloadUrl(version);
	}
	return `https://toolchains.bootlin.com/downloads/releases/toolchains/${BOOTLIN_ARCH[plat.arch]}/tarballs/${gccArtifactName(version, plat)}`;
}

/**
 * Return the platforms Bootlin publishes a prebuilt gcc toolchain for. Bootlin
 * only ships Linux; the arch set comes from the module's BOOTLIN_ARCH map.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function gccSupportedPlatforms() {
	return Object.keys(BOOTLIN_ARCH).map((arch) => ({ os: "linux", arch }));
}

/**
 * Return the named-cache key for a gcc toolchain version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccCacheKey(version, plat) {
	return `${version}/${plat.os}-${plat.arch}`;
}

export class GccToolchain extends Toolchain {
	static kind = "gcc-toolchain";
	static tool = GCC_TOOL;
	constructor({ version, unverified }, opts) {
		super(
			{
				kind: GccToolchain.kind,
				attrs: { version, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return gccBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, so anything that resolves a toolchain while
// the graph is running must find a handle here rather than build one.
let graphToolchains = new Map();

export function __resetGccToolchainStateForTest() {
	GccToolchain.clearDefault();
	graphToolchains = new Map();
}

function graphToolFor(version) {
	return graphToolchains.get(version) ?? gccGraphTool(version);
}

/**
 * Declare a gcc toolchain version and optionally set it as the default.
 *
 * @param {string|{linux?: string, windows?: string}} version Bootlin
 *   toolchain release version on Linux (e.g. "2025.08-1"), WinLibs release
 *   tag on Windows (e.g. "16.1.0posix-14.0.0-ucrt-r4") — see
 *   requireSupportedPlatform's own comment for why these don't share a
 *   vocabulary. A plain string is used as-is for whichever platform is
 *   active; pass an object keyed by os to pin both platforms from one call
 *   (see this module's own pinned default at the bottom of the file).
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this gcc toolchain.
 * @category configuration
 */
export function gccToolchain(version, opts = {}) {
	const plat = platformInfo();
	const resolved = typeof version === "string" ? version : version[plat.os];
	if (!resolved) {
		throw new Error(
			`gcc toolchain version has no entry for platform '${plat.os}'`,
		);
	}
	const toolchain = new GccToolchain(
		{ version: resolved, unverified: opts.unverified },
		{ default: opts.default },
	);
	const lockfileSpec =
		plat.os === "windows" ? LOCKFILE_SPEC_WINDOWS : LOCKFILE_SPEC_LINUX;
	toolchain[GEN_LOCKFILES] = graphGenerateToolLockfile({
		version: resolved,
		...lockfileSpec,
	});
	graphToolchains.set(resolved, gccGraphTool(resolved));
	return toolchain;
}

/**
 * Build the managed GCC distribution as a graph-native tool.
 *
 * @param {string} version
 * @param {object} [opts]
 * @param {boolean} [opts.unsafeSystemPaths=false] Put the direct compiler
 *   launchers first on PATH instead of Bootlin's guard wrappers.
 */
export function gccGraphTool(version, { unsafeSystemPaths = false } = {}) {
	const resolved = GccToolchain.requireVersion(version);
	const plat = platformInfo();
	namedCache({ name: GCC_TOOLCHAIN_CACHE, shared: true });
	const cacheKey = gccCacheKey(resolved, plat);
	const archive = downloadToolArtifact({
		lockfile: plat.os === "windows" ? GCC_WINDOWS_LOCKFILE : GCC_LOCKFILE,
		tool: plat.os === "windows" ? "gcc-windows" : "gcc",
		version: resolved,
		plat,
		url: gccDownloadUrl(resolved, plat),
		output: `gcc-downloads/${gccCacheKey(resolved, plat)}/${gccArtifactName(resolved, plat)}`,
		display: `download gcc ${resolved} (${plat.os}/${plat.arch})`,
		unverified: GccToolchain.resolveUnverified(resolved),
	});
	if (plat.os === "windows") {
		return gccGraphToolWindows(
			resolved,
			plat,
			archive,
			cacheKey,
			unsafeSystemPaths,
		);
	}
	const shell = nativeTool("sh");
	const mkdir = nativeTool("mkdir");
	const tar = nativeTool("tar");
	const xz = nativeTool("xz");
	const chmod = nativeTool("chmod");
	const directory = task({
		display: `install gcc ${resolved} (${plat.os}/${plat.arch})`,
		inputs: { archive, shell, mkdir, tar, xz, chmod },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			// Bootlin's own gcc binary is a `toolchain-wrapper` that is argv[0]-
			// sensitive, so these wrapper scripts exec the real binary under its
			// own name. clang/cc -> gcc,
			// c++ -> g++, ar -> the *binutils*-prefixed ar, a different prefix
			// from gcc/g++ — see BINUTILS_PREFIX's own doc comment — confirmed
			// missing by two real `imp lint //crates/imp:imp` failures: rustc's
			// own link step only needs "clang", but cc-rs-driven build scripts
			// also need "ar" (no CC/CXX-shaped override for it) and this
			// toolchain's own CXX env value (below) points at "c++". "ranlib" is
			// needed so rules/c/cmake's graph-native replay can pin CMAKE_RANLIB
			// to this toolchain (see gccCMakeCompilerArgs() below) instead of
			// leaking whatever ranlib the
			// configuring host happens to have on PATH (#98).
			//
			// A second set of aliases ("clang-unsafe-paths"/"cc-unsafe-paths"/
			// "c++-unsafe-paths") execs the *.br_real binary directly instead of
			// Bootlin's own toolchain-wrapper, with the same --sysroot and
			// hardening flags the wrapper would otherwise inject (captured via
			// BR2_DEBUG_WRAPPER=1) baked in ahead of "$@". The wrapper hardcodes a
			// rejection of any -I/-isystem/-idirafter/-iquote/-L argument under
			// /usr/include or /usr/lib ("unsafe header/library path used in
			// cross-compilation") — a pure argv string check unrelated to the
			// actual compiler target — which blocks linking against system
			// packages like libwebkit2gtk-4.1. Targets opting into
			// unsafeSystemPaths (see rules/c/index.js, rules/c/cmake/graph_replay.js)
			// reference these aliases instead, keeping the same sysroot/hardening
			// behavior minus that one guard. ar/ranlib are real binutils binaries,
			// not wrapped, so they need no such alias.
			//
			// A sibling "bin-unsafe-paths/" directory mirrors "bin/" but under
			// the same bare names ("clang"/"cc"/"c++"/"ar"/"ranlib"), pointed at
			// the unsafe-paths targets — needed because Odin invokes a program
			// literally named "clang" via PATH lookup to link (see gccTool()'s
			// own docstring) with no flag to select a differently-named binary,
			// so opting an odinPackage() into unsafeSystemPaths works by putting
			// this directory on PATH instead of "bin/" (see rules/odin/index.js).
			// These are real scripts, not symlinks to the "bin/*-unsafe-paths"
			// ones: a script's own "$0" reflects the path it was *invoked* at,
			// not a symlink's target, so a symlinked script would resolve its
			// own "${0%/*}"-relative .br_real/sysroot paths against
			// "bin-unsafe-paths/" instead of "bin/" and fail to find them.
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'archive=$1; out=$2; gccPrefix=$3; binutilsPrefix=$4; mkdir -p "$out" && tar -xJf "$archive" -C "$out" --strip-components=1 && for pair in "clang:$gccPrefix-gcc" "cc:$gccPrefix-gcc" "c++:$gccPrefix-g++" "ar:$binutilsPrefix-ar" "ranlib:$binutilsPrefix-ranlib"; do name=${pair%%:*}; target=${pair#*:}; printf \'%s\\n\' \'#!/bin/sh\' "exec \\"\\${0%/*}/$target\\" \\"\\$@\\"" > "$out/bin/$name"; chmod +x "$out/bin/$name"; done && for pair in "clang-unsafe-paths:$binutilsPrefix-gcc.br_real" "cc-unsafe-paths:$binutilsPrefix-gcc.br_real" "c++-unsafe-paths:$binutilsPrefix-g++.br_real"; do name=${pair%%:*}; target=${pair#*:}; printf \'%s\\n\' \'#!/bin/sh\' "exec \\"\\${0%/*}/$target\\" --sysroot \\"\\${0%/*}/../$binutilsPrefix/sysroot\\" -fstack-protector-strong -fPIE -pie -Wl,-z,now -Wl,-z,relro \\"\\$@\\"" > "$out/bin/$name"; chmod +x "$out/bin/$name"; done && mkdir -p "$out/bin-unsafe-paths" && for pair in "clang:$binutilsPrefix-gcc.br_real" "cc:$binutilsPrefix-gcc.br_real" "c++:$binutilsPrefix-g++.br_real"; do name=${pair%%:*}; target=${pair#*:}; printf \'%s\\n\' \'#!/bin/sh\' "exec \\"\\${0%/*}/../bin/$target\\" --sysroot \\"\\${0%/*}/../$binutilsPrefix/sysroot\\" -fstack-protector-strong -fPIE -pie -Wl,-z,now -Wl,-z,relro \\"\\$@\\"" > "$out/bin-unsafe-paths/$name"; chmod +x "$out/bin-unsafe-paths/$name"; done && for pair in "ar:$binutilsPrefix-ar" "ranlib:$binutilsPrefix-ranlib"; do name=${pair%%:*}; target=${pair#*:}; printf \'%s\\n\' \'#!/bin/sh\' "exec \\"\\${0%/*}/../bin/$target\\" \\"\\$@\\"" > "$out/bin-unsafe-paths/$name"; chmod +x "$out/bin-unsafe-paths/$name"; done',
					"gcc-install",
					exec.path(inputs.archive),
					"gcc-toolchain",
					GCC_EXE_PREFIX[plat.arch],
					BINUTILS_PREFIX[plat.arch],
				],
				tools: [
					inputs.shell,
					inputs.mkdir,
					inputs.tar,
					inputs.xz,
					inputs.chmod,
				],
				outputs: {
					directory: output.directory("gcc-toolchain", {
						namedCache: { name: GCC_TOOLCHAIN_CACHE, key: cacheKey },
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	}).outputs.directory;
	return graphTool(directory, {
		binDirs: [unsafeSystemPaths ? "bin-unsafe-paths" : "bin"],
		mount: { name: "gcc-toolchain", cache: GCC_TOOLCHAIN_CACHE, key: cacheKey },
	});
}

/**
 * Windows counterpart of the install step above: extracts a WinLibs
 * mingw-w64 GCC release (a plain UCRT/POSIX/SEH x86_64 zip — no Bootlin-style
 * toolchain-wrapper/sysroot/hardening-flag machinery to replicate, since
 * MinGW's own binaries have no such guard to work around) and copies the
 * real gcc.exe/g++.exe into the clang/cc alias names other rules expect (see
 * the Linux install step's own comment for why those aliases exist: Odin
 * execs a program literally named "clang" to link, and rustc's C link driver
 * needs "clang"/"cc" too). ar.exe/ranlib.exe/c++.exe already ship under
 * their plain names in WinLibs' own bin/, so those need no aliasing. The
 * "-unsafe-paths" aliases and the bin-unsafe-paths/ mirror are plain copies
 * of the same binaries, not different flags — there's no Bootlin-style
 * unsafe-path guard on Windows to bypass, so unsafeSystemPaths is a no-op
 * here (mirrors zig's own toolchain, which has no such guard either).
 */
function gccGraphToolWindows(
	version,
	plat,
	archive,
	cacheKey,
	unsafeSystemPaths,
) {
	const shell = nativeTool("sh");
	const mkdir = nativeTool("mkdir");
	const cp = nativeTool("cp");
	const mv = nativeTool("mv");
	const unzip = nativeTool("unzip");
	// WinLibs ships a zip, not a tar archive, so this extracts with unzip —
	// not tar (Windows hosts two "tar"s that answer to the same bare name,
	// Git-for-Windows' bundled MSYS/GNU tar with no zip support at all and
	// the OS's own bsdtar, and which one wins is a PATH-order accident; see
	// rules/imp/archive's own comment). unzip has no such competing
	// alternative to accidentally shadow it. It also has no
	// --strip-components equivalent, so dropping the zip's wrapping
	// "mingw64/" directory means unpacking into a staging dir first and
	// moving its contents up — the same approach rules/imp/archive's
	// extractArchive() now uses for a zip's stripComponents.
	//
	// Bare "mkdir"/"cp"/"mv"/"unzip" inside the script would resolve through
	// Git-for-Windows' own self-prepended PATH (its usr/bin, ahead of
	// anything imp's sandbox itself puts on PATH) rather than the mounted
	// tools declared below. exec.tool() is no help here either: for a native
	// tool binding it's a pure passthrough of the bare executable name (see
	// graph_core.js's exec.tool()), not a real path. exec.path() does return
	// the tool's real resolved absolute path, so passing each tool that way
	// as an argv positional sidesteps the PATH-precedence hazard entirely.
	const installScript =
		"archive=$1; out=$2; mkdir=$3; cp=$4; mv=$5; unzip=$6; " +
		'"$mkdir" -p "$out/bin" "$out/bin-unsafe-paths" "$out.stage" && ' +
		'"$unzip" -q "$archive" -d "$out.stage" && ' +
		'"$mv" "$out.stage"/*/* "$out"/ && ' +
		'for pair in "clang:gcc" "cc:gcc" "clang-unsafe-paths:gcc" "cc-unsafe-paths:gcc" "c++-unsafe-paths:c++"; do ' +
		"name=${pair%%:*}; target=${pair#*:}; " +
		'"$cp" "$out/bin/$target.exe" "$out/bin/$name.exe"; ' +
		"done && " +
		"for name in clang cc c++ ar ranlib; do " +
		'"$cp" "$out/bin/$name.exe" "$out/bin-unsafe-paths/$name.exe"; ' +
		"done";
	const directory = task({
		display: `install gcc ${version} (${plat.os}/${plat.arch})`,
		inputs: { archive, shell, mkdir, cp, mv, unzip },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					installScript,
					"gcc-install",
					exec.path(inputs.archive),
					"gcc-toolchain",
					`${exec.path(inputs.mkdir)}/mkdir.exe`,
					`${exec.path(inputs.cp)}/cp.exe`,
					`${exec.path(inputs.mv)}/mv.exe`,
					`${exec.path(inputs.unzip)}/unzip.exe`,
				],
				tools: [inputs.shell, inputs.mkdir, inputs.cp, inputs.mv, inputs.unzip],
				outputs: {
					directory: output.directory("gcc-toolchain", {
						namedCache: { name: GCC_TOOLCHAIN_CACHE, key: cacheKey },
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	}).outputs.directory;
	return graphTool(directory, {
		binDirs: [unsafeSystemPaths ? "bin-unsafe-paths" : "bin"],
		mount: { name: "gcc-toolchain", cache: GCC_TOOLCHAIN_CACHE, key: cacheKey },
	});
}

/**
 * Graph-native gcc toolchain: gccGraphTool() wrapped with version metadata,
 * mirroring rustGraphToolchain()'s shape (//rules/rust/toolchain) but scaled
 * to gcc's single install directory (like Odin's one-directory case).
 *
 * @param {string} [version]
 * @returns {{ tool: object, version: string }}
 */
export function gccGraphToolchain(version) {
	const resolved = GccToolchain.requireVersion(version);
	return Object.freeze({
		tool: gccGraphTool(resolved),
		version: resolved,
	});
}

/**
 * Return the currently configured default gcc toolchain as graph-native
 * handles, or null if none is declared.
 *
 * @returns {object|null}
 */
export function defaultGccGraphToolchain() {
	const version = GccToolchain.defaultVersion();
	return version ? gccGraphToolchain(version) : null;
}

/**
 * Install a local gcc toolchain directory into the named cache.
 *
 * @param {string} version
 * @param {string} source Path to the toolchain root.
 * @returns {string|null} Local path to the cached toolchain root.
 */
export function installGccToolchain(version, source) {
	namedCache({ name: GCC_TOOLCHAIN_CACHE, shared: true });
	const plat = platformInfo();
	const key = gccCacheKey(version, plat);
	cachePut(GCC_TOOLCHAIN_CACHE, key, source);
	return cacheGet(GCC_TOOLCHAIN_CACHE, key);
}

/**
 * Resolve an explicit or default gcc toolchain version.
 *
 * @param {string} [version]
 * @returns {string|null}
 */
export function resolveGccToolchainVersion(version) {
	return GccToolchain.resolveVersion(version);
}

/**
 * Return the gcc executable path for a toolchain version.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function gccBin(version) {
	const resolved = GccToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainBin(graphToolFor(resolved), {
		name: GCC_TOOLCHAIN_CACHE,
		key: gccCacheKey(resolved, plat),
		subDir: "bin",
		exe: plat.os === "windows" ? "gcc.exe" : `${GCC_EXE_PREFIX[plat.arch]}-gcc`,
	});
}

/**
 * Return a named-cache-backed gcc tool descriptor for sandbox execution.
 * Its bin/ directory also contains a `clang` wrapper script (Odin invokes a
 * program literally named "clang" to link) that execs the real gcc binary.
 *
 * @param {string} [version]
 * @returns {Promise<object>}
 */
export async function gccTool(version) {
	const resolved = GccToolchain.requireVersion(version);
	const plat = platformInfo();
	return toolchainToolSpec(graphToolFor(resolved), {
		toolName: "gcc-toolchain",
		name: GCC_TOOLCHAIN_CACHE,
		key: gccCacheKey(resolved, plat),
		binDirs: ["bin"],
	});
}

/**
 * Return the currently configured default gcc toolchain version.
 *
 * @returns {string|null}
 */
export function defaultGccToolchainVersion() {
	return GccToolchain.defaultVersion();
}

/**
 * Return the currently configured default gcc toolchain target handle.
 *
 * @returns {object|null}
 */
export function defaultGccToolchain() {
	return GccToolchain.default();
}

const LOCKFILE_SPEC_LINUX = registerToolchainLockfile(
	{
		name: "gcc",
		platforms: gccSupportedPlatforms(),
		downloadUrl: gccDownloadUrl,
		artifactName: gccArtifactName,
		lockfile: GCC_LOCKFILE,
	},
	["2025.08-1"],
);

// WinLibs' tag shares no version vocabulary with Bootlin's (see
// requireSupportedPlatform's own comment), so Windows gets its own lockfile
// file and its own version list instead of sharing Linux's —
// registerToolchainLockfile()/generateToolLockfile() assume one version
// string resolves via the same formula for every platform in the list,
// which doesn't hold across these two vendors.
const LOCKFILE_SPEC_WINDOWS = registerToolchainLockfile(
	{
		name: "gcc-windows",
		platforms: [{ os: "windows", arch: "x86_64" }],
		downloadUrl: gccDownloadUrl,
		artifactName: gccArtifactName,
		lockfile: GCC_WINDOWS_LOCKFILE,
	},
	["16.1.0posix-14.0.0-ucrt-r4"],
);

// Importing this rule provisions the pinned default for whichever platform
// is active. A workspace can replace it by declaring another
// gccToolchain(..., { default: true }).
gccToolchain(
	{ linux: "2025.08-1", windows: "16.1.0posix-14.0.0-ucrt-r4" },
	{ default: true },
);

/**
 * Given a task's `exec` and its already-declared, resolved
 * `gccGraphToolchain().tool` input, resolve
 * the rustflags/env/pathDirs rustLinkerTools() (//rules/rust) needs to point
 * rustc's C link driver at this toolchain's "clang"-named wrapper script
 * (see gccTool()'s docstring above for why that wrapper exists).
 *
 * The path always comes from the real, absolute, stable named-cache
 * directory (via cacheGet(), same source as the kache-active CC/CXX branch
 * below) — not exec.tool()'s sandbox-relative mount alias. A relative
 * `-C linker=<path>` breaks in practice: rustc's own linker subprocess
 * isn't guaranteed to run with the sandbox root as its cwd (confirmed by a
 * real `imp lint //crates/imp:imp` run failing with "linker `directory/bin/
 * clang` not found" — see #60/#31). exec.path() is still called, purely to
 * consume() the binding so the graph scheduler orders gcc's install task
 * (and therefore this named-cache population) first.
 *
 * `pathDirs` (the toolchain's own bin/ dir) matters beyond the linker/CC/CXX
 * roles above: cc-rs-driven build scripts (e.g. a dependency compiling and
 * archiving its own C sources) look for "ar" via PATH with no CC/CXX-shaped
 * override available — a produced tool() binding can't put a whole
 * directory onto PATH on its own (see this function's own note above), so
 * the caller must fold pathDirs into PATH itself (confirmed missing by a
 * real `imp lint //crates/imp:imp` run failing with `cc-rs: failed to find
 * tool "ar"` once the linker issue above was fixed — see #60/#31).
 *
 * @param {object} exec Task's exec (see task()'s run(exec, resolved) body).
 * @param {object} resolvedGccTool Resolved `gccGraphToolchain().tool` input.
 * @param {string} version `gccGraphToolchain().version`.
 * @param {boolean} [kacheActive] Selects plain `CC=<path>` vs kache-wrapped
 *   `CC=kache <path>`/`CXX=kache <path>` — cc-rs-driven build scripts need
 *   CC/CXX too, not just rustc's own `-C linker=` (see kacheActive's own
 *   branch below).
 * @returns {{ rustflags: string[], env: string[], pathDirs: string[] }}
 */
export function gccRustLinkDriverEnv(
	exec,
	resolvedGccTool,
	version,
	kacheActive,
) {
	const plat = platformInfo();
	const exeSuffix = plat.os === "windows" ? ".exe" : "";
	const cacheDir = cacheGet(GCC_TOOLCHAIN_CACHE, gccCacheKey(version, plat));
	const mounted = !kacheActive && resolvedGccTool?.mountName !== undefined;
	const clangPath = mounted
		? exec.tool(resolvedGccTool, "clang")
		: `${cacheDir}/bin/clang${exeSuffix}`;
	const cxxPath = mounted
		? exec.tool(resolvedGccTool, "c++")
		: `${cacheDir}/bin/c++${exeSuffix}`;
	const pathDirs = [
		mounted ? ".imp/tools/gcc-toolchain/bin" : `${cacheDir}/bin`,
	];
	const rustflags = ["-C", `linker=${clangPath}`];
	if (!kacheActive) {
		return { rustflags, env: [`CC=${clangPath}`], pathDirs };
	}
	return {
		rustflags,
		env: [`CC=kache ${clangPath}`, `CXX=kache ${cxxPath}`],
		pathDirs,
	};
}

/**
 * The real, absolute host directory (bin/ inside it) a resolved gcc graph
 * toolchain installed into, via the same named-cache `cacheGet()` real host
 * path gccRustLinkDriverEnv() uses — usable directly from any sandbox (no
 * tool mount needed), unlike exec.tool()'s sandbox-mount-relative path. See
 * gccCMakeCompilerArgs() below for why rules/c/cmake needs this specifically
 * (a real path, not a sandbox-relative one).
 *
 * @param {string} version `gccGraphToolchain().version`.
 * @returns {string}
 */
export function gccGraphToolchainDir(version) {
	const plat = platformInfo();
	return cacheGet(GCC_TOOLCHAIN_CACHE, gccCacheKey(version, plat));
}

/**
 * Parse the plain GCC release number out of a WinLibs release tag (see
 * WINLIBS_TAG_RE's own doc comment for the tag shape), e.g.
 * "16.1.0posix-14.0.0-ucrt-r4" -> "16.1.0". Needed because WinLibs' archive
 * lays out its per-version runtime libs (libgcc.a, libgcc_eh.a) under
 * lib/gcc/x86_64-w64-mingw32/<gcc version>/, and that path segment is the
 * bare GCC number, not the full WinLibs tag.
 *
 * @param {string} version A Windows gcc toolchain version (WinLibs tag).
 * @returns {string}
 */
export function winlibsGccVersion(version) {
	const match = WINLIBS_TAG_RE.exec(version);
	if (!match) {
		throw new Error(
			`gcc toolchain version '${version}' doesn't look like a WinLibs release tag (expected e.g. "16.1.0posix-14.0.0-ucrt-r4")`,
		);
	}
	return match[1];
}

/**
 * Real, absolute paths to the mingw-w64 runtime archives a raw COFF linker
 * (lld-link, radlink, ...) needs that a normal `gcc`/`clang` frontend
 * invocation would otherwise add on its own via its default-libs spec: the
 * C++ ABI/runtime support library (new/delete, RTTI, exceptions), the SEH
 * unwinder and its thread-local-storage emulation (which itself needs
 * pthread), the pthreads API BoringSSL's Windows build still compiles
 * against (mingw's own winpthreads implementation, not real POSIX threads),
 * the mingw libc extensions GCC-compiled C sources assume (e.g. strcasecmp,
 * the ___chkstk_ms stack-probe thunk), and — surprisingly, since
 * this isn't GCC/mingw-specific at all — the UCRT C runtime itself
 * (memcpy/malloc/strlen/...), which even a pure-Odin object file references
 * and which Odin's own "default" (MSVC link.exe) backend otherwise supplies
 * automatically but its lld-link path does not.
 *
 * Confirmed necessary by a real `odin build` failure once Odin's Windows
 * link step was switched to `-linker:lld` (see rules/odin/index.js) to work
 * around MSVC link.exe rejecting GCC-produced COMDAT sections: without these,
 * linking anything at all on Windows via lld-link fails with dozens of
 * "undefined symbol" errors, from plain UCRT functions up through C++-only
 * ones like `__gxx_personality_seh0`, `_Unwind_Resume`, and `operator new`
 * once a GCC/mingw-compiled C++ dependency (BoringSSL, webview) is in the
 * link too.
 *
 * @param {string} version A Windows gcc toolchain version (WinLibs tag).
 * @returns {string[]}
 */
export function gccWindowsRuntimeArchives(version) {
	const dir = gccGraphToolchainDir(version);
	const gccVersion = winlibsGccVersion(version);
	return [
		`${dir}/lib/gcc/x86_64-w64-mingw32/${gccVersion}/libgcc.a`,
		`${dir}/lib/gcc/x86_64-w64-mingw32/${gccVersion}/libgcc_eh.a`,
		`${dir}/x86_64-w64-mingw32/lib/libmingwex.a`,
		`${dir}/x86_64-w64-mingw32/lib/libmingw32.a`,
		`${dir}/x86_64-w64-mingw32/lib/libucrt.a`,
		`${dir}/x86_64-w64-mingw32/lib/libwinpthread.a`,
		`${dir}/lib/libstdc++.a`,
		`${dir}/lib/libsupc++.a`,
	];
}

/**
 * Real, absolute CMAKE_C_COMPILER/CMAKE_CXX_COMPILER/CMAKE_AR/CMAKE_RANLIB
 * arguments for a resolved gcc graph toolchain, for use by rules/c/cmake's
 * graph-native configure step (see #31/#62). Uses gccGraphToolchainDir()'s
 * real host path rather than exec.tool()'s sandbox-mount-relative one — CMake
 * bakes this value into build.ninja, which later replay actions read from a
 * *different* sandbox than the one that ran configure, so it must be a path
 * valid everywhere, not just within configure's own sandbox (the exact bug
 * class gccRustLinkDriverEnv's own docstring already covers for rustc's
 * `-C linker=`).
 *
 * Pinning CMAKE_RANLIB here matters beyond consistency with CMAKE_AR: left
 * unset, CMake's own find_program() falls back to whatever `ranlib` exists on
 * the host running `imp build`, baking that host-dependent absolute path
 * (e.g. `/usr/bin/ranlib`) into build.ninja — a real hermeticity gap, and the
 * root cause of #98 (CMake replay failing with "ranlib: not found" once that
 * baked-in host path got rewritten to a bare name with no matching mount).
 *
 * @param {string} version `gccGraphToolchain().version`.
 * @param {boolean} [unsafeSystemPaths] When true, point CMAKE_C_COMPILER/
 *   CMAKE_CXX_COMPILER at the "-unsafe-paths" aliases (see gccGraphTool()'s
 *   own install-step comment) instead of the plain wrapper-backed ones, so
 *   CMake-supplied -I/-isystem/-L flags under /usr/include or /usr/lib
 *   aren't rejected by Bootlin's toolchain-wrapper. CMAKE_AR/CMAKE_RANLIB
 *   are unaffected — ar/ranlib aren't wrapped.
 * @returns {string[]}
 */
export function gccCMakeCompilerArgs(version, unsafeSystemPaths) {
	const dir = gccGraphToolchainDir(version);
	const suffix = unsafeSystemPaths ? "-unsafe-paths" : "";
	const exeSuffix = platformInfo().os === "windows" ? ".exe" : "";
	return [
		`-DCMAKE_C_COMPILER=${dir}/bin/clang${suffix}${exeSuffix}`,
		`-DCMAKE_CXX_COMPILER=${dir}/bin/c++${suffix}${exeSuffix}`,
		`-DCMAKE_RANLIB=${dir}/bin/ranlib${exeSuffix}`,
		`-DCMAKE_AR=${dir}/bin/ar${exeSuffix}`,
		// WinLibs bundles nasm.exe in the same bin/ dir as clang/ar/ranlib.
		// Without this, CMake's enable_language(ASM_NASM) (see BoringSSL's
		// CMakeLists.txt Windows path) falls back to find_program()'s own
		// ambient-PATH search, which isn't hermetic and can silently miss the
		// toolchain's nasm even when one is bundled right here — confirmed by
		// a real Windows build where BoringSSL's hand-optimized SHA/AES/EC
		// assembly routines were entirely absent from libcrypto.a, causing
		// dozens of undefined-symbol link errors downstream, with no
		// configure-time failure to point at the cause.
		...(platformInfo().os === "windows"
			? [`-DCMAKE_ASM_NASM_COMPILER=${dir}/bin/nasm${exeSuffix}`]
			: []),
	];
}

/**
 * A legacy-shaped `{name, cache, key, binDirs}` tool spec for one of gcc's
 * graph-install wrapper aliases ("clang"/"cc"/"c++"/"ar"), mountable
 * directly via `exec.action({tools: [...]})`'s existing legacy-tool-spec
 * passthrough (the same shape `cmakeTool()`/`nativeToolSpec()` already
 * produce) — no `cacheGet()`/absolute-path plumbing needed by the caller.
 *
 * Needed because rules/c/cmake's graph-native replay bakes
 * gccCMakeCompilerArgs()'s real absolute compiler paths into build.ninja at
 * configure time, then rewrites them back to bare tool names
 * ("clang"/"c++"/"ar") before replaying each edge (see
 * ninja_graph.js's rewriteToolInvocations()) — those bare names need a real
 * mount, not another absolute-path env trick, to resolve to *this* pinned
 * gcc toolchain rather than whatever (if anything) is on a bare hermetic
 * sandbox's PATH.
 *
 * @param {string} version `gccGraphToolchain().version`.
 * @param {string} name One of "clang", "cc", "c++", "ar".
 * @returns {{ name: string, cache: string, key: string, binDirs: string[] }}
 */
export function gccGraphToolSpec(version, name) {
	const plat = platformInfo();
	return {
		kind: "tool",
		name,
		cache: GCC_TOOLCHAIN_CACHE,
		key: gccCacheKey(version, plat),
		binDirs: ["bin"],
	};
}
