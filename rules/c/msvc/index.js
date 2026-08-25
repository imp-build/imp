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

import { cacheGet, cacheHas, cachePut, namedCache, output } from "imp:core";
import { resolveToolLockfile } from "//rules/imp/lockfile";
import { shellQuote } from "//rules/c/toolchain";

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

// MSVC ships no assembler of its own — BoringSSL's Windows CMake build
// needs a real NASM (see resolveNasmHost() below), downloaded and cached
// under its own named-cache entry rather than an existing host directory
// (unlike MSVC_HOST_CACHE/MSVC_SDK_CACHE above, nothing here is ambient).
const NASM_CACHE = "msvc-nasm";
const NASM_KEY = "default";
const NASM_VERSION = "3.02";
const NASM_PLATFORM = { os: "windows", arch: "x86_64" };
const NASM_LOCKFILE = "//rules/c/msvc/nasm.lock";

// -O2/-DNDEBUG vs -O0/-g's cl.exe equivalent. /Zi (debug) emits a separate
// .pdb rather than embedding symbols the way -g does, but no caller here
// consumes a .pdb path today, so it's left as a side effect of the flag
// rather than plumbed through as its own output.
function msvcOptFlags(opt) {
	return opt === "release" ? ["/O2", "/DNDEBUG"] : ["/Od", "/Zi"];
}

// cl.exe/lib.exe/link.exe's own @file response-file reader follows standard
// Windows command-line quoting (a bare double quote, backslash-escaped), not
// the single-quote shell style rules/c/gcc's/rules/c/zig's rspQuote() (a
// plain shellQuote()) relies on — embedding a shellQuote()'d token like
// 'obj/a.o' here would hand cl.exe a filename containing two literal single
// quotes, not a quoted "obj/a.o". Object/archive paths at play here don't
// carry embedded double quotes in practice, so no backslash-escaping beyond
// wrapping is implemented.
function msvcRspQuote(value) {
	const s = String(value);
	return /\s/.test(s) ? `"${s}"` : s;
}

// The msvc side of the shared cc-toolchain provider contract's commands()
// (see rules/c/gcc's/rules/c/zig's own commands()) — resolves the ambient
// host (resolveMsvcHost()) and returns cl.exe/lib.exe-flavored structural
// argv builders for ccTask() (rules/c/index.js) to assemble a compile/
// archive/link "sh -c" script around, translating the same three shapes gcc/
// zig do (-c/-o/-I -> /c//Fo//I, `ar rcs` -> `lib.exe /OUT:`, -shared ->
// /LD) instead of the clang/gcc vocabulary ccTask() used to hardcode.
// Real cl.exe/lib.exe (not clang-cl) — see resolveMsvcHost()'s own
// docstring for why this module resolves the ambient host toolchain rather
// than vendoring one.
async function msvcToolchainCommands(exec) {
	const host = await resolveMsvcHost(exec);
	// Unlike gcc/zig (which mount their compiler via an eagerly-declared
	// taskInputs() binding + exec.tool()'s own consumed-binding tracking),
	// msvcToolchain() has no such binding — taskInputs() is `{}`, since
	// there's nothing to install ahead of time (see resolveMsvcHost()'s own
	// docstring). So the tool specs themselves are handed back here for
	// ccTask() to splice directly into each exec.action()'s own `tools:`
	// list instead.
	const tools = [
		msvcGraphToolSpec("cl.exe", host),
		msvcGraphToolSpec("lib.exe", host),
	];
	return {
		env: msvcEnv(host),
		tools,
		rspQuote: msvcRspQuote,
		compileCommand({ source, objPath, isCxx, includeDirs, opt, copts }) {
			return [
				"cl.exe",
				"/nologo",
				"/c",
				isCxx ? "/TP" : "/TC",
				...msvcOptFlags(opt),
				...includeDirs.map((dir) => shellQuote(`/I${dir}`)),
				...copts.map(shellQuote),
				shellQuote(`/Fo${objPath}`),
				shellQuote(source),
			];
		},
		archiveCommand({ outPath, rspPath }) {
			return [
				"lib.exe",
				"/nologo",
				shellQuote(`/OUT:${outPath}`),
				`@${shellQuote(rspPath)}`,
			];
		},
		// cl.exe itself acts as the link driver (as gcc's own compiler
		// binary does) rather than invoking link.exe directly — it already
		// knows how to find the CRT startup objects/default libs, the same
		// reason gcc's own linkCommand() reuses compiler(isCxx) instead of
		// invoking ld directly. /LD (not link.exe's own /DLL) is cl.exe's
		// own shared-library spelling of the same intent as gcc's -shared.
		linkCommand({ outPath, isShared, rspPath }) {
			return [
				"cl.exe",
				"/nologo",
				...(isShared ? ["/LD"] : []),
				shellQuote(`/Fe${outPath}`),
				`@${shellQuote(rspPath)}`,
			];
		},
	};
}

