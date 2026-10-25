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

		core.test.case("stages exact paths into the sandbox", function()
			local files = core.files({ paths = { "rules/imp/BUILD.luau" } })
			assert(core.test.resolve(staged(files, "test -f rules/imp/BUILD.luau && test ! -e rules/imp/file_set.test.luau")) == 0)
		end),

		core.test.case("stages separate overlapping glob and exact inputs", function()
			local first = core.files({ root = "rules/imp", include = { "BUILD.luau" } })
			local second = core.files({ paths = { "rules/imp/BUILD.luau", "rules/imp/file_set.test.luau" } })
			local result = core.task({
				inputs = { first = first, second = second },
				outputs = { code = output.value() },
				run = function(exec, inputs)
					local action = exec.action({
						argv = { "sh", "-c", "test -f rules/imp/BUILD.luau && test -f rules/imp/file_set.test.luau" },
						inputs = { inputs.first, inputs.second },
					})
					return { code = action.exit_code }
				end,
			})
			assert(core.test.resolve(result.outputs.code) == 0)
		end),

		core.test.case("fake actions share exact paths and digest captures", function()
			core.test.with_fake_run(function(host)
				local files = core.files({ paths = { "rules/imp/BUILD.luau", "rules/imp/no-such-exact-input" } })
				local result = core.task({
					inputs = { files = files },
					outputs = { paths = output.value(), contents = output.value() },
					run = function(exec, inputs)
						exec.action({ argv = { "unused" }, inputs = { inputs.files } })
						return { paths = exec.paths(inputs.files), contents = core.read_file_in_digest(exec.digest(inputs.files), "rules/imp/BUILD.luau") }
					end,
				})
				local paths = core.test.resolve(result.outputs.paths)
				assert(#paths == 1 and paths[1] == "rules/imp/BUILD.luau")
				assert(string.find(core.test.resolve(result.outputs.contents), "core.test_root()", 1, true))
				assert(#host.runs == 1 and host.runs[1].input_count == 1)
			end)
		end),

		core.test.case("actions require exact files to be declared task inputs", function()
			local files = core.files({ paths = { "rules/imp/BUILD.luau" } })
			local result = core.task({ run = function(exec)
				exec.action({ argv = { "unused" }, inputs = { files } })
			end })
			core.test.with_fake_run(function(host)
				local ok, err = pcall(core.test.resolve, result)
				assert(not ok and string.find(tostring(err), "declared task input", 1, true), tostring(err))
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("actions reject legacy plain input specifications", function()
			local result = core.task({ run = function(exec)
				exec.action({ argv = { "unused" }, inputs = { { kind = "file", path = "rules/imp/BUILD.luau" } } })
			end })
			core.test.with_fake_run(function()
				local ok, err = pcall(core.test.resolve, result)
				assert(not ok, tostring(err))
			end)
		end),

		core.test.case("accepts an empty input list", function()
			assert(core.test.resolve(staged(nil, "true")) == 0)
		end),
	}),
}
