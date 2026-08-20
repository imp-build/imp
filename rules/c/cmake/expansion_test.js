import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { TEST } from "//rules/workflows/test";
import { files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	buildTargetDeps,
	cmakeLibraryDep,
	cmakeProjectExpansion,
	crossTargetDependencies,
	topoSortTargets,
} from "//rules/c/cmake/expansion";
import {
	basename,
	compilerWorkspaceSources,
	cmakeProjectSpec,
	configureCmakeProject,
	correlateCTestEntries,
	isCmakeCompilerEdge,
	replayCmakeTarget,
} from "//rules/c/cmake/graph_replay";
import { listNamedCmakeTargets, parseNinja } from "//rules/c/cmake/ninja_graph";

// Fixture mirrors rules/c/cmake/example/CMakeLists.txt: a SHARED_LIBRARY
// (hello_cmake) and an EXECUTABLE (hello_cmake_main) that links it, plus one
// add_test() correlated to the executable — same shape
// ninja_graph_test.js's own fixture uses, trimmed to the two named targets
// cmakeProjectExpansion()'s create() actually discovers.
const SANDBOX_ROOT = "/sandbox-7-3-1";

// Matches cmakeProjectSpec()'s default buildDirPath for path:
// "rules/c/cmake/example" below.
const CONFIGURE_BUILD_DIR = "build/rules/c/cmake/example";

const RULES_NINJA = `
rule C_COMPILER__hello_cmake_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = /usr/bin/cc $DEFINES $INCLUDES $FLAGS -o $out -c $in
  description = Building C object $out

rule C_SHARED_LIBRARY_LINKER__hello_cmake_
  command = /usr/bin/cc -shared $in -o $TARGET_FILE
  description = Linking C shared library $TARGET_FILE

rule C_COMPILER__hello_cmake_main_unscanned_
  depfile = $DEP_FILE
  deps = gcc
  command = /usr/bin/cc $DEFINES $INCLUDES $FLAGS -o $out -c $in
  description = Building C object $out

rule C_EXECUTABLE_LINKER__hello_cmake_main_
  command = /usr/bin/cc $in -o $TARGET_FILE $LINK_LIBRARIES
  description = Linking C executable $TARGET_FILE

rule RERUN_CMAKE
  command = /usr/bin/cmake --regenerate-during-build -S${SANDBOX_ROOT} -B${SANDBOX_ROOT}/build
  generator = 1
`;

const BUILD_NINJA = `
ninja_required_version = 1.5

include CMakeFiles/rules.ninja

cmake_ninja_workdir = ${SANDBOX_ROOT}/${CONFIGURE_BUILD_DIR}/

# Object build statements for SHARED_LIBRARY target hello_cmake
build CMakeFiles/hello_cmake.dir/hello.c.o: C_COMPILER__hello_cmake_unscanned_ ${SANDBOX_ROOT}/rules/c/cmake/example/hello.c
  DEP_FILE = CMakeFiles/hello_cmake.dir/hello.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

# Link build statements for SHARED_LIBRARY target hello_cmake
build libhello_cmake.so: C_SHARED_LIBRARY_LINKER__hello_cmake_ CMakeFiles/hello_cmake.dir/hello.c.o
  TARGET_FILE = libhello_cmake.so

build hello_cmake: phony libhello_cmake.so

# Object build statements for EXECUTABLE target hello_cmake_main
build CMakeFiles/hello_cmake_main.dir/main.c.o: C_COMPILER__hello_cmake_main_unscanned_ ${SANDBOX_ROOT}/rules/c/cmake/example/main.c
  DEP_FILE = CMakeFiles/hello_cmake_main.dir/main.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake_main.dir

# Link build statements for EXECUTABLE target hello_cmake_main
build hello_cmake_main: C_EXECUTABLE_LINKER__hello_cmake_main_ CMakeFiles/hello_cmake_main.dir/main.c.o | libhello_cmake.so
  TARGET_FILE = hello_cmake_main
  LINK_LIBRARIES = libhello_cmake.so

build all: phony libhello_cmake.so hello_cmake_main

build build.ninja: RERUN_CMAKE ${SANDBOX_ROOT}/CMakeLists.txt
`;

const CTEST_TESTFILE = `# CMake generated Testfile for
# Source directory: ${SANDBOX_ROOT}
# Build directory: ${SANDBOX_ROOT}/build
add_test([=[hello_cmake_main_test]=] "${SANDBOX_ROOT}/build/hello_cmake_main")
`;

