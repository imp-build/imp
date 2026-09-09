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

import {
	Toolchain,
	cacheGet,
	cacheHas,
	cachePut,
	namedCache,
	output,
	platformInfo,
	task,
	tool as graphTool,
	toolName,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	downloadToolArtifact,
	lockfileAddressToPath,
	lockfileFor,
} from "//rules/imp/lockfile";
import { toolchainBin } from "//rules/imp/toolchain";
import { shellQuote } from "//rules/c/toolchain";
import {
	GEN_LOCKFILES,
	graphGenerateToolLockfile,
	registerToolchainLockfile,
} from "//rules/workflows/lockfiles";

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
const DEFAULT_LOCKFILE = "//rules/c/msvc/nasm.lock";

// Declared tool identity for the "nasm-toolchain" kind's TOOLCHAIN product
// (imp @nasm dispatch). Distinct from NASM_TOOL_NAMES below, which is the set
// of bare names a replayed ninja edge can name nasm as.
export const NASM_TOOL = toolName("nasm");

// NASM publishes one Windows x86_64 build per release.
const NASM_SUPPORTED_PLATFORMS = [{ os: "windows", arch: "x86_64" }];

/**
 * Return the platforms NASM publishes release archives for.
 *
 * @returns {Array<{ os: string, arch: string }>}
 */
export function nasmSupportedPlatforms() {
	return NASM_SUPPORTED_PLATFORMS.map((plat) => ({ ...plat }));
}

/**
 * Return the NASM release archive filename for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function nasmArtifactName(version, plat) {
	if (plat.os !== "windows" || plat.arch !== "x86_64") {
		throw new Error(
			`unsupported NASM platform: ${plat.os}/${plat.arch} (windows/x86_64 only)`,
		);
	}
	return `nasm-${version}-win64.zip`;
}

/**
 * Return the NASM release download URL for a version and platform.
 *
 * @param {string} version
 * @param {{ os: string, arch: string }} plat
 * @returns {string}
 */
