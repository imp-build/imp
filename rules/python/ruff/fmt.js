// Ruff formatting is an additive extension on the reusable pythonApp label
// factory. Keeping it here makes `python/ruff` the fmt handler's automatic
// provenance; importing this module enables `fmt` without pulling in
// linting, for packages declared before or after the import.
import { FMT } from "imp:core";
import { registerPythonAppHook } from "//rules/python";
import { ruffFmtRoot } from "//rules/python/ruff_graph";

registerPythonAppHook((source) => ({ [FMT]: ruffFmtRoot(source) }));
