local core = require("@imp/core")
local rules = require("@imp/rules/asset")
local test = require("@imp/rules/workflows/test")

return {
	assets = rules.asset({ srcs = { "*.luau" } }),
	rules_test = { [test.TEST] = core.test_root() },
}
