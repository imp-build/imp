+++
title = "The workspace file"
weight = 2
template = "page.html"
+++

`imp.workspace.js` is the root marker imp looks for when finding the workspace root. It's evaluated once, before any `BUILD.js` file.

Imports here are what enable things. Importing a workflow module enables its
goal; importing a rule module registers that rule's configuration schema and
supplies its pinned default toolchain, so `BUILD.js` files can use it.

**Illustrative example**

```js
import "//rules/workflows/build";
import "//rules/workflows/fmt";
import "//rules/workflows/lint";
import "//rules/workflows/test";

import "//rules/c/cmake";
import { odinToolchain } from "//rules/odin";
import { defaultOdinfmtToolchain } from "//rules/odin/odinfmt";

export const odin = odinToolchain("dev-2026-05", { default: true });
export const odinfmt = defaultOdinfmtToolchain();
```

A bare `import` is enough when the rule's pinned default is what you want. Use
a named import when the workspace exports a toolchain of its own, as below.

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
export const odinConfig = {
    collections: { lib: "library" },
};
```

The built-in `imp` configuration also accepts `jobs`, `jsWorkers`, and
`fsJobs`. `fsJobs` sets the number of filesystem workers that materialize
sandbox files. It can be overridden for one goal with `--fs-jobs`, just as
`--jobs` overrides `jobs`.

`jobs` is a budget of cores, not a count of actions: an action declares what it
costs with `exec.action({ cores })` (default 1), so one wide action can hold
several of the lanes `jobs` allows.

```js
export const impConfig = {
    fsJobs: 8,
};
```

## Exported declarations are workspace targets

An `export const name = ...` at the top level of `imp.workspace.js` gets a stable address, `//:name`, exactly like an export from a root `BUILD.js` file. `workspaceTargets()` and the target graph see it; nothing about it is workspace-file-specific beyond where it's declared.

Rule-owned default toolchains have no workspace address until you export their
getter result. This is optional for normal targets, which use the default
automatically:

```js
import { defaultOdinToolchain } from "//rules/odin";

export const odin = defaultOdinToolchain();
```

Use an explicit `{ default: true }` declaration only when a workspace needs a
different version or toolchain options:

```js
import { odinToolchain } from "//rules/odin";

export const odin = odinToolchain("dev-2026-04", { default: true });
```

## `imp @TOOL` resolves declared toolchains automatically

This section describes how imp runs a toolchain binary *for you*, from the
command line. It is a separate mechanism from how a rule package gets a
compiler for its own tasks — a rule consumes a toolchain as a graph handle,
described in [Extending Imp](../extending-imp/).

`imp @odin build foo.odin -out:foo` and `imp @odinfmt` run a managed toolchain binary directly, bypassing imp's own CLI parsing so the tool's flags never need a `--` separator. `TOOL` is resolved purely from the workspace, in two steps: imp first looks up the export named `TOOL` at `//:TOOL`, and if its target kind has a `"toolchain"` product registered, calls that product to get an absolute binary path and runs it. If nothing is exported at `//:TOOL`, imp falls back to asking every declared `Toolchain` subclass whether its own `static tool` name matches `TOOL`, and if one does, resolves *that* class's default instance instead. The fallback exists because some toolchain modules declare their default as a graph-native handle (used directly as a task input, not addressed by name) rather than as an exported target — `imp @biome`/`@ruff`/`@odinfmt` all resolve this way.

This means adding a new `@tool` needs no changes to imp itself — just a declared toolchain whose kind resolves to a binary, either exported at `//:TOOL` or declared as some class's default. A toolchain rule module opts in by subclassing `Toolchain`, which registers the `"toolchain"` product automatically from the subclass's `bin()`:

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

and the workspace file declares a default instance — either exported directly:

```js
export const mytool = myToolchain("1.2.3", { default: true });
```

or, for a toolchain module whose declaration API returns something other than the target handle (a graph-native tool, say), simply declared without being exported:

```js
import "//rules/mytool"; // calls myToolchain("1.2.3", { default: true }) itself
```

`imp @mytool ...` now works either way. If `TOOL` matches neither an export nor any declared toolchain's tool name, or a matching toolchain has no default instance declared, `imp @TOOL` fails with an error naming what's missing — there's no fixed list of "known tools" to update.

The one exception is `kcov`, which isn't workspace-driven at all — it's resolved from a fixed host install path, since coverage instrumentation isn't itself a build toolchain declared per-workspace.
