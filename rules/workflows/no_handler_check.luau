local core = require("@imp/core")
local self_tool = require("@imp/rules/imp/self-tool")

local workspace = [[require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/lint")
return {}
]]
local build_only = [[local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local targets = { built = { [build.BUILD] = core.task({ run = function() end }) } }
]]
local checked = [[targets.checked = {
    [fmt.FMT] = core.task({ outputs = { result = core.output.value() }, run = function() return { result = { paths = {} } } end }).outputs.result,
    [lint.LINT] = core.task({ outputs = { result = core.output.value() }, run = function() return { result = { ok = true } } end }).outputs.result,
}
]]

local function invoke(goal, handlers)
	local probe = core.task({
		inputs = {
			imp = self_tool.imp_tool,
			sh = core.native_tool("sh"),
			rules = core.builtin_files({ include = { "workflows/fmt/index.luau", "workflows/lint/index.luau", "workflows/build/index.luau", "workflows/report.luau" } }),
			goal = goal,
			build = build_only .. (if handlers then checked else "") .. "return targets\n",
		},
		outputs = { result = core.output.value() },
		run = function(exec, inputs)
			local result = exec.action({
				argv = { "sh", "-c", 'printf "%s" "$1" > imp.workspace.luau; printf "%s" "$2" > BUILD.luau; exec imp "$3" //...', "fixture", workspace, inputs.build, inputs.goal },
				inputs = { inputs.rules },
				tools = { inputs.imp, inputs.sh },
				env = { IMP_RUNTIME = "luau", IMP_RULES_DIR = "." },
				allow_failure = true,
				display = `check {inputs.goal} missing-handler warning`,
			})
			return { result = { code = result.exit_code, stdout = result.stdout, stderr = result.stderr } }
		end,
	})
	return probe.outputs.result
end

local probes = {}
for _, goal in ipairs({ "fmt", "lint" }) do
	probes[goal .. "_missing"] = invoke(goal, false)
	probes[goal .. "_handled"] = invoke(goal, true)
end
return core.task({
	inputs = probes,
	outputs = { units = core.output.value() },
	run = function(_, inputs)
		local units = {}
		for _, goal in ipairs({ "fmt", "lint" }) do
			for _, kind in ipairs({ "missing", "handled" }) do
				local result = inputs[goal .. "_" .. kind]
				local ok, failure = pcall(function()
					assert(result.code == 0, result.stdout .. result.stderr)
					if kind == "missing" then
						local warning = `warning: goal '{goal}' matched targets, but none has a handler for this goal; a handler import may be missing`
						local first, last = string.find(result.stderr, warning, 1, true)
						assert(first ~= nil, result.stderr)
						assert(string.find(result.stderr, warning, last + 1, true) == nil, result.stderr)
						assert(string.find(result.stdout, warning, 1, true) == nil, result.stdout)
					else
						assert(string.find(result.stderr, "handler import may be missing", 1, true) == nil, result.stderr)
						assert(string.find(result.stdout, `{goal}: 1`, 1, true) ~= nil, result.stdout)
					end
				end)
				table.insert(units, {
					name = `{goal} {kind} handler`,
					ok = ok,
					output = if ok then nil else tostring(failure),
				})
			end
		end
		return { units = units }
	end,
}).outputs.units
