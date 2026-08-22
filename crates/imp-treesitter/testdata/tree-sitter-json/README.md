Vendored from [`tree-sitter-json` 0.24.8](https://crates.io/crates/tree-sitter-json/0.24.8)
(MIT licensed, https://github.com/tree-sitter/tree-sitter-json), `src/parser.c`
and `src/tree_sitter/*.h` only.

Used exclusively as a small, dependency-free test fixture: a real generated
tree-sitter parser, to dlopen and exercise the full load→parse→query round
trip in tests, without needing a whole grammar built from a `grammar.js`.

The shared library isn't checked in: `crates/imp-treesitter/BUILD.js`
compiles `parser.c` at *build* time, via `ccLibrary({ shared: true })` and
the graph-provided cc toolchain — producing a real shared library for
whatever platform imp-treesitter is being built on (`.so` on Linux, `.dll`
on Windows), never a single vendored binary. See
`crates/imp-treesitter/tests/common/mod.rs` for how the compiled bytes get
embedded into the test binary.
