local odin = require("@imp/rules/odin")
return { hello = odin.odin_package({ srcs = { "*.odin" }, toolchain = "dev-2026-03" }) }
