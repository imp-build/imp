local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")

return {
	-- These checks need the CLI as the self tool. The engine unit-test
	-- process also runs core.test_root(), but is not a CLI executable.
	no_handler = { [test.TEST] = require("./no_handler_check") },
	rules_test = { [test.TEST] = core.test_root() },
}
