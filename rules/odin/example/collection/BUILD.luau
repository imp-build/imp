local odin = require("@imp/rules/odin")
return { app = odin.odin_package({ path = "app", collections = { lib = "vendor" }, toolchain = "dev-2026-03" }) }
