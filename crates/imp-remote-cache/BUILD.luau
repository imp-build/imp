local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_remote_cache = cargoPackage({
	workspace_member = true,
})
return { imp_remote_cache = imp_remote_cache }
