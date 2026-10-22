-- One graph-backed program for each direct Python source match.
local core = require("@imp/core")
local project = require("@imp/rules/python/project")
local runtime = require("@imp/rules/python/runtime")
local uv = require("@imp/rules/python/uv_toolchain")
local run = require("@imp/rules/workflows/run")
-- Internal constructor, exported for rule tests. BUILD authors use python_sources.
local function source_program(spec, file)
	local inputs = { sources = core.files({ root = spec.root, include = spec.sources }),
		uv = spec.uv.tool, cache = spec.uv.cache_tool, sh = core.native_tool("sh") }
	if spec.project then inputs.workspace = project.python_workspace_sources(spec.project.workspace) end
	for index, dep in ipairs(spec.deps) do inputs[`dep{index}`] = dep end
	return core.program({ inputs = inputs, describe = function(exec, input)
		local tools = { input.sh, input.uv, input.cache }
		for index in ipairs(spec.deps) do table.insert(tools, input[`dep{index}`]) end
		local digests = { exec.digest(input.sources) }
		if input.workspace then table.insert(digests, exec.digest(input.workspace)) end
		local workspace = if spec.project then spec.project.workspace.path else ""
		local python = if core.platform_info().os == "windows" then ".venv/Scripts/python.exe" else ".venv/bin/python"
		local env = uv.cache_env(exec, input.cache)
		local argv = { "sh", "-c",
			'file=$1; root=$2; workspace=$3; venvpy=$4; version=$5; uv=$6; shift 6; cd "$IMP_SANDBOX_ROOT" && export PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" && if [ -n "$workspace" ]; then "$uv" sync --project "$workspace" --all-packages --locked --no-progress --no-install-workspace --managed-python --python "$version" && "$workspace/$venvpy" "$file" "$@"; else exec "$uv" run --no-project --managed-python --python "$version" -- "$file" "$@"; fi',
			"python-source-run", file, spec.root, workspace, python, spec.python_version, uv.uv_bin(exec, input.uv) }
		return { argv = argv, env = env, tools = tools, inputs = digests, display = `python run {file}` }
	end })
end
--- Declare shallow script run roots. Options: root, sources ({ "*.py" }),
--- project (inferred), and deps. Recursive patterns are not accepted.
local function python_sources(options)
	options = options or {}
	assert(type(options.root) == "string" and options.root ~= "", "python_sources requires a workspace-relative root")
	local root = project.python_workspace_ref(options.root).path
	local sources = options.sources or { "*.py" }
	assert(type(sources) == "table" and #sources > 0, "python_sources patterns must be direct")
	for _, pattern in ipairs(sources) do
		assert(type(pattern) == "string" and pattern ~= "" and not string.find(pattern, "**", 1, true), "python_sources patterns must be direct (no '**')")
	end
	local spec = { root = root, sources = table.clone(sources), deps = table.clone(options.deps or {}),
		project = if options.project then project.assert_python_project(options.project, "python_sources") else project.find_python_project(root),
		python_version = runtime.default_python_runtime_version(), uv = uv.graph_toolchain() }
	local discovered = core.task({
		inputs = { sources = core.files({ root = root, include = spec.sources }) },
		outputs = { paths = core.output.value() },
		run = function(exec, input) return { paths = exec.paths(input.sources) } end,
	})
	local expanded = core.expand({
		inputs = { paths = discovered.outputs.paths },
		create = function(input)
			local children = {}
			for _, file in ipairs(input.paths) do
				children[file] = { [run.RUN] = source_program(spec, file) }
			end
			return children
		end,
	})
	return table.freeze({ root = root, [run.RUN] = expanded:all(run.RUN) })
end
core.register_build_rule({ rule = "python_sources", module = "@imp/rules/python/source" })
return { python_sources = python_sources, source_program = source_program }
