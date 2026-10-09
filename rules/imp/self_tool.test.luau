local core = require("@imp/core")
local self_tool = require("@imp/rules/imp/self-tool")
local output = core.output

--- A task that reports whether its actions find `imp` on PATH.
local function find_imp(inputs)
	return core.task({
		inputs = inputs,
		outputs = { found = output.value() },
		run = function(exec)
			local result = exec.action({
				argv = { "sh", "-c", ": > marker; command -v imp" },
				display = "find imp",
				-- Without PATH, sh falls back to a default PATH that can hold an
				-- installed imp. An empty PATH leaves only the declared tools.
				env = { PATH = "" },
				allow_failure = true,
				outputs = { marker = output.file("marker") },
			})
			return { found = result.exit_code == 0 }
		end,
	})
end

return {
	core.test.suite("imp_tool", {
		core.test.case("puts the running imp executable on the action PATH", function()
			assert(core.test.resolve(find_imp({ imp = self_tool.imp_tool }).outputs.found) == true)
		end),

		core.test.case("an action without the tool does not find imp", function()
			assert(core.test.resolve(find_imp({}).outputs.found) == false)
		end),

		core.test.case("a faked action records the imp tool", function()
			core.test.with_fake_run(function(host)
				core.test.resolve(find_imp({ imp = self_tool.imp_tool }))
				assert(#host.runs == 1)
				assert(host.runs[1].tools[1] == "imp", tostring(host.runs[1].tools[1]))
			end)
		end),
	}),
}
