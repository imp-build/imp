import { ccLibrary } from "//rules/c";
import { cargoPackage } from "//rules/rust";
import { BUILD } from "//rules/workflows/build";
import { TEST } from "//rules/workflows/test";
import { output, task } from "imp:core";

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

// The library plus the round-trip check binary (src/bin/treesitter-roundtrip.rs).
// The binary loads the grammar at run time from a path passed on argv, so —
// unlike the old tests/ embed — nothing here needs the grammar at compile time,
// and a plain `cargo` build of this crate has no dependency on an `imp` build.
export const imp_treesitter = cargoPackage({
    bin: "treesitter-roundtrip",
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
