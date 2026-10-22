local core = require("@imp/core")
local js = require("@imp/rules/js")
local build = require("@imp/rules/workflows/build")
local run = require("@imp/rules/workflows/run")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
require("@imp/rules/js/biome")
require("@imp/rules/js/biome/lint")
return {
	core.test.case("JS and TS applications export frozen build run and Biome facets", function()
		for _, factory in ipairs({ js.js_app, js.ts_app }) do
			local app = factory({ base = "rules/js/example/app", entry = "src/index.js" })
			assert(table.isfrozen(app))
			for _, slot in ipairs({ build.BUILD, run.RUN, fmt.FMT, lint.LINT }) do assert(type(app[slot]) == "userdata") end
			core.test.with_fake_run(function(host)
				assert(type(core.test.resolve(app[run.RUN])) == "table")
				for _, action in ipairs(host.runs) do assert(not string.find(action.display, "js run", 1, true)) end
			end)
		end
	end),
}
