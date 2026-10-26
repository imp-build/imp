local core = require("@imp/core")
local codegen = require("@imp/rules/imp/codegen")
local rust = require("@imp/rules/rust")
local generated = codegen.codegen({
	tools = { sh = core.native_tool("sh") },
	output_paths = { "rules/rust/example/src/generated.rs" },
	argv = function()
		return {
			"sh",
			"-c",
			'printf \'pub const GENERATED_VALUE: &str = "generated";\\n\' > "$1"',
			"generate",
			"rules/rust/example/src/generated.rs",
		}
	end,
})
return { hello = rust.cargo_package({ bin = "hello", generated_srcs = { generated } }) }
