local core = require("@imp/core")

-- `build` is cache-only: it builds and warms the task cache, but it does not
-- write files into the workspace. The `package` goal publishes files.
local function graph_build_goal(_roots)
	return nil
end

return {
	BUILD = core.goal("build", graph_build_goal),
}