export function nasmDownloadUrl(version, plat) {
	return `https://www.nasm.us/pub/nasm/releasebuilds/${version}/win64/${nasmArtifactName(version, plat)}`;
}

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
// (see rules/c/gcc's/rules/c/zig's own commands()) — reads the already-
// resolved ambient host (msvcHostGraphOutput()) and returns cl.exe/lib.exe-
// flavored structural argv builders for ccTask() (rules/c/index.js) to
// assemble a compile/archive/link "sh -c" script around, translating the
// same three shapes gcc/zig do (-c/-o/-I -> /c//Fo//I, `ar rcs` -> `lib.exe
// /OUT:`, -shared -> /LD) instead of the clang/gcc vocabulary ccTask() used
// to hardcode. Real cl.exe/lib.exe (not clang-cl) — see discoverMsvcHost()'s
// own docstring for why this module resolves the ambient host toolchain
// rather than vendoring one.
function msvcToolchainCommands(exec, input) {
	const host = input.msvcHost;
	// Unlike gcc/zig (whose compiler mount is the *only* thing taskInputs()
	// carries), msvcToolchain()'s taskInputs() also carries the resolved
	// host record itself (see msvcHostGraphOutput() below) — discovered once
	// by its own dedicated task node, not re-shelled-out-to per caller. The
	// tool specs are still handed back here (rather than mounted via
	// exec.tool() up front) for ccTask() to splice directly into each
	// exec.action()'s own `tools:` list instead.
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

// Built once (module-scoped memoization, mirroring rules/c/gcc's own
// graphToolchains Map) rather than one task() call per msvcToolchain()
// caller: task() itself dedupes two calls that describe identical work, but
// this guard avoids relying on that — it's the same node every caller gets,
// so every ccLibrary()/ccBinary()/cmakeProject() consumer's compile/archive/
// link/configure task shares one "discover MSVC host toolchain" graph node
// instead of the graph coincidentally collapsing a pile of look-alike ones.
let msvcHostGraphTask = null;

export function __resetMsvcHostTaskForTest() {
	msvcHostGraphTask = null;
}

// The task-output handle every taskInputs() below hands out as `msvcHost` —
// a "value" output (see discoverMsvcHost()'s own return value), not a file:
// the graph resolves it to the plain {vsRoot, mscVersion, sdkRoot,
// sdkVersion} record directly, no digest/readFileInDigest indirection
// needed. Declared with `cache: false`, same as the exec.action() this
// replaces used to be (see discoverMsvcHost()'s own docstring) — this node
// still re-runs once per `imp build` invocation rather than persisting
// across builds, so a changed host VS install is still picked up on the
// next build. What changes is *within* one invocation: every consumer now
// depends on this one node instead of each independently shelling out to
// vswhere, so it runs once per build, not once per compiled source file.
//
// A real host-identity fingerprint (e.g. the VS instance ID) could replace
// `cache: false` with a normal cached task keyed on that identity, so a
// build only re-discovers when the host's VS install actually changes —
// deferred for now; this task's shape (empty declared inputs today) is
// exactly where that key would go.
function msvcHostGraphOutput() {
	if (!msvcHostGraphTask) {
		msvcHostGraphTask = task({
			display: "discover MSVC host toolchain",
			cache: false,
			inputs: {},
			outputs: { host: output.value() },
			async run(exec) {
				return { host: await discoverMsvcHost(exec) };
			},
		});
	}
	return msvcHostGraphTask.outputs.host;
}

/**
 * Declare the ambient host MSVC toolchain — pass as `cmakeProject({
 * toolchain })`. There is no version to pick (unlike gccGraphToolchain() /
 * zigGraphToolchain()): this always resolves whatever Visual Studio the
 * host has installed, via one shared "discover MSVC host toolchain" graph
 * node (msvcHostGraphOutput()) rather than a fresh vswhere shellout per
 * caller.
 *
 * Also conforms to the shared cc-toolchain provider contract (`kind`,
 * `taskInputs`, `commands`, `cmakeConfigure`, `resolvesToolName`, `toolSpec`,
 * `resolveState`, `edgeEnv`) — see rules/c/gcc's and rules/c/zig's own
 * toolchain constructors for the other two providers, and
 * rules/c/toolchain.js's ccToolchainForPlatform() for the platform-indexed
 * union all three plug into. This object literal is still inert to
 * construct (no vswhere lookup, no action) — only taskInputs() references
 * the discovery task node, and only calling it (via any consumer's declared
 * inputs) causes it to actually run.
 *
 * @returns {object} Toolchain handle for cmakeProject()'s `toolchain` option.
 */
export function msvcToolchain() {
	return {
		kind: "msvc-host-toolchain",
		version: null,
		taskInputs: () => ({
			msvcHost: msvcHostGraphOutput(),
			// nasm is Windows-only, and so is this whole toolchain provider —
			// declaring it off Windows would only accumulate dead graph nodes
			// for a msvcToolchain() target configured on a Linux CI host.
			...(platformInfo().os === "windows"
				? { nasm: nasmGraphToolFor(resolveNasmVersion()) }
				: {}),
		}),
		// ccTask() (rules/c/index.js) now asks the toolchain to build its own
		// compile/archive/link argv (see msvcToolchainCommands() above)
		// instead of hardcoding clang/gcc flag syntax around a bare compiler
		// path — this is what makes msvcToolchain() usable from ccLibrary()/
		// ccBinary() directly, not just cmakeProject() (which sidestepped
		// this by letting CMake itself own the flag vocabulary).
		commands: (exec, input) => msvcToolchainCommands(exec, input),
		cmakeConfigure: async (exec, input) => {
			const host = input.msvcHost;
			const nasmPath = resolveNasmHost(exec, input.nasm);
			return {
				compilerArgs: msvcCMakeCompilerArgs(host, nasmPath),
				env: msvcEnv(host),
			};
		},
		resolvesToolName: (name) => MSVC_GRAPH_TOOL_NAMES.has(name),
		toolSpec: (name, host) => msvcGraphToolSpec(name, host),
		resolveState: (exec, input) => input.msvcHost,
		edgeEnv: (host) => msvcEnv(host),
	};
}

export function isMsvcToolchain(toolchain) {
	return !!toolchain && toolchain.kind === "msvc-host-toolchain";
}

/**
 * Discover the ambient host MSVC toolchain (VS install root, MSVC tools
 * version, Windows SDK root/version) by shelling out to vswhere.exe. Runs
 * exactly once per build invocation, inside msvcHostGraphOutput()'s own
 * dedicated task node — not called directly by any consumer.
 *
 * The vswhere lookup itself is deliberately not cached across builds the way
 * rules/c/gcc's toolchain install is (see msvcHostGraphOutput()'s own
 * `cache: false`) — this is ambient host state, not something imp itself
 * produced, so re-running vswhere (a few hundred ms) once per build is
 * simpler and safer than trying to invalidate a stale cache entry if the
 * host's VS install changes between builds.
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
async function discoverMsvcHost(exec) {
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

// NASM is a Group-A workspace-selectable toolchain (see nasmToolchain()),
// same shape as //rules/c/mold: a real Toolchain class, a declaration-time
// nasmGraphTool() built on the shared downloadToolArtifact helper, a
// [GEN_LOCKFILES] root, and a registerToolchainLockfile() spec so
// `imp goal gen-builtin-lockfiles` regenerates the shipped lock. MSVC ships
// no assembler of its own, unlike gcc's WinLibs distribution, which bundles
// nasm.exe (see gccCMakeCompilerArgs()); a msvcToolchain()-driven
// cmakeProject() that enable_language(ASM_NASM)s (e.g. BoringSSL's
// hand-optimized Windows assembly) needs one.
export class NasmToolchain extends Toolchain {
	static kind = "nasm-toolchain";
	static tool = NASM_TOOL;
	constructor({ version, lockfile, unverified }, opts) {
		super(
			{
				kind: NasmToolchain.kind,
				attrs: { version, lockfile, ...(unverified ? { unverified } : {}) },
			},
			opts,
		);
	}

	bin() {
		return nasmHostBin(this.attrs.version);
	}
}

// Built once per declared version, at declaration time: task() refuses to add
// graph nodes during execution, and resolveNasmHost() (below) resolves nasm
// while cmakeConfigure()'s task is already running, so it must find a handle
// here rather than build one. Mirrors //rules/c/mold's own graphToolchains Map.
let nasmGraphTools = new Map();

export function __resetNasmToolchainStateForTest() {
	NasmToolchain.clearDefault();
	nasmGraphTools = new Map();
}

function resolveNasmVersion(version) {
	return NasmToolchain.resolveVersion(version) ?? NASM_VERSION;
}

function nasmGraphToolFor(version) {
	return nasmGraphTools.get(version) ?? nasmGraphTool(version);
}

/**
 * Build the managed NASM assembler as a graph-native tool: the shared
 * verified download (downloadToolArtifact) plus a wrapper-strip extract task
 * that publishes nasm.exe into NASM_CACHE. Mirrors moldGraphTool() in
 * //rules/c/mold.
 *
 * @param {string} [version]
 * @returns {object} Graph tool handle for the installed NASM directory.
 */
export function nasmGraphTool(version) {
	const resolved = resolveNasmVersion(version);
	// NASM ships a Windows x86_64 build only, and the whole MSVC path is
	// Windows-only — hardcode the platform so this stays inert and crash-free
	// when the graph is built on a Linux CI host for a msvcToolchain() target.
	const plat = NASM_PLATFORM;
	namedCache({ name: NASM_CACHE, shared: true });
	const archive = downloadToolArtifact({
		lockfile: lockfileFor(NasmToolchain, resolved, DEFAULT_LOCKFILE),
		tool: "nasm",
		version: resolved,
		plat,
		url: nasmDownloadUrl(resolved, plat),
		output: `nasm-downloads/${resolved}/${nasmArtifactName(resolved, plat)}`,
		display: `download nasm ${resolved} (windows/x86_64)`,
		unverified: NasmToolchain.resolveUnverified(resolved),
	});
	const mkdir = nativeTool("mkdir");
	const unzip = nativeTool("unzip");
	const mv = nativeTool("mv");
	const sh = nativeTool("sh");
	const directory = task({
		display: `install nasm ${resolved} (windows/x86_64)`,
		inputs: { archive, mkdir, unzip, mv, sh },
		outputs: { directory: output.artifact() },
		async run(exec, inputs) {
			// nasm-<version>-win64.zip wraps its payload (nasm.exe, ndisasm.exe,
			// LICENSE) in one top-level "nasm-<version>/" directory. unzip has no
			// --strip-components, so stage into a side directory and move the
			// contents up — the same strip gccGraphToolWindows() does for
			// WinLibs' "mingw64/" wrapper. Size and sha256 are already verified
			// by downloadToolArtifact above.
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					'mkdir -p "$2" "$2.stage" && unzip -q "$1" -d "$2.stage" && mv "$2.stage"/*/* "$2"',
					"nasm-install",
					exec.path(inputs.archive),
					"nasm-toolchain",
				],
				tools: [inputs.mkdir, inputs.unzip, inputs.mv, inputs.sh],
				outputs: {
					directory: output.directory("nasm-toolchain", {
						namedCache: { name: NASM_CACHE, key: NASM_KEY },
					}),
				},
			});
			return { directory: result.outputs.directory };
		},
	}).outputs.directory;
	return graphTool(directory, { binDirs: ["."] });
}

