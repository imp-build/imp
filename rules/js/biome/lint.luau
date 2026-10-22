-- Import before declaring targets that need Biome linting.
local js = require("@imp/rules/js")
local lint = require("@imp/rules/workflows/lint")
local graph = require("@imp/rules/js/biome/graph")
local function hook(source) return { [lint.LINT] = graph.biome_lint_root(source) } end
js.register_js_sources_hook(hook)
js.register_js_app_hook(hook)
return { biome_lint_root = graph.biome_lint_root }
