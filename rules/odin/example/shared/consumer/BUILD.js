import { odinTestPackage } from "//rules/odin";
import { lib } from "//rules/odin/example/shared";

// `odin test` compiles and runs in one action, so there is no product to
// carry the library beside. The rule makes the library loadable another way on
// each platform — see odinTestLibraryPathEnv() (Linux) and odinTestOutArgs()
// (Windows) in //rules/odin.
export const consumer_tests = odinTestPackage({
	deps: [lib],
	toolchain: "dev-2026-03",
});