/**
 * Declare the NASM assembler toolchain and optionally set it as the default.
 * A msvcToolchain()-driven cmakeProject() picks up whatever default is
 * declared — see resolveNasmHost().
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {boolean} [opts.default=false]
 * @param {boolean} [opts.unverified=false] Allow downloading without a
 *   matching lockfile entry (warns instead of failing).
 * @param {string} [opts.lockfile] Address of a workspace-owned lockfile to
 *   use instead of the shipped one, so the address is stated one time only.
 * @returns {object} Target handle for this NASM toolchain.
 * @category configuration
 */
export function nasmToolchain(version, opts = {}) {
	const resolved = version ?? NASM_VERSION;
	const lockfile = opts.lockfile ?? DEFAULT_LOCKFILE;
	// Fail on a malformed address at declaration time, not at first acquire.
	lockfileAddressToPath(lockfile);
	const toolchain = new NasmToolchain(
		{ version: resolved, lockfile, unverified: opts.unverified },
		{ default: opts.default },
	);
	toolchain[GEN_LOCKFILES] = graphGenerateToolLockfile({
		version: resolved,
		...LOCKFILE_SPEC,
		lockfile,
	});
	nasmGraphTools.set(resolved, nasmGraphTool(resolved));
	return toolchain;
}

/**
 * Lockfile generation root for a NASM toolchain declared elsewhere (e.g. via
 * a frozen handle), mirroring odinfmtGenLockfiles(). A workspace that
 * captured the nasmToolchain() handle can use handle[GEN_LOCKFILES] directly
 * instead.
 *
 * @param {string} [version]
 * @param {object} [opts]
 * @param {string} [opts.lockfile] Override the address to write.
 * @returns {object}
 */
