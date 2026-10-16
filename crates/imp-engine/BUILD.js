import { cargoPackage } from "//rules/rust";
import { protoAssets } from "//crates/imp-daemon";
import {
    engineAssets,
    rulesTree,
    luauWorkspace,
    testTar,
    testGzip,
    testGit,
    testCmake,
    testCat,
    testSh,
    testAs,
    testLd,
    testAr,
    testMkdir,
    testNinja,
    testDirname,
    testCp,
    testCtest,
    testSed,
    testSha256sum,
    testCurl,
    testWc,
    testXz,
    testChmod,
    testSleep,
} from "//";

export const imp_engine = cargoPackage({
    // rulesTree and luauWorkspace are test inputs, not build inputs: the
    // loader reads rules from disk, and these tests resolve real rules from
    // tempdir workspaces and load the repository Luau workspace.
    deps: [engineAssets.files, rulesTree.files, luauWorkspace.files, protoAssets.files],
    testTools: [
        testTar,
        testGzip,
        testGit,
        testCmake,
        testCat,
        testSh,
        testAs,
        testLd,
        testAr,
        testMkdir,
        testNinja,
        testDirname,
        testCp,
        testCtest,
        testSed,
        testSha256sum,
        testCurl,
        testWc,
        testXz,
        testChmod,
        testSleep,
    ],
    workspaceMember: true,
});
