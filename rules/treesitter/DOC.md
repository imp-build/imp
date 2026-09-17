# Tree-sitter support

The Tree-sitter rules package the built-in Odin and JSON grammar fixtures and
the analyzer used by the Odin rules. The grammar sources and Rust binaries are
staged as builtin graph inputs, so a consumer workspace does not need Imp's
private crate tree.

## Public API

This namespace has no stable user-facing BUILD constructor. `impTreesitter`,
`odinAnalyzer`, the grammar fixtures, and `roundtrip` are internal support
roots used by the Odin rules and their tests. They are included in the
developer reference for repository maintenance, but are excluded from the
curated user API.
