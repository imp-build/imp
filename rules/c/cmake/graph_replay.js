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

import { files, output, packagePath, task } from "imp:core";
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
	reachableEdges,
	rebasePath,
	resolveEdgeCommand,
	sandboxRootFromWorkdir,
} from "//rules/c/cmake/ninja_graph";
import { parseCTestTestfile } from "//rules/c/cmake/ctest_testfile";

// Control bytes delimiting a multi-file dump in one exec.action()'s stdout:
// the only way to get an unknown-in-advance set of files (every *.ninja
// CMake's generator wrote, plus CTestTestfile.cmake if present) back out of
// a single action, since exec.action()'s own `outputs:` must be declared
// (as a fixed set of names) before the action runs — a real file's name
// can't become a new named output after the fact. Control bytes (not valid
// in any of these plain-text generated files) delimit path/content pairs.
const FILE_START = "\x01";
const FILE_MID = "\x02";
const FILE_END = "\x03";

function parseFileDump(dump) {
	const filesByPath = new Map();
	for (const chunk of dump.split(FILE_END)) {
		if (chunk.length === 0) continue;
		const start = chunk.indexOf(FILE_START);
		const mid = chunk.indexOf(FILE_MID);
		if (start === -1 || mid === -1) continue;
		filesByPath.set(chunk.slice(start + 1, mid), chunk.slice(mid + 1));
	}
	return filesByPath;
}

