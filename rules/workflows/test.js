// The "test" goal is seeded by default in HostState::default() (src/spike.rs),
// but its real products live elsewhere: odin-test-package (rules/odin/index.js),
// rules-test (rules/imp/test/index.js). This file just declares the goal
// explicitly so it's documented here rather than relying solely on the Rust
// default; goal registration is first-registration-wins, so this is a no-op
// today and stays correct if that default is ever dropped.

import { goal } from "imp:core";

goal("test");
