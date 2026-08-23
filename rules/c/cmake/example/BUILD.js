import { BUILD } from "//rules/workflows/build";
import { PACKAGE } from "//rules/workflows/package";
import { TEST } from "//rules/workflows/test";
import { cmakeLibraryDep, cmakeProject } from "//rules/c/cmake";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { msvcToolchain } from "//rules/c/msvc";
import { zigGraphToolchain } from "//rules/c/zig";
import { ccBinary, ccLibrary } from "//rules/c";
import { jsSources } from "//rules/js";

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
export const uses_cmake_lib = ccBinary({
	srcs: ["uses_cmake_lib.c"],
	deps: [
		cmakeLibraryDep(hello, "hello_cmake", {
			includeDirs: ["rules/c/cmake/example"],
		}),
	],
	toolchain: defaultGccGraphToolchain(),
});

// Exploratory: MSVC as a native cmakeProject() toolchain on Windows (see
// //rules/c/msvc). Separate buildDir since it shares `path` with `hello`
// above.
const hello_msvc = cmakeProject({
	path: "rules/c/cmake/example",
	buildDir: "build/rules/c/cmake/example-msvc",
	cmakeArgs: ["-DCMAKE_BUILD_TYPE=Debug"],
	toolchain: msvcToolchain(),
});
export const hello_cmake_msvc_main = {
	[BUILD]: hello_msvc.get("hello_cmake_main", BUILD),
};
export const hello_cmake_msvc_cxx_main = {
	[BUILD]: hello_msvc.get("hello_cmake_cxx_main", BUILD),
};

export const js = jsSources({ base: "rules/c/cmake/example" });