// build.ninja bakes gccCMakeCompilerArgs()'s real absolute compiler paths
// in as literal command text; rewriteToolInvocations() (see ninja_graph.js)
// rewrites *any* absolute command-position path back to a bare name for
// replay, regardless of where it came from — these are the only bare names
// that can result from *our own* compiler args, so they're resolved via
// gccGraphToolSpec() (a real mount of this pinned toolchain) rather than
// nativeTool() (which would resolve to a different, unpinned system tool
// with the same bare name, if one exists at all in a hermetic sandbox).
const GCC_GRAPH_TOOL_NAMES = new Set(["clang", "cc", "c++", "ar"]);

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
			mkdir: nativeTool("mkdir"),
			ninja: nativeTool("ninja"),
			cmakeTool: spec.cmakeToolchain.tool,
			find: nativeTool("find"),
			cat: nativeTool("cat"),
			dirname: nativeTool("dirname"),
		},
		outputs: { directory: output.artifact(), ninjaGraph: output.value() },
		async run(exec, input) {
			const compilerArgs = gccCMakeCompilerArgs(
				exec,
				input.ccTool,
				spec.toolchain.version,
			);
			const cmakeDir = cmakeGraphToolchainDir(
				exec,
				input.cmakeTool,
				spec.cmakeToolchain.version,
			);
			const cmakeExe = `${cmakeDir}/bin/cmake`;
			const script =
				"src=$1; bdir=$2; cmakeExe=$3; shift 3; " +
				'mkdir -p "$bdir" && "$cmakeExe" -S "$src" -B "$bdir" -G Ninja "$@" 1>&2 && ' +
				`find "$bdir" \\( -name '*.ninja' -o -name CTestTestfile.cmake \\) | while read -r f; do ` +
				`printf '${FILE_START}%s${FILE_MID}' "\${f#$bdir/}"; cat "$f"; printf '${FILE_END}'; done`;
			const result = await exec.action({
				argv: [
					"sh",
					"-c",
					script,
					"cmake-configure",
					spec.path,
					spec.buildDirPath,
					cmakeExe,
					...compilerArgs,
					...spec.cmakeArgs,
				],
				tools: [input.mkdir, input.ninja, input.find, input.cat, input.dirname],
				inputs: [
					input.srcs,
					...Object.keys(spec.dirInputs).map((key) => input[key]),
				],
				outputs: { directory: output.directory(spec.buildDirPath) },
				display: `cmake configure ${spec.path}`,
			});
			const dumped = parseFileDump(result.stdout);
			const mainText = dumped.get("build.ninja") || "";
			const { rules, edges, topVars, targetTypes } = parseNinja(
				mainText,
				(p) => dumped.get(p) || "",
			);
			const sandboxRoot = sandboxRootFromWorkdir(
				topVars.cmake_ninja_workdir,
				spec.buildDirPath,
			);
			// Dump keys are relative to $bdir (spec.buildDirPath), not
			// workspace-relative — matches the find/printf script's own
			// "${f#$bdir/}" stripping above.
			const ctestText = dumped.get("CTestTestfile.cmake") || null;
			return {
				directory: result.outputs.directory,
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
) {
	const { rules, edges, sandboxRoot } = ninjaGraph;
	const allReached = reachableEdges(edges, targetNames);
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
			// Output slot names ("out0", "out1", ...) are only unique *within*
			// one exec.action() call — an artifact mounts under its own slot
			// name when reused elsewhere (see reconstructBuildDirCmds()'s own
			// docstring), so two *different* actions that both happen to
			// name their own first output "out0" collide the instant both
			// get consumed together by a later action (confirmed via a real
			// "merge conflict at 'out0'" failure). A counter shared across
			// every exec.action() call in this whole task keeps every
			// declared name globally unique instead.
			let nextSlot = 0;
			const slotName = () => `slot${nextSlot++}`;

			// A produced exec.action() output artifact always mounts, when
			// later consumed as an input, at its *own output slot name*
			// (e.g. "directory"/"out3") — never at whatever path it was
			// *declared* with (confirmed against the engine's own
			// normalize_graph_artifact()/nest_file()/nest_directory() in
			// crates/imp-engine/src/spike.rs, which key the artifact's CAS
			// tree structure by output-slot name). So a later edge can't
			// just list an earlier edge's output as an `inputs:` entry and
			// expect it to reappear at ninja's own hardcoded
			// buildDirPath-relative path — each edge has to explicitly
			// reconstruct `$bdir` first, `cp`-ing configure's own scaffolding
			// plus every prior edge's output from wherever exec.path() says
			// it actually landed to the exact relative path ninja's command
			// text expects. This is the real replacement for legacy
			// mergeDigests()'s accumulation (see this module's own
			// docstring) — tracked here as `{destPath, binding}` pairs
			// rather than bare bindings so each reconstruction step knows
			// both where to copy *from* (exec.path(binding)) and *to*
			// (destPath).
			function reconstructBuildDirCmds(priorOutputs) {
				const configureSrc = exec.path(input.configureDirectory);
				return [
					`mkdir -p '${spec.buildDirPath}'`,
					`cp -r '${configureSrc}'/. '${spec.buildDirPath}'/`,
					...priorOutputs.map(({ destPath, binding }) => {
						const src = exec.path(binding);
						return `mkdir -p "$(dirname '${destPath}')" && cp '${src}' '${destPath}'`;
					}),
				];
			}

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
					// clang/cc/c++/ar). A real gap for a CMake project
					// invoking some other absolute-pathed host tool from its
					// build commands — tracked as a follow-up alongside this
					// migration's other known gaps (zig-as-CMake-compiler,
					// CMAKE_RANLIB).
					if (GCC_GRAPH_TOOL_NAMES.has(name)) {
						edgeTools.push(gccGraphToolSpec(spec.toolchain.version, name));
						continue;
					}
					if (name === "cmake") {
						edgeTools.push(cmakeGraphToolSpec(spec.cmakeToolchain.version));
						continue;
					}
					throw new Error(
						`cmake edge needs unsupported host tool '${name}' — only gcc's own clang/cc/c++/ar and cmake itself are resolvable from a graph-native CMake replay right now`,
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
				const restoreCmds = reconstructBuildDirCmds(priorOutputs);
				const cdCommand = `${restoreCmds.join(" && ")} && cd '${spec.buildDirPath}' && ${resolved.command}`;
				const outputNames = destPaths.map(() => slotName());

				const result = await exec.action({
					argv: ["sh", "-c", cdCommand],
					tools: edgeTools,
					inputs: [input.srcs, ...dirInputBindings],
					outputs: Object.fromEntries(
						destPaths.map((p, i) => [outputNames[i], output.file(p)]),
					),
					display: `cmake edge ${outputPaths[0] || edge.rule}`,
				});
				return outputNames.map((name, i) => ({
					destPath: destPaths[i],
					binding: result.outputs[name],
				}));
			}

			let priorOutputs = [];
			for (const wave of waves) {
				if (!wave) continue;
				const results = await Promise.all(
					wave.map((edge) => executeEdge(edge, priorOutputs)),
				);
				priorOutputs = [...priorOutputs, ...results.flat()];
			}

			// Final staging pass: reconstructs $bdir one more time (same as
			// every edge above) so its declared outputs — the whole
			// directory plus each exposeOutputs entry — actually exist on
			// disk when this action's script finishes.
			const stageRestoreCmds = reconstructBuildDirCmds(priorOutputs);
			const staged = await exec.action({
				argv: ["sh", "-c", `${stageRestoreCmds.join(" && ")}`],
				tools: baseTools,
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
 * @returns {object} Task handle (no declared outputs — a failing `ctest` invocation fails the task).
 */
export function runCTestTask(
	spec,
	configured,
	ninjaGraph,
	targetNames,
	testNames = [],
) {
	const built = replayCmakeTarget(spec, configured, ninjaGraph, targetNames);
	return task({
		display: `ctest ${spec.path} [${(testNames.length ? testNames : ["all"]).join(",")}]`,
		inputs: {
			directory: built.outputs.directory,
			ctest: nativeTool("ctest"),
			sed: nativeTool("sed"),
			find: nativeTool("find"),
			mkdir: nativeTool("mkdir"),
			cp: nativeTool("cp"),
		},
		async run(exec, input) {
			// built.outputs.directory mounts at its own output slot name
			// ("directory"), not spec.buildDirPath — see
			// reconstructBuildDirCmds()'s docstring in replayCmakeTarget().
			// CTestTestfile.cmake's own baked executable paths are
			// `$oldroot/spec.buildDirPath/...` (rewritten below to
			// `$(pwd)/spec.buildDirPath/...`), so the reconstruction has to
			// land at that exact relative path too, not wherever
			// exec.path() happened to mount the raw artifact.
			const mountedDir = exec.path(input.directory);
			const script =
				"oldroot=$1; mounted=$2; bdir=$3; shift 3; newroot=$(pwd); " +
				'mkdir -p "$bdir" && cp -r "$mounted"/. "$bdir"/ && ' +
				'find "$bdir" -name CTestTestfile.cmake -exec sed -i "s#$oldroot#$newroot#g" {} + ; ' +
				'ctest --test-dir "$bdir" "$@"';
			await exec.action({
				argv: [
					"sh",
					"-c",
					script,
					"cmake-ctest",
					ninjaGraph.sandboxRoot || "",
					mountedDir,
					spec.buildDirPath,
					...ctestNameFilterArgs(testNames),
				],
				tools: [input.ctest, input.sed, input.find, input.mkdir, input.cp],
				display: `ctest ${spec.path}`,
			});
		},
	});
}
