local cargoPackage = require("@imp/rules/rust").cargo_package
local protoAssets = require("@workspace/crates/imp-daemon/BUILD").protoAssets
local engineAssets = require("@workspace/BUILD").engineAssets
local rulesTree = require("@workspace/BUILD").rulesTree
local luauWorkspace = require("@workspace/BUILD").luauWorkspace
local testTar = require("@workspace/BUILD").testTar
local testGzip = require("@workspace/BUILD").testGzip
local testGit = require("@workspace/BUILD").testGit
local testCmake = require("@workspace/BUILD").testCmake
local testCat = require("@workspace/BUILD").testCat
local testSh = require("@workspace/BUILD").testSh
local testAs = require("@workspace/BUILD").testAs
local testLd = require("@workspace/BUILD").testLd
local testAr = require("@workspace/BUILD").testAr
local testMkdir = require("@workspace/BUILD").testMkdir
local testNinja = require("@workspace/BUILD").testNinja
local testDirname = require("@workspace/BUILD").testDirname
local testCp = require("@workspace/BUILD").testCp
local testCtest = require("@workspace/BUILD").testCtest
local testSed = require("@workspace/BUILD").testSed
local testSha256sum = require("@workspace/BUILD").testSha256sum
local testCurl = require("@workspace/BUILD").testCurl
local testWc = require("@workspace/BUILD").testWc
local testXz = require("@workspace/BUILD").testXz
local testChmod = require("@workspace/BUILD").testChmod
local testSleep = require("@workspace/BUILD").testSleep
local imp_engine = cargoPackage({
    deps = {engineAssets.files, protoAssets.files},
    test_deps = {rulesTree.files, luauWorkspace.files},
    test_tools = {
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
    },
    workspace_member = true,
})
return { imp_engine = imp_engine }
