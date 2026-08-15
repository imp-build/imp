// Canonical raw C/C++ rule entrypoint (graph-native, issue #31/#61 + #63
// cutover). ccLibrary()/ccBinary() build task()-based graphs directly.
//
// deps are handle-passing, not label references: ccLibrary(A)'s result is a
// plain frozen object a caller passes directly as ccBinary({deps:[A]})'s
// dependency — a flat, eagerly-computed transitiveArchives array (mirrors
// rules/rust's cargoPackage({deps}) pattern). This output shape
// ({[BUILD], archive, transitiveArchives, transitiveIncludeDirs,
// transitiveHdrs, [PACKAGE]}) is a deliberate cross-module contract: rules/c/cmake's graph-native
// per-target expand() children (issue #62) are meant to expose the same
// shape so a raw ccBinary({deps:[cmakeThing.get("mylib")]}) works
// transparently — see rules/c/cmake/expansion.js's own docstring for the
// known gap (issue #67) preventing that today.
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
//     unlike cargoPackage()'s single whole-crate cargo invocation.
//   - hdrs are tracked as an input (so editing a header invalidates the
//     compile) but never individually inspected — same conservative
//     widening rationale as rules/c/cmake's own header handling.

import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { configuration, files, output, packagePath, task } from "imp:core";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { defaultZigGraphToolchain, zigGraphCacheEnv } from "//rules/c/zig";

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

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Resolves a graph-native gcc or zig toolchain — distinguished by shape
// (zig's carries a buildCacheTool, gcc's doesn't; see rules/c/gcc's
// gccGraphToolchain()/rules/c/zig's zigGraphToolchain()), not a class/kind
// tag, since both are plain frozen records. Zig preferred over gcc by
// default, matching the legacy factory's own default order.
function resolveToolchain(toolchain) {
	const resolved =
		toolchain || defaultZigGraphToolchain() || defaultGccGraphToolchain();
	if (!resolved) {
		throw new Error(
			"ccLibrary()/ccBinary() need an explicit toolchain or a declared gcc/zig default — see //rules/c/gcc, //rules/c/zig",
		);
	}
	return resolved;
}

function isZigToolchain(toolchain) {
	return !!toolchain.buildCacheTool;
}

// The task()-input slice a resolved toolchain contributes — merge into any
// task's own `inputs:` map, mirroring rules/rust's linkerToolInputs().
function toolchainTaskInputs(toolchain) {
	return {
		ccTool: toolchain.tool,
		...(isZigToolchain(toolchain)
			? { ccBuildCacheTool: toolchain.buildCacheTool }
			: {}),
	};
}

// Resolves the executable-token prefix (zig's own tools are invoked as
// `zig <subcommand>`, two tokens) and env additions for compiling/archiving
// with a resolved toolchain, from inside a task's run().
function toolchainCommands(exec, toolchain, input, unsafeSystemPaths) {
	if (isZigToolchain(toolchain)) {
		const zigExe = exec.tool(input.ccTool, "zig");
		return {
			compiler: (isCxx) => [zigExe, isCxx ? "c++" : "cc"],
			archiver: () => [zigExe, "ar"],
			env: zigGraphCacheEnv(exec, input.ccBuildCacheTool),
		};
	}
	// unsafeSystemPaths swaps in the "-unsafe-paths" aliases (see
	// rules/c/gcc's gccGraphTool() install-step comment), which bypass
	// Bootlin's toolchain-wrapper unsafe-path guard — a no-op concern for zig
	// (no such wrapper/guard), so only the gcc branch here checks it.
	const suffix = unsafeSystemPaths ? "-unsafe-paths" : "";
	return {
		compiler: (isCxx) => [
			exec.tool(input.ccTool, isCxx ? `c++${suffix}` : `clang${suffix}`),
		],
		archiver: () => [exec.tool(input.ccTool, "ar")],
		env: [],
	};
}

function optFlags() {
	const mode = configuration("imp.mode", {}) || {};
	return mode.opt === "release" ? ["-O2", "-DNDEBUG"] : ["-O0", "-g"];
}

