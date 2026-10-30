local core = require("@imp/core")
local rules = require("@imp/rules/asset")
local build = require("@imp/rules/workflows/build")
local output = core.output

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

--- Resolve the workspace paths that a files handle selects.
local function selected_paths(files)
	local result = core.task({
		inputs = { files = files },
		outputs = { paths = output.value() },
		run = function(exec, inputs)
			return { paths = exec.paths(inputs.files) }
		end,
	})
	return core.test.resolve(result.outputs.paths)
end

return {
	core.test.case("asset returns source and build graph handles", function()
		local value = rules.asset({ srcs = { "*.luau" } })
		assert(type(value.sources) == "userdata", type(value.sources))
		assert(type(value[build.BUILD]) == "userdata", type(value[build.BUILD]))
	end),
	core.test.case("resource_package exposes its sources as graph files", function()
		local value = rules.resource_package({ srcs = { "*.luau" } })
		assert(type(value.files) == "userdata", type(value.files))
		assert(rawequal(value.files, value.sources))
	end),
	core.test.case("resource_package rejects paths outside the workspace", function()
		for _, options in ipairs({
			{ srcs = { "*.txt" }, path = "../outside" },
			{ srcs = { "*.txt" }, base = "/tmp" },
		}) do
			local text = error_text(rules.resource_package, options)
			assert(string.find(text, "asset paths must stay within the workspace", 1, true), text)
		end
	end),
	core.test.case("asset accepts an explicit source base", function()
		local paths = selected_paths(rules.asset({ base = ".", srcs = { "rules/asset/*.luau" } }).sources)
		assert(table.find(paths, "rules/asset/index.luau"), table.concat(paths, ", "))
		for _, options in ipairs({
			{ base = "rules/asset", srcs = { "*.luau" } },
			{ base = "rules", path = "asset", srcs = { "*.luau" } },
		}) do
			local other = selected_paths(rules.asset(options).sources)
			assert(table.concat(other, ", ") == table.concat(paths, ", "), table.concat(other, ", "))
		end
	end),
}
