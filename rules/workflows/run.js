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
// The callback below fully owns the goal: it validates the selection first,
// rejecting a multi-target run with exactly one error naming every offender
// (instead of one error per target, which is what happened when this check
// lived inside odinRun itself, since each selected target got its own
// dispatch task) — then dispatches to the selected target's product itself,
// since a goal callback replaces native per-target dispatch entirely.

import { goal, resolveProduct } from "imp:core";

export function requireSingleOdinPackage(selection) {
    const targets = selection.filter(t => t.kind === "odin-package");
    if (targets.length > 1) {
        throw new Error(`run requires a single target, got ${targets.length}: ${targets.map(t => t.address).join(", ")}`);
    }
}

export async function runGoal(selection) {
    requireSingleOdinPackage(selection);
    const resolved = selection.map(resolveProduct);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));
    for (const { label, promise } of calls) {
        try {
            await promise;
        } catch (e) {
            throw new Error(`${label}: ${e && e.message ? e.message : e}`);
        }
    }
}

goal("run", runGoal);
