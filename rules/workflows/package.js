// The "package" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// odin-package has a stub product (odinPackageStub, rules/odin/index.js)
// that throws "not yet implemented" rather than silently succeeding —
// imp package fails loudly for odin-package targets. The legacy Rust
// command (src/commands/package.rs, no longer wired into the binary) built
// a content pak, copied game binaries and license files into a per-platform
// dist/ directory, and zipped the result. Platforms and version were CLI
// arguments.
//
// TODO: define the actual packaging products, composing the content-pack
// and binary build products into a distributable zip, e.g.:
//   product("<some-kind>", "package", async (handle) => { ... });

import { goal } from "imp:core";

goal("package");
