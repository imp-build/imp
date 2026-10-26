-- Import before declaring Python targets that need Ruff lint.
local python = require("@imp/rules/python")
local workflow = require("@imp/rules/workflows/lint")
local graph = require("@imp/rules/python/ruff_graph")
local function hook(source)
	return { [workflow.LINT] = graph.ruff_lint_root(source) }
end
python.register_python_app_hook(hook)
python.register_python_test_hook(hook)
return { ruff_lint_root = graph.ruff_lint_root }
