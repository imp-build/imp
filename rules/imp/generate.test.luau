local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")
local odin = require("@imp/rules/odin/toolchain")
local odinfmt = require("@imp/rules/odin/odinfmt/toolchain")
local generate_workflow = require("@imp/rules/workflows/generate")

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function root(paths)
	local result = { before = "before" }
	for index, path in ipairs(paths) do
		result[`out{index}`] = { type = "artifact", digest = `digest:{path}`, path = path }
	end
	return { address = "//pkg:gen", result = result }
end

-- These cases port `generate_test.js` to Luau artifact slots and scoped host
-- fakes. The consumer check verifies CAS-only execution and cache reuse.
return {
	core.test.suite("generated_files", {
		core.test.case("resolves to one artifact for each path and the workspace digest", function()
			local handle = generate.generated_files({
				output_paths = { "rules/imp/testdata/lockfile/ruff.json", "rules/imp/testdata/missing.txt" },
				argv = function()
					return { "sh", "-c", "true" }
				end,
			})
			core.test.with_fake_run(function(host)
				local result = core.test.resolve(handle)
				assert(type(result.out1) == "userdata" and type(result.out2) == "userdata")
				assert(type(result.before) == "string" and #result.before > 0)
				assert(#host.runs == 1)
				assert(host.runs[1].display == "generate rules/imp/testdata/lockfile/ruff.json rules/imp/testdata/missing.txt")
				assert(host.runs[1].outputs.out2 == "rules/imp/testdata/missing.txt")
			end)
		end),

		core.test.case("declares tools separately from inputs and keeps check out of the action", function()
			local handle = generate.generated_files({
				display = "test generate",
				tools = { shell = core.native_tool("sh") },
				inputs = { source = core.files({ include = { "rules/imp/testdata/lockfile/ruff.json" } }) },
				output_paths = { "gen/a.txt", "gen/b.txt" },
				argv = function()
					return { "sh", "-c", "true" }
				end,
			})
			local actions = {}
			for _, check in ipairs({ false, true }) do
				core.test.with_fake_goal_flags({ check = check }, function()
					core.test.with_fake_run(function(host)
						core.test.resolve(handle)
						assert(#host.runs == 1)
						local run = host.runs[1]
						assert(run.display == "test generate")
						assert(#run.tools == 1 and run.tools[1] == "sh")
						assert(run.input_count == 1)
						assert(run.outputs.out1 == "gen/a.txt" and run.outputs.out2 == "gen/b.txt")
						assert(run.check == nil)
						table.insert(actions, run)
					end)
				end)
			end
			assert(#actions[1].argv == #actions[2].argv)
			for index, argument in ipairs(actions[1].argv) do
				assert(argument == actions[2].argv[index])
			end
			assert(actions[1].cache == actions[2].cache)
		end),

		core.test.case("accepts a mounted Odin formatter tool", function()
			core.test.with_fake_toolchain_host(function(host)
				odin.odin_toolchain("dev-2026-03", { default = true })
				local formatter = odinfmt.odinfmt_toolchain("dev-2026-03")
				local handle = generate.generated_files({
					display = "test generate with odinfmt",
					tools = { formatter = formatter.tool },
					output_paths = { "gen/a.odin" },
					argv = function(exec, inputs)
						return { odinfmt.bin(exec, inputs.formatter), "-w", "gen/a.odin" }
					end,
				})
				core.test.resolve(handle)
				local found = false
				for _, run in ipairs(host.runs) do
					if run.display == "test generate with odinfmt" then
						found = true
						assert(#run.tools == 1 and run.tools[1] == "odinfmt")
						assert(run.input_count == 0)
						assert(contains(run.argv[1], "/cache/odinfmt-toolchains/dev-2026-03/"))
					end
				end
				assert(found, "generator action was not recorded")
			end)
		end),

		core.test.case("requires output paths and an argv function", function()
			local argv = function()
				return { "true" }
			end
			for _, options in ipairs({ { argv = argv }, { output_paths = {}, argv = argv } }) do
				assert(contains(error_text(generate.generated_files, options), "requires a non-empty output_paths array"))
			end
			local text = error_text(generate.generated_files, { output_paths = { "a" }, argv = { "true" } })
			assert(contains(text, "requires an argv(exec, inputs) function"), text)
		end),

		core.test.case("rejects one name used for a tool and an input", function()
			local tool = core.native_tool("sh")
			local text = error_text(generate.generated_files, {
				tools = { shell = tool },
				inputs = { shell = tool },
				output_paths = { "a" },
				argv = function()
					return { "true" }
				end,
			})
			assert(contains(text, "got the same name in tools and inputs: shell"), text)
		end),

		core.test.case("generated_root_files sorts the artifacts of a root by path", function()
			local files = generate.generated_root_files({
				before = "x",
				out1 = { type = "artifact", digest = "d2", path = "b.txt" },
				out2 = { type = "artifact", digest = "d1", path = "a.txt" },
			})
			assert(#files == 2 and files[1].path == "a.txt" and files[2].digest == "d2")
			local single = generate.generated_root_files({ type = "artifact", digest = "d", path = "one.txt" })
			assert(#single == 1 and single[1].path == "one.txt")
			assert(generate.generated_root_files({ before = "x" }) == nil)
		end),

		core.test.case("rejects an output path with a glob character", function()
			local text = error_text(generate.generated_files, {
				output_paths = { "gen/[a].txt" },
				argv = function()
					return {}
				end,
			})
			assert(contains(text, "output path 'gen/[a].txt' must not contain a glob character"), text)
		end),

		core.test.case("rejects one output path declared twice", function()
			local text = error_text(generate.generated_files, {
				output_paths = { "a", "a" },
				argv = function()
					return {}
				end,
			})
			assert(contains(text, "generated_files() declares the output path 'a' twice"), text)
		end),
	}),

	core.test.suite("generated_file_is_stale", {
		core.test.case("is not stale when the diff has no changes", function()
			core.test.with_fake_diff({}, function()
				assert(not generate.generated_file_is_stale("gen/a.txt", "before", "after"))
			end)
		end),
		core.test.case("is stale when the diff names the path", function()
			core.test.with_fake_diff({ { type = "modified", path = "gen/a.txt" } }, function(diff)
				assert(generate.generated_file_is_stale("gen/a.txt", "before", "after"))
				assert(diff.calls[1].before == "before" and diff.calls[1].after == "after")
			end)
		end),

		core.test.case("is stale when the diff names an ancestor directory", function()
			core.test.with_fake_diff({ { type = "added", path = "gen" } }, function()
				assert(generate.generated_file_is_stale("gen/a.txt", "before", "after"))
			end)
		end),

		core.test.case("is not stale for a change to a different path", function()
			core.test.with_fake_diff({ { type = "removed", path = "gen/b.txt" }, { type = "added", path = "ge" } }, function()
				assert(not generate.generated_file_is_stale("gen/a.txt", "before", "after"))
			end)
		end),
	}),

	core.test.suite("generate goal", {
		core.test.case("writes each path and reports the stale paths", function()
			core.test.with_fake_goal_flags({ check = false }, function()
				core.test.with_fake_diff({ { type = "added", path = "gen/a.txt" } }, function()
					core.test.with_fake_write_workspace(function(writes)
						local report = generate_workflow.graph_generate_goal({ root({ "gen/b.txt", "gen/a.txt" }) })
						assert(#writes.calls == 2)
						assert(writes.calls[1].path == "gen/a.txt" and writes.calls[1].digest == "digest:gen/a.txt")
						assert(writes.calls[1].from == "gen/a.txt")
						assert(writes.calls[2].path == "gen/b.txt" and writes.calls[2].digest == "digest:gen/b.txt")
						assert(writes.calls[2].from == "gen/b.txt")
						assert(report == "generated 1 file(s):\n  gen/a.txt", report)
					end)
				end)
			end)
		end),

		core.test.case("publishes every file even when no file is stale", function()
			core.test.with_fake_goal_flags({}, function()
				core.test.with_fake_diff({}, function()
					core.test.with_fake_write_workspace(function(writes)
						local report = generate_workflow.graph_generate_goal({ root({ "gen/a.txt", "gen/b.txt" }) })
						assert(report == nil)
						assert(#writes.calls == 2)
						for index, path in ipairs({ "gen/a.txt", "gen/b.txt" }) do
							assert(writes.calls[index].path == path)
							assert(writes.calls[index].digest == `digest:{path}` and writes.calls[index].from == path)
						end
					end)
				end)
			end)
		end),

		core.test.case("check fails for a stale path and writes nothing", function()
			core.test.with_fake_goal_flags({ check = true }, function()
				core.test.with_fake_diff({ { type = "modified", path = "gen/a.txt" } }, function()
					core.test.with_fake_write_workspace(function(writes)
						local text = error_text(generate_workflow.graph_generate_goal, { root({ "gen/a.txt", "gen/b.txt" }) })
						assert(contains(text, "generated files are out of date:\n  gen/a.txt"), text)
						assert(not contains(text, "gen/b.txt"), text)
						assert(#writes.calls == 0)
					end)
				end)
			end)
		end),

		core.test.case("check passes when the files are up to date", function()
			core.test.with_fake_goal_flags({ check = true }, function()
				core.test.with_fake_diff({}, function()
					core.test.with_fake_write_workspace(function(writes)
						local report = generate_workflow.graph_generate_goal({ root({ "gen/a.txt", "gen/b.txt" }) })
						assert(report == "generate --check: 2 generated file(s) up to date", report)
						assert(#writes.calls == 0)
					end)
				end)
			end)
		end),

		core.test.case("rejects a root that is not a generated_files() result", function()
			core.test.with_fake_goal_flags({ check = true }, function()
				local text = error_text(generate_workflow.graph_generate_goal, { { address = "//x:y", result = {} } })
				assert(contains(text, "//x:y: generate graph root must resolve to a generated_files() result"), text)
			end)
		end),
	}),
}
