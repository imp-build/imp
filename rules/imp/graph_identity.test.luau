local core = require("@imp/core")

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local file_selection_cases = {}
for _, name in ipairs({ "files", "glob", "builtin_files" }) do
	local constructor = core[name]
	local function add_case(description, run)
		table.insert(file_selection_cases, core.test.case(name .. " " .. description, run))
	end
	add_case("rejects a missing include list", function()
		for _, options in ipairs({ {}, { root = "rules/imp" } }) do
			local text = error_text(constructor, options)
			assert(contains(text, name .. "({ root?, include, exclude? }) requires include glob patterns"), text)
		end
	end)
	add_case("rejects a positional pattern list", function()
		local text = error_text(constructor, { "*.luau" })
		assert(contains(text, name .. "() takes an options table, not a list of patterns"), text)
	end)
	add_case("rejects positional patterns with named include", function()
		local text = error_text(constructor, { "*.js", include = { "*.luau" } })
		assert(contains(text, name .. "() takes an options table, not a list of patterns"), text)
	end)
	add_case("rejects an empty include list", function()
		local text = error_text(constructor, { include = {} })
		assert(contains(text, name .. "({ include }) requires glob patterns"), text)
	end)
	add_case("accepts named glob options", function()
		local handle = constructor({ root = "rules/imp", include = { "*.luau" }, exclude = { "*.test.luau" } })
		assert(type(handle) == "userdata", type(handle))
	end)
end

-- Separate task declarations remain distinct. Reuse a handle to share results.
-- Nested resolution keeps the current test state; it opens no new invocation.
return {
	core.test.suite("file selection arguments", file_selection_cases),
	core.test.suite("graph handles", {
		core.test.case("separate declarations execute independently for each display form", function()
			for _, displays in ipairs({ { "build", "test" }, { "same", "same" }, {} }) do
				local calls = 0
				local function variant(display)
					return core.task({
						display = display,
						inputs = { shared = "constant" },
						outputs = { result = core.output.value() },
						run = function()
							calls += 1
							return { result = calls }
						end,
					})
				end
				local first = variant(displays[1])
				local second = variant(displays[2])
				assert(core.test.resolve(first.outputs.result) == 1)
				assert(core.test.resolve(second.outputs.result) == 2)
				assert(calls == 2)
			end
		end),

		core.test.case("the same display keeps different output declarations distinct", function()
			local calls = 0
			local function variant(outputs)
				return core.task({
					display = "same display",
					inputs = { shared = "constant" },
					outputs = outputs,
					run = function()
						calls += 1
						if outputs.result then
							return { result = calls }
						end
					end,
				})
			end
			local bare = variant({})
			local valued = variant({ result = core.output.value() })
			core.test.resolve(bare)
			assert(core.test.resolve(valued.outputs.result) == 2)
			assert(calls == 2)
		end),

		core.test.case("nested resolution preserves shared results and goal flags", function()
			local installs = 0
			local install = core.task({
				outputs = { done = core.output.value() },
				run = function()
					installs += 1
					return { done = installs }
				end,
			}).outputs.done
			local flag = core.task({
				outputs = { seen = core.output.value() },
				run = function()
					return { seen = core.goal_flags().check }
				end,
			}).outputs.seen
			local outer = core.task({
				inputs = { install = install },
				outputs = { result = core.output.value() },
				run = function(_exec, inputs)
					assert(inputs.install == 1)
					assert(core.test.resolve(install) == 1)
					local seen = core.test.resolve(flag)
					assert(core.goal_flags().check == true)
					return { result = seen }
				end,
			}).outputs.result
			core.test.with_fake_goal_flags({ check = true }, function()
				assert(core.test.resolve(outer) == true)
				assert(installs == 1)
			end)
		end),

		core.test.case("repeated resolution in one case reuses the task result", function()
			local calls = 0
			local output = core.task({
				outputs = { result = core.output.value() },
				run = function()
					calls += 1
					return { result = calls }
				end,
			}).outputs.result
			assert(core.test.resolve(output) == 1)
			assert(core.test.resolve(output) == 1)
			assert(calls == 1)
		end),

		core.test.case("core.test.resolve rejects a value that is not a graph handle", function()
			local text = error_text(core.test.resolve, { nope = true })
			assert(contains(text, "error converting Lua table to userdata"), text)
		end),

		core.test.case("core.test.resolve rejects a handle that is not a task", function()
			local files = core.files({ root = "rules/imp", include = { "*.luau" } })
			local text = error_text(core.test.resolve, files)
			assert(contains(text, "requires a task or task output handle, got files"), text)
		end),

		core.test.case("files() rejects an empty include list", function()
			local text = error_text(core.files, { root = "rules/imp", include = {} })
			assert(contains(text, "files({ include }) requires glob patterns"), text)
		end),
	}),
}
