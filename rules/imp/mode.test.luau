local core = require("@imp/core")
require("@imp/rules/imp/mode")

local function fails(fn, part)
	local ok, err = pcall(fn)
	assert(not ok and string.find(tostring(err), part, 1, true), tostring(err))
end

return {
	core.test.case("configured branches share tasks that read no axes", function()
		local runs = { leaf = 0, shared = 0 }
		local shared = core.task({
			outputs = { text = core.output.value() },
			run = function()
				runs.shared += 1
				return { text = "shared" }
			end,
		})
		local leaf = core.task({
			inputs = { opt = core.semantic.mode("opt"), shared = shared.outputs.text },
			outputs = { text = core.output.value() },
			run = function(_exec, input)
				runs.leaf += 1
				return { text = input.opt .. ":" .. input.shared }
			end,
		})
		local debug = core.configured(leaf, { opt = "debug" })
		local release = core.configured(leaf, { opt = "release" })
		assert(core.test.resolve(debug.outputs.text) == "debug:shared")
		assert(core.test.resolve(release.outputs.text) == "release:shared")
		assert(core.test.resolve(core.configured(release, { opt = "debug" }).outputs.text) == "debug:shared")
		assert(runs.leaf == 2 and runs.shared == 1)
	end),

	core.test.case("configured validates overrides", function()
		local task = core.task({ run = function() end })
		fails(function()
			core.configured(task, {})
		end, "must not be empty")
		fails(function()
			core.configured(task, { missing = "release" })
		end, "undeclared mode axis")
		fails(function()
			core.configured(task, { opt = "invalid" })
		end, "not a valid value")
		fails(function()
			core.configured(task, { opt = 2 })
		end, "map axis names to strings")
	end),

	core.test.case("configured rejects output-selection axes", function()
		core.define_mode_axis("mode_test_output", { kind = "output-select", ["default"] = "binary" })
		local task = core.task({ run = function() end })
		fails(function()
			core.configured(task, { mode_test_output = "binary" })
		end, "only accepts rebuild axes")
	end),

	core.test.case("mode declarations validate defaults", function()
		fails(function()
			core.define_mode_axis("invalid_axis", { kind = "rebuild", ["default"] = 2 })
		end, "must be a string")
		fails(function()
			core.define_mode_axis("invalid_axis", { kind = "rebuild", values = { "debug" }, ["default"] = "release" })
		end, "must be included")
	end),
}
