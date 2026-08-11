// The "build" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// Every built-in ruleset is graph-native and exposes [BUILD] directly today
// (Odin, cmake-lib/cmake-toolchain, asset, stampFile labels, ...), and the
// legacy target()/product() dispatch this goal used to fall back to has been
// retired — a BUILD.js wanting a build-selectable workload now needs a real
// [BUILD] handle. attach(label, "build", fn) (the `build()` sugar in
// imp:core) is a separate, still-supported mechanism and is unaffected.
//
// `build` is cache-only: it builds and warms the task cache, but (now that
// every build product is materialize:false) never leaves files in the
// workspace. Getting real files out of a target is `package`'s job
// (writeWorkspace to dist/), the only goal that still writes.

import { goal, writeWorkspace } from "imp:core";

/** Materialize source-generation graph roots while ordinary builds remain CAS-only. */
export function graphBuildGoal(roots) {
	for (const { result } of roots) {
		if (!result?.generated || typeof result.path !== "string") continue;
		writeWorkspace(result.path, result.generated.digest, { from: result.path });
	}
}

goal("build", undefined, { graph: graphBuildGoal });
