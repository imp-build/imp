local cargoPackage = require("@imp/rules/rust").cargo_package
local resourcePackage = require("@imp/rules/asset").resource_package
local protoAssets = resourcePackage({
	srcs = { "proto/**" },
})

local imp_daemon = cargoPackage({
	workspace_member = true,
	deps = { protoAssets.files },
})
return { protoAssets = protoAssets, imp_daemon = imp_daemon }
