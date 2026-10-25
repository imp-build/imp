local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_logging = cargoPackage({
    workspace_member = true,
})
return { imp_logging = imp_logging }
