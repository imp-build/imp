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
import { downloadToolArtifact } from "//rules/imp/lockfile";
import { toolchainBin, toolchainToolSpec } from "//rules/imp/toolchain";
import {
	generateToolLockfile,
	GEN_LOCKFILES,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

// Declared tool identity for products this toolchain implements; also
// consumed by rule modules registering gcc-driven products.
export const GCC_TOOL = toolName("gcc");

const GCC_TOOLCHAIN_CACHE = "gcc-toolchains";
const GCC_LOCKFILE = "//rules/c/gcc/gcc.lock";

// Bootlin only publishes prebuilt Linux toolchains; this doesn't cover
// Windows (a different linking story entirely — MSVC link.exe — and out of
// scope here).
function requireSupportedPlatform(plat) {
	if (plat.os !== "linux") {
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

/**
 * Return the Bootlin toolchain name for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccArtifactName(version, plat) {
	requireSupportedPlatform(plat);
	return `${BOOTLIN_ARCH[plat.arch]}--glibc--stable-${version}.tar.xz`;
}

/**
 * Return the Bootlin toolchain download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function gccDownloadUrl(version, plat) {
	requireSupportedPlatform(plat);
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
 * @param {string} version Bootlin toolchain release version, e.g. "2025.08-1".
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @returns {object} Target handle for this gcc toolchain.
 * @category configuration
 */
export function gccToolchain(version, opts = {}) {
	const toolchain = new GccToolchain(
		{ version, unverified: opts.unverified },
		{ default: opts.default },
	);
	graphToolchains.set(version, gccGraphTool(version));
	return toolchain;
}

/** Build the managed GCC distribution as a graph-native tool. */
export function gccGraphTool(version) {
	const resolved = GccToolchain.requireVersion(version);
	const plat = platformInfo();
	namedCache({ name: GCC_TOOLCHAIN_CACHE, shared: true });
	const cacheKey = gccCacheKey(resolved, plat);
	const archive = downloadToolArtifact({
		lockfile: GCC_LOCKFILE,
		tool: "gcc",
		version: resolved,
		plat,
		url: gccDownloadUrl(resolved, plat),
		output: `gcc-downloads/${gccCacheKey(resolved, plat)}/${gccArtifactName(resolved, plat)}`,
		display: `download gcc ${resolved} (${plat.os}/${plat.arch})`,
		unverified: GccToolchain.resolveUnverified(resolved),
	});
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
	return graphTool(directory, { binDirs: ["bin"] });
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
		exe: `${GCC_EXE_PREFIX[plat.arch]}-gcc`,
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

// Importing this rule provisions the pinned default. A workspace can replace
// it by declaring another gccToolchain(..., { default: true }).
gccToolchain("2025.08-1", { default: true });

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "gcc",
		platforms: gccSupportedPlatforms(),
		downloadUrl: gccDownloadUrl,
		artifactName: gccArtifactName,
		lockfile: GCC_LOCKFILE,
	},
	["2025.08-1"],
);
product(
	GccToolchain,
	GEN_LOCKFILES,
	GCC_TOOL,
	(handle) => generateToolLockfile({ handle, ...LOCKFILE_SPEC }),
	{ display: "gen lockfiles {0}", level: "info" },
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
	exec.path(resolvedGccTool);
	const plat = platformInfo();
	const dir = cacheGet(GCC_TOOLCHAIN_CACHE, gccCacheKey(version, plat));
	const clangPath = `${dir}/bin/clang`;
	const pathDirs = [`${dir}/bin`];
	const rustflags = ["-C", `linker=${clangPath}`];
	if (!kacheActive) {
		return { rustflags, env: [`CC=${clangPath}`], pathDirs };
	}
	return {
		rustflags,
		env: [`CC=kache ${clangPath}`, `CXX=kache ${dir}/bin/c++`],
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
 * @param {object} exec Task's exec (see task()'s run(exec, resolved) body).
 * @param {object} resolvedGccTool Resolved `gccGraphToolchain().tool` input.
 * @param {string} version `gccGraphToolchain().version`.
 * @returns {string}
 */
export function gccGraphToolchainDir(exec, resolvedGccTool, version) {
	exec.path(resolvedGccTool);
	const plat = platformInfo();
	return cacheGet(GCC_TOOLCHAIN_CACHE, gccCacheKey(version, plat));
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
 * @param {object} exec Task's exec (see task()'s run(exec, resolved) body).
 * @param {object} resolvedGccTool Resolved `gccGraphToolchain().tool` input.
 * @param {string} version `gccGraphToolchain().version`.
 * @param {boolean} [unsafeSystemPaths] When true, point CMAKE_C_COMPILER/
 *   CMAKE_CXX_COMPILER at the "-unsafe-paths" aliases (see gccGraphTool()'s
 *   own install-step comment) instead of the plain wrapper-backed ones, so
 *   CMake-supplied -I/-isystem/-L flags under /usr/include or /usr/lib
 *   aren't rejected by Bootlin's toolchain-wrapper. CMAKE_AR/CMAKE_RANLIB
 *   are unaffected — ar/ranlib aren't wrapped.
 * @returns {string[]}
 */
export function gccCMakeCompilerArgs(
	exec,
	resolvedGccTool,
	version,
	unsafeSystemPaths,
) {
	const dir = gccGraphToolchainDir(exec, resolvedGccTool, version);
	const suffix = unsafeSystemPaths ? "-unsafe-paths" : "";
	return [
		`-DCMAKE_C_COMPILER=${dir}/bin/clang${suffix}`,
		`-DCMAKE_CXX_COMPILER=${dir}/bin/c++${suffix}`,
		`-DCMAKE_RANLIB=${dir}/bin/ranlib`,
		`-DCMAKE_AR=${dir}/bin/ar`,
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
