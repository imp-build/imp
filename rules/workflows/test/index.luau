-- A selected `TEST` root resolves to a list of execution-unit results:
--
--   { { name, ok, output? } }
--
-- `output` is set only for a failing unit. The goal aggregates the units of
-- every selected root and reports them once, so that one failing root does
-- not hide the results of another root.
local core = require("@imp/core")
local report = require("@imp/rules/workflows/report")

--- Convert one action result into the shared test unit list. The action must
--- use `allow_failure = true`, so that a failing test does not stop the task.
local function test_vehicle(name, result)
	local ok = result.exit_code == 0
	local unit = { name = name, ok = ok }
	if not ok then
		local parts = {}
		for _, text in ipairs({ result.stdout, result.stderr }) do
			if text ~= nil and text ~= "" then
				table.insert(parts, text)
			end
		end
		unit.output = table.concat(parts, "\n")
	end
	return { unit }
end

--- True when `value` is a list of `{ name, ok, output? }` units.
local function is_unit_list(value)
	if type(value) ~= "table" then
		return false
	end
	local count = 0
	for _ in pairs(value) do
		count += 1
	end
	if count ~= #value then
		return false
	end
	for _, unit in ipairs(value) do
		if type(unit) ~= "table" or type(unit.name) ~= "string" or type(unit.ok) ~= "boolean" then
			return false
		end
	end
	return true
end

--- Aggregate the units of every selected `TEST` root and report once. The
--- report is returned when all units pass and raised as a goal error when a
--- unit fails.
local function graph_test_goal(roots)
	local units = {}
	local failed = false
	for _, root in ipairs(roots) do
		if root.result ~= nil and not is_unit_list(root.result) then
			core.goal_error(`{root.address}: a TEST root must resolve to a list of \{ name, ok, output \} units`)
		end
		for _, unit in ipairs(root.result or {}) do
			if not unit.ok then
				failed = true
			end
			table.insert(units, {
				key = root.address .. " " .. unit.name,
				status = if unit.ok then "pass" else "fail",
				output = unit.output,
			})
		end
	end
	local text = report.status_report(units, {
		order = { "fail", "pass" },
		colors = { fail = "red", pass = "green" },
		summary = function(counts)
			return `test: {counts.pass}/{counts.pass + counts.fail} unit(s) passed`
		end,
	})
	if failed then
		core.goal_error(text)
	end
	return text
end

return {
	TEST = core.goal("test", graph_test_goal),
	graph_test_goal = graph_test_goal,
	test_vehicle = test_vehicle,
}
