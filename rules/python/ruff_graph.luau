-- Ruff tasks preserve source selection and configuration discovery.
local core = require("@imp/core")
local ruff = require("@imp/rules/python/ruff_toolchain")
local CONFIG_NAMES = { "pyproject.toml", "ruff.toml", ".ruff.toml" }
local function configs(root, patterns)
	local result = {}
	local parts = {}
	for part in string.gmatch(root, "[^/]+") do
		if part ~= "." then table.insert(parts, part) end
	end
	for count = #parts, 0, -1 do
		local directory = if count == 0 then "." else table.concat(parts, "/", 1, count)
		table.insert(result, core.files({ root = directory, include = CONFIG_NAMES }))
	end
	local seen, include = {}, {}
	for _, pattern in ipairs(patterns) do
		local directory = string.match(pattern, "^(.+)/[^/]*$")
		if directory and not seen[directory] then
			seen[directory] = true
			for _, name in ipairs(CONFIG_NAMES) do table.insert(include, directory .. "/" .. name) end
		end
	end
	if #include > 0 then table.insert(result, core.files({ root = root, include = include })) end
	return result
end
local function ruff_root(source, kind)
	local formatting = kind == "fmt"
	local input = { sources = source.python_sources, ruff = ruff.graph_toolchain().tool, sh = core.native_tool("sh") }
	local selected = configs(source.root, source.source_patterns)
	for index, files in ipairs(selected) do input[`config{index}`] = files end
	return core.task({
		display = `ruff {kind} {source.root}`, inputs = input, outputs = { result = core.output.value() },
		run = function(exec, inputs)
			local paths = exec.paths(inputs.sources)
			local flags = core.goal_flags()
			local requested = (if formatting then flags.check else flags.fix) == true
			if #paths == 0 then
				return { result = if formatting then { paths = paths, check = { requested = requested, failed = false } }
					else { ok = true, output = "", paths = paths, fix_applied = false } }
			end
			local before = if formatting then exec.digest(inputs.sources) else nil
			local function staged(files)
				return if formatting then files else { source = files, from = ".", to = "fixed" }
			end
			local action_inputs = { staged(inputs.sources) }
			for index = 1, #selected do table.insert(action_inputs, staged(inputs[`config{index}`])) end
			local script = if formatting then
				'mode=$1; shift; ruff format --no-cache "$@" ${mode:+--check}'
				else 'mode=$1; shift; cd fixed && ruff check --no-cache --color=always "$@" ${mode:+--fix}'
			local argv = { "sh", "-c", script, `ruff-{kind}`, if requested then "1" else "" }
			for _, path in ipairs(paths) do table.insert(argv, path) end
			local result = exec.action({
				argv = argv, inputs = action_inputs, allow_failure = true,
				outputs = { [if formatting then "formatted" else "fixed"] = core.output.directory(if formatting then source.root else "fixed") },
			})
			local text = result.stdout .. (if result.stderr == "" then "" else "\n" .. result.stderr)
			if formatting then
				return { result = { formatted = { digest = exec.digest(result.outputs.formatted), path = source.root },
					sources_digest = before, paths = paths, check = { requested = requested, failed = result.exit_code ~= 0 }, output = text } }
			end
			return { result = { ok = result.exit_code == 0, output = text, paths = paths, fix_applied = requested,
				fixed = if requested then { digest = exec.digest(result.outputs.fixed), path = "fixed" } else nil } }
		end,
	}).outputs.result
end
return {
	ruff_fmt_root = function(source) return ruff_root(source, "fmt") end,
	ruff_lint_root = function(source) return ruff_root(source, "lint") end,
}
