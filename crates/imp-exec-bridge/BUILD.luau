local cargoPackage = require("@imp/rules/rust").cargo_package
local imp_exec_bridge = cargoPackage({
    workspace_member = true,
})
return { imp_exec_bridge = imp_exec_bridge }
