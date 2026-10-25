-- Canonical public entrypoint for the "imp" tool that products use when Imp
-- itself implements them, and not an acquired toolchain.
local core = require("@imp/core")

return {
	--- Graph tool handle for the running Imp executable. Actions run it as `imp`.
	--- @category target
	imp_tool = core.self_tool(),
}
