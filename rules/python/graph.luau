-- Python application artifacts and pytest execution units.
local core = require("@imp/core")
local project = require("@imp/rules/python/project")
local runtime = require("@imp/rules/python/runtime")
local uv = require("@imp/rules/python/uv_toolchain")
local pex = require("@imp/rules/python/pex_toolchain")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local run = require("@imp/rules/workflows/run")
local test = require("@imp/rules/workflows/test")
local app_hooks, test_hooks = {}, {}
local function register(hooks, hook)
	assert(type(hook) == "function", "Python hook expects a function")
	if not table.find(hooks, hook) then table.insert(hooks, hook) end
end
local function patterns(value)
	value = value or { "*.py" }
	assert(type(value) == "table" and #value > 0, "Python sources require source glob patterns")
	for _, pattern in ipairs(value) do assert(type(pattern) == "string" and pattern ~= "", "Python sources expect non-empty glob patterns") end
	return table.clone(value)
end
local function spec_for(options, api)
	local ref = if options.project then project.assert_python_project(options.project, api) else project.infer_python_project(options.base or core.package_path(), api)
	return { project = ref, sources = patterns(options.sources), python_version = options.python_version or runtime.default_python_runtime_version(),
		uv = uv.graph_toolchain(options.uv_version), deps = table.clone(options.deps or {}) }
end
local function venv_python()
	return if core.platform_info().os == "windows" then ".venv/Scripts/python.exe" else ".venv/bin/python"
end
local function inputs_for(spec)
	local inputs = { sources = core.files({ root = spec.project.path, include = spec.sources }),
		workspace = project.python_workspace_sources(spec.project.workspace), uv = spec.uv.tool, uv_cache = spec.uv.cache_tool,
		sh = core.native_tool("sh") }
	for index, dep in ipairs(spec.deps) do inputs[`dep{index}`] = dep end
	return inputs
end
local function extend(value, hooks, sources)
	for _, hook in ipairs(hooks) do
		local info = table.clone(value)
		info.source_patterns = sources
		for key, field in pairs(hook(table.freeze(info))) do value[key] = field end
	end
	return table.freeze(value)
end
--- Declare a PEX app. Options: project, base, sources, entry_point,
--- python_version, uv_version, pex_version, extra_pex_args, and deps.
--- Return sources, python_sources, root, BUILD, PACKAGE, and RUN.
local function python_app(options)
	options = options or {}
	local spec = spec_for(options, "python_app")
	local selected_pex = pex.graph_toolchain(options.pex_version)
	local entry_point = options.entry_point or ""
	local extra_pex_args = table.clone(options.extra_pex_args or {})
	local inputs = inputs_for(spec)
	inputs.pex, inputs.pex_cache = selected_pex.tool, selected_pex.cache_tool
	local built = core.task({
		display = `python-app build {spec.project.path}`, inputs = inputs, outputs = { artifact = core.output.artifact() },
		run = function(exec, input)
			local argv = { "sh", "-c",
				'project=$1; workspace=$2; uv=$3; pex=$4; out=$5; version=$6; entry=$7; pexargs=$8; venvpy=$9; stage=${10}; "$uv" sync --project "$workspace" --all-packages --locked --no-dev --no-progress --managed-python --python "$version" && "$workspace/$venvpy" "$pex" --venv-repository="$workspace/.venv" --no-transitive --pre -o "$out" ${entry:+-e "$entry"} -D "$stage" $pexargs',
				"python-app-build", spec.project.path, spec.project.workspace.path, uv.uv_bin(exec, input.uv), pex.pex_bin(exec, input.pex),
				".imp-out/app.pex", spec.python_version, entry_point, table.concat(extra_pex_args, " "), venv_python(), ".imp-pex-sources" }
			local env = uv.cache_env(exec, input.uv_cache)
			for key, value in pairs(pex.cache_env(exec, input.pex_cache)) do env[key] = value end
			-- UV needs sources at their project paths; PEX needs a separate source tree.
			local result = exec.action({ argv = argv, env = env, inputs = { input.workspace, input.sources, { source = input.sources, from = spec.project.path, to = ".imp-pex-sources" } },
				outputs = { artifact = core.output.file(".imp-out/app.pex") } })
			return { artifact = result.outputs.artifact }
		end,
	})
	local program = core.program({
		inputs = { app = built.outputs.artifact, uv = spec.uv.tool, cache = spec.uv.cache_tool, sh = core.native_tool("sh") },
		describe = function(exec, input)
			local env = uv.cache_env(exec, input.cache)
			env.IMP_PYTHON_BUILD_VERSION = spec.python_version
			return { argv = { "sh", "-c", 'prog=$1; ver=$2; uv=$3; shift 3; exec "$uv" run --no-project --managed-python --python "$ver" -- "$IMP_SANDBOX_ROOT/$prog" "$@"',
				"python-run", exec.path(input.app), spec.python_version, uv.uv_bin(exec, input.uv) },
				inputs = { exec.digest(input.app) }, tools = { input.sh, input.uv, input.cache }, env = env, display = `python run {spec.project.path}` }
		end,
	})
	return extend({ sources = inputs.sources, python_sources = inputs.sources, root = spec.project.path,
		[build.BUILD] = built.outputs.artifact, [package.PACKAGE] = built.outputs.artifact, [run.RUN] = program }, app_hooks, spec.sources)
end
--- Declare pytest units. Options: project, base, sources, test_args,
--- python_version, uv_version, and deps. Return root and TEST.
local function python_test(options)
	options = options or {}
	local spec = spec_for(options, "python_test")
	local test_args = table.clone(options.test_args or {})
	local inputs = inputs_for(spec)
	local tested = core.task({
		display = `python test {spec.project.path}`, inputs = inputs, outputs = { units = core.output.value() },
		run = function(exec, input)
			local result = exec.action({ argv = { "sh", "-c",
				'project=$1; workspace=$2; uv=$3; testargs=$4; version=$5; venvpy=$6; "$uv" sync --project "$workspace" --all-packages --locked --no-progress --managed-python --python "$version" && "$workspace/$venvpy" -m pytest "$project" -rA $testargs',
				"python-test", spec.project.path, spec.project.workspace.path, uv.uv_bin(exec, input.uv), table.concat(test_args, " "), spec.python_version, venv_python() },
				inputs = { input.workspace, input.sources }, env = uv.cache_env(exec, input.uv_cache), allow_failure = true })
			local seen, failed, paths = {}, {}, {}
			for line in string.gmatch(result.stdout .. "\n", "([^\n]*)\n") do
				local outcome, node = string.match(line, "^(%u+)%s+(%S+)")
				if outcome == "PASSED" or outcome == "FAILED" or outcome == "ERROR" then
					local separator = string.find(node, "::", 1, true)
					local file = if separator then string.sub(node, 1, separator - 1) else node
					if not seen[file] then seen[file] = true table.insert(paths, file) end
					if outcome ~= "PASSED" then failed[file] = true end
				end
			end
			local combined = result.stdout .. (if result.stderr == "" then "" else "\n" .. result.stderr)
			if #paths == 0 then return { units = if result.exit_code == 0 then {} else { { name = spec.project.path, ok = false, output = combined } } } end
			table.sort(paths)
			local units = {}
			for _, path in ipairs(paths) do table.insert(units, { name = path, ok = not failed[path], output = if failed[path] then combined else nil }) end
			return { units = units }
		end,
	})
	local value = { root = spec.project.path, [test.TEST] = tested.outputs.units }
	for _, hook in ipairs(test_hooks) do
		local info = table.clone(value)
		info.python_sources, info.source_patterns = inputs.sources, spec.sources
		for key, field in pairs(hook(table.freeze(info))) do value[key] = field end
	end
	return table.freeze(value)
end
return { PYTHON_SOURCE_INCLUDES = table.freeze({ "*.py" }), python_app = python_app, python_test = python_test,
	register_python_app_hook = function(hook) register(app_hooks, hook) end,
	register_python_test_hook = function(hook) register(test_hooks, hook) end }
