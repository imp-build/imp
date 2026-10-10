local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")
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

-- `generate_test.js` runs generators with Odin toolchains. The Imp generate
-- validation task ports it. These cases test the staleness check and the
-- goal with host fakes.
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
						local report = generate_workflow.graph_generate_goal({ root({ "gen/a.txt" }) })
						assert(#writes.calls == 1)
						assert(writes.calls[1].path == "gen/a.txt" and writes.calls[1].digest == "digest:gen/a.txt")
						assert(report == "generated 1 file(s):\n  gen/a.txt", report)
					end)
				end)
			end)
		end),

		core.test.case("check fails for a stale path and writes nothing", function()
			core.test.with_fake_goal_flags({ check = true }, function()
				core.test.with_fake_diff({ { type = "modified", path = "gen/a.txt" } }, function()
					core.test.with_fake_write_workspace(function(writes)
						local text = error_text(generate_workflow.graph_generate_goal, { root({ "gen/a.txt" }) })
						assert(contains(text, "generated files are out of date:\n  gen/a.txt"), text)
						assert(#writes.calls == 0)
					end)
				end)
			end)
		end),

		core.test.case("check passes when the files are up to date", function()
			core.test.with_fake_goal_flags({ check = true }, function()
				core.test.with_fake_diff({}, function()
					local report = generate_workflow.graph_generate_goal({ root({ "gen/a.txt", "gen/b.txt" }) })
					assert(report == "generate --check: 2 generated file(s) up to date", report)
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
