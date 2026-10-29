# Tree-sitter support

For contributors and rule authors: the Tree-sitter rules package the built-in
Odin and JSON grammar fixtures and the analyzer used by the Odin rules.
The grammar sources and Rust binaries are
staged as builtin graph inputs, so a consumer workspace does not need Imp's
private crate tree.

## Public API

This namespace has no stable user-facing BUILD constructor. `impTreesitter`,
`odinAnalyzer`, the grammar fixtures, and `roundtrip` are internal support
roots used by the Odin rules and their tests. They are included in the
developer reference for repository maintenance, but are excluded from the
curated user API.

## Luau support roots

Import `@imp/rules/treesitter` to use the Luau package. It exports
`json_grammar_fixture`, `odin_grammar_fixture`, `imp_treesitter`,
`odin_analyzer`, and `roundtrip`. Each grammar fixture exposes `sources`,
`archive`, and a `BUILD` root. Each executable is a single-binary Cargo
package: its `PACKAGE` handle resolves to the executable artifact. Declare
that handle and the grammar's `archive` handle as task inputs, then stage
both in the action that runs the executable.

The package compiles the grammar C sources with the default GCC toolchain.
On macOS, it uses the host `cc` from `@imp/rules/c/host`. On a platform with
neither, the module loads, but a grammar build fails with an error.
It does not use the precompiled JSON library in the source tree. The Odin
grammar also compiles its external scanner. The Rust sources, manifests,
and lockfile come from the installed rules tree. Consumer workspaces do not
need copies of these files.

### Verify the package

From the repository root, build the checkout binary and run:

```sh
cargo build -p imp
target/debug/imp test //rules/treesitter/...
python3 rules/treesitter/testdata/consumer_check.py --imp target/debug/imp
```

The package tests include `//rules/treesitter:roundtrip`. It builds the JSON
grammar and checks parsing, queries, repeated loads, and explicit symbols.
Its runtime guards reject source-tree grammar paths and check execution from
a relocated binary with an empty environment. `cargo test --workspace`
does not run this binary.

The external consumer check also builds the Odin grammar and analyzer,
checks source edits, and checks failure propagation. Native execution is
validated on Linux. Native Windows and macOS execution is not verified by
this check.
