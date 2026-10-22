local python = require("@imp/rules/python")
local workspace = python.python_workspace({ path = "rules/python/example" })
local project = python.python_project({ workspace = workspace, path = "." })
return {
	workspace = workspace,
	hello = python.python_app({ project = project, entry_point = "hello.__main__", sources = { "src/**/*.py" } }),
	scripts = python.python_sources({ root = "rules/python/example/scripts" }),
	hello_test = python.python_test({ project = project, sources = { "tests/**/*.py" } }),
}
