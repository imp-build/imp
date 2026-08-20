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

import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { TEST } from "//rules/workflows/test";
import { expand } from "imp:core";
import {
	basename,
	cmakeProjectSpec,
	configureCmakeProject,
	correlateCTestEntries,
	replayCmakeTarget,
	runCTestTask,
} from "//rules/c/cmake/graph_replay";
import {
	listNamedCmakeTargets,
	reachableEdgesBounded,
} from "//rules/c/cmake/ninja_graph";

// ---------------------------------------------------------------------------
// cmakeProject() registry — declaration order, read by
// //rules/c/generate_build's dedup check. Mirrors rules/c/index.js's own
// ccWorkloadSpecs()/rules/rust/index.js's cargoPackageHandles().
// ---------------------------------------------------------------------------

const _cmakeProjectSpecs = [];

export function cmakeProjectSpecs() {
	return _cmakeProjectSpecs.slice();
}

// Pass 1 of create()'s two-pass discovery: for each named target, walk its
// edges bounded against every *other* named target's own final output(s)
// (see reachableEdgesBounded() in ninja_graph.js) and record which of those
// targets it actually references — CMake's own inter-library dependency
// shape, confirmed against a real `build.ninja` (an order-only `||
// libcrypto.a` on a static library's link edge, an implicit `| libssl.a
// libcrypto.a` on an executable's). Returns `Map<targetName, {name,
// outputPaths}[]>` of each target's real cross-target dependencies —
// `outputPaths` is *every* one of the dependency's own (possibly multiple)
// declared outputs this target's edges reference, via `|` or `||` alike (see
// buildTargetDeps()'s own docstring for why both matter: a Windows
// SHARED_LIBRARY dependency's `.dll.a` import library is a real, `|`-only
// link-time need, but its `.dll` — referenced only order-only, `||` — is
// still a real runtime need of the built executable, just one CMake's own
// ninja graph doesn't model as a command-text argument). Exported for direct
// testing — the fake test host can't drive create() itself end-to-end (see
// expansion_test.js's own comment on this).
export function crossTargetDependencies(named, ninjaGraph) {
	const crossDeps = new Map();
	for (const t of named) {
		const targetNames = t.outputs.length > 0 ? t.outputs : [t.name];
		const ownOutputs = new Set(targetNames);
		const boundaryOutputPaths = new Set();
		for (const other of named) {
			if (other.name === t.name) continue;
			for (const o of other.outputs) {
				if (!ownOutputs.has(o)) boundaryOutputPaths.add(o);
			}
		}
		const { boundaries } = reachableEdgesBounded(
			ninjaGraph.edges,
			targetNames,
			boundaryOutputPaths,
		);
		const boundarySet = new Set(boundaries);
		const deps = named
			.filter((other) => other.name !== t.name)
			.filter((other) => other.outputs.some((o) => boundarySet.has(o)))
			.map((other) => ({
				name: other.name,
				outputPaths: other.outputs.filter((o) => boundarySet.has(o)),
			}));
		crossDeps.set(t.name, deps);
	}
	return crossDeps;
}

// Pass 2's minting order: dependencies before dependents, so each target's
// targetDeps entries always reference an already-minted task handle (task()
// calls don't execute at declare time, but replayCmakeTarget() itself reads
// `dep.outputs`/`dep.task` synchronously while building its own `inputs:`).
// CMake's own target graph is a DAG by construction — a real link target
// can't order-only-depend on something that depends back on it — so a
// leftover node after Kahn's algorithm terminates means boundary detection
// itself is wrong, not a valid project shape; surfaced as a clear error
// rather than an undefined handle downstream. Exported for direct testing —
// see crossTargetDependencies()'s own docstring.
export function topoSortTargets(named, crossDeps) {
	const byName = new Map(named.map((t) => [t.name, t]));
	const remainingDeps = new Map(
		named.map((t) => [
			t.name,
			new Set(crossDeps.get(t.name).map((dep) => dep.name)),
		]),
	);
	const ordered = [];
	let progressed = true;
	while (remainingDeps.size > 0 && progressed) {
		progressed = false;
		for (const [name, deps] of remainingDeps) {
			if (deps.size > 0) continue;
			ordered.push(byName.get(name));
			remainingDeps.delete(name);
			for (const other of remainingDeps.values()) other.delete(name);
			progressed = true;
		}
	}
	if (remainingDeps.size > 0) {
		throw new Error(
			`cmake project: cyclic target dependency detected among ${Array.from(remainingDeps.keys()).join(", ")} — not expected from any valid CMakeLists.txt`,
		);
	}
	return ordered;
}

