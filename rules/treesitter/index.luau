-- Internal grammar and executable roots for the Odin rules and round-trip test.
local core = require("@imp/core")
local build = require("@imp/rules/workflows/build")
local package = require("@imp/rules/workflows/package")
local test = require("@imp/rules/workflows/test")
local rust = require("@imp/rules/rust")
local gcc = require("@imp/rules/c/gcc")
local output = core.output
local gcc_toolchain = gcc.default_graph_toolchain()

local function grammar_fixture(name, root, include)
	local sources = core.builtin_files({ root = root, include = include })
	local output_path = `build/treesitter/{name}.so`
	local compile = core.task({
		display = `compile Tree-sitter {name} grammar`,
		inputs = { sources = sources, gcc = gcc_toolchain.tool },
		outputs = { archive = output.artifact() },
		run = function(exec, input)
			local suffix = if core.platform_info().os == "windows" then ".exe" else ""
			local argv = { `{gcc.graph_toolchain_dir(exec, input.gcc)}/bin/cc{suffix}`, "-shared", "-fPIC", `-I{root}` }
			for _, path in ipairs(exec.paths(input.sources)) do
				if string.match(path, "%.c$") then
					table.insert(argv, path)
				end
			end
			table.insert(argv, "-o")
			table.insert(argv, output_path)
			local result = exec.action({
				argv = argv,
				inputs = { input.sources },
				tools = { input.gcc },
				outputs = { archive = output.file(output_path) },
			})
			return { archive = result.outputs.archive }
		end,
	})
	return table.freeze({ sources = sources, [build.BUILD] = compile, archive = compile.outputs.archive })
end

--- Build the JSON grammar from built-in C sources and headers.
local json_grammar_fixture =
	grammar_fixture("json", "treesitter/testdata/tree-sitter-json", { "parser.c", "tree_sitter/*.h" })

--- Build the Odin grammar, including its external scanner.
local odin_grammar_fixture =
	grammar_fixture("odin", "treesitter/testdata/tree-sitter-odin", { "parser.c", "scanner.c", "tree_sitter/*.h" })

--- Compile the pinned Luau grammar for static reference extraction.
local luau_grammar = grammar_fixture("luau", "treesitter/grammars/luau", { "parser.c", "scanner.c", "tree_sitter/*.h" })

--- Declare the Luau reference syntax extractor.
local luau_reference = rust.cargo_package({ path = "treesitter", bin = "imp-luau-reference", builtin = true })

--- Declare the round-trip executable. PACKAGE resolves to its binary artifact.
local imp_treesitter = rust.cargo_package({ path = "treesitter", bin = "treesitter-roundtrip", builtin = true })

--- Declare the Odin analyzer. PACKAGE resolves to its binary artifact.
local odin_analyzer = rust.cargo_package({ path = "treesitter", bin = "imp-treesitter-parse", builtin = true })

local roundtrip_run = core.task({
	display = "Tree-sitter grammar round-trip",
	inputs = { bin = imp_treesitter[package.PACKAGE], fixture = json_grammar_fixture.archive },
	outputs = { units = output.value() },
	run = function(exec, input)
		local result = exec.action({
			argv = { exec.path(input.bin), exec.path(input.fixture) },
			inputs = { input.bin, input.fixture },
			allow_failure = true,
		})
		return { units = test.test_vehicle("grammar-roundtrip", result) }
	end,
})

return {
	luau_grammar = luau_grammar,
	luau_reference = luau_reference,
	json_grammar_fixture = json_grammar_fixture,
	odin_grammar_fixture = odin_grammar_fixture,
	imp_treesitter = imp_treesitter,
	odin_analyzer = odin_analyzer,
	roundtrip = { [test.TEST] = roundtrip_run.outputs.units },
}
