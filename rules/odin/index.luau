-- Public Odin graph declarations. Require odinfmt before declaring packages.
local core = require("@imp/core")
local graph = require("@imp/rules/odin/graph")
local toolchain = require("@imp/rules/odin/toolchain")
core.define_config_schema("odin", {
	collections = core.field.map(core.field.string(), core.field.string(), { default = {} }),
	build_generate = core.field.bool({ default = false }),
})
core.register_build_rule({ rule = "odin_package", module = "@imp/rules/odin" })
core.register_build_rule({ rule = "odin_test_package", module = "@imp/rules/odin" })
require("@imp/rules/odin/generate_build")
return {

	--- @category target
	odin_package = graph.odin_package,
	--- Declare an Odin test package with source and dependency options.
	--- @category target
	odin_test_package = graph.odin_test_package,
	register_odin_package_hook = graph.register_odin_package_hook,

	--- @category configuration
	odin_toolchain = toolchain.odin_toolchain,
	odin_gen_lockfiles = toolchain.odin_gen_lockfiles,
	odin_graph_toolchain = toolchain.graph_toolchain,
	odin_bin = toolchain.bin,
	default_odin_toolchain_version = toolchain.default_version,
}
