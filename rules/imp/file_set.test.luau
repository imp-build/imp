local core = require("@imp/core")
local output = core.output

-- A module-level value. Imp evaluates the module again for each case, so a
-- change in one case is not visible in the next case.
local per_case_state = 0

--- Resolve the sorted workspace-relative paths of `files`.
local function paths_of(files)
	return core.test.resolve(core.task({
		inputs = { files = files },
		outputs = { paths = output.value() },
		run = function(exec, inputs)
			return { paths = exec.paths(inputs.files) }
		end,
	}).outputs.paths)
end

local function has(list, value)
	for _, item in list do
		if item == value then
			return true
		end
	end
	return false
end

return {
	core.test.suite("files", {
		core.test.case("a case may change module state", function()
			per_case_state = 1
			assert(per_case_state == 1)
		end),

		core.test.case("the next case gets a fresh module instance", function()
			assert(per_case_state == 0, tostring(per_case_state))
		end),

		core.test.case("glob() returns a graph handle, not paths", function()
			local files = core.glob({ root = "rules/imp", include = { "*.luau" } })
			assert(type(files) == "userdata", type(files))
		end),

		core.test.case("exec.paths returns workspace-relative strings", function()
			local paths = paths_of(core.glob({ root = "rules/imp", include = { "*.luau" } }))
			assert(#paths > 0)
			assert(type(paths[1]) == "string")
			assert(has(paths, "rules/imp/BUILD.luau"), table.concat(paths, "\n"))
		end),

		core.test.case("glob patterns support double stars", function()
			local paths = paths_of(core.glob({ root = "rules", include = { "**/*.test.luau" } }))
			assert(has(paths, "rules/imp/file_set.test.luau"), table.concat(paths, "\n"))
		end),

		core.test.case("exec.paths is sorted", function()
			local paths = paths_of(core.glob({ root = "rules/imp", include = { "**/*" } }))
			for index = 2, #paths do
				assert(paths[index - 1] < paths[index], paths[index - 1] .. " >= " .. paths[index])
			end
		end),

		core.test.case("exec.paths rejects a handle that is not a files handle", function()
			local ok, err = pcall(
				core.test.resolve,
				core.task({
					inputs = { tool = core.native_tool("sh") },
					outputs = { paths = output.value() },
					run = function(exec, inputs)
						return { paths = exec.paths(inputs.tool) }
					end,
				}).outputs.paths
			)
			assert(not ok, "expected an error")
			assert(string.find(tostring(err), "exec.paths(handle) requires a files handle", 1, true), tostring(err))
		end),

		core.test.case("exact paths are sorted unique existing workspace files", function()
			local paths = paths_of(core.files({
				paths = {
					"rules/imp/file_set.test.luau",
					"rules/imp/BUILD.luau",
					"rules/imp/file_set.test.luau",
					"rules/imp/no-such-exact-input",
				},
			}))
			assert(#paths == 2, table.concat(paths, "\n"))
			assert(paths[1] == "rules/imp/BUILD.luau")
			assert(paths[2] == "rules/imp/file_set.test.luau")
			assert(#paths_of(core.files({ paths = {} })) == 0)
			assert(#paths_of(core.files({ paths = { "rules/imp/no-such-exact-input" } })) == 0)
		end),

		core.test.case("exact paths validate options and dense string lists", function()
			for _, options in ipairs({
				{ paths = "file" },
				{ paths = { 1 } },
				{ paths = { [2] = "file" } },
				{ paths = { [1] = "a", [3] = "b" } },
				{ paths = { name = "file" } },
				{ paths = {}, include = {} },
				{ paths = {}, exclude = {} },
				{ paths = {}, root = "." },
				{ paths = {}, other = true },
			}) do
				local ok, err = pcall(core.files, options)
				assert(not ok and string.find(tostring(err), "files({ paths })", 1, true), tostring(err))
			end
			for _, path in ipairs({
				"",
				"/absolute",
				"../outside",
				"a/../b",
				"./file",
				"a//b",
				"a/",
				"C:/file",
				"a\\b",
				"a\0b",
			}) do
				local ok, err = pcall(core.files, { paths = { path } })
				assert(not ok and string.find(tostring(err), "workspace-relative", 1, true), tostring(err))
			end
			for _, constructor in ipairs({ core.glob, core.builtin_files }) do
				local ok, err = pcall(constructor, { paths = {} })
				assert(not ok and string.find(tostring(err), "core.files", 1, true), tostring(err))
			end
		end),

		core.test.case("exec.paths rejects a plain string", function()
			local ok, err = pcall(
				core.test.resolve,
				core.task({
					outputs = { paths = output.value() },
					run = function(exec)
						return { paths = exec.paths("not-a-fileset") }
					end,
				}).outputs.paths
			)
			assert(not ok, tostring(err))
		end),

		core.test.case("exclude removes matched paths", function()
			local paths = paths_of(core.glob({
				root = "rules/imp",
				include = { "*.luau" },
				exclude = { "*.test.luau" },
			}))
			assert(has(paths, "rules/imp/BUILD.luau"))
			assert(not has(paths, "rules/imp/file_set.test.luau"))
		end),
	}),
}
