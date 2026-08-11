// The "build" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// Every built-in ruleset is graph-native and exposes [BUILD] directly today
// (Odin, cmake-lib/cmake-toolchain, asset, stampFile labels, ...) rather than
// registering a legacy product here — the callback below only matters for
// targets still using the legacy target()/product() API. It resolves each
// selected target's product itself via resolveProducts, driving its own
// fan-out/await loop directly (the same pattern //rules/workflows/run,
// test, and fmt use).
//
// `build` is cache-only: it builds and warms the task cache, but (now that
// every build product is materialize:false) never leaves files in the
// workspace — so it reports a plain count rather than the on-disk artifact
// paths it used to print. Getting real files out of a target is `package`'s
// job (writeWorkspace to dist/), the only goal that still writes.

import { goal, logInfo, resolveProducts, writeWorkspace } from "imp:core";

export async function buildGoal(selection) {
	const resolved = selection.flatMap(resolveProducts);
	const calls = resolved.map(({ label, fn, handle }) => ({
		label,
		promise: fn(handle),
	}));
	let count = 0;
	for (const { label, promise } of calls) {
		try {
			await promise;
		} catch (e) {
			throw new Error(`${label}: ${e && e.message ? e.message : e}`);
		}
		count++;
	}
	if (count > 0) {
		logInfo(`Built ${count} target${count === 1 ? "" : "s"}`);
	}
}

/** Materialize source-generation graph roots while ordinary builds remain CAS-only. */
export function graphBuildGoal(roots) {
	for (const { result } of roots) {
		if (!result?.generated || typeof result.path !== "string") continue;
		writeWorkspace(result.path, result.generated.digest, { from: result.path });
	}
}

goal("build", buildGoal, { graph: graphBuildGoal });
