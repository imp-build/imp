// Wires cargo clippy (rules/rust/lint) and ruff check (rules/python/lint)
// into the build graph as the "lint" product for their target kinds.
//
// Unlike fmtGoal/testGoal, which fail fast on the first target that throws,
// lintGoal runs every selected target to completion: cargoClippy/ruffCheck
// never throw for a tool-reported lint failure (they call run() with
// allowFailure: true and return { ok, output } instead), so nothing here
// aborts early. Every target's captured output — ANSI codes intact, since
// the underlying tools are invoked with forced color — is printed only after
// every run has finished, followed by a pass/fail summary; the goal then
// fails if any target was unclean.
//
// odin-package keeps its own "lint" product (odinLint, rules/odin/index.js)
// registered directly there — it follows the same allowFailure/{ok, output}
// contract as cargoClippy/ruffCheck, running `odin check -vet`.

export { cargoPackageLint } from "//rules/rust/clippy";
export { pythonAppLint } from "//rules/python/ruff/lint";
export { lintGoal } from "//rules/workflows/lint_goal";
