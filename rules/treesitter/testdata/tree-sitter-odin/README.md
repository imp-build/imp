Vendored from [`tree-sitter-odin`](https://github.com/tree-sitter-grammars/tree-sitter-odin)
at commit `d2ca8efb4487e156a60d5bd6db2598b872629403`.

The generated parser and external scanner are compiled by
`rules/odin/index.js` through `ccLibrary({ shared: true })`. The Odin dependency
analyzer loads the resulting library in a graph task.

The upstream grammar is MIT licensed; its license is included beside the
vendored sources.
