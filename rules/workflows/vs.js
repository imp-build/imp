// Migration target for src/commands/vs.rs
//
// The legacy Rust command iterated workspace targets and emitted
// .vs/launch.vs.json, .vs/tasks.vs.json, .vscode/launch.json, and
// .vscode/tasks.json with build and launch configurations for each target
// in debug and release modes.
//
// Intended shape:
//
//   import { goal } from "imp:core";
//
//   export default async function () {
//     // TODO: define a vs goal that generates IDE config files from the
//     //       set of odin-package targets and their build products
//     // goal("vs", { ... });
//   }

// TODO: implement
