local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local codegen_module = require("@imp/rules/imp/codegen")
local codegen_workflow = require("@imp/rules/workflows/codegen")
local codegen = codegen_module.codegen

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local function sh_codegen(output_paths, script)
	return codegen({
		tools = { sh = core.native_tool("sh") },
		output_paths = output_paths,
		argv = function()
			return { "sh", "-c", script or "true" }
		end,
	})
end

local function artifact_source()
	return core.task({
		outputs = { file = core.output.artifact() },
		run = function(exec)
			local result = exec.action({
				argv = { "true" },
				outputs = { file = core.output.file("source.txt") },
			})
			return { file = result.outputs.file }
		end,
	}).outputs.file
end

-- The JavaScript module also checks the display name through graph
-- introspection, and structural task dedupe. Luau has no introspection walk,
-- and each `core.task` call makes a new handle, so those cases have no Luau
-- form. The fake run records the display name instead.
return {
	core.test.suite("codegen", {
		core.test.case("gives one artifact handle for each output path when it declares the graph", function()
			local generated = sh_codegen({ "a/one.txt", "b/nested/two.txt" })
			assert(#generated.paths == 2 and generated.paths[1] == "a/one.txt" and generated.paths[2] == "b/nested/two.txt")
			assert(type(generated.files["a/one.txt"]) == "userdata")
			assert(type(generated.files["b/nested/two.txt"]) == "userdata")
			assert(type(generated[build.BUILD]) == "userdata")
			assert(type(generated[codegen_workflow.CODEGEN]) == "userdata")
			assert(table.isfrozen(generated))
			assert(table.isfrozen(generated.files))
			assert(table.isfrozen(generated.paths))
		end),

		core.test.case("the CODEGEN root is the generator task with one artifact for each path", function()
			local generated = sh_codegen({ "a/one.txt", "b/two.txt" })
			assert(rawequal(generated[codegen_workflow.CODEGEN], generated[build.BUILD]))
			core.test.with_fake_run(function(host)
				local result = core.test.resolve(generated[codegen_workflow.CODEGEN])
				assert(type(result.out1) == "userdata")
				assert(type(result.out2) == "userdata")
				assert(#host.runs == 1)
				assert(host.runs[1].outputs.out1 == "a/one.txt")
				assert(host.runs[1].outputs.out2 == "b/two.txt")
				assert(host.runs[1].tools[1] == "sh")
			end)
		end),

		core.test.case("names the action after its outputs when no display is given", function()
			core.test.with_fake_run(function(host)
				core.test.resolve(sh_codegen({ "a/one.txt" })[build.BUILD])
				assert(host.runs[1].display == "generate a/one.txt", host.runs[1].display)
			end)
		end),

		core.test.case("stages the declared inputs", function()
			local source = artifact_source()
			local generated = codegen({
				inputs = { source = source },
				output_paths = { "out.txt" },
				argv = function()
					return { "sh", "-c", "true" }
				end,
			})
			core.test.with_fake_run(function(host)
				core.test.resolve(generated[build.BUILD])
				-- The first run produces the source. The second run is the generator.
				assert(#host.runs == 2)
				assert(host.runs[2].input_count == 1)
			end)
		end),

		core.test.case("rejects an empty or missing output_paths", function()
			local argv = function()
				return {}
			end
			assert(contains(error_text(codegen, { argv = argv }), "requires a non-empty output_paths array"))
			assert(contains(error_text(codegen, { output_paths = {}, argv = argv }), "requires a non-empty output_paths array"))
		end),

		core.test.case("rejects an argv that is not a function", function()
			local text = error_text(codegen, { output_paths = { "a" }, argv = { "sh" } })
			assert(contains(text, "requires an argv(exec, inputs) function"), text)
		end),

		core.test.case("rejects one name used for both a tool and an input", function()
			local text = error_text(codegen, {
				tools = { sh = core.native_tool("sh") },
				inputs = { sh = artifact_source() },
				output_paths = { "a" },
				argv = function()
					return {}
				end,
			})
			assert(contains(text, "got the same name in tools and inputs: sh"), text)
		end),

		core.test.case("rejects one output path declared twice", function()
			local text = error_text(sh_codegen, { "a.txt", "a.txt" })
			assert(contains(text, "declares the output path 'a.txt' twice"), text)
		end),

		core.test.case("writes a nested output path with no tool other than its shell", function()
			core.test.with_fake_run(function(host)
				core.test.resolve(sh_codegen({ "deep/nested/out.txt" }, "printf x > deep/nested/out.txt")[build.BUILD])
				assert(host.runs[1].outputs.out1 == "deep/nested/out.txt")
				assert(#host.runs[1].tools == 1)
			end)
		end),
	}),

	core.test.suite("generated sources", {
		core.test.case("expands a codegen() result to one entry for each path", function()
			local generated = sh_codegen({ "a.odin", "b.odin" })
			local list = codegen_module.normalize_generated_srcs({ generated }, { rule = "odin_package" })
			assert(#list == 2)
			assert(list[1].expected_path == "a.odin" and rawequal(list[1].artifact, generated.files["a.odin"]))
			assert(list[2].expected_path == "b.odin" and rawequal(list[2].artifact, generated.files["b.odin"]))
		end),

		core.test.case("accepts the { artifact, path } form and applies resolve_path", function()
			local artifact = artifact_source()
			local list = codegen_module.normalize_generated_srcs({ { artifact = artifact, path = "gen.odin" } }, {
				rule = "odin_package",
				resolve_path = function(path)
					return `app/{path}`
				end,
			})
			assert(list[1].expected_path == "app/gen.odin")
			assert(rawequal(list[1].artifact, artifact))
		end),

		core.test.case("resolve_path returns the path unchanged by default", function()
			local list = codegen_module.normalize_generated_srcs({ { artifact = artifact_source(), path = "gen.odin" } })
			assert(list[1].expected_path == "gen.odin")
		end),

		core.test.case("rejects an entry that is not a codegen() result or { artifact, path }", function()
			local text = error_text(codegen_module.normalize_generated_srcs, { { path = "x" } }, { rule = "odin_package" })
			assert(contains(text, "odin_package generated_srcs[1] must be a codegen() result"), text)
			text = error_text(codegen_module.normalize_generated_srcs, { { paths = {}, files = {} } }, { rule = "odin_package" })
			assert(contains(text, "generated_srcs[1] must be a codegen() result"), text)
		end),

		core.test.case("removes entries with the same path and the same artifact", function()
			local artifact = artifact_source()
			local list = codegen_module.dedupe_generated_srcs({
				{ artifact = artifact, expected_path = "a.odin" },
				{ artifact = artifact, expected_path = "a.odin" },
			}, { rule = "odin_package" })
			assert(#list == 1)
		end),

		core.test.case("rejects two different artifacts at one path", function()
			local text = error_text(codegen_module.dedupe_generated_srcs, {
				{ artifact = artifact_source(), expected_path = "a.odin" },
				{ artifact = artifact_source(), expected_path = "a.odin" },
			}, { rule = "odin_package" })
			assert(contains(text, "odin_package: two different generated sources cannot claim one workspace path ('a.odin')"), text)
		end),

		core.test.case("accepts a real path that is the declared path", function()
			codegen_module.assert_generated_src_path("odin_package", 1, "a.odin", "a.odin")
		end),

		core.test.case("rejects a real path that is not the declared path", function()
			local text = error_text(codegen_module.assert_generated_src_path, "odin_package", 2, "b.odin", "a.odin")
			assert(contains(text, "generated_srcs[2] artifact's real path 'b.odin' does not match its declared path ('a.odin')"), text)
		end),
	}),

	core.test.suite("stamp_file", {
		core.test.case("returns a frozen file artifact and build root", function()
			local stamp = codegen_module.stamp_file({ output = "VERSION", text = "1.2.3" })
			assert(table.isfrozen(stamp))
			assert(rawequal(stamp.file, stamp[build.BUILD]))
			core.test.with_fake_run(function(host)
				core.test.resolve(stamp.file)
				local run = host.runs[1]
				assert(run.display == "write VERSION")
				assert(run.argv[5] == "VERSION" and run.argv[6] == "1.2.3")
				assert(run.outputs.file == "VERSION")
			end)
		end),

		core.test.case("requires an output and a text", function()
			assert(contains(error_text(codegen_module.stamp_file, { text = "x" }), "requires a non-empty output"))
			assert(contains(error_text(codegen_module.stamp_file, { output = "x" }), "requires a text string"))
		end),
	}),

	core.test.suite("codegen goal", {
		core.test.case("exports each file below dist/codegen", function()
			core.test.with_fake_write_workspace(function(writes)
				local report = codegen_workflow.graph_codegen_goal({
					{
						address = "//pkg:gen",
						result = { out1 = { type = "artifact", digest = "d1", path = "a/one.txt" } },
					},
				})
				assert(#writes.calls == 1)
				assert(writes.calls[1].path == "dist/codegen/a/one.txt")
				assert(writes.calls[1].digest == "d1" and writes.calls[1].from == "a/one.txt")
				assert(contains(report, "Exported 1 codegen file:"), report)
			end)
		end),

		core.test.case("rejects paths that differ only in case", function()
			local text = error_text(codegen_workflow.graph_codegen_goal, {
				{ address = "//a:gen", result = { type = "artifact", digest = "d", path = "A.txt" } },
				{ address = "//b:gen", result = { type = "artifact", digest = "d", path = "a.txt" } },
			})
			assert(contains(text, "codegen output path conflict at 'dist/codegen/a.txt'"), text)
		end),

		core.test.case("rejects a root without artifacts", function()
			local text = error_text(codegen_workflow.graph_codegen_goal, { { address = "//a:gen", result = { x = 1 } } })
			assert(contains(text, "//a:gen: codegen root must resolve to a codegen() result"), text)
		end),

		core.test.case("rejects a path that is not normalized", function()
			local text = error_text(codegen_workflow.graph_codegen_goal, {
				{ address = "//a:gen", result = { type = "artifact", digest = "d", path = "../x" } },
			})
			assert(contains(text, "must be a normalized workspace-relative path"), text)
		end),
	}),
}
