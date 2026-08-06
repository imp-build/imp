// Ruff linting is an additive extension on the reusable pythonApp label
// factory. Keeping it here makes `python/ruff` the lint handler's automatic
// provenance; importing this module enables `lint` without pulling in
// formatting, for packages declared before or after the import.
import { LINT } from "imp:core";
import { registerPythonAppHook } from "//rules/python";
import { ruffLintRoot } from "//rules/python/ruff_graph";

registerPythonAppHook((source) => ({ [LINT]: ruffLintRoot(source) }));
