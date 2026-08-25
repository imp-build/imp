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
//     configure task's output. The task remains target-granular, but C/C++
//     compiler actions receive only their direct workspace source, captured
//     include-like files, and declared extra inputs. Other edge types retain
//     the full project input because Ninja does not describe their runtime
//     reads completely.
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
	file,
	files,
	output,
	packagePath,
	pathsInDigest,
	readFileInDigest,
	task,
} from "imp:core";
import { nativeTool } from "//rules/imp/native-tool";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { isMsvcToolchain } from "//rules/c/msvc";
import { isZigToolchain } from "//rules/c/zig";
import { selectCcToolchain } from "//rules/c/toolchain";
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
	joinAndNormalize,
} from "//rules/c/cmake/ninja_graph";
import { parseCTestTestfile } from "//rules/c/cmake/ctest_testfile";

function resolveCmakeToolchain(toolchain) {
	const resolved = toolchain || defaultCmakeGraphToolchain();
	if (!resolved) {
		throw new Error(
			"cmakeProject() needs a declared CMake default (see //rules/c/cmake/toolchain) or an explicit cmakeToolchain option",
		);
	}
	return resolved;
}

// `toolchain` may be a bare gcc/zig/msvc provider or a platform-indexed
// union (see //rules/c/toolchain's ccToolchainForPlatform()) — selectCcToolchain()
// resolves either to a bare provider. Zig is rejected synchronously here
// (rather than deferring to its own cmakeConfigure(), which also throws)
// to preserve this module's existing declaration-time error UX.
function requireCcToolchain(toolchain) {
	const selected = selectCcToolchain(toolchain) || defaultGccGraphToolchain();
	if (!selected) {
		throw new Error(
			"cmakeProject() needs an explicit gcc or msvc toolchain, or a declared gcc default — see //rules/c/gcc and //rules/c/msvc",
		);
	}
	if (isZigToolchain(selected)) {
		throw new Error(
			"cmakeProject() doesn't support a zig toolchain yet — rules/c/zig's zigGraphTool() has no named-cache-backed real path for CMake to bake into build.ninja (see this module's own docstring); pass a gccGraphToolchain() or msvcToolchain() instead",
		);
	}
	return selected;
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
			"**/*.inc",
			"**/*.inl",
			"**/*.ipp",
			"**/*.tpp",
		],
		dirs = [],
		extraGlobs = [],
		deps = [],
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
		extraInput:
			extraGlobs.length > 0
				? files({ root: srcPath, include: extraGlobs })
				: null,
		dirInputs: Object.fromEntries(
			dirs.map((d, i) => [
				`dir${i}`,
				files({ root: `${srcPath}/${d}`, include: ["**/*"] }),
			]),
		),
		deps: [...deps],
		toolchain: requireCcToolchain(toolchain),
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
 *   build dir, an artifact), `.outputs.ninjaGraph` (a plain JSON value), and
 *   `.outputs.sourcePaths` (the exact workspace paths captured by `srcs`).
 */
