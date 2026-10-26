local core = require("@imp/core")
local python = require("@imp/rules/python")
local run = require("@imp/rules/workflows/run")
local source = require("@imp/rules/python/source")
local uv = require("@imp/rules/python/uv_toolchain")
local project = require("@imp/rules/python/project")
return {
	core.test.case("source rejects missing roots and recursive patterns", function()
		assert(not pcall(python.python_sources, {}))
		assert(not pcall(python.python_sources, { root = "../tools" }))
		assert(not pcall(python.python_sources, { root = "rules/python", sources = { "**/*.py" } }))
		assert(not pcall(python.python_sources, { root = "rules/python", sources = {} }))
	end),
	core.test.case("source programs use inferred project and runtime", function()
		core.test.with_fake_toolchain_host(function()
			python.python_runtime("3.12.4")
			local scripts = python.python_sources({ root = "rules/python/example/scripts" })
			assert(type(scripts[run.RUN]) == "userdata")
			local value = core.test.resolve(source.source_program({
				root = scripts.root,
				sources = { "*.py" },
				deps = {},
				project = project.find_python_project(scripts.root),
				python_version = python.default_python_runtime_version(),
				uv = uv.graph_toolchain(),
			}, "rules/python/example/scripts/demo.py"))
			assert(table.find(value.argv, "rules/python/example/scripts/demo.py"))
			assert(table.find(value.argv, "rules/python/example"))
			assert(table.find(value.argv, "3.12.4"))
			assert(#value.inputs == 2 and #value.tools == 3)
		end)
	end),
	core.test.case("unprojected source programs stage only source inputs", function()
		core.test.with_fake_toolchain_host(function()
			local value = {
				core.test.resolve(source.source_program({
					root = "rules/python/testdata",
					sources = { "consumer_check.py" },
					deps = { core.native_tool("git") },
					python_version = "3.13.0",
					uv = uv.graph_toolchain(),
				}, "rules/python/testdata/consumer_check.py")),
			}
			assert(#value == 1 and #value[1].inputs == 1 and #value[1].tools == 4)
			assert(table.find(value[1].argv, ""))
			assert(value[1].env.UV_CACHE_DIR == "/cache/uv-cache-dir/shared")
		end)
	end),
}
