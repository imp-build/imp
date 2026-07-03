// The "build" goal is seeded by default in HostState::default() (src/spike.rs),
// but its real products live elsewhere: odin-package (rules/odin/index.js),
// cmake-lib/cmake-toolchain (rules/c/cmake/index.js), asset (rules/asset.js),
// stamp-file (rules/gen.js), odin-gen (rules/odin/index.js). This file just
// declares the goal explicitly so it's documented here rather than relying
// solely on the Rust default; goal registration is first-registration-wins,
// so this is a no-op today and stays correct if that default is ever dropped.

import { goal } from "imp:core";

goal("build");
