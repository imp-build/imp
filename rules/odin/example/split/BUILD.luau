local odin = require("@imp/rules/odin")
local lib = odin.odin_package({ toolchain = "dev-2026-03" })
return { lib = lib, lib_tests = odin.odin_test_package({ deps = { lib }, toolchain = "dev-2026-03" }) }
