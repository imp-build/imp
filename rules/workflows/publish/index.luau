-- The `publish` goal selects roots that change a registry, such as an OCI
-- image push. The user must select these roots explicitly with
-- `imp publish`. The push actions run when the driver resolves each root, so
-- the goal only reports the roots.
local core = require("@imp/core")

--- Report the selected `PUBLISH` roots.
local function graph_publish_goal(roots)
	if #roots == 0 then
		return nil
	end
	local lines = {}
	for _, root in ipairs(roots) do
		table.insert(lines, `\n  {tostring(root.address)}`)
	end
	local noun = if #roots == 1 then "target" else "targets"
	return `Published {#roots} {noun}:{table.concat(lines)}`
end

return {
	PUBLISH = core.goal("publish", graph_publish_goal),
	graph_publish_goal = graph_publish_goal,
}
