local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")
local treesitter = require("@imp/rules/treesitter")

return {
	rules_test = { [test.TEST] = core.test_root() },
	roundtrip = treesitter.roundtrip,
}
