// Ambient-host MSVC toolchain resolution for Windows.
//
// Unlike rules/c/gcc's WinLibs GCC (a pinned, downloadable archive) or
// rules/c/zig's Zig releases, MSVC cannot be vendored or redistributed by
// imp — Microsoft doesn't ship it as a freely fetchable archive, and its
// license doesn't permit imp from caching/redistributing the compiler or the
// Windows SDK. So this module resolves whatever the host already has
// installed, the same ambient dependency Odin's own default Windows linker
// already has on `link.exe` (see rules/c/gcc's PASSTHROUGH_ENV_VARS_WINDOWS
// comment) — not a new hermeticity regression, just extending an existing
// one to cover the C/C++ side too.
//
// Why MSVC at all, given that: a Windows odin build's own object code is
// MSVC-ABI (it auto-links libcmt.lib unless told not to). Any GCC/mingw or
// zig(-windows-gnu)-compiled C/C++ dependency carries a different ABI/CRT —
// confirmed the hard way (see rules/odin/index.js's -no-crt and
// gccWindowsRuntimeArchives()): mixing them means two live CRT instances in
// one process, and even after forcing that to link cleanly, MSVC's own
// link.exe rejects GCC/mingw COMDAT sections outright ("LNK1143: invalid or
// corrupt file: no symbol for COMDAT section"), which is *why* Windows odin
// builds were switched to lld-link in the first place. Building the C/C++
// dependencies with the same MSVC toolchain Odin itself targets sidesteps
// both problems at once: no ABI mixing, no COMDAT rejection, Odin's plain
// default linker just works.

import { cacheHas, cachePut, namedCache } from "imp:core";

// The VS Installer always places vswhere.exe here, regardless of which VS
// edition/version it goes on to manage — the one fixed, well-known location
// this module can rely on without itself needing to search for it. Mirrors
// exec.rs's BUILTIN_SHELL_CANDIDATES: a short list of fixed real paths
// checked directly, not a PATH search.
const VSWHERE_CANDIDATES = [
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
	"C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe",
];

const MSVC_HOST_CACHE = "msvc-host-toolchain";
const MSVC_HOST_KEY = "default";
// A second, separate named-cache entry: the Windows SDK (rc.exe/mt.exe, plus
// the ucrt/um/shared headers and libs) lives under a completely different
// install root ("Windows Kits\10") than Visual Studio's own VC toolset, so
// it can't share MSVC_HOST_CACHE's single binDirs-relative-to-one-root mount.
const MSVC_SDK_CACHE = "msvc-host-sdk";
const MSVC_SDK_KEY = "default";

/**
 * Declare the ambient host MSVC toolchain — pass as `cmakeProject({
 * toolchain })`. There is no version to pick (unlike gccGraphToolchain() /
 * zigGraphToolchain()): this always resolves whatever Visual Studio the
 * host has installed, discovered fresh per task via resolveMsvcHost().
 *
 * @returns {{kind: string}} Toolchain handle for cmakeProject()'s `toolchain` option.
 */
export function msvcToolchain() {
	return { kind: "msvc-host-toolchain" };
}

export function isMsvcToolchain(toolchain) {
	return !!toolchain && toolchain.kind === "msvc-host-toolchain";
}

