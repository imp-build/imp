import { cargoPackage } from "//rules/rust";
import { protoAssets } from "//crates/imp-daemon";
import {
    engineAssets,
    testTar,
    testGzip,
    testGit,
    testCmake,
    testCc,
    testAs,
    testLd,
    testAr,
    testMkdir,
    testNinja,
    testDirname,
    testCp,
    testCtest,
    testFind,
    testSed,
} from "//";

export const imp_engine = cargoPackage({
    deps: [engineAssets, protoAssets],
    testTools: [
        testTar,
        testGzip,
        testGit,
        testCmake,
        testCc,
        testAs,
        testLd,
        testAr,
        testMkdir,
        testNinja,
        testDirname,
        testCp,
        testCtest,
        testFind,
        testSed,
    ],
    workspaceMember: true,
});
