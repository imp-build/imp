// The "test" goal is seeded by default in HostState::default() (src/spike.rs).
// Declared explicitly here so it's documented; goal registration is
// first-registration-wins, so this is a no-op today and stays correct if
// that default is ever dropped.
//
// Every built-in ruleset is graph-native and exposes [TEST] directly today
// (Odin, rules-test's rulesTest(), Rust's cargoPackage(), ...). Selected
// [TEST] graph roots execute on their own; no workflow-level callback is
// needed to run them, unlike goals that materialize or aggregate results
// (build, fmt, lint, package). The legacy target()/product() dispatch this
// goal used to fall back to has been retired.
// attach(label, "test", fn) (the `test()` sugar in imp:core) is a separate,
// still-supported mechanism and is unaffected.

import { goal } from "imp:core";

goal("test");
