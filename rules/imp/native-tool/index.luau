local core = require("@imp/core")

local function native_tool(name)
	return core.native_tool(name)
end

return {
	native_tool = native_tool,
}
