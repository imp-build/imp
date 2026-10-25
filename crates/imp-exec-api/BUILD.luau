local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_exec_api = cargoPackage({
    workspace_member = true,
})
return { imp_exec_api = imp_exec_api }
