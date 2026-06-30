// Migration target for src/commands/package.rs
//
// The legacy Rust command built a content pak, copied game binaries and license
// files into a per-platform dist/ directory, and zipped the result.
// Platforms were passed as CLI arguments; version was also a CLI argument.
//
// Intended shape:
//
//   import { goal, platform } from "imp:core";
//
//   export default async function () {
//     // TODO: define package goals per platform, composing the content-pack
//     //       and binary build products into a distributable zip
//     // goal("package", { ... });
//     // goal("package:windows", { ... });
//     // goal("package:linux", { ... });
//   }

// TODO: implement
