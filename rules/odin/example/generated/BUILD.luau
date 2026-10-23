local codegen = require("@imp/rules/imp/codegen")
local odin = require("@imp/rules/odin")
local generated = codegen.stamp_file({ output = "rules/odin/example/generated/value.odin", text = "package generated\n\nGeneratedValue :: 42" })
return { generated_value = generated, app = odin.odin_package({ generated_srcs = { { artifact = generated.file, path = "value.odin" } }, toolchain = "dev-2026-03" }) }
