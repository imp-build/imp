local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_execution = cargoPackage({
	workspace_member = true,
})
return { imp_execution = imp_execution }
