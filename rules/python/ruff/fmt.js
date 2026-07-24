// Ruff formatting registration. Keeping it here makes `python/ruff` the
// product's automatic provenance; importing this module enables `fmt`
// without pulling in linting.
import { product, FMT } from "imp:core";
import { PythonApp } from "//rules/python";
import { ruffFmt } from "//rules/python/fmt";
import { RUFF_TOOL } from "//rules/python/ruff_toolchain";

export const pythonAppFmt = product(PythonApp, FMT, RUFF_TOOL, ruffFmt, {
	display: "fmt {0}",
	level: "info",
});
