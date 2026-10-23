local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")
local odin = require("@imp/rules/odin")
local lib = c.cc_library({ shared = true, srcs = { "mul.c" }, toolchain = gcc.default_graph_toolchain() })
return { lib = lib, app = odin.odin_package({ deps = { lib }, toolchain = "dev-2026-03" }) }
