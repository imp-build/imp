local c = require("@imp/rules/c")
local gcc = require("@imp/rules/c/gcc")

-- An explicit gcc toolchain, not the default zig toolchain: static-archive
-- linking with `zig cc` and `zig ar` has an open issue ("artifact:
-- unrecognized file extension"). See #74.
local toolchain = gcc.default_graph_toolchain()

local lib = c.cc_library({
	path = "rules/c/graph_example/lib",
	toolchain = toolchain,
})

return {
	lib = lib,
	hello = c.cc_binary({
		path = "rules/c/graph_example",
		srcs = { "main.c" },
		deps = { lib },
		toolchain = toolchain,
	}),
}
