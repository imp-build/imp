-- Canonical public entrypoint for generated-file graph roots.
local core = require("@imp/core")
local output = core.output

local function sorted_keys(map)
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

--- Validate the options that `generated_files()` and the `codegen()` of
--- @imp/rules/imp/codegen have in common, and name one action output slot for
--- each output path.
---
--- The two functions differ only in where their outputs go: the workspace,
--- or the graph. Thus they share one set of rules about what a caller can
--- declare. This function is internal to the two generator entrypoints. It is
--- not part of the public rule API.
---
--- Returns `{ tool_names, input_names, slots }`.
local function plan_generated_outputs(api, options)
	local tools = options.tools or {}
	local inputs = options.inputs or {}
	local output_paths = options.output_paths
	if type(output_paths) ~= "table" or #output_paths == 0 then
		error(`{api}() requires a non-empty output_paths array`, 3)
	end
	if type(options.argv) ~= "function" then
		error(`{api}() requires an argv(exec, inputs) function`, 3)
	end
	local tool_names = sorted_keys(tools)
	local input_names = sorted_keys(inputs)
	for _, name in ipairs(input_names) do
		if tools[name] ~= nil then
			error(`{api}() got the same name in tools and inputs: {name}`, 3)
		end
	end
	local seen = {}
	local slots = {}
	for index, path in ipairs(output_paths) do
		if type(path) ~= "string" or #path == 0 then
			error(`{api}() output_paths must be non-empty strings`, 3)
		end
		if seen[path] then
			error(`{api}() declares the output path '{path}' twice`, 3)
		end
		seen[path] = true
		-- Action output slot names must match [A-Za-z0-9_.-], and output
		-- paths do not. Thus the slots are indexed and map back to their path.
		slots[index] = `out{index}`
	end
	return { tool_names = tool_names, input_names = input_names, slots = slots }
end

--- Declare a task that runs the generator and returns one artifact for each
--- output path. This function is internal to the generator entrypoints.
local function generator_task(api, options)
	local plan = plan_generated_outputs(api, options)
	local tools = options.tools or {}
	local inputs = options.inputs or {}
	local output_paths = table.clone(options.output_paths)
	local argv = options.argv
	local display = options.display or `generate {table.concat(output_paths, " ")}`
	local task_inputs = {}
	local task_outputs = {}
	for _, name in ipairs(plan.tool_names) do
		task_inputs[name] = tools[name]
	end
	for _, name in ipairs(plan.input_names) do
		task_inputs[name] = inputs[name]
	end
	for _, slot in ipairs(plan.slots) do
		task_outputs[slot] = output.artifact()
	end
	local generator = core.task({
		inputs = task_inputs,
		outputs = task_outputs,
		run = function(exec, resolved)
			local action_inputs = {}
			for _, name in ipairs(plan.input_names) do
				table.insert(action_inputs, resolved[name])
			end
			local action_outputs = {}
			for index, slot in ipairs(plan.slots) do
				action_outputs[slot] = output.file(output_paths[index])
			end
			local result = exec.action({
				display = display,
				argv = argv(exec, resolved),
				inputs = action_inputs,
				outputs = action_outputs,
			})
			local outputs = {}
			for _, slot in ipairs(plan.slots) do
				outputs[slot] = result.outputs[slot]
			end
			return outputs
		end,
	})
	return generator, plan, output_paths
end

