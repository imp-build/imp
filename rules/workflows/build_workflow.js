// The "build" goal is seeded by default in HostState::default() (src/spike.rs),
// but its real products live elsewhere: odin-package (rules/odin/index.js),
// cmake-lib/cmake-toolchain (rules/c/cmake/index.js), asset (rules/asset.js),
// stamp-file (rules/gen.js), odin-gen (rules/odin/index.js). This file just
// declares the goal explicitly so it's documented here rather than relying
// solely on the Rust default; goal registration is first-registration-wins,
// so this is a no-op today and stays correct if that default is ever dropped.
//
// The callback resolves each selected target's product itself via
// resolveProducts, driving its own fan-out/await loop directly (the same
// pattern run.js/test.js/fmt.js use).
//
// `build` is cache-only: it builds and warms the task cache, but (now that
// every build product is materialize:false) never leaves files in the
// workspace — so it reports a plain count rather than the on-disk artifact
// paths it used to print. Getting real files out of a target is `package`'s
// job (writeWorkspace to dist/), the only goal that still writes.

import { goal, logInfo, resolveProducts } from "imp:core";

export async function buildGoal(selection) {
    const resolved = selection.flatMap(resolveProducts);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));
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

goal("build", buildGoal);
