import { cargoPackage } from "//rules/rust";
import { protoAssets } from "//crates/imp-daemon";
import { engineAssets, testTar, testGzip, testGit } from "//";

export const imp_engine = cargoPackage({
    deps: [engineAssets, protoAssets],
    testTools: [testTar, testGzip, testGit],
    workspaceMember: true,
});