/**
 * Declare the ambient host MSVC toolchain — pass as `cmakeProject({
 * toolchain })`. There is no version to pick (unlike gccGraphToolchain() /
 * zigGraphToolchain()): this always resolves whatever Visual Studio the
 * host has installed, discovered fresh per task via resolveMsvcHost().
 *
 * Also conforms to the shared cc-toolchain provider contract (`kind`,
 * `taskInputs`, `commands`, `cmakeConfigure`, `resolvesToolName`, `toolSpec`,
 * `resolveState`, `edgeEnv`) — see rules/c/gcc's and rules/c/zig's own
 * toolchain constructors for the other two providers, and
 * rules/c/toolchain.js's ccToolchainForPlatform() for the platform-indexed
 * union all three plug into. This object literal is fully inert to
 * construct (no vswhere lookup, no task/action) — every method that touches
 * the ambient host defers to resolveMsvcHost(exec) inside a task's run(),
 * same as before this contract existed (see resolveMsvcHost()'s own
 * docstring below).
 *
 * @returns {object} Toolchain handle for cmakeProject()'s `toolchain` option.
 */
export function msvcToolchain() {
	return {
		kind: "msvc-host-toolchain",
		version: null,
		taskInputs: () => ({}),
		// ccTask() (rules/c/index.js) now asks the toolchain to build its own
		// compile/archive/link argv (see msvcToolchainCommands() above)
		// instead of hardcoding clang/gcc flag syntax around a bare compiler
		// path — this is what makes msvcToolchain() usable from ccLibrary()/
		// ccBinary() directly, not just cmakeProject() (which sidestepped
		// this by letting CMake itself own the flag vocabulary).
		commands: (exec) => msvcToolchainCommands(exec),
		cmakeConfigure: async (exec) => {
			const host = await resolveMsvcHost(exec);
			const nasmPath = await resolveNasmHost(exec);
			return {
				compilerArgs: msvcCMakeCompilerArgs(host, nasmPath),
				env: msvcEnv(host),
			};
		},
		resolvesToolName: (name) => MSVC_GRAPH_TOOL_NAMES.has(name),
		toolSpec: (name, host) => msvcGraphToolSpec(name, host),
		resolveState: (exec) => resolveMsvcHost(exec),
		edgeEnv: (host) => msvcEnv(host),
	};
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
 * Resolve a NASM assembler for BoringSSL's Windows CMake build (see
 * msvcCMakeCompilerArgs()'s own CMAKE_ASM_NASM_COMPILER) — MSVC itself
 * ships no assembler, unlike gcc's WinLibs distribution, which bundles
 * nasm.exe alongside clang/ar/ranlib (see rules/c/gcc's own
 * gccCMakeCompilerArgs()). Downloaded straight from nasm.us, verified
 * against nasm.lock, rather than routed through imp's Toolchain-class/
 * GEN_LOCKFILES machinery the way gcc/zig's own pinned toolchains are:
 * nasm here is an internal implementation detail of the msvc CMake path,
 * not a user-facing toolchain a workspace would ever declare a version
 * of — so this stays a small, self-contained download+extract, resolved
 * entirely inside a task's run() (never at graph-declaration time),
 * matching resolveMsvcHost()'s own dynamic resolution and
 * msvcToolchain()'s "fully inert to construct" design (see this module's
 * own header comment).
 *
 * Unlike resolveMsvcHost()'s own ambient, always-re-verified vswhere
 * lookup, this artifact is an immutable pinned download — the extract
 * action's own inputs (URL, sha256, version) never change, so imp's
 * ordinary action cache (not a manual cacheHas() guard) is what makes a
 * repeat call cheap; the download/extract script itself still runs on
 * every call, just typically as a cache hit.
 *
 * @param {object} exec
 * @returns {Promise<string>} Real, absolute host path to nasm.exe.
 */
