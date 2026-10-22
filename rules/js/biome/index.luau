-- Import before declaring targets that need Biome formatting.
local js = require("@imp/rules/js")
local fmt = require("@imp/rules/workflows/fmt")
local graph = require("@imp/rules/js/biome/graph")
local function hook(source) return { [fmt.FMT] = graph.biome_fmt_root(source) } end
js.register_js_sources_hook(hook)
js.register_js_app_hook(hook)
return require("@imp/rules/js/biome/toolchain")
