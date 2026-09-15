+++
title = "Documentation workflow"
weight = 35
extra = { sidebar_heading = true }
+++

This page is for contributors and maintainers who update Imp
documentation. It explains which files to edit, how the site is built,
and what evidence a reviewer needs.

## Choose the source of truth

Edit the maintained source that owns the content:

- Use `docs/content/` for authored site pages.
- Use `rules/*/DOC.md` for rule-specific guides.
- Use source JSDoc, schemas, capabilities, and rule guides for generated API
  references.
- Use `docs/BUILD.js` to change how the site and generated references are
  assembled.
- Use `ci/gen_workflow.py` for the generated GitHub workflow files.

The reference pages under `docs/content/reference/` are generated output. Do
not hand-edit them. Vendored documentation and `dist/` output are outside the
authored documentation scope.

## Write for one audience

Name the primary audience when a page changes context. Use `Users` for people who install,
configure, run, observe, troubleshoot, and consume Imp. Use `Rule authors`, `Contributors`, and
`Maintainers` when the required knowledge changes.

Start with the page purpose and the result the reader gets. Then give prerequisites, the smallest
useful procedure, expected evidence, limits, and links to deeper material. Use exact commands,
target addresses, symbols, and paths in backticks.

State warnings and platform limits near the behavior they qualify. Describe a failure with its
symptom, likely cause when known, and next diagnostic action.

## Build and review the site

From the repository root, use the focused documentation checks while editing:

```sh
imp fmt //docs
imp lint //docs
imp test //docs
imp package //docs:site
```

`docs/BUILD.js` extracts JavaScript and user API references from source files, schemas,
capabilities, and rule guides before Zola builds the site. Packaging therefore checks both authored
pages and generated reference inputs.

Before review, also check the generated workflows and the full repository:

```sh
imp generate //ci:docs_workflow --check
imp fmt //...
imp lint //...
imp test //...
cargo test --workspace
git diff --check
```

## Keep changes reviewable

Keep examples close to the behavior they explain. Label a complete procedure as a **Runnable
example** only when the repository or listed steps reproduce it; label fragments with missing setup
as an **Illustrative example**. Link to existing guide pages and API references instead of copying
large sections.

Before submitting, check heading order, descriptive link text, command context, platform limits, and
generated-file ownership. Follow the complete checklist in
[`docs/EDITORIAL.md`](../../EDITORIAL.md).
