local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local test = require("@imp/rules/workflows/test")
local treesitter = require("@imp/rules/treesitter")

local function find(host, display)
	for _, action in ipairs(host.runs) do
		if action.display == display then
			return action
		end
	end
	error("missing action " .. display)
end

return {
	core.test.case("exposes graph-backed grammars and executable packages", function()
		for _, fixture in ipairs({ treesitter.json_grammar_fixture, treesitter.odin_grammar_fixture }) do
			assert(type(fixture.sources) == "userdata" and type(fixture.archive) == "userdata")
			assert(type(fixture[build.BUILD]) == "userdata" and table.isfrozen(fixture))
		end
		for _, executable in ipairs({ treesitter.imp_treesitter, treesitter.odin_analyzer }) do
			assert(type(executable[build.BUILD]) == "userdata" and type(executable[package.PACKAGE]) == "userdata")
		end
	end),
	core.test.case("compiles only C sources and stages grammar headers", function()
		core.test.with_fake_toolchain_host(function(host)
			for name, fixture in pairs({
				json = treesitter.json_grammar_fixture,
				odin = treesitter.odin_grammar_fixture,
			}) do
				local paths = core.test.resolve(core.task({
					inputs = { sources = fixture.sources },
					outputs = { paths = core.output.value() },
					run = function(exec, input)
						return { paths = exec.paths(input.sources) }
					end,
				}).outputs.paths)
				assert(table.find(paths, `treesitter/testdata/tree-sitter-{name}/tree_sitter/parser.h`))
				for _, path in ipairs(paths) do
					assert(not string.match(path, "%.so$"))
				end
				core.test.resolve(fixture.archive)
				local action = find(host, `compile Tree-sitter {name} grammar`)
				assert(string.find(action.argv[1], "/cache/gcc-toolchains/", 1, true))
				assert(action.argv[2] == "-shared" and action.argv[3] == "-fPIC")
				assert(action.argv[4] == `-Itreesitter/testdata/tree-sitter-{name}`)
				assert(table.find(action.argv, `treesitter/testdata/tree-sitter-{name}/parser.c`))
				assert(action.outputs.archive == `build/treesitter/{name}.so` and action.input_count == 1)
				for _, arg in ipairs(action.argv) do
					assert(not string.match(arg, "%.h$"))
				end
				if name == "odin" then
					assert(table.find(action.argv, "treesitter/testdata/tree-sitter-odin/scanner.c"))
				end
			end
		end)
	end),
	core.test.case("round-trip stages its executable and JSON grammar", function()
		core.test.with_fake_toolchain_host(function(host)
			local units = core.test.resolve(treesitter.roundtrip[test.TEST])
			assert(#units == 1 and units[1].name == "grammar-roundtrip" and units[1].ok and units[1].output == nil)
			local action = find(host, "Tree-sitter grammar round-trip")
			assert(string.match(action.argv[1], "/treesitter%-roundtrip$"))
			assert(action.argv[2] == "build/treesitter/json.so" and action.input_count == 2)
		end)
	end),
	core.test.case("round-trip reports action failures with diagnostics", function()
		core.test.with_fake_toolchain_host(function(host)
			host.set_run_exit_code("Tree-sitter grammar round-trip", 1)
			host.set_run_stdout("Tree-sitter grammar round-trip", "partial check")
			host.set_run_stderr("Tree-sitter grammar round-trip", "grammar failed")
			local units = core.test.resolve(treesitter.roundtrip[test.TEST])
			assert(#units == 1 and not units[1].ok and units[1].output == "partial check\ngrammar failed")
		end)
	end),
}