/**
 * Discover the ambient host MSVC toolchain (VS install root, MSVC tools
 * version, Windows SDK root/version) by shelling out to vswhere.exe.
 *
 * The vswhere lookup itself is deliberately not cached across builds the way
 * rules/c/gcc's toolchain install is — this is ambient host state, not
 * something imp itself produced, so re-running vswhere (a few hundred ms)
 * each time a task needs it is simpler and safer than trying to invalidate a
 * stale cache entry if the host's VS install changes.
 *
 * exec.action's `tools:` mounting only ever sees a bare tool name like
 * "cl.exe" (ninja_graph.js's rewriteToolInvocations() strips any absolute
 * path back to one, same as for gcc's clang/ar/ranlib — see
 * msvcGraphToolSpec()), and needs a real `{cache,key}`-addressed directory to
 * mount, resolvable without a direct graph dependency on whichever task ran
 * this first. Unlike gcc's toolchain (installed once into the cache by its
 * own dedicated task), there's no task producing this content — it already
 * exists on the host — so this cachePut()s it in directly. Only the small
 * cl.exe/link.exe/lib.exe bin directory (tens of MB, not the whole VS
 * install, which can be tens of GB and once made cache_dir_put()'s recursive
 * byte-for-byte copy fail outright): everything else MSVC needs (headers,
 * .lib files) is referenced by real host path directly in compiler/linker
 * flags (see msvcCMakeCompilerArgs()), never through a tool mount at all.
 *
 * Must run inside a task's run() (needs exec.action to shell out to
 * vswhere) — not callable at graph-declaration time.
 *
 * @param {object} exec
 * @returns {Promise<{vsRoot: string, mscVersion: string, sdkRoot: string, sdkVersion: string}>}
 */
export async function resolveMsvcHost(exec) {
	// Each vswhere candidate is its own positional arg (not space-joined into
	// one string for `for c in $list`): several of the fixed candidate paths
	// contain spaces themselves ("Program Files (x86)"), which word-splitting
	// a joined string would mangle.
	const script =
		'vswhere=""; ' +
		'for c in "$@"; do ' +
		'if [ -f "$c" ]; then vswhere=$c; break; fi; ' +
		"done; " +
		'if [ -z "$vswhere" ]; then echo "no vswhere.exe found at any known install path" >&2; exit 1; fi; ' +
		'vsroot=$("$vswhere" -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath); ' +
		'if [ -z "$vsroot" ]; then echo "vswhere found no MSVC (VC.Tools.x86.x64) install on this host" >&2; exit 1; fi; ' +
		'mscver=$(tr -d "\\r\\n" < "$vsroot/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"); ' +
		'sdkroot="C:/Program Files (x86)/Windows Kits/10"; ' +
		'sdkver=$(ls "$sdkroot/Include" | sort -V | tail -1); ' +
		'printf "%s\\n%s\\n%s\\n%s\\n" "$vsroot" "$mscver" "$sdkroot" "$sdkver"';
	const result = await exec.action({
		argv: ["sh", "-c", script, "msvc-discover", ...VSWHERE_CANDIDATES],
		cache: false,
		display: "discover MSVC host toolchain",
	});
	const [vsRoot, mscVersion, sdkRoot, sdkVersion] = result.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim());
	if (!vsRoot || !mscVersion || !sdkRoot || !sdkVersion) {
		throw new Error(
			`failed to discover a host MSVC toolchain (got vsRoot=${vsRoot}, mscVersion=${mscVersion}, sdkRoot=${sdkRoot}, sdkVersion=${sdkVersion}) — is Visual Studio (with the "Desktop development with C++" workload) installed?`,
		);
	}
	const host = { vsRoot, mscVersion, sdkRoot, sdkVersion };
	const { binDir, sdkBinDir } = msvcHostDirs(host);
	namedCache({ name: MSVC_HOST_CACHE, shared: true });
	namedCache({ name: MSVC_SDK_CACHE, shared: true });
	if (!cacheHas(MSVC_HOST_CACHE, MSVC_HOST_KEY)) {
		cachePut(MSVC_HOST_CACHE, MSVC_HOST_KEY, binDir);
	}
	if (!cacheHas(MSVC_SDK_CACHE, MSVC_SDK_KEY)) {
		cachePut(MSVC_SDK_CACHE, MSVC_SDK_KEY, sdkBinDir);
	}
	return host;
}

/**
 * The MSVC/Windows-SDK bin/include/lib directories for a resolved host,
 * x86_64 (Hostx64/x64) only.
 *
 * @param {{vsRoot: string, mscVersion: string, sdkRoot: string, sdkVersion: string}} host
 */
