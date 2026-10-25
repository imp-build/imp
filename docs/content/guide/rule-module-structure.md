+++
title = "Rule module structure"
weight = 4
template = "page.html"
+++

This page is for contributors who organize Luau rules. Keep one public
entrypoint per rule or extension and keep implementation helpers behind it.

## Public modules

A rule directory exposes `index.luau` through its canonical `@imp/rules/...`
address. The entrypoint returns its public functions and values. It can
re-export documented definitions from helper modules. Do not create a catalog
root module that silently enables all rules.

An extension such as `@imp/rules/python/ruff/fmt` registers only that extension.
Keep formatting and lint activation explicit. Require extensions before BUILD
modules declare the targets that need them.

## Private helpers

Use relative requires for implementation helpers. A module is evaluated once
per canonical source, including when a relative and an absolute require name
refer to the same file. Public entrypoints must not expose raw host data in
place of graph handles.

## Documentation

Keep the rule guide in `DOC.md`. Add a `## Public API` section and examples
with their context and limits. Document exported declarations with contiguous
`---` comments. Structured tags are `@param`, `@returns`, and `@category`.
The extractor resolves static aliases and re-exports without executing rule
modules. Unsupported public export forms fail extraction.

## Tests

Add a BUILD test root and package-local `.test.luau` files. A nested package
owns its own test modules. Test public behavior through the entrypoint and
use the host fakes for action plans. Use a real consumer check for sandbox,
toolchain, and installed-rule boundaries.
