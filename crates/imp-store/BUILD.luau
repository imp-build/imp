local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_store = cargoPackage({
	workspace_member = true,
})
return { imp_store = imp_store }
