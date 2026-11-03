local codegen = require("@imp/rules/imp/codegen")
local odin = require("@imp/rules/odin")
local generated = codegen.stamp_file({
	output = "rules/odin/example/cross_module/gen/value.odin",
	text = "package gen\n\nValue :: 7",
})
return {
	gen = odin.odin_package({
		generated_srcs = { { artifact = generated.file, path = "value.odin" } },
		toolchain = "dev-2026-03",
	}),
}
