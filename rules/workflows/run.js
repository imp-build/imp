// The "run" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// No legacy Rust predecessor ever existed for this goal. Individual rule
// products own execution details: Odin materializes and launches a binary on
// the real workspace, while Python source targets execute sandboxed.
//
// The callback below fully owns the goal: it validates the selection first,
// rejecting anything but one target with one error naming every offender —
// then dispatches to the selected target's product itself,
// since a goal callback replaces native per-target dispatch entirely.

import { goal, resolveProducts } from "imp:core";

export function requireSingleRunnable(selection) {
	if (selection.length !== 1) {
		throw new Error(
			`run requires a single target, got ${selection.length}: ${selection.map((t) => t.address).join(", ")}`,
		);
	}
}

export async function runGoal(selection) {
	requireSingleRunnable(selection);
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle),
	}));
	for (const { label, promise } of calls) {
		try {
			await promise;
		} catch (e) {
			throw new Error(`${label}: ${e && e.message ? e.message : e}`);
		}
	}
}

goal("run", runGoal);
