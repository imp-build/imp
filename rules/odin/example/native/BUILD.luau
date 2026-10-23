local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")
local odin = require("@imp/rules/odin")
local lib = c.cc_library({ toolchain = gcc.default_graph_toolchain() })
return { lib = lib, native_tests = odin.odin_test_package({ deps = { lib }, toolchain = "dev-2026-03" }) }
