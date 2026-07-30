import {
	Target,
	artifact,
	build,
	configuration,
	discoverLabels,
	expand,
	glob,
	label,
	labelAddress,
	file_set,
	memo,
	mergeDigests,
	output,
	output_path,
	pathsInDigest,
	product,
	readFileInDigest,
	registerTarget,
	registerLabel,
	run,
	sourcesField,
	targetAddress,
	test,
	BUILD,
	PACKAGE,
	TEST,
} from "imp:core";
import { nativeTool, nativeToolSpec } from "//rules/imp/native_tool";
import {
	acquireCmakeToolchain,
	cmakeBin,
	cmakeTool,
	defaultCmakeToolchain,
	CmakeToolchain,
} from "//rules/c/cmake/toolchain";
import {
	zigTool,
	zigBuildCacheTool,
	zigGlobalCacheEnv,
	zigCMakeArgs,
	defaultZigToolchain,
} from "//rules/c/zig/toolchain";
import {
	extractCopyDestinations,
	listNamedCmakeTargets,
	parseNinja,
	reachableEdges,
	rebasePath,
	resolveEdgeCommand,
	sandboxRootFromWorkdir,
} from "//rules/c/cmake/ninja_graph";
import { parseCTestTestfile } from "//rules/c/cmake/ctest_testfile";

// Registers generic cc_library/cc_binary build dispatch and generated-build
// metadata. CMake remains a backend that can mint generic C/C++ targets.
import "//rules/c";

// Registers the "build" goal's artifact summary callback for consumers that
// import CMake build rules without importing the workflows layer explicitly.
import "//rules/workflows/build_workflow";
import { CMAKE_TOOL } from "//rules/c/cmake/toolchain";

export {
	acquireCmakeToolchain,
	cmakeBin,
	cmakeCacheKey,
	cmakeTool,
	cmakeToolchain,
	defaultCmakeToolchain,
	defaultCmakeToolchainVersion,
	installCmakeToolchain,
	resolveCmakeToolchainVersion,
} from "//rules/c/cmake/toolchain";

// ---------------------------------------------------------------------------
// Path helpers (same pattern as rules/odin/index.js)
// ---------------------------------------------------------------------------

const DEFAULT_CPP_SRCS = [
	"CMakeLists.txt",
	"**/*.c",
	"**/*.cc",
	"**/*.cpp",
	"**/*.cxx",
	"**/*.h",
	"**/*.hh",
	"**/*.hpp",
	"**/*.hxx",
];

