-- Canonical public entrypoint for host-PATH tool providers.
local core = require("@imp/core")

--- Declare an executable that the host finds on PATH when an action runs.
---
--- The returned value is a graph tool handle. Put it in the `inputs` of a
--- task: each action of that task can then run the executable by name, for
--- example `native_tool("cmake")`.
local function native_tool(name)
	if type(name) ~= "string" or #name == 0 then
		error("native_tool(name) requires a non-empty executable name", 2)
	end
	return core.native_tool(name)
end

return {

	--- @category target
	native_tool = native_tool,
}
