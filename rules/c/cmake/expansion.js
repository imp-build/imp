// Graph-native CMake project discovery (issue #31/#62): one expand() per
// cmakeProject() call, keyed by CMake target name — replaces the legacy
// discoverCmakeLabels()'s "re-run configure+parse on every call" behavior
// with real expand()-level memoization (configure only actually runs once
// per distinct resolved input fingerprint, however many targets get
// selected across however many goals).
//
// Reuses graph_replay.js's configureCmakeProject()/replayCmakeTarget()/
// runCTestTask()/correlateCTestEntries() unchanged — this file only adds
// the per-target discovery loop (listNamedCmakeTargets(), test
// correlation) and expand() wiring around them.
//
// Raw ccLibrary()/ccBinary() interop (issue #67): a discovered CMake
// target's `expand().get(name, BUILD)` is a bare resolved handle, unlike a
// raw ccLibrary() result which also carries transitiveArchives/
// transitiveIncludeDirs. expand()'s own get()/all() (see graph_core.js's
// _graphChildHandle()) can't hand back extra plain sibling data anyway —
// child data isn't known until the CMake configure task has actually run,
// while ccTask() (rules/c/index.js) needs transitiveIncludeDirs as plain
// strings *synchronously at BUILD.js declare time* (baked into a literal
// `-I` flags string built outside of run()). No engine change closes that
// gap. cmakeLibraryDep() below adapts a discovered target into a `deps`
// entry instead, with a caller-supplied includeDirs list — the same kind
// of manual knowledge a plain `ccLibrary({hdrs})` glob already requires.

import { BUILD, PACKAGE, TEST, expand } from "imp:core";
import {
	basename,
	cmakeProjectSpec,
	configureCmakeProject,
	correlateCTestEntries,
	replayCmakeTarget,
	runCTestTask,
} from "//rules/c/cmake/graph_replay";
import { listNamedCmakeTargets } from "//rules/c/cmake/ninja_graph";

// ---------------------------------------------------------------------------
// cmakeProject() registry — declaration order, read by
// //rules/c/generate_build's dedup check. Mirrors rules/c/index.js's own
// ccWorkloadSpecs()/rules/rust/index.js's cargoPackageHandles().
// ---------------------------------------------------------------------------

const _cmakeProjectSpecs = [];

export function cmakeProjectSpecs() {
	return _cmakeProjectSpecs.slice();
}

/**
 * Discover and build every real CMake target (`add_library`/`add_executable`)
 * a CMakeLists.txt declares, as one keyed expand(). Use cmakeLibraryDep()
 * to consume a discovered target as a raw ccLibrary()/ccBinary() `deps`
 * entry — see this module's own docstring.
 *
 * @param {object} [opts] Same shape as cmakeProjectSpec()'s opts.
 * @returns {object} `{get(cmakeTargetName, workflow, facet?), all(workflow, facet?)}`
 *   — `workflow` one of `BUILD`/`PACKAGE`/`TEST`; `TEST`'s facet is always
 *   `"unit"` (a single ctest run), mirroring rules/rust's own TEST facet
 *   shape for uniformity, even though CMake only ever has the one kind.
 */
export function cmakeProjectExpansion(opts = {}) {
	const spec = cmakeProjectSpec(opts);
	_cmakeProjectSpecs.push(spec);
	const configured = configureCmakeProject(spec);

	return expand({
		display: `expand cmake project ${spec.path}`,
		inputs: { ninjaGraph: configured.outputs.ninjaGraph },
		create({ ninjaGraph }) {
			const testsByBasename = correlateCTestEntries(ninjaGraph);
			const children = {};
			for (const cmakeTarget of listNamedCmakeTargets(ninjaGraph)) {
				const matchedTestNames = new Set();
				if (cmakeTarget.type === "EXECUTABLE") {
					for (const candidate of [cmakeTarget.name, ...cmakeTarget.outputs]) {
						for (const name of testsByBasename.get(basename(candidate)) || []) {
							matchedTestNames.add(name);
						}
					}
				}
				const testNames = Array.from(matchedTestNames);
				const targetNames =
					cmakeTarget.outputs.length > 0
						? cmakeTarget.outputs
						: [cmakeTarget.name];

				const built = replayCmakeTarget(
					spec,
					configured,
					ninjaGraph,
					targetNames,
					cmakeTarget.outputs,
				);
				// A CMake target can list more than one output path, but only
				// the first is exposed as [BUILD]/[PACKAGE] — same "one target,
				// one product" assumption the legacy discoverCmakeLabels()'s
				// own single-child-per-target shape already made.
				const artifact = built.outputs.file0;

				children[cmakeTarget.name] = {
					[BUILD]: artifact,
					[PACKAGE]: artifact,
					...(testNames.length > 0
						? {
								[TEST]: {
									unit: runCTestTask(
										spec,
										configured,
										ninjaGraph,
										targetNames,
										testNames,
									),
								},
							}
						: {}),
				};
			}
			return children;
		},
	});
}

/**
 * Public entry point for a graph-native CMake project — see
 * cmakeProjectExpansion() for the returned `{get, all}` shape.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] Workspace-relative CMakeLists.txt directory. Defaults to the calling BUILD.js's own directory (".").
 * @param {string} [opts.buildDir] Build directory; defaults to `build/<path>`.
 * @param {string[]} [opts.srcs] Source glob CMake configure/replay depends on.
 * @param {string[]} [opts.dirs] Extra directories (e.g. vendored includes) to mount.
 * @param {string[]} [opts.cmakeArgs] Extra `cmake -S -B` arguments.
 * @param {object} [opts.toolchain] `gccGraphToolchain()` result, or the workspace default. zig isn't supported yet — see graph_replay.js's own docstring.
 * @returns {object} `{get(cmakeTargetName, workflow, facet?), all(workflow, facet?)}`.
 * @category target
 */
export function cmakeProject(opts = {}) {
	return cmakeProjectExpansion(opts);
}

/**
 * Adapt a discovered CMake target for use as a raw ccLibrary()/ccBinary()
 * `deps` entry. CMake's own per-target include paths aren't structurally
 * discoverable today (see this module's own docstring) and `expand().get()`
 * is resolved too late for ccTask()'s synchronous include-flag
 * construction anyway, so `includeDirs` must be supplied by the caller.
 *
 * @param {object} project A cmakeProject()/cmakeProjectExpansion() result.
 * @param {string} name CMake target name (as passed to add_library/add_executable).
 * @param {object} [opts]
 * @param {string[]} [opts.includeDirs=[]] Include dirs downstream ccLibrary()/ccBinary() targets need, e.g. the CMake project's own public header directory.
 * @returns {object} `{[BUILD], archive, transitiveArchives, transitiveIncludeDirs}` — usable directly as a ccLibrary()/ccBinary() `deps` entry.
 * @category target
 */
export function cmakeLibraryDep(project, name, opts = {}) {
	const { includeDirs = [] } = opts;
	const archive = project.get(name, BUILD);
	return Object.freeze({
		[BUILD]: archive,
		archive,
		transitiveArchives: [archive],
		transitiveIncludeDirs: [...includeDirs],
	});
}
