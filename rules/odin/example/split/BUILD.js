import { odinPackage, odinTestPackage } from "//rules/odin";
import { jsSources } from "//rules/js";

// Odin compiles a directory as one package, so a test package that globs only
// its own test files gets the other half from the package it shares the
// directory with. Both sets of sources land at the same sandbox path, which is
// what makes `odin test .` see one package rather than a file with undeclared
// names.
export const lib = odinPackage({
	toolchain: "dev-2026-03",
});

export const lib_tests = odinTestPackage({
	deps: [lib],
	toolchain: "dev-2026-03",
});

export const js = jsSources();
