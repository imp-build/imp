-- Public Python graph API. Ruff extensions have a separate migration task.
local core = require("@imp/core")
local graph = require("@imp/rules/python/graph")
local runtime = require("@imp/rules/python/runtime")
local uv = require("@imp/rules/python/uv_toolchain")
local pex = require("@imp/rules/python/pex_toolchain")
core.register_build_rule({ rule = "python_app", module = "@imp/rules/python" })
core.register_build_rule({ rule = "python_test", module = "@imp/rules/python" })
return {
	python_app = graph.python_app, python_test = graph.python_test,
	python_sources = require("@imp/rules/python/source").python_sources,
	python_project = require("@imp/rules/python/project").python_project,
	python_workspace = require("@imp/rules/python/workspace").python_workspace,
	python_runtime = runtime.python_runtime, default_python_runtime_version = runtime.default_python_runtime_version,
	register_python_app_hook = graph.register_python_app_hook, register_python_test_hook = graph.register_python_test_hook,
	uv_toolchain = uv.uv_toolchain, uv_graph_tool = uv.graph_toolchain, uv_bin = uv.uv_bin,
	default_uv_toolchain_version = uv.default_version, resolve_uv_toolchain_version = uv.resolve_version,
	pex_toolchain = pex.pex_toolchain, pex_graph_tool = pex.graph_toolchain, pex_bin = pex.pex_bin,
	default_pex_toolchain_version = pex.default_version, resolve_pex_toolchain_version = pex.resolve_version,
}
