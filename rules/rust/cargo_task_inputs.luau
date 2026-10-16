-- Group Cargo inputs by their compile, runtime, and tool roles.
local core = require("@imp/core")
local codegen = require("@imp/rules/imp/codegen")
local ROLES = { compile = { "dep", "generated" }, runtime = { "dep", "test_dep", "generated" }, tools = { "tool" } }
local function manifest_sources(root, options)
	options = options or {}
	return core.files({ root = root, include = if options.recursive then { "**/Cargo.toml", "Cargo.lock", "**/*.rs" } else { "Cargo.toml", "Cargo.lock", "*.rs" }, exclude = { "target/**" } })
end
local function cargo_task_inputs(options)
	options = options or {}
	local generated = options.generated_srcs or {}
	local artifacts = {}
	for _, value in ipairs(generated) do table.insert(artifacts, value.artifact) end
	local groups = { dep = options.deps or {}, test_dep = options.test_deps or {}, tool = options.test_tools or {}, generated = artifacts }
	return {
		generated_srcs = generated,
		bindings = function(role)
			local result = {}
			for _, prefix in ipairs(assert(ROLES[role], "unknown Cargo input role")) do
				for index, value in ipairs(groups[prefix]) do result[`{prefix}{index}`] = value end
			end
			return result
		end,
		resolved = function(input, role)
			local result = {}
			for _, prefix in ipairs(assert(ROLES[role], "unknown Cargo input role")) do
				for index in ipairs(groups[prefix]) do table.insert(result, input[`{prefix}{index}`]) end
			end
			return result
		end,
		validate_generated_srcs = function(exec, input, rule)
			for index, value in ipairs(generated) do codegen.assert_generated_src_path(rule or "cargo_package", index, exec.path(input[`generated{index}`]), value.expected_path) end
		end,
	}
end
return { cargo_task_inputs = cargo_task_inputs, cargo_manifest_sources = manifest_sources, builtin_cargo_manifest_sources = function(root, options)
 options = options or {}
 return core.builtin_files({ root = root, include = if options.recursive then { "Cargo.toml", "Cargo.lock", "**/*.rs" } else { "Cargo.toml", "Cargo.lock", "*.rs" }, exclude = { "target/**" } })
 end }
