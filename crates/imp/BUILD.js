import { cargoPackage } from "//rules/rust";
import { protoAssets } from "//crates/imp-daemon";
import { engineAssets, testTar, testGzip, testGit } from "//";

export const imp = cargoPackage({
    bin: "imp",
    deps: [engineAssets, protoAssets],
    testTools: [testTar, testGzip, testGit],
    workspaceMember: true,
});
