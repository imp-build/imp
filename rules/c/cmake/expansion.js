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
// Known shape gap versus rules/c's ccLibrary()/ccBinary(): the #31
// migration plan's decision 4 wants a discovered CMake target's
// `expand().get(name, BUILD)` usable directly as a raw ccBinary()'s `deps`
// entry, with transitiveArchives/transitiveIncludeDirs exposed the same
// way. expand()'s own get()/all() API (see graph_core.js's
// _graphChildHandle()) only ever returns *one* resolved handle for one
// workflow+facet — there's no way to also hand back plain sibling fields
// (arrays computed at declare time) through that same call, unlike a bare
// JS object ccLibrary() can just return directly. Tracked as issue #67 —
// not solved here.

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
 * a CMakeLists.txt declares, as one keyed expand(). See this module's own
 * docstring for the known raw-ccBinary()-interop gap.
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