--- Declare a graph-native generated-files root.
---
--- The result is a task handle for the `GENERATE` slot of
--- @imp/rules/workflows/generate. The task has one artifact output for each
--- output path, and a `before` value: the CAS digest of the same paths in the
--- workspace when the goal ran. The goal reads the path of each file from its
--- artifact. The generator stays hermetic and cacheable: it runs in a
--- sandbox, keeps its outputs in CAS, and does not know about the `check`
--- flag. Thus `imp generate` and `imp generate --check` share one cache
--- entry. The workflow compares the outputs with the workspace and writes
--- them at the goal boundary.
---
--- A separate task captures the current workspace files of `output_paths`.
--- Thus a change to a generated file in the workspace does not change the
--- cache key of the generator. The capture uses the workspace file walk, so
--- a gitignored output path is always reported as stale. The capture reads
--- each output path as a glob pattern, so an output path must not contain
--- `*`, `?`, `[`, `]`, `{`, or `}`.
---
--- Options:
---   display       Optional action label.
---   tools         Optional table of named tool handles. Each tool is on PATH
---                 when the generator runs.
---   inputs        Optional table of named source handles that the generator
---                 reads.
---   output_paths  Workspace-relative paths that the generator writes.
---   argv          `function(exec, resolved)` that returns the generator
---                 command line.
---
--- Example (`ci/BUILD.luau`):
---
---   local generate = require("@imp/rules/imp/generate")
---   local workflow = require("@imp/rules/workflows/generate")
---
---   return {
---       docs_workflow = {
---           [workflow.GENERATE] = generate.generated_files({
---               display = "generate GitHub workflows",
---               tools = { python3 = core.native_tool("python3") },
---               inputs = { script = core.files({ include = { SCRIPT } }) },
---               output_paths = { ".github/workflows/docs.yml" },
---               argv = function(_exec, _resolved)
---                   return { "python3", SCRIPT, ".github/workflows/docs.yml" }
---               end,
---           }),
---       },
---   }
local function generated_files(options)
	local generator, plan = generator_task("generated_files", options)
	-- The workspace capture reads `output_paths` as include patterns.
	for _, path in ipairs(options.output_paths) do
		if string.find(path, "[%*%?%[%]{}]") then
			error(`generated_files() output path '{path}' must not contain a glob character`, 2)
		end
	end
	local current = core.files({ root = ".", include = table.clone(options.output_paths) })
	local snapshot = core.task({
		inputs = { current = current },
		outputs = { digest = output.value() },
		run = function(exec, resolved)
			return { digest = exec.digest(resolved.current) }
		end,
	})
	local collect_inputs = { before = snapshot.outputs.digest }
	local collect_outputs = { before = output.value() }
	for _, slot in ipairs(plan.slots) do
		collect_inputs[slot] = generator.outputs[slot]
		collect_outputs[slot] = output.artifact()
	end
	return core.task({
		inputs = collect_inputs,
		outputs = collect_outputs,
		run = function(_exec, resolved)
			local result = { before = resolved.before }
			for _, slot in ipairs(plan.slots) do
				result[slot] = resolved[slot]
			end
			return result
		end,
	})
end

--- Return the generated files of a resolved generator root, sorted by path:
--- an array of `{ path, digest }`. A goal receives each artifact as a
--- `{ type = "artifact", digest, path }` table, and `path` is the declared
--- output path. A root with one output resolves to that artifact.
local function generated_root_files(result)
	if type(result) ~= "table" then
		return nil
	end
	local candidates = if result.type == "artifact" then { result } else result
	local files = {}
	for _, value in pairs(candidates) do
		if type(value) == "table" and value.type == "artifact" then
			if type(value.path) ~= "string" or type(value.digest) ~= "string" or value.digest == "" then
				return nil
			end
			table.insert(files, { path = value.path, digest = value.digest })
		end
	end
	if #files == 0 then
		return nil
	end
	table.sort(files, function(left, right)
		return left.path < right.path
	end)
	return files
end

--- Report whether the generated content at `digest` differs from the
--- workspace content at `path`. `before` is the CAS digest of the workspace
--- files, as a `generated_files()` result gives it. A missing file is stale.
local function generated_file_is_stale(path, before, digest)
	local changes = core.diff_digests(before, digest)
	-- When a full subtree is added or removed (for example, the output
	-- directory did not exist before the first run), the diff reports that
	-- ancestor and not each file in it. `path` is the exact file, so it is
	-- stale when a change names the path or one of its ancestors.
	for _, change in ipairs(changes) do
		if change.path == path or string.sub(path, 1, #change.path + 1) == change.path .. "/" then
			return true
		end
	end
	return false
end

return {
	plan_generated_outputs = plan_generated_outputs,
	generator_task = generator_task,

	--- @category target
	generated_files = generated_files,
	generated_root_files = generated_root_files,
	generated_file_is_stale = generated_file_is_stale,
}
