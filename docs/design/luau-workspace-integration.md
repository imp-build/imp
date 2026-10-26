# Luau workspace integration

This record is for contributors who verify the repository cutover. Commands
run from the repository root with a checkout-built binary. Imp uses Luau without a runtime override. Downloaded CI binaries need
`IMP_RULES_DIR` set to the checkout rules directory. The obsolete JavaScript authoring catalog is removed. The final release
audit remains a separate task.

## Repository coverage

`python3 ci/check_luau_workspace.py --imp target/debug/imp` checks the Luau
BUILD inventory, Cargo, docs, CI workflows, and the RUN boundary between Odin
libraries and executables. C, Rust, and Odin BUILD generation are enabled.
The checker runs the cutover audit and its regression tests. The audit rejects
obsolete or unexpected JavaScript authoring files and checks retained inputs.

The removed JavaScript-only declarations have these recorded exclusions:

- `rules/BUILD.js`: the obsolete JavaScript authoring formatting inventory.
  Luau source formatting remains separate post-cutover work.
- `rules/imp/test/BUILD.js` and `rules/imp/test/index.js`: the QuickJS test
  harness. Luau uses `core.test_root()` and scoped host fakes.
- `rules/workflows/build/BUILD.js`: the QuickJS workflow test declaration.
  Luau workflow tests use `rules/workflows/BUILD.luau`.
- `examples/proposed-rules/BUILD.js`: an illustrative proposal with a local
  toolchain, not a supported consumer.

## Reference data flow

The installed Tree-sitter rule compiles the pinned Luau grammar and the Rust
`imp-luau-reference` binary. The binary parses a source manifest and emits
syntax records with source locations. It rejects trees with syntax errors.
The Python extractor resolves static exported tables, aliases, and re-exports
without executing modules. Missing names, cyclic aliases, direct writes to
export tables or their aliases, duplicate names, and unsupported return forms
fail extraction. The mutation check scans module-level control flow but does
not execute calls or inspect function bodies. It cannot detect indirect
mutation through a function call. Keep export construction static.

The renderer emits a complete code reference, a curated user reference,
`exports.json`, and a page/source manifest. Public categories are `target`
and `configuration`; other implementation exports use `api`. Contiguous
`---` comments provide prose and optional `@param`, `@returns`, and
`@category` tags. Exported field comments can refine a definition's category.
The host declaration file is documentation-only. A Rust test compares its
`@host` names with the live nested host table.

The site and its quality check consume the same generated reference artifact.
The checker verifies source existence, page inventory, links, navigation,
and obsolete JavaScript authoring instructions. Generated references are CAS
outputs and are not committed to the source tree.

## Preview and installed rules

`target/debug/imp run //docs:site_serve` launches the Python
supervisor through the existing RUN workflow. Its declared tools cover both
the supervisor and nested tool acquisition. The supervisor resolves the Imp
executable once, packages before serving, and rebuilds after source changes.
It restarts Zola only when output changes. Rebuild failure retains the last
successful site. Signal handling stops and reaps both child processes.

The package smoke test runs outside the checkout, clears `IMP_RULES_DIR`,
and uses Luau without a runtime override. It checks the shipped Luau catalog,
BUILD generation, asset builds, and a Luau test root. Windows archive checks
require Luau entrypoints and the grammar source. Native Windows and macOS
execution remain separate validation work.

## Verification

Verified on Linux on 2026-10-25. Each Imp command below selected Luau with
`IMP_RUNTIME=luau` and used `target/debug/imp`.

| Check | Recorded result |
| --- | --- |
| `imp fmt //...` | `fmt: 27 unchanged, 0 changed, 0 failed` |
| `imp fmt --check //...` | `fmt: 27 unchanged, 0 changed, 0 failed` |
| `imp lint //...` | `lint: 28 clean, 0 fixed, 0 failed` |
| `imp test //...` | Exit 0; `test: 732/732 unit(s) passed` |
| `cargo test --workspace` | Exit 0; all Rust unit, integration, and doc-test groups passed |
| `imp test //docs` | Exit 0; 19 Python tests passed in one graph test unit |
| `imp lint //docs` | `lint: 1 clean, 0 fixed, 0 failed` |
| `imp generate //ci:docs_workflow --check` | `generate --check: 2 generated file(s) up to date` |
| Workspace coverage check | 63 BUILD files, five exclusions, 92 targets; all three generators enabled |
| External installed-package smoke | Exit 0; packaged JavaScript and Luau rules resolved outside the checkout |
| Live preview check | Initial HTTP response, rebuilt response after a source edit, and shutdown without a forced kill |
| Python format and lint checks | All nine changed Python files passed Ruff |
| Standalone extractor Clippy | Exit 0 with `--bin imp-luau-reference -- -D warnings` |
| `git diff --check` | Exit 0; no output |

The full Luau test summary counts four failed sandbox actions from expected
negative CMake fixtures. All test units pass and the command exits zero.
Reference extraction covers 80 modules and 587 exported names, including
re-exports. All 122 curated public entries have prose.

An independent review found that writes through export-table aliases or
inside control flow could pass extraction without an error. The extractor
now checks these writes and rejects the mutated table. Regression tests use
the real grammar and cover aliases, conditionals, bracket writes, compound
assignments, and member function declarations. No current catalog entry was
affected by the defect.

A separate all-target Clippy check of the standalone Tree-sitter crate found
an existing `needless_borrows_for_generic_args` warning in
`src/bin/treesitter-roundtrip.rs`. That line is outside this change. The
changed extractor binary passes its own Clippy check. Native Windows and
macOS execution were not run.
