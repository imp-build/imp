-- Require this extension before declaring Odin packages for IDE generation.
local odin = require("@imp/rules/odin")
local vs = require("@imp/rules/workflows/vs")
odin.register_odin_package_hook(function(_, metadata)
	return { [vs.VSCODE] = metadata() }
end)
return {}
