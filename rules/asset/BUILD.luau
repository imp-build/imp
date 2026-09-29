local rules = require("@imp/rules/asset")

return {
	assets = rules.asset({ srcs = { "*.luau" } }),
}
