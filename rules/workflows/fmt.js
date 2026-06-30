// Migration target for src/commands/fmt.rs
//
// The legacy Rust command walked all Odin files in the workspace and ran
// `odinfmt -w` on each, grouped by directory.
// This should become a goal that invokes odinfmt via exec() on each odin-package target.
//
// Intended shape:
//
//   import { goal } from "imp:core";
//   import { odinfmt } from "//rules/odin";
//
//   export default async function () {
//     // TODO: define a fmt goal that runs odinfmt on all odin-package sources
//     // goal("fmt", { ... });
//   }

// TODO: implement
