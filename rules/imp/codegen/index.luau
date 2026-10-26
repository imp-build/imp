-- Generic in-graph source generation: run a generator in a sandboxed action
-- and give the outputs to a language rule as declared sources.
--
-- This is the sibling of `generated_files()` in @imp/rules/imp/generate. Both
-- declare files that a command produces. They differ only in where the files
-- go:
--
--   generated_files()  the workspace. The `GENERATE` root of `imp generate`,
--                      for committed, drift-gated code generation.
--   codegen()          the graph. A package (for example the
--                      `generated_srcs` of a language rule) stages it into its
--                      sandbox. No file goes into the workspace.
--
-- That difference decides the return shape. `generated_files()` returns one
-- task handle, which resolves to its artifacts when the goal runs. A package
-- needs the artifact of each path while it declares the graph, so `codegen()`
-- returns the handle of each output slot in `files`.
--
-- The generator is an ordinary sandboxed action with declared tools. On
-- purpose, there is no Luau-callback form: it would run workspace code inside
-- the build engine and not in the sandbox. Use `@imp/rules/imp/self-tool` to
-- run Imp itself as a generator.
--
-- `stamp_file()` is the simplest case of the same idea: the output is fixed
-- text, so there is no generator command and no declared tool.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local codegen_workflow = require("@imp/rules/workflows/codegen")
local generate = require("@imp/rules/imp/generate")
local output = core.output

--- Declare generated sources that stay in the graph.
---
---   local codegen = require("@imp/rules/imp/codegen").codegen
---
---   local bindings = codegen({
---       display = "generate Odin bindings",
---       tools = { python3 = core.native_tool("python3") },
---       inputs = { schema = core.files({ include = { "schema.json" } }) },
---       output_paths = { "app/generated/bindings.odin" },
---       argv = function(_exec, _resolved)
---           return { "python3", "tools/schema_to_odin.py", "schema.json", "app/generated/bindings.odin" }
---       end,
---   })
---
--- `output_paths` are workspace-relative, and they are the contract: a
--- package stages each artifact at exactly that path, so a path has one
--- owner. Exclude a generated path from each glob that could also include it.
---
--- A nested output path needs no `mkdir`. The executor creates the parent
--- directory of each declared file output before it starts the program.
---
--- Options are as for `generated_files()`: `display`, `tools`, `inputs`,
--- `output_paths`, and `argv`.
---
--- Returns a frozen table `{ paths, files, BUILD, CODEGEN }`.
--- `files[path]` is the artifact handle of that output path. `BUILD` builds
--- the generator and writes nothing to the workspace. `CODEGEN` holds the
--- same generator task and makes it selectable with `imp codegen`, which
--- exports the files below `dist/codegen/`.
local function codegen(options)
	local generator, plan, output_paths = generate.generator_task("codegen", options)
	local files = {}
	for index, path in ipairs(output_paths) do
		files[path] = generator.outputs[plan.slots[index]]
	end
	return table.freeze({
		paths = table.freeze(table.clone(output_paths)),
		files = table.freeze(files),
		[build.BUILD] = generator,
		[codegen_workflow.CODEGEN] = generator,
	})
end

local function is_codegen_result(entry)
	return type(entry) == "table"
		and table.isfrozen(entry)
		and type(entry.paths) == "table"
		and type(entry.files) == "table"
		and entry[codegen_workflow.CODEGEN] ~= nil
end

--- Normalize the `generated_srcs` list of a rule into the shape of the
--- staging contract: an array of `{ artifact, expected_path }`, where
--- `expected_path` is the workspace-relative path of the artifact.
---
--- An entry is a `codegen()` result, which gives one pair for each output
--- path, or a `{ artifact, path }` table. `resolve_path` changes the
--- rule-relative `path` of such a table to a workspace-relative path. Its
--- default returns the path unchanged.
---
--- This function is internal to the language rules that consume generated
--- sources. It is not part of the public API.
---
--- Options: `rule` (the consuming rule name, for error messages) and
--- optional `resolve_path`.
local function normalize_generated_srcs(entries, options)
	options = options or {}
	local resolve_path = options.resolve_path or function(path)
		return path
	end
	local normalized = {}
	for index, entry in ipairs(entries or {}) do
		if is_codegen_result(entry) then
			for _, expected_path in ipairs(entry.paths) do
				table.insert(normalized, { artifact = entry.files[expected_path], expected_path = expected_path })
			end
		elseif
			type(entry) == "table"
			and type(entry.artifact) == "userdata"
			and type(entry.path) == "string"
			and entry.path ~= ""
		then
			table.insert(normalized, { artifact = entry.artifact, expected_path = resolve_path(entry.path) })
		else
			error(
				`{options.rule} generated_srcs[{index}] must be a codegen() result, or `
					.. '{ artifact = <graph handle>, path = "<relative path>" }',
				2
			)
		end
	end
	return normalized
end

--- Remove generated sources that repeat one workspace path, and reject a
--- conflict: two different artifacts at the same path. In the sandbox, one
--- would overwrite the other, and the input order would select the result.
---
--- Options: `rule` (the consuming rule name, for error messages).
local function dedupe_generated_srcs(list, options)
	options = options or {}
	local by_path = {}
	local deduped = {}
	for _, generated in ipairs(list or {}) do
		local current = by_path[generated.expected_path]
		if current == nil then
			by_path[generated.expected_path] = generated
			table.insert(deduped, generated)
		elseif not rawequal(current.artifact, generated.artifact) then
			error(
				`{options.rule}: two different generated sources cannot claim one `
					.. `workspace path ('{generated.expected_path}')`,
				2
			)
		end
	end
	return deduped
end

--- The run-time half of the staging contract: a generated source artifact
--- must be at exactly the workspace path that its entry declared, because a
--- compiler finds only the files that are in the package directory. A rule
--- calls this function in its task `run` callback, when it knows the sandbox
--- path (`exec.path(handle)`).
local function assert_generated_src_path(rule, index, actual, expected)
	if actual ~= expected then
		error(
			`{rule} generated_srcs[{index}] artifact's real path '{actual}' does `
				.. `not match its declared path ('{expected}') - the generating `
				.. "action's output.file() path must match",
			2
		)
	end
end

--- Declare a graph artifact that contains fixed text.
---
--- This is the simplest `codegen()`: the content is a literal, so there is no
--- generator command and no declared tool. `argv[0]` is a bare `sh`, the
--- shell that the executor finds.
---
--- Options: `output` (the workspace-relative output path) and `text`.
---
--- Returns a frozen `{ file, BUILD }` with the file artifact and its build
--- root.
local function stamp_file(options)
	local output_path = options.output
	local text = options.text
	if type(output_path) ~= "string" or #output_path == 0 then
		error("stamp_file(options) requires a non-empty output", 2)
	end
	if type(text) ~= "string" then
		error("stamp_file(options) requires a text string", 2)
	end
	local stamp = core.task({
		outputs = { file = output.artifact() },
		run = function(exec)
			local result = exec.action({
				display = `write {output_path}`,
				argv = { "sh", "-c", 'printf \'%s\\n\' "$2" > "$1"', "imp-stamp", output_path, text },
				outputs = { file = output.file(output_path) },
			})
			return { file = result.outputs.file }
		end,
	})
	return table.freeze({ file = stamp.outputs.file, [build.BUILD] = stamp.outputs.file })
end

return {

	--- @category target
	codegen = codegen,
	normalize_generated_srcs = normalize_generated_srcs,
	dedupe_generated_srcs = dedupe_generated_srcs,
	assert_generated_src_path = assert_generated_src_path,

	--- @category target
	stamp_file = stamp_file,
}
