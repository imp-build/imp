local python = require("@imp/rules/python")
return {
	app = python.python_app({ entry_point = "native_app.__main__", sources = { "src/**/*.py" } }),
	tests = python.python_test({ sources = { "tests/**/*.py" } }),
}
