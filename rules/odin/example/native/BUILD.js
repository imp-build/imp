import { ccLibrary } from "//rules/c";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { odinTestPackage } from "//rules/odin";

// Issue #100: a raw ccLibrary(), consumed directly by an odinPackage() via
// `foreign import`, not through CMake. gcc rather than the zig-preferred
// default — see rules/c/graph_example/BUILD.js's own note on #74.
export const lib = ccLibrary({
	path: "rules/odin/example/native",
	toolchain: defaultGccGraphToolchain(),
});

export const native_tests = odinTestPackage({
	deps: [lib],
	toolchain: "dev-2026-03",
});
