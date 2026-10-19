local core = require("@imp/core")
local lock = require("@imp/rules/python/lock")
local uv = require("@imp/rules/python/uv_toolchain")

local function lock_case(workspace)
	return core.test.case(`locks workspace {workspace}`, function()
		core.test.with_fake_toolchain_host(function(host)
			uv.reset_for_test()
			uv.uv_toolchain("0.12.13", {})
			local sources = core.files({ root = "rules/python/testdata/workspace", include = { "pyproject.toml" } })
			local handle = lock.python_workspace_lock({ workspace = workspace, sources = sources, uv = uv.graph_toolchain("0.12.13").tool, python_version = "3.13.0" })
			local result = core.test.resolve(handle)
			local path = if workspace == "." then "uv.lock" else workspace .. "/uv.lock"
			assert(result.kind == "python-project-lock")
			assert(result.project == workspace and result.path == path)
			assert(type(result.lockfile) == "userdata")
			local action = host.runs[#host.runs]
			assert(action.display == `lock Python workspace {workspace}`)
			assert(action.cache == false)
			assert(table.find(action.argv, "--managed-python"))
			assert(table.find(action.argv, "3.13.0"))
			assert(table.find(action.argv, workspace))
			assert(action.env.UV_CACHE_DIR == "/cache/uv-cache-dir/shared")
			assert(action.env.UV_PYTHON_INSTALL_DIR == "/cache/uv-cache-dir/shared/python-install")
			assert(table.find(action.tools, "uv"))
			assert(table.find(action.tools, "uv-cache-dir"))
			local writes = 0
			for _, call in ipairs(host.calls) do if call[1] == "write_workspace" then writes += 1 end end
			assert(writes == 0)
			assert(action.outputs.lockfile == path)
			assert(action.input_count == 1)
		end)
	end)
end
return { core.test.suite("Python workspace lock", { lock_case("."), lock_case("packages/app") }) }
