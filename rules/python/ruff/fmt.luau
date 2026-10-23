-- Import before declaring Python targets that need Ruff fmt.
local python = require("@imp/rules/python")
local workflow = require("@imp/rules/workflows/fmt")
local graph = require("@imp/rules/python/ruff_graph")
local function hook(source) return { [workflow.FMT] = graph.ruff_fmt_root(source) } end
python.register_python_app_hook(hook)
python.register_python_test_hook(hook)
return { ruff_fmt_root = graph.ruff_fmt_root }
