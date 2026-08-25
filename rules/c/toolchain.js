// Platform-indexed C/C++ toolchain provider union — follow-up to PR #165's
// review ("the public abstraction needs to be a platform-indexed ccToolchain
// union, rather than a single selected provider").
//
// gccGraphToolchain()/zigGraphToolchain()/msvcToolchain() (see
// //rules/c/gcc, //rules/c/zig, //rules/c/msvc) all conform to the same
// duck-typed provider contract now: `kind`, `taskInputs()`, `commands()`,
// `cmakeConfigure()`, `resolvesToolName()`, `toolSpec()`, `resolveState()`,
// `edgeEnv()`. Everything that dispatches on toolchain kind (rules/c/index.js's
// ccLibrary()/ccBinary(), rules/c/cmake/graph_replay.js's configure/replay)
// calls through that contract instead of duck-typing/kind-branching per
// call site. This module adds the one piece the contract doesn't cover on
// its own: picking *which* provider is active for the current platform,
// while keeping every other branch inert.

import { platformInfo } from "imp:core";

// Shared bash-argv quoting for a single sh -c script token — every provider's
// compileCommand()/archiveCommand()/linkCommand() (see gcc's/zig's/msvc's own
// commands()) runs through "sh -c" regardless of which native compiler it
// invokes, so this level of quoting is the same across every toolchain; only
// a response-file's own *content* (parsed by the native tool itself, not
// bash) needs a toolchain-specific quoting function — see each provider's own
// rspQuote().
export function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// -O2/-DNDEBUG vs -O0/-g: shared between gcc and zig, whose "cc"/"clang"
// front ends both accept the same clang/gcc-style flag vocabulary — not
// shared with msvc, which spells the same intent as /O2 /DNDEBUG vs /Od /Zi
// (see rules/c/msvc's own msvcOptFlags()).
export function clangOptFlags(opt) {
	return opt === "release" ? ["-O2", "-DNDEBUG"] : ["-O0", "-g"];
}

/**
 * Wrap one provider per OS into a single selectable union — "the same
 * logical target keeps one toolchain shape while selecting GCC on Linux and
 * MSVC on Windows" per the PR #165 review. Pass to cmakeProject()/
 * ccLibrary()/ccBinary()'s `toolchain` option in place of a bare provider.
 *
 * Each `byOs` branch may be an already-constructed provider or a zero-arg
 * thunk — pass whichever reads more clearly at the call site; it makes
 * little practical difference. Calling `msvcToolchain()` itself is still
 * inert (a plain object literal, no I/O) — its one graph node (the shared
 * "discover MSVC host toolchain" task, see //rules/c/msvc's own
 * msvcHostGraphOutput()) is only registered once some consumer's
 * `taskInputs()` call actually reaches it, same as any other lazily-declared
 * task node. gccGraphToolchain()/zigGraphToolchain() do register a real download/
 * install task() graph node when called, for whichever platform is
 * executing right now — but merely *declaring* that node costs nothing
 * unless something downstream actually requests its output (imp only
 * executes reachable task nodes), and both modules already declare their
 * own pinned-default install node unconditionally as a side effect of
 * being imported at all (see gcc's/zig's own bottom-of-file
 * `gccToolchain(..., {default: true})`/`zigToolchain(..., {default:
 * true})`) — before this union or any thunk here ever runs. So a thunk
 * only avoids one *additional*, redundant such node on a branch that
 * never gets selected; it's not the difference between "downloads gcc" and
 * "doesn't."
 *
 * Selection is by `targetPlatform.os` only (no `arch` axis): every provider
 * today hardcodes x86_64 support, so there is nothing downstream yet that
 * would act on an arch key.
 *
 * @param {{[os: string]: object|(() => object)}} byOs Provider (or thunk)
 *   per platform `os` string (e.g. "linux", "windows", "darwin").
 * @returns {{kind: string, byOs: object, select: (targetPlatform?: {os: string, arch: string}) => object}}
 */
export function ccToolchainForPlatform(byOs) {
	return Object.freeze({
		kind: "cc-toolchain-union",
		byOs: { ...byOs },
		// targetPlatform defaults to the current execution host, but is taken
		// as an explicit parameter rather than calling platformInfo() only
		// internally — the seam the PR #165 review asked for ("keep execution
		// platform distinct from output target triple for later
		// cross-compilation support"). Actually resolving a target you're not
		// executing on is still unsupported (every provider's own host/version
		// resolution assumes host === target internally) — this only keeps the
		// union's own selection call ready for that once it exists.
		select(targetPlatform = platformInfo()) {
			const branch = byOs[targetPlatform.os];
			if (!branch) {
				throw new Error(
					`no cc toolchain configured for platform '${targetPlatform.os}' (configured: ${Object.keys(byOs).join(", ") || "none"})`,
				);
			}
			return typeof branch === "function" ? branch() : branch;
		},
	});
}

export function isCcToolchainUnion(toolchain) {
	return !!toolchain && toolchain.kind === "cc-toolchain-union";
}

/**
 * Resolve `toolchain` to a bare provider: a union is passed through
 * `.select()`, a bare provider (or nullish) is returned unchanged. Lets
 * cmakeProject()/ccLibrary()/ccBinary() accept either transparently.
 *
 * @param {object} [toolchain]
 * @param {{os: string, arch: string}} [targetPlatform]
 * @returns {object|undefined}
 */
export function selectCcToolchain(toolchain, targetPlatform) {
	return isCcToolchainUnion(toolchain)
		? toolchain.select(targetPlatform)
		: toolchain;
}
