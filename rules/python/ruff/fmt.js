// Ruff formatting registration. Keeping it here makes `python/ruff` the
// products' automatic provenance; importing this module enables `fmt` and
// `format-check` without pulling in linting.
import { product, FMT } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";
import { PythonApp } from "//rules/python";
import { ruffFmt, ruffFormatCheck } from "//rules/python/fmt";
import { RUFF_TOOL } from "//rules/python/ruff_toolchain";

export const pythonAppFmt = product(PythonApp, FMT, RUFF_TOOL, ruffFmt);
export const pythonAppFormatCheck = product(PythonApp, FORMAT_CHECK, RUFF_TOOL, ruffFormatCheck);
