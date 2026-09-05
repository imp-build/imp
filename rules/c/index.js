// Canonical raw C/C++ rule entrypoint (graph-native, issue #31/#61 + #63
// cutover). ccLibrary()/ccBinary() build task()-based graphs directly.
//
// deps are handle-passing, not label references: ccLibrary(A)'s result is a
// plain frozen object a caller passes directly as ccBinary({deps:[A]})'s
// dependency — a flat, eagerly-computed transitiveArchives array (mirrors
// rules/rust's cargoPackage({deps}) pattern). This output shape
// ({[BUILD], archive, transitiveArchives, transitiveSharedLibs,
// transitiveIncludeDirs, transitiveHdrs, [PACKAGE]}) is a deliberate
// cross-module contract: rules/c/cmake's graph-native
// per-target expand() children (issue #62) are meant to expose the same
// shape so a raw ccBinary({deps:[cmakeThing.get("mylib")]}) works
// transparently — see rules/c/cmake/expansion.js's own docstring for the
// known gap (issue #67) preventing that today.
//
// transitiveArchives and transitiveSharedLibs are separate buckets because a
// static archive and a shared library need different treatment, and until
// both existed the rules could not tell them apart: cmakeLibraryDep() put a
// CMake target's artifact into transitiveArchives whether it was a .a or a
// .so, while ccLibrary({shared:true}) kept its own .so out of that array and
// exposed it nowhere else. An archive is fed to both `ar` and the linker; a
// shared library is only ever fed to the linker, never to `ar`. Both buckets
// are mounted into the sandbox. A binary that has any shared library in its
// closure also *carries* it: its product becomes a directory holding the
// executable plus those libraries, linked with -Wl,-rpath,$ORIGIN so the
// loader finds them beside it at run time (see ccTask()'s own comment on
// `bundled`, and the decision entry binary-products-carry-shared-libraries).
//
// Known simplifications versus the pre-migration factory:
//   - CMakeLists.txt/main()-detection-driven generate-build support lives in
//     //rules/c/generate_build, a separate module (mirrors
//     //rules/rust/generate_build's own split from //rules/rust).
//   - One task() per target, but the run() body issues one exec.action()
//     compile call per source file (chained into a final archive/link
//     action) rather than one script compiling everything — a single shell
//     command compiling hundreds of sources overflows the argument-string
//     limit (issue #84). This also gets per-object task-cache reuse back,
//     unlike cargoPackage()'s single whole-crate cargo invocation. The
//     final archive/link action itself can still list hundreds of object/
//     archive paths, so those go through a response file materialized via
//     rspfileArgv() rather than being inlined into that action's own
//     script — see rspfileArgv()'s own docstring.
//   - hdrs are tracked as an input (so editing a header invalidates the
//     compile) but never individually inspected — same conservative
//     widening rationale as rules/c/cmake's own header handling.

import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { RUN } from "//rules/workflows/run";
import { TEST } from "//rules/workflows/test";
import {
	files,
	output,
	packagePath,
	platformInfo,
	semantic,
	task,
} from "imp:core";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { nativeTool } from "//rules/imp/native-tool";
import { defaultZigGraphToolchain } from "//rules/c/zig";
import { selectCcToolchain, shellQuote } from "//rules/c/toolchain";

export const DEFAULT_CPP_SRCS = ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx"];
export const DEFAULT_CPP_HDRS = ["**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx"];

function isCxxSource(path) {
	return /\.(cc|cpp|cxx)$/i.test(path);
}

