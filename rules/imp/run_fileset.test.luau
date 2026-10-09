local core = require("@imp/core")
local output = core.output

--- A task that runs `script` with `files` staged as action inputs and
--- returns the exit code.
local function staged(files, script)
	return core.task({
		inputs = { files = files },
		outputs = { code = output.value() },
		run = function(exec, inputs)
			local result = exec.action({
				argv = { "sh", "-c", ": > marker; " .. script },
				inputs = inputs.files and { inputs.files } or {},
				allow_failure = true,
				outputs = { marker = output.file("marker") },
			})
			return { code = result.exit_code }
		end,
	}).outputs.code
end

return {
	core.test.suite("exec.action with file inputs", {
		core.test.case("stages glob files into the sandbox", function()
			local files = core.glob({ root = "rules/imp", include = { "BUILD.luau" } })
			assert(core.test.resolve(staged(files, "test -f rules/imp/BUILD.luau")) == 0)
		end),

		core.test.case("stages only the matched files", function()
			local files = core.glob({ root = "rules/imp", include = { "BUILD.luau" } })
			assert(core.test.resolve(staged(files, "test -f rules/imp/file_set.test.luau")) ~= 0)
		end),

		core.test.case("accepts an empty input list", function()
			assert(core.test.resolve(staged(nil, "true")) == 0)
		end),
	}),
}
