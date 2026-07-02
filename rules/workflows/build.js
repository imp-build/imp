// Migration target for src/commands/build.rs
//
// The legacy Rust command supported build modes (debug, quick, release, shipping, msan, asan),
// direct Odin compilation, jodin (JoltPhysics) integration, and a check command.
// This should become a goal that invokes the build system for the appropriate targets.
//
// Intended shape:
//
//   import { goal, platform } from "imp:core";
//
//   export default async function () {
//     // TODO: define build goals for each mode, delegating to odin-package targets
//     // goal("build", { ... });
//     // goal("build:release", { ... });
//     // goal("check", { ... });
//   }

// TODO: implement