function normalizeWorkspacePath(path) {
	const parts = [];
	for (const part of (path || ".").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`C/C++ paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function outputSlugFor(path) {
	return path === "." ? "root" : path.replace(/\//g, "_");
}

// A single sh -c script listing every object/archive/linkopt inline
// overflows on Windows once a target has enough sources (issue #84's own
// compile-step version of this problem): git-bash's sh.exe (spawned
// directly by imp's exec layer, not through another MSYS/Cygwin parent)
// silently truncates any single argv element around 8186 bytes — see
// rules/c/cmake/graph_replay.js's resolveEdgeRspfile()/RSPFILE_CHUNK_SIZE
// comment for the confirmed repro and rationale. Materializing the
// variable-length part into a response file, its content spread across
// many small chunked argv elements instead of one large one, sidesteps
// that truncation; the fixed small script itself never scales with source
// count.
const RSPFILE_CHUNK_SIZE = 4000;

function chunkRspfileContent(content) {
	const chunks = [];
	for (let i = 0; i < content.length; i += RSPFILE_CHUNK_SIZE) {
		chunks.push(content.slice(i, i + RSPFILE_CHUNK_SIZE));
	}
	return chunks;
}

// Builds exec.action() argv that writes `content` to `rspPath` (via
// chunked positional params, never inlined into the script text) before
// running `command`, which must itself reference `@`+shellQuote(rspPath)
// to consume it — ar/ranlib and gcc/clang/zig all support `@file`
// response files with the same shell-like quoting shellQuote() already
// produces, so `content` can be reused verbatim from today's inline
// command construction.
function rspfileArgv(displayName, rspPath, content, command) {
	const script = `set -e; rsp=$1; shift; : > "$rsp"; for chunk; do printf '%s' "$chunk" >> "$rsp"; done; ${command}`;
	return [
		"sh",
		"-c",
		script,
		displayName,
		rspPath,
		...chunkRspfileContent(content),
	];
}

// Resolves toolchain to a bare provider (a platform-indexed union passed
// through .select(), a bare provider unchanged — see
// //rules/c/toolchain's selectCcToolchain()) and falls back to the declared
// zig/gcc default. Every provider now conforms to the same duck-typed
// contract (kind/taskInputs/commands/...; see //rules/c/gcc's,
// //rules/c/zig's, //rules/c/msvc's own toolchain constructors), so callers
// below dispatch through it rather than shape-sniffing zig vs. gcc. Zig
// preferred over gcc by default, matching the legacy factory's own default
// order.
function resolveToolchain(toolchain) {
	const selected = selectCcToolchain(toolchain);
	const resolved =
		selected || defaultZigGraphToolchain() || defaultGccGraphToolchain();
	if (!resolved) {
		throw new Error(
			"ccLibrary()/ccBinary() need an explicit toolchain or a declared gcc/zig default — see //rules/c/gcc, //rules/c/zig",
		);
	}
	return resolved;
}

// "release"/"debug" only — each toolchain provider (see gcc's/zig's/msvc's
// own commands()) translates this into its own optimization/debug-flag
// vocabulary rather than ccTask() handing down literal flags.
//
// The value arrives as a declared `semantic.mode("opt")` task input, not
// from an ambient configuration() read. Only a declared input tells the
// graph that this task reads the `opt` axis, which is what lets one edge
// build the task under a different configuration while the tasks that read
// no axis stay shared. `null` (no axis resolved, e.g. this rule's own JS
// unit tests) reads as "debug", the declared default of the axis.
function optModeOf(value) {
	return value === "release" ? "release" : "debug";
}

function objectPathFor(outputSlug, source) {
	return `build/c/obj/${outputSlug}/${source.replace(/[^A-Za-z0-9_.-]/g, "_")}.o`;
}

// Platform-correct shared-library filename for ccLibrary({shared: true})'s
// output. The `lib` prefix is not decoration: with it, the file a consumer
// looks for at run time and the file imp builds have the same name, so
// `imp package` can publish it under a name the loader recognizes (see
// graphPackageGoal() in //rules/workflows/package). Windows uses a bare
// `<name>.dll` by its own convention.
//
// macOS isn't a supported target anywhere else in this module (see
// requireSupportedPlatform() in //rules/c/gcc), so it's not handled here
// either — it would want `.dylib`.
function sharedLibFilename(slug) {
	return platformInfo().os === "windows" ? `${slug}.dll` : `lib${slug}.so`;
}

// ---------------------------------------------------------------------------
// ccLibrary()/ccBinary() registry — declaration order, read by
// //rules/c/generate_build's dedup check. Mirrors rules/rust/index.js's own
// cargoPackageHandles().
// ---------------------------------------------------------------------------

const _ccSpecs = [];

export function ccWorkloadSpecs() {
	return _ccSpecs.slice();
}

function crateSpec(opts) {
	const {
		path = packagePath(),
		srcs = DEFAULT_CPP_SRCS,
		hdrs = DEFAULT_CPP_HDRS,
		deps = [],
		toolchain,
		copts = [],
		linkopts = [],
		unsafeSystemPaths = false,
		shared = false,
	} = opts || {};
	const normalizedPath = normalizeWorkspacePath(path);
	const spec = {
		path: normalizedPath,
		srcs: [...srcs],
		hdrs: [...hdrs],
		deps: deps || [],
		toolchain: resolveToolchain(toolchain),
		copts: [...copts],
		linkopts: [...linkopts],
		outputSlug: outputSlugFor(normalizedPath),
		shared: !!shared,
		// Bypasses Bootlin's toolchain-wrapper unsafe-path guard (see gcc's own
		// gccToolchainCommands()) — needed to link against host system packages
		// like libwebkit2gtk-4.1.
		unsafeSystemPaths: !!unsafeSystemPaths,
	};
	_ccSpecs.push(spec);
	return spec;
}

// One coarse task compiling every source (in one sandboxed script, looping
// over shell-quoted literal source/object pairs — mirrors the legacy
// factory's own shell_quote()-based script construction) and then either
// archiving (library) or linking against transitiveArchives (binary).
function ccTask(spec, isLibrary) {
	const isShared = isLibrary && spec.shared;
	const srcs = files({ root: spec.path, include: spec.srcs });
	const hdrs = files({ root: spec.path, include: spec.hdrs });
	const transitiveArchives = spec.deps.flatMap((d) => d.transitiveArchives);
	// A dep's shared libraries travel their own bucket (see this module's own
	// docstring). They reach the link step and the sandbox, never the `ar`
	// archive step. A dep predating the field contributes none, same
	// defaulting as transitiveHdrs/transitiveLinkopts below.
	const transitiveSharedLibs = spec.deps.flatMap(
		(d) => d.transitiveSharedLibs || [],
	);
	// Own linkopts stays link-step-only (not transitive) — only a dep's own
	// transitiveLinkopts (e.g. a cmakeLibraryDep()'s pkg-config-derived
	// -L/-l flags) flows into this target's own link step.
	const transitiveLinkopts = spec.deps.flatMap(
		(d) => d.transitiveLinkopts || [],
	);
	// A dep without transitiveHdrs (e.g. a raw rules/c/cmake target — see its
	// own expansion.js docstring for why it can't cheaply supply header
	// handles) just contributes no headers to mount, same asymmetry already
	// accepted for transitiveIncludeDirs there.
	const transitiveHdrs = spec.deps.flatMap((d) => d.transitiveHdrs || []);
	// A binary that links a workspace-built shared library needs that library
	// beside it at run time, so its product becomes a *directory* holding the
	// executable plus every transitive shared library under its own soname,
	// linked with -Wl,-rpath,$ORIGIN (see rpathOriginArgs() in
	// //rules/c/toolchain, and the decision entry
	// binary-products-carry-shared-libraries). A binary with no shared
	// dependency keeps the single-file product it has always had: nothing has
	// to travel beside it, and changing its shape would move every packaged
	// binary's dist/ path for no gain.
	const bundled = !isLibrary && transitiveSharedLibs.length > 0;
	// A binary's own output extension needs the platform-correct ".exe" on
	// Windows: gcc/clang/cl.exe all auto-append it to the linked file
	// themselves when the requested output name has none (PE executables
	// require it), so a declared output path without it is never actually
	// produced — confirmed by a real `imp build` failure ("run() output ...
	// was not created as a file in sandbox").
	const exeName = `${spec.outputSlug}${platformInfo().os === "windows" ? ".exe" : ""}`;
	const bundleDir = `build/c/${spec.outputSlug}.d`;
	const outPath = isShared
		? `build/c/${sharedLibFilename(spec.outputSlug)}`
		: isLibrary
			? `build/c/${spec.outputSlug}.a`
			: bundled
				? `${bundleDir}/${exeName}`
				: `build/c/${exeName}`;
	// Own path first, so a target's own headers shadow a same-named header
	// pulled in transitively.
	const includeDirs = [
		spec.path,
		...spec.deps.flatMap((d) => d.transitiveIncludeDirs),
	];

	const built = task({
		display: `cc ${isShared ? "shared-link" : isLibrary ? "archive" : "link"} ${spec.path}`,
		inputs: {
			srcs,
			hdrs,
			mkdir: nativeTool("mkdir"),
			dirname: nativeTool("dirname"),
			cp: nativeTool("cp"),
			optMode: semantic.mode("opt"),
			...spec.toolchain.taskInputs(),
			...Object.fromEntries(
				transitiveArchives.map((archive, i) => [`archive${i}`, archive]),
			),
			...Object.fromEntries(
				transitiveSharedLibs.map((sharedLib, i) => [
					`sharedLib${i}`,
					sharedLib,
				]),
			),
			...Object.fromEntries(
				transitiveHdrs.map((depHdrs, i) => [`depHdrs${i}`, depHdrs]),
			),
		},
		outputs: { artifact: output.artifact() },
		async run(exec, input) {
			const sourcePaths = exec.paths(input.srcs);
			exec.paths(input.hdrs);
			const needsCxx = sourcePaths.some(isCxxSource);
			const opt = optModeOf(input.optMode);
			const objectPaths = sourcePaths.map((source) =>
				objectPathFor(spec.outputSlug, source),
			);
			// One exec.action() per source file, not one script compiling all
			// of them: a target with hundreds of sources overflows a single
			// shell command's argument-string limit (issue #84). This also
			// restores per-object task-cache reuse the coarse single-script
			// form gave up.
			//
			// toolchain.commands() is re-resolved for every exec.action() call
			// rather than once up front: it consumes exec.tool()/exec.path()
			// bindings as a side effect, and exec.action() clears the
			// consumed set once it returns — a binding consumed for one
			// action isn't carried over and mounted into the next.
			const compileResults = await Promise.all(
				sourcePaths.map(async (source, i) => {
					const {
						compileCommand,
						env,
						tools: extraTools = [],
					} = await spec.toolchain.commands(exec, input, {
						unsafeSystemPaths: spec.unsafeSystemPaths,
					});
					const objPath = objectPaths[i];
					const commandTokens = compileCommand({
						source,
						objPath,
						isCxx: isCxxSource(source),
						includeDirs,
						opt,
						copts: spec.copts,
						isShared,
					});
					const script = `set -e; mkdir -p "$(dirname ${shellQuote(objPath)})"; ${commandTokens.join(" ")}`;
					return exec.action({
						argv: ["sh", "-c", script, "cc-compile"],
						env,
						tools: [input.mkdir, input.dirname, ...extraTools],
						inputs: [
							input.srcs,
							input.hdrs,
							...transitiveHdrs.map((_, j) => input[`depHdrs${j}`]),
						],
						outputs: { object: output.file(objPath) },
						display: `cc compile ${objPath}`,
					});
				}),
			);
			// A produced exec.action() output reappears in a later action's
			// sandbox at its own real declared path (objPath here), so the
			// archive/link command below can reference objectPaths directly —
			// it just needs the compile results listed as inputs: so they get
			// mounted at all.
			const objectSandboxPaths = objectPaths;
			// commands() must be resolved *before* exec.path()'ing the
			// dependency archives below, not after: a provider's own
			// commands() can itself consume exec.tool()/exec.path() bindings
			// (e.g. gcc's compiler()/archiver() mounting input.ccTool), and
			// exec.action() clears the consumed exec.tool()/exec.path()
			// binding set once it returns (see the compile step's own
			// comment above) — calling commands() after depArchivePaths
			// silently dropped the archive dependency's mount from this
			// action entirely (confirmed by a real MSVC `imp build` link
			// failure: "LNK1181: cannot open input file ...a", the
			// dependency simply never made it into the sandbox).
			const {
				archiveCommand,
				linkCommand,
				env,
				rspQuote,
				tools: extraTools = [],
			} = await spec.toolchain.commands(exec, input, {
				unsafeSystemPaths: spec.unsafeSystemPaths,
			});
			const depArchivePaths = transitiveArchives.map((_, i) =>
				exec.path(input[`archive${i}`]),
			);
			const depSharedLibPaths = transitiveSharedLibs.map((_, i) =>
				exec.path(input[`sharedLib${i}`]),
			);
			const actionKind = isShared
				? "shared-link"
				: isLibrary
					? "archive"
					: "link";
			const rspPath = `build/c/${spec.outputSlug}.rsp`;
			const mkdirCmd = `mkdir -p "$(dirname ${shellQuote(outPath)})"`;
			// The bundle's other half: every transitive shared library is
			// copied next to the executable, under the basename its DT_NEEDED
			// entry already names (sonameArgs() in //rules/c/toolchain is what
			// makes that basename bare). mkdirCmd above has already created
			// the bundle directory — it is the linked executable's own parent.
			//
			// These paths go into the script text rather than the response
			// file: the list scales with a target's shared dependencies, not
			// with its source count, so it can't reach the argument-string
			// limit rspfileArgv() exists to dodge.
			//
			// Two dependencies whose libraries share a basename would overwrite
			// each other here. That is the same collision the loader itself
			// would hit at run time, since DT_NEEDED carries only the basename,
			// so resolving it needs more than a copy step can decide.
			const copyCmd = bundled
				? `; cp ${depSharedLibPaths
						.map(shellQuote)
						.join(" ")} ${shellQuote(`${bundleDir}/`)}`
				: "";
			const finalArgv =
				isLibrary && !isShared
					? rspfileArgv(
							`cc-${actionKind}`,
							rspPath,
							objectSandboxPaths.map(rspQuote).join(" "),
							`${mkdirCmd}; ${archiveCommand({ outPath, rspPath }).join(" ")}`,
						)
					: (() => {
							// Object/archive paths and linkopts all go through the
							// response file's own content (rspQuote-quoted, parsed
							// by the native tool itself), not the outer sh -c
							// script — see rspfileArgv()'s own docstring for why.
							// Shared libraries follow the archives: a GNU-style link
							// line resolves left to right, so a .so listed after the
							// archives can still satisfy what they leave undefined.
							const content = [
								...objectSandboxPaths,
								...depArchivePaths,
								...depSharedLibPaths,
								...spec.linkopts,
								...transitiveLinkopts,
							]
								.map(rspQuote)
								.join(" ");
							return rspfileArgv(
								`cc-${actionKind}`,
								rspPath,
								content,
								`${mkdirCmd}; ${linkCommand({ outPath, isCxx: needsCxx, isShared, bundled, rspPath }).join(" ")}${copyCmd}`,
							);
						})();
			const result = await exec.action({
				argv: finalArgv,
				env,
				tools: [input.mkdir, input.dirname, input.cp, ...extraTools],
				inputs: compileResults.map((r) => r.outputs.object),
				outputs: {
					artifact: bundled
						? output.directory(bundleDir)
						: output.file(outPath),
				},
				display: `cc ${actionKind} ${outPath}`,
			});
			return { artifact: result.outputs.artifact };
		},
	});
	// `outPath` is the executable itself either way; the artifact's own path
	// is the bundle directory when bundled, so a caller that has to *launch*
	// the binary (ccBinary()'s [RUN], ccTest()) needs both.
	return { built, hdrs, exePath: outPath, bundled };
}

// The [RUN] root for a binary. It runs nothing itself: it resolves the built
// artifact into the `{digest, path}` description //rules/workflows/run stages
// and launches (see its own docstring for the accepted shapes). `cache: false`
// mirrors //rules/python/source's own run descriptor — the described program
// is impure by definition and re-describing it is cheap.
//
// `exePath` rather than the artifact's own path: a bundled binary's artifact
// *is* the product directory, and execing a directory is not a program.
function runDescriptor(spec, executable, exePath, bundled) {
	return task({
		display: `cc run ${spec.path}`,
		cache: false,
		inputs: { artifact: executable, exePath, bundled },
		outputs: { run: output.value() },
		async run(_exec, input) {
			return { run: { digest: input.artifact.digest, path: input.exePath } };
		},
	});
}

// ccTest()'s [TEST] root: run the built executable, and report its exit code
// as one unit in the {name, ok, output} contract graphTestGoal() aggregates
// (see //rules/workflows/test). `allowFailure` is what makes a failing test a
// reported unit rather than a thrown build error — the same contract
// //rules/rust's crateTestTask() and //rules/c/cmake's runCTestTask() use.
//
// A bundled binary is launched through its own product directory, so $ORIGIN
// resolves to the directory holding its shared libraries and the loader needs
// no LD_LIBRARY_PATH.
function testTask(spec, executable, exePath, bundled) {
	return task({
		display: `cc test ${spec.path}`,
		inputs: { artifact: executable, exePath, bundled },
		outputs: { units: output.value() },
		async run(exec, input) {
			const root = exec.path(input.artifact);
			const program = input.bundled
				? `${root}/${input.exePath.split("/").pop()}`
				: root;
			const result = await exec.action({
				argv: [program],
				inputs: [input.artifact],
				allowFailure: true,
				display: `cc test ${spec.path}`,
			});
			const ok = result.exitCode === 0;
			return {
				units: [
					{
						name: spec.path,
						ok,
						...(ok
							? {}
							: {
									output: [result.stdout, result.stderr]
										.filter(Boolean)
										.join("\n"),
								}),
					},
				],
			};
		},
	});
}

/**
 * Declare a graph-native raw C/C++ library. `deps` takes other
 * ccLibrary()/cmake-project-target call results directly (handle-passing,
 * not label references) — see this module's own docstring for the
 * transitiveArchives contract shared with rules/c/cmake's graph-native
 * targets.
 *
 * @category target
 * @param {object} [opts]
 * @param {string} [opts.path] Workspace-relative directory. Defaults to the calling BUILD.js's own directory (".").
 * @param {string[]} [opts.srcs] Source glob, default DEFAULT_CPP_SRCS.
 * @param {string[]} [opts.hdrs] Header glob (input-only, not individually inspected), default DEFAULT_CPP_HDRS.
 * @param {Array<object>} [opts.deps=[]] Other ccLibrary()/cmake-target results this library links against.
 * @param {object} [opts.toolchain] gccGraphToolchain()/zigGraphToolchain() result, or the workspace default.
 * @param {string[]} [opts.copts=[]] Extra compiler flags.
 * @param {boolean} [opts.unsafeSystemPaths=false] Bypass Bootlin's toolchain-wrapper unsafe-path guard (which rejects -I/-isystem/-L flags under /usr/include or /usr/lib) so this target can link against host system packages (e.g. libwebkit2gtk-4.1). No-op on a zig toolchain, which has no such guard.
 * @param {boolean} [opts.shared=false] Build a dynamically-loadable shared object (`-shared`, platform-correct extension: `.dll` on Windows, `.so` elsewhere) instead of a static `.a` archive. The result is reported as `transitiveSharedLibs` rather than `transitiveArchives`, so a dependent ccLibrary()/ccBinary() links against it but never tries to `ar` it in. A consumer's product carries the library beside its own executable and is linked with an `$ORIGIN` rpath, so it also loads at run time — see ccBinary().
 * @returns {object} Frozen `{[BUILD], archive, transitiveArchives, transitiveSharedLibs, transitiveIncludeDirs, transitiveHdrs, transitiveLinkopts, [PACKAGE]}`.
 */
export function ccLibrary(opts = {}) {
	const spec = crateSpec(opts);
	const { built, hdrs } = ccTask(spec, true);
	const archive = built.outputs.artifact;
	return Object.freeze({
		spec,
		[BUILD]: archive,
		archive,
		transitiveArchives: spec.shared
			? spec.deps.flatMap((d) => d.transitiveArchives)
			: [archive, ...spec.deps.flatMap((d) => d.transitiveArchives)],
		// The mirror of transitiveArchives above: a shared library's own
		// output goes here and nowhere else, so a consumer's link step can
		// reach it while its `ar` step cannot.
		transitiveSharedLibs: spec.shared
			? [archive, ...spec.deps.flatMap((d) => d.transitiveSharedLibs || [])]
			: spec.deps.flatMap((d) => d.transitiveSharedLibs || []),
		transitiveIncludeDirs: [
			spec.path,
			...spec.deps.flatMap((d) => d.transitiveIncludeDirs),
		],
		transitiveHdrs: [hdrs, ...spec.deps.flatMap((d) => d.transitiveHdrs || [])],
		// Own linkopts (this library's own link step — irrelevant, ccLibrary()
		// archives rather than links) is deliberately not folded in here; only
		// a dep's own transitiveLinkopts flows through (see ccTask()'s own
		// comment on the same asymmetry).
		transitiveLinkopts: spec.deps.flatMap((d) => d.transitiveLinkopts || []),
		[PACKAGE]: archive,
	});
}

/**
 * Declare a graph-native raw C/C++ binary. Same `deps`/toolchain contract as
 * ccLibrary() — see this module's own docstring.
 *
 * @category target
 * @param {object} [opts]
 * @param {string} [opts.path] Workspace-relative directory. Defaults to the calling BUILD.js's own directory (".").
 * @param {string[]} [opts.srcs] Source glob, default DEFAULT_CPP_SRCS.
 * @param {string[]} [opts.hdrs] Header glob, default DEFAULT_CPP_HDRS.
 * @param {Array<object>} [opts.deps=[]] ccLibrary()/cmake-target results this binary links against.
 * @param {object} [opts.toolchain] gccGraphToolchain()/zigGraphToolchain() result, or the workspace default.
 * @param {string[]} [opts.copts=[]] Extra compiler flags.
 * @param {string[]} [opts.linkopts=[]] Extra linker flags for this binary's own link step (not propagated to anything that might depend on it — deps' own `transitiveLinkopts` are folded in automatically instead).
 * @param {boolean} [opts.unsafeSystemPaths=false] Bypass Bootlin's toolchain-wrapper unsafe-path guard (which rejects -I/-isystem/-L flags under /usr/include or /usr/lib) so this target can link against host system packages (e.g. libwebkit2gtk-4.1). No-op on a zig toolchain, which has no such guard.
 * @returns {object} Frozen `{[BUILD], [PACKAGE], [RUN]}`. The product is a single executable file, or a directory holding the executable plus every transitive shared library when there is one (see this module's own docstring).
 */
export function ccBinary(opts = {}) {
	const spec = crateSpec(opts);
	const { built, exePath, bundled } = ccTask(spec, false);
	const executable = built.outputs.artifact;
	return Object.freeze({
		spec,
		[BUILD]: executable,
		[PACKAGE]: executable,
		[RUN]: runDescriptor(spec, executable, exePath, bundled).outputs.run,
	});
}

/**
 * Declare a graph-native raw C/C++ test binary: a ccBinary() whose exit code
 * is the test result. Same `deps`/toolchain contract as ccBinary() — see this
 * module's own docstring.
 *
 * The binary is run with no arguments and nothing else mounted, so an
 * assertion belongs inside `main()` (`return actual == expected ? 0 : 1`).
 * That is the same granularity //rules/c/cmake reports for a CTest entry and
 * //rules/rust for a test binary: one unit per executable, not per case.
 *
 * @category target
 * @param {object} [opts] Every ccBinary() option, unchanged.
 * @returns {object} Frozen `{[BUILD], [RUN], [TEST]}`.
 */
export function ccTest(opts = {}) {
	const spec = crateSpec(opts);
	const { built, exePath, bundled } = ccTask(spec, false);
	const executable = built.outputs.artifact;
	return Object.freeze({
		spec,
		[BUILD]: executable,
		[RUN]: runDescriptor(spec, executable, exePath, bundled).outputs.run,
		[TEST]: testTask(spec, executable, exePath, bundled).outputs.units,
	});
}
