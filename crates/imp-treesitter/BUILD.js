import { cargoPackage } from "//rules/rust";
import { ccLibrary } from "//rules/c";

// The test fixture grammar (see testdata/tree-sitter-json/README.md) is
// compiled from vendored source at *build* time — via the graph-provided cc
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

// cargoPackage's own sources() only globs Cargo.toml/Cargo.lock/**/*.rs, so
// the compiled fixture grammar (embedded at compile time via include_bytes!,
// see tests/common/mod.rs) needs to be declared as a dep for the sandboxed
// build to see it — same reason the top-level BUILD.js declares engineAssets
// for imp-engine's embedded JS.
export const imp_treesitter = cargoPackage({
    deps: [jsonGrammarFixture.archive],
    workspaceMember: true,
});
