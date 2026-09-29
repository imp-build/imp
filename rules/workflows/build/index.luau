local core = require("@imp/core")

local function graph_build_goal(_roots)
	return nil
end

return {
	BUILD = core.goal("build", nil, { graph = graph_build_goal }),
}
