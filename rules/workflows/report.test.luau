local core = require("@imp/core")
local report = require("@imp/rules/workflows/report")

local RED = "\27[31m"
local YELLOW = "\27[33m"
local GREEN = "\27[32m"
local RESET = "\27[0m"

local options = {
	order = { "failed", "changed", "unchanged" },
	colors = { failed = "red", changed = "yellow", unchanged = "green" },
	summary = function(counts)
		return `fmt: {counts.unchanged} unchanged, {counts.changed} changed, {counts.failed} failed`
	end,
}

local function lines_of(text)
	return string.split(text, "\n")
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

return {
	core.test.case("status_report sorts by status severity, then by key", function()
		local lines = lines_of(report.status_report({
			{ key = "//pkg:z", status = "unchanged" },
			{ key = "//pkg:a", status = "changed" },
			{ key = "//pkg:m", status = "failed" },
			{ key = "//pkg:b", status = "failed" },
		}, options))
		assert(contains(lines[1], "//pkg:b"), lines[1])
		assert(contains(lines[2], "//pkg:m"), lines[2])
		assert(contains(lines[3], "//pkg:a"), lines[3])
		assert(contains(lines[4], "//pkg:z"), lines[4])
	end),

	core.test.case("status_report aligns the key column to the longest key", function()
		local long = "//pkg:a-much-longer-address"
		local lines = lines_of(report.status_report({
			{ key = "//pkg:short", status = "unchanged" },
			{ key = long, status = "unchanged" },
		}, options))
		local expected = long .. "  " .. GREEN .. "UNCHANGED" .. RESET
		assert(lines[1] == expected, lines[1])
	end),

	core.test.case("status_report colors each status from the given palette", function()
		local text = report.status_report({
			{ key = "//pkg:a", status = "failed" },
			{ key = "//pkg:b", status = "changed" },
			{ key = "//pkg:c", status = "unchanged" },
		}, options)
		assert(contains(text, RED .. "FAILED" .. RESET), text)
		assert(contains(text, YELLOW .. "CHANGED" .. RESET), text)
		assert(contains(text, GREEN .. "UNCHANGED" .. RESET), text)
	end),

	core.test.case("status_report adds output blocks only for units that have output", function()
		local text = report.status_report({
			{ key = "//pkg:a", status = "failed", output = "diagnostic detail" },
			{ key = "//pkg:b", status = "unchanged" },
		}, options)
		assert(contains(text, "//pkg:a:\ndiagnostic detail"), text)
		assert(not contains(text, "//pkg:b:\n"), text)
	end),

	core.test.case("status_report calls summary with the count of each status", function()
		local lines = lines_of(report.status_report({
			{ key = "//pkg:a", status = "failed" },
			{ key = "//pkg:b", status = "changed" },
			{ key = "//pkg:c", status = "unchanged" },
			{ key = "//pkg:d", status = "unchanged" },
		}, options))
		assert(lines[#lines] == "fmt: 2 unchanged, 1 changed, 1 failed", lines[#lines])
	end),
}
