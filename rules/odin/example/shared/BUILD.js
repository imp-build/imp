import { ccLibrary } from "//rules/c";
import { defaultGccGraphToolchain } from "//rules/c/gcc";
import { odinPackage } from "//rules/odin";

// A ccLibrary({ shared: true }) consumed directly by an odinPackage() via
// `foreign import`. Unlike the archive case next door (see
// //rules/odin/example/native), the library is a separate file at run time, so
// the consumer's product is a directory that carries it beside the executable.
// gcc rather than the zig-preferred default — see
// rules/c/graph_example/BUILD.js's own note on #74.
export const lib = ccLibrary({
	shared: true,
	srcs: ["mul.c"],
	toolchain: defaultGccGraphToolchain(),
});

export const app = odinPackage({
	srcs: ["*.odin"],
	deps: [lib],
	toolchain: "dev-2026-03",
});