const CONFIGURE_FILES = {
	[`${CONFIGURE_BUILD_DIR}/build.ninja`]: BUILD_NINJA,
	[`${CONFIGURE_BUILD_DIR}/CMakeFiles/rules.ninja`]: RULES_NINJA,
	[`${CONFIGURE_BUILD_DIR}/CTestTestfile.cmake`]: CTEST_TESTFILE,
};

// Fully fake gcc/cmake toolchains, sidestepping gccGraphToolchain()'s/
// cmakeGraphToolchain()'s real download+install task chains — see
// rules/c/index_test.js's own fakeGccGraphToolchain() for the same
// technique and rationale.
function fakeGccGraphToolchain(version = "2025.08-1") {
	const binRoot = files({ root: "rules/c/gcc", include: ["**/*"] });
	return { tool: tool(binRoot, { binDirs: ["bin"] }), version };
}

function fakeCmakeGraphToolchain(version = "3.31.0") {
	const binRoot = files({ root: "rules/c/gcc", include: ["**/*"] });
	return { tool: tool(binRoot, { binDirs: ["bin"] }), version };
}

function withCmakeHost(fn) {
	return withFakeToolchainHost(async (host) => {
		host.setRunOutputFiles(
			"cmake configure rules/c/cmake/example",
			"directory",
			CONFIGURE_FILES,
		);
		const expansion = cmakeProjectExpansion({
			path: "rules/c/cmake/example",
			toolchain: fakeGccGraphToolchain(),
			cmakeToolchain: fakeCmakeGraphToolchain(),
		});
		return fn(host, expansion);
	});
}

async function resolveHandles(handles) {
	const roots = handles.map((handle, index) => ({
		address: `root${index}`,
		handleId: handle.__graph_id,
	}));
	return globalThis.__imp_execute_graph_handles(
		JSON.stringify(roots),
		JSON.stringify({}),
	);
}

// The fake host's mocked run() doesn't materialize a real CAS artifact for a
// declared output.file()/output.artifact() — resolving replayCmakeTarget()'s
// or runCTestTask()'s own task still fails on that artifact-shape check
// (same limitation rules/rust/index_test.js's own
// resolveIgnoringArtifactValidation() docstring covers), so tests that only
// need cmakeProjectExpansion()'s create() to run (not a full target build)
// catch that expected failure here rather than treating it as a bug.
async function resolveIgnoringArtifactValidation(handles) {
	try {
		await resolveHandles(handles);
	} catch (error) {
		if (
			!String(error.message || error).includes("must be an action artifact")
		) {
			throw error;
		}
	}
}

// Filtered to the "cmake configure" display prefix specifically:
// configureCmakeProject() also runs a second, separate exec.action() (
// "cmake patch ctest paths ...") whenever the fixture's CTestTestfile.cmake
// is present, to fix up that file's baked-in absolute paths — a distinct
// display, so it doesn't inflate this count.
function configureRunCount(host) {
	return host.runs.filter((run) => run.display.startsWith("cmake configure"))
		.length;
}

