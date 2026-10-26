+++
title = "Contributing and maintaining Imp"
weight = 25
extra = { sidebar_heading = true }
+++

Most changes to Imp follow the same loop: find the code that owns the
behavior, make a focused change, run the relevant checks, and explain the
result in the review.

## Find your way around

Start in these directories:

- `crates/` — Rust implementation, including the CLI, graph engine, executor,
  and content-addressed store.
- `rules/` — Luau rule packages and their `DOC.md` guides.
- `docs/` — the documentation site and its build definition.
- `ci/` — workflow generators and repository checks.
- `examples/`, `probes/`, and `testdata/` — fixtures and focused experiments.

Rule packages expose their public API from a directory's `index.luau`. Keep
private helpers below that entrypoint. If a behavior belongs to a rule, fix the
rule; if it belongs to graph evaluation or execution, fix the corresponding
crate.

## A quick mental model

Build files and rules declare a graph of tasks and outputs. Imp runs selected
actions in sandboxes with declared inputs and tools, then stores their outputs
in the cache. Keep those boundaries intact when changing code.

## Develop and test

Run commands from the repository root. Imp uses Luau. The executable must be able to find the
built-in `rules/` tree. For checkout development, install the local shim with
`./install.sh --local`; it rebuilds Imp and sets `IMP_RULES_DIR` to this
checkout's `rules/` directory. A copied or released `imp` binary does not
follow the checkout: it can run old rules and lack current authoring APIs. Use the shim, or run the build in `target/` directly.

A Cargo build in this checkout (`target/debug/imp` or `target/release/imp`)
finds the checkout's `rules/` from its own path. Set
`IMP_RULES_DIR="$PWD/rules"` only when you build with a different
`CARGO_TARGET_DIR`. Without a rules path, a command can stop while it loads a
rule that calls `builtin_files()`, before it runs the selected graph actions.
Treat `no built-in rules directory available` as a rules-path setup failure,
not as a lint or test result.

Focused selectors check only the selected graph. The `//...` selectors below
discover and check the full repository graph. Record which scope you ran and
report setup failures separately from rule or code failures.

While iterating, use a focused selector:

**Runnable example**

```sh
imp lint //docs
imp test //docs
imp package //docs:site
```

Before review, run the full checks:

```sh
imp fmt //...
imp lint //...
imp test //...
cargo test --workspace
```

Use `cargo test --workspace`, not bare `cargo test`; the workspace contains
several crates. The Imp checks cover graph, rule, formatting, lint, and
packaging behavior that Cargo does not.

The documentation lint also checks source and rendered links, guide navigation,
generated reference output, and example status labels. It does not execute
arbitrary documentation commands.

## Do not edit generated output

Edit the source, then regenerate the output:

- Generated API pages come from Luau source comments, schemas, and rule
  guides. Edit those inputs, not `docs/content/reference/`.
- `.github/workflows/docs.yml` and `.github/workflows/release.yml` come from
  `ci/gen_workflow.py`. Run `imp generate //ci:docs_workflow` after changing
  the generator.
- `dist/` and other build outputs are disposable.

Keep the diff focused. In the review, say what changed, which checks you ran,
and whether a platform or environment limited the result. Follow
[`docs/EDITORIAL.md`](../../EDITORIAL.md) for documentation, rule guides, and
source Luau documentation.
