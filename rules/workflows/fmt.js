// Ported from the legacy Rust command src/commands/fmt.rs.
//
// Wires Odin's fmt mechanics (//rules/odin/odinfmt) into the build graph as
// products: `fmt` reformats a package's own sources in place, `format-check`
// verifies they're already formatted without mutating the tree, reachable via
// `//:<pkg>#format-check`.
//
// `goal("fmt")` declares the "fmt" goal explicitly so `imp fmt`
// is documented here rather than relying solely on the host's built-in
// default (HostState::default(), src/spike.rs); goal registration is
// first-registration-wins, so this is a no-op if the host already seeded it,
// and stays correct if that default is ever dropped.
import { odinFmt, odinFormatCheck } from "//rules/odin/odinfmt";
import { goal, product } from "imp:core";

goal("fmt");

export const odinPackageFmt = product("odin-package", "fmt", odinFmt);
export const odinTestPackageFmt = product("odin-test-package", "fmt", odinFmt);
export const odinPackageFormatCheck = product("odin-package", "format-check", odinFormatCheck);
export const odinTestPackageFormatCheck = product("odin-test-package", "format-check", odinFormatCheck);
