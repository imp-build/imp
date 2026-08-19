// Graph-native port of rules/c/cmake/index.js's configureNinjaGraph()/
// replayReachableGraph()/correlateCTestEntries() (issue #31/#62). These are
// logic-pure (wave scheduling, sandbox-root rebasing, POST_BUILD copy
// sniffing) but were built entirely on the *legacy* run()/output()/
// mergeDigests() primitives, not exec.action()/output.* — this file ports
// the I/O layer to exec.action(), reusing rules/c/cmake/ninja_graph.js's
// parsing helpers verbatim (they're pure text-in/structured-data-out, no
// primitive coupling at all).
//
// Two building blocks, both plain functions that internally call task():
//   - configureCmakeProject(spec): runs `cmake -S -B -G Ninja` once and
//     parses the resulting ninja graph. One task per project.
//   - replayCmakeTarget(spec, configured, targetNames): replays every
//     ninja edge reachable from targetNames as its own exec.action() call,
//     in topological waves — one task per *call*, so rules/c/cmake's
//     expand()-based per-target discovery (#62/PR C2) can mint one replay
//     task per discovered CMake target, each depending on the shared
//     configure task's output. Per the #31 migration plan's decision 6,
//     this migration deliberately stops at target-level task granularity
//     (not one task per ninja edge) — any one target's task still declares
//     the whole project's sources as its own input, so an unrelated
//     source-file edit still invalidates it, same coarse tradeoff
//     rules/c/graph.js's own ccTask() already accepts.
//
// mergeDigests()-based accumulation (the legacy mechanism letting a later
// wave "see" an earlier wave's outputs without physical materialization)
// has no graph-native equivalent primitive — the replacement is threading
// each exec.action() call's own result.outputs.* binding into the next
// wave's exec.action() `inputs:` array directly (the same output-binding
// chaining every other migrated ruleset already relies on).
//
// CMake itself is a pinned, graph-native toolchain (rules/c/cmake/toolchain.js's
// cmakeGraphTool()/cmakeGraphToolchain(), PR D) — not resolved from ambient
// host PATH. Configure invokes it via a resolved tool() binding directly;
// replay resolves a rewritten bare "cmake" name (recovered from a
// POST_BUILD custom command's baked-in CMAKE_COMMAND path — see
// cmakeGraphTool()'s own docstring) via cmakeGraphToolSpec(), the same
// freshly-constructible pattern gcc's own clang/cc/c++/ar names use below.
//
// C compiler toolchain support is gcc-only for now: CMake bakes CMAKE_C_COMPILER et al
// into build.ninja as literal text, read back by *later, separate* replay
// sandboxes — so it needs a real, stable, absolute host path, not
// exec.tool()'s sandbox-mount-relative one (the exact bug class
// gccRustLinkDriverEnv's own docstring covers for rustc's `-C linker=`).
// gcc's graph toolchain already has that (gccCMakeCompilerArgs(), backed by
// the same named-cache cacheGet() gccRustLinkDriverEnv() uses); zig's graph
// toolchain (rules/c/zig's zigGraphTool()) doesn't yet cachePut a
// named-cache-backed real path at all, so zig-as-CMake-compiler is left
// unsupported here — a known follow-up gap, tracked alongside #61's own
// zig-ar static-archive gap.

