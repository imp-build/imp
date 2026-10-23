local core = require("@imp/core")
local python = require("@imp/rules/python")
require("@imp/rules/python/ruff/fmt")
require("@imp/rules/python/ruff/lint")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
return {
	core.test.case("Ruff facets attach to app and test declarations", function()
		for _, declare in ipairs({ python.python_app, python.python_test }) do
			local target = declare({ base = "rules/python/example" })
			assert(type(target[fmt.FMT]) == "userdata")
			assert(type(target[lint.LINT]) == "userdata")
		end
	end),
}
