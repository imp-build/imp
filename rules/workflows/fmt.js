// Ported from the legacy Rust command src/commands/fmt.rs.
//
// Wires Odin's fmt mechanics (//rules/odin/odinfmt) into the build graph as
// products: `fmt` reformats a package's own sources in place, `format-check`
// verifies they're already formatted without mutating the tree. `imp fmt
// --check` runs the check variant; `format-check` also stays reachable
// directly via `//:<pkg>#format-check` for scripting.
//
// The "fmt" goal is declared with a callback so `--check` can pick a
// different product (`format-check` instead of `fmt`) per selected target,
// via the general goal-flags mechanism (`goalFlags()`). The callback drives
// its own resolve/fan-out/await loop (resolveProducts) rather than delegating
// to a shared dispatch helper, so every selected target gets checked and
// summarized before any unformatted file turns into a thrown error — a
// single formatter failing to compile shouldn't hide the report for every
// other target.
export {
	odinPackageFmt,
	odinTestPackageFmt,
	odinPackageFormatCheck,
	odinTestPackageFormatCheck,
} from "//rules/odin/odinfmt";
export {
	cargoPackageFmt,
	cargoPackageFormatCheck,
} from "//rules/rust/rustfmt";
export {
	pythonAppFmt,
	pythonAppFormatCheck,
} from "//rules/python/ruff/fmt";
export {
	jsSourcesFmt,
	jsSourcesFormatCheck,
} from "//rules/js/biome/index";
export { fmtGoal } from "//rules/workflows/fmt_goal";
