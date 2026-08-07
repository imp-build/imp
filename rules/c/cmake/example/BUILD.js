import { BUILD, PACKAGE, TEST } from "imp:core";
import { cmakeLib } from "//rules/c/cmake";
import { cmakeProject } from "//rules/c/cmake/expansion";
import { zigToolchain } from "//rules/c/zig";
import { ccBinary, ccLibrary } from "//rules/c";
import { jsSources } from "//rules/js";

// Temporary smoke targets for #31/#62 PR C2 — exercise cmakeProject()'s
// expand()-based discovery end-to-end (real cmake+ninja+ctest subprocesses)
// against this same fixture's CMakeLists.txt, gcc-toolchain-driven. Remove
// once PR C3 lands real expansion-level test coverage in its place.
const graphProject = cmakeProject({
	path: "rules/c/cmake/example",
	buildDir: "build/cmake-graph-example",
});
export const graph_hello_cmake = {
	[BUILD]: graphProject.get("hello_cmake", BUILD),
	[PACKAGE]: graphProject.get("hello_cmake", PACKAGE),
};
export const graph_hello_cmake_main = {
	[BUILD]: graphProject.get("hello_cmake_main", BUILD),
	[TEST]: { unit: graphProject.get("hello_cmake_main", TEST, "unit") },
};

const zig = zigToolchain("0.16.0");

export const hello = cmakeLib({
	compiler: zig,
	cmakeArgs: ["-DCMAKE_BUILD_TYPE=Debug"],
	outputs: ["libhello_cmake.so"],
});
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