export function configureCmakeProject(spec) {
	return task({
		display: `cmake configure ${spec.path}`,
		inputs: {
			srcs: spec.srcsInput,
			...spec.dirInputs,
			...Object.fromEntries(spec.deps.map((dep, i) => [`dep${i}`, dep])),
			...spec.toolchain.taskInputs(),
			ninja: nativeTool("ninja"),
			cmakeTool: spec.cmakeToolchain.tool,
			sed: nativeTool("sed"),
		},
		outputs: {
			directory: output.artifact(),
			ninjaGraph: output.value(),
			sourcePaths: output.value(),
		},
		async run(exec, input) {
			const { compilerArgs, env: toolchainEnv } =
				await spec.toolchain.cmakeConfigure(exec, input, {
					unsafeSystemPaths: spec.unsafeSystemPaths,
				});
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
			// the same failure class rules/c/gcc's own
			// gccToolchainCommands() comment documents for direct compiler
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
					...spec.deps.map((_, i) => input[`dep${i}`]),
				],
				env: toolchainEnv,
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
				sourcePaths: exec.paths(input.srcs),
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

const INCLUDE_LIKE_SUFFIXES = [
	".h",
	".hh",
	".hpp",
	".hxx",
	".inc",
	".inl",
	".ipp",
	".tpp",
];

// CMake emits `deps = gcc` for GCC-like compilers and `deps = msvc` for
// cl.exe. Other edges keep the full project source set because their true
// runtime inputs are not recoverable from build.ninja alone.
export function isCmakeCompilerEdge(edge, rules) {
	const deps = rules[edge.rule]?.deps;
	return deps === "gcc" || deps === "msvc";
}

// The path list comes from configure's captured `srcs` input, so generated
// files and build-edge outputs never get mistaken for workspace sources.
export function compilerWorkspaceSources(
	edge,
	rules,
	sandboxRoot,
	sourcePaths,
) {
	if (!isCmakeCompilerEdge(edge, rules)) return [];
	const captured = new Set(sourcePaths);
	return Array.from(
		new Set(
			[...edge.inputs, ...edge.implicitInputs]
				.map((path) => rebasePath(path, sandboxRoot))
				.filter((path) => captured.has(path)),
		),
	).sort();
}

function includeLikeSources(sourcePaths) {
	return sourcePaths
		.filter((path) => {
			const lower = path.toLowerCase();
			return INCLUDE_LIKE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
		})
		.sort();
}

function compilerEdgeKey(edge) {
	return edge.outputs[0] || edge.implicitOutputs[0] || edge.rule;
}

function upFromBuildDir(buildDirPath) {
	const depth = buildDirPath.split("/").filter(Boolean).length;
	return depth === 0 ? "." : Array(depth).fill("..").join("/");
}

// Ninja's `-t deps` format is intentionally simple and stable: an output
// line ends in `: #deps ...`; following indented lines are its dependencies.
// Keep this narrow parser local to CMake's generated scan file.
export function parseNinjaDeps(text) {
	const deps = new Map();
	let output = null;
	for (const line of text.split("\n")) {
		const record = /^(.*): #deps \d+/.exec(line);
		if (record) {
			output = record[1];
			deps.set(output, []);
			continue;
		}
		if (output && /^\s+\S/.test(line)) {
			deps.get(output).push(line.trim().replace(/\\/g, "/"));
			continue;
		}
		if (line.length === 0) output = null;
	}
	return deps;
}

function scanPathToWorkspacePath(path, buildDirPath, sourcePaths) {
	const normalized = path.replace(/\\/g, "/");
	if (sourcePaths.has(normalized)) return normalized;
	if (/^(?:[A-Za-z]:)?\//.test(normalized)) return null;
	const workspacePath = joinAndNormalize(buildDirPath, normalized);
	return sourcePaths.has(workspacePath) ? workspacePath : null;
}

function scanManifest(
	ninjaGraph,
	sourcePaths,
	buildDirPath,
	depsText,
	skipped,
) {
	const sourceSet = new Set(sourcePaths);
	const deps = parseNinjaDeps(depsText || "");
	const manifest = {};
	for (const edge of ninjaGraph.edges) {
		if (!isCmakeCompilerEdge(edge, ninjaGraph.rules)) continue;
		const key = compilerEdgeKey(edge);
		if (skipped.has(key)) {
			manifest[key] = { fallback: skipped.get(key), headers: [] };
			continue;
		}
		const recorded = deps.get(key);
		if (!recorded) {
			manifest[key] = {
				fallback: "Ninja did not report compiler dependencies",
				headers: [],
			};
			continue;
		}
		const directSources = new Set(
			compilerWorkspaceSources(
				edge,
				ninjaGraph.rules,
				ninjaGraph.sandboxRoot,
				sourcePaths,
			),
		);
		const recordedSources = new Set(
			recorded
				.map((path) => scanPathToWorkspacePath(path, buildDirPath, sourceSet))
				.filter(Boolean),
		);
		if (Array.from(directSources).some((path) => !recordedSources.has(path))) {
			manifest[key] = {
				fallback: "Ninja dependency record omitted the direct source",
				headers: [],
			};
			continue;
		}
		manifest[key] = {
			headers: Array.from(recordedSources)
				.filter((path) => !directSources.has(path))
				.sort(),
		};
	}
	return manifest;
}

function isCmakeModuleEdge(edge, rules) {
	return isCmakeCompilerEdge(edge, rules) && Boolean(edge.vars.dyndep);
}

function scannerToolsForEdges(spec, state, ninjaGraph) {
	return Promise.all(
		Array.from(
			new Set(
				ninjaGraph.edges
					.filter((edge) => isCmakeCompilerEdge(edge, ninjaGraph.rules))
					.flatMap((edge) => {
						const resolved = resolveEdgeCommand(
							edge,
							ninjaGraph.rules,
							ninjaGraph.topVars,
							ninjaGraph.sandboxRoot,
							spec.buildDirPath,
						);
						return resolved?.toolNames || [];
					}),
			),
		).map(async (name) => {
			if (!spec.toolchain.resolvesToolName(name)) return null;
			return spec.toolchain.toolSpec(name, state);
		}),
	);
}

/**
 * Run CMake's compiler rules in syntax-only mode once, then return the
 * workspace headers Ninja recorded for each compiler edge. This task sits
 * before expand(), so its value can shape later replay tasks without any
 * action feeding data back into its own cache key.
 */
export function scanCmakeCompilerInputs(spec, configured) {
	return task({
		display: `cmake scan ${spec.path}`,
		inputs: {
			configureDirectory: configured.outputs.directory,
			ninjaGraph: configured.outputs.ninjaGraph,
			sourcePaths: configured.outputs.sourcePaths,
			srcs: spec.srcsInput,
			...(spec.extraInput ? { extra: spec.extraInput } : {}),
			...spec.dirInputs,
			...Object.fromEntries(spec.deps.map((dep, i) => [`dep${i}`, dep])),
			...spec.toolchain.taskInputs(),
			ninja: nativeTool("ninja"),
			sed: nativeTool("sed"),
		},
		outputs: { manifest: output.value() },
		async run(exec, input) {
			const compilerEdges = input.ninjaGraph.edges.filter((edge) =>
				isCmakeCompilerEdge(edge, input.ninjaGraph.rules),
			);
			if (compilerEdges.length === 0) return { manifest: {} };

			const state = await spec.toolchain.resolveState(exec, input);
			const tools = (
				await scannerToolsForEdges(spec, state, input.ninjaGraph)
			).filter(Boolean);
			const ninjaExe = exec.path(input.ninja);
			const sedExe = exec.path(input.sed);
			const scan = await exec.action({
				argv: [
					"sh",
					"-c",
					// Patch only CMake's compiler rules in this action's private copy
					// of the configured tree. Ninja retains its normal depfile or
					// showIncludes parser, and no object file is written.
					"bdir=$1 oldroot=$2 up=$3 ninja=$4 sed=$5 mode=$6; " +
						'cd "$bdir" || exit 0; ' +
						'"$sed" -i "s|$oldroot|$up|g" build.ninja CMakeFiles/rules.ninja 2>/dev/null; ' +
						'if [ "$mode" = msvc ]; then flag=/Zs; else flag=-fsyntax-only; fi; ' +
						'"$sed" -E -i "/^rule (C|CXX)_COMPILER/,/^$/ { /^  command = / s/$/ $flag/ }" CMakeFiles/rules.ninja; ' +
						// Let one Ninja invocation schedule all compiler scans. `sed`
						// is already a configure dependency, so this does not add a
						// host-tool requirement to replay.
						'set -- $("$ninja" -f build.ninja -t targets all | "$sed" -n -E "s/: (C|CXX)_COMPILER.*$//p"); ' +
						'[ "$#" -eq 0 ] || "$ninja" -f build.ninja -k 0 "$@"; ' +
						'"$ninja" -f build.ninja -t deps > .imp-cmake-deps.txt 2>/dev/null; exit 0',
					"cmake-dependency-scan",
					spec.buildDirPath,
					input.ninjaGraph.sandboxRoot,
					upFromBuildDir(spec.buildDirPath),
					ninjaExe,
					sedExe,
					isMsvcToolchain(spec.toolchain) ? "msvc" : "gcc",
				],
				tools: [input.ninja, input.sed, ...tools],
				inputs: [
					input.configureDirectory,
					input.srcs,
					...(spec.extraInput ? [input.extra] : []),
					...Object.keys(spec.dirInputs).map((key) => input[key]),
					...spec.deps.map((_, i) => input[`dep${i}`]),
				],
				env: spec.toolchain.edgeEnv(state),
				outputs: {
					scan: output.file(`${spec.buildDirPath}/.imp-cmake-deps.txt`),
				},
				display: `cmake scan ${spec.path}`,
				allowFailure: true,
			});
			let depsText = "";
			try {
				depsText = readFileInDigest(
					scan.outputs.scan.digest,
					`${spec.buildDirPath}/.imp-cmake-deps.txt`,
				);
			} catch (_) {
				// The action deliberately completes after an individual scanner
				// failure. Missing output becomes an edge-local broad fallback.
			}
			return {
				manifest: scanManifest(
					input.ninjaGraph,
					input.sourcePaths,
					spec.buildDirPath,
					depsText,
					new Map(),
				),
			};
		},
	});
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
 * @param {string[]} [sourcePaths] Exact workspace paths captured by the
 *   configure action's `srcs` input.
 * @param {object} [compilerManifest] Header paths and fallback reasons from
 *   scanCmakeCompilerInputs().
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
	sourcePaths = [],
	compilerManifest = {},
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
	const compilerSources = new Map(
		reached.map((edge) => [
			edge,
			compilerWorkspaceSources(edge, rules, sandboxRoot, sourcePaths),
		]),
	);
	const compilerSourcePaths = Array.from(
		new Set(Array.from(compilerSources.values()).flat()),
	).sort();
	const fallbackHeaderPaths = includeLikeSources(sourcePaths).filter(
		(path) => !compilerSourcePaths.includes(path),
	);
	const compilerHeaders = new Map();
	const compilerInputPlan = {};
	for (const edge of reached) {
		if (!isCmakeCompilerEdge(edge, rules)) continue;
		if (isCmakeModuleEdge(edge, rules)) {
			throw new Error(
				`cmake project '${spec.path}' target '${targetNames.join(",")}' uses C++ module/dyndep edge '${compilerEdgeKey(edge)}'; CMake dependency scanning does not support modules yet`,
			);
		}
		const key = compilerEdgeKey(edge);
		const scanned = compilerManifest[key];
		const fallback = scanned?.fallback || !scanned;
		const headers = fallback ? fallbackHeaderPaths : scanned.headers;
		compilerHeaders.set(edge, headers);
		compilerInputPlan[key] = {
			headers,
			...(fallback
				? { fallback: scanned?.fallback || "no scan manifest" }
				: {}),
		};
	}
	const headerPaths = Array.from(
		new Set(Array.from(compilerHeaders.values()).flat()),
	).sort();
	const compilerSourceInputs = Object.fromEntries(
		compilerSourcePaths.map((path, i) => [`source${i}`, file(path)]),
	);
	const headerInputs = Object.fromEntries(
		headerPaths.map((path, i) => [`header${i}`, file(path)]),
	);
	const sourceInputNames = new Map(
		compilerSourcePaths.map((path, i) => [path, `source${i}`]),
	);
	const headerInputNames = new Map(
		headerPaths.map((path, i) => [path, `header${i}`]),
	);
	const graphDepInputNames = spec.deps.map((_, i) => `graphDep${i}`);

	return task({
		display: `cmake build ${spec.path} [${targetNames.join(",")}]`,
		inputs: {
			configureDirectory: configured.outputs.directory,
			srcs: spec.srcsInput,
			...compilerSourceInputs,
			...headerInputs,
			...(spec.extraInput ? { extra: spec.extraInput } : {}),
			...spec.dirInputs,
			...Object.fromEntries(spec.deps.map((dep, i) => [`graphDep${i}`, dep])),
			...spec.toolchain.taskInputs(),
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
			compilerInputPlan,
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
			const compilerHeaderInputs = new Map(
				Array.from(compilerHeaders.entries()).map(([edge, paths]) => [
					edge,
					paths.map((path) => input[headerInputNames.get(path)]),
				]),
			);
			const graphDepInputs = graphDepInputNames.map((key) => input[key]);
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
			// Memoized per replay task run(), not per edge: even though msvc's
			// own resolveState() is now just a plain-object read off `input`
			// (msvcHostGraphOutput()'s dedicated task node resolves it once
			// per build, not per replay task — see rules/c/msvc's own
			// docstring), every edge in this target still shares the one
			// resolution rather than each redundantly re-reading it (gcc/zig's
			// own resolveState() returns null trivially either way).
			let toolchainStatePromise = null;
			function getToolchainState() {
				if (!toolchainStatePromise) {
					toolchainStatePromise = spec.toolchain.resolveState(exec, input);
				}
				return toolchainStatePromise;
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
					// inside a running task() body. A provider's own toolSpec()
					// (gccGraphToolSpec()/msvcGraphToolSpec(), reached via
					// resolvesToolName()/toolSpec() below) and cmakeGraphToolSpec()
					// are the freshly-constructible, named-cache-backed
					// alternative (see cmakeGraphTool()'s own docstring in
					// //rules/c/cmake/toolchain for why "cmake" — CMAKE_COMMAND
					// baked into a POST_BUILD custom command — needs the exact
					// same treatment as the cc toolchain's own compiler/archiver
					// names). A real gap for a CMake project invoking some other
					// absolute-pathed host tool from its build commands — tracked
					// as a follow-up alongside this migration's other known gap
					// (zig-as-CMake-compiler).
					//
					// ".exe"-suffixed names are handled by each provider's own
					// resolvesToolName() (see e.g. gcc's GCC_GRAPH_TOOL_NAMES,
					// which lists both forms): on Windows, a provider's own
					// cmakeConfigure()-baked compiler paths always carry the
					// suffix, and rewriteToolInvocations() extracts the basename
					// verbatim, extension included. The "cmake" mount's own
					// folder name (from cmakeGraphToolSpec()) is unrelated to
					// this — only its bin dir matters for PATH, and the real
					// binary inside it is "cmake.exe" either way.
					if (name === "cmake" || name === "cmake.exe") {
						edgeTools.push(cmakeGraphToolSpec(spec.cmakeToolchain.version));
						continue;
					}
					if (spec.toolchain.resolvesToolName(name)) {
						edgeTools.push(
							spec.toolchain.toolSpec(name, await getToolchainState()),
						);
						continue;
					}
					throw new Error(
						`cmake edge needs unsupported host tool '${name}' — only the configured cc toolchain's own tool names and cmake itself are resolvable from a graph-native CMake replay right now`,
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
				// See ninja_graph.js's resolveEdgeRspfile() docstring: real
				// ninja writes rspfile_content to rspfile's path before
				// running the command; replay has to do the same thing
				// itself. Written via positional params, not interpolated
				// into the script text, since content is arbitrary
				// (object-file lists, linker flags) and must not be
				// re-parsed as shell syntax. Chunked into multiple argv
				// elements rather than passed as one — confirmed via a
				// standalone repro (an exec.action() writing a single large
				// argv string via `sh -c 'printf "%s" "$1" > f'`) that a
				// single argv element reaching git-bash's sh.exe (an MSYS
				// binary, spawned here as a plain non-MSYS-aware child via
				// Rust's std::process::Command — never through another
				// MSYS/Cygwin parent) silently truncates around 8186 bytes;
				// BoringSSL's crypto target alone needs ~19KB for its object
				// list. The same repro with the identical total content
				// split across many small argv elements instead came through
				// intact, so chunking sidesteps whatever fixed-size buffer
				// MSYS's own non-Cygwin-parent command-line reparsing uses,
				// while staying far under Windows' own ~32K total
				// command-line limit for any realistic object/library list.
				const RSPFILE_CHUNK_SIZE = 4000;
				function chunkRspfileContent(content) {
					const chunks = [];
					for (let i = 0; i < content.length; i += RSPFILE_CHUNK_SIZE) {
						chunks.push(content.slice(i, i + RSPFILE_CHUNK_SIZE));
					}
					return chunks;
				}
				const cdCommand = resolved.rspfile
					? `cd '${spec.buildDirPath}' && { rsp=$1; shift; : > "$rsp"; for chunk; do printf '%s' "$chunk" >> "$rsp"; done; } && ${resolved.command}`
					: `cd '${spec.buildDirPath}' && ${resolved.command}`;
				const shArgv = resolved.rspfile
					? [
							"sh",
							"-c",
							cdCommand,
							"cmake-rsp",
							resolved.rspfile.path,
							...chunkRspfileContent(resolved.rspfile.content),
						]
					: ["sh", "-c", cdCommand];
				const outputNames = destPaths.map((_, i) => `out${i}`);

				const compilerInputs = compilerSources
					.get(edge)
					.map((path) => input[sourceInputNames.get(path)]);
				const edgeInputs =
					isCmakeCompilerEdge(edge, rules) && sourcePaths.length > 0
						? [
								...compilerInputs,
								...compilerHeaderInputs.get(edge),
								...(spec.extraInput ? [input.extra] : []),
								...dirInputBindings,
								input.configureDirectory,
								...graphDepInputs,
								...priorOutputs,
								...boundaryInputs,
							]
						: [
								input.srcs,
								...dirInputBindings,
								input.configureDirectory,
								...graphDepInputs,
								...priorOutputs,
								...boundaryInputs,
							];

				const fallback = compilerInputPlan[compilerEdgeKey(edge)]?.fallback;
				const result = await exec.action({
					argv: shArgv,
					tools: edgeTools,
					inputs: edgeInputs,
					env: spec.toolchain.edgeEnv(await getToolchainState()),
					outputs: Object.fromEntries(
						destPaths.map((p, i) => [outputNames[i], output.file(p)]),
					),
					display: `cmake edge ${outputPaths[0] || edge.rule}${fallback ? ` [broad input fallback: ${fallback}]` : ""}`,
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
				inputs: [
					input.configureDirectory,
					...graphDepInputs,
					...priorOutputs,
					...boundaryInputs,
				],
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
 * @param {string[]} [sourcePaths] Forwarded to replayCmakeTarget().
 * @param {object} [compilerManifest] Forwarded to replayCmakeTarget().
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
	sourcePaths = [],
	compilerManifest = {},
) {
	const built = replayCmakeTarget(
		spec,
		configured,
		ninjaGraph,
		targetNames,
		[],
		targetDeps,
		sourcePaths,
		compilerManifest,
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
