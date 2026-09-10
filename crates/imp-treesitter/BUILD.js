import { ccLibrary } from "//rules/c";
import { nativeTool } from "//rules/imp/native-tool";
import { cargoPackage } from "//rules/rust";
import { BUILD } from "//rules/workflows/build";
import { TEST } from "//rules/workflows/test";
import { files, output, task } from "imp:core";

// The round-trip check's grammar (see testdata/tree-sitter-json/README.md) is
// compiled from vendored source at build time — via the graph-provided cc
// toolchain, the same one //rules/c/gcc already uses for every other C
// target — rather than checked in as a prebuilt binary. That makes it
// correct for whatever platform imp-treesitter is actually being built on,
// unlike a single vendored linux-x86_64 .so.
export const jsonGrammarFixture = ccLibrary({
    path: "crates/imp-treesitter/testdata/tree-sitter-json",
    srcs: ["parser.c"],
    hdrs: ["tree_sitter/*.h"],
    shared: true,
});

// The Odin dependency analyzer uses the same in-process Tree-sitter API as the
// round-trip test. Keep the generated parser checked in and compile it through
// the graph so the analyzer has a platform-correct shared library.
const odinGrammarSources = files({
	root: "crates/imp-treesitter/testdata/tree-sitter-odin",
	include: ["parser.c", "scanner.c", "tree_sitter/*.h"],
});

export const odinGrammarFixture = task({
	display: "compile Tree-sitter Odin grammar",
	inputs: {
		sources: odinGrammarSources,
		cc: nativeTool("cc"),
		assembler: nativeTool("as"),
		linker: nativeTool("ld"),
	},
	outputs: { archive: output.artifact() },
	async run(exec, input) {
		const sourcePaths = exec.paths(input.sources).filter((path) =>
			/\.c$/.test(path),
		);
		const result = await exec.action({
			argv: [
				exec.tool(input.cc, "cc"),
				"-shared",
				"-fPIC",
				"-Icrates/imp-treesitter/testdata/tree-sitter-odin",
				...sourcePaths,
				"-o",
				"build/odinGrammar.so",
			],
			inputs: [input.sources],
			tools: [input.cc, input.assembler, input.linker],
			outputs: { archive: output.file("build/odinGrammar.so") },
		});
		return { archive: result.outputs.archive };
	},
});

// The library plus the round-trip check binary (src/bin/treesitter-roundtrip.rs).
// The binary loads the grammar at run time from a path passed on argv, so —
// unlike the old tests/ embed — nothing here needs the grammar at compile time,
// and a plain `cargo` build of this crate has no dependency on an `imp` build.
export const imp_treesitter = cargoPackage({
    bin: "treesitter-roundtrip",
    workspaceMember: true,
});

export const odinAnalyzer = cargoPackage({
	bin: "imp-treesitter-parse",
	workspaceMember: true,
});

// Not a cargo test: `imp test //crates/imp-treesitter:roundtrip` runs the
// built binary with the graph-built JSON grammar staged and its sandbox path
// as argv[1]. A missing or broken grammar fails here — the ccLibrary build
// error propagates, or the binary's load fails and it exits non-zero.
const roundtripRun = task({
    display: "imp-treesitter grammar round-trip",
    inputs: {
        bin: imp_treesitter[BUILD]["treesitter-roundtrip"],
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
                    ...(ok
                        ? {}
                        : {
                              output: [result.stdout, result.stderr]
                                  .filter(Boolean)
                                  .join("\n"),
                          }),
                },
            ],
        };
    },
});

export const roundtrip = { [TEST]: roundtripRun.outputs.units };
