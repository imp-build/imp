-- The `lint` goal reports the lint results of the selected targets.
-- `imp lint --fix` also writes the fixes that a linter made.
--
-- This module registers the goal but enables no linter. Each language linter
-- is a separate module that gives a `LINT` root. A `LINT` root resolves to
-- this table, or to a table with this table in its `result` field:
--
--   {
--     ok,            -- false when the linter found problems
--     output?,       -- linter output for a failed unit
--     paths?,        -- workspace-relative source paths of the target
--     fixed?,        -- artifact with the fixed sources under `fixed/`
--     fix_applied?,  -- true when the linter changed a source
--   }
--
-- The lint task runs its action with `allow_failure = true`, so that a lint
-- failure does not stop the task.
local core = require("@imp/core")
local report = require("@imp/rules/workflows/report")

--- Write lint fixes at the goal boundary and report each root once. The
--- report is returned when all roots pass and raised as a goal error when a
--- root fails.
local function graph_lint_goal(roots)
	local fix = core.goal_flags().fix
	local results = {}
	for _, root in ipairs(roots) do
		local result = root.result
		if type(result) == "table" and type(result.result) == "table" then
			result = result.result
		end
		if type(result) ~= "table" then
			core.goal_error(`{root.address}: a LINT root must resolve to a table with an 'ok' field`)
		end
		table.insert(results, { address = root.address, result = result })
	end
	if fix then
		for _, entry in ipairs(results) do
			local result = entry.result
			if result.fixed ~= nil and result.fixed.digest ~= nil and type(result.paths) == "table" then
				for _, path in ipairs(result.paths) do
					core.write_workspace(path, result.fixed.digest, { from = `fixed/{path}` })
				end
			end
		end
	end
	local failed = false
	local entries = {}
	for _, entry in ipairs(results) do
		local result = entry.result
		local status = "clean"
		if not result.ok then
			status = "fail"
			failed = true
		elseif result.fix_applied then
			status = "fixed"
		end
		table.insert(entries, {
			key = entry.address,
			status = status,
			output = if result.ok then nil else result.output,
		})
	end
	local text = report.status_report(entries, {
		order = { "fail", "fixed", "clean" },
		colors = { fail = "red", fixed = "yellow", clean = "green" },
		summary = function(counts)
			return `lint: {counts.clean} clean, {counts.fixed} fixed, {counts.fail} failed`
		end,
	})
	if failed then
		core.goal_error(text)
	end
	return text
end

return {
	LINT = core.goal("lint", graph_lint_goal, {
		flags = { fix = { description = "Automatically fix what can be fixed" } },
	}),
	graph_lint_goal = graph_lint_goal,
}