// Builds a target's replayCmakeTarget()/runCTestTask() `targetDeps` argument
// from already-minted handles — shared by both the task-minting pass and
// the runCTestTask() call in the children-building pass below, which needs
// the same shape for the same target.
//
// fileIndices picks out *every* output crossTargetDependencies() found this
// target's own edges referencing — not just the dependency's first declared
// output, and not just one. A CMake SHARED_LIBRARY target on Windows has
// two: the `.dll` itself and a `.dll.a` import library. The import library
// is needed to *link* (confirmed against a real Windows run: an executable
// linking such a library fails with "cannot find ...dll.a" if handed only
// the dependency's file0, which happened to be the `.dll`, not the import
// library the link edge actually references) — but the DLL is *also* needed,
// separately, for the built executable to even launch (confirmed the same
// way: mounting only the import library produces a binary that fails at
// runtime with STATUS_DLL_NOT_FOUND, since replay builds each target into
// its own isolated directory rather than one shared build tree where the
// DLL would already be sitting right there). So every referenced output
// gets mounted, not just whichever one resolves the link command — on a
// single-output dependency (the common case, e.g. any Unix
// STATIC_LIBRARY/SHARED_LIBRARY) that's still just the one index, same as
// before. Exported for direct testing — see crossTargetDependencies()'s own
// docstring on why the fake test host can't drive create() itself
// end-to-end.
export function buildTargetDeps(targetName, named, crossDeps, builtByName) {
	return Object.fromEntries(
		crossDeps.get(targetName).map(({ name: depName, outputPaths }) => {
			const depTarget = named.find((n) => n.name === depName);
			const fileIndices = outputPaths.map((outputPath) => {
				const fileIndex = depTarget.outputs.indexOf(outputPath);
				if (fileIndex === -1) {
					throw new Error(
						`cmake project: '${targetName}' depends on '${depName}' via output '${outputPath}', but that output isn't among '${depName}'s own declared outputs (${depTarget.outputs.join(", ")}) — crossTargetDependencies() and this function have gone out of sync`,
					);
				}
				return fileIndex;
			});
			return [
				depName,
				{
					outputs: depTarget.outputs,
					task: builtByName[depName],
					fileIndices,
				},
			];
		}),
	);
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
		inputs: {
			ninjaGraph: configured.outputs.ninjaGraph,
			sourcePaths: configured.outputs.sourcePaths,
		},
		create({ ninjaGraph, sourcePaths }) {
			const testsByBasename = correlateCTestEntries(ninjaGraph);
			const named = listNamedCmakeTargets(ninjaGraph);
			const crossDeps = crossTargetDependencies(named, ninjaGraph);

			const builtByName = {};
			for (const t of topoSortTargets(named, crossDeps)) {
				const targetNames = t.outputs.length > 0 ? t.outputs : [t.name];
				const targetDeps = buildTargetDeps(
					t.name,
					named,
					crossDeps,
					builtByName,
				);
				builtByName[t.name] = replayCmakeTarget(
					spec,
					configured,
					ninjaGraph,
					targetNames,
					t.outputs,
					targetDeps,
					sourcePaths,
				);
			}

			const children = {};
			for (const cmakeTarget of named) {
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

				const built = builtByName[cmakeTarget.name];
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
										buildTargetDeps(
											cmakeTarget.name,
											named,
											crossDeps,
											builtByName,
										),
										sourcePaths,
									).outputs.units,
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
 * @param {string[]} [opts.extraGlobs=[]] Extra project-relative files to mount
 *   for compiler edges, for inputs that do not use a standard header suffix.
 * @param {Array<object>} [opts.deps=[]] Artifact handles to mount for CMake
 *   configure and replay. CMake arguments define how the project uses them.
 * @param {string[]} [opts.cmakeArgs] Extra `cmake -S -B` arguments.
 * @param {object} [opts.toolchain] `gccGraphToolchain()` result, or the workspace default. zig isn't supported yet — see graph_replay.js's own docstring.
 * @param {boolean} [opts.unsafeSystemPaths=false] Bypass Bootlin's toolchain-wrapper unsafe-path guard (which rejects -I/-isystem/-L flags under /usr/include or /usr/lib) so this project's compile/link steps can use host system packages (e.g. libwebkit2gtk-4.1). Same sysroot and hardening flags as normal, just without that one guard.
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
 * @param {string[]} [opts.linkopts=[]] Link flags downstream targets need to resolve this target's own shared-library dependencies, e.g. pkg-config-derived `-L`/`-l` flags for a `.so` linked against host system packages. CMake's own per-target link flags aren't structurally discoverable any more than its include paths are (see `includeDirs` above) — supplied by the caller for the same reason.
 * @returns {object} `{[BUILD], archive, transitiveArchives, transitiveIncludeDirs, transitiveLinkopts}` — usable directly as a ccLibrary()/ccBinary() `deps` entry.
 * @category target
 */
export function cmakeLibraryDep(project, name, opts = {}) {
	const { includeDirs = [], linkopts = [] } = opts;
	const archive = project.get(name, BUILD);
	return Object.freeze({
		[BUILD]: archive,
		archive,
		transitiveArchives: [archive],
		transitiveIncludeDirs: [...includeDirs],
		transitiveLinkopts: [...linkopts],
	});
}
