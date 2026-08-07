// Wires ruff check (rules/python/lint) into the build graph as the "lint"
// product for its target kind. Rust's cargoPackage() is graph-native and
// exposes [LINT] directly (see //rules/rust, //rules/rust/workspace_expansion)
// rather than registering a legacy product here.
//
// Unlike fmtGoal/testGoal, which fail fast on the first target that throws,
// lintGoal runs every selected target to completion: ruffCheck never throws
// for a tool-reported lint failure (it calls run() with allowFailure: true
// and returns { ok, output, fixSupported, fixApplied, outputDigest } instead),
// so nothing here aborts early. Every target's captured output — ANSI codes
// intact, since the underlying tools are invoked with forced color — is
// printed only after every run has finished, followed by a pass/fail summary;
// the goal then fails if any target was unclean, regardless of whether
// `--fix` also fixed some of it.
//
// odin-package keeps its own "lint" product (odinLint, rules/odin/index.js)
// registered directly there — it follows the same allowFailure/{ok, output,
// ...} contract as ruffCheck, running `odin check -vet` (which has no
// autofix mode, so it always reports fixSupported: false).

import "//rules/python/ruff/lint";
export { ruffLintRoot } from "//rules/python/ruff_graph";
export { lintGoal } from "//rules/workflows/lint_goal";
