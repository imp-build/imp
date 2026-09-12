import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { TEST } from "//rules/workflows/test";
import { cmakeLibraryDep, cmakeProject } from "//rules/c/cmake";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { msvcToolchain } from "//rules/c/msvc";
import { zigGraphToolchain } from "//rules/c/zig";
import { ccBinary, ccLibrary, ccTest } from "//rules/c";
import { jsSources } from "//rules/js";
import { platformInfo } from "imp:core";

const isWindows = platformInfo().os === "windows";

const zig = zigGraphToolchain("0.16.0");

// gcc-driven, not zig: graph-native cmakeProject() only supports a gcc
// toolchain today (zig-as-CMake-compiler is a documented, deferred gap —
// see rules/c/cmake/graph_replay.js's own docstring). raw_hello/raw_main
// below stay on zig, since graph-native ccLibrary()/ccBinary() do support
// it.
const hello = cmakeProject({
	path: "rules/c/cmake/example",
	cmakeArgs: ["-DCMAKE_BUILD_TYPE=Debug"],
});
export const hello_cmake = {
	[BUILD]: hello.get("hello_cmake", BUILD),
	[PACKAGE]: hello.get("hello_cmake", PACKAGE),
};
export const hello_cmake_main = {
	[BUILD]: hello.get("hello_cmake_main", BUILD),
	[TEST]: { unit: hello.get("hello_cmake_main", TEST, "unit") },
};

// Issue #98: a STATIC_LIBRARY target's archive edge needs ranlib mounted.
export const hello_cmake_static_main = {
	[BUILD]: hello.get("hello_cmake_static_main", BUILD),
	[TEST]: { unit: hello.get("hello_cmake_static_main", TEST, "unit") },
};

// Issue #89: replaying a C++ target rewrites its compile command to the bare
// tool name "c++", which needs its own graph toolchain mount alongside cc/ar.
export const hello_cmake_cxx_main = {
	[BUILD]: hello.get("hello_cmake_cxx_main", BUILD),
};

export const raw_hello = ccLibrary({
	srcs: ["hello.c"],
	toolchain: zig,
});
export const raw_main = ccBinary({
	srcs: ["main.c"],
	deps: [raw_hello],
	toolchain: zig,
});

// Demonstrates issue #67's cmakeLibraryDep(): a raw ccBinary() linking
// directly against a CMake-discovered target. Needs gcc explicitly (raw
// ccLibrary()/ccBinary() default to zig, but hello_cmake was built with
// gcc — see the cmakeProject() comment above).
// hello_cmake is an add_library(... SHARED ...) target, so it belongs in the
// shared bucket — a caller must say so (see cmakeLibraryDep()'s own docs on
// why the CMake target type isn't readable here).
const helloCmakeLib = cmakeLibraryDep(hello, "hello_cmake", {
	includeDirs: ["rules/c/cmake/example"],
	shared: true,
});
export const uses_cmake_lib = ccBinary({
	srcs: ["uses_cmake_lib.c"],
	deps: [helloCmakeLib],
	toolchain: defaultGccGraphToolchain(),
});

// The same consumer, run rather than only built. Its product is a directory
// holding the executable beside libhello_cmake.so, and it is linked with
// -Wl,-rpath,$ORIGIN, so a clean exit here is the evidence that a
// workspace-built shared library actually loads at run time (see the decision
// entry binary-products-carry-shared-libraries). uses_cmake_lib.c has always
// returned 0 only when hello_cmake_add(2, 3) == 5; until this target existed
// nothing ever executed it, which is how the gap stayed open.
export const uses_cmake_lib_test = ccTest({
	srcs: ["uses_cmake_lib.c"],
	deps: [helloCmakeLib],
	toolchain: defaultGccGraphToolchain(),
});

// Exploratory: MSVC as a native cmakeProject() toolchain on Windows (see
// //rules/c/msvc). Separate buildDir since it shares `path` with `hello`
// above. Only declared on Windows: msvcToolchain()'s taskInputs() reach a
// vswhere.exe discovery task with no host-OS guard of its own, so off
// Windows these targets are graph roots only when the graph is walked
// whole and cold, e.g. by `imp generate --check`.
const hello_msvc = isWindows
	? cmakeProject({
			path: "rules/c/cmake/example",
			buildDir: "build/rules/c/cmake/example-msvc",
			cmakeArgs: ["-DCMAKE_BUILD_TYPE=Debug"],
			toolchain: msvcToolchain(),
		})
	: undefined;
export const hello_cmake_msvc_main = isWindows
	? { [BUILD]: hello_msvc.get("hello_cmake_main", BUILD) }
	: undefined;
export const hello_cmake_msvc_cxx_main = isWindows
	? { [BUILD]: hello_msvc.get("hello_cmake_cxx_main", BUILD) }
	: undefined;

// Exercises msvcToolchain()'s commands() (see //rules/c/msvc) through the
// same raw ccLibrary()/ccBinary() path raw_hello/raw_main use with zig
// above — the fixture the "commands() doesn't support ccLibrary()/
// ccBinary() yet" gap needed once cl.exe/lib.exe-flavored structural argv
// translation existed to exercise. Windows-only, same reason as hello_msvc
// above.
export const raw_hello_msvc = isWindows
	? ccLibrary({ srcs: ["hello.c"], toolchain: msvcToolchain() })
	: undefined;
export const raw_main_msvc = isWindows
	? ccBinary({
			srcs: ["main.c"],
			deps: [raw_hello_msvc],
			toolchain: msvcToolchain(),
		})
	: undefined;

export const js = jsSources({ base: "rules/c/cmake/example" });