function normalize_workspace_path(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`cmake paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function safe_target_address(handle) {
	if (!handle || (handle.__imp !== true && handle.__imp_label !== true))
		return null;
	try {
		return handle.__imp_label === true
			? labelAddress(handle)
			: targetAddress(handle);
	} catch (_) {
		return null;
	}
}

function declaring_directory(handle) {
	const address = safe_target_address(handle);
	if (!address || !address.startsWith("//")) return ".";
	const scope = address.slice(2).split(":")[0];
	return scope.length === 0 ? "." : scope;
}

function declared_path(handle, path = ".") {
	const base = declaring_directory(handle);
	const local = path || ".";
	if (base === ".") return normalize_workspace_path(local);
	if (local === ".") return base;
	return normalize_workspace_path(`${base}/${local}`);
}

// ---------------------------------------------------------------------------
// Memo/product functions for C/CMake targets
// ---------------------------------------------------------------------------

export const tool = product(
	CmakeToolchain,
	BUILD,
	CMAKE_TOOL,
	async function tool(handle) {
		await acquireCmakeToolchain(handle.attrs.version);
		return { name: "cmake", version: handle.attrs.version };
	},
	{ display: "build {0}", level: "info" },
);

export const sources = memo(
	async function sources(handle) {
		const root = declared_path(handle, handle.attrs.src || ".");
		return glob({ root, include: handle.attrs.srcs || DEFAULT_CPP_SRCS });
	},
	{ display: "sources {0}", level: "debug" },
);

// Conservative header-change safety net for the per-edge graph replay below:
// Ninja's static build graph doesn't expose header dependencies (those are
// only known via the depfile a compile produces — a universal property of
// the C preprocessor, not something any CMake generator exposes statically).
// Declaring just this narrower header-only glob as an extra input on every
// compile edge (instead of the whole `sources` set) means editing one .c
// file only invalidates that file's own edge, while editing any header
// conservatively invalidates every compile edge — safe, if coarser than a
// real per-header dependency scan (a `cc -MM`-based follow-up would narrow
// this further).
const headerSources = memo(
	async function headerSources(handle) {
		const root = declared_path(handle, handle.attrs.src || ".");
		return glob({
			root,
			include: ["**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx"],
		});
	},
	{ display: "header Sources {0}", level: "debug" },
);

// compilerEnv's values (e.g. ZIG_GLOBAL_CACHE_DIR) are relative to the
// sandbox root (that's where their "tool" mount lands — see
// zigBuildCacheTool), but plain env vars are interpreted by whatever
// consumes them relative to *their own* cwd at the moment they read it, not
// relative to wherever the value was originally set — so a relative value
// silently breaks (creating a fresh, throwaway, unshared directory instead
// of hitting the real mount) the instant anything invoked downstream
// changes its cwd, which both this rule's own `cd buildDirPath` (edge
// replay) and CMake's internal compiler-detection probe do. Every call site
// must capture `imp_sandbox_root="$(pwd)"` at the very start of its
// script, before any cd happens, then splice these export statements in
// right after — see configureNinjaGraph and executeEdge below.
function zigEnvExportStmts(compilerEnv) {
	return compilerEnv.map((entry) => {
		const eq = entry.indexOf("=");
		return `export ${entry.slice(0, eq)}="$imp_sandbox_root/${entry.slice(eq + 1)}"`;
	});
}

// Shared path/toolchain/input resolution for both the "build" and "test"
// products below — factors out everything that doesn't depend on whether
// we're building or (re-)running ctest.
async function resolveCmakeSetup(handle) {
	const srcPath = declared_path(handle, handle.attrs.src || ".");
	// Deliberately keyed off srcPath, not targetOutputSlug(handle) (unlike
	// odin/c/rust's own default output paths) — expandCmakeProject mints one
	// cc_library/cc_binary/cc_test child per discovered CMake target, each
	// under its own address, but only forwards the parent's *explicit*
	// attrs.buildDir (see expandCmakeProject below); when that's unset, every
	// child must independently re-derive the exact same buildDirPath the
	// parent's own configure/build already populated, or a child's own
	// buildCmakeArtifact() would look for its (already-built) outputs under a
	// build directory that was never actually configured. srcPath is the one
	// value every expanded child shares with its parent (all pass the same
	// `src`), so it's the only safe default key here.
	const buildDirPath =
		handle.attrs.buildDir || `build/${srcPath === "." ? "cmake" : srcPath}`;
	const mode = configuration("imp.mode", {}) || {};
	const cmakeArgs = [
		`-DCMAKE_BUILD_TYPE=${mode.opt === "release" ? "Release" : "Debug"}`,
		...(handle.attrs.cmakeArgs || []),
	];
	const inputFiles = await sources(handle);
	const dirInputs = (handle.attrs.dirs || []).map((d) => ({
		kind: "directory",
		path: declared_path(handle, d),
	}));

	// No pinned toolchain declared — still need a resolved cmake so the
	// hermetic sandbox can find it (bare "cmake" has no PATH entry
	// otherwise).
	const cmakeToolSpec = handle.attrs.toolchain
		? await cmakeTool(handle.attrs.toolchain)
		: await nativeToolSpec(nativeTool("cmake"));
	// zigBuildCacheTool/zigGlobalCacheEnv pair a mounted, shared, named-
	// cache directory with the env var pointing Zig at it — see
	// ZIG_BUILD_CACHE's doc comment in rules/c/zig/toolchain.js for why
	// sharing this across sandboxes is both safe (content-addressed by what
	// Zig is compiling, never by sandbox identity) and necessary (without
	// it, every sandbox re-pays Zig's own compiler-rt build and bakes a
	// fresh ephemeral sandbox path into it, which -ffile-prefix-map alone
	// can't reach since it's not part of the translation unit we ask Zig to
	// compile).
	const compilerTools = handle.attrs.compiler
		? [
				await zigTool(handle.attrs.compiler),
				await zigBuildCacheTool(handle.attrs.compiler),
			]
		: await Promise.all(
				["cc", "as", "ld", "ar"].map((name) =>
					nativeToolSpec(nativeTool(name)),
				),
			);
	const compilerArgs = handle.attrs.compiler
		? await zigCMakeArgs(handle.attrs.compiler)
		: [];
	const compilerEnv = handle.attrs.compiler ? zigGlobalCacheEnv() : [];

	return {
		srcPath,
		buildDirPath,
		cmakeArgs,
		inputFiles,
		dirInputs,
		cmakeToolSpec,
		compilerTools,
		compilerArgs,
		compilerEnv,
	};
}

// Configures the project with CMake's Ninja generator (needs no `ninja`
// binary installed — CMake's own code emits build.ninja/rules.ninja; we
// only ever read that graph, never execute it via ninja) and parses it.
//
// The configure `run()` is itself a normal content-keyed task-cache entry
// (inputs: sources + dirs), so an unchanged project skips reconfiguring
// entirely rather than paying for it on every build/test.
async function configureNinjaGraph(handle, setup) {
	const {
		srcPath,
		buildDirPath,
		cmakeArgs,
		inputFiles,
		dirInputs,
		cmakeToolSpec,
		compilerTools,
		compilerArgs,
		compilerEnv,
	} = setup;

	// Can't pass compilerEnv via run()'s own `env:` — CMake's own
	// compiler-detection probe (CMakeFiles/<ver>/CompilerIdC/) invokes the
	// compiler from a *subdirectory* it creates itself, and a relative env
	// value like ZIG_GLOBAL_CACHE_DIR gets reinterpreted relative to
	// whatever cwd the compiler actually runs from — silently creating a
	// fresh, throwaway cache under CompilerIdC/ instead of hitting the real
	// mount (see zigEnvExportStmts' doc comment). $(pwd) here is the sandbox
	// root (this script never cd's before it runs), so exporting an
	// absolute path up front keeps it correct no matter what cwd CMake's own
	// internal probes use.
	const envPreamble =
		compilerEnv.length > 0
			? `imp_sandbox_root="$(pwd)" && ${zigEnvExportStmts(compilerEnv).join(" && ")} && `
			: "";
	const script = `src=$1; bdir=$2; shift 2; ${envPreamble}mkdir -p "$bdir" && cmake -S "$src" -B "$bdir" -G Ninja "$@"`;
	const configureTools = [
		await nativeToolSpec(nativeTool("mkdir")),
		// CMake's Ninja generator needs a real `ninja` (or ninja-compatible)
		// binary resolvable at configure time to populate
		// CMAKE_MAKE_PROGRAM, even though we never invoke it ourselves —
		// we only ever read the generated build.ninja/rules.ninja text.
		await nativeToolSpec(nativeTool("ninja")),
		...(handle.attrs.compiler
			? [await nativeToolSpec(nativeTool("dirname"))]
			: []),
	];

	const configureResult = await run({
		argv: [
			"sh",
			"-c",
			script,
			"cmake-configure",
			srcPath,
			buildDirPath,
			...compilerArgs,
			...cmakeArgs,
		],
		tools: [cmakeToolSpec, ...compilerTools, ...configureTools],
		inputs: [inputFiles, ...dirInputs],
		outputs: [output(output_path(buildDirPath), { kind: "directory" })],
		materialize: false,
		display: `cmake configure ${srcPath}`,
	});

	const readAt = (path) =>
		readFileInDigest(configureResult.outputDigest, `${buildDirPath}/${path}`);
	const buildNinjaText = readAt("build.ninja");
	const { rules, edges, topVars, targetTypes } = parseNinja(
		buildNinjaText,
		readAt,
	);
	const sandboxRoot = sandboxRootFromWorkdir(
		topVars.cmake_ninja_workdir,
		buildDirPath,
	);

	return {
		rules,
		edges,
		topVars,
		targetTypes,
		sandboxRoot,
		outputDigest: configureResult.outputDigest,
	};
}

// Replays every build edge reachable from `targetNames` (e.g. "all") as its
// own run() call, so an unchanged source file's compile edge is a
// task-cache hit and gets skipped instead of the whole project rebuilding
// as one atomic unit — the graph-lift this file exists for. Each edge is
// materialize:false; instead of relying on physical on-disk presence,
// dependency ordering is enforced by topological waves (as before) *and* by
// threading a running merged CAS digest (`accumulatedDigest`, seeded from
// configure's own output) through each wave — every edge in wave N receives
// everything produced by waves 0..N-1 (plus configure) as a single
// `{kind:"digest"}` input, so it sees dependency-produced files at their
// normal build-directory-relative paths without them ever having been
// materialized into the real workspace. Returns the final accumulated
// digest, covering everything the replay produced (the digest-chained
// analog of "the build directory, fully built").
async function replayReachableGraph(handle, setup, graph, targetNames) {
	const { buildDirPath, cmakeToolSpec, compilerTools, compilerEnv, dirInputs } =
		setup;
	const { rules, edges, topVars, sandboxRoot } = graph;
	// Always available on PATH for every edge, matching exactly what
	// configure itself used — needed for tool names that only resolve
	// through a pinned toolchain's own mount (e.g. a Zig compiler's
	// "zigar"/"zigranlib" wrapper scripts), not via a fresh host PATH
	// lookup.
	// The zigar/zigranlib wrapper scripts a Zig compiler toolchain
	// generates shell out to `dirname` internally — invisible to the
	// per-edge toolName extraction below since it never appears in the
	// edge's own resolved command text.
	const baseTools = [
		cmakeToolSpec,
		...compilerTools,
		...(handle.attrs.compiler
			? [await nativeToolSpec(nativeTool("dirname"))]
			: []),
	];
	const baseToolNames = new Set(baseTools.map((t) => t.name));

	// The full walk (including phony/bookkeeping edges) is needed for
	// topological leveling below — only the non-phony, has-a-command subset
	// is actually replayed as run() calls.
	const allReached = reachableEdges(edges, targetNames);
	const reached = allReached.filter(
		(edge) =>
			edge.rule !== "phony" && rules[edge.rule] && rules[edge.rule].command,
	);
	const headerFiles = await headerSources(handle);

	// Edges must still run in topological waves — even though dependency
	// *content* now flows through accumulatedDigest rather than physical
	// paths, a wave can't start until every edge whose output it might read
	// has actually finished (and been merged in). Edges with no such
	// dependency on each other are safe to run concurrently within a wave.
	//
	// Dependencies can chain *through* phony/order-only markers (e.g.
	// CMake's "cmake_object_order_depends_target_X" edges) rather than
	// referencing a real edge's output directly — levelOf walks the full
	// graph (allReached, not just the executable subset) and treats a
	// phony edge as a zero-cost passthrough to its own dependencies,
	// instead of a dead end, so a transitive real dependency reached only
	// through a chain of phony markers still forces the correct wave.
	const allByOutput = new Map();
	for (const edge of allReached) {
		for (const p of [...edge.outputs, ...edge.implicitOutputs]) {
			allByOutput.set(p, edge);
		}
	}
	const isExecutable = (edge) =>
		edge.rule !== "phony" &&
		Boolean(rules[edge.rule]) &&
		Boolean(rules[edge.rule].command);
	const levels = new Map();
	function levelOf(edge) {
		if (levels.has(edge)) return levels.get(edge);
		let depLevel = 0;
		for (const dep of [
			...edge.inputs,
			...edge.implicitInputs,
			...edge.orderOnly,
		]) {
			const depEdge = allByOutput.get(dep);
			if (depEdge && depEdge !== edge) {
				depLevel = Math.max(depLevel, levelOf(depEdge));
			}
		}
		const level = isExecutable(edge) ? depLevel + 1 : depLevel;
		levels.set(edge, level);
		return level;
	}
	const waves = [];
	for (const edge of reached) {
		const level = levelOf(edge);
		(waves[level] || (waves[level] = [])).push(edge);
	}

	async function executeEdge(edge, inputDigest) {
		const resolved = resolveEdgeCommand(
			edge,
			rules,
			topVars,
			sandboxRoot,
			buildDirPath,
		);
		if (!resolved) return null;

		// resolved.toolNames only ever contains names rewritten from a
		// genuine absolute host path (e.g. "/usr/bin/ar") — imp's own
		// ".imp/tools/..." mount paths (e.g. a Zig toolchain's
		// "zigar"/"zigranlib") are rewritten to bare names too, but
		// deliberately excluded from toolNames there, since they're never
		// real host-wide binaries and always already covered by
		// cmakeToolSpec/compilerTools. See rewriteToolInvocations.
		const edgeTools = [...baseTools];
		for (const name of resolved.toolNames) {
			if (baseToolNames.has(name)) continue;
			edgeTools.push(await nativeToolSpec(nativeTool(name)));
		}

		// Real external source files (CMake canonicalizes CMAKE_SOURCE_DIR
		// references to absolute paths) still need their own physical
		// input — everything else this edge depends on (earlier edges'
		// outputs, or configure-time-generated files like a precompiled
		// header shim) rides in via `inputDigest` instead.
		const leafInputs = [];
		for (const dep of [
			...edge.inputs,
			...edge.implicitInputs,
			...edge.orderOnly,
		]) {
			const isAbsolute =
				Boolean(sandboxRoot) && dep.startsWith(sandboxRoot + "/");
			if (isAbsolute) {
				leafInputs.push({ kind: "file", path: rebasePath(dep, sandboxRoot) });
			}
		}

		// Edges with a depfile are real C/C++ compiles with dynamic header
		// deps not visible in the static graph — see headerSources' doc
		// comment for the conservative-widening rationale. Declared `dirs`
		// (e.g. a vendored third-party include tree like Jolt) aren't
		// covered by that project-local header glob at all, so they need
		// to be mounted too — every compile edge gets the same extra
		// directories the old single-run() build always mounted, since we
		// don't parse -I flags to know which edge actually needs which one.
		const isCompileEdge = Boolean(
			edge.vars.DEP_FILE || rules[edge.rule].depfile,
		);

		const outputPaths = [...edge.outputs, ...edge.implicitOutputs];
		// A POST_BUILD/PRE_LINK custom command (e.g. a `cmake -E copy` to
		// stage the built artifact into the source tree) isn't modeled as
		// its own ninja edge/output at all — it only shows up baked into
		// this edge's resolved command text. Without declaring its
		// destination as an output too, the file would be created inside
		// this edge's own ephemeral sandbox and then discarded when the
		// sandbox is torn down, instead of flowing into accumulatedDigest
		// like the old single-run() build always materialized it for free.
		const copyOutputs = extractCopyDestinations(resolved.command, buildDirPath);

		// Ninja always executes edges with cwd = the build directory (see
		// resolveEdgeCommand's doc comment) — resolved.command's paths are
		// already rebased on that assumption, so replicate it here.
		//
		// Each replayed edge runs inside its own freshly-minted, randomly
		// rooted sandbox (see src/cache.rs's create_sandbox_root), so a
		// compile edge's cwd — and therefore the absolute path GCC/Clang
		// record as DW_AT_comp_dir in debug info — differs on every single
		// invocation even when nothing about the source changed. The whole
		// sandbox root (captured via $(pwd) *before* the cd, since it's
		// unknown until the edge actually runs) is remapped to a fixed,
		// canonical path, making the emitted debug info — and thus the
		// object/link output — identical across sandboxes. This alone
		// doesn't cover a toolchain that lazily builds and caches its own
		// runtime bits under the sandbox root too (e.g. Zig compiling
		// compiler-rt/libstd into "$HOME/.cache/zig/..." on first use, which
		// bakes that same ephemeral root into *their* debug info) — see
		// compilerEnv/ZIG_BUILD_CACHE in rules/c/zig/toolchain.js, which
		// pins that cache to a stable, shared, named-cache mount instead.
		//
		// compilerEnv (e.g. ZIG_GLOBAL_CACHE_DIR) points at a tool mounted
		// at the *sandbox root* (".imp/tools/..."), so it can't be passed
		// via run()'s own `env:` — that's a plain relative-path string set
		// once at process spawn, before this script's `cd` runs, and would
		// resolve relative to buildDirPath instead once the command
		// actually executes. `export`ing it here, after capturing the root
		// but before the `cd`, keeps it correct for every command in the
		// resolved edge (including chained POST_BUILD steps) regardless of
		// cwd.
		const needsSandboxRoot = isCompileEdge || compilerEnv.length > 0;
		const preamble = needsSandboxRoot
			? [`imp_sandbox_root="$(pwd)"`, ...zigEnvExportStmts(compilerEnv)].join(
					" && ",
				)
			: "";
		const prefixMapSuffix = isCompileEdge
			? ` -ffile-prefix-map="$imp_sandbox_root"=/imp-src`
			: "";
		const cdCommand = preamble
			? `${preamble} && cd '${buildDirPath}' && ${resolved.command}${prefixMapSuffix}`
			: `cd '${buildDirPath}' && ${resolved.command}`;
		const result = await run({
			argv: ["sh", "-c", cdCommand],
			tools: edgeTools,
			inputs: [
				...leafInputs,
				{ kind: "digest", digest: inputDigest },
				...(isCompileEdge ? [headerFiles, ...dirInputs] : []),
			],
			outputs: [
				...outputPaths.map((p) => output(output_path(`${buildDirPath}/${p}`))),
				...copyOutputs.map((p) => output(output_path(p))),
			],
			materialize: false,
			display: `cmake edge ${outputPaths[0] || edge.rule}`,
		});
		return result.outputDigest;
	}

	let accumulatedDigest = graph.outputDigest;
	for (const wave of waves) {
		if (!wave) continue;
		const digests = await Promise.all(
			wave.map((edge) => executeEdge(edge, accumulatedDigest)),
		);
		const newDigests = digests.filter((d) => d != null);
		if (newDigests.length > 0) {
			accumulatedDigest = mergeDigests([accumulatedDigest, ...newDigests]);
		}
	}
	return accumulatedDigest;
}

function replayTargetNames(handle) {
	const outputs = handle.attrs.outputs || [];
	return handle.attrs.outputsInBuildDir && outputs.length > 0
		? outputs
		: ["all"];
}

// Shared "build" implementation for every kind expandCmakeProject can mint
// (cc_library, cc_binary, cc_test) as well as the original hand-declared
// cmake-lib — identical regardless of kind, since a target's kind only ever
// affects which products get *dispatched*, never what building one means.
export async function buildCmakeArtifact(handle) {
	const setup = await resolveCmakeSetup(handle);
	const { srcPath, buildDirPath } = setup;
	const stageOutputs = handle.attrs.stageOutputs || [];

	const graph = await configureNinjaGraph(handle, setup);
	const replayDigest = await replayReachableGraph(
		handle,
		setup,
		graph,
		replayTargetNames(handle),
	);

	// outputs/stageOutputs name files relative to srcPath, matching how
	// this attr has always worked — many real CMakeLists.txt files (e.g.
	// via a POST_BUILD `cmake -E copy` custom command) stage their built
	// artifact into the source tree themselves, rather than leaving it at
	// its plain buildDirPath location. The graph replay's extractCopyDestinations
	// handling ensures that side effect is actually captured back to the
	// real workspace now that it isn't one big monolithic sandboxed build.
	//
	// A target minted by `expandCmakeProject` sets `outputsInBuildDir`
	// instead: its `outputs` are exactly the ninja-graph-relative paths
	// `replayReachableGraph` already materialized under buildDirPath, with
	// no user-declared srcPath staging to speak of — declare them from
	// there directly rather than assuming a srcPath copy that never happens.
	const outputsInBuildDir = Boolean(handle.attrs.outputsInBuildDir);
	const outputBase = outputsInBuildDir ? buildDirPath : srcPath;
	const outputDecls = (handle.attrs.outputs || []).map((name) =>
		output(output_path(`${outputBase}/${name}`)),
	);
	const stagedOutputDecls = stageOutputs.map(({ to }) =>
		output(output_path(to)),
	);

	const stageCmds = outputsInBuildDir
		? []
		: stageOutputs.map(
				({ from, to }) =>
					`mkdir -p "$(dirname '${to}')" && cp '${srcPath}/${from}' '${to}'`,
			);
	const script = stageCmds.length > 0 ? stageCmds.join(" && ") : ":";
	const scriptTools = [
		...(stageCmds.length > 0
			? [
					await nativeToolSpec(nativeTool("mkdir")),
					await nativeToolSpec(nativeTool("cp")),
					await nativeToolSpec(nativeTool("dirname")),
				]
			: []),
	];

	// Everything this step needs — buildDirPath's own contents plus any
	// copyOutputs-produced srcPath files the replay staged — already lives
	// in replayDigest; nothing here is read as a physical path anymore.
	const result = await run({
		argv: ["sh", "-c", script, "cmake-stage"],
		tools: scriptTools,
		inputs: [{ kind: "digest", digest: replayDigest }],
		outputs: [...outputDecls, ...stagedOutputDecls],
		materialize: false,
		display: `cmake stage ${srcPath}`,
	});
	return { ...result, outputBase, hasStageOutputs: stageOutputs.length > 0 };
}

export class CppSources extends Target {
	static kind = "cpp-sources";
	constructor({ srcs }) {
		super({
			kind: CppSources.kind,
			attrs: { sources: srcs },
			sources: sourcesField({
				root: ".",
				include: srcs,
				exclude: [],
			}),
		});
	}
}

export class CmakeLib extends Target {
	static kind = "cmake-lib";
	constructor({
		src = ".",
		buildDir,
		srcs,
		dirs = [],
		cmakeArgs = [],
		ctestArgs = [],
		outputs = [],
		stageOutputs = [],
		outputsInBuildDir = false,
		toolchain,
		compiler,
		deps = [],
		kind = CmakeLib.kind,
		testNames = [],
	}) {
		const explicitToolchainTarget =
			toolchain && toolchain.__imp === true ? toolchain : null;
		const explicitVersion =
			toolchain && toolchain.__imp !== true ? toolchain : null;
		const toolchainTarget =
			explicitToolchainTarget ||
			(!explicitVersion ? defaultCmakeToolchain() : null);
		const toolchainVersion =
			explicitVersion || (toolchainTarget && toolchainTarget.attrs?.version);

		const explicitCompilerTarget =
			compiler && compiler.__imp === true ? compiler : null;
		const explicitCompilerVersion =
			compiler && compiler.__imp !== true ? compiler : null;
		const compilerTarget =
			explicitCompilerTarget ||
			(!explicitCompilerVersion ? defaultZigToolchain() : null);
		const compilerVersion =
			explicitCompilerVersion ||
			(compilerTarget && compilerTarget.attrs?.version);

		const allDeps = [
			...(toolchainTarget ? [{ target: toolchainTarget, mode: "tool" }] : []),
			...(compilerTarget ? [{ target: compilerTarget, mode: "tool" }] : []),
			...deps,
		];

		super({
			kind,
			attrs: {
				src, // stored as user-provided; resolved by declared_path in product/memo
				srcs: srcs || DEFAULT_CPP_SRCS,
				...(kind !== CmakeLib.kind ? { backend: "cmake" } : {}),
				...(dirs.length ? { dirs } : {}),
				cmakeArgs,
				...(ctestArgs.length ? { ctestArgs } : {}),
				outputs,
				...(stageOutputs.length ? { stageOutputs } : {}),
				...(outputsInBuildDir ? { outputsInBuildDir } : {}),
				...(testNames.length ? { testNames } : {}),
				...(buildDir ? { buildDir } : {}),
				...(toolchainVersion ? { toolchain: toolchainVersion } : {}),
				...(toolchainTarget ? { toolchainTarget } : {}),
				...(compilerVersion ? { compiler: compilerVersion } : {}),
				...(compilerTarget ? { compilerTarget } : {}),
				...(allDeps.length
					? { deps: allDeps.map((dep) => dep.target || dep) }
					: {}),
			},
			sources: [
				sourcesField({
					root: src,
					include: srcs || DEFAULT_CPP_SRCS,
					exclude: [],
				}),
				...dirs.map((dir) =>
					sourcesField({
						root: dir,
						include: ["**/*"],
						exclude: [],
					}),
				),
			],
			deps: allDeps,
		});
	}
}

export const native_link_library = product(
	CmakeLib,
	BUILD,
	CMAKE_TOOL,
	buildCmakeArtifact,
	{ display: "build {0}", level: "info" },
);

/**
 * Package a cmake-built artifact to dist/. Only supports the common case
 * where `handle.attrs.outputs` all share `outputBase` as their directory —
 * a target using `stageOutputs` to scatter files across arbitrary `to`
 * paths has no single directory to publish from, so it isn't supported yet.
 *
 * @param {object} handle Target handle (cmake-lib, or a cc_library/cc_binary/
 *   cc_test using the cmake backend).
 * @returns {Promise<object>} An artifact(...) built from the cmake result.
 */
export async function packageCmakeArtifact(handle) {
	const result = await buildCmakeArtifact(handle);
	if (result.hasStageOutputs) {
		throw new Error(
			"package is not yet implemented for cmake targets using stageOutputs (their outputs may not share a common directory)",
		);
	}
	return artifact(result.outputDigest, { from: result.outputBase });
}

export const cmakeLibPackage = product(
	CmakeLib,
	PACKAGE,
	CMAKE_TOOL,
	packageCmakeArtifact,
	{ display: "package {0}", level: "info" },
);

// Regex-escapes and `-R`-joins a set of correlated CTest test names, scoping
// a cc_test target's own "test" product to just its case(s) instead of the
// whole suite. Absent for cmake-lib/manually-declared targets (and for
// cc_test targets outside the (b) exceptions correlation can't cover),
// leaving ctest's own default (run everything) unchanged.
function ctestNameFilterArgs(testNames) {
	if (!testNames || testNames.length === 0) return [];
	const pattern = testNames
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	return ["-R", `^(${pattern})$`];
}

// Runs the project's ctest suite. Framework-agnostic by construction: CMake's
// `add_test()` is how Unity, Catch2, GoogleTest, and doctest all register
// tests, so ctest itself is the generic runner — no per-framework detection
// needed here.
//
// Builds via the same per-edge graph replay as buildCppArtifact (so an
// unchanged source file's compile edge is a cache hit instead of the whole
// suite rebuilding), then runs ctest itself as one final impure step against
// the resulting build directory. Scoped to just `handle.attrs.testNames`
// when present (a cc_test target correlated to specific CTest case(s) by
// expandCmakeProject) — unscoped (whole suite) otherwise, matching the
// existing cmake-lib behavior.
export async function runCTest(handle) {
	const setup = await resolveCmakeSetup(handle);
	const { srcPath, buildDirPath } = setup;
	const ctestArgs = [
		...(handle.attrs.ctestArgs || []),
		...ctestNameFilterArgs(handle.attrs.testNames),
	];

	const graph = await configureNinjaGraph(handle, setup);
	const replayDigest = await replayReachableGraph(
		handle,
		setup,
		graph,
		replayTargetNames(handle),
	);

	// CTestTestfile.cmake (generated at configure time) bakes in the
	// *configure* sandbox's absolute root as each test's executable path —
	// the same absolute-sandbox-root problem the graph replay works around
	// for build.ninja, but ctest reads this file directly at runtime, so it
	// has to be patched in place instead: substitute the old (configure)
	// sandbox root for this run's real, current one (only knowable from
	// inside the sandbox itself, via `pwd`) before invoking ctest.
	const script =
		"oldroot=$1; bdir=$2; shift 2; " +
		"newroot=$(pwd); " +
		'find "$bdir" -name CTestTestfile.cmake -exec sed -i "s#$oldroot#$newroot#g" {} + ; ' +
		'ctest --test-dir "$bdir" "$@"';

	// No outputs/materialize on this final step: test results aren't
	// user-addressable artifacts. No impure flag: a passing run is cached
	// and replayed on a later run with unchanged inputs; a failing run
	// bails before any cache record is written, so it always reruns until
	// it passes — same choice cargoTest/odinTest make.
	return run({
		argv: [
			"sh",
			"-c",
			script,
			"cmake-test",
			graph.sandboxRoot || "",
			buildDirPath,
			...ctestArgs,
		],
		tools: [
			await nativeToolSpec(nativeTool("ctest")),
			await nativeToolSpec(nativeTool("find")),
			await nativeToolSpec(nativeTool("sed")),
		],
		inputs: [{ kind: "digest", digest: replayDigest }],
		display: `ctest ${srcPath}`,
	});
}

export const ctest = product(CmakeLib, TEST, CMAKE_TOOL, runCTest, {
	display: "test {0}",
	level: "info",
});

// Returns link artifacts at their staged locations as a resource file set for
// odin package sandboxing. Also ensures the cmake build is a plan prerequisite.
// Returns a `{kind:"digest"}` run()-inputs entry covering the build's whole
// result (never materialized, so odin's own sandboxed build reads the
// staged .so/.dylib/etc. files straight from this digest rather than a
// physical path) — not a FileSet, since the files it names were never
// captured from the real workspace.
export const cmake_resources = memo(
	async function cmake_resources(handle) {
		const result = await native_link_library(handle);
		return { kind: "digest", digest: result.outputDigest };
	},
	{ display: "cmake resources {0}", level: "debug" },
);

// Returns `{ paths, digest }` — same contract as rules/c/index.js's
// cc_link_artifacts, so a raw cc_binary/cc_library can depend on a
// cmake-backed library uniformly. `digest` is buildCmakeArtifact's own
// outputDigest (already known from its run() result); cmake's own build
// still materializes to real paths for now (its digest-chaining migration is
// a separate, later pass), but exposing the digest here lets *callers*
// (raw cc_binary linking against a cmake-backed cc_library) stop depending
// on physical presence.
export const cmake_link_artifacts = memo(
	async function cmake_link_artifacts(handle) {
		const result = await buildCmakeArtifact(handle);
		const setup = await resolveCmakeSetup(handle);
		const outputBase = handle.attrs.outputsInBuildDir
			? setup.buildDirPath
			: setup.srcPath;
		const linkFiles = (handle.attrs.outputs || [])
			.filter((name) => /\.(a|so|dll|lib|dylib)$/.test(name))
			.map((name) => `${outputBase}/${name}`);
		return { paths: linkFiles, digest: result.outputDigest };
	},
	{ display: "cmake link artifacts {0}", level: "debug" },
);

// Lazily expands a CmakeLib into one separately-addressable, separately-
// selectable imp target per real CMake target it declares (a
// CMakeLists.txt's own `add_library`/`add_executable`), instead of only ever
// exposing the coarse "all" target the hand-written CmakeLib itself models.
// Runs at most once per invocation, only for CmakeLib targets actually
// reachable from the current goal's selection (see `ensure_expanded` in
// spike.rs) — `configureNinjaGraph`'s `cmake configure` step is itself a
// normal content-keyed task-cache entry, so this doesn't reconfigure on
// every build once a project is unchanged.
//
// Each minted child gets `outputsInBuildDir: true` since `t.outputs` names
// files relative to buildDirPath (as recorded in build.ninja), not srcPath
// like a hand-written CmakeLib's `outputs` normally does — the artifact is
// already sitting there after replayReachableGraph's own per-edge
// materialize:true, so buildCppArtifact declares it from buildDirPath
// directly instead of staging a srcPath copy that never happens for these.
//
// Each child's own `kind` reflects its real CMake target type instead of
// uniformly reusing "cmake-lib" — STATIC_LIBRARY/SHARED_LIBRARY/
// MODULE_LIBRARY become "cc_library", a plain EXECUTABLE becomes
// "cc_binary", and an EXECUTABLE correlateCTestEntries can tie to one or
// more CTestTestfile.cmake add_test() cases becomes "cc_test" — mirroring
// Bazel's cc_test, which is simultaneously buildable and runnable-as-a-test
// (both a "build" and a "test" product are registered for it below).
const CMAKE_TYPE_TO_KIND = {
	STATIC_LIBRARY: "cc_library",
	SHARED_LIBRARY: "cc_library",
	MODULE_LIBRARY: "cc_library",
	// EXECUTABLE deliberately absent: it's "cc_binary" by default, or
	// "cc_test" when correlated to an add_test() case below.
};

function basename(path) {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

// Correlates CTestTestfile.cmake's add_test() entries back to the
// EXECUTABLE targets discovered by listNamedCmakeTargets, by comparing
// basenames: a test's command is either a fully resolved absolute path
// (rebasePath strips the configure sandbox root the same way build.ninja's
// own paths need it stripped) or a bare, unresolved token relying on
// ctest's cwd = buildDirPath to find it — both forms reduce to the plain
// executable filename once rebased. Returns executable-output-basename ->
// correlated test name(s); a test whose command doesn't match any
// discovered executable is silently uncorrelated (see plan notes — still
// exercised by the parent's own unscoped ctest run, just not its own target).
function correlateCTestEntries(graph, buildDirPath) {
	const testsByBasename = new Map();
	const ctestFilePath = `${buildDirPath}/CTestTestfile.cmake`;
	if (!pathsInDigest(graph.outputDigest).includes(ctestFilePath))
		return testsByBasename;

	const ctestText = readFileInDigest(graph.outputDigest, ctestFilePath);
	for (const test of parseCTestTestfile(ctestText)) {
		const commandPath = test.command[0];
		if (!commandPath) continue;
		const key = basename(rebasePath(commandPath, graph.sandboxRoot));
		if (!testsByBasename.has(key)) testsByBasename.set(key, []);
		testsByBasename.get(key).push(test.name);
	}
	return testsByBasename;
}

export const expandCmakeProject = expand(
	CmakeLib,
	async function expandCmakeProject(handle) {
		const setup = await resolveCmakeSetup(handle);
		const graph = await configureNinjaGraph(handle, setup);
		const parentAddress = safe_target_address(handle);
		const scope = parentAddress ? parentAddress.split(":")[0] : "//";
		const testsByBasename = correlateCTestEntries(graph, setup.buildDirPath);

		for (const cmakeTarget of listNamedCmakeTargets(graph)) {
			const matchedTestNames = new Set();
			if (cmakeTarget.type === "EXECUTABLE") {
				for (const candidate of [cmakeTarget.name, ...cmakeTarget.outputs]) {
					for (const name of testsByBasename.get(basename(candidate)) || []) {
						matchedTestNames.add(name);
					}
				}
			}
			const testNames = Array.from(matchedTestNames);
			const kind =
				testNames.length > 0
					? "cc_test"
					: CMAKE_TYPE_TO_KIND[cmakeTarget.type] || "cc_binary";

			registerTarget(
				new CmakeLib({
					src: handle.attrs.src,
					buildDir: handle.attrs.buildDir,
					srcs: handle.attrs.srcs,
					dirs: handle.attrs.dirs,
					cmakeArgs: handle.attrs.cmakeArgs,
					toolchain: handle.attrs.toolchainTarget || handle.attrs.toolchain,
					compiler: handle.attrs.compilerTarget || handle.attrs.compiler,
					outputs: cmakeTarget.outputs,
					outputsInBuildDir: true,
					kind,
					testNames,
				}),
				`${scope}:${cmakeTarget.name}`,
			);
		}
	},
	{ display: "expand CMake project {0}", level: "info" },
);

// ---------------------------------------------------------------------------
// Target constructors
// ---------------------------------------------------------------------------

/**
 * Declare a target that owns C/C++ source files.
 *
 * @category target
 * @param {object} opts
 * @param {string[]} opts.srcs Source glob patterns.
 * @returns {object} Target handle.
 */
export function cppSources({ srcs }) {
	return new CppSources({ srcs });
}

/**
 * Declare a CMake-backed native library, binary, or test target.
 *
 * @category target
 * @param {object} opts
 * @param {string} [opts.src="."] Workspace-relative CMake source directory.
 * @param {string} [opts.buildDir] Workspace-relative build directory.
 * @param {string[]} [opts.srcs] Source glob patterns staged for CMake.
 * @param {string[]} [opts.dirs=[]] Additional directories staged for CMake.
 * @param {string[]} [opts.cmakeArgs=[]] Extra arguments passed to CMake configure.
 * @param {string[]} [opts.ctestArgs=[]] Extra arguments passed to ctest.
 * @param {string[]} [opts.outputs=[]] Output paths produced by the CMake build.
 * @param {string[]} [opts.stageOutputs=[]] Output paths to stage from the build directory.
 * @param {object|string} [opts.toolchain] CMake toolchain target handle or version string.
 * @param {object|string} [opts.compiler] Compiler toolchain target handle or version string.
 * @param {Array} [opts.deps=[]] Additional dependencies.
 * @returns {object} Target handle.
 */
export function cmakeLib({
	src = ".",
	buildDir,
	srcs,
	dirs = [],
	cmakeArgs = [],
	ctestArgs = [],
	outputs = [],
	stageOutputs = [],
	toolchain,
	compiler,
	deps = [],
}) {
	return new CmakeLib({
		src,
		buildDir,
		srcs,
		dirs,
		cmakeArgs,
		ctestArgs,
		outputs,
		stageOutputs,
		toolchain,
		compiler,
		deps,
	});
}

/**
 * Issue #90 integration probe. It deliberately remains unsupported/private;
 * #32 will replace cmakeLib() with the production label factory.
 */
export function __cmakeLabelProbe({
	src = ".",
	buildDir,
	srcs,
	dirs = [],
	cmakeArgs = [],
	ctestArgs = [],
	toolchain,
	compiler,
}) {
	const project = label({
		data: {
			src,
			srcs: srcs || DEFAULT_CPP_SRCS,
			dirs,
			cmakeArgs,
			ctestArgs,
			...(toolchain
				? {
						toolchain:
							toolchain.__imp === true ? toolchain.attrs.version : toolchain,
					}
				: {}),
			...(compiler
				? {
						compiler:
							compiler.__imp === true ? compiler.attrs.version : compiler,
					}
				: {}),
			...(buildDir ? { buildDir } : {}),
		},
	});
	project.attrs = project.data;
	discoverLabels(
		project,
		async function discoverCmakeLabels(owner) {
			const setup = await resolveCmakeSetup(owner);
			const graph = await configureNinjaGraph(owner, setup);
			const scope = labelAddress(owner).split(":")[0];
			const testsByBasename = correlateCTestEntries(
				graph,
				setup.buildDirPath,
			);
			for (const cmakeTarget of listNamedCmakeTargets(graph)) {
				const matchedTestNames = new Set();
				if (cmakeTarget.type === "EXECUTABLE") {
					for (const candidate of [cmakeTarget.name, ...cmakeTarget.outputs]) {
						for (const name of testsByBasename.get(basename(candidate)) || []) {
							matchedTestNames.add(name);
						}
					}
				}
				const child = label({
					data: {
						...owner.data,
						outputs: cmakeTarget.outputs,
						outputsInBuildDir: true,
						testNames: Array.from(matchedTestNames),
					},
				});
				child.attrs = child.data;
				build(child, async function buildDiscoveredCmakeTarget() {
					return buildCmakeArtifact(child);
				});
				if (child.data.testNames.length > 0) {
					test(child, async function testDiscoveredCmakeTarget() {
						return runCTest(child);
					});
				}
				registerLabel(child, `${scope}:${cmakeTarget.name}`);
			}
		},
		{ goals: ["build", "test"] },
	);
	return project;
}
