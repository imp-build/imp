-- Require this module to register the workspace build modes.
local core = require("@imp/core")

core.define_mode_axis("opt", {
	kind = "rebuild",
	values = { "debug", "release" },
	["default"] = "debug",
})
core.define_profile("default", { opt = "debug" })
core.define_profile("release", { opt = "release" })

return {}
