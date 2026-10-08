local core = require("@imp/core")
local fmt = require("@imp/rules/workflows/fmt")

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn)
	local ok, err = pcall(fn)
	assert(not ok, "expected a goal error")
	return tostring(err)
end

local function check_result(failed, output)
	return {
		paths = {},
		check = { requested = true, failed = failed },
		output = output,
	}
end

-- The case for a real digest comparison is a host test in
-- crates/imp-engine/src/luau.rs, because a test module cannot make a CAS
-- tree digest from workspace files.
return {
	core.test.suite("graph_fmt_goal", {
		core.test.case("a check failure is reported as failed, with output, and fails the goal", function()
			core.test.with_fake_goal_flags({}, function()
				local text = error_text(function()
					fmt.graph_fmt_goal({
						{ address = "//pkg:a", result = check_result(true, "diff detail") },
					})
				end)
				assert(contains(text, "diff detail"), text)
				assert(contains(text, "FAILED"), text)
			end)
		end),

		core.test.case("a passing check is reported as unchanged", function()
			core.test.with_fake_goal_flags({}, function()
				local text = fmt.graph_fmt_goal({
					{ address = "//pkg:a", result = check_result(false) },
				})
				assert(contains(text, "UNCHANGED"), text)
				assert(not contains(text, "FAILED"), text)
			end)
		end),

		core.test.case("roots without a paths list are skipped", function()
			core.test.with_fake_goal_flags({}, function()
				local text = fmt.graph_fmt_goal({
					{ address = "//pkg:a", result = nil },
					{ address = "//pkg:b", result = check_result(false) },
				})
				assert(not contains(text, "//pkg:a"), text)
				assert(contains(text, "//pkg:b"), text)
			end)
		end),

		core.test.case("aggregates the failures of all selected roots", function()
			core.test.with_fake_goal_flags({}, function()
				local text = error_text(function()
					fmt.graph_fmt_goal({
						{ address = "//pkg:a", result = check_result(true, "a") },
						{ address = "//pkg:b", result = check_result(true, "b") },
					})
				end)
				assert(contains(text, "//pkg:a"), text)
				assert(contains(text, "//pkg:b"), text)
			end)
		end),

		core.test.case("--check never writes, even for an unchanged result", function()
			core.test.with_fake_write_workspace(function(writes)
				core.test.with_fake_goal_flags({ check = true }, function()
					fmt.graph_fmt_goal({
						{ address = "//pkg:a", result = check_result(false) },
					})
				end)
				assert(#writes.calls == 0)
			end)
		end),
	}),
}
