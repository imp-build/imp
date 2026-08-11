// The "test" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// Every built-in ruleset is graph-native and exposes [TEST] directly today
// (Odin, rules-test's rulesTest(), Rust's cargoPackage(), ...) rather than
// registering a legacy product here — the callback below only matters for
// targets still using the legacy target()/product() API.
//
// Unlike "run", "test" has no single-target restriction — every selected
// target's registered test product runs. The callback below just delegates
// to the default per-target dispatch, since a goal callback replaces native
// dispatch entirely rather than running alongside it.

import { goal, resolveProducts } from "imp:core";

export async function testGoal(selection) {
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

goal("test", testGoal);
