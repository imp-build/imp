local odin = require("@imp/rules/odin")
local shared = require("@workspace/rules/odin/example/shared/BUILD")
return { consumer_tests = odin.odin_test_package({ deps = { shared.lib }, toolchain = "dev-2026-03" }) }
