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
- `rules/` — JavaScript rule packages and their `DOC.md` guides.
- `docs/` — the documentation site and its build definition.
- `ci/` — workflow generators and repository checks.
- `examples/`, `probes/`, and `testdata/` — fixtures and focused experiments.

Rule packages expose their public API from a directory's `index.js`. Keep
private helpers below that entrypoint. If a behavior belongs to a rule, fix the
rule; if it belongs to graph evaluation or execution, fix the corresponding
crate.

## A quick mental model

Build files and rules declare a graph of tasks and outputs. Imp runs selected
actions in sandboxes with declared inputs and tools, then stores their outputs
in the cache. Keep those boundaries intact when changing code.

## Develop and test

Run commands from the repository root. While iterating, use a focused selector:

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

- Generated API pages come from JavaScript, schemas, capabilities, and rule
  guides. Edit those inputs, not `docs/content/reference/`.
- `.github/workflows/docs.yml` and `.github/workflows/release.yml` come from
  `ci/gen_workflow.py`. Run `imp generate //ci:docs_workflow` after changing
  the generator.
- `dist/` and other build outputs are disposable.

Keep the diff focused. In the review, say what changed, which checks you ran,
and whether a platform or environment limited the result. Follow
[`docs/EDITORIAL.md`](../../EDITORIAL.md) for documentation, rule guides, and
source JSDoc.
