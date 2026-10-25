local core = require("@imp/core")
return {
	core.test.case("Python Luau setup enables both Ruff products", function()
		local guide = core.read_file("@imp/rules/python/DOC.md")
		local setup = assert(string.match(guide, "## Set up a Luau workspace(.-)## Run goals"))
		local code = assert(string.match(setup, "```lua\n(.-)```"))
		for module in string.gmatch(code, 'require%("([^"]+)"%)') do require(module) end
		local python = require("@imp/rules/python")
		local fmt = require("@imp/rules/workflows/fmt")
		local lint = require("@imp/rules/workflows/lint")
		local app = python.python_app({ base = "rules/python/example", entry_point = "hello.__main__" })
		assert(type(app[fmt.FMT]) == "userdata" and type(app[lint.LINT]) == "userdata")
	end),
}