function objectPathFor(outputSlug, source) {
	return `build/c/obj/${outputSlug}/${source.replace(/[^A-Za-z0-9_.-]/g, "_")}.o`;
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
		// Bypasses Bootlin's toolchain-wrapper unsafe-path guard (see
		// toolchainCommands()'s own comment) — needed to link against host
		// system packages like libwebkit2gtk-4.1.
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
	const srcs = files({ root: spec.path, include: spec.srcs });
	const hdrs = files({ root: spec.path, include: spec.hdrs });
	const outPath = isLibrary
		? `build/c/${spec.outputSlug}.a`
		: `build/c/${spec.outputSlug}`;
	const transitiveArchives = spec.deps.flatMap((d) => d.transitiveArchives);
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
	// Own path first, so a target's own headers shadow a same-named header
	// pulled in transitively.
	const includeDirs = [
		spec.path,
		...spec.deps.flatMap((d) => d.transitiveIncludeDirs),
	];

	const built = task({
		display: `cc ${isLibrary ? "archive" : "link"} ${spec.path}`,
		inputs: {
			srcs,
			hdrs,
			...toolchainTaskInputs(spec.toolchain),
			...Object.fromEntries(
				transitiveArchives.map((archive, i) => [`archive${i}`, archive]),
			),
			...Object.fromEntries(
				transitiveHdrs.map((depHdrs, i) => [`depHdrs${i}`, depHdrs]),
			),
		},
		outputs: { artifact: output.artifact() },
		async run(exec, input) {
			const sourcePaths = exec.paths(input.srcs);
			exec.paths(input.hdrs);
			const isCxx = sourcePaths.some(isCxxSource);
			const flags = [
				...optFlags(),
				...includeDirs.map((dir) => `-I${dir}`),
				...spec.copts,
			]
				.map(shellQuote)
				.join(" ");
			const objectPaths = sourcePaths.map((source) =>
				objectPathFor(spec.outputSlug, source),
			);
			// One exec.action() per source file, not one script compiling all
			// of them: a target with hundreds of sources overflows a single
			// shell command's argument-string limit (issue #84). This also
			// restores per-object task-cache reuse the coarse single-script
			// form gave up.
			//
			// toolchainCommands() is re-resolved for every exec.action() call
			// rather than once up front: it consumes exec.tool()/exec.path()
			// bindings as a side effect, and exec.action() clears the
			// consumed set once it returns — a binding consumed for one
			// action isn't carried over and mounted into the next.
			const compileResults = await Promise.all(
				sourcePaths.map((source, i) => {
					const { compiler, env } = toolchainCommands(
						exec,
						spec.toolchain,
						input,
						spec.unsafeSystemPaths,
					);
					const compilerCmd = compiler(isCxx).map(shellQuote).join(" ");
					const objPath = objectPaths[i];
					const script = `set -e; mkdir -p "$(dirname ${shellQuote(objPath)})"; ${compilerCmd} -c ${shellQuote(source)} -o ${shellQuote(objPath)} ${flags}`;
					return exec.action({
						argv: ["sh", "-c", script, "cc-compile"],
						env,
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
			const depArchivePaths = transitiveArchives.map((_, i) =>
				exec.path(input[`archive${i}`]),
			);
			const { compiler, archiver, env } = toolchainCommands(
				exec,
				spec.toolchain,
				input,
				spec.unsafeSystemPaths,
			);
			const finalCmd = isLibrary
				? `${archiver().map(shellQuote).join(" ")} rcs ${shellQuote(outPath)} ${objectSandboxPaths.map(shellQuote).join(" ")}`
				: (() => {
						const needsCxx = sourcePaths.some(isCxxSource);
						const linker = (needsCxx ? compiler(true) : compiler(false))
							.map(shellQuote)
							.join(" ");
						const linkFlags = [...spec.linkopts, ...transitiveLinkopts]
							.map(shellQuote)
							.join(" ");
						return `${linker} -o ${shellQuote(outPath)} ${objectSandboxPaths.map(shellQuote).join(" ")} ${depArchivePaths.map(shellQuote).join(" ")} ${linkFlags}`;
					})();
			const script = `set -e; mkdir -p "$(dirname ${shellQuote(outPath)})"; ${finalCmd}`;
			const result = await exec.action({
				argv: ["sh", "-c", script, isLibrary ? "cc-archive" : "cc-link"],
				env,
				inputs: compileResults.map((r) => r.outputs.object),
				outputs: { artifact: output.file(outPath) },
				display: `cc ${isLibrary ? "archive" : "link"} ${outPath}`,
			});
			return { artifact: result.outputs.artifact };
		},
	});
	return { built, hdrs };
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
 * @returns {object} Frozen `{[BUILD], archive, transitiveArchives, transitiveIncludeDirs, transitiveHdrs, transitiveLinkopts, [PACKAGE]}`.
 */
export function ccLibrary(opts = {}) {
	const spec = crateSpec(opts);
	const { built, hdrs } = ccTask(spec, true);
	const archive = built.outputs.artifact;
	return Object.freeze({
		spec,
		[BUILD]: archive,
		archive,
		transitiveArchives: [
			archive,
			...spec.deps.flatMap((d) => d.transitiveArchives),
		],
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
 * @returns {object} Frozen `{[BUILD], [PACKAGE]}`.
 */
export function ccBinary(opts = {}) {
	const spec = crateSpec(opts);
	const { built } = ccTask(spec, false);
	const executable = built.outputs.artifact;
	return Object.freeze({
		spec,
		[BUILD]: executable,
		[PACKAGE]: executable,
	});
}
