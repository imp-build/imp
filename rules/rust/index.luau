-- Cargo packages expose build, package, format, lint, and test graph roots.
-- BUILD generation is enabled by importing ./generate_build separately.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local test = require("@imp/rules/workflows/test")
local rust = require("./toolchain")
local gcc = require("@imp/rules/c/gcc")
local host = require("@imp/rules/c/host")
local mold = require("@imp/rules/c/mold")
local kache = require("./kache")
local codegen = require("@imp/rules/imp/codegen")
local cargo_inputs = require("./cargo_task_inputs")
local expansion_module = require("./workspace_expansion")
local specs = {}
local output = core.output
local EMPTY_DECLARATION = table.freeze({})

local function normalize_path(path)
	local parts = {}
	for part in string.gmatch(path, "[^/]+") do
		assert(part ~= "..", `Rust paths must stay within the workspace: {path}`)
		if part ~= "." then
			table.insert(parts, part)
		end
	end
	assert(
		string.sub(path, 1, 1) ~= "/" and not string.find(path, "\\", 1, true),
		"Rust paths must be workspace-relative"
	)
	return if #parts == 0 then "." else table.concat(parts, "/")
end

local function package_specs()
	return table.clone(specs)
end

local function resolve_toolchain(value)
	if type(value) == "table" and value.toolchain_id then
		return value, EMPTY_DECLARATION
	end
	local declaration = if type(value) == "table" then value else if value == nil then rust.default_toolchain() else nil
	local version = if declaration then declaration.version else value
	return rust.graph_toolchain(version), declaration or EMPTY_DECLARATION
end

-- Compute handles while declaring the graph. Task callbacks only resolve them.
local function tool_inputs(spec, compiling)
	local inputs =
		{ rustup = spec.toolchain.tool, cargo = spec.toolchain.cargo_home_tool, shell = core.native_tool("sh") }
	if compiling then
		if core.platform_info().os ~= "windows" then
			if not spec.link_driver then
				spec.link_driver = spec.declaration.link_driver
					or gcc.default_graph_toolchain()
					or host.default_graph_toolchain()
			end
			assert(spec.link_driver, "cargo builds need a GCC default or an explicit link_driver")
			if host.is_host_toolchain(spec.link_driver) then
				inputs.host_cc = spec.link_driver.tool
				inputs.host_ar = spec.link_driver.ar_tool
			else
				inputs.gcc = spec.link_driver.tool
			end
			inputs.dirname = core.native_tool("dirname")
			local linker = spec.declaration.linker
			if linker then
				inputs.mold = linker.tool or mold.graph_toolchain(linker.version).tool
			end
		end
		local cache = spec.declaration.kache
		if cache then
			local graph = kache.graph_toolchain(cache.version)
			inputs.kache = graph.tool
			inputs.kache_data = graph.data_tool
		end
	end
	return inputs
end

local function tool_env(exec, input, spec)
	local active = input.kache ~= nil
	local env = table.clone(
		rust.graph_tool_env(
			exec,
			input.rustup,
			input.cargo,
			spec.toolchain.toolchain_id,
			spec.toolchain.version,
			active
		).env
	)
	local flags, dirs = {}, {}
	local driver = if input.gcc
		then gcc.rust_link_driver_env(exec, input.gcc, active)
		elseif input.host_cc then host.rust_link_driver_env(active)
		else nil
	if driver then
		for key, value in pairs(driver.env) do
			env[key] = value
		end
		for _, value in ipairs(driver.rustflags) do
			table.insert(flags, value)
		end
		for _, value in ipairs(driver.path_dirs) do
			table.insert(dirs, value)
		end
	end
	if input.mold then
		local result = mold.rust_linker_env(exec, input.mold)
		for _, value in ipairs(result.rustflags) do
			table.insert(flags, value)
		end
		for _, value in ipairs(result.path_dirs) do
			table.insert(dirs, value)
		end
	end
	if active then
		for key, value in pairs(kache.build_cache_env(exec, input.kache, input.kache_data, spec.declaration.kache)) do
			env[key] = value
		end
	end
	if #dirs > 0 then
		env.PATH = table.concat(dirs, ":") .. (if env.PATH then ":" .. env.PATH else "")
	end
	return env, table.concat(flags, " "), active
end

local function cargo_script(command, active)
	return 'imp_sandbox_root="$(pwd)"; manifest=$1; target_dir=$2; rustflags=$3; shift 3; '
		.. (if active then kache.script_preamble() else "")
		.. 'RUSTFLAGS="$rustflags'
		.. (if active then " --remap-path-prefix=$imp_sandbox_root=/imp-src" else "")
		.. '" '
		.. command
end

local expansions = expansion_module.new({
	package_specs = package_specs,
	tool_inputs = tool_inputs,
	tool_env = tool_env,
	cargo_script = cargo_script,
})

local function generated_for_build(spec)
	if not spec.workspace_member then
		return spec.generated_srcs
	end
	local generated = {}
	for _, member in ipairs(specs) do
		if member.workspace_member then
			for _, source in ipairs(member.generated_srcs) do
				table.insert(generated, source)
			end
		end
	end
	return codegen.dedupe_generated_srcs(generated, { rule = "cargo_package" })
end

