-- Re-lock one Python workspace and publish only its uv.lock artifact.
local core = require("@imp/core")
local uv_toolchain = require("@imp/rules/python/uv_toolchain")

--- Declare an uncached lock task. Options: workspace, sources, uv (tool
--- handle), and python_version. Return a Python lock task handle
--- for the GEN_LOCKFILES slot. sources must include workspace metadata.
local function python_workspace_lock(options)
	local workspace = options.workspace
	local path = if workspace == "." then "uv.lock" else workspace .. "/uv.lock"
	local cache = uv_toolchain.cache_tool()
	return core.task({
		display = `gen Python workspace lockfile {workspace}`, cache = false,
		inputs = { sources = options.sources, uv = options.uv, cache = cache },
		outputs = { kind = core.output.value(), project = core.output.value(), path = core.output.value(), lockfile = core.output.artifact() },
		run = function(exec, inputs)
			local action = exec.action({
				argv = { uv_toolchain.uv_bin(exec, inputs.uv), "lock", "--project", workspace, "--no-progress", "--managed-python", "--python", options.python_version },
				inputs = { inputs.sources }, tools = { inputs.uv, inputs.cache },
				env = uv_toolchain.cache_env(exec, inputs.cache), cache = false,
				outputs = { lockfile = core.output.file(path) }, display = `lock Python workspace {workspace}`,
			})
			return { kind = "python-project-lock", project = workspace, path = path, lockfile = action.outputs.lockfile }
		end,
	})
end
return { python_workspace_lock = python_workspace_lock }
