local core = require("@imp/core")
local workflow = require("@imp/rules/workflows/test")

local GREEN = "\27[32m"
local RED = "\27[31m"
local RESET = "\27[0m"

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn)
	local ok, err = pcall(fn)
	assert(not ok, "expected a goal error")
	return tostring(err)
end

local function failing_roots()
	return {
		{ address = "//pkg:a", result = { { name = "unit-a", ok = false, output = "boom a" } } },
		{ address = "//pkg:b", result = { { name = "unit-b", ok = false, output = "boom b" } } },
	}
end

return {
	core.test.case("test_vehicle returns a named passing unit without output", function()
		local units = workflow.test_vehicle("unit-a", { exit_code = 0, stdout = "ok", stderr = "" })
		assert(#units == 1)
		assert(units[1].name == "unit-a")
		assert(units[1].ok == true)
		assert(units[1].output == nil)
	end),

	core.test.case("test_vehicle combines the output of a failing unit", function()
		local units = workflow.test_vehicle("unit-a", {
			exit_code = 1,
			stdout = "assertion failed",
			stderr = "trace",
		})
		assert(units[1].ok == false)
		assert(units[1].output == "assertion failed\ntrace", units[1].output)
	end),

	core.test.case("test_vehicle keeps an empty output for a failure with no captured text", function()
		local units = workflow.test_vehicle("unit-a", { exit_code = 1, stdout = "", stderr = "" })
		assert(units[1].ok == false)
		assert(units[1].output == "", units[1].output)
	end),

	core.test.case("graph_test_goal returns a sorted, aligned, colored report when all units pass", function()
		local text = workflow.graph_test_goal({
			{ address = "//pkg:b", result = { { name = "unit-b", ok = true } } },
			{ address = "//pkg:a", result = { { name = "unit-a", ok = true } } },
		})
		local expected = `//pkg:a unit-a  {GREEN}PASS{RESET}\n//pkg:b unit-b  {GREEN}PASS{RESET}\ntest: 2/2 unit(s) passed`
		assert(text == expected, text)
	end),

	core.test.case("graph_test_goal sorts failures before passes, in any address order", function()
		local text = error_text(function()
			workflow.graph_test_goal({
				{ address = "//pkg:z", result = { { name = "unit-z", ok = true } } },
				{ address = "//pkg:a", result = { { name = "unit-a", ok = false, output = "boom" } } },
			})
		end)
		local fail_at = string.find(text, `//pkg:a unit-a  {RED}FAIL{RESET}`, 1, true)
		local pass_at = string.find(text, `//pkg:z unit-z  {GREEN}PASS{RESET}`, 1, true)
		assert(fail_at ~= nil and pass_at ~= nil and fail_at < pass_at, text)
	end),

	core.test.case("graph_test_goal aggregates the failures of all selected roots", function()
		local text = error_text(function()
			workflow.graph_test_goal(failing_roots())
		end)
		assert(contains(text, "//pkg:a unit-a"), text)
		assert(contains(text, "//pkg:b unit-b"), text)
	end),

	core.test.case("graph_test_goal reports a passing unit with a failing unit of another root", function()
		local text = error_text(function()
			workflow.graph_test_goal({
				{ address = "//pkg:a", result = { { name = "unit-a", ok = true } } },
				{ address = "//pkg:b", result = { { name = "unit-b", ok = false, output = "boom" } } },
			})
		end)
		assert(contains(text, "//pkg:a unit-a"), text)
		assert(contains(text, "//pkg:b unit-b"), text)
	end),

	core.test.case("graph_test_goal includes the captured output of each failing unit", function()
		local text = error_text(function()
			workflow.graph_test_goal({
				{ address = "//pkg:a", result = { { name = "unit-a", ok = false, output = "assertion failed" } } },
			})
		end)
		assert(contains(text, "assertion failed"), text)
	end),

	core.test.case("graph_test_goal ignores roots with no units", function()
		local text = workflow.graph_test_goal({ { address = "//pkg:a", result = {} } })
		assert(text == "test: 0/0 unit(s) passed", text)
	end),

	core.test.case("graph_test_goal refuses a result that is not a unit list", function()
		local text = error_text(function()
			workflow.graph_test_goal({ { address = "//pkg:a", result = { name = "unit-a", ok = true } } })
		end)
		assert(contains(text, "//pkg:a: a TEST root must resolve to a list of"), text)
	end),
}
