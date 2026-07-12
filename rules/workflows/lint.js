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
// odin-package keeps its own "lint" product (odinLintStub, rules/odin/index.js)
// registered directly there — it still throws "not yet implemented" and so
// still aborts the goal immediately, same as any other product function that
// throws for a genuine (non-lint) error.

import { cargoClippy } from "//rules/rust/lint";
import { ruffCheck } from "//rules/python/lint";
import { goal, product, resolveProduct, logInfo } from "imp:core";

export async function lintGoal(selection) {
    const resolved = selection.map(resolveProduct);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));

    const results = [];
    for (const { label, promise } of calls) {
        results.push({ label, ...(await promise) });
    }

    for (const { label, output } of results) {
        if (output) logInfo(`${label}:\n${output}`);
    }

    const failed = results.filter((r) => !r.ok);
    logInfo(`lint: ${results.length - failed.length}/${results.length} target(s) clean`);
    if (failed.length > 0) {
        throw new Error(`lint failed: ${failed.map((r) => r.label).join(", ")}`);
    }
}

goal("lint", lintGoal);

export const cargoPackageLint = product("cargo-package", "lint", cargoClippy);
export const pythonAppLint = product("python-app", "lint", ruffCheck);
