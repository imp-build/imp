// Ruff linting registration. Keeping it here makes `python/ruff` the
// product's automatic provenance; importing this module enables `lint`
// without pulling in formatting.
import { product, LINT } from "imp:core";
import { PythonApp } from "//rules/python";
import { ruffCheck } from "//rules/python/lint";
import { RUFF_TOOL } from "//rules/python/ruff_toolchain";

export const pythonAppLint = product(PythonApp, LINT, RUFF_TOOL, ruffCheck);
