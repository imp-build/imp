local core = require("@imp/core")
local project = require("@imp/rules/python/project")
local runtime = require("@imp/rules/python/runtime")
local uv = require("@imp/rules/python/uv_toolchain")
local lock = require("@imp/rules/python/lock")
local lockfiles = require("@imp/rules/workflows/lockfiles")
--- Declare a uv workspace. Options: path, uv_version, and python_version.
--- Return workspace identity and a GEN_LOCKFILES root.
local function python_workspace(options)
	options = options or {}
	local ref = project.python_workspace_ref(options.path or core.package_path())
	local value = table.clone(ref)
	value[lockfiles.GEN_LOCKFILES] = lock.python_workspace_lock({
		workspace = ref.path,
		sources = project.python_workspace_sources(ref),
		uv = uv.graph_toolchain(options.uv_version).tool,
		python_version = options.python_version or runtime.default_python_runtime_version(),
	})
	return table.freeze(value)
end
return { python_workspace = python_workspace }