import {
	files,
	output,
	packagePath,
	pathsInDigest,
	readFileInDigest,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import {
	defaultGccGraphToolchain,
	gccCMakeCompilerArgs,
	gccGraphToolSpec,
} from "//rules/c/gcc";
import {
	cmakeGraphToolSpec,
	cmakeGraphToolchainDir,
	defaultCmakeGraphToolchain,
} from "//rules/c/cmake/toolchain";
import {
	extractCopyDestinations,
	parseNinja,
	reachableEdgesBounded,
	rebasePath,
	resolveEdgeCommand,
	sandboxRootFromWorkdir,
} from "//rules/c/cmake/ninja_graph";
import { parseCTestTestfile } from "//rules/c/cmake/ctest_testfile";

// build.ninja bakes gccCMakeCompilerArgs()'s real absolute compiler paths
// in as literal command text; rewriteToolInvocations() (see ninja_graph.js)
// rewrites *any* absolute command-position path back to a bare name for
// replay, regardless of where it came from — these are the only bare names
// that can result from *our own* compiler args, so they're resolved via
// gccGraphToolSpec() (a real mount of this pinned toolchain) rather than
// nativeTool() (which would resolve to a different, unpinned system tool
// with the same bare name, if one exists at all in a hermetic sandbox).
const GCC_GRAPH_TOOL_NAMES = new Set([
	"clang",
	"cc",
	"c++",
	"ar",
	"ranlib",
	// The unsafeSystemPaths escape hatch (see cmakeProjectSpec() below and
	// rules/c/gcc's gccGraphTool()/gccCMakeCompilerArgs()) can bake these
	// aliases into build.ninja instead of the plain ones above.
	"clang-unsafe-paths",
	"cc-unsafe-paths",
	"c++-unsafe-paths",
	// gccCMakeCompilerArgs() bakes a ".exe" suffix into every name above on
	// Windows (see its own doc comment in rules/c/gcc) — rewriteToolInvocations()
	// extracts the basename verbatim, extension included, so those literal
	// names need their own entries here.
	"clang.exe",
	"cc.exe",
	"c++.exe",
	"ar.exe",
	"ranlib.exe",
	"clang-unsafe-paths.exe",
	"cc-unsafe-paths.exe",
	"c++-unsafe-paths.exe",
]);

function isZigToolchain(toolchain) {
	return !!toolchain.buildCacheTool;
}

// The task()-input slice a resolved toolchain contributes (mirrors
// rules/c/graph.js's toolchainTaskInputs()).
function toolchainTaskInputs(toolchain) {
	return { ccTool: toolchain.tool };
}

function resolveCmakeToolchain(toolchain) {
	const resolved = toolchain || defaultCmakeGraphToolchain();
	if (!resolved) {
		throw new Error(
			"cmakeProject() needs a declared CMake default (see //rules/c/cmake/toolchain) or an explicit cmakeToolchain option",
		);
	}
	return resolved;
}

function requireGccToolchain(toolchain) {
	const resolved = toolchain || defaultGccGraphToolchain();
	if (!resolved) {
		throw new Error(
			"cmakeProject() needs an explicit gcc toolchain or a declared gcc default — see //rules/c/gcc",
		);
	}
	if (isZigToolchain(resolved)) {
		throw new Error(
			"cmakeProject() doesn't support a zig toolchain yet — rules/c/zig's zigGraphTool() has no named-cache-backed real path for CMake to bake into build.ninja (see this module's own docstring); pass a gccGraphToolchain() instead",
		);
	}
	return resolved;
}

// Normalizes cmakeProject()'s own opts into the plain spec both
// configureCmakeProject() and replayCmakeTarget() take. Exported so
// rules/c/cmake/expansion.js (#62/PR C2) can build it once and pass it to
// both, and so tests can construct one directly.
export function cmakeProjectSpec(opts = {}) {
	const {
		path = packagePath(),
		buildDir,
		srcs = [
			"CMakeLists.txt",
			"**/*.c",
			"**/*.cc",
			"**/*.cpp",
			"**/*.cxx",
			"**/*.h",
			"**/*.hh",
			"**/*.hpp",
			"**/*.hxx",
		],
		dirs = [],
		cmakeArgs = [],
		toolchain,
		cmakeToolchain,
		unsafeSystemPaths = false,
	} = opts;
	const srcPath = path;
	const buildDirPath =
		buildDir || `build/${srcPath === "." ? "cmake" : srcPath}`;
	return {
		path: srcPath,
		buildDirPath,
		cmakeArgs: [...cmakeArgs],
		srcsInput: files({ root: srcPath, include: srcs }),
		dirInputs: Object.fromEntries(
			dirs.map((d, i) => [
				`dir${i}`,
				files({ root: `${srcPath}/${d}`, include: ["**/*"] }),
			]),
		),
		toolchain: requireGccToolchain(toolchain),
		cmakeToolchain: resolveCmakeToolchain(cmakeToolchain),
		// Bypasses Bootlin's toolchain-wrapper unsafe-path guard for this
		// project's compiler (see gccGraphTool()'s install-step comment in
		// rules/c/gcc/index.js for what it rejects and why) — needed to link
		// against host system packages like libwebkit2gtk-4.1.
		unsafeSystemPaths: !!unsafeSystemPaths,
	};
}

/**
 * Configure a CMake project with the Ninja generator and parse the
 * resulting build graph. One task per project — real memoization (unlike
 * the legacy discoverCmakeLabels(), which reconfigured on every call).
 *
 * @param {object} spec From cmakeProjectSpec().
 * @returns {object} Task handle with `.outputs.directory` (the configured
 *   build dir, an artifact) and `.outputs.ninjaGraph` (a plain JSON value:
 *   `{rules, edges, topVars, targetTypes, sandboxRoot, ctestText}`).
 */
export function configureCmakeProject(spec) {
	return task({
		display: `cmake configure ${spec.path}`,
		inputs: {
			srcs: spec.srcsInput,
			...spec.dirInputs,
			...toolchainTaskInputs(spec.toolchain),
			ninja: nativeTool("ninja"),
			cmakeTool: spec.cmakeToolchain.tool,
			sed: nativeTool("sed"),
		},
		outputs: { directory: output.artifact(), ninjaGraph: output.value() },
		async run(exec, input) {
			const compilerArgs = gccCMakeCompilerArgs(
				exec,
				input.ccTool,
				spec.toolchain.version,
				spec.unsafeSystemPaths,
			);
			const cmakeDir = cmakeGraphToolchainDir(
				exec,
				input.cmakeTool,
				spec.cmakeToolchain.version,
			);
			const cmakeExe = `${cmakeDir}/bin/cmake`;
			// Direct argv, no `sh`: cmake (and everything it spawns
			// internally, including try_compile's own nested cmake/ninja/
			// clang chain) is then a genuine native child of imp's Rust
			// harness, so it actually inherits the harness's sandboxed
			// TMP/TEMP (sandbox_home_tmp() in
			// crates/imp-execution/src/exec.rs) instead of losing them
			// across Git-for-Windows' MSYS sh's native-child exec boundary —
			// the same failure class rules/c/index.js's own
			// toolchainCommands() comment documents for direct compiler
			// invocations, except CMake's try_compile has no -pipe-style
			// escape hatch since it's spawned deep inside cmake.exe's own
			// process tree, not something our own argv construction
			// touches. No `mkdir` needed either: the harness pre-creates
			// every declared output's directory before a sandboxed run
			// starts.
			const configured = await exec.action({
				argv: [
					cmakeExe,
					"-S",
					spec.path,
					"-B",
					spec.buildDirPath,
					"-G",
					"Ninja",
					...compilerArgs,
					...spec.cmakeArgs,
				],
				tools: [input.ninja],
				inputs: [
					input.srcs,
					...Object.keys(spec.dirInputs).map((key) => input[key]),
				],
				outputs: { directory: output.directory(spec.buildDirPath) },
				display: `cmake configure ${spec.path}`,
			});

			// Read generated files straight out of the captured directory's
			// own CAS tree — no sandbox, no second process needed just to
			// look at text CMake already wrote. A directory-kind output
			// nests under its own declared path (see
			// normalize_graph_artifact() in crates/imp-engine/src/spike.rs),
			// so reads need the buildDirPath prefix, not a bare
			// bdir-relative path.
			const digest = configured.outputs.directory.digest;
			const readGenerated = (relPath) =>
				readFileInDigest(digest, `${spec.buildDirPath}/${relPath}`);
			const mainText = readGenerated("build.ninja");
			const { rules, edges, topVars, targetTypes } = parseNinja(
				mainText,
				readGenerated,
			);
			const sandboxRoot = sandboxRootFromWorkdir(
				topVars.cmake_ninja_workdir,
				spec.buildDirPath,
			);

			// CTestTestfile.cmake bakes each test's executable as an
			// *absolute* path rooted at this exact configure sandbox
			// (CMake's own auto-substitution for `add_test(NAME ...
			// COMMAND target)`). Rewritten here, right when the real
			// absolute build dir (cmake_ninja_workdir) is known with
			// certainty, no separate capture-and-match needed later — the
			// "fix at build time, not run time" this repo's own
			// runCTestTask() used to defer (see its history): a run-time
			// oldroot->newroot rewrite bakes the *current* sandbox's path
			// into a cached exec.action(), which is invisible to the
			// action's cache key, so a cache hit silently replays a stale
			// path from whatever sandbox first produced that exact cached
			// result. A bare relative token has no sandbox path to go
			// stale — CTest resolves it against its own --test-dir cwd (see
			// ctest_testfile.js's own comment on this form). A project with
			// nested add_subdirectory()s that each call
			// enable_testing()/add_test() gets one CTestTestfile.cmake per
			// subdirectory, not just the top-level one — every one needs
			// the same rewrite for `ctest --test-dir` to recurse correctly.
			const allPaths = pathsInDigest(digest);
			const topCtestPath = `${spec.buildDirPath}/CTestTestfile.cmake`;
			const ctestPaths = allPaths.filter(
				(p) => p === topCtestPath || p.endsWith("/CTestTestfile.cmake"),
			);
			const workdir = topVars.cmake_ninja_workdir;

			let directory = configured.outputs.directory;
			if (ctestPaths.length > 0 && workdir) {
				// Still via `sh`, unlike the configure action above: this
				// repo's `sed` is an MSYS-linked build (imports
				// msys-2.0.dll/msys-intl-8.dll — confirmed directly), so
				// invoking it as a bare native child fails to launch at all
				// (STATUS_DLL_NOT_FOUND) without sh's environment. That's
				// fine here — unlike cmake's try_compile, this step never
				// spawns a compiler toolchain that needs a real TMP/TEMP, so
				// it was never exposed to the MSYS TMP-dropping bug in the
				// first place. Pattern/paths are still fully precomputed in
				// JS, so no `find`/shell expansion is needed beyond handing
				// sed its args.
				const patched = await exec.action({
					argv: [
						"sh",
						"-c",
						'pattern=$1; shift; sed -i "$pattern" "$@"',
						"cmake-patch-ctest",
						`s#${workdir}##g`,
						...ctestPaths,
					],
					tools: [input.sed],
					inputs: [configured.outputs.directory],
					outputs: { directory: output.directory(spec.buildDirPath) },
					display: `cmake patch ctest paths ${spec.path}`,
				});
				directory = patched.outputs.directory;
			}

			// Computed independently of the patch action above (which
			// exists purely to fix the *physical* file runCTestTask() later
			// runs ctest directly against) — an equivalent rewrite, done in
			// JS against the raw digest content, so correlateCTestEntries()
			// doesn't have to wait on/depend on that action at all.
			const rawCtestText = ctestPaths.includes(topCtestPath)
				? readFileInDigest(digest, topCtestPath)
				: null;
			const ctestText =
				rawCtestText && workdir
					? rawCtestText.split(workdir).join("")
					: rawCtestText;

			return {
				directory,
				ninjaGraph: {
					rules,
					edges,
					topVars,
					targetTypes,
					sandboxRoot,
					ctestText,
				},
			};
		},
	});
}

// Correlates CTestTestfile.cmake's add_test() entries to executable output
// basenames — same logic as the legacy correlateCTestEntries(), just
// operating on the ctest file's text directly (already captured by
// configureCmakeProject() above) instead of reading it out of a digest.
export function correlateCTestEntries(ninjaGraph) {
	const testsByBasename = new Map();
	if (!ninjaGraph.ctestText) return testsByBasename;
	for (const t of parseCTestTestfile(ninjaGraph.ctestText)) {
		const commandPath = t.command[0];
		if (!commandPath) continue;
		const key = basename(rebasePath(commandPath, ninjaGraph.sandboxRoot));
		if (!testsByBasename.has(key)) testsByBasename.set(key, []);
		testsByBasename.get(key).push(t.name);
	}
	return testsByBasename;
}

export function basename(path) {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Replay every ninja build edge reachable from `targetNames` as its own
 * exec.action() call, in topological waves, producing that target's own
 * build outputs. One task per call — rules/c/cmake/expansion.js mints one
 * per discovered CMake target, each depending on the shared
 * configureCmakeProject() task's output.
 *
 * @param {object} spec From cmakeProjectSpec().
 * @param {object} configured configureCmakeProject(spec)'s task handle.
 * @param {object} ninjaGraph The *resolved* `configured.outputs.ninjaGraph`
 *   value (plain JSON) — the caller already has this (e.g.
 *   rules/c/cmake/expansion.js's expand() `create()` receives it resolved),
 *   so it's captured directly rather than re-declared as a task input.
 * @param {string[]} targetNames Ninja target names to build (e.g. ["all"]
 *   or a single discovered CMake target's own output names).
 * @param {string[]} [exposeOutputs] buildDirPath-relative file paths (a
 *   subset of what targetNames produces, e.g. a discovered CMake target's
 *   own `outputs`) to additionally expose as their own named artifacts —
 *   `.outputs.file0`/`.outputs.file1`/... in `targetNames` order — so a
 *   caller (rules/c/cmake/expansion.js) can hand out a single target's own
 *   build product without the whole shared build directory. Omit to skip
 *   (only `.outputs.directory` is produced).
 * @param {object} [targetDeps] `{ [otherTargetName]: { outputs: string[],
 *   task: <replayCmakeTarget() handle>, fileIndices?: number[] } }` — other
 *   named CMake targets this one depends on (CMake's own Ninja generator
 *   names a dependency's final output directly in a `|`/`||` reference; see
 *   reachableEdgesBounded() in ninja_graph.js). Declaring them here stops
 *   this target's own edge walk at that boundary instead of re-deriving the
 *   dependency's edges, and takes its already-built artifact(s)
 *   (`dep.task.outputs[`file${i}`]` for each `i` in `fileIndices`, default
 *   `[0]`) as declared graph inputs instead — every referenced output, not
 *   just one, since a dependency can be needed in more than one way at once
 *   (see buildTargetDeps()'s own docstring in expansion.js). Omit for a
 *   target with no cross-target dependencies — behaves exactly as before.
 * @returns {object} Task handle with `.outputs.directory` (an artifact: the
 *   build directory after replay, including any POST_BUILD copy
 *   destinations) and, per `exposeOutputs` entry, `.outputs.file<i>`.
 */
export function replayCmakeTarget(
	spec,
	configured,
	ninjaGraph,
	targetNames,
	exposeOutputs = [],
	targetDeps = {},
) {
	const { rules, edges, sandboxRoot } = ninjaGraph;
	// A dependency's own final output(s) — CMake's Ninja generator names
	// these directly in a `|`/`||` reference when one real target depends
	// on another (see reachableEdgesBounded()'s own docstring). Stopping
	// the walk there means this target's replay takes the other target's
	// already-built artifact as a declared input instead of re-deriving
	// its edges from scratch.
	const boundaryOutputPaths = new Set();
	for (const dep of Object.values(targetDeps)) {
		for (const p of dep.outputs) boundaryOutputPaths.add(p);
	}
	const { edges: allReached } = reachableEdgesBounded(
		edges,
		targetNames,
		boundaryOutputPaths,
	);
	const reached = allReached.filter(
		(edge) =>
			edge.rule !== "phony" && rules[edge.rule] && rules[edge.rule].command,
	);

	const allByOutput = new Map();
	for (const edge of allReached) {
		for (const p of [...edge.outputs, ...edge.implicitOutputs])
			allByOutput.set(p, edge);
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
			if (depEdge && depEdge !== edge)
				depLevel = Math.max(depLevel, levelOf(depEdge));
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

	return task({
		display: `cmake build ${spec.path} [${targetNames.join(",")}]`,
		inputs: {
			configureDirectory: configured.outputs.directory,
			srcs: spec.srcsInput,
			...spec.dirInputs,
			...toolchainTaskInputs(spec.toolchain),
			mkdir: nativeTool("mkdir"),
			cp: nativeTool("cp"),
			dirname: nativeTool("dirname"),
			// task()'s identity key is call site + declared inputs only — it
			// can't see plain closure arguments. Every discovered CMake
			// target's replayCmakeTarget() call shares this exact call site,
			// module, and (spec/configured/ninjaGraph-derived) inputs above,
			// so without these two the key collides across every target in
			// one CMakeLists.txt and every target after the first silently
			// resolves to the first target's already-registered task.
			targetNames,
			exposeOutputs,
			// Real graph handles (not plain closure data), so task()'s own
			// _graphInput() fingerprints each by its producing task's
			// identity — a dependency target whose own inputs changed (or a
			// different set of dependency names entirely, which changes
			// this object's own key set) naturally produces a distinct key
			// here. depTargetNames is redundant with the dep_<name>_<i> keys
			// above but kept anyway, matching this file's existing
			// targetNames/exposeOutputs defense-in-depth precedent. One key
			// per referenced fileIndex, not one per dependency name: a
			// dependency can be needed in more than one way at once (see
			// buildTargetDeps()'s own docstring in expansion.js).
			...Object.fromEntries(
				Object.entries(targetDeps).flatMap(([name, dep]) =>
					(dep.fileIndices ?? [0]).map((i) => [
						`dep_${name}_${i}`,
						dep.task.outputs[`file${i}`],
					]),
				),
			),
			depTargetNames: Object.keys(targetDeps).sort(),
		},
		outputs: {
			directory: output.artifact(),
			...Object.fromEntries(
				exposeOutputs.map((_, i) => [`file${i}`, output.artifact()]),
			),
		},
		async run(exec, input) {
			const baseTools = [input.mkdir, input.cp, input.dirname];
			const baseToolNames = new Set(["mkdir", "cp", "dirname"]);
			const dirInputBindings = Object.keys(spec.dirInputs).map(
				(key) => input[key],
			);
			// A boundary dependency's own artifact(s) are already captured at
			// their real buildDirPath-relative paths (same mechanism
			// exposeOutputs' file0..N rely on). Every referenced output is
			// mounted unconditionally for every edge in this replay, not just
			// the ones that need it: which edge needs which specific file
			// physically present can't be determined from parsed data alone
			// (an order-only reference is by design invisible in resolved
			// command text — see reachableEdgesBounded()'s own docstring —
			// yet still a real requirement, e.g. a DLL a built executable
			// loads at runtime without ever naming it in its own link
			// command), and there are normally only one or two boundary deps
			// per target, so mounting them broadly is cheap.
			const boundaryInputs = Object.entries(targetDeps).flatMap(([name, dep]) =>
				(dep.fileIndices ?? [0]).map((i) => input[`dep_${name}_${i}`]),
			);

			async function executeEdge(edge, priorOutputs) {
				const resolved = resolveEdgeCommand(
					edge,
					rules,
					ninjaGraph.topVars,
					sandboxRoot,
					spec.buildDirPath,
				);
				if (!resolved) return [];

				const edgeTools = [...baseTools];
				for (const name of resolved.toolNames) {
					if (baseToolNames.has(name)) continue;
					// nativeTool() only produces a resolved graph binding when
					// declared as a task's own static `inputs:` (see e.g.
					// rules/c/mold's install task) — a dynamically discovered
					// tool name, known only once an edge's command is parsed
					// here at execution time, can't be turned into one from
					// inside a running task() body. gccGraphToolSpec()/
					// cmakeGraphToolSpec() are the freshly-constructible,
					// named-cache-backed alternative (see cmakeGraphTool()'s
					// own docstring in //rules/c/cmake/toolchain for why
					// "cmake" — CMAKE_COMMAND baked into a POST_BUILD custom
					// command — needs the exact same treatment as gcc's own
					// clang/cc/c++/ar/ranlib). A real gap for a CMake project
					// invoking some other absolute-pathed host tool from its
					// build commands — tracked as a follow-up alongside this
					// migration's other known gap (zig-as-CMake-compiler).
					if (GCC_GRAPH_TOOL_NAMES.has(name)) {
						edgeTools.push(gccGraphToolSpec(spec.toolchain.version, name));
						continue;
					}
					// ".exe" alongside the bare name for the same reason
					// GCC_GRAPH_TOOL_NAMES lists both forms: on Windows,
					// gccCMakeCompilerArgs()'s own compiler paths always
					// carry the suffix, and rewriteToolInvocations() extracts
					// the basename verbatim, extension included. The mount's
					// own folder name ("cmake", from cmakeGraphToolSpec()) is
					// unrelated to this — only its bin dir matters for PATH,
					// and the real binary inside it is "cmake.exe" either way.
					if (name === "cmake" || name === "cmake.exe") {
						edgeTools.push(cmakeGraphToolSpec(spec.cmakeToolchain.version));
						continue;
					}
					throw new Error(
						`cmake edge needs unsupported host tool '${name}' — only gcc's own clang/cc/c++/ar/ranlib and cmake itself are resolvable from a graph-native CMake replay right now`,
					);
				}

				const outputPaths = [...edge.outputs, ...edge.implicitOutputs];
				const copyOutputs = extractCopyDestinations(
					resolved.command,
					spec.buildDirPath,
				);
				const destPaths = [
					...outputPaths.map((p) => `${spec.buildDirPath}/${p}`),
					...copyOutputs,
				];
				const cdCommand = `cd '${spec.buildDirPath}' && ${resolved.command}`;
				const outputNames = destPaths.map((_, i) => `out${i}`);

				const result = await exec.action({
					argv: ["sh", "-c", cdCommand],
					tools: edgeTools,
					inputs: [
						input.srcs,
						...dirInputBindings,
						input.configureDirectory,
						...priorOutputs,
						...boundaryInputs,
					],
					outputs: Object.fromEntries(
						destPaths.map((p, i) => [outputNames[i], output.file(p)]),
					),
					display: `cmake edge ${outputPaths[0] || edge.rule}`,
				});
				return outputNames.map((name) => result.outputs[name]);
			}

			let priorOutputs = [];
			for (const wave of waves) {
				if (!wave) continue;
				const results = await Promise.all(
					wave.map((edge) => executeEdge(edge, priorOutputs)),
				);
				priorOutputs = [...priorOutputs, ...results.flat()];
			}

			// Every edge's output already reappears at its own real
			// buildDirPath-relative path once listed as an input (produced
			// artifacts now nest under their real captured path, not an
			// output-slot name — see normalize_graph_artifact() in
			// crates/imp-engine/src/spike.rs), so this pass just needs to
			// mount configureDirectory plus every edge output together to
			// declare the final directory/exposeOutputs artifacts; no
			// reconstruction script is needed.
			const staged = await exec.action({
				argv: ["sh", "-c", "true"],
				// boundaryInputs included so this target's own exposed
				// `directory` stays a complete build tree (e.g. for
				// runCTestTask(), which runs a test executable straight out
				// of it) — the same completeness the old unbounded replay
				// had incidentally, from re-deriving the dependency's files
				// itself.
				inputs: [input.configureDirectory, ...priorOutputs, ...boundaryInputs],
				outputs: {
					directory: output.directory(spec.buildDirPath),
					...Object.fromEntries(
						exposeOutputs.map((p, i) => [
							`file${i}`,
							output.file(`${spec.buildDirPath}/${p}`),
						]),
					),
				},
				display: `cmake stage ${spec.path}`,
			});
			return {
				directory: staged.outputs.directory,
				...Object.fromEntries(
					exposeOutputs.map((_, i) => [`file${i}`, staged.outputs[`file${i}`]]),
				),
			};
		},
	});
}

// Sanitizes test names the same way legacy ctestNameFilterArgs() did, for a
// -R regex that matches CTest's exact test name(s), nothing broader.
function ctestNameFilterArgs(testNames) {
	if (!testNames || testNames.length === 0) return [];
	const pattern = testNames
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	return ["-R", `^(${pattern})$`];
}

/**
 * Build (via replayCmakeTarget()) then run ctest, scoped to `testNames` when
 * given. One task per call — rules/c/cmake/expansion.js mints one per
 * discovered CMake test target.
 *
 * CTestTestfile.cmake (generated at configure time) bakes in *configure's*
 * own sandbox absolute root as each test's executable path — same problem
 * replay's own sandbox-root rebasing solves for build.ninja, but ctest reads
 * this file directly at runtime, so it's patched in place instead (same
 * `sed` substitution the legacy runCTest() used).
 *
 * @param {object} spec From cmakeProjectSpec().
 * @param {object} configured configureCmakeProject(spec)'s task handle.
 * @param {object} ninjaGraph The *resolved* `configured.outputs.ninjaGraph` value.
 * @param {string[]} targetNames Ninja target names to build first (see replayCmakeTarget()).
 * @param {string[]} [testNames] CTest test name(s) to scope to; all tests if omitted.
 * @param {object} [targetDeps] Forwarded to replayCmakeTarget() — see its
 *   own docstring. Avoids the test executable's own replay re-deriving a
 *   library dependency's edges it already has its own task for.
 * @returns {object} Task handle whose `units` output resolves to a single-entry
 *   `[{name, ok, output}]` list — see //rules/workflows/test's contract.
 */
export function runCTestTask(
	spec,
	configured,
	ninjaGraph,
	targetNames,
	testNames = [],
	targetDeps = {},
) {
	const built = replayCmakeTarget(
		spec,
		configured,
		ninjaGraph,
		targetNames,
		[],
		targetDeps,
	);
	const unitName = testNames.length ? testNames.join(",") : spec.path;
	return task({
		display: `ctest ${spec.path} [${(testNames.length ? testNames : ["all"]).join(",")}]`,
		inputs: {
			directory: built.outputs.directory,
			ctest: nativeTool("ctest"),
		},
		outputs: { units: output.value() },
		async run(exec, input) {
			// built.outputs.directory now mounts at its own real path
			// (spec.buildDirPath) since produced artifacts nest under their
			// real captured path, not an output-slot name — see
			// normalize_graph_artifact() in crates/imp-engine/src/spike.rs.
			// CTestTestfile.cmake's own baked executable paths are already
			// bare relative tokens by this point — configureCmakeProject()
			// rewrites them once, at configure time, from its own real
			// absolute build dir (see that function's own comment on why:
			// a run-time rewrite here, using this sandbox's $(pwd), would be
			// invisible to this cached exec.action()'s cache key and risk
			// replaying a stale path from whichever sandbox first produced
			// an identical cached result). CTest resolves the relative
			// tokens itself via --test-dir.
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					'bdir=$1; shift; ctest --test-dir "$bdir" "$@"',
					"cmake-ctest",
					spec.buildDirPath,
					...ctestNameFilterArgs(testNames),
				],
				tools: [input.ctest],
				inputs: [input.directory],
				display: `ctest ${spec.path}`,
				allowFailure: true,
			});
			const ok = result.exitCode === 0;
			return {
				units: [
					{
						name: unitName,
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