export function msvcHostDirs(host) {
	const vcDir = `${host.vsRoot}/VC/Tools/MSVC/${host.mscVersion}`;
	const sdkInc = `${host.sdkRoot}/Include/${host.sdkVersion}`;
	const sdkLib = `${host.sdkRoot}/Lib/${host.sdkVersion}`;
	return {
		binDir: `${vcDir}/bin/Hostx64/x64`,
		sdkBinDir: `${host.sdkRoot}/bin/${host.sdkVersion}/x64`,
		includeDirs: [
			`${vcDir}/include`,
			`${sdkInc}/ucrt`,
			`${sdkInc}/um`,
			`${sdkInc}/shared`,
		],
		libDirs: [`${vcDir}/lib/x64`, `${sdkLib}/ucrt/x64`, `${sdkLib}/um/x64`],
	};
}

/**
 * CMake configure arguments pointing at a resolved host MSVC toolchain: just
 * the compiler/RC/MT paths. Deliberately *not* /I or /LIBPATH flags baked
 * into CMAKE_<LANG>_FLAGS — see msvcEnv()'s own comment for why those go
 * through INCLUDE/LIB env vars instead. CMAKE_AR/CMAKE_RANLIB are left
 * unset: CMake picks lib.exe and its own MSVC static-library rule
 * automatically once CMAKE_C_COMPILER_ID comes back "MSVC", the same way it
 * infers everything else about an MSVC toolchain from cl.exe alone.
 *
 * @param {{vsRoot: string, mscVersion: string, sdkRoot: string, sdkVersion: string}} host
 * @returns {string[]}
 */
export function msvcCMakeCompilerArgs(host) {
	const { binDir, sdkBinDir } = msvcHostDirs(host);
	const clPath = `${binDir}/cl.exe`;
	return [
		`-DCMAKE_C_COMPILER=${clPath}`,
		`-DCMAKE_CXX_COMPILER=${clPath}`,
		// Not auto-detected under the Ninja generator (only the VS generator
		// finds these itself) — confirmed by a real configure failure: CMake
		// invoked a bare, unresolved "rc" for the manifest-embedding step and
		// failed with "no such file or directory".
		`-DCMAKE_RC_COMPILER=${sdkBinDir}/rc.exe`,
		`-DCMAKE_MT=${sdkBinDir}/mt.exe`,
		// GCC/mingw's ld auto-exports every global symbol from a shared
		// library by default; MSVC's link.exe exports nothing unless told to
		// (via __declspec(dllexport) or a .def file), and silently skips
		// producing an import .lib when there's nothing to export. C/C++
		// dependencies built for the GCC path generally don't carry
		// dllexport annotations (they were never needed there), so mimic
		// GCC's default here rather than expecting every dependency to add
		// them just for the MSVC path.
		"-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON",
	];
}

/**
 * INCLUDE/LIB env entries (run({env: [...]})-shaped "KEY=VALUE" strings) for
 * a resolved host — cl.exe/link.exe's own standard mechanism for finding
 * system headers/libs (the same env vars vcvarsall.bat sets), used here
 * instead of baking /I"..."/LIBPATH:"..." flags into CMAKE_C_FLAGS /
 * CMAKE_EXE_LINKER_FLAGS. Needed because those flags would be replayed as
 * literal shell argv text later (rules/c/cmake/graph_replay.js replays each
 * ninja edge through `sh -c`), and rules/c/cmake/ninja_graph.js's own
 * cmd.exe-wrapper cleanup unconditionally strips every double quote from a
 * replayed command (confirmed by a real failure: bash choked on the bare
 * `(`/`)`/spaces in an unquoted "...Program Files (x86)..." path once its
 * surrounding quotes were stripped) — env var values never go through that
 * argv tokenization at all, so this sidesteps the whole class of problem
 * rather than trying to out-escape it.
 *
 * Also carries MSYS2_ARG_CONV_EXCL=* — cl.exe/link.exe are native (non-MSYS)
 * children of the `sh -c` replaying each edge (see graph_replay.js's
 * executeEdge()), and Git-for-Windows' MSYS runtime auto-mangles any argv
 * token that looks like a POSIX path into a Windows one before exec'ing a
 * native child. A single-slash MSVC flag like `/FoCMakeFiles/foo.dir/x.obj`
 * matches that heuristic and got silently rewritten/dropped in testing — cl
 * then fell back to its own default output name in cwd, producing a
 * plausible-looking command that nonetheless wrote its .obj to the wrong
 * path. Confirmed by reproducing the exact resolved command by hand: it only
 * matched the real (broken) behavior once this var was unset, and worked
 * once set — see rules/c/gcc's own PASSTHROUGH_ENV_VARS_WINDOWS comment for
 * the sibling issue on the gcc path (which doesn't need this only because
 * clang/gcc flags use `-o` / `--foo`, never a bare leading slash).
 *
 * @param {{vsRoot: string, mscVersion: string, sdkRoot: string, sdkVersion: string}} host
 * @returns {string[]}
 */