describe("cmakeProjectExpansion", () => {
	test("compiler edges select their direct source while other edges stay broad", () => {
		const ninjaGraph = parseNinja(BUILD_NINJA, (path) => {
			if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
			throw new Error(`unexpected include: ${path}`);
		});
		const compiler = ninjaGraph.edges.find((edge) =>
			edge.outputs.includes("CMakeFiles/hello_cmake.dir/hello.c.o"),
		);
		const linker = ninjaGraph.edges.find((edge) =>
			edge.outputs.includes("libhello_cmake.so"),
		);
		const sourcePaths = [
			"rules/c/cmake/example/hello.c",
			"rules/c/cmake/example/hello.h",
			"rules/c/cmake/example/main.c",
			"rules/c/cmake/example/unrelated.json",
		];

		expect(isCmakeCompilerEdge(compiler, ninjaGraph.rules)).toBe(true);
		expect(isCmakeCompilerEdge(linker, ninjaGraph.rules)).toBe(false);
		expect(
			compilerWorkspaceSources(
				compiler,
				ninjaGraph.rules,
				SANDBOX_ROOT,
				sourcePaths,
			),
		).toEqual(["rules/c/cmake/example/hello.c"]);
		expect(
			compilerWorkspaceSources(
				linker,
				ninjaGraph.rules,
				SANDBOX_ROOT,
				sourcePaths,
			),
		).toEqual([]);
	});

	test("runs cmake configure exactly once across multiple get() calls for different targets", () => {
		return withCmakeHost(async (host, expansion) => {
			await resolveIgnoringArtifactValidation([
				expansion.get("hello_cmake", BUILD),
				expansion.get("hello_cmake_main", BUILD),
			]);
			expect(configureRunCount(host)).toBe(1);
		});
	});

	test("runs cmake configure exactly once even when all() is also resolved", () => {
		return withCmakeHost(async (host, expansion) => {
			await resolveIgnoringArtifactValidation([
				expansion.get("hello_cmake", BUILD),
				expansion.all(BUILD),
			]);
			expect(configureRunCount(host)).toBe(1);
		});
	});

	test("compiler replay mounts its source and headers, not the full source set", () => {
		return withCmakeHost(async (host, expansion) => {
			await resolveIgnoringArtifactValidation([
				expansion.get("hello_cmake", BUILD),
			]);
			const compile = host.runs.find(
				(run) =>
					run.display === "cmake edge CMakeFiles/hello_cmake.dir/hello.c.o",
			);
			expect(compile.inputs.length).toBe(3);
			expect(
				compile.inputs
					.map((input) => input.path)
					.filter(Boolean)
					.sort(),
			).toEqual([
				"rules/c/cmake/example/hello.c",
				"rules/c/cmake/example/hello.h",
			]);
		});
	});

	test("hello_cmake (a library with no add_test()) exposes [BUILD]/[PACKAGE]", () => {
		return withCmakeHost(async (_host, expansion) => {
			const build = expansion.get("hello_cmake", BUILD);
			const pkg = expansion.get("hello_cmake", PACKAGE);
			expect(build.__imp_graph_handle).toBe(true);
			expect(pkg.__imp_graph_handle).toBe(true);
		});
	});

	// Whether hello_cmake ends up with a [TEST] key is decided by
	// cmakeProjectExpansion()'s create() from listNamedCmakeTargets() +
	// correlateCTestEntries() alone — asserted directly here against the pure
	// parse/correlate functions rather than through a resolved expand()
	// handle, since the fake host can't materialize configureCmakeProject()'s
	// artifact output (see resolveIgnoringArtifactValidation()'s docstring):
	// any full resolution of an expand() child fails the same
	// "must be an action artifact" way regardless of whether that child's
	// requested workflow/facet actually exists, so that failure mode can't be
	// distinguished from a real "no such facet" error under this harness.
	test("only hello_cmake_main's executable target correlates to the add_test() entry", () => {
		function readInclude(path) {
			if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
			throw new Error(`unexpected include: ${path}`);
		}
		const { targetTypes, edges, rules, topVars } = parseNinja(
			BUILD_NINJA,
			readInclude,
		);
		const sandboxRoot = SANDBOX_ROOT;
		const testsByBasename = correlateCTestEntries({
			ctestText: CTEST_TESTFILE,
			sandboxRoot,
		});
		const named = listNamedCmakeTargets({ targetTypes, edges, rules, topVars });
		const byName = Object.fromEntries(named.map((t) => [t.name, t]));

		expect(testsByBasename.has(basename("hello_cmake_main"))).toBe(true);
		expect(testsByBasename.get(basename("hello_cmake_main"))).toEqual([
			"hello_cmake_main_test",
		]);
		expect(byName.hello_cmake.type).toBe("SHARED_LIBRARY");
		expect(byName.hello_cmake_main.type).toBe("EXECUTABLE");
	});

	test("hello_cmake_main (linked to the correlated ctest entry) exposes a distinct [BUILD] and a [TEST] unit facet", () => {
		return withCmakeHost(async (_host, expansion) => {
			const build = expansion.get("hello_cmake_main", BUILD);
			const testUnit = expansion.get("hello_cmake_main", TEST, "unit");
			expect(build.__imp_graph_handle).toBe(true);
			expect(testUnit.__imp_graph_handle).toBe(true);
			expect(build.__graph_id === testUnit.__graph_id).toBe(false);
		});
	});

	// Regression: task()'s identity key is call site + declared inputs only
	// (see graph_core.js's _graphTaskKey()) — it can't see plain closure
	// arguments. Every discovered target's replayCmakeTarget() call happens
	// from the very same call site and shares every *declared* input
	// (spec/configured/ninjaGraph are identical project-wide), so without
	// targetNames/exposeOutputs folded into replayCmakeTarget()'s own
	// `inputs`, two different targets' calls collide onto the same task
	// node — the second target's [BUILD] silently replays the first
	// target's edges instead of its own. expand().get()'s own handle is a
	// lazy per-key accessor (see the "lazy handle" test below) and stays
	// distinct by construction regardless, so the collision has to be
	// checked one level down, on replayCmakeTarget()'s own return value —
	// the same call expansion.js's create() makes per target.
	test("replayCmakeTarget() gives distinct targets distinct task identities", () => {
		return withFakeToolchainHost(async () => {
			const spec = cmakeProjectSpec({
				path: "rules/c/cmake/example",
				toolchain: fakeGccGraphToolchain(),
				cmakeToolchain: fakeCmakeGraphToolchain(),
			});
			const configured = configureCmakeProject(spec);
			const ninjaGraph = {
				...parseNinja(BUILD_NINJA, (path) => {
					if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
					throw new Error(`unexpected include: ${path}`);
				}),
				sandboxRoot: SANDBOX_ROOT,
			};
			const helloCmake = replayCmakeTarget(
				spec,
				configured,
				ninjaGraph,
				["hello_cmake"],
				["libhello_cmake.so"],
			);
			const helloCmakeMain = replayCmakeTarget(
				spec,
				configured,
				ninjaGraph,
				["hello_cmake_main"],
				["hello_cmake_main"],
			);
			expect(helloCmake.__graph_id === helloCmakeMain.__graph_id).toBe(false);
			expect(
				helloCmake.outputs.file0.__graph_id ===
					helloCmakeMain.outputs.file0.__graph_id,
			).toBe(false);
		});
	});

	// Regression, same task-identity-key mechanism as above: targetDeps is a
	// declared input like targetNames/exposeOutputs, so two calls differing
	// only in targetDeps must not collide onto the same task.
	test("replayCmakeTarget() with targetDeps folds the dependency into task identity", () => {
		return withFakeToolchainHost(async () => {
			const spec = cmakeProjectSpec({
				path: "rules/c/cmake/example",
				toolchain: fakeGccGraphToolchain(),
				cmakeToolchain: fakeCmakeGraphToolchain(),
			});
			const configured = configureCmakeProject(spec);
			const ninjaGraph = {
				...parseNinja(BUILD_NINJA, (path) => {
					if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
					throw new Error(`unexpected include: ${path}`);
				}),
				sandboxRoot: SANDBOX_ROOT,
			};
			const helloCmake = replayCmakeTarget(
				spec,
				configured,
				ninjaGraph,
				["hello_cmake"],
				["libhello_cmake.so"],
			);
			const withoutDeps = replayCmakeTarget(
				spec,
				configured,
				ninjaGraph,
				["hello_cmake_main"],
				["hello_cmake_main"],
			);
			const withDeps = replayCmakeTarget(
				spec,
				configured,
				ninjaGraph,
				["hello_cmake_main"],
				["hello_cmake_main"],
				{
					hello_cmake: {
						outputs: ["libhello_cmake.so"],
						task: helloCmake,
					},
				},
			);
			expect(withoutDeps.__graph_id === withDeps.__graph_id).toBe(false);
		});
	});

	test("replayCmakeTarget() folds extraGlobs and graph deps into task identity", () => {
		return withFakeToolchainHost(async () => {
			const options = {
				path: "rules/c/cmake/example",
				toolchain: fakeGccGraphToolchain(),
				cmakeToolchain: fakeCmakeGraphToolchain(),
			};
			const baseSpec = cmakeProjectSpec(options);
			const configured = configureCmakeProject(baseSpec);
			const extraSpec = cmakeProjectSpec({
				...options,
				extraGlobs: ["**/*.json"],
			});
			const depSpec = cmakeProjectSpec({
				...options,
				deps: [configured.outputs.directory],
			});
			const ninjaGraph = {
				...parseNinja(BUILD_NINJA, (path) => {
					if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
					throw new Error(`unexpected include: ${path}`);
				}),
				sandboxRoot: SANDBOX_ROOT,
			};
			const sourcePaths = [
				"rules/c/cmake/example/hello.c",
				"rules/c/cmake/example/hello.h",
			];
			const base = replayCmakeTarget(
				baseSpec,
				configured,
				ninjaGraph,
				["hello_cmake"],
				[],
				{},
				sourcePaths,
			);
			const extra = replayCmakeTarget(
				extraSpec,
				configureCmakeProject(extraSpec),
				ninjaGraph,
				["hello_cmake"],
				[],
				{},
				sourcePaths,
			);
			const withDep = replayCmakeTarget(
				depSpec,
				configureCmakeProject(depSpec),
				ninjaGraph,
				["hello_cmake"],
				[],
				{},
				sourcePaths,
			);

			expect(base.__graph_id === extra.__graph_id).toBe(false);
			expect(base.__graph_id === withDep.__graph_id).toBe(false);
		});
	});

	// create()'s own two-pass discovery (crossTargetDependencies/
	// topoSortTargets) can't be exercised through a resolved expand() child
	// under this harness — configureCmakeProject()'s `directory: output.
	// artifact()` output fails the fake host's own artifact-shape check
	// (same "must be an action artifact" limitation resolveIgnoringArtifact
	// Validation() covers) as soon as *any* of its outputs are requested,
	// including `ninjaGraph` — which is exactly what expand()'s own `inputs`
	// needs to run create() at all. So, matching this file's existing
	// pattern of testing create()'s pure logic directly (see
	// listNamedCmakeTargets()/correlateCTestEntries() above), these test the
	// two-pass helpers directly against the same parsed fixture.
	test("crossTargetDependencies() finds hello_cmake_main depends on hello_cmake, not the reverse", () => {
		const ninjaGraph = parseNinja(BUILD_NINJA, (path) => {
			if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
			throw new Error(`unexpected include: ${path}`);
		});
		const named = listNamedCmakeTargets(ninjaGraph);
		const crossDeps = crossTargetDependencies(named, ninjaGraph);
		expect(crossDeps.get("hello_cmake_main")).toEqual([
			{ name: "hello_cmake", outputPaths: ["libhello_cmake.so"] },
		]);
		expect(crossDeps.get("hello_cmake")).toEqual([]);
	});

	test("topoSortTargets() orders hello_cmake before hello_cmake_main", () => {
		const ninjaGraph = parseNinja(BUILD_NINJA, (path) => {
			if (path === "CMakeFiles/rules.ninja") return RULES_NINJA;
			throw new Error(`unexpected include: ${path}`);
		});
		const named = listNamedCmakeTargets(ninjaGraph);
		const crossDeps = crossTargetDependencies(named, ninjaGraph);
		const ordered = topoSortTargets(named, crossDeps).map((t) => t.name);
		expect(ordered).toEqual(["hello_cmake", "hello_cmake_main"]);
	});

	test("buildTargetDeps() mounts every one of a dependency's referenced outputs, not just one", () => {
		// A Windows SHARED_LIBRARY target declares *two* outputs — the DLL
		// itself and a `.dll.a` import library. The real build line confirmed
		// against a Windows run references *both* at once — `|
		// libhello_cmake.dll.a || libhello_cmake.dll` — the `.dll.a` as a
		// real (`|`) link input, the `.dll` only order-only (`||`): never an
		// argument in the link command, but still a real requirement of the
		// *built executable*, which needs the DLL physically present to even
		// launch (confirmed the hard way: mounting only the import library
		// produces a binary that fails at runtime with STATUS_DLL_NOT_FOUND,
		// since replay builds each target into its own isolated directory
		// rather than one shared build tree where the DLL would already be
		// sitting right there). Both outputs must end up mounted.
		const rules = `
rule C_COMPILER__hello_cmake_unscanned_
  command = cc -c $in -o $out

rule C_SHARED_LIBRARY_LINKER__hello_cmake_
  command = cc -shared -o $TARGET_FILE $in

rule C_COMPILER__hello_cmake_main_unscanned_
  command = cc -c $in -o $out

rule C_EXECUTABLE_LINKER__hello_cmake_main_
  command = cc $in -o $TARGET_FILE -lhello_cmake
`;
		const build = `
include CMakeFiles/rules.ninja

# Object build statements for SHARED_LIBRARY target hello_cmake
build CMakeFiles/hello_cmake.dir/hello.c.o: C_COMPILER__hello_cmake_unscanned_ hello.c
  DEP_FILE = CMakeFiles/hello_cmake.dir/hello.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

# Link build statements for SHARED_LIBRARY target hello_cmake
build libhello_cmake.dll libhello_cmake.dll.a: C_SHARED_LIBRARY_LINKER__hello_cmake_ CMakeFiles/hello_cmake.dir/hello.c.o
  TARGET_FILE = libhello_cmake.dll
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

build hello_cmake: phony libhello_cmake.dll

# Object build statements for EXECUTABLE target hello_cmake_main
build CMakeFiles/hello_cmake_main.dir/main.c.o: C_COMPILER__hello_cmake_main_unscanned_ main.c
  DEP_FILE = CMakeFiles/hello_cmake_main.dir/main.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake_main.dir

# Link build statements for EXECUTABLE target hello_cmake_main
build hello_cmake_main.exe: C_EXECUTABLE_LINKER__hello_cmake_main_ CMakeFiles/hello_cmake_main.dir/main.c.o | libhello_cmake.dll.a || libhello_cmake.dll
  TARGET_FILE = hello_cmake_main.exe

build hello_cmake_main: phony hello_cmake_main.exe

build all: phony libhello_cmake.dll hello_cmake_main
`;
		const ninjaGraph = parseNinja(build, (path) => {
			if (path === "CMakeFiles/rules.ninja") return rules;
			throw new Error(`unexpected include: ${path}`);
		});
		const named = listNamedCmakeTargets(ninjaGraph);
		const crossDeps = crossTargetDependencies(named, ninjaGraph);

		expect(crossDeps.get("hello_cmake_main")).toEqual([
			{
				name: "hello_cmake",
				outputPaths: ["libhello_cmake.dll", "libhello_cmake.dll.a"],
			},
		]);

		const targetDeps = buildTargetDeps("hello_cmake_main", named, crossDeps, {
			hello_cmake: "FAKE_HELLO_CMAKE_TASK",
		});
		expect(targetDeps.hello_cmake.fileIndices).toEqual([0, 1]);
		expect(targetDeps.hello_cmake.outputs).toEqual([
			"libhello_cmake.dll",
			"libhello_cmake.dll.a",
		]);
		expect(targetDeps.hello_cmake.task).toBe("FAKE_HELLO_CMAKE_TASK");
	});

	test("get() on any target name (including an unknown one) returns a lazy handle without eagerly validating", () => {
		// expand().get()'s own docs (graph_core.js's _graphExpand()) confirm
		// child-key/workflow/facet validation is deferred entirely to
		// resolution time — get() itself never inspects the expansion's
		// actual children, so this call must not throw synchronously even
		// for a target cmakeProjectExpansion() never discovers.
		return withCmakeHost(async (_host, expansion) => {
			const handle = expansion.get("nonexistent_target", BUILD);
			expect(handle.__imp_graph_handle).toBe(true);
		});
	});

	test("all(BUILD) fans out to every discovered target without throwing during construction", () => {
		return withCmakeHost(async (_host, expansion) => {
			const all = expansion.all(BUILD);
			expect(all.__imp_graph_handle).toBe(true);
		});
	});
});

