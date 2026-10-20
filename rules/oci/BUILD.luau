local core = require("@imp/core")
local test = require("@imp/rules/workflows/test")
return { rules_test = { [test.TEST] = core.test_root() } }
