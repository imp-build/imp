// The "test" goal is seeded by default in HostState::default() (src/spike.rs),
// but its real products live elsewhere: odin-test-package (rules/odin/index.js),
// rules-test (rules/imp/test/index.js). This file just declares the goal
// explicitly so it's documented here rather than relying solely on the Rust
// default; goal registration is first-registration-wins, so this is a no-op
// today and stays correct if that default is ever dropped.
//
// Unlike "run", "test" has no single-target restriction — every selected
// target's registered test product runs. The callback below just delegates
// to the default per-target dispatch, since a goal callback replaces native
// dispatch entirely rather than running alongside it.

import { goal, resolveProducts } from "imp:core";

export async function testGoal(selection) {
    const resolved = selection.flatMap(resolveProducts);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));
    for (const { label, promise } of calls) {
        try {
            await promise;
        } catch (e) {
            throw new Error(`${label}: ${e && e.message ? e.message : e}`);
        }
    }
}

goal("test", testGoal);
