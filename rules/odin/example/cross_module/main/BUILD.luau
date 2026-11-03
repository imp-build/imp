local odin = require("@imp/rules/odin")
-- This package imports `../gen` by a relative path and also has it as a dep
-- from another BUILD module. Both must reach one generated source. The BUILD
-- walk evaluates `gen` before this module requires it, because `gen` sorts
-- first.
return {
	main = odin.odin_package({
		deps = { require("@workspace/rules/odin/example/cross_module/gen/BUILD").gen },
		toolchain = "dev-2026-03",
	}),
}
