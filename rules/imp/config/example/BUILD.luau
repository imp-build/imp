local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
require("@imp/rules/imp/mode")

local function stamp(name, inputs)
	inputs.sh = core.native_tool("sh")
	return core.task({
		inputs = inputs,
		outputs = { artifact = core.output.artifact(), text = core.output.value() },
		run = function(exec, resolved)
			local text = name .. ":" .. (resolved.opt or "none")
			local path = "config-probe-" .. name .. ".txt"
			local result = exec.action({
				argv = { "sh", "-c", 'printf %s "$1" > "$2"', "config-probe", text, path },
				outputs = { file = core.output.file(path) },
				display = "config-probe " .. text,
			})
			return { artifact = result.outputs.file, text = text }
		end,
	})
end

local leaf = stamp("leaf", { opt = core.semantic.mode("opt") })
local shared = stamp("shared", {})
local both = core.task({
	inputs = {
		debug = leaf.outputs.text,
		release = core.configured(leaf, { opt = "release" }).outputs.text,
		shared = shared.outputs.text,
	},
	outputs = { report = core.output.value() },
	run = function(_exec, resolved)
		return { report = resolved.debug .. "|" .. resolved.release .. "|" .. resolved.shared }
	end,
})

return { probe = { [build.BUILD] = both } }
