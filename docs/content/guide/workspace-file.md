+++
title = "The workspace file"
weight = 2
template = "page.html"
+++

`imp.workspace.js` is the root marker imp looks for when finding the workspace root. It's evaluated once, before any `BUILD.js` file, and does two things: imports rule modules (registering their `product()`s so `BUILD.js` files can use them) and declares workspace-wide singletons — most commonly toolchains:

```js
import "//rules/c/cmake";
import "//rules/workflows/build";
import { odinToolchain } from "//rules/odin";
import { odinfmtToolchain } from "//rules/odin/odinfmt/toolchain";

export const odin = odinToolchain("dev-2026-03", { default: true });
export const odinfmt = odinfmtToolchain();

```

Static, known-shape configuration uses an export named after its schema
namespace. For example, an Odin collections configuration is declared as:

```js
export const odin = {
    collections: { lib: "library" },
};
```

When the namespace is also used by another workspace export, use the
`<namespace>Config` form instead:

```js
export const odin = odinToolchain("dev-2026-03", { default: true });
export const odinConfig = {
    collections: { lib: "library" },
};
```

## Exported declarations are workspace targets

An `export const name = ...` at the top level of `imp.workspace.js` gets a stable address, `//:name`, exactly like an export from a root `BUILD.js` file. `workspaceTargets()` and the target graph see it; nothing about it is workspace-file-specific beyond where it's declared.

Declaring `odinToolchain(...)` without exporting it (the old style) still works for anything that reaches it through the module's own API — `defaultOdinToolchain()`, `resolveOdinToolchainVersion()`, and so on — but it has no address, so nothing outside that module can look it up by name.

## `imp @TOOL` resolves exported toolchains automatically

`imp @odin build foo.odin -out:foo` and `imp @odinfmt` run a managed toolchain binary directly, bypassing imp's own CLI parsing so the tool's flags never need a `--` separator. `TOOL` is resolved purely from the workspace: imp looks up the export named `TOOL` at `//:TOOL`, and if its target kind has a `"toolchain"` product registered, calls that product to get an absolute binary path and runs it.

This means adding a new `@tool` needs no changes to imp itself — just an exported target whose kind resolves to a binary. A toolchain rule module opts in by subclassing `Toolchain`, which registers the `"toolchain"` product automatically from the subclass's `bin()`:

```js
import { Toolchain, toolName } from "imp:core";

export class MyToolchain extends Toolchain {
    static kind = "my-toolchain";
    static tool = toolName("mytool");
    constructor({ version }, opts) {
        super({ kind: MyToolchain.kind, attrs: { version } }, opts);
    }

    bin() {
        return resolveMyToolBin(this.attrs.version);
    }
}

export function myToolchain(version, opts = {}) {
    return new MyToolchain({ version }, { default: opts.default });
}
```

and the workspace file exports it:

```js
export const mytool = myToolchain("1.2.3");
```

`imp @mytool ...` now works. If `TOOL` isn't exported from the workspace file, or its kind has no `"toolchain"` product, `imp @TOOL` fails with an error naming what's missing — there's no fixed list of "known tools" to update.

The one exception is `kcov`, which isn't workspace-driven at all — it's resolved from a fixed host install path, since coverage instrumentation isn't itself a build toolchain declared per-workspace.
