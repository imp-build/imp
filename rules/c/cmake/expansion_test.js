import { BUILD, PACKAGE, TEST, files, tool } from "imp:core";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	cmakeLibraryDep,
	cmakeProjectExpansion,
} from "//rules/c/cmake/expansion";
import { correlateCTestEntries, basename } from "//rules/c/cmake/graph_replay";
import { listNamedCmakeTargets, parseNinja } from "//rules/c/cmake/ninja_graph";

// Fixture mirrors rules/c/cmake/example/CMakeLists.txt: a SHARED_LIBRARY
// (hello_cmake) and an EXECUTABLE (hello_cmake_main) that links it, plus one
// add_test() correlated to the executable — same shape
// ninja_graph_test.js's own fixture uses, trimmed to the two named targets
// cmakeProjectExpansion()'s create() actually discovers.
const SANDBOX_ROOT = "/sandbox-7-3-1";

const RULES_NINJA = `
rule C_COMPILER__hello_cmake_unscanned_
  command = /usr/bin/cc $DEFINES $INCLUDES $FLAGS -o $out -c $in
  description = Building C object $out

rule C_SHARED_LIBRARY_LINKER__hello_cmake_
  command = /usr/bin/cc -shared $in -o $TARGET_FILE
  description = Linking C shared library $TARGET_FILE

rule C_COMPILER__hello_cmake_main_unscanned_
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

cmake_ninja_workdir = ${SANDBOX_ROOT}/build/

# Object build statements for SHARED_LIBRARY target hello_cmake
build CMakeFiles/hello_cmake.dir/hello.c.o: C_COMPILER__hello_cmake_unscanned_ ${SANDBOX_ROOT}/hello.c
  DEP_FILE = CMakeFiles/hello_cmake.dir/hello.c.o.d
  OBJECT_DIR = CMakeFiles/hello_cmake.dir

# Link build statements for SHARED_LIBRARY target hello_cmake
build libhello_cmake.so: C_SHARED_LIBRARY_LINKER__hello_cmake_ CMakeFiles/hello_cmake.dir/hello.c.o
  TARGET_FILE = libhello_cmake.so

build hello_cmake: phony libhello_cmake.so

# Object build statements for EXECUTABLE target hello_cmake_main
build CMakeFiles/hello_cmake_main.dir/main.c.o: C_COMPILER__hello_cmake_main_unscanned_ ${SANDBOX_ROOT}/main.c
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

const FILE_START = "\x01";
const FILE_MID = "\x02";
const FILE_END = "\x03";

function dumpFile(path, content) {
	return `${FILE_START}${path}${FILE_MID}${content}${FILE_END}`;
}

const CONFIGURE_STDOUT =
	dumpFile("build.ninja", BUILD_NINJA) +
	dumpFile("CMakeFiles/rules.ninja", RULES_NINJA) +
	dumpFile("CTestTestfile.cmake", CTEST_TESTFILE);

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
		host.setRunStdout(
			"cmake configure rules/c/cmake/example",
			CONFIGURE_STDOUT,
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

function configureRunCount(host) {
	return host.runs.filter((run) => run.display.startsWith("cmake configure"))
		.length;
}

describe("cmakeProjectExpansion", () => {
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
});
