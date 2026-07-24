Vendored from [`tree-sitter-json` 0.24.8](https://crates.io/crates/tree-sitter-json/0.24.8)
(MIT licensed, https://github.com/tree-sitter/tree-sitter-json), `src/parser.c`
and `src/tree_sitter/*.h` only.

Used exclusively as a small, dependency-free test fixture: a real generated
tree-sitter parser, to dlopen and exercise the full load→parse→query round
trip in tests, without needing a whole grammar built from a `grammar.js`.

`tree-sitter-json.so` is a prebuilt (linux-x86_64) shared library compiled
from `parser.c`, checked in rather than compiled by the test suite itself:
compiling it from within a test action would need a C toolchain available
at *test-run* time, which imp's own sandboxed test execution deliberately
doesn't provide (only the earlier *build* step gets one, for bundled
SQLite/QuickJS) — see the discussion on the tree-sitter-support PR. Rebuild
it if `parser.c` ever changes:

```sh
cc -shared -fPIC -I . -o tree-sitter-json.so parser.c
```
