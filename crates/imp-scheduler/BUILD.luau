local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_scheduler = cargoPackage({
    workspace_member = true,
})
return { imp_scheduler = imp_scheduler }
