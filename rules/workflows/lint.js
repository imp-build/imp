// The "lint" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// No legacy Rust predecessor ever existed for this goal. odin-package has a
// stub product (odinLintStub, rules/odin/index.js) that throws "not yet
// implemented" rather than silently succeeding — imp lint fails loudly
// for odin-package targets until real lint checks are implemented.

import { goal } from "imp:core";

goal("lint");
