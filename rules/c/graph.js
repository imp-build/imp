// Graph-native raw C/C++ rules (issue #31/#61): ccLibrary()/ccBinary() build
// task()-based graphs directly, replacing the legacy label()/attach()-based
// factory in rules/c/index.js. Lives alongside that module additively until
// the #31 cutover (see rules/rust's own additive-then-cutover precedent).
//
// deps are handle-passing, not label references: ccLibrary(A)'s result is a
// plain frozen object a caller passes directly as ccBinary({deps:[A]})'s
// dependency — replacing the legacy "walk deps filtered by kind at build
// time" mechanism with a flat, eagerly-computed transitiveArchives array
// (mirrors rules/rust's cargoPackage({deps}) pattern). This output shape
// ({[BUILD], archive, transitiveArchives, transitiveIncludeDirs, [PACKAGE]})
// is a deliberate cross-module contract: rules/c/cmake's graph-native
// per-target expand() children (issue #62) must expose the identical shape
// so a raw ccBinary({deps:[cmakeThing.get("mylib")]}) works transparently —
// see the #31 migration plan for why this replaces the legacy `backend`
// attr dispatch entirely (no more dynamic import("//rules/c/cmake")).
//
// Known simplifications versus the pre-migration factory:
//   - No CMakeLists.txt/main()-detection-driven generate-build support yet
//     (rules/c/index.js's generateBuild() stays the canonical generator
//     until the #31 cutover folds a graph-native equivalent in).
//   - One coarse compile+archive/link action per target (not one run() per
//     source file) — a change to any one source recompiles the whole
//     target. Matches this migration's "graph nodes should be deliberately
//     coarse" design constraint and mirrors how cargoPackage() compiles a
//     whole crate in one cargo invocation, at the cost of the legacy
//     factory's finer-grained per-object task-cache reuse.
//   - hdrs are tracked as an input (so editing a header invalidates the
//     compile) but never individually inspected — same conservative
//     widening rationale as rules/c/cmake's own header handling.

import {
	BUILD,
	PACKAGE,
	configuration,
	files,
	output,
	packagePath,
	task,
} from "imp:core";

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
function toolchainCommands(exec, toolchain, input) {
	if (isZigToolchain(toolchain)) {
		const zigExe = exec.tool(input.ccTool, "zig");
		return {
			compiler: (isCxx) => [zigExe, isCxx ? "c++" : "cc"],
			archiver: () => [zigExe, "ar"],
			env: zigGraphCacheEnv(exec, input.ccBuildCacheTool),
		};
	}
	return {
		compiler: (isCxx) => [exec.tool(input.ccTool, isCxx ? "c++" : "clang")],
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

function crateSpec(opts) {
	const {
		path = packagePath(),
		srcs = DEFAULT_CPP_SRCS,
		hdrs = DEFAULT_CPP_HDRS,
		deps = [],
		toolchain,
		copts = [],
		linkopts = [],
	} = opts || {};
	const normalizedPath = normalizeWorkspacePath(path);
	return {
		path: normalizedPath,
		srcs: [...srcs],
		hdrs: [...hdrs],
		deps: deps || [],
		toolchain: resolveToolchain(toolchain),
		copts: [...copts],
		linkopts: [...linkopts],
		outputSlug: outputSlugFor(normalizedPath),
	};
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
	// Own path first, so a target's own headers shadow a same-named header
	// pulled in transitively.
	const includeDirs = [
		spec.path,
		...spec.deps.flatMap((d) => d.transitiveIncludeDirs),
	];

	return task({
		display: `cc ${isLibrary ? "archive" : "link"} ${spec.path}`,
		inputs: {
			srcs,
			hdrs,
			...toolchainTaskInputs(spec.toolchain),
			...Object.fromEntries(
				transitiveArchives.map((archive, i) => [`archive${i}`, archive]),
			),
		},
		outputs: { artifact: output.artifact() },
		async run(exec, input) {
			const sourcePaths = exec.paths(input.srcs);
			exec.paths(input.hdrs);
			const isCxx = sourcePaths.some(isCxxSource);
			const { compiler, archiver, env } = toolchainCommands(
				exec,
				spec.toolchain,
				input,
			);
			const compilerCmd = compiler(isCxx).map(shellQuote).join(" ");
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
			const compileCmds = sourcePaths.map(
				(source, i) =>
					`mkdir -p "$(dirname ${shellQuote(objectPaths[i])})" && ${compilerCmd} -c ${shellQuote(source)} -o ${shellQuote(objectPaths[i])} ${flags}`,
			);
			const depArchivePaths = transitiveArchives.map((_, i) =>
				exec.path(input[`archive${i}`]),
			);
			const finalCmd = isLibrary
				? `${archiver().map(shellQuote).join(" ")} rcs ${shellQuote(outPath)} ${objectPaths.map(shellQuote).join(" ")}`
				: (() => {
						const needsCxx = sourcePaths.some(isCxxSource);
						const linker = (needsCxx ? compiler(true) : compiler(false))
							.map(shellQuote)
							.join(" ");
						const linkFlags = spec.linkopts.map(shellQuote).join(" ");
						return `${linker} -o ${shellQuote(outPath)} ${objectPaths.map(shellQuote).join(" ")} ${depArchivePaths.map(shellQuote).join(" ")} ${linkFlags}`;
					})();
			const script = `set -e; mkdir -p "$(dirname ${shellQuote(outPath)})"; ${compileCmds.join("; ")}; ${finalCmd}`;
			const result = await exec.action({
				argv: ["sh", "-c", script, isLibrary ? "cc-archive" : "cc-link"],
				env,
				inputs: transitiveArchives.map((_, i) => input[`archive${i}`]),
				outputs: { artifact: output.file(outPath) },
				display: `cc ${isLibrary ? "archive" : "link"} ${outPath}`,
			});
			return { artifact: result.outputs.artifact };
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
 * @returns {object} Frozen `{[BUILD], archive, transitiveArchives, transitiveIncludeDirs, [PACKAGE]}`.
 */
export function ccLibrary(opts = {}) {
	const spec = crateSpec(opts);
	const built = ccTask(spec, true);
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
 * @param {string[]} [opts.linkopts=[]] Extra linker flags.
 * @returns {object} Frozen `{[BUILD], [PACKAGE]}`.
 */
export function ccBinary(opts = {}) {
	const spec = crateSpec(opts);
	const built = ccTask(spec, false);
	const executable = built.outputs.artifact;
	return Object.freeze({
		spec,
		[BUILD]: executable,
		[PACKAGE]: executable,
	});
}
