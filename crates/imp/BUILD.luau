local cargoPackage = require("@imp/rules/rust").cargo_package
local protoAssets = require("@workspace/crates/imp-daemon/BUILD").protoAssets
local testTar = require("@workspace/BUILD").testTar
local testGzip = require("@workspace/BUILD").testGzip
local testGit = require("@workspace/BUILD").testGit
local imp = cargoPackage({
	bin = "imp",
	deps = { protoAssets.files },
	test_tools = { testTar, testGzip, testGit },
	workspace_member = true,
})
return { imp = imp }
