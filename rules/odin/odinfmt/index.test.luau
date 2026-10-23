local core = require("@imp/core")
local odin = require("@imp/rules/odin")
local formatter = require("@imp/rules/odin/odinfmt")
local fmt = require("@imp/rules/workflows/fmt")
return {
	core.test.case("importing odinfmt attaches immutable formatter roots", function()
		local value = odin.odin_package({ base = ".", path = "rules/odin/example" })
		assert(table.isfrozen(value) and type(value[fmt.FMT]) == "userdata")
	end),
	core.test.case("formatter limits invocations to Odin source paths", function()
		core.test.with_fake_toolchain_host(function(host)
			local sources = core.files({ root = "rules/odin/example", include = { "main.odin", "BUILD.js" } })
			local result
			core.test.with_fake_goal_flags({}, function() result = core.test.resolve(formatter.odin_fmt_root({ sources = sources, base = "rules/odin/example" })) end)
			assert(#result.paths == 1 and result.paths[1] == "rules/odin/example/main.odin")
			assert(type(result.sources_digest) == "string" and not result.check.failed)
			local action = host.runs[#host.runs]
			assert(action.argv[#action.argv] == "rules/odin/example/main.odin")
			assert(action.argv[6] == "" or action.argv[6] == "odinfmt.json")
		end)
	end),
	core.test.case("an empty Odin source set requires no formatter action", function()
		core.test.with_fake_toolchain_host(function(host)
			local result
			core.test.with_fake_goal_flags({}, function() result = core.test.resolve(formatter.odin_fmt_root({ sources = core.files({ root = "rules/odin", include = { "DOC.md" } }), base = "rules/odin" })) end)
			assert(#result.paths == 0 and not result.check.failed)
			-- Tool inputs may acquire the formatter, but no format action runs.
			for _, action in ipairs(host.runs) do assert(action.display ~= "odinfmt rules/odin") end
		end)
	end),
}
