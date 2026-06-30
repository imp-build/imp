// Migration target for src/commands/test.rs
//
// The legacy Rust command built jodin, compiled all test packages with
// -build-mode:test, ran each binary, and reported pass/fail counts.
// Also supported integration tests (test_main target) and kcov coverage.
//
// Intended shape:
//
//   import { goal } from "imp:core";
//
//   export default async function () {
//     // TODO: define test and integration-test goals that build odin-package
//     //       targets in test mode and run their output binaries
//     // goal("test", { ... });
//     // goal("test:integration", { ... });
//     // goal("coverage", { ... });
//   }

// TODO: implement
