-- Ruff graph tests use the toolchain host fake.
local core = require("@imp/core")
local python = require("@imp/rules/python")
local ruff = require("@imp/rules/python/ruff_toolchain")
require("@imp/rules/python/ruff/fmt")
require("@imp/rules/python/ruff/lint")
local fmt = require("@imp/rules/workflows/fmt")
local lint = require("@imp/rules/workflows/lint")
local BASE = "rules/python/testdata/ruff_config/app"
local function check(flags, fn)
	core.test.with_fake_toolchain_host(function(host)
		ruff.reset_for_test()
		ruff.ruff_toolchain("0.16.7", { default = true })
		core.test.with_fake_goal_flags(flags, function() fn(host) end)
	end)
end
local function action(host, kind)
	for _, run in ipairs(host.runs) do if run.display == `ruff {kind} {BASE}` then return run end end
	error("missing Ruff action")
end
local function paths(run)
	local seen = {}
	for _, input in ipairs(run.inputs) do
		for _, path in ipairs(input.paths or {}) do seen[path] = true end
	end
	return seen
end
return {
	core.test.case("Ruff stages selected sources and applicable configs", function()
		check({}, function(host)
			local app = python.python_app({ base = BASE, sources = { "src/**/*.py" } })
			core.test.resolve(app[fmt.FMT])
			core.test.resolve(app[lint.LINT])
			local formatted, checked = action(host, "fmt"), action(host, "lint")
			local selected = paths(checked)
			for _, path in ipairs({ BASE .. "/pyproject.toml", BASE .. "/src/pkg/.ruff.toml", "rules/python/testdata/ruff_config/ruff.toml", BASE .. "/src/pkg/mod.py" }) do assert(selected[path], path) end
			assert(not selected[BASE .. "/other/ruff.toml"] and not selected[BASE .. "/tests/ruff.toml"])
			for _, input in ipairs(checked.inputs) do assert(input.from == "." and input.to == "fixed") end
			for _, tool in ipairs({ "cp", "mkdir", "dirname" }) do assert(not table.find(checked.tools, tool)) end
			assert(#checked.argv == 6 and checked.argv[6] == BASE .. "/src/pkg/mod.py")
			assert(formatted.argv[6] == checked.argv[6])
		end)
	end),
	core.test.case("Ruff test facets use test sources and configs", function()
		check({}, function(host)
			local suite = python.python_test({ base = BASE, sources = { "tests/*.py" } })
			core.test.resolve(suite[fmt.FMT])
			core.test.resolve(suite[lint.LINT])
			local run = action(host, "lint")
			assert(paths(run)[BASE .. "/tests/ruff.toml"])
			assert(run.argv[6] == BASE .. "/tests/test_mod.py")
		end)
	end),
	core.test.case("Ruff check and fix preserve result contracts", function()
		check({ check = true, fix = true }, function(host)
			local app = python.python_app({ base = BASE, sources = { "src/pkg/*.py" } })
			host.set_run_exit_code(`ruff fmt {BASE}`, 1)
			host.set_run_stdout(`ruff fmt {BASE}`, "format failure")
			local formatted = core.test.resolve(app[fmt.FMT])
			assert(formatted.check.requested and formatted.check.failed and formatted.sources_digest)
			assert(string.find(formatted.output, "format failure", 1, true))
			local fixed = core.test.resolve(app[lint.LINT])
			assert(fixed.ok and fixed.fix_applied and fixed.fixed.path == "fixed")
			assert(action(host, "lint").argv[5] == "1")
		end)
	end),
	core.test.case("Ruff lint returns failures without a fix artifact", function()
		check({}, function(host)
			local app = python.python_app({ base = BASE, sources = { "src/**/*.py" } })
			host.set_run_exit_code(`ruff lint {BASE}`, 1)
			host.set_run_stderr(`ruff lint {BASE}`, "lint failure")
			local value = core.test.resolve(app[lint.LINT])
			assert(not value.ok and not value.fix_applied and value.fixed == nil)
			assert(string.find(value.output, "lint failure", 1, true))
		end)
	end),
	core.test.case("Ruff accepts empty and default source patterns", function()
		check({}, function(host)
			local app = python.python_app({ base = BASE, sources = { "absent.py" } })
			assert(#core.test.resolve(app[fmt.FMT]).paths == 0)
			assert(core.test.resolve(app[lint.LINT]).ok)
			for _, run in ipairs(host.runs) do assert(not string.find(run.display, "ruff fmt", 1, true) and not string.find(run.display, "ruff lint", 1, true)) end
			assert(core.test.resolve(python.python_app({ base = BASE })[lint.LINT]).ok)
		end)
	end),
}