-- Delay build input collection until resolution, after sibling declarations.
local function crate_build(spec)
	local sources = if spec.builtin
		then cargo_inputs.builtin_cargo_manifest_sources
		else cargo_inputs.cargo_manifest_sources
	local manifests = sources(if spec.workspace_member then "." else spec.path, { recursive = true })
	local inputs = tool_inputs(spec, true)
	inputs.manifests = manifests
	local generated = cargo_inputs.cargo_task_inputs({ deps = spec.deps, generated_srcs = generated_for_build(spec) })
	for key, value in pairs(generated.bindings("compile")) do
		inputs[key] = value
	end
	local outputs = {}
	for _, name in ipairs(spec.bin) do
		outputs[name] = output.artifact()
	end
	return core.task({
		display = `cargo build {spec.path}`,
		inputs = inputs,
		outputs = outputs,
		run = function(exec, input)
			generated.validate_generated_srcs(exec, input)
			local env, flags, active = tool_env(exec, input, spec)
			local dir = `build/rust/{spec.slug}`
			local argv = {
				"sh",
				"-c",
				cargo_script(
					'cargo build -j "$IMP_CORES" --locked --manifest-path "$manifest" --target-dir "$target_dir" "$@"',
					active
				),
				"cargo-build",
				`{spec.path}/Cargo.toml`,
				dir,
				flags,
			}
			if spec.release then
				table.insert(argv, "--release")
			end
			for _, arg in ipairs(spec.cargo_args) do
				table.insert(argv, arg)
			end
			local action_outputs = {}
			for _, name in ipairs(spec.bin) do
				action_outputs[name] = output.file(
					`{dir}/{if spec.release then "release" else "debug"}/{name}{if core.platform_info().os
							== "windows"
						then ".exe"
						else ""}`
				)
			end
			local staged = { input.manifests }
			for _, value in ipairs(generated.resolved(input, "compile")) do
				table.insert(staged, value)
			end
			return exec.action({ argv = argv, env = env, inputs = staged, outputs = action_outputs, cores = 8 }).outputs
		end,
	})
end

--- Declare a Cargo package. Options use snake_case. `bin` is explicit; omit
--- it for a library. `workspace_member` assumes a workspace at "." and a
--- package name equal to the directory name. `release` selects Cargo release.
--- @returns Target with BUILD handles keyed by binary name, TEST unit and doctests handles, and one PACKAGE handle for binaries.
local function cargo_package(options)
	options = options or {}
	local path = normalize_path(options.path or core.package_path())
	local graph, declaration = resolve_toolchain(options.toolchain)
	local generated = codegen.dedupe_generated_srcs(
		codegen.normalize_generated_srcs(options.generated_srcs, {
			rule = "cargo_package",
			resolve_path = function(value)
				return normalize_path(if path == "." then value else `{path}/{value}`)
			end,
		}),
		{ rule = "cargo_package" }
	)
	local bins = if type(options.bin) == "string" then { options.bin } else table.clone(options.bin or {})
	local spec = {
		path = path,
		bin = bins,
		release = options.release == true,
		toolchain = graph,
		declaration = declaration,
		cargo_args = table.clone(options.cargo_args or {}),
		test_args = table.clone(options.test_args or {}),
		test_tools = table.clone(options.test_tools or {}),
		deps = table.clone(options.deps or {}),
		test_deps = table.clone(options.test_deps or {}),
		generated_srcs = generated,
		workspace_member = options.workspace_member == true,
		builtin = options.builtin == true,
		slug = if path == "." then "root" else string.gsub(path, "/", "_"),
	}
	table.insert(specs, spec)
	local expansion = if spec.workspace_member then expansions.workspace(".", spec) else expansions.standalone(spec)
	local key = if spec.workspace_member then string.match(path, "[^/]+$") or "." else path

	local value = {
		spec = spec,
		[lint.LINT] = expansion:get(key, lint.LINT),
		[fmt.FMT] = expansion:get(key, fmt.FMT),
		[test.TEST] = table.freeze({
			unit = expansion:get(key, test.TEST, "unit"),
			doctests = expansion:get(key, test.TEST, "doctests"),
		}),
	}
	if #bins > 0 then
		local deferred = core.expand({
			inputs = {},
			create = function()
				local compiled = crate_build(spec)
				local published = compiled.outputs[bins[1]]
				if #bins > 1 then
					local inputs = {
						shell = core.native_tool("sh"),
						mkdir = core.native_tool("mkdir"),
						cp = core.native_tool("cp"),
					}
					for index, name in ipairs(bins) do
						inputs[`binary{index}`] = compiled.outputs[name]
					end
					published = core.task({
						display = `bundle cargo binaries {path}`,
						inputs = inputs,
						outputs = { directory = output.artifact() },
						run = function(exec, input)
							local dir = `build/rust/{spec.slug}-package`
							local argv, staged =
								{ "sh", "-c", 'dir=$1; shift; mkdir -p "$dir"; cp "$@" "$dir/"', "bundle-cargo", dir },
								{}
							for index in ipairs(bins) do
								table.insert(argv, exec.path(input[`binary{index}`]))
								table.insert(staged, input[`binary{index}`])
							end
							return {
								directory = exec.action({
									argv = argv,
									inputs = staged,
									outputs = { directory = output.directory(dir) },
								}).outputs.directory,
							}
						end,
					}).outputs.directory
				end
				local facets = {}
				for _, name in ipairs(bins) do
					facets[name] = compiled.outputs[name]
				end
				return { build = { [build.BUILD] = facets, [package.PACKAGE] = published } }
			end,
		})
		local facets = {}
		for _, name in ipairs(bins) do
			facets[name] = deferred:get("build", build.BUILD, name)
		end
		value[build.BUILD] = table.freeze(facets)
		value[package.PACKAGE] = deferred:get("build", package.PACKAGE)
	end
	return table.freeze(value)
end

return {
	--- @category target
	cargo_package = cargo_package,
	cargo_package_specs = package_specs,
}