export function nasmGenLockfiles(version, opts = {}) {
	const resolved = resolveNasmVersion(version);
	return {
		[GEN_LOCKFILES]: graphGenerateToolLockfile({
			version: resolved,
			...LOCKFILE_SPEC,
			lockfile:
				opts.lockfile ?? lockfileFor(NasmToolchain, resolved, DEFAULT_LOCKFILE),
		}),
	};
}

/**
 * The real, absolute host path to nasm.exe, installing it if necessary.
 * Backs NasmToolchain.bin() / `imp @nasm`.
 *
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function nasmHostBin(version) {
	const resolved = resolveNasmVersion(version);
	return toolchainBin(nasmGraphToolFor(resolved), {
		name: NASM_CACHE,
		key: NASM_KEY,
		exe: "nasm.exe",
	});
}

/**
 * Resolve the NASM assembler for a msvcToolchain()-driven cmakeProject().
 *
 * Acquisition is declared at graph-declaration time by nasmGraphTool() (the
 * shared downloadToolArtifact plus a wrapper-strip extract task) and reaches
 * this helper as the task's already-resolved `nasm` input
 * (msvcToolchain().taskInputs()). exec.path() is called only to consume() the
 * binding so the graph scheduler orders the install task first — the same
 * shape as moldBinDir() in //rules/c/mold.
 *
 * @param {object} exec Task's exec.
 * @param {object} resolvedNasmTool The task's resolved `nasm` input.
 * @returns {string} Real, absolute host path to nasm.exe.
 */
export function resolveNasmHost(exec, resolvedNasmTool) {
	exec.path(resolvedNasmTool);
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
 * cachePut()-registering the ambient VS root discoverMsvcHost() already
 * found (see this module's own header comment on why: there's nothing to
 * download, the toolchain already exists on the host) — nasm.exe is the
 * one exception, actually downloaded by nasmGraphTool().
 *
 * @param {string} name One of MSVC_GRAPH_TOOL_NAMES.
 * @param {{vsRoot: string, mscVersion: string}} host Already-resolved (and
 *   cachePut()'d) via discoverMsvcHost() earlier in the same task run().
 *   Unused for nasm.exe, which resolves by cache name alone.
 * @returns {{name: string, cache: string, key: string, binDirs: string[]}}
 */
export function msvcGraphToolSpec(name, host) {
	// discoverMsvcHost() cachePut()s the bin directory itself as the cache
	// root (not the whole VS/SDK install — see its own comment), so the
	// mount's binDirs is just "." here, unlike gcc's toolchain-root-relative
	// paths.
	if (NASM_TOOL_NAMES.has(name)) {
		return {
			kind: "tool",
			name,
			cache: NASM_CACHE,
			key: NASM_KEY,
			binDirs: ["."],
		};
	}
	return MSVC_SDK_TOOL_NAMES.has(name)
		? {
				kind: "tool",
				name,
				cache: MSVC_SDK_CACHE,
				key: MSVC_SDK_KEY,
				binDirs: ["."],
			}
		: {
				kind: "tool",
				name,
				cache: MSVC_HOST_CACHE,
				key: MSVC_HOST_KEY,
				binDirs: ["."],
			};
}

const LOCKFILE_SPEC = registerToolchainLockfile(
	{
		name: "nasm",
		platforms: nasmSupportedPlatforms(),
		downloadUrl: nasmDownloadUrl,
		artifactName: nasmArtifactName,
		lockfile: DEFAULT_LOCKFILE,
	},
	[NASM_VERSION],
);

// Importing this rule provisions the pinned default — Windows only: nasm has
// no other platform, and the whole msvcToolchain()/cmakeConfigure() path is
// Windows-only, so an eager build must not run on a Linux/macOS workspace
// import. A workspace can still declare its own nasmToolchain(..., { default:
// true }) explicitly.
if (platformInfo().os === "windows") {
	nasmToolchain(NASM_VERSION, { default: true });
}
