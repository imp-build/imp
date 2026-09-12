import { BUILD } from "//rules/workflows/build";
import { TEST } from "//rules/workflows/test";
import { builtinFiles, output, task } from "imp:core";
import { cargoPackage } from "//rules/rust";
import { defaultGccGraphToolchain } from "//rules/c/gcc";

const gccToolchain = defaultGccGraphToolchain();

function grammarFixture(name, root, include, includeDir) {
	const sources = builtinFiles({ root, include });
	const outputPath = `build/treesitter/${name}.so`;
	const compile = task({
		display: `compile Tree-sitter ${name} grammar`,
		inputs: { sources, gcc: gccToolchain.tool },
		outputs: { archive: output.artifact() },
		async run(exec, input) {
			const sourcePaths = exec.paths(input.sources).filter((path) => /\.c$/.test(path));
			const result = await exec.action({
				argv: [exec.tool(input.gcc, "cc"), "-shared", "-fPIC", `-I${includeDir}`, ...sourcePaths, "-o", outputPath],
				inputs: [input.sources],
				tools: [input.gcc],
				outputs: { archive: output.file(outputPath) },
			});
			return { archive: result.outputs.archive };
		},
	});
	return Object.freeze({ sources, [BUILD]: compile, archive: compile.outputs.archive });
}

export const jsonGrammarFixture = grammarFixture(
	"json",
	"treesitter/testdata/tree-sitter-json",
	["parser.c", "tree_sitter/*.h"],
	"treesitter/testdata/tree-sitter-json",
);

export const odinGrammarFixture = grammarFixture(
	"odin",
	"treesitter/testdata/tree-sitter-odin",
	["parser.c", "scanner.c", "tree_sitter/*.h"],
	"treesitter/testdata/tree-sitter-odin",
);

export const impTreesitter = cargoPackage({
	path: "treesitter",
	bin: "treesitter-roundtrip",
	builtin: true,
});

export const odinAnalyzer = cargoPackage({
	path: "treesitter",
	bin: "imp-treesitter-parse",
	builtin: true,
});

const roundtripRun = task({
	display: "Tree-sitter grammar round-trip",
	inputs: {
		bin: impTreesitter[BUILD]["treesitter-roundtrip"],
		fixture: jsonGrammarFixture.archive,
	},
	outputs: { units: output.value() },
	async run(exec, input) {
		const result = await exec.action({
			argv: [exec.path(input.bin), exec.path(input.fixture)],
			inputs: [input.bin, input.fixture],
			allowFailure: true,
		});
		const ok = result.exitCode === 0;
		return {
			units: [
				{
					name: "grammar-roundtrip",
					ok,
					...(ok ? {} : { output: [result.stdout, result.stderr].filter(Boolean).join("\n") }),
				},
			],
		};
	},
});

export const roundtrip = { [TEST]: roundtripRun.outputs.units };