describe("cmakeLibraryDep", () => {
	test("wraps a discovered target's [BUILD] handle as a ccLibrary()-shaped deps entry", () => {
		return withCmakeHost(async (_host, expansion) => {
			const dep = cmakeLibraryDep(expansion, "hello_cmake", {
				includeDirs: ["rules/c/cmake/example"],
			});
			expect(dep[BUILD].__imp_graph_handle).toBe(true);
			expect(dep.archive.__graph_id).toBe(dep[BUILD].__graph_id);
			expect(dep.transitiveArchives).toEqual([dep.archive]);
			expect(dep.transitiveIncludeDirs).toEqual(["rules/c/cmake/example"]);
		});
	});

	test("defaults includeDirs to an empty list", () => {
		return withCmakeHost(async (_host, expansion) => {
			const dep = cmakeLibraryDep(expansion, "hello_cmake");
			expect(dep.transitiveIncludeDirs).toEqual([]);
		});
	});

	test("exposes linkopts as transitiveLinkopts, defaulting to an empty list", () => {
		return withCmakeHost(async (_host, expansion) => {
			const dep = cmakeLibraryDep(expansion, "hello_cmake", {
				linkopts: ["-L/usr/lib/x86_64-linux-gnu", "-lwebkit2gtk-4.1"],
			});
			expect(dep.transitiveLinkopts).toEqual([
				"-L/usr/lib/x86_64-linux-gnu",
				"-lwebkit2gtk-4.1",
			]);
			expect(
				cmakeLibraryDep(expansion, "hello_cmake").transitiveLinkopts,
			).toEqual([]);
		});
	});
});
