import { cargoPackage } from "//rules/rust";
import { protoAssets } from "//crates/imp-daemon";
import { engineAssets, testTar, testGzip, testGit } from "//";

export const imp = cargoPackage({
    bin: "imp",
    // engineAssets is still needed: this sandbox compiles imp-engine from
    // source, and its loader.rs include_str!s imp_core.js. rules/** is what
    // came off — nothing embeds it any more.
    deps: [engineAssets.files, protoAssets.files],
    testTools: [testTar, testGzip, testGit],
    workspaceMember: true,
});
