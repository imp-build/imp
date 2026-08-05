+++
title = "Rule module structure"
weight = 4
template = "page.html"
+++

Rules expose a small, directory-based public API. A workspace author should
need one import for each tool or capability they select, and that import should
make clear what it enables.

## Public entrypoints

Every user-selectable rule, toolchain, or workflow lives in a named directory
whose `index.js` is its only public import path:

```text
rules/
  python/
    index.js          # Python targets and public Python declarations
    ruff/
      index.js        # Ruff formatting and linting integration
      format.js       # private implementation
```

The parent `rules/` directory is a namespace, not a tool. Do not add a catch-all
`rules/index.js`, and do not make a parent entrypoint silently enable every
child tool. Import the narrowest directory that represents the capability being
selected:

```js
import "//rules/python";
import "//rules/python/ruff";
import "//rules/workflows/fmt";
```

`index.js` owns the public contract. It exports declarations that belong in a
workspace or `BUILD.js` file, such as target constructors, toolchain factories,
configuration schemas, and intentional product-registration side effects. Its
module comment should say what importing it provides. Keep its export list
small; an exported helper is part of the supported user API.

## Private implementation

Put implementation modules below the entrypoint's directory and import them
only from rule implementation code or focused tests. Helpers may contain
product functions, source discovery, lockfile handling, or platform details,
but users must not need their filenames to configure a workspace.

Create a child directory only when it is independently selected or configured
by users, such as `c/cmake`, `js/biome`, or `rust/clippy`. That child gets its
own `index.js`. Do not create directories merely to split private helpers.

Test-only support trees are not public tools. Keep them unimportable from
workspace and `BUILD.js` files, document that status in their module comments,
and avoid adding a public entrypoint unless a real user capability emerges.

## Consumer rules

These consumers must import directory entrypoints only:

- `imp.workspace.js` and generated output from `imp init`;
- user `BUILD.js` files and repository examples;
- user guides, rule `DOC.md` files, and documentation build definitions.

Rule implementation files and focused unit tests may import a private helper
when that is necessary to test or compose its implementation. Such imports are
not examples of the user API and must not be copied into documentation.

The public imp support APIs follow the same rule. Use
`//rules/imp/test`, `//rules/imp/native-tool`, `//rules/imp/generate`,
`//rules/imp/mode`, `//rules/imp/archive`, `//rules/imp/lockfile`, and
`//rules/imp/self-tool` for their respective capabilities. `rulesTest()` is
the selectable TEST graph root; the other modules provide graph tools,
workspace configuration, or ordinary rule-author helpers. `nativeTool()`
returns a lazy graph handle: the host `PATH` lookup happens only when selected
work consumes it. `nativeToolSpec()` remains temporarily for legacy `run()`
consumers while built-in rulesets migrate.

When moving a public module, update all first-party consumers in the same
change. Remove the old deep import rather than leaving a compatibility shim:
the canonical directory path is the only supported path.

## Registration and migration checklist

Loading an entrypoint must preserve every product, configuration schema,
default toolchain, and goal registration that its public capability requires.
Avoid cycles by keeping shared target types in the parent entrypoint and having
a selected child entrypoint register only its own product.

For each migration:

1. Move the public module into its named directory and make `index.js` the
   public surface.
2. Repoint workspace, `BUILD.js`, initializer, example, and documentation
   imports to the directory path.
3. Update path-sensitive loader, API-reference, and product-registration tests.
4. Remove the old path, then verify the canonical import both loads and
   registers the expected products.
