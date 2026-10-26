-- Register workflows before BUILD.luau modules declare their graph roots.
require("@imp/rules/workflows/build")
require("@imp/rules/workflows/builtin_lockfiles")
require("@imp/rules/workflows/codegen")
require("@imp/rules/workflows/fmt")
require("@imp/rules/workflows/generate")
require("@imp/rules/workflows/generate_build")
require("@imp/rules/workflows/lint")
require("@imp/rules/workflows/lockfiles")
require("@imp/rules/workflows/package")
require("@imp/rules/workflows/publish")
require("@imp/rules/workflows/run")
require("@imp/rules/workflows/test")

require("@imp/rules/imp/mode")
require("@imp/rules/c/generate_build")
require("@imp/rules/odin")
require("@imp/rules/odin/odinfmt")
require("@imp/rules/odin/vscode")

require("@imp/rules/workflows/vs")
require("@imp/rules/rust/generate_build")
require("@imp/rules/js/biome")
require("@imp/rules/python/ruff/fmt")
require("@imp/rules/python/ruff/lint")
require("@imp/rules/zola").zola_toolchain("0.22.1", { default = true })
local rust = require("@imp/rules/rust/toolchain")
local mold = require("@imp/rules/c/mold").default_graph_toolchain()
local kache = require("@imp/rules/rust/kache").default_toolchain()
require("@imp/rules/odin").odin_toolchain("dev-2026-03", { default = true, linker = mold })
rust.rust_toolchain("1.93.0", { default = true, linker = mold, kache = kache })
local luau = require("@imp/rules/imp/luau")
luau.stylua_toolchain("2.6.0", { default = true })
luau.luau_analyzer_toolchain("0.709", { default = true })
return {
	cache = { gc_max_age_days = 7 },
	imp = { jobs = 8, js_workers = 1 },
	c = { build_generate = true },
	rust = { build_generate = true, doctest = false },
	odin = { build_generate = true },
}
