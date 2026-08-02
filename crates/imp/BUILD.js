import { cargoPackage } from "//rules/rust";
import { protoAssets } from "//crates/imp-daemon";
import { engineAssets, rulesTree, testTar, testGzip, testGit } from "//";

export const imp = cargoPackage({
    bin: "imp",
    // engineAssets is still needed: this sandbox compiles imp-engine from
    // source, and its loader.rs include_str!s imp_core.js. rules/** is what
    // came off — nothing embeds it any more.
    deps: [engineAssets, protoAssets],
    // Runtime-only: nothing here embeds rules/, but the `imp init` tests
    // load the real catalog from disk. testDeps keeps it out of the build
    // inputs, so a rule edit re-runs these tests without rebuilding the
    // release binary.
    testDeps: [rulesTree],
    testTools: [testTar, testGzip, testGit],
    workspaceMember: true,
});
