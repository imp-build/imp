-- The `generate-build` goal writes generated `BUILD.luau` files.
--
-- A rule module registers a generator with `core.register_build_generator({
-- namespace, generate })`. The generator runs only when the `build_generate`
-- field of its configuration namespace is true. `core.generate_build` calls
-- each enabled generator, merges the targets that they return for each
-- file, and renders each file. `imp goal generate-build --check` reports
-- out-of-date files and does not write them.
--
-- The goal takes no target selection: it runs every registered generator.
local core = require("@imp/core")

--- Write or check the generated BUILD files, and report the result.
local function generate_build_goal(_roots)
	local check = core.goal_flags().check == true
	local result = core.generate_build(check)
	local changed = result.changed
	if check then
		local text = `generate-build: {#result.checked} file(s) checked, {#changed} out of date`
		if #changed > 0 then
			core.goal_error(`{text}\ngenerated BUILD files are out of date: {table.concat(changed, ", ")}`)
		end
		return text
	end
	if #changed == 0 then
		return nil
	end
	local lines = { `generate-build: {#changed} file(s) written` }
	for _, file in ipairs(changed) do
		table.insert(lines, `  {file}`)
	end
	return table.concat(lines, "\n")
end

return {
	GENERATE_BUILD = core.goal("generate-build", generate_build_goal, {
		flags = {
			check = { description = "Verify generated BUILD files are up to date without writing changes" },
		},
		selection = "none",
	}),
	generate_build_goal = generate_build_goal,
}
