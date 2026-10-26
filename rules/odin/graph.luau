-- Package discovery, source closure, and sandboxed Odin actions.
local core = require("@imp/core")
local tools = require("@imp/rules/odin/toolchain")
local gcc = require("@imp/rules/c/gcc")
local mold = require("@imp/rules/c/mold")
local treesitter = require("@imp/rules/treesitter")
local codegen = require("@imp/rules/imp/codegen")
local build = require("@imp/rules/workflows/build")
local lint = require("@imp/rules/workflows/lint")
local package = require("@imp/rules/workflows/package")
local run = require("@imp/rules/workflows/run")
local test = require("@imp/rules/workflows/test")
require("@imp/rules/imp/mode")
local packages, hooks = {}, {}
local CORES = 4
local EXCLUDE = { "*_test.odin", "test_*.odin" }
local function append(out, values)
	for _, value in ipairs(values) do
		table.insert(out, value)
	end
	return out
end
local function keys(map)
	local out = {}
	for key in pairs(map) do
		table.insert(out, key)
	end
	table.sort(out)
	return out
end
local function dirname(path)
	return string.match(path, "^(.*)/[^/]*$") or "."
end
local function join(base, path)
	assert(type(path) == "string" and string.sub(path, 1, 1) ~= "/", "Odin paths must be workspace-relative")
	local parts = {}
	for part in string.gmatch(base .. "/" .. path, "[^/]+") do
		if part == ".." then
			assert(#parts > 0, "Odin path escapes the workspace")
			table.remove(parts)
		elseif part ~= "." then
			table.insert(parts, part)
		end
	end
	return if #parts == 0 then "." else table.concat(parts, "/")
end
local function defines(value)
	value = value or {}
	assert(type(value) == "table", "Odin defines require a name-to-string map")
	local out = {}
	for name, item in pairs(value) do
		assert(type(name) == "string" and string.match(name, "^[A-Za-z_][A-Za-z0-9_]*$"), "invalid Odin define name")
		assert(type(item) == "string", `Odin define '{name}' requires a string value`)
		out[name] = item
	end
	return table.freeze(out)
end
local function define_args(value)
	local out, normalized = {}, defines(value)
	for _, name in ipairs(keys(normalized)) do
		table.insert(out, `-define:{name}={normalized[name]}`)
	end
	return out
end
local function collection_map(spec, config)
	local out = table.clone(config.collections or {})
	for name, value in pairs(spec.collections or {}) do
		if type(name) == "number" then
			name, value = value.name, value.path
		end
		if type(value) == "table" then
			value = value.path
		end
		assert(type(name) == "string" and type(value) == "string", "Odin collections require string names and paths")
		out[name] = join(spec.base, value)
	end
	return out
end
local analysis_task = core.task({
	display = "tree-sitter analyze Odin sources",
	inputs = {
		sources = core.files({ root = ".", include = { "**/*.odin" }, exclude = { "build/**" } }),
		grammar = treesitter.odin_grammar_fixture.archive,
		analyzer = treesitter.odin_analyzer[package.PACKAGE],
	},
	outputs = { index = core.output.value() },
	run = function(exec, input)
		local argv = { exec.path(input.analyzer), exec.path(input.grammar) }
		append(argv, exec.paths(input.sources))
		local result = exec.action({ argv = argv, inputs = { input.analyzer, input.grammar, input.sources } })
		return { index = core.json_decode(result.stdout) }
	end,
})
local function analyze(spec, index, paths)
	local imports, dirs, main = {}, {}, false
	for _, path in ipairs(paths) do
		if string.match(path, "%.odin$") then
			dirs[dirname(path)] = true
			local file = (index.files or {})[path]
			if file then
				for _, imp in ipairs(file.imports) do
					imports[imp] = true
				end
				main = main or file.hasMainEntrypoint
			end
		end
	end
	local path = spec.path
	if not dirs[path] then
		local found = keys(dirs)
		assert(
			#found <= 1,
			`Odin sources span multiple package directories under '{path}'; set path or split the package`
		)
		path = found[1] or path
	end
	return { path = path, imports = keys(imports), has_main = main, paths = paths }
end
local function resolve_import(imp, from, collections)
	local name, relative = string.match(imp, "^([^:]+):(.*)$")
	if name then
		return if collections[name] then join(collections[name], relative) else nil, name
	end
	return join(from, imp), nil
end
local function closure(spec, index, selected, config)
	local collections = collection_map(spec, config)
	local declared = {}
	for _, candidate in ipairs(packages) do
		if not declared[candidate.path] or declared[candidate.path].test then
			declared[candidate.path] = candidate
		end
	end
	local result = { specs = {}, sources = {}, collections = {} }
	local visited, directories, queue = {}, {}, {}
	local function enqueue(candidate)
		if visited[candidate.key] then
			return
		end
		visited[candidate.key] = true
		local info = analyze(candidate, index, selected[candidate.key])
		directories[candidate.path], directories[info.path] = true, true
		table.insert(result.specs, candidate)
		table.insert(result.sources, candidate.sources)
		table.insert(queue, info)
		for _, dep in ipairs(candidate.deps) do
			if type(dep) == "table" and dep.odin_spec then
				enqueue(dep.odin_spec)
			end
		end
	end
	enqueue(spec)
	local cursor = 1
	while cursor <= #queue do
		local info = queue[cursor]
		cursor += 1
		for _, imp in ipairs(info.imports) do
			local path, name = resolve_import(imp, info.path, collections)
			if path then
				if name then
					result.collections[name] = collections[name]
				end
				if declared[path] then
					enqueue(declared[path])
				elseif not directories[path] then
					directories[path] = true
					local paths = {}
					for file in pairs(index.files or {}) do
						local basename = string.match(file, "[^/]+$")
						if
							dirname(file) == path
							and not string.match(basename, "_test%.odin$")
							and not string.match(basename, "^test_")
						then
							table.insert(paths, file)
						end
					end
					table.sort(paths)
					assert(
						#paths > 0,
						`Odin package '{info.path}' imports '{imp}', which resolves to '{path}', but there is no Odin package there`
					)
					table.insert(result.sources, core.files({ root = path, include = { "*.odin" }, exclude = EXCLUDE }))
					table.insert(queue, analyze({ path = path }, index, paths))
				end
			end
		end
	end
	return result
end
local function resources(specs)
	local out = { files = {}, shared = {}, linkopts = {}, generated = {} }
	local seen, shared, flags = {}, {}, {}
	local function push(handle)
		assert(type(handle) == "userdata", "Odin resources require graph handles")
		if not seen[handle] then
			seen[handle] = true
			table.insert(out.files, handle)
		end
	end
	for _, spec in ipairs(specs) do
		append(out.generated, spec.generated)
		for _, dep in ipairs(spec.deps) do
			if type(dep) == "userdata" then
				push(dep)
			elseif type(dep) == "table" and not dep.odin_spec then
				local recognized = false
				for _, field in ipairs({ "sources", "resources" }) do
					if dep[field] then
						push(dep[field])
						recognized = true
					end
				end
				for _, field in ipairs({ "transitive_archives", "transitive_shared_libs", "transitive_import_libs" }) do
					if dep[field] then
						recognized = true
						for _, handle in ipairs(dep[field]) do
							push(handle)
							if field == "transitive_shared_libs" and not shared[handle] then
								shared[handle] = true
								table.insert(out.shared, handle)
							end
						end
					end
				end
				if dep.transitive_linkopts then
					recognized = true
					for _, flag in ipairs(dep.transitive_linkopts) do
						if not flags[flag] then
							flags[flag] = true
							table.insert(out.linkopts, flag)
						end
					end
				end
				assert(recognized, `Odin package '{spec.path}' has a dep of an unrecognized shape`)
			elseif type(dep) ~= "table" then
				error(`Odin package '{spec.path}' has a dep of an unrecognized shape`)
			end
		end
	end
	out.generated = codegen.dedupe_generated_srcs(out.generated, { rule = "odin_package" })
	return out
end
local function merged_defines(specs, config)
	local result, assigned = table.clone(defines(config.defines)), {}
	for _, spec in ipairs(specs) do
		for name, value in pairs(spec.defines) do
			assert(assigned[name] == nil or assigned[name] == value, `Odin packages reach conflicting define '{name}'`)
			assigned[name], result[name] = value, value
		end
	end
	return result
end
local function library_env(paths, plat)
	local dirs, seen = {}, {}
	for _, path in ipairs(paths) do
		local dir = dirname(path)
		if not seen[dir] then
			seen[dir] = true
			table.insert(dirs, dir)
		end
	end
	return if #dirs > 0 and plat.os == "linux" then { LD_LIBRARY_PATH = table.concat(dirs, ":") } else {}
end
local function test_out_args(paths, plat)
	if #paths == 0 or plat.os ~= "windows" then
		return {}
	end
	local dir = dirname(paths[1])
	for _, path in ipairs(paths) do
		assert(dirname(path) == dir, "odin test on Windows cannot load DLLs from more than one directory")
	end
	return { `-out:{dir}/output.exe` }
end
local function compile(spec, info, source_closure, native, config, kind)
	local provider = spec.toolchain
	local cc = gcc.graph_toolchain()
	if spec.unsafe_system_paths then
		cc = gcc.toolchain_record(gcc.graph_tool(cc.version, { unsafe_system_paths = true }), cc.version)
	end
	local inputs = { odin = provider.tool, gcc = cc.tool }
	local is_lint, is_test = kind == "lint", kind == "test"
	local linker = if not is_lint then provider.linker else nil
	if linker then
		inputs.mold = linker.tool
	end
	if not is_lint then
		inputs.opt = core.semantic.mode("opt")
	end
	for i, source in ipairs(source_closure.sources) do
		inputs[`source{i}`] = source
	end
	for i, resource in ipairs(native.files) do
		inputs[`resource{i}`] = resource
	end
	for i, generated in ipairs(native.generated) do
		inputs[`generated{i}`] = generated.artifact
	end
	local values = merged_defines(source_closure.specs, config)
	local plat = core.platform_info()
	local executable = if plat.os == "windows" then "output.exe" else "output"
	local output_path = if info.has_main then executable else "output.a"
	return core.task({
		display = `odin {if is_lint then "check -vet" elseif is_test then "test" else "build"} {info.path}`,
		inputs = inputs,
		outputs = if is_lint
			then { result = core.output.value() }
			elseif is_test then { units = core.output.value() }
			else { artifact = core.output.artifact() },
		run = function(exec, input)
			local all_inputs, shared_paths = {}, {}
			for _, name in ipairs(keys(input)) do
				local handle = input[name]
				if
					string.match(name, "^source%d+$")
					or string.match(name, "^resource%d+$")
					or string.match(name, "^generated%d+$")
				then
					table.insert(all_inputs, handle)
				end
			end
			for i, generated in ipairs(native.generated) do
				codegen.assert_generated_src_path(
					"odin_package",
					i,
					exec.path(input[`generated{i}`]),
					generated.expected_path
				)
			end
			for i, handle in ipairs(native.files) do
				if table.find(native.shared, handle) then
					table.insert(shared_paths, exec.path(input[`resource{i}`]))
				end
			end
			local argv = {
				tools.bin(exec, input.odin),
				if is_lint then "check" elseif is_test then "test" else "build",
				info.path,
				`-thread-count:{CORES}`,
			}
			if is_test then
				table.insert(argv, `-define:ODIN_TEST_THREADS={CORES}`)
			end
			append(argv, define_args(values))
			for _, name in ipairs(keys(source_closure.collections)) do
				table.insert(argv, `-collection:{name}={source_closure.collections[name]}`)
			end
			if not is_lint then
				table.insert(argv, if input.opt == "release" then "-o:speed" else "-debug")
			end
			if is_lint then
				table.insert(argv, "-vet")
			end
			if not info.has_main then
				if is_lint then
					table.insert(argv, "-no-entry-point")
				elseif not is_test then
					table.insert(argv, "-build-mode:lib")
				end
			end
			if not is_lint and not is_test then
				table.insert(argv, `-out:{output_path}`)
			end
			if is_test then
				append(argv, test_out_args(shared_paths, plat))
			end
			local bin_dir = gcc.graph_toolchain_dir(exec, input.gcc)
				.. (if spec.unsafe_system_paths then "/bin-unsafe-paths" else "/bin")
			local path_dirs, flags = { bin_dir }, table.clone(native.linkopts)
			if linker then
				local env = mold.odin_linker_env(exec, input.mold)
				append(argv, env.flags)
				path_dirs = append(table.clone(env.path_dirs), path_dirs)
			elseif not is_lint and plat.os == "windows" and provider.lld_on_windows then
				table.insert(argv, "-linker:lld")
				if provider.mingw_crt then
					table.insert(argv, "-no-crt")
					table.insert(flags, "/force:multiple")
					append(flags, gcc.windows_runtime_archives(exec, input.gcc, cc.version))
				end
			end
			if not is_lint and #flags > 0 then
				table.insert(argv, "-extra-linker-flags:" .. table.concat(flags, " "))
			end
			local env = library_env(shared_paths, plat)
			env.PATH = table.concat(path_dirs, if plat.os == "windows" then ";" else ":")
			local result = exec.action({
				argv = argv,
				cores = CORES,
				inputs = all_inputs,
				env = env,
				allow_failure = is_lint or is_test,
				outputs = if not is_lint and not is_test then { artifact = core.output.file(output_path) } else {},
			})
			if is_lint then
				return {
					result = {
						ok = result.exit_code == 0,
						output = result.stdout .. "\n" .. result.stderr,
						fix_supported = false,
						fix_applied = false,
					},
				}
			end
			if is_test then
				return { units = test.test_vehicle(info.path, result) }
			end
			return { artifact = result.outputs.artifact }
		end,
	})
end
local function product_options(spec, info, native)
	return {
		namespace = "odin",
		target_slug = string.gsub(spec.path, "[^%w_]", "_"),
		executable_name = if core.platform_info().os == "windows" then "output.exe" else "output",
		shared_libraries = native.shared,
		bundle_display = `odin bundle {info.path}`,
	}
end
local function selected_paths()
	local inputs = {}
	for _, candidate in ipairs(packages) do
		inputs[candidate.key] = candidate.sources
	end
	return core.task({
		inputs = inputs,
		outputs = { paths = core.output.value() },
		run = function(exec, input)
			local paths = {}
			for key, handle in pairs(input) do
				paths[key] = exec.paths(handle)
			end
			return { paths = paths }
		end,
	}).outputs.paths
end
local function metadata_for(spec)
	return core.expand({
		inputs = {},
		create = function()
			local selected = selected_paths()
			local expanded = core.expand({
				inputs = { index = analysis_task.outputs.index, selected = selected },
				create = function(input)
					local info = analyze(spec, input.index, input.selected[spec.key])
					local native =
						resources(closure(spec, input.index, input.selected, core.configuration("odin") or {}).specs)
					local layout = package.binary_product_layout(product_options(spec, info, native))
					local metadata = core.task({
						outputs = { info = core.output.value() },
						run = function()
							return {
								info = {
									has_main = info.has_main,
									is_test = spec.test,
									executable_path = layout.published_executable_path,
								},
							}
						end,
					})
					return { metadata = { INFO = metadata.outputs.info } }
				end,
			})
			return { metadata = { INFO = expanded:get("metadata", "INFO") } }
		end,
	}):get("metadata", "INFO")
end
local function actions(spec, index, selected)
	local info = analyze(spec, index, selected[spec.key])
	assert(
		#info.paths > 0,
		if spec.test
			then `odin_test_package at '{spec.path}' has no Odin source files; default globs are *_test.odin and test_*.odin; pass srcs for other names`
			else `odin_package at '{spec.path}' has no Odin source files; ordinary packages exclude test files`
	)
	local config = core.configuration("odin") or {}
	local sources = closure(spec, index, selected, config)
	local native = resources(sources.specs)
	local built = compile(spec, info, sources, native, config, "build")
	local product = built.outputs.artifact
	local executable_path
	if info.has_main then
		local plan = package.binary_product(product_options(spec, info, native))
		local result = plan.finish(product)
		product, executable_path = result.artifact, result.executable_path
	end
	local value = {
		[build.BUILD] = product,
		[package.PACKAGE] = product,
		[lint.LINT] = compile(spec, info, sources, native, config, "lint").outputs.result,
	}
	if spec.test then
		value[test.TEST] = compile(spec, info, sources, native, config, "test").outputs.units
	elseif info.has_main then
		value[run.RUN] = core.program({
			inputs = { artifact = product, sh = core.native_tool("sh") },
			describe = function(exec, input)
				return {
					argv = {
						"sh",
						"-c",
						'program=$1; shift; exec "$IMP_SANDBOX_ROOT/$program" "$@"',
						"odin-run",
						executable_path or exec.path(input.artifact),
					},
					inputs = { exec.digest(input.artifact) },
					tools = { input.sh },
					display = `odin run {info.path}`,
				}
			end,
		})
	end
	return value
end
local function expansion_for(spec)
	-- The outer expansion runs after all BUILD modules load. It declares exact
	-- source-list inputs for the inner expansion, including later packages.
	return core.expand({
		inputs = {},
		create = function()
			local selected = selected_paths()
			local expanded = core.expand({
				inputs = { index = analysis_task.outputs.index, selected = selected },
				create = function(input)
					return { actions = actions(spec, input.index, input.selected) }
				end,
			})
			local roots = {
				[build.BUILD] = expanded:get("actions", build.BUILD),
				[package.PACKAGE] = expanded:get("actions", package.PACKAGE),
				[lint.LINT] = expanded:get("actions", lint.LINT),
			}
			if spec.test then
				roots[test.TEST] = expanded:get("actions", test.TEST)
			end
			return { actions = roots }
		end,
	})
end
-- RUN has dynamic membership: a library has no executable to launch.
local function run_for(spec)
	return core.expand({
		inputs = {},
		create = function()
			local selected = selected_paths()
			local programs = core.expand({
				inputs = { index = analysis_task.outputs.index, selected = selected },
				create = function(input)
					if not analyze(spec, input.index, input.selected[spec.key]).has_main then
						return {}
					end
					return { program = { [run.RUN] = actions(spec, input.index, input.selected)[run.RUN] } }
				end,
			})
			return { programs = { [run.RUN] = programs:all(run.RUN) } }
		end,
	}):get("programs", run.RUN)
end
--- Declare an Odin package with source, dependency, and toolchain options.
local function odin_package(options, is_test)
	options = options or {}
	local base = options.base or core.package_path()
	local provider = options.toolchain
	if provider == nil or type(provider) == "string" then
		provider = tools.graph_toolchain(provider)
	end
	assert(
		type(provider) == "table" and provider.kind == "odin-toolchain" and type(provider.tool) == "userdata",
		"Odin toolchain requires a version string or an Odin provider"
	)
	local spec = {
		key = `package_{#packages + 1}`,
		base = base,
		path = join(base, options.path or "."),
		srcs = table.clone(options.srcs or (if is_test then EXCLUDE else { "*.odin" })),
		exclude = table.clone(options.exclude or (if is_test then {} else EXCLUDE)),
		collections = table.clone(options.collections or {}),
		deps = table.clone(options.deps or {}),
		defines = defines(options.defines),
		toolchain = provider,
		test = is_test == true,
		unsafe_system_paths = options.unsafe_system_paths == true,
	}
	if #spec.srcs == 0 then
		spec.srcs = { "*.odin" }
	end
	spec.sources = core.files({ root = spec.path, include = spec.srcs, exclude = spec.exclude })
	spec.generated = codegen.normalize_generated_srcs(options.generated_srcs, {
		rule = "odin_package",
		resolve_path = function(path)
			return join(spec.path, path)
		end,
	})
	table.insert(packages, spec)
	local expanded = expansion_for(spec)
	local value = {
		odin_spec = spec,
		sources = spec.sources,
		base = base,
		version = provider.version,
		[build.BUILD] = expanded:get("actions", build.BUILD),
		[package.PACKAGE] = expanded:get("actions", package.PACKAGE),
		[lint.LINT] = expanded:get("actions", lint.LINT),
	}
	if is_test then
		value[test.TEST] = expanded:get("actions", test.TEST)
	else
		value[run.RUN] = run_for(spec)
	end
	for _, hook in ipairs(hooks) do
		for name, field in
			pairs(hook(table.freeze({ sources = spec.sources, base = base, version = provider.version }), function()
				return metadata_for(spec)
			end))
		do
			value[name] = field
		end
	end
	return table.freeze(value)
end
return {
	odin_package = odin_package,
	odin_test_package = function(options)
		return odin_package(options, true)
	end,
	register_odin_package_hook = function(hook)
		assert(type(hook) == "function", "Odin package hook requires a function")
		if not table.find(hooks, hook) then
			table.insert(hooks, hook)
		end
	end,
	package_specs = function()
		return table.clone(packages)
	end,
	join = join,
	dirname = dirname,
	define_args = define_args,
	defines = defines,
	analyze = analyze,
	resolve_import = resolve_import,
	collection_map = collection_map,
	closure = closure,
	resources = resources,
	merged_defines = merged_defines,
	library_env = library_env,
	test_out_args = test_out_args,
}
