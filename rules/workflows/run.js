// The "run" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// No legacy Rust predecessor ever existed for this goal. odin-package has a
// real product (odinRun, rules/odin/index.js): builds via odinBuild, then
// executes the resulting binary directly against the real workspace
// (sandbox: false, impure: true) — only for packages with a main entrypoint.
//
// The pre-flight callback below runs once per invocation, before any
// per-target dispatch, so a multi-target selection is rejected with exactly
// one error instead of one per target (which is what happened when this
// check lived inside odinRun itself, since each selected target gets its
// own dispatch task).

import { goal } from "imp:core";

export function requireSingleOdinPackage(selection) {
    const targets = selection.filter(t => t.kind === "odin-package");
    if (targets.length > 1) {
        throw new Error(`run requires a single target, got ${targets.length}: ${targets.map(t => t.address).join(", ")}`);
    }
}

goal("run", requireSingleOdinPackage);
