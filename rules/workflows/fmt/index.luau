-- The `fmt` goal formats the sources of the selected targets in place.
-- `imp fmt --check` makes sure that the sources are formatted and does not
-- change the workspace.
--
-- This module registers the goal but enables no formatter. Each language
-- formatter is a separate module that gives a `FMT` root. An `FMT` root
-- resolves to this table:
--
--   {
--     paths,            -- workspace-relative source paths of the target
--     sources_digest?,  -- CAS tree with the sources before formatting
--     formatted?,       -- artifact with the sources after formatting
--     check?,           -- { requested, failed }
--     output?,          -- formatter output for a failed unit
--   }
--
-- The goal ignores a root without `paths`.
local core = require("@imp/core")
local report = require("@imp/rules/workflows/report")

-- A formatter task formats its sources in place in the sandbox, and declares
-- its output as a directory at the base of the package. That directory can
-- contain more than the declared sources: for a package at the workspace
-- root it is the full sandbox, with the tool mounts. Thus the goal compares
-- each declared path with `core.read_file_in_digest`. A comparison of the
-- two trees would find the extra entries and report each such package as
-- changed.
--
-- `check.failed` comes first. Some formatters refuse to write in check mode
-- and fail instead. Other formatters (for example odinfmt) always write.
-- For them, a changed path means "changed" in a write run and "failed" in a
-- check run.
local function unit_status(result)
	if result.check ~= nil and result.check.failed then
		return "failed"
	end
	if result.formatted == nil or result.sources_digest == nil then
		return "unchanged"
	end
	local changed = false
	for _, path in ipairs(result.paths) do
		local before = core.read_file_in_digest(result.sources_digest, path)
		local after = core.read_file_in_digest(result.formatted.digest, path)
		if before ~= after then
			changed = true
			break
		end
	end
	if not changed then
		return "unchanged"
	end
	if result.check ~= nil and result.check.requested then
		return "failed"
	end
	return "changed"
end

--- Write formatted sources at the goal boundary and report each root once.
--- The report is returned when no unit fails and raised as a goal error when
--- a unit fails.
local function graph_fmt_goal(roots)
	local check = core.goal_flags().check
	local units = {}
	for _, root in ipairs(roots) do
		local result = root.result
		if type(result) == "table" and type(result.paths) == "table" then
			table.insert(units, { address = root.address, status = unit_status(result), result = result })
		end
	end
	if not check then
		for _, unit in ipairs(units) do
			if unit.status ~= "failed" and unit.result.formatted ~= nil then
				for _, path in ipairs(unit.result.paths) do
					core.write_workspace(path, unit.result.formatted.digest, { from = path })
				end
			end
		end
	end
	local failed = false
	local entries = {}
	for _, unit in ipairs(units) do
		if unit.status == "failed" then
			failed = true
		end
		table.insert(entries, {
			key = unit.address,
			status = unit.status,
			output = if unit.status == "failed" then unit.result.output else nil,
		})
	end
	local text = report.status_report(entries, {
		order = { "failed", "changed", "unchanged" },
		colors = { failed = "red", changed = "yellow", unchanged = "green" },
		summary = function(counts)
			return `fmt: {counts.unchanged} unchanged, {counts.changed} changed, {counts.failed} failed`
		end,
	})
	if failed then
		core.goal_error(text)
	end
	return text
end

return {
	FMT = core.goal("fmt", graph_fmt_goal, {
		flags = { check = { description = "Verify formatting without writing changes" } },
	}),
	graph_fmt_goal = graph_fmt_goal,
}
