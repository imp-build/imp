import { odinTestPackage } from "//rules/odin";
import { lib } from "//rules/odin/example/shared";

// `odin test` compiles and runs in one action, so there is no product to
// carry the library beside — see graphOdinBundle()'s own note on the gap.
export const consumer_tests = odinTestPackage({
	deps: [lib],
	toolchain: "dev-2026-03",
});
