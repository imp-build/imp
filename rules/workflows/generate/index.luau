-- The `generate` goal writes the generated files of the selected roots into
-- the workspace. `imp generate --check` makes sure that the files are up to
-- date and does not write them. Use it as a CI drift gate for committed
-- generated code.
--
-- A `GENERATE` root is a `generated_files()` result from
-- @imp/rules/imp/generate. It resolves to one artifact for each generated
-- file and a `before` digest of the same paths in the workspace. The
-- generator runs in a sandbox and keeps its outputs in CAS. This goal
-- compares them with the workspace and writes them at the goal boundary.
-- Thus the generator stays hermetic, and both modes share one cache entry.
local core = require("@imp/core")
local generate = require("@imp/rules/imp/generate")

--- Write the generated files of the selected roots, or make sure that they
--- are up to date, and return a report.
local function graph_generate_goal(roots)
	local check = core.goal_flags().check == true
	local stale = {}
	local checked = 0
	for _, root in ipairs(roots) do
		local address = tostring(root.address)
		local result = root.result
		local files = generate.generated_root_files(result)
		if files == nil or type(result.before) ~= "string" then
			core.goal_error(`{address}: generate graph root must resolve to a generated_files() result`)
		end
		for _, file in ipairs(files) do
			local path = file.path
			checked += 1
			if generate.generated_file_is_stale(path, result.before, file.digest) then
				table.insert(stale, path)
			end
			-- Write each declared path, not only the stale paths. The diff
			-- gives the report, and write_workspace decides the workspace
			-- content.
			if not check then
				core.write_workspace(path, file.digest, { from = path })
			end
		end
	end
	local listed = {}
	for _, path in ipairs(stale) do
		table.insert(listed, `  {path}`)
	end
	if check then
		if #stale > 0 then
			core.goal_error(`generated files are out of date:\n{table.concat(listed, "\n")}`)
		end
		return `generate --check: {checked} generated file(s) up to date`
	end
	if #stale == 0 then
		return nil
	end
	return `generated {#stale} file(s):\n{table.concat(listed, "\n")}`
end

return {
	GENERATE = core.goal("generate", graph_generate_goal, {
		flags = {
			check = { description = "Verify generated files are up to date without writing changes" },
		},
	}),
	graph_generate_goal = graph_generate_goal,
}
