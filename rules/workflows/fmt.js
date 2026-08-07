// Ported from the legacy Rust command src/commands/fmt.rs.
//
// Wires each language's fmt mechanics into the build graph as a single `fmt`
// product per target kind. `imp fmt` reformats a target's own sources in
// place; `imp fmt --check` verifies they're already formatted without
// mutating the tree, by passing `{check: true}` into the same product
// function (see //rules/workflows/fmt_goal.js) rather than dispatching to a
// separately registered product.
//
// The "fmt" goal is declared with a callback so it can drive its own
// resolve/fan-out/await loop (resolveProducts) rather than delegating to a
// shared dispatch helper — every selected target gets checked and
// summarized before any unformatted file turns into a thrown error, so a
// single formatter failing to compile shouldn't hide the report for every
// other target.
//
// Rust's cargoPackage() is graph-native and exposes [FMT] directly (see
// //rules/rust, //rules/rust/workspace_expansion) rather than registering a
// legacy product here.
import "//rules/python/ruff/fmt";
export { ruffFmtRoot } from "//rules/python/ruff_graph";
export { biomeFmtRoot } from "//rules/js/biome/fmt";
export { fmtGoal } from "//rules/workflows/fmt_goal";
