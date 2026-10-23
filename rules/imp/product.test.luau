local core = require("@imp/core")

local function compute(value, on_run)
	return core.task({
		inputs = { value = value },
		outputs = { result = core.output.value() },
		run = function(_exec, inputs)
			if on_run then
				on_run()
			end
			return { result = inputs.value * 3 }
		end,
	}).outputs.result
end

local function consume(value)
	return core.task({
		inputs = { value = value },
		outputs = { result = core.output.value() },
		run = function(_exec, inputs)
			return { result = inputs.value }
		end,
	}).outputs.result
end

local function collect(first, second)
	return core.task({
		inputs = { first = first, second = second },
		outputs = { result = core.output.value() },
		run = function(_exec, inputs)
			return { result = { inputs.first, inputs.second } }
		end,
	}).outputs.result
end

return {
	core.test.suite("graph computation replaces products", {
		core.test.case("two consumers share one producer execution", function()
			local calls = 0
			local producer = compute(4, function()
				calls += 1
			end)
			local result = core.test.resolve(collect(consume(producer), consume(producer)))
			assert(result[1] == 12, tostring(result[1]))
			assert(result[2] == 12, tostring(result[2]))
			assert(calls == 1, tostring(calls))
		end),

		core.test.case("different declared inputs produce different results", function()
			local result = core.test.resolve(collect(compute(1), compute(2)))
			assert(result[1] == 3, tostring(result[1]))
			assert(result[2] == 6, tostring(result[2]))
		end),
	}),
}