export function msvcEnv(host) {
	const { includeDirs, libDirs } = msvcHostDirs(host);
	return [
		`INCLUDE=${includeDirs.join(";")}`,
		`LIB=${libDirs.join(";")}`,
		"MSYS2_ARG_CONV_EXCL=*",
	];
}

// Bare tool names cl.exe's own compile/link commands can appear as in a
// replayed ninja edge, once ninja_graph.js's rewriteToolInvocations() strips
// the absolute path CMake baked in back to a bare name (see
// msvcCMakeCompilerArgs()'s own comment) — mirrors rules/c/gcc's
// GCC_GRAPH_TOOL_NAMES. link.exe/lib.exe show up in link and
// static-library-archive edges respectively; CMake invokes cl.exe itself
// for the actual link step by default (not link.exe directly), but list it
// too for an explicit CMAKE_LINKER override.
export const MSVC_GRAPH_TOOL_NAMES = new Set([
	"cl.exe",
	"link.exe",
	"lib.exe",
	// CMake's own manifest-embedding step invokes these bare, without the
	// .exe suffix (confirmed via a real replayed command: `rc /fo ...`).
	"rc",
	"rc.exe",
	"mt",
	"mt.exe",
]);

// rc.exe/mt.exe live under the Windows SDK root, not the VS/VC root the rest
// of MSVC_GRAPH_TOOL_NAMES resolves against — see MSVC_SDK_CACHE's own
// comment.
const MSVC_SDK_TOOL_NAMES = new Set(["rc", "rc.exe", "mt", "mt.exe"]);

/**
 * A `{name, cache, key, binDirs}` tool spec for cl.exe/link.exe/lib.exe,
 * mountable directly via `exec.action({tools: [...]})` — mirrors
 * rules/c/gcc's gccGraphToolSpec(), except the "install" is just
 * cachePut()-registering the ambient VS root resolveMsvcHost() already
 * found (see this module's own header comment on why: there's nothing to
 * download, the toolchain already exists on the host).
 *
 * @param {string} name One of MSVC_GRAPH_TOOL_NAMES.
 * @param {{vsRoot: string, mscVersion: string}} host Already-resolved (and
 *   cachePut()'d) via resolveMsvcHost() earlier in the same task run().
 * @returns {{name: string, cache: string, key: string, binDirs: string[]}}
 */
export function msvcGraphToolSpec(name, host) {
	// resolveMsvcHost() cachePut()s the bin directory itself as the cache
	// root (not the whole VS/SDK install — see its own comment), so the
	// mount's binDirs is just "." here, unlike gcc's toolchain-root-relative
	// paths.
	return MSVC_SDK_TOOL_NAMES.has(name)
		? { kind: "tool", name, cache: MSVC_SDK_CACHE, key: MSVC_SDK_KEY, binDirs: ["."] }
		: { kind: "tool", name, cache: MSVC_HOST_CACHE, key: MSVC_HOST_KEY, binDirs: ["."] };
}
