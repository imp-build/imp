import { BUILD, PACKAGE, TEST } from "imp:core";
import { cmakeProject } from "//rules/c/cmake";
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

export const raw_hello = ccLibrary({
	srcs: ["hello.c"],
	toolchain: zig,
});
export const raw_main = ccBinary({
	srcs: ["main.c"],
	deps: [raw_hello],
	toolchain: zig,
});
export const js = jsSources({ base: "rules/c/cmake/example" });
