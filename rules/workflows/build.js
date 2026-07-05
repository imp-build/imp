// The "build" goal is seeded by default in HostState::default() (src/spike.rs),
// but its real products live elsewhere: odin-package (rules/odin/index.js),
// cmake-lib/cmake-toolchain (rules/c/cmake/index.js), asset (rules/asset.js),
// stamp-file (rules/gen.js), odin-gen (rules/odin/index.js). This file just
// declares the goal explicitly so it's documented here rather than relying
// solely on the Rust default; goal registration is first-registration-wins,
// so this is a no-op today and stays correct if that default is ever dropped.
//
// The callback resolves each selected target's product itself via
// resolveProduct rather than delegating to dispatchSelection, so it drives
// its own fan-out/await loop directly.

import { goal, resolveProduct } from "imp:core";

export async function buildGoal(selection) {
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

goal("build", buildGoal);
