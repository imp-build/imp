// Odin formatting is implemented as products in the Odin rule set, not as a
// standalone workflow goal:
//
//   - `fmt` product (odin-package, odin-test-package) runs `odinfmt -w` over a
//     package's own sources in the sandbox and writes the formatted files back.
//     The built-in `fmt` goal (GoalProductPolicy::Named("fmt")) dispatches to it,
//     so `imp fmt` works with no extra wiring.
//   - `format-check` product formats in the sandbox and diffs against the input,
//     failing without mutating the tree. Reachable via `//:<pkg>#format-check`.
//
// See rules/odin/index.js (products) and rules/odin/toolchain.js (odinfmtTool).
// This replaces the legacy Rust command in src/commands/fmt.rs.