export async function resolveNasmHost(exec) {
	namedCache({ name: NASM_CACHE, shared: true });
	const lockEntry = resolveToolLockfile({
		address: NASM_LOCKFILE,
		tool: "nasm",
		version: NASM_VERSION,
		plat: NASM_PLATFORM,
	});
	if (!lockEntry) {
		throw new Error(
			`no nasm.lock entry for nasm ${NASM_VERSION} (windows/x86_64) — see //rules/c/msvc/nasm.lock`,
		);
	}
	// No `tools:` mount, bare command names (curl/mkdir/unzip/mv/
	// sha256sum) resolved off ambient PATH — matches resolveMsvcHost()'s
	// own bare "sh -c" script above, not gcc's hermetic-tool-mounted
	// install task: nativeTool() only produces a resolved graph binding
	// when declared as a task's own static `inputs:` (see e.g. rules/c/
	// gcc's own install-task comment), which isn't available here — this
	// runs dynamically inside cmakeConfigure()'s already-executing task,
	// not at graph-declaration time. Same accepted ambient-host departure
	// from strict hermeticity this whole module already makes (see its own
	// header comment) — nasm.us isn't vendored/pinned the way gcc/zig's
	// own toolchains are, but its own transfer *is* still sha256-verified
	// against nasm.lock, unlike the vswhere lookup above.
	//
	// nasm-<version>-win64.zip wraps its contents (nasm.exe, ndisasm.exe,
	// LICENSE) in one top-level "nasm-<version>/" directory — stripped the
	// same way gccGraphToolWindows() strips WinLibs' own wrapping
	// "mingw64/" directory: unzip has no --strip-components equivalent, so
	// this downloads and stages into a side directory, then moves its
	// contents up into the real output.
	const script =
		'url=$1; sha=$2; size=$3; out=$4; ' +
		'mkdir -p "$out" "$out.stage" && ' +
		'curl -fSL -o "$out.zip" "$url" && ' +
		'actual=$(wc -c < "$out.zip") && ' +
		'{ [ "$actual" -eq "$size" ] || { echo "size mismatch for nasm download: expected $size bytes, got $actual" >&2; exit 1; }; } && ' +
		'printf "%s  %s\\n" "$sha" "$out.zip" | sha256sum -c - && ' +
		'unzip -q "$out.zip" -d "$out.stage" && ' +
		'mv "$out.stage"/*/* "$out"/';
	await exec.action({
		argv: [
			"sh",
			"-c",
			script,
			"nasm-install",
			lockEntry.url,
			lockEntry.sha256,
			String(lockEntry.size),
			"nasm-toolchain",
		],
		outputs: {
			directory: output.directory("nasm-toolchain", {
				namedCache: { name: NASM_CACHE, key: NASM_KEY },
			}),
		},
		display: `install nasm ${NASM_VERSION}`,
	});
	return `${cacheGet(NASM_CACHE, NASM_KEY)}/nasm.exe`;
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
 * @param {string} nasmPath Real, absolute host path to nasm.exe — see
 *   resolveNasmHost().
 * @returns {string[]}
 */
export function msvcCMakeCompilerArgs(host, nasmPath) {
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
		// MSVC ships no assembler of its own, unlike gcc's WinLibs
		// distribution (see gccCMakeCompilerArgs()'s own
		// -DCMAKE_ASM_NASM_COMPILER) — set unconditionally the same way
		// gcc's own is, harmless for a project that never
		// enable_language(ASM_NASM)s, required (confirmed by a real
		// configure failure: "No CMAKE_ASM_NASM_COMPILER could be found")
		// for one that does, e.g. BoringSSL's hand-optimized Windows
		// assembly routines.
		`-DCMAKE_ASM_NASM_COMPILER=${nasmPath}`,
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
	// BoringSSL's Windows build bakes nasm's absolute path (see
	// msvcCMakeCompilerArgs()'s own -DCMAKE_ASM_NASM_COMPILER) into
	// build.ninja at configure time; replay rewrites it back to a bare
	// name the same way it does for cl/link/lib/rc/mt — mirrors
	// rules/c/gcc's own GCC_GRAPH_TOOL_NAMES "nasm"/"nasm.exe" entries.
	"nasm",
	"nasm.exe",
]);

// rc.exe/mt.exe live under the Windows SDK root, not the VS/VC root the rest
// of MSVC_GRAPH_TOOL_NAMES resolves against — see MSVC_SDK_CACHE's own
// comment.
const MSVC_SDK_TOOL_NAMES = new Set(["rc", "rc.exe", "mt", "mt.exe"]);

// nasm.exe lives under its own downloaded NASM_CACHE (see resolveNasmHost()),
// not the VS/VC root or the Windows SDK root the rest of
// MSVC_GRAPH_TOOL_NAMES resolves against.
const NASM_TOOL_NAMES = new Set(["nasm", "nasm.exe"]);

/**
 * A `{name, cache, key, binDirs}` tool spec for cl.exe/link.exe/lib.exe/
 * nasm.exe, mountable directly via `exec.action({tools: [...]})` — mirrors
 * rules/c/gcc's gccGraphToolSpec(), except the "install" is just
 * cachePut()-registering the ambient VS root resolveMsvcHost() already
 * found (see this module's own header comment on why: there's nothing to
 * download, the toolchain already exists on the host) — nasm.exe is the
 * one exception, actually downloaded by resolveNasmHost().
 *
 * @param {string} name One of MSVC_GRAPH_TOOL_NAMES.
 * @param {{vsRoot: string, mscVersion: string}} host Already-resolved (and
 *   cachePut()'d) via resolveMsvcHost() earlier in the same task run().
 *   Unused for nasm.exe, which resolves by cache name alone.
 * @returns {{name: string, cache: string, key: string, binDirs: string[]}}
 */
export function msvcGraphToolSpec(name, host) {
	// resolveMsvcHost() cachePut()s the bin directory itself as the cache
	// root (not the whole VS/SDK install — see its own comment), so the
	// mount's binDirs is just "." here, unlike gcc's toolchain-root-relative
	// paths.
	if (NASM_TOOL_NAMES.has(name)) {
		return { kind: "tool", name, cache: NASM_CACHE, key: NASM_KEY, binDirs: ["."] };
	}
	return MSVC_SDK_TOOL_NAMES.has(name)
		? { kind: "tool", name, cache: MSVC_SDK_CACHE, key: MSVC_SDK_KEY, binDirs: ["."] }
		: { kind: "tool", name, cache: MSVC_HOST_CACHE, key: MSVC_HOST_KEY, binDirs: ["."] };
}
